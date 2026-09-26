import fetch from 'node-fetch';
import fs from 'fs';

import {
    sleep,
    api,
    mhy,
    render,
    yaml,
    config
} from '#xhh';
import NoteUser from '../../genshin/model/mys/NoteUser.js';
import { manualGeetest } from './manual_geetest.js';


function cookiePart(ck = '', key) {
    const m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
    return m ? m[1] : '';
}

function parseCookie(ck = '') {
    const map = {};
    String(ck).split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx <= 0) return;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (k) map[k] = v;
    });
    return map;
}

function buildCookie(map = {}) {
    return Object.keys(map)
        .filter(k => map[k] !== undefined && map[k] !== null && map[k] !== '')
        .map(k => `${k}=${map[k]}`)
        .join(';') + ';';
}

function getStokenEntry(qq, uid) {
    const path = `./plugins/xhh/data/Stoken/${qq}.yaml`;
    if (!fs.existsSync(path)) return null;
    try {
        return (yaml.get(path) || {})[uid] || null;
    } catch (_) {
        return null;
    }
}

function getStokenData(qq) {
    const path = `./plugins/xhh/data/Stoken/${qq}.yaml`;
    if (!fs.existsSync(path)) return {};
    try {
        return yaml.get(path) || {};
    } catch (_) {
        return {};
    }
}

function isBh3Region(region = '') {
    return ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'].includes(String(region || ''));
}

async function hasXhhBh3Stoken(qq) {
    const data = getStokenData(qq);
    return Object.values(data).some(entry => entry?.stuid && entry?.stoken && isBh3Region(entry?.region));
}

async function getBh3SignTargets(e, allAccounts = false) {
    const qq = e.user_id;
    const data = getStokenData(qq);
    const selectedUid = await redis.get(`xhh:bh3_uid:${qq}`);
    const selectedRegion = selectedUid ? await redis.get(`xhh:bh3_region:${qq}`) : null;
    const targets = [];
    const add = async (uid, entry = {}) => {
        if (!uid || !entry?.stuid || !entry?.stoken) return;
        if (!isBh3Region(entry.region || selectedRegion)) return;
        if (targets.some(v => String(v.uid) === String(uid))) return;
        const rawCk = entry.ck_stoken || `stuid=${entry.stuid};stoken=${entry.stoken};${entry.mid ? `mid=${entry.mid};` : ''}`;
        const ck = await ensureCookieToken(e, rawCk, entry);
        targets.push({ uid: String(uid), ck, server: entry.region || selectedRegion || 'android01' });
    };

    if (selectedUid && data[selectedUid]) await add(selectedUid, data[selectedUid]);
    if (allAccounts) {
        for (const [uid, entry] of Object.entries(data)) await add(uid, entry);
    } else if (!targets.length) {
        const first = Object.entries(data).find(([, entry]) => entry?.stuid && entry?.stoken);
        if (first) await add(first[0], first[1]);
    }
    return targets;
}

async function ensureCookieToken(e, ck, entry = null) {
    if (!ck || /(?:^|;\s*)cookie_token=/.test(ck)) return ck;
    const map = parseCookie(ck);
    const stuid = entry?.stuid || map.stuid || map.ltuid || map.account_id;
    const stoken = entry?.stoken || map.stoken;
    if (!stuid || !stoken) return ck;
    // 每个请求独立超时：之前两个接口共用一个 10s 计时器，第一个慢一点第二个就会被 abort
    const requestJson = async url => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            return await fetch(url, { method: 'GET', headers: mhy.getHeaders(e, ck), signal: controller.signal }).then(r => r.json());
        } finally {
            clearTimeout(timer);
        }
    };
    try {
        const cookieRes = await requestJson(`https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`);
        const cookieToken = cookieRes?.data?.cookie_token;
        // bbs-api 社区签到同时认 stoken 和 cookie_token：缺 stoken → 1034 无验证参数，缺 cookie_token → -100
        if (cookieToken) {
            let ltoken = entry?.ltoken || map.ltoken;
            if (!ltoken) {
                const ltokenRes = await requestJson('https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken');
                ltoken = ltokenRes?.data?.ltoken || '';
            }
            if (config().debug) logger.mark(`[xhh][sign] ensureCookieToken retcode=${cookieRes?.retcode} cookieToken=${!!cookieToken} ltoken=${!!ltoken}`);
            map.stuid = stuid;
            map.stoken = stoken;
            map.cookie_token = cookieToken;
            map.account_id = map.account_id || stuid;
            if (entry?.mid) map.mid = entry.mid;
            if (ltoken) {
                map.ltoken = ltoken;
                map.ltuid = stuid;
            }
            return buildCookie(map);
        }
        if (config().debug) logger.mark(`[xhh][sign] ensureCookieToken 失败 retcode=${cookieRes?.retcode} msg=${cookieRes?.message}`);
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] refresh cookie_token failed: ${err.message}`);
    }
    return ck;
}

async function getSignCookieAndServer(e, game, uid, ck) {
    let server;
    if (game === 'bh3') {
        const entry = getStokenEntry(e.user_id, uid);
        if (entry) {
            server = entry.region;
            ck = entry.ck_stoken || ck;
        }
        ck = await ensureCookieToken(e, ck, entry);
    }
    return { ck, server };
}

function getMysSignTargets(e, game, allAccounts = false) {
    if (!allAccounts) {
        const mys = e.user.getMysUser(game);
        if (!mys) return [];
        const ck = mys.ck;
        const uids = Array.isArray(mys.uids?.[game]) ? mys.uids[game] : [];
        return uids.map(uid => ({ uid, ck, server: null }));
    }

    const targets = [];
    const seen = new Set();
    for (const mys of Object.values(e.user.mysUsers || {})) {
        if (!mys?.ck) continue;
        const uids = Array.isArray(mys.uids?.[game]) ? mys.uids[game] : [];
        for (const uid of uids) {
            const key = `${mys.ltuid}:${uid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({ uid, ck: mys.ck, server: null });
        }
    }
    return targets;
}

async function MysSign(e, games, allAccounts = false) {
    const hasBh3Xhh = games.includes('bh3') && await hasXhhBh3Stoken(e.user_id);
    if (
        !e.user.getMysUser() &&
        !e.user.getMysUser('sr') &&
        !e.user.getMysUser('zzz') &&
        !e.user.getMysUser('bh3') &&
        !hasBh3Xhh
    )
        return e.reply('未绑定米游社ck,请发送[扫码绑定]', true);
    let msgs = [];
    let bj = 1;
    for (let game of games) {
        const game_name = game == 'gs' ? '原神' : game == 'sr' ? '星铁' : game == 'zzz' ? '绝区零' : '崩坏3';
        let targets = [];
        if (game === 'bh3') {
            targets = await getBh3SignTargets(e, allAccounts);
        }
        if (!targets.length) {
            targets = getMysSignTargets(e, game, allAccounts);
        }
        if (!targets.length) continue;
            for (let i = 0; i < targets.length; i++) {
                const { uid, ck, server } = targets[i];
                if (i > 0) await sleep(1000);
                const signOpt = game === 'bh3' && server ? { ck, server } : await getSignCookieAndServer(e, game, uid, ck);
                let headers = mhy.getHeaders(e, signOpt.ck);
                const Ds = mhy.getDsSign();
                headers.DS = Ds;
                headers.Origin = 'https://act.mihoyo.com';
                headers.Referer = 'https://act.mihoyo.com';
                //必加参数
                if (game === 'gs') headers['x-rpc-signgame'] = 'hk4e';
                else if (game === 'sr') headers['x-rpc-signgame'] = 'hkrpg';
                else if (game === 'zzz') headers['x-rpc-signgame'] = 'zzz';
                else delete headers['x-rpc-signgame'];
                let data = {
                    game,
                    uid,
                    headers,
                    server: signOpt.server,
                    type: 'sign_info',
                };
            let res = await api(e, data);
            /**
             * 报错
             */
            if (typeof res == 'string') {
                msgs.push({
                    game: game_name,
                    uid: uid,
                    tip: res,
                });
                logger.mark(`[${game_name}签到失败]QQ: ${e.user_id},UID: ${uid}`);
            } else if (res.retcode == 0 && res.data) {
                /**
                 * 查询签到状态成功
                 */
                //已经签到
                const day = res.data.total_sign_day;
                const rew = await reward(e, data);
                if (res.data.is_sign == true) {
                    const award = rew[day - 1] || {};
                    msgs.push({
                        game: game_name,
                        uid: uid,
                        icon: award.icon,
                        tip: '今日已签',
                        day: day,
                        cnt: award.cnt || '',
                    });
                    if (bj) {
                        add(e);
                        bj = 0;
                    }
                } else {
                    //未签到,开始签到
                    logger.mark(`[${game_name}签到]QQ: ${e.user_id},UID: ${uid}`);
                    data.type = 'sign';
                    data.manual_captcha = true;
                    let sign_res = await api(e, data);
                    if ([1034, 10035].includes(Number(sign_res?.retcode)) && sign_res?.data?.gt) {
                        const validate = await manualGeetest(e, { ...sign_res.data, uid }, `${game_name} UID:${uid} 签到`);
                        if (validate?.validate) {
                            const retryHeaders = {
                                ...headers,
                                'x-rpc-challenge': validate.challenge,
                                'x-rpc-validate': validate.validate,
                                'x-rpc-seccode': validate.seccode || `${validate.validate}|jordan`,
                            };
                            sign_res = await api(e, { ...data, headers: retryHeaders, manual_captcha: false });
                        }
                    }
                    //签到成功
                    if (sign_res.retcode == 0) {
                        const award = rew[day] || {};
                        msgs.push({
                            game: game_name,
                            uid: uid,
                            icon: award.icon,
                            tip: '签到成功',
                            day: day + 1,
                            cnt: award.cnt || '',
                        });
                        if (bj) {
                            add(e);
                            bj = 0;
                        }
                    }
                    //签到失败
                    else if (typeof sign_res == 'string') {
                        msgs.push({
                            game: game_name,
                            uid: uid,
                            tip: sign_res,
                        });
                    } else if ([1034, 10035].includes(Number(sign_res?.retcode))) {
                        msgs.push({
                            game: game_name,
                            uid: uid,
                            tip: '签到遇到验证码，手动验证未完成或验证失败',
                        });
                    } else if (sign_res?.message) {
                        msgs.push({
                            game: game_name,
                            uid: uid,
                            tip: sign_res.message,
                        });
                    }
                }
            }
        }
    }
    const data_ = {
        // 模板统一用 title 显示首行（游戏签到是「原神uid：123456789」）
        msgs: msgs.map(m => ({ title: `${m.game}uid：${m.uid}`, ...m })),
        qq: e.user_id,
        name: e.sender.card || e.sender.nickname,
    };
    //渲染
    return render('sign/sign', data_, {
        e,
        ret: true,
    });
}

function add(e) {
    const path = './plugins/xhh/config/sign.yaml';
    const data = yaml.get(path);
    if (!data.zd_sign || !e.isGroup) return;
    if (!isAllowSignGroup(data.sign_group, e.group_id)) return;
    if (!data.sign) {
        data.sign = {};
    } else {
        const arrays = Object.values(data.sign);
        const allNumbers = arrays.flat();
        if (allNumbers.includes(e.user_id)) return;
    }
    let qqs = data.sign[e.group_id] || []
    if (qqs.includes(e.user_id)) return;
    qqs.push(e.user_id);
    data.sign[e.group_id] = qqs;
    return yaml.set(path, 'sign', data.sign);
}

function isAllowSignGroup(signGroup, group) {
    if (!Array.isArray(signGroup) || signGroup.length === 0) return true;
    const gid = String(group);
    return signGroup.map(v => String(v)).includes(gid);
}


/* ============================================================
 * 米游社社区签到
 * 全部 bbs 请求统一交给 https://mhy.989894366.xyz/mihoyo_api/get 代发：
 * 签名、设备指纹、风控都由代理服务端处理，本地只拼请求、读结果、兜超时。
 * ============================================================ */
const MHY_PROXY_URL = 'https://mhy.989894366.xyz/mihoyo_api/get';
const BBS_API_HOST = 'https://bbs-api.miyoushe.com';
const BBS_SIGN_PATH = '/apihub/app/api/signIn';
// 代理是第三方服务，必须有超时兜底，否则指令会一直挂着不回复
const PROXY_TIMEOUT = 20000;
// 每日任务取帖用的板块：一个区够用，不必每个板块都刷一遍请求
const TASK_FORUM_ID = '26';
const NEED_READ = 5;
const NEED_VOTE = 5;

const BBS_FORUMS = [
    { name: '崩坏3', signId: '1', forumId: '1' },
    { name: '原神', signId: '2', forumId: '26' },
    { name: '崩坏2', signId: '3', forumId: '30' },
    { name: '未定事件簿', signId: '4', forumId: '37' },
    { name: '大别野', signId: '5', forumId: '34' },
    { name: '崩坏星穹铁道', signId: '6', forumId: '52' },
    { name: '绝区零', signId: '8', forumId: '57' },
];

const BBS_PROXY_GAME = {
    '2': 'hk4e',
    '6': 'hkrpg',
    '8': 'nap',
};

/** 请求间随机停顿：限速 + 降风控 */
function jitter(min = 600, max = 1200) {
    return sleep(min + Math.floor(Math.random() * (max - min)));
}

function bbsProxyToken() {
    return String((config() || {}).Verification_API_KEY || '').trim() || 'xhh-free';
}

/** 代理统一回 { retcode, message, data }，米游社真实回包在 data 里 */
function unwrapProxyResult(res) {
    if (!res || typeof res !== 'object') return { retcode: -500, message: '代理无返回' };
    if (Number(res.retcode) === 404 || /token/i.test(String(res.message || ''))) {
        return { retcode: -404, message: '代理token无效' };
    }
    const inner = res.data && typeof res.data === 'object' ? res.data : res;
    if (!inner || typeof inner !== 'object') return { retcode: -500, message: '代理返回异常' };
    return inner;
}

async function proxyRequest(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT);
    try {
        const res = await fetch(MHY_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-mihoyo-api-token': bbsProxyToken(),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        }).then(r => r.json());
        return unwrapProxyResult(res);
    } catch (err) {
        return {
            retcode: -500,
            message: `请求失败:${err?.name === 'AbortError' ? '超时' : err?.message || '未知错误'}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 单个社区接口调用：只传 cookie，其余签名交给代理
 * -500 是我们自己定义的网络/代理层错误，只有它才重试；米游社业务码原样返回由调用方判定
 */
async function bbsApi(account, path, opt = {}) {
    const method = opt.method || (opt.body ? 'POST' : 'GET');
    const payload = {
        url: /^https?:\/\//.test(path) ? path : `${BBS_API_HOST}${path}`,
        headers: { Cookie: account.ck },
        method,
    };
    if (opt.body) payload.body = opt.body;
    if (opt.game) payload.game = opt.game;
    let res = { retcode: -500, message: '未发起请求' };
    for (let i = 0; i < (opt.times || 2); i++) {
        if (i) await jitter(1000, 2000);
        res = await proxyRequest(payload);
        if (Number(res.retcode) !== -500) break;
    }
    if (config().debug) {
        logger.mark(`[xhh][bbs] ${method} ${path} => ${res?.retcode} ${String(res?.message || '').slice(0, 60)}`);
    }
    return res;
}

/** 把米游社回包翻译成给用户看的提示 */
function bbsResultTip(res) {
    const rc = Number(res?.retcode);
    if (rc === 0) return '签到成功';
    if ([-5003, 1008].includes(rc) || /已经|已签到|重复/.test(String(res?.message || ''))) return '今日已签';
    if (rc === -404) return '代理不可用';
    if (rc === -500) return '代理请求失败';
    if ([-100, -101, 10001].includes(rc)) return '登录失效,请重新[扫码绑定]';
    if ([1034, 10035, 10041].includes(rc)) return '遇到验证码';
    if (rc === -10001) return '请求被拒(签名)';
    return String(res?.message || `失败(${res?.retcode ?? '无返回'})`).slice(0, 30);
}

function getBbsAccounts(e) {
    const path = `./plugins/xhh/data/Stoken/${e.user_id}.yaml`;
    const accounts = new Map();
    const collect = data => {
        for (const entry of Object.values(data || {})) {
            if (!entry?.stuid || !entry?.stoken) continue;
            if (accounts.has(String(entry.stuid))) continue;
            accounts.set(String(entry.stuid), {
                stuid: String(entry.stuid),
                stoken: entry.stoken,
                ck: entry.ck_stoken || `stuid=${entry.stuid};stoken=${entry.stoken};${entry.mid ? `mid=${entry.mid};` : ''}`,
            });
        }
    };
    if (fs.existsSync(path)) {
        try { collect(yaml.get(path)); } catch (_) {}
    }
    // 没有扫码记录时退回当前绑定的 ck；社区签到只认 stoken，没 stoken 的直接不算
    if (!accounts.size) {
        const mys = e.user?.getMysUser?.('gs');
        if (mys?.ck && /stoken=/.test(mys.ck)) {
            accounts.set('0', {
                stuid: '',
                stoken: cookiePart(mys.ck, 'stoken'),
                ck: mys.ck,
            });
        }
    }
    return [...accounts.values()];
}

// 当日签到缓存：签过就别再打接口了，重复请求只会被记风控
function bbsCacheKey(e, account) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `xhh:bbs_sign:${day}:${e.user_id}:${account.stuid || '0'}`;
}

async function bbsSignedToday(e, account) {
    try {
        return !!(await redis.get(bbsCacheKey(e, account)));
    } catch (_) {
        return false;
    }
}

async function markBbsSigned(e, account) {
    try {
        await redis.set(bbsCacheKey(e, account), '1', { EX: getSecondsToMidnight() });
    } catch (_) {}
}

/**
 * 单个板块签到
 * ck 里只有 stoken 时社区接口可能判未登录/要验证码，补一次 cookie_token 后重试一轮（每轮只补一次）
 */
async function bbsForumSignIn(e, account, forum, ctx = {}) {
    const body = { gids: Number(forum.signId) };
    const game = BBS_PROXY_GAME[String(forum.signId)];
    let res = await bbsApi(account, BBS_SIGN_PATH, { method: 'POST', body, game });
    const needCookieToken = [-100, -101, 10001, 1034, 10035].includes(Number(res?.retcode));
    if (needCookieToken && !/(?:^|;\s*)cookie_token=/.test(account.ck || '') && !ctx.refreshed) {
        ctx.refreshed = true;
        ctx.account = { ...account, ck: await ensureCookieToken(e, account.ck, account) };
        if (ctx.account.ck !== account.ck) {
            await jitter(800, 1500);
            res = await bbsApi(ctx.account, BBS_SIGN_PATH, { method: 'POST', body, game });
        }
    }
    return res;
}

/** 米游币每日任务：整号只跑一轮浏览/点赞/分享，没必要每个板块重复刷 */
async function bbsDailyTasks(account) {
    const listRes = await bbsApi(account, `/post/api/getForumPostList?forum_id=${TASK_FORUM_ID}&is_good=false&is_hot=false&page_size=20&sort_type=1`);
    const postIds = (listRes?.data?.list || []).map(v => v?.post?.post_id).filter(Boolean);
    if (!postIds.length) return '';
    await jitter();
    let browse = 0, vote = 0, share = 0;
    for (const postId of postIds.slice(0, NEED_READ)) {
        const res = await bbsApi(account, `/post/api/getPostFull?post_id=${postId}`);
        if (Number(res?.retcode) === 0) browse++;
        await jitter(500, 1000);
    }
    for (const postId of postIds.slice(0, NEED_VOTE)) {
        const res = await bbsApi(account, '/apihub/sapi/upvotePost', {
            method: 'POST',
            body: { post_id: String(postId), is_cancel: false },
        });
        if (Number(res?.retcode) === 0) vote++;
        if ([1034, 10035].includes(Number(res?.retcode))) break;
        await jitter(500, 1000);
    }
    const shareRes = await bbsApi(account, `/apihub/api/getShareConf?entity_id=${postIds[0]}&entity_type=1`);
    if (Number(shareRes?.retcode) === 0) share++;
    return `浏览${browse} 点赞${vote} 分享${share}`;
}

/**
 * 单个通行证：先查任务态（米游币已拿满就跳过），再逐板块签到，最后补每日任务
 * rows 用于出图，lines 用于文本兜底
 */
async function bbsSignAccount(e, account, lines) {
    const rows = [];
    const fill = tip => {
        for (const forum of BBS_FORUMS) rows.push({ name: forum.name, tip });
    };
    if (await bbsSignedToday(e, account)) {
        fill('今日已签');
        for (const forum of BBS_FORUMS) lines.push(`${forum.name}：今日已签`);
        return { rows, ok: true };
    }
    let cur = account;
    const stateRes = await bbsApi(cur, '/apihub/sapi/getUserMissionsState');
    const skipDailyTasks = Number(stateRes?.retcode) === 0 && Number(stateRes.data?.can_get_points) === 0;
    if (skipDailyTasks) lines.push('今日米游币已拿满');
    const ctx = {};
    for (const forum of BBS_FORUMS) {
        let res;
        try {
            res = await bbsForumSignIn(e, cur, forum, ctx);
        } catch (err) {
            logger.error(`[xhh][bbs_sign] ${account.stuid || ''} ${forum.name}: ${err.message}`);
            res = { retcode: -500, message: '签到异常' };
        }
        if (ctx.account) cur = ctx.account;
        const tip = bbsResultTip(res);
        rows.push({ name: forum.name, tip });
        lines.push(`${forum.name}：${tip}`);
        // 代理不可用 / ck 失效：剩下的板块结果只会一样，别再打一遍浪费请求
        if (/代理不可用|登录失效/.test(tip)) {
            const rest = BBS_FORUMS.slice(rows.length);
            for (const f of rest) rows.push({ name: f.name, tip });
            break;
        }
        await jitter(800, 1600);
    }
    const ok = rows.length > 0 && rows.every(r => /签到成功|今日已签/.test(r.tip));
    if (ok) {
        try {
            if (!skipDailyTasks) {
                const taskTip = await bbsDailyTasks(cur);
                if (taskTip) lines.push(`每日任务：${taskTip}`);
            }
        } catch (err) {
            logger.error(`[xhh][bbs_task] ${account.stuid || ''}: ${err.message}`);
        }
        await markBbsSigned(e, account);
    }
    return { rows, ok };
}

async function BbsSign(e) {
    const accounts = getBbsAccounts(e);
    if (!accounts.length) {
        return e.reply('未找到米游社SToken(社区签到只认stoken)，请先[小花火扫码登录]绑定', true, { recallMsg: 60 });
    }
    const all = /全部/.test(e.msg || '');
    const lines = [all ? '米游社社区全部签到' : '米游社社区签到'];
    const msgs = [];
    for (const account of accounts) {
        const label = account.stuid || '当前绑定';
        lines.push(`\n通行证 ${label}`);
        try {
            const { rows } = await bbsSignAccount(e, account, lines);
            msgs.push(bbsCardItem(account, rows));
        } catch (err) {
            logger.error(`[xhh][bbs_sign] ${label}: ${err.message}`);
            lines.push(`签到异常：${err.message}`);
            msgs.push({ title: `通行证 ${label}`, tip: '签到异常' });
        }
        await jitter(1000, 2000);
    }
    return replyBbsResultImage(e, msgs, lines);
}

async function bbsSignForUser(qq) {
    const e = {
        user_id: String(qq),
        msg: '社区签到',
        isGroup: false,
        sender: { nickname: String(qq) },
        reply: async () => false,
    };
    const accounts = getBbsAccounts(e);
    const lines = [`QQ ${qq}`];
    const msgs = [];
    if (!accounts.length) {
        lines.push('未找到米游社SToken');
        return { msgs, lines };
    }
    for (const account of accounts) {
        const label = account.stuid || '当前绑定';
        lines.push(`\n通行证 ${label}`);
        try {
            const { rows } = await bbsSignAccount(e, account, lines);
            msgs.push(bbsCardItem(account, rows));
        } catch (err) {
            logger.error(`[xhh][bbs_auto] ${qq} ${label}: ${err.message}`);
            lines.push(`签到异常：${err.message}`);
            msgs.push({ title: `通行证 ${label}`, tip: '签到异常' });
        }
        await jitter(1000, 2000);
    }
    return { msgs, lines };
}

async function BbsAutoSign(qqs = []) {
    const users = [...new Set((qqs || []).map(v => String(v).trim()).filter(Boolean))];
    const allLines = ['米游社社区自动签到'];
    const allMsgs = [];
    for (const qq of users) {
        const result = await bbsSignForUser(qq);
        allLines.push(...result.lines);
        allMsgs.push(...result.msgs.map(m => ({ ...m, title: `QQ ${qq} · ${m.title}` })));
        await jitter(1500, 3000);
    }
    return { msgs: allMsgs, lines: allLines };
}

async function sendBbsAutoResult(group, result) {
    const text = (result?.lines || []).join('\n') || '米游社社区自动签到完成';
    return Bot.pickGroup(Number(group)).sendMsg(text);
}

// 结果汇总：全失败时给出可操作的排查提示，不再 60s 就把消息撤掉
function bbsResultTips(lines) {
    const body = lines.slice(1);
    const tips = [];
    if (body.some(l => /遇到验证码/.test(l))) {
        tips.push('提示：代理代发也没绕开米游社验证码，换个 Verification_API_KEY 或晚点再试');
    }
    if (body.some(l => /登录失效/.test(l))) {
        tips.push('提示：ck 已失效，重新[扫码绑定]后再试');
    }
    if (body.some(l => /代理不可用|代理token/.test(l))) {
        tips.push('提示：代理未授权或不可用，检查 Verification_API_KEY 是否正确');
    }
    if (body.some(l => /代理请求失败|超时/.test(l))) {
        tips.push('提示：代理访问失败(网络或限流)，稍后重试');
    }
    if (body.some(l => /请求被拒/.test(l))) {
        tips.push('提示：请求被米游社拒绝(签名/版本)，稍后再试或反馈开发者');
    }
    return tips;
}

function replyBbsResult(e, lines) {
    const ok = lines.slice(1).some(l => /签到成功|今日已签/.test(l));
    if (!ok) lines = lines.concat(bbsResultTips(lines));
    return e.reply(lines.join('\n'), false, ok ? {} : { recallMsg: 300 });
}

// 一个通行证出一张卡：正常时只写「今日已签 / 签到成功」，有异常才点名是哪个版块
function bbsCardItem(account, rows) {
    const stuid = account.stuid || '当前绑定';
    const failed = rows.filter(r => !/签到成功|今日已签/.test(r.tip));
    let tip;
    if (!failed.length) {
        tip = rows.every(r => /今日已签/.test(r.tip)) ? '今日已签' : '签到成功';
    } else {
        const okCount = rows.length - failed.length;
        tip = `${okCount}/${rows.length} 完成 · ${failed.map(r => `${r.name}${r.tip}`).join(' ')}`;
    }
    return {
        title: `通行证 ${stuid}`,
        tip,
    };
}

// 结果出图；渲染失败回退文本，保证不影响签到本身
async function replyBbsResultImage(e, msgs, lines) {
    const ok = msgs.some(m => /签到成功|今日已签/.test(m.tip));
    try {
        // ret:true 时图片由 runtime 直接发出（与 wiki/签到等其它功能一致），
        // 返回值只是「发送结果」而不是图片内容——不要再 e.reply 一次，否则会多发一条客户端看不懂的消息
        const sent = await render('sign/sign', {
            msgs,
            qq: e.user_id,
            name: e.sender?.card || e.sender?.nickname || String(e.user_id),
            // 与游戏签到共用 sign/sign.html，这里单独给个 saveId，免得命中它的渲染缓存
            saveId: 'bbs_sign',
        }, { e, ret: true });
        if (config().debug) logger.mark(`[xhh][bbs] 出图发送结果: ${JSON.stringify(sent ?? null).slice(0, 120)}`);
        // render 只在截图/渲染失败时给 false，否则已经发出去了
        if (sent !== false) {
            if (!ok) {
                const tips = bbsResultTips(lines);
                if (tips.length) await e.reply(tips.join('\n'), false, { recallMsg: 300 });
            }
            return true;
        }
    } catch (err) {
        logger.error(`[xhh][bbs_sign] 结果渲染失败，回退文本: ${err.message}`);
    }
    return replyBbsResult(e, lines);
}

async function reward(e, data) {
    let rew = await redis.get(`xhh:sign:${data.game}`);
    if (rew) return JSON.parse(rew);
    data.type = 'sign_home';
    const res = await api(e, data);
    if (!Array.isArray(res?.data?.awards)) return [];
    const time = getSecondsToMidnight();
    await redis.set(`xhh:sign:${data.game}`, JSON.stringify(res.data.awards), {
        EX: time,
    });
    return res.data.awards;
}

//获取到次日0点的时间（秒）
function getSecondsToMidnight() {
    // 获取当前时间
    const now = new Date();

    // 创建次日0点时间对象
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);

    // 计算时间差并转换为秒（取整）
    return Math.floor((midnight - now) / 1000);
}

async function zd_MysSign(qqs) {
    let num = 0,
        z_num = 0,
        cg_qqs = [],
        sbai_qqs = [];
    const games = ['gs', 'sr', 'zzz', 'bh3'];
    for (let qq of qqs) {
        let e = {};
        e.user_id = qq;
        // e.reply = (msg) => { }
        for (let game of games) {
            let user = (await NoteUser.create(qq)).getMysUser(game); //只要当前xx游戏绑定ck的账号信息（原神可能有多个，如渠道服）
            if (!user) continue;
            const ck = user.ck;
            // 部分用户只绑定了 CK，但没有该游戏的 UID；
            // 直接读取 uids[game].length 会导致自动签到任务整体中断。
            const uids = Array.isArray(user.uids?.[game]) ? user.uids[game] : [];
            for (let i = 0; i < uids.length; i++) {
                z_num++;
                const uid = uids[i];
                if (i > 0) await sleep(1000);
                const signOpt = await getSignCookieAndServer(e, game, uid, ck);
                let headers = mhy.getHeaders(e, signOpt.ck);
                const Ds = mhy.getDsSign();
                headers.DS = Ds;
                headers.Origin = 'https://act.mihoyo.com';
                headers.Referer = 'https://act.mihoyo.com';
                //必加参数
                if (game === 'gs') headers['x-rpc-signgame'] = 'hk4e';
                else if (game === 'sr') headers['x-rpc-signgame'] = 'hkrpg';
                else if (game === 'zzz') headers['x-rpc-signgame'] = 'zzz';
                else delete headers['x-rpc-signgame'];
                let data = {
                    game,
                    uid,
                    headers,
                    server: signOpt.server,
                    type: 'sign_info',
                };
                let res = await api(e, data);
                /**
                 * 报错
                 */
                if (typeof res == 'string') {
                    if (!sbai_qqs.includes(qq)) {
                        if (cg_qqs.includes(qq)) {
                            const index = cg_qqs.indexOf(qq);
                            cg_qqs.splice(index, 1);
                        }
                        sbai_qqs.push(qq);
                    }
                    continue;
                } else if (res.retcode == 0 && res.data) {
                    /**
                     * 查询签到状态成功
                     */
                    //已经签到
                    if (res.data.is_sign == true) {
                        if (!cg_qqs.includes(qq)) {
                            cg_qqs.push(qq);
                        }
                        num++;
                        continue;
                    } else {
                        //未签到,开始签到
                        data.type = 'sign';
                        const sign_res = await api(e, data);
                        //签到成功
                        if (sign_res.retcode == 0) {
                            if (!cg_qqs.includes(qq)) {
                                cg_qqs.push(qq);
                            }
                            num++;
                            continue;
                        }
                        //签到失败
                        else if (typeof sign_res == 'string') {
                            if (!sbai_qqs.includes(qq)) {
                                if (cg_qqs.includes(qq)) {
                                    const index = cg_qqs.indexOf(qq);
                                    cg_qqs.splice(index, 1);
                                }
                                sbai_qqs.push(qq);
                            }
                            continue;
                        }
                    }
                }
                await sleep(500);
            }
            await sleep(500);
        }
        await sleep(500);
    }

    return {
        num,
        z_num,
        cg_qqs,
        sbai_qqs,
    };
}

export {
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
};
