import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'node:crypto';

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

// 按账户派生稳定 device_id：过码清的是「设备」风险分，重签必须用同一 device_id 才放行
function stableDeviceId(seed) {
    // x-rpc-device_id 应保持完整 UUID 形态。之前截成 16 位短串，
    // 社区 signIn 会把它判成异常设备，表现为所有版块统一返回 1034。
    const hex = crypto.createHash('md5').update(String(seed)).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

async function getBh3SignTargets(e) {
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
    for (const [uid, entry] of Object.entries(data)) await add(uid, entry);
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

async function MysSign(e, games) {
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
            targets = await getBh3SignTargets(e);
        }
        if (!targets.length) {
            const mys = e.user.getMysUser(game);
            if (!mys) continue;
            const ck = mys.ck;
            const uids = Array.isArray(mys.uids?.[game]) ? mys.uids[game] : [];
            targets = uids.map(uid => ({ uid, ck, server: null }));
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


// bbs-api 的盐与 app_version 必须成套（实测：2.70.1 + 老盐已被服务端拒，GET 回 -100、POST 回 -10001）
// 参考 cchanlan/xhh-TL (MIT) utils/bbsCoinClient.js，其盐表取自 gsuid_core 的 _S['2.102.1']
const BBS_APP_VERSION = '2.102.1';
// GET 类 DS 盐（2.102.1 的 K2）
const BBS_SALT_K2 = 'lX8m5VO5at5JG7hR8hzqFwzyL5aB1tYo';
// POST 类 DS2 盐（gsuid 表的 salt_id 22）
const BBS_SALT_X6 = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v';
// 过码接口仍是老版本形态（4x 盐 + 2.40.1）
const GT_APP_VERSION = '2.40.1';
const BBS_DEFAULT_FP = '38d7ee834d1e9';
// 撞码 → 过码成功后的重签梯度（毫秒）：过码完立刻重打仍是 1034，要等米游社放行
const CAPTCHA_RETRY_GAPS = [0, 5000, 12000];
// 每日任务需求数（按官方上限收敛，不做无谓请求）
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

function getBbsAccounts(e) {
    const path = `./plugins/xhh/data/Stoken/${e.user_id}.yaml`;
    const path2 = `./plugins/xiaoyao-cvs-plugin/data/yaml/${e.user_id}.yaml`;
    const accounts = new Map();
    const collect = data => {
        for (const entry of Object.values(data || {})) {
            if (!entry?.stuid || !entry?.stoken) continue;
            if (accounts.has(String(entry.stuid))) continue;
            const ck = entry.ck_stoken || `stuid=${entry.stuid};stoken=${entry.stoken};${entry.mid ? `mid=${entry.mid};` : ''}`;
            // 全程固定 device_id：设备指纹一变，米游社立刻判风险设备 → 1034
            accounts.set(String(entry.stuid), {
                stuid: String(entry.stuid),
                ck,
                stoken: entry.stoken,
                ltoken: entry.ltoken,
                mid: entry.mid,
                device_id: stableDeviceId(entry.stuid),
            });
        }
    };
    if (fs.existsSync(path)) {
        try { collect(yaml.get(path)); } catch (_) {}
    }
    // 兼容逍遥插件的 stoken 文件：没有 xhh 扫码记录时社区签到也能用
    if (!accounts.size && fs.existsSync(path2)) {
        try {
            const data = yaml.get(path2) || {};
            collect(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { ...v, stuid: v?.stuid || k }])));
        } catch (_) {}
    }
    return [...accounts.values()];
}

function bbsBaseHeaders(e, ck, body = '', useBodyDs = false) {
    const headers = mhy.getHeaders(e, ck);
    headers.Cookie = ck;
    headers.DS = useBodyDs ? mhy.getDs2('', body, BBS_SALT_X6) : mhy.getDs(BBS_SALT_K2);
    headers['x-rpc-app_version'] = BBS_APP_VERSION;
    headers['x-rpc-client_type'] = '2';
    headers['x-rpc-device_model'] = 'Mi 10';
    headers['x-rpc-device_name'] = 'Xiaomi Mi 10';
    headers['x-rpc-channel'] = 'miyousheluodi';
    headers['x-rpc-sys_version'] = '12';
    headers['x-rpc-csm_source'] = 'myself';
    headers['x-rpc-device_id'] = mhy.getDeviceGuid().replace(/-/g, '').toUpperCase();
    // 没绑定设备时用官方客户端同款兜底指纹，别用随机串（随机 fp 反而像脚本）
    if (!headers['x-rpc-device_fp'] || headers['x-rpc-device_fp'] === '38d7f0aac0ab7') {
        headers['x-rpc-device_fp'] = BBS_DEFAULT_FP;
    }
    headers.Referer = 'https://app.mihoyo.com';
    headers['User-Agent'] = `Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/${BBS_APP_VERSION}`;
    delete headers.Origin;
    delete headers['X-Requested-With'];
    delete headers['x-rpc-verify_key'];
    delete headers['x-rpc-app_id'];
    if (useBodyDs) headers['Content-Type'] = 'application/json;charset=UTF-8';
    else delete headers['Content-Type'];
    return headers;
}

/** 撞风控（1034 同族）；注意 -5003 是「今日已签过」，不是验证码 */
function isBbsCaptcha(res) {
    const rc = Number(res?.retcode);
    // 5003 是重复签到/今日已签，不是验证码；纳入验证码会触发无意义的代理和过码请求。
    return !!(res?.data?.challenge || res?.data?.gt || [1034, 10035, 10041].includes(rc));
}

/** 凭证失效。-10001 不在内：那是签名被拒，换凭证没用 */
function isBbsExpired(res) {
    return [-100, -101, 10001].includes(Number(res?.retcode));
}

function isBbsBadSign(res) {
    return Number(res?.retcode) === -10001;
}

/** 请求间随机停顿，降低风控 */
function jitter(min = 500, max = 1200) {
    return sleep(min + Math.floor(Math.random() * (max - min)));
}

/** 查米游币任务态：can_get_points 为 0 说明今天已拿满，不必再发一堆请求 */
async function bbsMissions(e, account) {
    const res = await bbsJson(e, account, 'https://bbs-api.miyoushe.com/apihub/sapi/getUserMissionsState');
    if (!res?.data) return null;
    return {
        total: Number(res.data.total_points) || 0,
        canGet: Number(res.data.can_get_points) || 0,
        res,
    };
}

async function bbsJson(e, account, url, body = null, useBodyDs = false, extraHeaders = {}) {
    const bodyText = body ? JSON.stringify(body) : '';
    const headers = bbsBaseHeaders(e, account.ck, bodyText, useBodyDs);
    if (account?.device_id) headers['x-rpc-device_id'] = account.device_id;
    Object.assign(headers, extraHeaders);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers,
            body: body ? bodyText : undefined,
            signal: controller.signal,
        });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            logger.error(`[xhh][bbs] 返回非JSON: ${text.slice(0, 200)}`);
            return { retcode: -500, message: '接口返回异常(非JSON)' };
        }
    } catch (err) {
        logger.error(`[xhh][bbs] 请求失败: ${err.message}`);
        return { retcode: -500, message: '请求失败: ' + (err.name === 'AbortError' ? '超时' : err.message) };
    } finally {
        clearTimeout(timer);
    }
}

async function geetestPass(gt, challenge) {
    const urls = [
        `https://challenge.minigg.cn/geetest?token=&gt=${encodeURIComponent(gt)}&challenge=${encodeURIComponent(challenge)}`,
        `https://api.114514616.xyz/validate/get?token=&gt=${encodeURIComponent(gt)}&challenge=${encodeURIComponent(challenge)}`,
    ];
    for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(url, { signal: controller.signal }).then(r => r.text());
            const v = (res || '').trim();
            if (config().debug) logger.mark(`[xhh][bbs_sign] 极验代理(${url.split('/')[2]})返回: ${v.slice(0, 60)}`);
            if (v && !/^[<{]/.test(v)) return v;
        } catch (err) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 极验代理(${url.split('/')[2]})失败: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
    return '';
}

// 验证码代理重放：把签到请求交给服务端代发，绕开本机 IP 风控
async function bbsProxySign(e, account, url, body) {
    const token = config().Verification_API_KEY || 'xhh-free';
    const bodyText = JSON.stringify(body || {});
    const headers = bbsBaseHeaders(e, account.ck, bodyText, true);
    if (account?.device_id) headers['x-rpc-device_id'] = account.device_id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch('https://mhy.989894366.xyz/mihoyo_api/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-mihoyo-api-token': token },
            body: JSON.stringify({ url, headers, body: JSON.parse(bodyText), method: 'POST' }),
            signal: controller.signal,
        }).then(r => r.json());
        if (Number(res?.retcode) === 404 || /token is not found/i.test(String(res?.message || ''))) {
            logger.warn(`[xhh][bbs_sign] 代理 token 不可用，跳过代理重放`);
            return null;
        }
        const data = res?.data && typeof res.data === 'object' ? res.data : res;
        if (config().debug) logger.mark(`[xhh][bbs_sign] 代理重放=${data?.retcode} ${String(data?.message || '').slice(0, 60)}`);
        return data;
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_sign] 代理重放失败: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function ttocrPass(e, gt, challenge) {
    const API_KEY = config().Verification_API_KEY;
    if (!API_KEY) return null;
    const BASE_URL = 'http://api.ttocr.com/api';
    try {
        const recognizeRes = await fetch(`${BASE_URL}/recognize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appkey: API_KEY, gt, challenge, itemid: 388, referer: 'https://webstatic.mihoyo.com' })
        }).then(r => r.json());
        if (!recognizeRes.resultid) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] ttocr recognize失败: ${JSON.stringify(recognizeRes).slice(0, 120)}`);
            return null;
        }
        let result;
        for (let i = 0; i < 8; i++) {
            await sleep(i === 0 ? 3000 : 1000);
            result = await fetch(`${BASE_URL}/results?appkey=${API_KEY}&resultid=${recognizeRes.resultid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appkey: API_KEY, resultid: recognizeRes.resultid })
            }).then(r => r.json());
            if (result?.status !== 2) break;
        }
        if (result?.data && result.status === 1) {
            return { challenge: result.data.challenge, validate: result.data.validate };
        }
        if (config().debug) logger.mark(`[xhh][bbs_sign] ttocr结果: ${JSON.stringify(result).slice(0, 120)}`);
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_sign] ttocr过码失败: ${err.message}`);
    }
    return null;
}

async function bbsForumTasks(e, account, forum) {
    const listUrl = `https://bbs-api.miyoushe.com/post/api/getForumPostList?forum_id=${forum.forumId}&is_good=false&is_hot=false&page_size=20&sort_type=1`;
    const listRes = await bbsJson(e, account, listUrl);
    const postIds = (listRes?.data?.list || []).map(v => v?.post?.post_id).filter(Boolean);
    if (!postIds.length) return '';
    await jitter();
    let browse = 0, vote = 0, share = 0;
    for (const postId of postIds.slice(0, NEED_READ)) {
        const res = await bbsJson(e, account, `https://bbs-api.miyoushe.com/post/api/getPostFull?post_id=${postId}`);
        if (Number(res?.retcode) === 0) browse++;
        await jitter();
    }
    for (const postId of postIds.slice(0, NEED_VOTE)) {
        const res = await bbsJson(e, account, 'https://bbs-api.miyoushe.com/apihub/sapi/upvotePost', { post_id: String(postId), is_cancel: false });
        if (Number(res?.retcode) === 0) vote++;
        if (isBbsCaptcha(res)) break;
        await jitter();
    }
    const shareRes = await bbsJson(e, account, `https://bbs-api.miyoushe.com/apihub/api/getShareConf?entity_id=${postIds[0]}&entity_type=1`);
    if (Number(shareRes?.retcode) === 0) share++;
    return `浏览${browse} 点赞${vote} 分享${share}`;
}

// 当日签到缓存：签过就别再打接口了，米游社按重复请求记风控
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

// 手动过码只有在配置了公网地址时才有意义(否则链接是 127.0.0.1，用户打不开，白等一整轮)
function manualGeetestReady() {
    const cfg = config() || {};
    if (cfg.manual_gt_enable === false) return false;
    const url = String(cfg.manual_gt_public_url || '').trim();
    if (!url) return false;
    return !/^https?:\/\/(127\.|localhost|0\.0\.0\.|\[::1\])/i.test(url);
}

async function bbsForumSign(e, account, forum, ctx = {}) {
    // 社区签到认 cookie_token，纯 stoken 会触发"无验证参数的 1034"导致无法过码；先用 stoken 补 cookie_token
    const ck = await ensureCookieToken(e, account.ck, account);
    const refreshed = { ...account, ck, device_id: account.device_id || stableDeviceId(account.stuid || account.uid || ck) };
    const signUrl = 'https://bbs-api.miyoushe.com/apihub/app/api/signIn';
    const gids = Number(forum.signId);
    // 今日米游币已拿满就别再发一堆请求了（账号维度，每个账号只查一次）
    if (ctx.missions === undefined) {
        ctx.missions = await bbsMissions(e, refreshed);
        if (config().debug) logger.mark(`[xhh][bbs_sign] 任务态=${ctx.missions?.res?.retcode} 可获取=${ctx.missions?.canGet ?? '未知'}`);
    }
    if (ctx.missions?.canGet === 0) return '今日已签';
    let signRes = await bbsJson(e, refreshed, signUrl, { gids }, true);
    // 网络抖动/接口超时重试一次，避免整个板块直接判失败
    if (signRes?.retcode === -500) {
        await sleep(1500);
        signRes = await bbsJson(e, refreshed, signUrl, { gids }, true);
    }
    if (config().debug) {
        const fields = (refreshed.ck || '').split(';').map(s => s.split('=')[0]).filter(Boolean).join(',');
        logger.mark(`[xhh][bbs_sign] ${forum.name} ck字段=[${fields}]`);
        logger.mark(`[xhh][bbs_sign] ${forum.name} signRes=${JSON.stringify(signRes).slice(0, 300)}`);
    }
    // 米游社颁的 challenge 要当 x-rpc-challenge 带回：过码完立刻重打仍是 1034，按梯度等放行
    const retryWithChallenge = async ch => {
        for (const gap of CAPTCHA_RETRY_GAPS) {
            if (gap) await sleep(gap);
            const retry = await bbsJson(e, refreshed, signUrl, { gids }, true, { 'x-rpc-challenge': ch });
            if (config().debug) logger.mark(`[xhh][bbs_sign] retry=${retry?.retcode} msg=${retry?.message} gap=${gap}`);
            signRes = retry;
            if (!isBbsCaptcha(retry)) return true;
        }
        return false;
    };

    // verifyVerification(wapi)换 x-rpc-challenge → 带 challenge 重签（过码接口是老版本形态：2.40.1 + 4x 盐）
    const challengeGame = ['6', '8'].includes(String(gids)) ? String(gids) : '2';
    const verifyAndRetry = async (gch, validate) => {
        if (!validate) return false;
        const verifyBody = {
            geetest_challenge: gch,
            geetest_validate: validate,
            geetest_seccode: `${validate}|jordan`
        };
        const verifyHeaders = {
            'x-rpc-client_type': '5',
            'x-rpc-app_version': GT_APP_VERSION,
            'x-rpc-challenge_game': challengeGame,
            DS: mhy.getDs2('', JSON.stringify(verifyBody), 4),
        };
        const verifyRes = await bbsJson(e, refreshed, 'https://bbs-api.miyoushe.com/misc/wapi/verifyVerification', verifyBody, true, verifyHeaders);
        const ch = verifyRes?.data?.challenge;
        if (config().debug) logger.mark(`[xhh][bbs_sign] verifyVerification=${verifyRes?.retcode} ch=${!!ch}`);
        if (!ch) return false;
        return retryWithChallenge(ch);
    };

    // 1) 代理重放优先：服务端代发，绕开本机 IP 风控
    if (isBbsCaptcha(signRes)) {
        const proxyRes = await bbsProxySign(e, refreshed, signUrl, { gids });
        if (proxyRes && !isBbsCaptcha(proxyRes) && Number(proxyRes.retcode) !== -500) signRes = proxyRes;
    }

    // 2) 自己过码：createVerification 拿 gt/challenge → 打码 → verifyVerification 换 challenge → 重签
    let captcha = null;
    if (isBbsCaptcha(signRes)) {
        try {
            const query = 'gids=2&is_high=false';
            const createHeaders = {
                'x-rpc-client_type': '5',
                'x-rpc-app_version': GT_APP_VERSION,
                'x-rpc-challenge_game': challengeGame,
                DS: mhy.getDs2(query, '', 4),
            };
            let createRes = await bbsJson(e, refreshed, `https://bbs-api.miyoushe.com/misc/wapi/createVerification?${query}`, null, false, createHeaders);
            // 兜底：老版本走 misc/api 接口，wapi 拿不到时再尝试
            if (!createRes?.data?.gt) {
                createRes = await bbsJson(e, refreshed, 'https://bbs-api.miyoushe.com/misc/api/createVerification?is_high=false');
            }
            const gt = createRes?.data?.gt;
            const challenge = createRes?.data?.challenge;
            if (config().debug) logger.mark(`[xhh][bbs_sign] createVerification=${createRes?.retcode} gt=${!!gt} challenge=${!!challenge} forum=${forum.name}`);
            if (gt && challenge) {
                captcha = { gt, challenge, new_captcha: createRes.data.new_captcha || 1, success: createRes.data.success ?? 1 };
                let gch = challenge;
                let validate = '';
                // 1) 打码平台(需 Verification_API_KEY，全自动)
                const tt = await ttocrPass(e, gt, challenge);
                if (tt) {
                    gch = tt.challenge;
                    validate = tt.validate;
                    if (config().debug) logger.mark(`[xhh][bbs_sign] ttocr过码成功`);
                }
                // 2) 极验代理(免费，秒回)
                if (!validate) {
                    validate = await geetestPass(gt, challenge);
                    gch = challenge;
                    if (config().debug) logger.mark(`[xhh][bbs_sign] validate=${validate ? validate.slice(0, 24) + '...' : '空'}`);
                }
                if (validate) await verifyAndRetry(gch, validate);
            }
        } catch (err) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 过码失败: ${err.message}`);
        }
    }
    // 最后才轮到手动过码：一轮签到只弹一次(否则 7 个板块 × 120s 直接把指令卡死)
    if (isBbsCaptcha(signRes) && captcha && manualGeetestReady() && !ctx.manualUsed) {
        ctx.manualUsed = true;
        try {
            const man = await manualGeetest(e, captcha, `${forum.name} 社区签到`);
            if (man?.validate) await verifyAndRetry(man.challenge, man.validate);
        } catch (err) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 手动过码异常: ${err.message}`);
        }
    }
    let signTip;
    const rc = Number(signRes?.retcode);
    if (rc === 0) signTip = '签到成功';
    else if (rc === -5003 || rc === 1008 || /已经|已签到|重复/.test(signRes?.message || '')) signTip = '今日已签';
    else if (isBbsExpired(signRes)) return '登录失效,请重新[扫码绑定]';
    else if (isBbsCaptcha(signRes)) return '遇到验证码(未过码)';
    else if (isBbsBadSign(signRes)) return '请求被拒(签名/版本)';
    else signTip = signRes?.message || `失败(${signRes?.retcode ?? '无返回'})`;
    // 签到没成功就别再刷浏览/点赞了，只会加重风控
    if (!/签到成功|今日已签/.test(signTip)) return signTip;
    let taskTip = '';
    try {
        taskTip = await bbsForumTasks(e, refreshed, forum);
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_task] ${forum.name}: ${err.message}`);
    }
    return taskTip ? `${signTip} ${taskTip}` : signTip;
}

async function BbsAllSign(e) {
    const accounts = getBbsAccounts(e);
    if (!accounts.length) return e.reply('未找到米游社SToken，请先扫码绑定', true, { recallMsg: 60 });
    const lines = ['米游社社区全部签到'];
    const msgs = [];
    for (const account of accounts) {
        lines.push(`\n通行证 ${account.stuid || '默认(当前绑定)'}`);
        const rows = [];
        if (await bbsSignedToday(e, account)) {
            for (const forum of BBS_FORUMS) {
                lines.push(`${forum.name}：今日已签`);
                rows.push({ name: forum.name, tip: '今日已签' });
            }
            msgs.push(bbsCardItem(account, rows));
            continue;
        }
        const ctx = {};
        for (const forum of BBS_FORUMS) {
            let tip = '签到异常';
            try {
                tip = await bbsForumSign(e, account, forum, ctx);
            } catch (err) {
                logger.error(`[xhh][bbs_sign] ${account.stuid} ${forum.name}: ${err.message}`);
            }
            lines.push(`${forum.name}：${tip}`);
            rows.push({ name: forum.name, tip });
            await jitter(1500, 3000);
        }
        msgs.push(bbsCardItem(account, rows));
        if (rows.length && rows.every(r => /签到成功|今日已签/.test(r.tip))) await markBbsSigned(e, account);
    }
    return replyBbsResultImage(e, msgs, lines);
}

async function bbsSignForEvent(e, all = false) {
    const accounts = getBbsAccounts(e);
    if (!accounts.length) return { msgs: [], lines: [`米游社社区${all ? '全部' : ''}签到`, '未找到米游社SToken，请先扫码绑定'] };
    const lines = [`米游社社区${all ? '全部' : ''}签到`];
    const msgs = [];
    for (const account of accounts) {
        lines.push(`\n通行证 ${account.stuid || '默认(当前绑定)'}`);
        const rows = [];
        if (await bbsSignedToday(e, account)) {
            for (const forum of BBS_FORUMS) {
                lines.push(`${forum.name}：今日已签`);
                rows.push({ name: forum.name, tip: '今日已签' });
            }
            msgs.push(bbsCardItem(account, rows));
            continue;
        }
        const ctx = {};
        for (const forum of BBS_FORUMS) {
            let tip = '签到异常';
            try {
                tip = await bbsForumSign(e, account, forum, ctx);
            } catch (err) {
                logger.error(`[xhh][bbs_sign] ${account.stuid || e.user_id} ${forum.name}: ${err.message}`);
            }
            lines.push(`${forum.name}：${tip}`);
            rows.push({ name: forum.name, tip });
            await jitter(1500, 3000);
        }
        msgs.push(bbsCardItem(account, rows));
        if (rows.length && rows.every(r => /签到成功|今日已签/.test(r.tip))) await markBbsSigned(e, account);
    }
    return { msgs, lines };
}

async function BbsSign(e) {
    if (/全部/.test(e.msg || '')) return BbsAllSign(e);
    // 社区签到必须用 Stoken 文件里的 stoken（米游社 bbs-api 认 stoken，getMysUser 只有 ltoken 无法签社区）
    const accounts = getBbsAccounts(e);
    if (!accounts.length) {
        const mys = e.user.getMysUser('gs');
        if (!mys) return e.reply('未绑定米游社,请发送[扫码绑定]', true, { recallMsg: 60 });
        accounts.push({ stuid: '', ck: mys.ck, device_id: stableDeviceId(mys.ck || e.user_id) });
        if (!/stoken=/.test(mys.ck || '')) await e.reply('未找到米游社SToken(社区签到只认stoken)，请先[小花火扫码登录]绑定', true, { recallMsg: 60 });
    }
    const lines = ['米游社社区签到'];
    const msgs = [];
    for (const account of accounts) {
        const rows = [];
        if (await bbsSignedToday(e, account)) {
            for (const forum of BBS_FORUMS) {
                lines.push(`${forum.name}：今日已签`);
                rows.push({ name: forum.name, tip: '今日已签' });
            }
            msgs.push(bbsCardItem(account, rows));
            continue;
        }
        const ctx = {};
        for (const forum of BBS_FORUMS) {
            let tip = '签到异常';
            try {
                tip = await bbsForumSign(e, account, forum, ctx);
            } catch (err) {
                logger.error(`[xhh][bbs_sign] ${forum.name}: ${err.message}`);
            }
            lines.push(`${forum.name}：${tip}`);
            rows.push({ name: forum.name, tip });
            await jitter(1500, 3000);
        }
        msgs.push(bbsCardItem(account, rows));
        if (rows.length && rows.every(r => /签到成功|今日已签/.test(r.tip))) await markBbsSigned(e, account);
    }
    return replyBbsResultImage(e, msgs, lines);
}

async function BbsAutoSign(qqs = []) {
    const allMsgs = [];
    const allLines = ['米游社社区自动签到'];
    const users = [...new Set((qqs || []).map(v => String(v).trim()).filter(Boolean))];
    for (const qq of users) {
        const e = {
            user_id: qq,
            msg: '社区签到',
            isGroup: false,
            sender: { nickname: String(qq) },
            reply: async () => false,
        };
        const { msgs, lines } = await bbsSignForEvent(e, false);
        allLines.push(`\nQQ ${qq}`);
        allLines.push(...lines.slice(1));
        allMsgs.push(...msgs.map(m => ({ ...m, title: `QQ ${qq} · ${m.title}` })));
        await jitter(2000, 4000);
    }
    return { msgs: allMsgs, lines: allLines };
}

async function sendBbsAutoResult(group, result) {
    const { lines = [] } = result || {};
    if (!group) return false;
    return Bot.pickGroup(Number(group)).sendMsg(lines.join('\n') || '米游社社区自动签到完成');
}

// 结果汇总：全失败时给出可操作的排查提示，不再 60s 就把消息撤掉
function bbsResultTips(lines) {
    const body = lines.slice(1);
    const tips = [];
    if (body.some(l => /遇到验证码/.test(l))) {
        tips.push('提示：触发米游社验证码，可配置 Verification_API_KEY 使用代理，或配置 manual_gt_public_url 后用手动过码');
    }
    if (body.some(l => /登录失效/.test(l))) {
        tips.push('提示：ck 已失效，重新[扫码绑定]后再试');
    }
    if (body.some(l => /请求被拒/.test(l))) {
        tips.push('提示：接口签名被拒(米游社版本更新)，请更新插件后再试');
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
        const img = await render('sign/sign', {
            msgs,
            qq: e.user_id,
            name: e.sender?.card || e.sender?.nickname || String(e.user_id),
            // 与游戏签到共用 sign/sign.html，这里单独给个 saveId，免得命中它的渲染缓存
            saveId: 'bbs_sign',
        }, { e, ret: true });
        if (img) {
            if (!ok) {
                const tips = bbsResultTips(lines);
                if (tips.length) await e.reply(tips.join('\n'), false, { recallMsg: 300 });
            }
            return e.reply(img, false, ok ? {} : { recallMsg: 300 });
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
