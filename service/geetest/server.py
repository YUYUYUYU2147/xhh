"""
米游社社区签到 —— 本机全自动过码服务

撞米游社风控（retcode 1034 / 10035 / 10041）时，本服务替调用方解开极验滑块，
并把米游社回执里颁的 challenge 交给调用方，让它带 x-rpc-challenge 重发原请求。

只监听 127.0.0.1。整体流程：

    ① 米游社 createVerification            → 拿 gt / challenge
    ② 极验 get.php                         → 拿 c、s 与三张图的地址
    ③ 下载拼图、还原乱序背景、模板匹配出缺口距离
    ④ 生成 w（轨迹 + 混淆，见 wsolver.py）
    ⑤ 极验返回 validate
    ⑥ 米游社 verifyVerification           → 换到 x-rpc-challenge

其中 ②③ 需要极验的 c/s 与图像处理，直接依赖 bili-ticket-gt-python。
参考来源见 README 的「致谢」。

⚠️ 仅供学习交流与技术研究，请勿用于任何商业用途。使用本服务产生的一切账号
风险由使用者自负；本服务绕过了验证码这一安全机制，请只在本人账号上使用。
"""

import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import httpx

from wsolver import build_w

# ───────────────────────── 可调参数 ─────────────────────────
# 默认 2149（本机 2147/2148 被 1Panel 占用），刻意不跟 xhh-TL 的 8766 一致：
# 会出现「一份服务的进程答另一份的请求」，那种错极难定位。改端口最省事。
PORT = int(os.environ.get('GT_PORT', '2149'))
MAX_ROUNDS = int(os.environ.get('GT_MAX_ROUNDS', '8'))
CONCURRENCY = int(os.environ.get('GT_CONCURRENCY', '4'))
RETRY_GAP = float(os.environ.get('GT_RETRY_GAP', '0.5'))

# 客户端形态：签到是 App 端接口（client_type=2），过码也必须按 App 端走，
# 不成套的话米游社回执里的 challenge 换到签到上不认
CLIENT_TYPE = os.environ.get('GT_CLIENT_TYPE', '2')
CHALLENGE_GAME = os.environ.get('GT_CHALLENGE_GAME', '2')
# 过码接口是独立的一套老版本形态，与 bbs-api 的常规请求不同
GT_APP_VERSION = os.environ.get('GT_APP_VERSION', '2.40.1')

# DS2 盐：salt 4 用于过码接口
SALT_GT = os.environ.get('GT_SALT', 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs')

UA = f'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) ' \
     f'Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/{GT_APP_VERSION}'

BBS = 'https://bbs-api.miyoushe.com'

_lock = threading.Lock()
_stats = {'ok': 0, 'fail': 0, 'rounds': 0, 'total_s': 0.0}

# ─────────── 熔断 ───────────
# 极验偶尔会成批拒收某段时间内下发的 challenge：实测 2026-10-01 14:54:58 起连续
# 8 轮全是 MissingParam("validate")，9 秒后放弃；两分钟后又立刻恢复成首轮必过。
# 这种窗口里若让每个版块各自死磕满 MAX_ROUNDS，7 个版块就是 7×9 秒白等，
# 还会把风控打上去。所以连续失败到阈值就短路一段时间，直接让调用方走兜底。
BREAKER_FAILS = int(os.environ.get('GT_BREAKER_FAILS', '2'))   # 连续几次失败就熔断
BREAKER_COOLDOWN = float(os.environ.get('GT_BREAKER_COOLDOWN', '30'))  # 熔断多少秒
BREAKER_PROBE_TIMEOUT = float(os.environ.get('GT_BREAKER_PROBE_TIMEOUT', '90'))  # 半开探针最多等多久
_breaker = {'fail': 0, 'open_until': 0.0, 'probe': False, 'probe_at': 0.0}


def breaker_state():
    """返回 (是否熔断中, 剩余秒数)。

    半开只放一个探针，其余请求继续快速失败。这里有个坑：放行探针时会把 open_until
    清零，如果只用「open_until 是否还在」判断，后续请求会全部当成正常放行 —— 半开就
    变成了全开，等于没有熔断。所以要用独立的 probe 标记，并且给探针加超时，
    否则探针请求异常退出时 probe 会一直挂着，服务从此再也不放行。
    """
    with _lock:
        now = time.time()
        if _breaker['probe']:
            # 探针在途；超时还没回来就当它挂了，重新放一个新的
            if now - _breaker['probe_at'] <= BREAKER_PROBE_TIMEOUT:
                return True, 0.0
            log('⚡ 半开探针超时未回，重新放一个')
            _breaker['probe'] = True
            _breaker['probe_at'] = now
            return False, 0.0
        until = _breaker['open_until']
        if until > now:
            return True, until - now
        if until:  # 冷却结束，放一次探针
            _breaker['open_until'] = 0.0
            _breaker['fail'] = 0
            _breaker['probe'] = True
            _breaker['probe_at'] = now
            return False, 0.0
        return False, 0.0


def breaker_record(ok):
    with _lock:
        _breaker['probe'] = False
        if ok:
            _breaker['fail'] = 0
            _breaker['open_until'] = 0.0
            return
        _breaker['fail'] += 1
        if _breaker['fail'] >= BREAKER_FAILS:
            _breaker['open_until'] = time.time() + BREAKER_COOLDOWN
            log(f'⚡ 连续 {_breaker["fail"]} 次失败，熔断 {BREAKER_COOLDOWN:.0f}s'
                f'（期间直接快速失败，让调用方走兜底）')


def log(msg):
    print(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}', flush=True)


# ─────────────────────── 米游社接口 ───────────────────────

def ds2(query='', body=''):
    """过码接口的 DS2 签名：salt 固定走 salt 4"""
    import hashlib
    t = round(time.time())
    r = int(time.time() * 1000) % 900000 + 100000
    return f'{t},{r},{hashlib.md5(f"salt={SALT_GT}&t={t}&r={r}&b={body}&q={query}".encode()).hexdigest()}'


def gt_headers(cookie, device_id, device_fp):
    """
    过码请求的头。

    device_id / device_fp 一律用调用方传进来的那套 —— 过码要跟重签是同一个身份，
    不然米游社认不出来。x-rpc-challenge_game 也不能少。
    """
    return {
        'Cookie': cookie,
        'User-Agent': UA,
        'X-Requested-With': 'com.mihoyo.hyperion',
        'Origin': 'https://webstatic.mihoyo.com',
        'Referer': 'https://webstatic.mihoyo.com',
        'x-rpc-app_version': GT_APP_VERSION,
        'x-rpc-client_type': str(CLIENT_TYPE),
        'x-rpc-device_id': str(device_id or ''),
        'x-rpc-device_fp': str(device_fp or ''),
        'x-rpc-challenge_game': str(CHALLENGE_GAME),
        'Accept': 'application/json, text/plain, */*',
    }


def app_paths():
    """App 端（client_type=2）与网页端（5）的接口路径不同，必须成套用"""
    if str(CLIENT_TYPE) == '2':
        return 'misc/api/createVerification', 'misc/api/verifyVerification'
    return 'misc/wapi/createVerification', 'misc/wapi/verifyVerfication'


def create_verification(cookie, device_id, device_fp):
    path, _ = app_paths()
    query = 'is_high=false' if str(CLIENT_TYPE) == '2' else 'gids=2&is_high=false'
    headers = gt_headers(cookie, device_id, device_fp)
    headers['DS'] = ds2(query)
    with httpx.Client(timeout=12) as c:
        res = c.get(f'{BBS}/{path}?{query}', headers=headers)
    return res.json()


def verify_verification(cookie, challenge, validate, seccode, device_id, device_fp):
    _, path = app_paths()
    body = {
        'geetest_challenge': challenge,
        'geetest_validate': validate,
        'geetest_seccode': seccode,
    }
    text = json.dumps(body, separators=(',', ':'))
    headers = gt_headers(cookie, device_id, device_fp)
    headers['DS'] = ds2('', text)
    headers['Content-Type'] = 'application/json;charset=UTF-8'
    with httpx.Client(timeout=12) as c:
        res = c.post(f'{BBS}/{path}', headers=headers, content=text.encode())
    return res.json()


# ───────────────────────── 过码主体 ─────────────────────────

_solver = None


def _get_solver():
    """bili_ticket_gt_python 是 Rust 扩展，首次 import 较慢，延迟加载并缓存"""
    global _solver
    if _solver is None:
        import bili_ticket_gt_python
        _solver = bili_ticket_gt_python.SlidePy()
    return _solver


def solve_once(cookie, device_id, device_fp):
    """
    跑完一轮完整过码，返回 validate 信息；任何一步失败返回 None。

    极验的 challenge 是一次性的，所以不能分步重试 —— 中途失败这轮就作废，
    由上层重新申请一个新的。
    """
    cv = create_verification(cookie, device_id, device_fp)
    gt = (cv.get('data') or {}).get('gt')
    origin_challenge = (cv.get('data') or {}).get('challenge')
    if not gt or not origin_challenge:
        log(f'    createVerification 没拿到 gt/challenge retcode={cv.get("retcode")}')
        return None

    s = _get_solver()
    # 这三步有先后依赖：不先拿 c/s 和题型，后面 get_new_c_s_args 会报缺参数
    s.get_c_s(gt, origin_challenge)
    kind = s.get_type(gt, origin_challenge)
    if kind != 'slide':
        log(f'    题型是 {kind}，本服务只处理滑块')
        return None
    c, s_seed, args = s.get_new_c_s_args(gt, origin_challenge)
    new_challenge = args[0]

    # 模块内部负责下载图片、还原乱序背景并模板匹配出缺口
    distance = s.calculate_key(args)
    if distance is None:
        return None

    w = build_w(distance, gt, new_challenge, list(c), s_seed)
    _, validate = s.verify(gt, new_challenge, w)
    if not validate:
        return None
    return {'validate': validate, 'challenge': new_challenge, 'distance': distance}


def solve(cookie, device_id, device_fp):
    """整次请求：最多试 MAX_ROUNDS 轮，成功后向米游社回执换 x-rpc-challenge"""
    tripped, left = breaker_state()
    if tripped:
        log(f'⚡ 熔断中，跳过本轮（还剩 {left:.0f}s）')
        with _lock:
            _stats['fail'] += 1
        return {'ok': False, 'reason': 'breaker open', 'retryAfter': round(left)}
    started = time.time()
    for round_no in range(1, MAX_ROUNDS + 1):
        t0 = time.time()
        try:
            got = solve_once(cookie, device_id, device_fp)
            if got:
                res = verify_verification(
                    cookie, got['challenge'], got['validate'],
                    f"{got['validate']}|jordan", device_id, device_fp)
                challenge = (res.get('data') or {}).get('challenge', '')
                if res.get('retcode') == 0 and challenge:
                    with _lock:
                        _stats['ok'] += 1
                        _stats['rounds'] += round_no
                        _stats['total_s'] += time.time() - started
                    breaker_record(True)
                    log(f'✅ 过码成功（第 {round_no} 轮，缺口 {got["distance"]}，'
                        f'{time.time() - t0:.1f}s）challenge={challenge[:16]}…')
                    return {'ok': True, 'round': round_no, 'distance': got['distance'],
                            'challenge': challenge}
                log(f'    回交未通过 retcode={res.get("retcode")} msg={str(res.get("message"))[:60]}')
            else:
                log(f'  [轮{round_no}] 这一轮没过')
        except Exception as err:  # 单轮失败不该拖垮整个请求
            log(f'  [轮{round_no}] 异常 {type(err).__name__}: {str(err)[:140]}')
            if os.environ.get('GT_DEBUG'):
                traceback.print_exc()
        time.sleep(RETRY_GAP)
    with _lock:
        _stats['fail'] += 1
    breaker_record(False)
    log(f'❌ {MAX_ROUNDS} 轮都没过（{time.time() - started:.1f}s）')
    return {'ok': False}


# ───────────────────────── HTTP 层 ─────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass  # 静默默认的逐请求日志

    def _reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path.startswith('/health'):
            with _lock:
                st = dict(_stats)
            done = st['ok'] + st['fail']
            return self._reply(200, {
                'ok': True,
                'stats': {
                    'success': st['ok'],
                    'failed': st['fail'],
                    'successRate': f'{st["ok"] / done * 100:.0f}%' if done else '-',
                    'avgRounds': f'{st["rounds"] / st["ok"]:.1f}' if st['ok'] else '0.0',
                    'avgSeconds': f'{st["total_s"] / st["ok"]:.1f}' if st['ok'] else '0.0',
                    'breakerOpen': round(_breaker['open_until'] - time.time()) > 0,
                    'breakerFail': _breaker['fail'],
                },
            })
        self._reply(404, {'error': 'not found'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception as err:
            return self._reply(400, {'error': f'bad json: {err}'})

        # 调用方指定身份就用它的；没指定才用本机默认值
        device_id = (body.get('deviceId') or '').strip() or None
        device_fp = (body.get('deviceFp') or '').strip() or None

        # 批量模式：一次给多个 ck，并发跑
        if isinstance(body.get('cookies'), list):
            cks = [c for c in body['cookies'] if c]
            if not cks:
                return self._reply(400, {'error': 'empty cookies'})
            log(f'收到批量过码请求（{len(cks)} 个）')
            results = [None] * len(cks)
            threads, sem = [], threading.Semaphore(CONCURRENCY)

            def work(i, ck):
                with sem:
                    results[i] = solve(ck, device_id, device_fp)

            for i, ck in enumerate(cks):
                t = threading.Thread(target=work, args=(i, ck))
                t.start()
                threads.append(t)
            for t in threads:
                t.join()
            return self._reply(200, {'data': {'results': [
                {'ok': bool(r and r.get('ok')), 'round': (r or {}).get('round', 0)} for r in results
            ]}})

        cookie = body.get('cookie', '')
        if not cookie:
            return self._reply(400, {'error': 'missing cookie'})
        log('收到过码请求')
        r = solve(cookie, device_id, device_fp)
        if not r.get('ok'):
            # 熔断拒的也要把 reason 透出去，调用方才能区分「服务端主动拒」和「真解不出来」
            if r.get('reason') == 'breaker open':
                return self._reply(503, {'error': 'breaker open',
                                        'retryAfter': r.get('retryAfter', 0)})
            return self._reply(500, {'error': 'verify failed'})
        return self._reply(200, {'msg': '', 'data': {
            'result': 'ok', 'round': r['round'], 'distance': r['distance'],
            'challenge': r.get('challenge', ''),
        }})


def self_check():
    """启动就检查依赖，别等真要过码时才报错"""
    missing = []
    for mod, hint in (('bili_ticket_gt_python', 'pip install bili-ticket-gt-python==0.2.5'),
                      ('Crypto', 'pip install pycryptodome'),
                      ('httpx', 'pip install httpx')):
        try:
            __import__(mod)
        except ImportError:
            missing.append(f'缺少 {mod}，执行：{hint}')
        except OSError as err:
            # 该包是 Rust 扩展，系统 glibc 太低会在这里炸
            missing.append(f'{mod} 加载失败（{err}）。它需要 glibc >= 2.31，'
                           f'过低就得换机器或换发行版')
    if missing:
        log('⚠️ 启动自检发现问题：')
        for m in missing:
            log(f'   - {m}')
    else:
        log('启动自检通过')


if __name__ == '__main__':
    log(f'米游社过码服务已启动 http://127.0.0.1:{PORT}（最多 {MAX_ROUNDS} 轮/次，'
        f'client_type={CLIENT_TYPE}）')
    self_check()
    # 只绑本机。这个服务拿着别人的 cookie 去调米游社，不能对外暴露
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
