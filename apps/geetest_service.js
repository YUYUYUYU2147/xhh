import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config, yaml, sleep, pluginPriority, ttocrPoints } from '#xhh';

const execAsync = promisify(exec);

// service/geetest 由 #过码部署 装在本机，只监听 127.0.0.1
const SERVICE_DIR = './plugins/xhh/service/geetest';
const VENV_DIR = `${SERVICE_DIR}/.venv`;
const PM2_NAME = 'xhh-geetest-solver';

const IS_WIN = process.platform === 'win32';

/**
 * venv 里的解释器路径。
 *
 * 别按平台硬判断 —— WSL、Git Bash、Cygwin 这些环境下 process.platform 可能仍是
 * win32 或 linux，但 venv 是按「谁建的」决定目录结构的。直接按候选列表逐个探测，
 * 哪个存在用哪个，跨平台、半平台都能覆盖。
 *
 * 找不到返回空串，由调用方据此判断「还没建 venv」。
 */
function venvPython() {
    const candidates = IS_WIN
        ? [
              ['Scripts', 'python.exe'],
              ['Scripts', 'python'],
              ['bin', 'python'],
          ]
        : [
              ['bin', 'python3'],
              ['bin', 'python'],
              ['Scripts', 'python.exe'],
          ];
    for (const rel of candidates) {
        const p = path.join(VENV_DIR, ...rel);
        if (fs.existsSync(p)) return p;
    }
    return '';
}

/**
 * 建 venv 要用哪个命令。Windows 上通常没有 python3，只有 python 或 py。
 * 依次试哪个行用哪个 —— 光判 platform 会在装了 py 启动器的机器上判错。
 */
async function resolvePythonCmd() {
    const tries = IS_WIN
        ? [
              ['py', ['-3']],
              ['python', []],
          ]
        : [
              ['python3', []],
              ['python', []],
          ];
    for (const [cmd, args] of tries) {
        if (await has(`${cmd} ${args.join(' ')} -V`)) return { cmd, args };
    }
    return null;
}

/** 引号包裹，路径里有空格（Windows 下 Program Files 之类）也不会散 */
function q(s) {
    return `"${String(s)}"`;
}

/** 拼一个 shell 命令串。Windows 用 cmd 语法，POSIX 用 sh 语法。 */
function sh(...parts) {
    return parts.filter(Boolean).join(IS_WIN ? ' && ' : ' && ');
}

// 默认端口。刻意不跟 xhh-TL 的 8766 一致：同一台机器上两个插件各起一份服务时，
// 端口撞了就会出现「A 插件的部署答了 B 插件的请求」，这种错最难查。
// 换端口是最省事的隔离办法。改了这里要同步改 service/geetest/server.py 的 GT_PORT 默认值。
// 本机 2147 / 2148 已被 1Panel 占用，所以取 2149。
const PORT = 2149;

function addr() {
    return String(config()?.auto_verify_addr || `http://127.0.0.1:${PORT}/solve`).trim();
}
function baseUrl() {
    return addr().replace(/\/solve\/?$/, '');
}

// 按响应耗时挑最快的源。默认源在部分机器上很慢甚至超时，逐个试直到有一个成的。
const PIP_MIRRORS = [
    'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.aliyun.com/pypi/simple',
    'https://pypi.org/simple',
];

async function run(cmd, timeout = 300000) {
    return execAsync(cmd, { timeout, maxBuffer: 8 * 1024 * 1024 });
}

async function has(cmd) {
    try {
        await run(cmd, 15000);
        return true;
    } catch {
        return false;
    }
}

async function health() {
    try {
        const resp = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(5000) });
        return await resp.json();
    } catch {
        return null;
    }
}

/**
 * 这个进程是不是本插件 pm2 管的。
 *
 * pm2 jlist 的输出前面可能夹带 `[PM2] Spawning…` 之类的提示（首次拉起 daemon 时
 * 会出现），直接 JSON.parse 会把提示里的 [ 当成数组开头而报错，误判成「没部署」。
 * 所以这里从第一个 [ 开始截取再解析。
 */
async function pm2HasProcess() {
    if (!await has('pm2 -v')) return null; // 没装 pm2，返回 null 表示「说不准」
    try {
        const { stdout } = await run('pm2 jlist', 20000);
        const start = stdout.indexOf('[');
        if (start < 0) return false;
        const list = JSON.parse(stdout.slice(start));
        return Array.isArray(list) && list.some(p => p?.name === PM2_NAME);
    } catch {
        return false;
    }
}

async function pipInstall(pyPath) {
    if (!pyPath) throw new Error('找不到 venv 里的 python，装不了依赖');
    const tries = [];
    for (const mirror of PIP_MIRRORS) {
        try {
            const { stderr } = await run(
                `${q(pyPath)} -m pip install -q --disable-pip-version-check -i ${mirror} -r ${q(`${SERVICE_DIR}/requirements.txt`)}`,
                900000
            );
            if (/ERROR|error:/.test(stderr || '')) throw new Error(stderr.slice(0, 200));
            return mirror;
        } catch (err) {
            tries.push(`${new URL(mirror).host} 失败：${String(err.message).split('\n')[0].slice(0, 80)}`);
        }
    }
    throw new Error(`所有 pip 源都没装上\n${tries.join('\n')}`);
}

/**
 * glibc 太低装不上 bili-ticket-gt-python（它只有 manylinux_2_31 的 wheel）。
 * 不预检的话，用户看到的是一堆 pip 报错，看不出真正原因是系统太老。
 */
async function glibcTooLow() {
    if (IS_WIN) return null; // Windows 没有 glibc 这回事
    try {
        const { stdout } = await run('ldd --version', 15000);
        const m = String(stdout).match(/(\d+)\.(\d+)/);
        if (!m) return null;
        const [major, minor] = [Number(m[1]), Number(m[2])];
        // 低于 2.31 就装不上那个编译包
        return major < 2 || (major === 2 && minor < 31) ? `${major}.${minor}` : null;
    } catch {
        return null; // 查不到就别拦，让 pip 自己报错
    }
}

export class GeetestService extends plugin {
    constructor(e) {
        super({
            name: '[小花火]过码服务',
            dsc: '米游社极验滑块全自动过码服务的部署与状态',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [
                // 「部署」既可能写在前面（#部署过码）也可能写在后面（#过码部署），两种都得认
                { reg: '^#*(小花火|xhh)*(部署|安装)?(过码|滑块)(服务|解码器)?(部署|安装)?$', fnc: 'deploy', permission: 'master' },
                { reg: '^#*(小花火|xhh)*(过码|滑块)(服务|解码器)?(状态|情况)$', fnc: 'status' },
            ],
        });
    }

    async status(e) {
        // 打码平台是可选的第二级，单独一行说明状态（没配 appkey 就说没配）
        let platform = '打码平台：未配置 ttocr_appkey，不启用';
        if (String(config()?.ttocr_appkey || '').trim()) {
            const pts = await ttocrPoints();
            platform = `打码平台：已启用，剩余 ${pts || '未知'}`;
        }
        const h = await health();
        if (!h?.ok) {
            return e.reply(
                `过码服务地址：${addr()}\n未运行或探不到。\n` +
                '本机装服务：#过码部署（需主人权限）\n' +
                `${platform}\n` +
                (IS_WIN ? '装依赖需要 Python 与 venv；' : '装依赖需要 python3 与 venv；') +
                    '服务只监听 127.0.0.1，不对外暴露。',
                true
            );
        }
        const s = h.stats || {};
        // 端口活着、进程却不在本插件的 pm2 表里 —— 旧版本部署留下的（或手工起的）。
        // 这时点 pm2 restart 只会去动一个不存在的进程，而实际在答的还是那个野生的。
        const managed = await pm2HasProcess();
        const orphan = managed === false;
        return e.reply(
            `过码服务地址：${addr()}\n运行中\n` +
            `累计成功 ${s.success ?? '-'}，失败 ${s.failed ?? '-'}，成功率 ${s.successRate ?? '-'}` +
            (s.avgRounds ? `，平均 ${s.avgRounds} 轮 / ${s.avgSeconds} 秒` : '') + '\n' +
            // 熔断中是瞬时状态，得看得见，否则「一直失败」和「被熔断拒了」分不清
            (s.breakerOpen ? `⚡ 熔断中（连续失败 ${s.breakerFail} 次），期间请求会秒回并走兜底，稍后自动恢复\n` : '') +
            (orphan
                ? `\n⚠️ 服务在跑，但不在本插件的进程表里（pm2 里没有 ${PM2_NAME}）\n` +
                  `多半是旧版本部署或手工起（nohup / start /b）留下的。想让本插件接管：\n` +
                  `· 执行 pm2 delete ${PM2_NAME} 后重发 #过码部署\n` +
                  '· 或直接重启一次机器（过码服务不会自启）\n'
                : '') +
            `${platform}`,
            true
        );
    }

    async deploy(e) {
        const pre = await health();
        if (pre?.ok) {
            // 端口已经在响应，但进程不一定归本插件管。旧版本部署留下的是直连 pm2 或
            // 手工 nohup 起的进程，端口被它占着，新进程根本起不来。
            // 不做检查就往下走，最后会「看起来部署成功、实际还是旧进程在答」。
            const managed = await pm2HasProcess();
            if (managed === false) {
                return e.reply(
                    [
                        `过码服务正在运行（${addr()}），但不在本插件的进程表里`
                            + `（pm2 里没有 ${PM2_NAME}）。`,
                        '',
                        '这多半是旧版本部署或手工启动留下的进程。要让本插件接管：',
                        `· 机器人所在设备执行：pm2 delete ${PM2_NAME}`,
                        '· 或直接重启一次机器（过码服务不会自启）',
                        '',
                        '停掉之后再发一次本指令。',
                    ].join('\n'),
                    true
                );
            }
            return e.reply(`过码服务已经在跑了（${addr()}）。\n发「#过码服务状态」看统计`, true);
        }

        const steps = [];
        const step = async (label, fn) => {
            await e.reply(`[过码部署] ${label}…`);
            const r = await fn();
            steps.push(label);
            return r;
        };

        // 1) 前置检查。python 命令名按平台试 —— Windows 上通常没有 python3
        const py = await resolvePythonCmd();
        if (!py) {
            return e.reply(
                IS_WIN
                    ? '找不到 Python，装不了。Windows 上请先装 Python，安装时勾选「Add to PATH」。'
                    : '找不到 python3，装不了。',
                true
            );
        }
        const pyBase = `${py.cmd} ${py.args.join(' ')}`.trim();
        if (!await has(`${pyBase} -c "import venv"`)) {
            return e.reply(
                IS_WIN
                    ? '这个 Python 缺 venv 模块，装不了。重新运行 Python 安装程序并勾选 venv 组件。'
                    : '这个 python3 缺 venv 模块，装不了（Debian/Ubuntu 装 python3-venv）。',
                true
            );
        }

        // 2) 虚拟环境
        await step('创建虚拟环境', async () => {
            // 已经建好就直接复用。用 fs 探测而不是 test -x —— 后者在 Windows 上不存在。
            if (venvPython()) return '复用已有';
            await run(`${pyBase} -m venv ${q(VENV_DIR)}`, 300000);
            const found = venvPython();
            if (!found) {
                throw new Error(
                    `venv 建好了但找不到解释器（试过 ${VENV_DIR}/bin 与 ${VENV_DIR}/Scripts）`
                );
            }
            return '已创建';
        });

        // 3) 依赖
        // 先看 glibc —— bili-ticket-gt-python 只有 manylinux_2_31 的 wheel，
        // 系统太老时装不上，却会报一堆看不出所以然的 pip 错。提前说清。
        const libc = await glibcTooLow();
        if (libc) {
            return e.reply(
                `[过码部署] 装不了：系统 glibc ${libc} 太低。\n` +
                    'bili-ticket-gt-python 只有 manylinux_2_31 及以上的编译包，需要 glibc 2.31 以上。\n' +
                    'Debian/Ubuntu 可升级系统，或换更新的发行版。\n' +
                    '暂时仍可手动过码（撞风控时会给验证链接）。',
                true
            );
        }
        await step('安装依赖（首次较慢，bili-ticket-gt-python 是编译包）', async () => {
            const mirror = await pipInstall(venvPython());
            return `已装（源：${new URL(mirror).host}）`;
        });

        // 4) 启动
        const started = await step('启动服务', async () => {
            const pyPath = venvPython();
            if (!pyPath) throw new Error('找不到 venv 里的 python，服务起不来');
            if (await has('pm2 -v')) {
                try { await run(`pm2 delete ${PM2_NAME}`, 30000); } catch { /* 本来就没有，忽略 */ }
                await run(`pm2 start ${q(pyPath)} --name ${PM2_NAME} -- ${q(`${SERVICE_DIR}/server.py`)}`, 120000);
                try { await run('pm2 save', 60000); } catch { /* save 失败不影响运行 */ }
                return `pm2 托管（${PM2_NAME}）`;
            }
            // 没有 pm2 就后台起，够用；重启后需要重新部署。
            // POSIX 用 nohup + disown，Windows 用 start /b —— 那套 shell 语法在 cmd 下不成立。
            const script = `${SERVICE_DIR}/server.py`;
            if (IS_WIN) {
                await run(sh(`cd ${q(SERVICE_DIR)}`, `start "" /b ${q(pyPath)} server.py > ${q(`${SERVICE_DIR}/server.log`)} 2>&1`));
                return '后台运行（本机没装 pm2，重启后需重新部署）';
            }
            await run(sh(`cd ${q(SERVICE_DIR)}`, `nohup ${q(pyPath)} server.py > ${q(`${SERVICE_DIR}/server.log`)} 2>&1 & disown`));
            return 'nohup 后台运行（本机没装 pm2，重启后需重新部署）';
        });

        // 5) 验活
        let h = null;
        for (let i = 0; i < 10 && !h?.ok; i++) {
            await sleep(1000);
            h = await health();
        }
        if (!h?.ok) {
            const log = await has(`test -f "${SERVICE_DIR}/server.log"`) ? '\n日志：#小花火 过码服务日志' : '';
            return e.reply(
                `[过码部署] 服务起来了但探不到响应。\n已完成：${steps.join(' → ')}\n启动方式：${started}${log}\n` +
                '常见原因：依赖没装成功（glibc 太低）、端口被占。可以先看 server.log。',
                true
            );
        }

        return e.reply(
            `[过码部署] 完成\n` +
            `已完成：${steps.join(' → ')}\n` +
            `启动方式：${started}\n` +
            `地址：${addr()}\n` +
            '撞米游社风控时会自动调用它过滑块，不需要手动操作。发「#过码服务状态」看统计。',
            true
        );
    }
}
