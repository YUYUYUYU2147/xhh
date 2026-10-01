"""
极验 v3 滑块 —— w 参数生成

w 的结构：私用 base64(AES-128-CBC(轨迹包)) ‖ RSA-PKCS1v1.5(AES密钥)

  * AES：16 字节随机密钥、CBC、IV 全 0、PKCS7 填充
  * RSA：极验全站共用的固定公钥，密钥加密后转 hex 拼在密文尾部
  * base64：极验私有码表，末尾两位是 () 而不是 +/

轨迹包里的 aa 字段要过两层编码：
  1) 轨迹先做差分，再按「位移 / 时间」分通道编码，用 !! 拼接
  2) 再用服务端下发的 c、s 把随机字符按二次曲线插进串里

参考来源见 README 的「致谢」。
"""

import hashlib
import json
import random

from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Util.Padding import pad

# 极验私有 base64 码表：标准表把 +/ 换成了 ()
_B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()'

# 极验 w 加密用 RSA 公钥，所有站点共用同一个
_RSA_PUBKEY = '''-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDB45NNFhRGWzMFPn9I7k7IexS5
XviJR3E9Je7L/350x5d9AtwdlFH3ndXRwQwprLaptNb7fQoCebZxnhdyVl8Jr2J3
FZGSIa75GJnK4IwNaG10iyCjYDviMYymvCtZcGWSqSGdC/Bcn2UCOiHSMwgHJSrg
Bm1Zzu+l8nSOqAurgQIDAQAB
-----END PUBLIC KEY-----'''

# 单值编码用的字符表（注意与 base64 表不同）
_VALUE_CHARS = '()*,-./0123456789:?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqr'

# 常见位移组合的单字符缩写，省一点体积。
# ⚠️ 这张表必须完整：漏掉任何一档，该组合就会被拆成独立的 x/y 两个值，
#    编码出来的串和极验预期不一致，验证会被直接拒掉（表现为过码一直失败）。
#    9 组对应 9 个字符，末尾是 ~。
_PAIR_SHORTCUTS = [((1, 0), 's'), ((2, 0), 't'), ((1, -1), 'u'), ((1, 1), 'v'),
                   ((0, 1), 'w'), ((0, -1), 'x'), ((3, 0), 'y'), ((2, -1), 'z'),
                   ((2, 1), '~')]

# 每 3 字节切出的 4 段 6 位，各自的位掩码
_SEG = [7274496, 9483264, 19220, 235]


def _six_bits(value, mask):
    """按掩码指定的位段从 24 位整数里取出一段 6 位"""
    acc = 0
    for bit in range(23, -1, -1):
        if (mask >> bit) & 1:
            acc = (acc << 1) + ((value >> bit) & 1)
    return acc


def geetest_b64(raw):
    """
    极验私有 base64。每组 3 字节 → 4 字符，尾部不足处用 '.' 补齐到 4 的倍数。
    """
    out = []
    pad_len = 0
    for i in range(0, len(raw), 3):
        block = raw[i:i + 3]
        n = len(block)
        val = int.from_bytes(block + b'\x00' * (3 - n), 'big')
        take = 4 if n == 3 else (3 if n == 2 else 2)
        out.extend(_B64_ALPHABET[_six_bits(val, m)] for m in _SEG[:take])
        pad_len = (4 - take) % 4
    return ''.join(out) + '.' * pad_len


def _new_aes_key():
    """
    16 字节随机密钥：4 组、每组 4 位 hex（极验前端就是这么拼的）。
    直接用 %04x 拼而不是先转整数再切片 —— 那样遇到小于 0x1000 的值会少一位，
    凑不满 16 字节，AES.new 会直接抛 Incorrect AES key length。
    """
    return ''.join('%04x' % random.randrange(0x10000) for _ in range(4)).encode()


def _aes_cbc(key, plain):
    """
    AES-128-CBC，PKCS7 填充。

    ⚠️ IV 是 16 个 ASCII 字符 '0'（0x30），**不是 16 个零字节（0x00）**。
    写成 b'\\x00' * 16 会解出完全不同的内容，服务端判定轨迹非法，验证必挂。
    """
    return AES.new(key, AES.MODE_CBC, b'0000000000000000').encrypt(pad(plain.encode(), 16))


def _rsa_hex(text):
    return PKCS1_v1_5.new(RSA.import_key(_RSA_PUBKEY)).encrypt(text.encode()).hex()


# ─────────────────────────── 轨迹 ───────────────────────────

def _build_track(distance):
    """
    造一条像人拖出来的轨迹。

    真人不会匀速直线拖过去：起手有一点点反向试探，末段会冲过头再往回拉一点点。
    这里用 easeOutExpo 做主体位移，再叠上这两处细节。
    """
    def ease_out_expo(p):
        if p >= 1.0:
            return 1.0
        return 1.0 - pow(2.0, -10.0 * p)

    points = [[random.randint(-50, -10), random.randint(-50, -10), 0], [0, 0, 0]]
    total_ms = random.randint(50, 100)
    steps = 30 + distance // 2
    prev_x = 0
    for i in range(steps):
        x = round(ease_out_expo(i / steps) * distance)
        total_ms += random.randint(10, 20)
        if x == prev_x:
            continue
        points.append([x, random.randint(0, 2), total_ms])
        prev_x = x
    # 冲过头再修正：更接近真人，也给服务端一点「非机器」的信号
    points.append([prev_x + random.randint(2, 6), 0, total_ms + random.randint(10, 30)])
    points.append([prev_x, 0, total_ms + random.randint(40, 90)])
    points.append(list(points[-1]))
    return points


def _encode_track_layer1(track):
    """
    轨迹编码第一层：差分 → 按位移/时间分通道编码 → 用 '!!' 拼起来。

    dx=dy=0 的点不产出位移，只把耗时累加到下一段上。
    """
    deltas = []
    carry = 0
    last = (0, 0)
    for i in range(len(track) - 1):
        dx = round(track[i + 1][0] - track[i][0])
        dy = round(track[i + 1][1] - track[i][1])
        dt = round(track[i + 1][2] - track[i][2])
        if dx == 0 and dy == 0 and dt == 0:
            continue
        if dx == 0 and dy == 0:
            carry += dt
        else:
            deltas.append([dx, dy, dt + carry])
            carry = 0
            last = (dx, dy)
    if carry:
        deltas.append([last[0], last[1], carry])

    def scalar(v):
        n = len(_VALUE_CHARS)
        mag = abs(v)
        prefix = '!' if v < 0 else ''
        hi = mag // n
        if hi:
            return prefix + '$' + _VALUE_CHARS[min(hi, n - 1)] + _VALUE_CHARS[mag % n]
        return prefix + _VALUE_CHARS[mag % n]

    xs, ys, ts = [], [], []
    for dx, dy, dt in deltas:
        shortcut = next((ch for (kx, ky), ch in _PAIR_SHORTCUTS if (dx, dy) == (kx, ky)), None)
        if shortcut:
            ys.append(shortcut)
        else:
            xs.append(scalar(dx))
            ys.append(scalar(dy))
        ts.append(scalar(dt))
    return ''.join(xs) + '!!' + ''.join(ys) + '!!' + ''.join(ts)


def _encode_track_layer2(text, c, s):
    """
    轨迹编码第二层：按服务端给的 s 决定插入位置，往串里塞随机字符做混淆。

    ⚠️ 取模基数必须固定成插入前的原始长度。字符串每插一个字符就变长，
    用当前长度当基数会让后面的插入位置整体漂移，服务端解出的轨迹就是乱的。
    """
    if not c or not s:
        return text
    span = len(text)
    coef_a, coef_b, coef_d = c[0], c[2], c[4]
    out = text
    for i in range(0, len(s) - 1, 2):
        try:
            code = int(s[i:i + 2], 16)
        except ValueError:
            break
        pos = (coef_a * code * code + coef_b * code + coef_d) % span
        out = out[:pos] + chr(code) + out[pos:]
    return out


# ─────────────────────── userresponse ───────────────────────

def _encode_user_response(distance, challenge):
    """
    把滑动距离编成 userresponse。

    challenge 末两位暗藏一个偏移量（两位分别按不同基数解），先加上它再按
    5 档权重（1/2/5/10/50）随机抽字符拼出来 —— 同样距离每次生成的串都不一样。
    """
    tail = challenge[-2:]
    digits = [(ord(ch) - 87) if ord(ch) > 57 else (ord(ch) - 48) for ch in tail]
    target = round(distance) + 36 * digits[0] + digits[1]

    # 把 challenge（去掉末两位）的不重复字符分进 5 个桶，凑够权重就抽一个
    buckets = [[] for _ in range(5)]
    seen = set()
    turn = 0
    for ch in challenge[:-2]:
        if ch in seen:
            continue
        seen.add(ch)
        buckets[turn].append(ch)
        turn = (turn + 1) % 5

    weights = [1, 2, 5, 10, 50]
    level = 4
    out = ''
    while target > 0:
        if target - weights[level] >= 0:
            out += random.choice(buckets[level])
            target -= weights[level]
        else:
            # 这档够不着就降一档，并把它从候选里去掉，避免死循环
            buckets.pop(level)
            weights.pop(level)
            level -= 1
        if level < 0:
            break
    return out


# ─────────────────────────── 对外 ───────────────────────────

def build_w(distance, gt, challenge, c, s):
    """
    组装极验的 w 参数。

    :param distance: 缺口横坐标距离（整数像素）
    :param gt: 极验下发的 gt
    :param challenge: 极验下发的**新** challenge（带后缀），不是最初申请的那个
    :param c: 服务端下发的位置混淆系数
    :param s: 服务端下发的位置混淆种子
    :return: w 参数字符串
    """
    track = _build_track(int(distance))
    passtime = track[-1][2]

    aa = _encode_track_layer2(_encode_track_layer1(track), c, s)
    rp = hashlib.md5((gt + challenge[:-2] + str(passtime)).encode()).hexdigest()

    payload = {
        'lang': 'zh-cn',
        'userresponse': _encode_user_response(int(distance), challenge),
        'passtime': passtime,
        'imgload': random.randint(100, 200),
        'aa': aa,
        'ep': {
            'v': '9.1.8-bfget5', '$_E_': False, 'me': True,
            'ven': 'Google Inc. (Intel)',
            'ren': 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'fp': ['move', 483, 149, 1702019849214, 'pointermove'],
            'lp': ['up', 657, 100, 1702019852230, 'pointerup'],
            'em': {'ph': 0, 'cp': 0, 'ek': '11', 'wd': 1, 'nt': 0, 'si': 0, 'sc': 0},
            'tm': {
                'a': 1702019845759, 'b': 1702019845951, 'c': 1702019845951, 'd': 0, 'e': 0,
                'f': 1702019845763, 'g': 1702019845785, 'h': 1702019845785, 'i': 1702019845785,
                'j': 1702019845845, 'k': 1702019845812, 'l': 1702019845845, 'm': 1702019845942,
                'n': 1702019845946, 'o': 1702019845954, 'p': 1702019846282, 'q': 1702019846282,
                'r': 1702019846287, 's': 1702019846288, 't': 1702019846288, 'u': 1702019846288,
            },
            'dnf': 'dnf', 'by': 0,
        },
        'rp': rp,
    }

    key = _new_aes_key()
    blob = geetest_b64(_aes_cbc(key, json.dumps(payload, separators=(',', ':'))))
    return blob + _rsa_hex(key.decode())
