import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config, sleep } from '#xhh';
import { pickSentMsgId, scheduleGroupRecall } from './msgRecall.js';

const tasks = new Map();
let server = null;
let startedPort = 0;
// cloudflared 快速隧道拿到的临时公网地址；trycloudflare 域名每次重启都会变
let tunnelUrl = '';
let tunnelProc = null;
let tunnelPromise = null;
const registerHits = new Map();
const MAX_BODY_SIZE = 256 * 1024;
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_LIMIT = 20;

// 后台隧道脚本（tools/manual_gt_tunnel.sh）会把实际地址写到文件里，插件读取它。
// 路径可移植：环境变量 > 插件数据目录（默认，随仓库走）> /root/.xhh（兼容旧写法）。
const TUNNEL_URL_FILES = [
  process.env.XHH_MANUAL_GT_URL_FILE,
  './plugins/xhh/data/manual_gt_url',
  '/root/.xhh/manual_gt_url',
].filter(Boolean);

function readTunnelUrlFile() {
  for (const file of TUNNEL_URL_FILES) {
    try {
      const url = fs.readFileSync(file, 'utf8').trim();
      if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(url)) return url;
    } catch (_) {}
  }
  return '';
}

// 后台隧道服务（systemd）刚起来时，地址文件会先存在、内容后写入。
// 这种情况下先等它写好，不要急着再拉一条隧道，否则会出现两条隧道互相干扰。
function tunnelFilePending() {
  return TUNNEL_URL_FILES.some(file => {
    try {
      return fs.existsSync(file)
    } catch (_) {
      return false
    }
  })
}

async function waitTunnelUrlFile(timeoutMs = 20000) {
  const step = 1500
  for (let waited = 0; waited < timeoutMs; waited += step) {
    const url = readTunnelUrlFile()
    if (url) return url
    await new Promise(r => setTimeout(r, step))
  }
  return ''
}

function getManualCfg() {
  const cfg = config() || {};
  const envPublicUrl = process.env.XHH_MANUAL_GT_PUBLIC_URL || process.env.MANUAL_GT_PUBLIC_URL || '';
  const configured = String(cfg.manual_gt_public_url || envPublicUrl).trim().replace(/\/+$/, '');
  // 配置里写的是 trycloudflare 临时域名（或留空）时，优先用后台隧道实际地址
  const isTempDomain = !configured || /trycloudflare\.com$/i.test(configured);
  const liveTunnel = tunnelUrl || readTunnelUrlFile();
  return {
    enable: cfg.manual_gt_enable !== false,
    // 手动验证码服务只监听本机，公网访问统一交给 Cloudflare Tunnel/反向代理。
    host: cfg.manual_gt_host || '127.0.0.1',
    port: Number(cfg.manual_gt_port || 3000),
    publicUrl: (isTempDomain && liveTunnel) || configured,
    path: String(cfg.manual_gt_path || '/xhh-gt').replace(/\/+$/, ''),
    timeout: Number(cfg.manual_gt_timeout || 120),
    autoTunnel: cfg.manual_gt_auto_tunnel !== false,
    // 自动签到/社区签到是定时任务，e.reply 被写成空壳（async () => false），
    // 验证码链接必须主动发到群里，否则用户根本不知道要去过码，任务只能干等到超时重试。
    notifyGroup: Number(cfg.manual_gt_notify_group || 0),
    notifyAt: (Array.isArray(cfg.manual_gt_notify_at) ? cfg.manual_gt_notify_at : String(cfg.manual_gt_notify_at || '').split(','))
      .map(v => String(v).trim())
      .filter(v => /^\d{5,12}$/.test(v)),
  };
}

// 定位 cloudflared：pm2/systemd 启动的实例 PATH 可能不完整，直接 spawn('cloudflared') 会 ENOENT，
// 所以这里按常见安装位置逐个探测，拿绝对路径去 spawn。
function cloudflaredCandidates() {
  return [
    process.env.CLOUDFLARED_PATH,
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/snap/bin/cloudflared',
    '/opt/cloudflared/cloudflared',
    ...String(process.env.PATH || '')
      .split(':')
      .filter(Boolean)
      .map(dir => `${dir}/cloudflared`),
  ].filter(Boolean)
}

// 部分运行环境（pm2/systemd/容器）里 spawn 直接给命令名会 ENOENT，
// 所以这里逐个候选做存在性 + 可执行性检查，拿绝对路径去 spawn。
// 用 existsSync 兜底：某些沙箱里 accessSync(X_OK) 会被拒，但文件其实可执行。
function resolveCloudflared() {
  const seen = new Set()
  const tried = []
  for (const file of cloudflaredCandidates()) {
    if (seen.has(file)) continue
    seen.add(file)
    let ok = false
    try {
      ok = fs.existsSync(file)
    } catch (_) {}
    if (!ok) {
      tried.push(`${file}(无)`)
      continue
    }
    try {
      fs.accessSync(file, fs.constants.X_OK)
    } catch (_) {
      // existsSync 命中但 X_OK 被拒，仍然尝试用它：spawn 自己会报更准确的错
      tried.push(`${file}(存在,权限未确认)`)
    }
    return file
  }
  logger.warn(
    `[xhh][manual_gt] 未找到 cloudflared，已探测：${tried.join('、') || '(候选为空)'}\n` +
    '  · 安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
    '  · 或运行 tools/manual_gt_tunnel.sh（地址写入 plugins/xhh/data/manual_gt_url，插件自动读取）\n' +
    '  · 或在 config.yaml 填 manual_gt_public_url，指向你自己的固定域名/反向代理',
  )
  return ''
}

// trycloudflare 快速隧道是临时的：进程一挂域名就失效（访问报 530）。
// 优先用后台 systemd 服务（xhh-gt-tunnel.service）写下的地址；
// 没有的话才自己拉一条隧道，并把实际地址打在日志里。
async function startQuickTunnel(port) {
  const fromFile = readTunnelUrlFile();
  if (fromFile) {
    tunnelUrl = fromFile;
    logger.mark(`[xhh][manual_gt] 使用后台隧道地址：${tunnelUrl}`);
    return tunnelUrl;
  }
  if (tunnelFilePending()) {
    logger.mark('[xhh][manual_gt] 检测到后台隧道地址文件，正在等待其写入实际地址…');
    const waited = await waitTunnelUrlFile(20000);
    if (waited) {
      tunnelUrl = waited;
      logger.mark(`[xhh][manual_gt] 使用后台隧道地址：${tunnelUrl}`);
      return tunnelUrl;
    }
    logger.warn('[xhh][manual_gt] 后台隧道 20 秒内没写出地址，改为插件自建隧道');
  }
  if (tunnelUrl) return tunnelUrl;
  if (tunnelPromise) return tunnelPromise;
  tunnelPromise = new Promise((resolve) => {
    let child;
    let settled = false;
    let buf = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tunnelProc = null;
      tunnelPromise = null;
      resolve(value);
    };
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!m) return;
      tunnelUrl = m[0];
      logger.mark(`[xhh][manual_gt] 临时公网地址：${tunnelUrl}（trycloudflare 隧道，重启后地址会变）`);
      finish(tunnelUrl);
    };
    // 冷启动时 cloudflared 连边缘节点可能要十几秒，20s 太紧会误报超时
    const timer = setTimeout(() => {
      // 把 cloudflared 的原始输出打出来，否则「超时」没有任何线索可查
      const tail = buf.trim().split('\n').slice(-12).join(' | ').slice(0, 900);
      logger.warn(
        `[xhh][manual_gt] 等待 cloudflared 公网地址超时（45s，pid=${child?.pid ?? '无'}）` +
        (tail ? `\ncloudflared 输出：${tail}` : '\ncloudflared 没有任何输出（可能进程已退出或被环境限制）'),
      );
      finish('');
    }, 45000);
    const bin = resolveCloudflared();
    if (!bin) {
      logger.warn(
        '[xhh][manual_gt] 未找到可用的 cloudflared，公网访问请手动配置 manual_gt_public_url' +
        '（或安装 cloudflared 后用 xhh/tools/manual_gt_tunnel.sh 起隧道）',
      );
      // 必须 finish：否则这个 Promise 永远不 resolve，调用方会一直等到 45s 超时定时器，
      // 日志里就会出现「pid=无 / 没有任何输出」这种误导信息。
      finish('');
      return '';
    }
    logger.mark(`[xhh][manual_gt] 使用 cloudflared：${bin}`);
    try {
      const extra = process.env.XHH_CLOUDFLARED_PROTOCOL
        ? ['--protocol', process.env.XHH_CLOUDFLARED_PROTOCOL]
        : [];
      child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', ...extra], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: process.env.HOME || '/tmp' },
      });
      logger.mark(`[xhh][manual_gt] 已拉起 cloudflared（pid=${child.pid}，端口 ${port}${extra.length ? '，' + extra.join(' ') : ''}）`);
      tunnelProc = child;
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', err => {
        logger.warn(`[xhh][manual_gt] 启动 cloudflared(${bin}) 失败：${err?.message || err}`);
        finish('');
      });
      child.on('exit', (code, signal) => {
        if (!settled) {
          logger.warn(`[xhh][manual_gt] cloudflared 进程退出（code=${code} signal=${signal}），未能取得公网地址`);
          finish('');
        }
      });
    } catch (err) {
      logger.warn(`[xhh][manual_gt] 启动 cloudflared(${bin}) 失败：${err?.message || err}`);
      finish('');
    }
  });
  return tunnelPromise;
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(raw || '{}')); } catch (_) { return resolve({}); }
      }
      const params = new URLSearchParams(raw);
      const obj = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      resolve(obj);
    });
  });
}

async function waitForPublicUrl(cfg) {
  if (cfg.publicUrl && !/trycloudflare\.com$/i.test(cfg.publicUrl)) return cfg.publicUrl;
  if (cfg.autoTunnel) return startQuickTunnel(cfg.port);
  return cfg.publicUrl || '';
}

function page(key, testMode = false) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><title>小花火手动验证</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1c2438,#41245a);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#fff}.card{width:min(92vw,420px);padding:28px;border-radius:22px;background:rgba(255,255,255,.12);box-shadow:0 18px 60px rgba(0,0,0,.35);backdrop-filter:blur(12px);text-align:center}.title{font-size:24px;font-weight:800;margin-bottom:10px}.sub{opacity:.82;margin-bottom:22px;line-height:1.7}.btn{border:0;border-radius:999px;padding:13px 24px;background:#7cf3d0;color:#102236;font-weight:800;font-size:16px}.wait{display:none;margin:18px 0}.tip{margin-top:18px;font-size:14px;opacity:.78}.ok{font-size:22px;font-weight:800;color:#7cf3d0}</style></head><body><div class="card"><div class="title">小花火手动验证</div><div class="sub" id="sub">米游社签到遇到验证码，请点击下方按钮完成验证。</div><div id="captcha" data-key="${key}"><button class="btn" id="btn">点击验证</button><div class="wait" id="wait">验证码加载中...</div></div><div class="tip">完成后可以回到 QQ 等待签到结果。</div></div><script src="https://static.geetest.com/static/tools/gt.js"></script><script>
const btn=document.getElementById('btn'),wait=document.getElementById('wait'),sub=document.getElementById('sub'),key=document.getElementById('captcha').dataset.key;const testMode=${testMode ? 'true' : 'false'};let captcha=null;
function done(){btn.style.display='none';wait.style.display='none';sub.innerHTML='<div class="ok">验证成功</div>可以关闭本页面了';}
function submit(v){btn.style.display='none';wait.style.display='block';fetch('./validate/'+key,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)}).then(done).catch(()=>{sub.textContent='提交失败，请重试';wait.style.display='none';btn.style.display='inline-block'})}
function load(){if(testMode){submit({geetest_challenge:'test-challenge',geetest_validate:'test-validate',geetest_seccode:'test-validate|jordan'});return}btn.style.display='none';wait.style.display='block';fetch('./register/'+key).then(r=>r.json()).then(d=>{if(d.status||!d.data){sub.textContent=d.message||'验证信息不存在或已失效';wait.style.display='none';return}const c=d.data;initGeetest({gt:c.gt,challenge:c.challenge,new_captcha:c.new_captcha||1,offline:!c.success,product:'bind',width:'100%'},obj=>{captcha=obj;wait.style.display='none';obj.onReady(()=>obj.verify());obj.onSuccess(()=>submit(obj.getValidate()));obj.onClose(()=>{btn.style.display='inline-block'});obj.onError(()=>{btn.style.display='inline-block';sub.textContent='验证码加载失败，请重试'})})}).catch(()=>{sub.textContent='网络错误，请重试';wait.style.display='none';btn.style.display='inline-block'})}
btn.onclick=()=>captcha?captcha.verify():load();
</script></body></html>`;
}

function cleanup(key) {
  const item = tasks.get(key);
  if (item?.timer) clearTimeout(item.timer);
  tasks.delete(key);
}

function makeTask(data, publicUrl = '', test = false) {
  const cfg = getManualCfg();
  const key = crypto.randomBytes(4).toString('hex');
  tasks.set(key, {
    data: {
      gt: data.gt,
      challenge: data.challenge,
      new_captcha: data.new_captcha || 1,
      success: data.success ?? 1,
      uid: data.uid || '',
    },
    result: null,
    test,
    timer: setTimeout(() => cleanup(key), cfg.timeout * 1000),
  });
  const base = publicUrl || `http://127.0.0.1:${cfg.port}`;
  return {
    key,
    link: `${base}${cfg.path}/${key}`,
    result: `${base}${cfg.path}/validate/${key}`,
  };
}

function ensureServer() {
  const cfg = getManualCfg();
  if (!cfg.enable) return false;
  if (server && startedPort === cfg.port) return true;
  if (server) try { server.close(); } catch (_) {}
  server = http.createServer(async (req, res) => {
    const cfg = getManualCfg();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const base = cfg.path;
    if (!url.pathname.startsWith(base + '/')) return sendJson(res, { status: 1, message: 'Not Found' }, 404);
    const rest = url.pathname.slice(base.length + 1).split('/').filter(Boolean);
    const [action, key] = rest.length === 1 ? ['index', rest[0]] : rest;
    if (req.method === 'POST' && (action === 'register' || (action === 'index' && key === 'register'))) {
      const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const hit = registerHits.get(ip);
      if (!hit || now - hit.startedAt >= REGISTER_WINDOW_MS) {
        registerHits.set(ip, { startedAt: now, count: 1 });
      } else if (hit.count >= REGISTER_LIMIT) {
        return sendJson(res, { status: 1, message: '请求过于频繁，请稍后再试' }, 429);
      } else {
        hit.count += 1;
      }
      const body = await readBody(req);
      if (!body) return sendJson(res, { status: 1, message: '请求体过大' }, 413);
      if (!body?.gt || !body?.challenge) return sendJson(res, { status: 1, message: '缺少 gt 或 challenge' }, 400);
      const task = makeTask(body, await waitForPublicUrl(getManualCfg()));
      return sendJson(res, {
        status: 0,
        message: 'OK',
        data: { link: task.link, result: task.result },
      });
    }
    if (!key || !tasks.has(key)) return sendJson(res, { status: 1, message: '验证信息不存在或已失效' }, 404);
    const task = tasks.get(key);
    if (req.method === 'GET' && action === 'index') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(key, !!task.test));
    }
    if (req.method === 'GET' && action === 'register') return sendJson(res, { status: 0, message: 'OK', data: task.data });
    if (req.method === 'POST' && action === 'validate') {
      const body = await readBody(req);
      task.result = body;
      task.doneAt = Date.now();
      return sendJson(res, { status: 0, message: 'OK', data: {} });
    }
    if (req.method === 'GET' && action === 'validate') return sendJson(res, { status: task.result ? 0 : 1, message: task.result ? 'OK' : 'WAIT', data: task.result || null });
    return sendJson(res, { status: 1, message: 'Not Found' }, 404);
  });
  server.on('error', err => {
    logger.error(`[xhh][manual_gt] 服务启动失败: ${err.message}（端口 ${cfg.port} 可能被占用，可在 config.yaml 改 manual_gt_port）`);
  });
  server.listen(cfg.port, cfg.host, () => logger.mark(`[xhh][manual_gt] 手动验证码服务启动: ${cfg.host}:${cfg.port}${cfg.path}`));
  startedPort = cfg.port;
  return true;
}

// 供插件载入时调用：启动失败只记日志，不影响插件本身
export function startManualGeetest() {
  try {
    const cfg = getManualCfg();
    // 这里只起本地 http 服务，不预热隧道。
    // 隧道是「真的遇到验证码、要用链接」时才拉（见 waitForPublicUrl）：
    // 提前拉会在每次重启后白占 20~45s 和 24MB 内存，用户可能一整天都不撞码。
    return ensureServer();
  } catch (err) {
    logger.error(`[xhh][manual_gt] 服务启动异常: ${err?.message || err}`);
    return false;
  }
}

// 发送验证码通知。
// 定时任务里 e.reply 是空壳（bbsSignForUser 构造的 e.reply = async () => false），
// 直接 await e.reply 只会静默丢弃，用户永远收不到链接。
// 因此先判断 e.reply 是否真的可用，不可用时改用 Bot.pickGroup 主动发群消息。
// @ 的是「这条签到失败对应的成员」——即 e.user_id（社区/游戏签到任务里就是那个失败账号的 QQ），
// 由他自己去网页过滑块；notifyAt 仅作为额外补充（例如需要同时提醒管理员时再填）。
async function notifyCaptcha(e, cfg, text) {
  const recalled = { recallMsg: cfg.timeout };
  // 手动指令触发的场景（e.reply 真实可用且在群里）直接回复即可
  if (typeof e?.reply === 'function' && e.isGroup) {
    try {
      const ok = await e.reply(text, true, recalled);
      if (ok !== false) return true;
    } catch { /* 落到下面的群推送 */ }
  }
  const gid = cfg.notifyGroup || (e?.isGroup ? Number(e.group_id) : 0);
  if (!gid) {
    logger.warn('[xhh][manual_gt] 无可用通知渠道（e.reply 不可用且未配置 manual_gt_notify_group），验证码链接未送达');
    return false;
  }
  // 优先 @ 本次失败账号的 QQ（定时任务构造的 e.user_id），再补上额外通知对象并去重
  const ats = [];
  for (const q of [e?.user_id, ...cfg.notifyAt]) {
    const s = String(q ?? '').trim();
    if (/^\d{5,12}$/.test(s) && !ats.includes(s)) ats.push(s);
  }
  try {
    // 必须用 segment.at()，直接拼 [CQ:at,qq=xxx] 字符串在 TRSSYz/OneBotv11 下不会被渲染成 @，
    // 会原样显示成字面量
    const msg = ats.length
      ? [...ats.map(q => segment.at(q)), '\n', text]
      : text;
    const sent = await Bot.pickGroup(gid).sendMsg(msg);
    // 这条是主动群发，e.reply 的 recallMsg 选项在这里完全不生效（定时任务里 e.reply
    // 还是空壳 async () => false），所以以前这条验证码通知是永不撤回的。
    // 板块有 7 个、群和号一多就会刷屏。按验证有效期 cfg.timeout 到点撤回，
    // 用户该点的时间已经给足了。
    const msgId = pickSentMsgId(sent);
    const willRecall = scheduleGroupRecall(gid, sent, Math.max(30, Number(cfg.timeout) || 120));
    logger.mark(`[xhh][manual_gt] 验证码通知已发送（群 ${gid}${ats.length ? '，已 @' + ats.join(',') : ''}${willRecall ? `，${cfg.timeout}s 后自动撤回` : '，未取到消息ID无法撤回'}）`);
    return true;
  } catch (err) {
    logger.error(`[xhh][manual_gt] 验证码通知发送失败（群 ${gid}）: ${err?.message || err}`);
    return false;
  }
}

export async function manualGeetest(e, data = {}, title = '米游社签到') {
  const cfg = getManualCfg();
  if (!cfg.enable || !data.gt || !data.challenge) return false;
  if (!ensureServer()) return false;
  const publicUrl = await waitForPublicUrl(cfg);
  if (cfg.autoTunnel && !publicUrl && !cfg.publicUrl) {
    logger.warn('[xhh][manual_gt] 没有可用公网地址，未发送无法访问的本机验证码链接');
    await e.reply('手动验证码服务没有可用的公网地址，请配置 manual_gt_public_url，或安装并启动 cloudflared。', true);
    return false;
  }
  const task = makeTask(data, publicUrl);
  const { key, link } = task;
  await notifyCaptcha(e, cfg, `${title}遇到验证码，请打开地址并完成验证：\n${link}\n验证有效期 ${cfg.timeout} 秒，完成后小花火会自动重试。`);
  for (let i = 0; i < cfg.timeout; i += 2) {
    const task = tasks.get(key);
    if (task?.result?.geetest_validate) {
      const v = task.result;
      cleanup(key);
      return {
        gt: data.gt,
        challenge: v.geetest_challenge,
        validate: v.geetest_validate,
        seccode: v.geetest_seccode || `${v.geetest_validate}|jordan`,
      };
    }
    await sleep(2000);
  }
  cleanup(key);
  return false;
}

// 自测：造一个假任务发链接，用于验证服务监听、页面渲染、Geetest 静态资源是否可达
export async function manualGeetestTest(e) {
  const cfg = getManualCfg();
  if (!ensureServer()) return e.reply('手动验证服务未启用（config.yaml 里 manual_gt_enable: false）', true);
  const publicUrl = await waitForPublicUrl(cfg);
  const key = crypto.randomBytes(4).toString('hex');
  const base = publicUrl || `http://127.0.0.1:${cfg.port}`;
  const link = `${base}${cfg.path}/${key}`;
  tasks.set(key, {
    data: { gt: '0353574b7c8c2066f884fd8ee1b1c8b2', challenge: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', new_captcha: 1, success: 1, uid: 'self-test' },
    result: null,
    test: true,
    timer: setTimeout(() => cleanup(key), cfg.timeout * 1000),
  });
  const publicTip = publicUrl
    ? `公网地址：${publicUrl}`
    : '公网地址：未配置，且没读到隧道地址 → 下面的链接只能在服务器本机打开，手机上打不开';
  await e.reply(
    `手动验证完整流程模拟\n模拟接口返回：1034（验证码）\n本地监听：${cfg.host}:${cfg.port}\n${publicTip}\n测试链接：\n${link}\n\n打开链接后点击「模拟提交验证」，机器人会等待并模拟重试签到。${
      cfg.publicUrl ? '' : '\n提示：手机/其他设备请用 xhh/tools/manual_gt_tunnel.sh 起隧道，或把固定域名填进 manual_gt_public_url。'
    }`,
    true,
    { recallMsg: cfg.timeout },
  );
  for (let i = 0; i < Math.min(cfg.timeout, 30); i += 1) {
    const task = tasks.get(key);
    if (task?.result?.geetest_validate) {
      cleanup(key);
      logger.mark('[xhh][manual_gt] 模拟验证码提交成功，模拟签到重试成功');
      return e.reply('手动验证完整流程模拟成功：已收到验证结果，并完成模拟签到重试。', true);
    }
    await sleep(1000);
  }
  cleanup(key);
  return e.reply('手动验证完整流程模拟超时：没有收到网页提交结果。', true);
}


// 端到端清一次米游社风控：createVerification → 手动页面 → verifyVerification。
// 卡池刷新、签到、查询等任何撞上 1034 的场景都可以复用它。
// gids=2 对应社区（bbs）通道，解除后对应接口即可正常访问。
export async function mihoyoClearRisk(e, label = '米游社风控') {
  const cfg = getManualCfg();
  if (!cfg.enable) return { ok: false, reason: '手动过码服务未启用（manual_gt_enable: false）' };
  if (!ensureServer()) return { ok: false, reason: '本地验证服务启动失败' };
  const { default: api } = await import('./api.js');
  const { default: mhy } = await import('./mhy.js');
  const uid = e?.user?.getUid?.('gs') || e?.user?.getUid?.() || '';
  let sk = '';
  try {
    sk = uid ? await mhy.getstoken(e, uid) : '';
  } catch (_) {}
  if (!sk) return { ok: false, reason: '未绑定米游社 SToken，无法构造验证请求' };

  const headers = mhy.getHeaders(e, sk, false);
  headers['x-rpc-client_type'] = 5;
  headers.DS = mhy.getDs2('gids=2&is_high=false', '', 4);
  const create = await api(e, { headers, type: 'createVerification' });
  if (Number(create?.retcode) !== 0 || !create?.data?.gt) {
    return { ok: false, reason: `申请验证码失败 retcode=${create?.retcode} message=${create?.message || '无'}` };
  }
  const validated = await manualGeetest(e, { ...create.data, uid }, label);
  if (!validated?.validate) return { ok: false, reason: '未完成验证（超时或关闭）' };
  const body = JSON.stringify({
    geetest_challenge: validated.challenge || create.data.challenge,
    geetest_validate: validated.validate,
    geetest_seccode: validated.seccode || `${validated.validate}|jordan`,
  });
  const verify = await api(e, { headers: { ...headers, DS: mhy.getDs2('', body, 4) }, type: 'verifyVerification', body });
  if (Number(verify?.retcode) !== 0) {
    return { ok: false, reason: `回交校验失败 retcode=${verify?.retcode} message=${verify?.message || '无'}` };
  }
  return { ok: true, challenge: verified?.challenge };
}

export default { manualGeetest, ensureServer, startManualGeetest, manualGeetestTest, mihoyoClearRisk };
