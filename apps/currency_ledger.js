import moment from 'moment';
import fs from 'fs';
import path from 'path';
import { render, pluginPriority, mhy, config } from '#xhh';
import MysInfo from '../../genshin/model/mys/mysInfo.js';
import { xhh_gacha_pool } from './gacha_pool.js';
import { getRoleProfile, serverName as toServerName } from '../system/roleProfile.js';
/**
 * 原神原石 / 星铁星琼 / 绝区零菲林的月报与统计
 *
 * 三个游戏都走米游社的「月报」接口，只是端点和字段名不一样：
 *
 *   原神   ys_ledger/monthInfo       month 传 1~12
 *          month_data.current_primogems / last_primogems / gacha
 *          month_data.group_by = [{ name, num, icon }]
 *
 *   星铁   srledger/month_info       month 传 YYYYMM
 *          month_data.current_hcoin / last_hcoin / current_rails_pass
 *          month_data.group_by = [{ action, action_name, num, icon, percent }]
 *
 *   绝区零 nap_ledger/month_info     month 传 YYYYMM
 *          month_data.list = [{ data_type, count }]（PolychromesData=菲林…）
 *          month_data.income_components = [{ action, num, percent }]
 *
 * 鉴权与端点都复用 genshin 插件的 MysInfo，这里只做「取数 + 归一化 + 渲染」。
 */
const DATA_DIR = './plugins/xhh/data/CurrencyLedger';
const ZZZ_ACTION_NAME = {
    event_rewards: '活动奖励',
    daily_activity_rewards: '日常活跃奖励',
    shiyu_rewards: '式舆防卫战&危局强袭战奖励',
    mail_rewards: '邮件奖励',
    growth_rewards: '成长奖励',
    hollow_rewards: '零号空洞奖励',
    other_rewards: '其他奖励',
};

// 统计图配色，与崩三水晶统计保持一致
const PIE_COLORS = ['#73a8c6', '#d56565', '#70b2b4', '#bd9a5a', '#739970', '#7a6da7', '#597ea0', '#c98fb0'];
const GAMES = {
    gs: {
        key: 'gs',
        name: '原神',
        alias: '原神原石',
        sub: 'GENSHIN IMPACT',
        title: '原神 · 原石札记',
        unit: '原石',
        extraName: '摩拉',
        accent: '#c9a227',
        // 原石的 month 是「几月」，不是 YYYYMM
        monthArg: m => String(m.month),
    },
    sr: {
        key: 'sr',
        name: '星铁',
        alias: '星铁星琼',
        sub: 'HONKAI: STAR RAIL',
        title: '崩坏：星穹铁道 · 开拓月历',
        unit: '星琼',
        extraName: '开拓力',
        accent: '#5b8fd6',
        monthArg: m => m.ym,
    },
    zzz: {
        key: 'zzz',
        name: '绝区零',
        alias: '绝区零菲林',
        sub: 'ZENLESS ZONE ZERO',
        title: '绝区零 · 菲林月报',
        unit: '菲林',
        extraName: '加密母带',
        accent: '#e8a33d',
        monthArg: m => m.ym,
    },
};
// 卡池那边 gameName 用的是中文全称，这里做一次映射
const POOL_GAME_NAME = { gs: '原神', sr: '星穹铁道', zzz: '绝区零' };

/**
 * 统计页右上角装饰图。
 *
 * 用户要的是「当前卡池那张图右上角」的那张 —— 也就是卡池渲染器里的 markIcon。
 * 直接调 gacha_pool 的 fixedCornerFallback()，和 srCurrentPool / gsCurrentPool 等
 * 走的是同一个函数、同一套优先级（fixed_splash 目录 → getMarkIcon → gameMarkIcon），
 * 所以两个地方的图必然一致，不会出现「账本这边换了图、卡池那边没换」。
 *
 * 返回值可能是插件内相对路径（如 gs_mark/paimon.png），也可能是别人机器上的
 * 绝对路径（星铁角标取的是 miao-plugin 的三月七立绘），两种都要能显示，
 * 所以下面按是否含 protocol 决定怎么拼。
 */
function poolCornerIcon(e, game) {
    try {
        return new xhh_gacha_pool(e).fixedCornerFallback(POOL_GAME_NAME[game] || '') || '';
    } catch (err) {
        logger.warn?.('[xhh][账本] 取当前卡池角标失败:', err?.message || err);
        return '';
    }
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

function dataPath(game, qq) {
    return path.join(DATA_DIR, game, `${qq}.json`);
}

/**
 * 读存档。
 * 键必须是 YYYYMM —— 早期版本没做校验，原神接口回的 month 可能是 "9"，
 * 于是存档里出现了 '9' 和 '202609' 两个键都代表九月，柱状图就画出两根 9 月的柱子。
 * 这里直接把非法键丢掉，并把它的数据并进同月的那条（数值取较大的那个，避免把已有数据清零）。
 */
function readAll(game, qq) {
    const file = dataPath(game, qq);
    if (!fs.existsSync(file)) return {};
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
    const out = {};
    let dropped = [];
    for (const [k, v] of Object.entries(raw || {})) {
        if (/^\d{6}$/.test(String(k))) {
            out[k] = v;
            continue;
        }
        dropped.push([k, v]);
    }
    if (!dropped.length) return out;
    // 非法键只保留月份数（"9" → 202609 的月份 9），并到当年同月那条上
    const nowYm = moment().format('YYYYMM');
    for (const [k, v] of dropped) {
        const mo = String(k).replace(/\D/g, '').slice(-2);
        if (!/^\d{2}$/.test(mo)) continue;
        const guess = `${nowYm.slice(0, 4)}${mo}`;
        if (out[guess]) {
            if (Number(v?.monthTotal || 0) > Number(out[guess].monthTotal || 0)) {
                out[guess] = { ...out[guess], ...v, ym: guess };
            }
        }
    }
    logger.warn?.(`[xhh][账本] ${game} 存档里有非法月份键 ${dropped.join(',')}，已忽略（统计里原本会多出重复月份）`);
    return out;
}

function writeAll(game, qq, data) {
    fs.mkdirSync(path.join(DATA_DIR, game), { recursive: true });
    fs.writeFileSync(dataPath(game, qq), JSON.stringify(data, null, '\t'));
}

/** 从指令里认出是哪个游戏 */
function pickGame(msg = '') {
    if (/绝区零|菲林|zzz/i.test(msg)) return 'zzz';
    if (/星铁|星穹|星琼|铁道|sr/i.test(msg)) return 'sr';
    return 'gs';
}

/**
 * 解析月份。支持：留空(当月) / 数字 5 / 中文 五 / YYYYMM(202608)
 * 返回 { month: 1~12, ym: 'YYYYMM' }
 */
function parseMonth(msg = '') {
    const now = moment();
    const curMonth = now.month() + 1;
    const text = String(msg || '')
        .replace(/[#＃%％]/g, '')
        .replace(/(原神|原石|星铁|星穹|星琼|铁道|绝区零|菲林|札记|月报|统计)/g, '');
    const ymMatch = /(\d{4})(\d{2})/.exec(text);
    if (ymMatch) return { month: Number(ymMatch[2]), ym: `${ymMatch[1]}${ymMatch[2]}` };

    let month = null;
    const numMatch = /(\d{1,2})/.exec(text);
    if (numMatch) {
        month = Number(numMatch[1]);
    } else {
        // 必须按长度从长到短找：「十二」里也含「二」，先找短的会把十二月认成二月
        const hit = CN_NUM.slice().sort((a, b) => b.length - a.length).find(c => text.includes(c));
        if (hit) month = CN_NUM.indexOf(hit) + 1;
    }
    if (!(month >= 1 && month <= 12)) {
        return { month: curMonth, ym: now.format('YYYYMM') };
    }

    // 往回数月会跨年：1 月往前推是去年的 12 月
    const back = curMonth - month;
    let year = now.year();
    if (back >= 12) year -= 1;
    else if (back > 0 && month > curMonth) year -= 1;
    return { month, ym: `${year}${String(month).padStart(2, '0')}` };
}

// 三个游戏的来源明细条目字段名并不一致，而且原神这套从没被验证过
// （genshin 那边只读了 item.action_id 去取颜色，从没读过名字和数值）。
// 这里对每个字段都接受多种别名，避免猜错一个就把整份明细过滤成空。
const pickSrcName = i => String(
    i?.name ?? i?.title ?? i?.action_name ?? i?.type_name ?? i?.action ?? i?.action_name_cn ?? ''
).trim();
const pickSrcNum = i => Number(i?.num ?? i?.count ?? i?.value ?? i?.amount ?? 0);
const pickSrcList = md => {
    const raw = md?.group_by || md?.income_components || md?.list || [];
    return (Array.isArray(raw) ? raw : [])
        .map(i => ({ name: pickSrcName(i), num: pickSrcNum(i), icon: i?.icon || '' }))
        .filter(i => i.name && i.num > 0);
};

/** 把三个游戏各自不同的响应，统一成同一套字段 */
function normalize(game, res) {
    const d = res?.data || {};
    // 月份键必须是 YYYYMM。原神接口的 month 字段有可能是 "9" 这种只带月份的写法，
    // 直接拿去 slice(0,4)/slice(4) 会得到 "9" 和空串，柱状图的月份标签就渲染不出来。
    // 这里只认 6 位数字，其余交给调用方用「请求的月份」补。
    const ym = v => (/^\d{6}$/.test(String(v || '')) ? String(v) : '');
    if (game === 'gs') {
        const md = d.month_data || {};
        const dd = d.day_data || {};
        return {
            ym: ym(d.month),
            uid: String(d.uid || ''),
            nickname: d.nickname || '',
            avatar: d.avatar || '',
            monthTotal: Number(md.current_primogems || 0),
            lastMonth: Number(md.last_primogems || 0),
            today: Number(dd.current_primogems || 0),
            extra: Number(dd.current_mora || 0),
            gacha: Number(md.gacha || 0),
            list: pickSrcList(md),
        };
    }
    if (game === 'sr') {
        const md = d.month_data || {};
        const dd = d.day_data || {};
        return {
            ym: ym(d.data_month || d.month),
            uid: String(d.uid || ''),
            nickname: d.role_info?.nickname || '',
            avatar: d.role_info?.avatar || '',
            monthTotal: Number(md.current_hcoin || 0),
            lastMonth: Number(md.last_hcoin || 0),
            today: Number(dd.current_hcoin || 0),
            extra: Number(dd.current_rails_pass || 0),
            gacha: Math.floor(Number(md.current_hcoin || 0) / 160),
            list: pickSrcList(md),
        };
    }
    // 绝区零
    const md = d.month_data || {};
    const list = md.list || [];
    const pick = t => Number(list.find(i => i.data_type === t)?.count || 0);
    return {
        ym: ym(d.data_month),
        uid: String(d.uid || ''),
        nickname: d.role_info?.nickname || '',
        avatar: d.role_info?.avatar || '',
        monthTotal: pick('PolychromesData'),
        lastMonth: 0,
        today: 0,
        extra: pick('MatserTapeData'),
        boopons: pick('BooponsData'),
        gacha: 0,
        // 绝区零用 action 枚举，先把枚举翻成中文再走统一提取
        list: pickSrcList({ group_by: (md.income_components || []).map(i => ({ ...i, name: ZZZ_ACTION_NAME[i.action] || i.action })) }),
    };
}

/** 把这个月的快照存下来，统计要用 */
function saveSnapshot(qq, game, snap) {
    if (!snap?.ym) return;
    const all = readAll(game, qq);
    all[snap.ym] = {
        monthTotal: snap.monthTotal,
        lastMonth: snap.lastMonth,
        gacha: snap.gacha,
        list: snap.list,
        // 统计页要显示头像和昵称，这两个字段只有账本接口里有
        nickname: snap.nickname || all[snap.ym]?.nickname || '',
        avatar: snap.avatar || all[snap.ym]?.avatar || '',
        serverName: snap.serverName || all[snap.ym]?.serverName || '',
        uid: snap.uid || all[snap.ym]?.uid || '',
        saveTime: moment().format('YYYY-MM-DD HH:mm:ss'),
    };
    writeAll(game, qq, all);
}

/** 合并各月来源明细（action_id 跨月不稳定，只能按 name 合并） */
function buildSource(list) {
    const merged = new Map();
    for (const m of list) {
        for (const it of m?.list || []) {
            const name = String(it.name || '').trim();
            if (!name || !(Number(it.num) > 0)) continue;
            if (!merged.has(name)) merged.set(name, { name, num: 0 });
            merged.get(name).num += Number(it.num);
        }
    }
    const rows = [...merged.values()].sort((a, b) => b.num - a.num);
    const base = rows.reduce((s, i) => s + i.num, 0);
    // 最大余数法：逐项四舍五入会算出 101% 这种合计，这里先取整再把余数补给小数最大的几项，
    // 保证图例上的百分比加起来正好 100%
    const raw = rows.map(i => (base > 0 ? (i.num / base) * 100 : 0));
    const floor = raw.map(v => Math.floor(v));
    let rest = 100 - floor.reduce((a, b) => a + b, 0);
    const order = raw
        .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac);
    const percent = floor.slice();
    for (const { idx } of order) {
        if (rest <= 0) break;
        percent[idx] += 1;
        rest -= 1;
    }
    return rows.map((i, idx) => ({
        ...i,
        percent: percent[idx],
        color: PIE_COLORS[idx % PIE_COLORS.length],
    }));
}

function toB64(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

export class CurrencyLedger extends plugin {
    constructor() {
        super({
            name: '[小花火]原石星琼菲林账本',
            dsc: '原神原石 / 星铁星琼 / 绝区零菲林的月报与统计',
            event: 'message',
            priority: pluginPriority('currency_ledger', 100),
            rule: [
                {
                    // 前缀沿用插件约定：#小花火xxx / #xhhxxx / #xxx 都行
                    // 游戏名允许叠加（星铁星琼 / 绝区零菲林 都是常见写法），
                    // 月份支持 8 / 八 / 202608 / 十二月 这几种写法
                    reg: '^[#%*]*(小花火|xhh)?[#%*]*(原神|原石|星铁|星穹|星琼|铁道|绝区零|菲林)+(札记|月报)?(统计)?\\s*(\\d{1,6}|[一二两三四五六七八九十]+)?月*$',
                    fnc: 'run',
                },
            ],
        })
    }

    /** 统一的取数入口 */
    async fetch(e, game, mInfo) {
        const meta = GAMES[game];
        const oldGame = e.game;
        const oldNoTips = e.noTips;
        e.game = game;
        e.noTips = false;
        try {
            const res = await MysInfo.get(e, 'ledger', { month: meta.monthArg(mInfo) }, { log: false, game });
            if (!res || res.retcode !== 0) {
                return { error: res?.message || '月报接口返回异常，请确认已扫码绑定 Cookie 且在米游社 App 内开启「账本」权限。' };
            }
            const snap = normalize(game, res);
            // 接口真实字段名有几处从来没被验证过，一次性都打出来，省得反复重启：
            //   1) 原神 group_by 的字段名（猜错整份被过滤成空 → 饼图直接没有）
            //   2) 原神/星铁的 nickname+avatar 位置（zzz 走 role_info 能取到，
            //      gs/sr 存回来是空串，字段名多半也不在 role_info 下）
            if (!snap.list.length || !snap.nickname || !snap.avatar || config().debug) {
                const d = res?.data || {};
                const raw = d.month_data?.group_by;
                // 打印 group_by 每条的实际取值：原神这套只有 action（数字代码）、
                // 没有 action_name，pickSrcName 会把代码当名字用，饼图上就是一堆数字。
                // 星铁有 action_name，但要确认它到底是不是中文。
                const sample = (Array.isArray(raw) ? raw : [])
                    .slice(0, 10)
                    .map(i => `${i?.action ?? '?'}${i?.action_name !== undefined ? `=>${i.action_name}` : ''}:${i?.num ?? '?'}`)
                    .join(' ');
                // 找出所有形如 xxx.nickname / xxx.avatar 的路径，值非空才打印
                const found = [];
                const walk = (obj, path, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 3) return;
                    for (const [k, v] of Object.entries(obj)) {
                        const p = path ? `${path}.${k}` : k;
                        if (/nickname|avatar|head/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
                            if (String(v || '').trim()) found.push(`${p}=${String(v).slice(0, 45)}`);
                        } else if (v && typeof v === 'object') walk(v, p, depth + 1);
                    }
                };
                walk(d, '', 0);
                logger.warn?.(
                    `[xhh][账本] ${game} 字段探测: ` +
                    `group_by=${Array.isArray(raw) ? `array[${raw.length}]` : typeof raw}` +
                    (Array.isArray(raw) && raw[0] ? ` 首条字段=${Object.keys(raw[0]).join(',')}` : '') +
                    ` | 昵称头像命中: ${found.join(' ; ') || '无'}` +
                    ` | data顶层=${Object.keys(d).join(',')}` +
                    (sample ? ` | group_by取值=${sample}` : '')
                );
            }
            return { snap };
        } catch (err) {
            return { error: err?.message || String(err) };
        } finally {
            e.game = oldGame;
            e.noTips = oldNoTips;
        }
    }

    async run(e) {
        const msg = e.msg || '';
        const game = pickGame(msg);
        const meta = GAMES[game];
        const mInfo = parseMonth(msg);
        const isCount = /统计/.test(msg);
        // 必须在 MysInfo.init 之前设好 e.game：
        // getUid 里是 `const game = e?.game || (e?.isSr ? "sr" : "gs")`，
        // 之前这里没设，init 拿到的 e.game 是空的 → 一律回落到 "gs"，
        // 于是原石/星琼/菲林三个指令都在用**原神 UID** 去查另外两个游戏。
        // fetch() 内部虽然也会设 e.game，但那时候 init 早就跑完了。
        const oldGame = e.game;
        e.game = game;
        let auth;
        try {
            auth = await MysInfo.init(e, 'ledger');
        } finally {
            e.game = oldGame;
        }
        if (!auth?.uid || !auth?.ckInfo?.ck) {
            return e.reply('未检测到米游社 Cookie，请先发送 #扫码登录 完成绑定。', true, { recallMsg: 60 });
        }
        const { snap, error } = await this.fetch(e, game, mInfo);
        if (error) return e.reply(error, true, { recallMsg: 60 });
        // 接口没回合法 YYYYMM 时用「请求的月份」兜底，否则存盘的键不完整，
        // 统计页的月份标签会渲染成空的「月」
        if (!/^\d{6}$/.test(String(snap.ym || ''))) snap.ym = mInfo.ym;

        // 账本接口不返回头像（实测：原神只有 nickname、绝区零有 role_info、
        // 星铁两个都没有），统一走 index 接口补昵称头像 ——
        // 和崩三水晶统计同一套逻辑，见 system/roleProfile.js。
        // uid 必须用当前游戏自己的那个（e.game 已在 init 时按游戏设过）。
        if (!snap.nickname || !snap.avatar) {
            const profile = await getRoleProfile(e, snap.uid || auth.uid, game);
            if (profile.nickname) snap.nickname = profile.nickname;
            if (profile.avatar) snap.avatar = profile.avatar;
            if (profile.serverName) snap.serverName = profile.serverName;
        }

        // 无论月报还是统计都先把当月存进去，保证统计里始终包含最新月份
        const qq = String(e.user_id || e.user?.qq || '');
        saveSnapshot(qq, game, snap);

        return isCount
            ? this.renderCount(e, game, meta, qq, auth)
            : this.renderMonth(e, game, meta, snap, mInfo, qq, auth);
    }

    async renderMonth(e, game, meta, snap, mInfo, qq, auth) {
        const ym = snap.ym || mInfo.ym;
        const label = ym ? `${Number(ym.slice(0, 4))}年${Number(ym.slice(4))}月` : '本月';
        const rows = snap.list.map((i, idx) => ({ ...i, color: PIE_COLORS[idx % PIE_COLORS.length] }));
        const base = rows.reduce((s, i) => s + i.num, 0);
        const cards = [
            { title: `本月${meta.unit}`, num: snap.monthTotal.toLocaleString('en-US'), accent: meta.accent },
            { title: '上月结余', num: snap.lastMonth.toLocaleString('en-US'), accent: '#8a94a6' },
            { title: `今日${meta.unit}`, num: snap.today.toLocaleString('en-US'), accent: '#5fb08a' },
        ];
        if (game === 'zzz') {
            cards.push({ title: '加密母带', num: Number(snap.extra || 0).toLocaleString('en-US'), accent: '#a06fc0' });
            cards.push({ title: '邦布券', num: Number(snap.boopons || 0).toLocaleString('en-US'), accent: '#d98a5b' });
        } else {
            cards.push({ title: `今日${meta.extraName}`, num: Number(snap.extra || 0).toLocaleString('en-US'), accent: '#a06fc0' });
            cards.push({ title: '本月抽卡', num: `${snap.gacha} 抽`, accent: '#d98a5b' });
        }
        const data = {
            game,
            gameName: meta.name,
            title: meta.title,
            unit: meta.unit,
            accent: meta.accent,
            label,
            ym,
            uid: snap.uid || String(auth?.uid || ''),
            nickname: snap.nickname || '',
            avatarUrl: snap.avatar || '',
            cards,
            rows,
            base: base.toLocaleString('en-US'),
            dateStr: moment().format('YYYY-MM-DD'),
        };
        const img = await render('currency_ledger/ledger', data, { e, pct: 1.5 });
        return e.reply(img);
    }

    async renderCount(e, game, meta, qq, auth) {
        const all = readAll(game, qq);
        const months = Object.keys(all).sort();
        if (!months.length) {
            return e.reply(`还没有${meta.name}的历史记录，先发一次「#${meta.alias}」建立数据。`, true, { recallMsg: 60 });
        }
        const items = months.map(ym => ({
            month: `${Number(ym.slice(4))}月`,
            year: ym.slice(0, 4),
            value: Number(all[ym]?.monthTotal || 0),
        }));
        const total = items.reduce((s, i) => s + i.value, 0);
        const best = items.reduce((a, b) => (b.value > (a?.value ?? -1) ? b : a), null);
        const rows = buildSource(months.map(ym => all[ym]));
        const first = months[0];
        const last = months[months.length - 1];
        // 头像/昵称从最近一次抓到的快照里取（快照在每次查询时都会覆盖保存）
        const latest = all[last] || {};
        // 右上角装饰图 = 当前卡池那张图的 markIcon（同一个函数，保证两边一致）
        const cornerSplash = poolCornerIcon(e, game);
        const sourceTotal = rows.reduce((s, r) => s + r.num, 0);
        const data = {
            game,
            gameName: meta.name,
            gameSub: meta.sub || '',
            title: `${meta.name} · ${meta.unit}统计`,
            unit: meta.unit,
            accent: meta.accent,
            uid: String(auth?.uid || latest.uid || ''),
            // 服务器名走统一函数（roleProfile.serverName），
            // 和头像同一处，不再各写一份映射表
            serverName: latest.serverName || toServerName(mhy.getServer(String(auth?.uid || latest.uid || ''), game)),
            nickname: latest.nickname || '',
            avatarUrl: latest.avatar || '',
            cornerSplash,
            total: total.toLocaleString('en-US'),
            sourceTotal: sourceTotal.toLocaleString('en-US'),
            monthCount: months.length,
            rangeText: `${Number(first.slice(0, 4))}年${Number(first.slice(4))}月 ~ ${Number(last.slice(0, 4))}月`,
            bestMonth: best ? best.month : '',
            bestValue: best ? best.value.toLocaleString('en-US') : '',
            itemsB64: toB64(items),
            sourceB64: toB64(rows),
            dateStr: moment().format('YYYY-MM-DD'),
        };
        const img = await render('currency_ledger/count', data, { e, pct: 1.5 });
        return e.reply(img);
    }
}
