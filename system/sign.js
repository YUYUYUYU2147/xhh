import fetch from 'node-fetch';
import fs from 'fs';
import crypto from 'node:crypto';
import net from 'node:net';

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
import { mhyFetch } from './mhy_fetch.js';


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

// 规整一份 ck：去掉分隔符两侧的空白。
// 别的插件存进来的 ck 有 '; account_id=xxx' 这种带空格的写法，
// account_id 前多一个空格就会让米游社判成未登录（retcode=-100）。
function normalizeCk(ck) {
    if (!ck) return '';
    return buildCookie(parseCookie(ck));
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
            const resp = await mhyFetch(url, { method: 'GET', headers: mhy.getHeaders(e, ck), signal: controller.signal });
            const text = await resp.text();
            try {
                return JSON.parse(text);
            } catch (err) {
                // 被风控拦下时米游社回的是 HTML 拦截页，硬解析会抛 SyntaxError
                const head = String(text || '').trim().slice(0, 80);
                logger.mark(`[xhh][sign] 返回非 JSON，status=${resp.status} body=${head}`);
                return { retcode: -1, message: head.startsWith('<') ? '米游社返回拦截页，请稍后重试' : '接口返回异常' };
            }
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
    const xiaoyaoAll = getXiaoyaoEntries(e.user_id);
    if (
        !e.user.getMysUser() &&
        !e.user.getMysUser('sr') &&
        !e.user.getMysUser('zzz') &&
        !e.user.getMysUser('bh3') &&
        !hasBh3Xhh &&
        !xiaoyaoAll.length
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
            if (mys) {
                const uids = Array.isArray(mys.uids?.[game]) ? mys.uids[game] : [];
                for (const uid of uids) {
                    targets.push({
                        uid,
                        ck: await ckForGameUid(e, game, uid, mys.ck),
                        server: await ckRegionForGameUid(game, uid) || null,
                    });
                }
            }
        }
        // 逍遥插件的账号按 game_biz 归到对应游戏，和 xhh 侧的账号一起签。
        // 同一个 uid 两边都有时只签一次，免得重复请求把风控打上去。
        for (const v of xiaoyaoAll) {
            if (v.game !== game || !v.uid) continue;
            const hit = targets.find(t => String(t.uid) === v.uid);
            if (hit) {
                // 已经由 getMysUser 那条路收进来的同一个 uid：库里那份 ck 可能是失效缓存
                // （genshin 的 ck 里 account_id 前还带个空格，发出去就是 -100）。
                // 逍遥这份带 stoken，可以现场换出新的 cookie_token，能换成就换掉。
                if (v.stuid && v.stoken) {
                    const rebuilt = await ckForGameUid(e, game, v.uid, xiaoyaoCk(v), v);
                    if (/cookie_token=/.test(rebuilt) && /ltoken=/.test(rebuilt)) {
                        hit.ck = rebuilt;
                        if (v.region) hit.server = v.region;
                    }
                }
                continue;
            }
            targets.push({ uid: v.uid, ck: await ckForGameUid(e, game, v.uid, xiaoyaoCk(v), v), server: v.region || null });
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
    if (!data.sign || typeof data.sign !== 'object') data.sign = {};
    // 比较前统一转字符串：yaml 里存的是数字，e.user_id 的类型取决于适配器，
    // 两边类型不一致时 includes 恒为 false，同一个 QQ 每次签到都会被再塞一遍，
    // sign.yaml 无限膨胀。群号做键同理，统一 String() 免得和 addBbs 写出两种键。
    const group = String(e.group_id);
    const qq = String(e.user_id);
    for (const [gid, list] of Object.entries(data.sign)) {
        if (!Array.isArray(list)) continue;
        data.sign[gid] = list.map(String);
        if (data.sign[gid].includes(qq)) return;
    }
    const qqs = Array.isArray(data.sign[group]) ? data.sign[group] : [];
    qqs.push(qq);
    data.sign[group] = qqs;
    return yaml.set(path, 'sign', data.sign);
}

function isAllowSignGroup(signGroup, group) {
    if (!Array.isArray(signGroup) || signGroup.length === 0) return true;
    const gid = String(group);
    return signGroup.map(v => String(v)).includes(gid);
}


// bbs-api 的盐与 app_version 必须成套；参考 xhh-TL 的社区任务实现。
const BBS_APP_VERSION = '2.102.1';
// GET 类 DS 盐（2.102.1 的 K2）
const BBS_SALT_K2 = 'lX8m5VO5at5JG7hR8hzqFwzyL5aB1tYo';
// POST 类 DS2 盐（gsuid 表的 salt_id 22）
const BBS_SALT_X6 = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v';
// 过码接口仍是老版本形态（4x 盐 + 2.40.1）
const GT_APP_VERSION = '2.40.1';
const BBS_DEFAULT_FP = '38d7ee834d1e9';
// 过码服务地址。默认指向插件自带的 service/geetest（用 #过码部署 起在本机 2149），
// 装到别处就改配置里的 auto_verify_addr。留空则视为没装，自动过码整段跳过。
const DEFAULT_AUTO_VERIFY_ADDR = 'http://127.0.0.1:2149/solve';
const autoVerifyAddr = () => String(config()?.auto_verify_addr ?? DEFAULT_AUTO_VERIFY_ADDR).trim();
// 撞码 → 过码成功后的重签梯度（毫秒）：过码完立刻重打仍是 1034，要等米游社放行
const CAPTCHA_RETRY_GAPS = [0, 6000, 15000, 30000, 60000];
// 每日任务需求数（按官方上限收敛，不做无谓请求）
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

// ─────────── 逍遥插件（xiaoyao-cvs-plugin）的 stoken ───────────
// 社区签到与游戏签到都从这里补账号。以前社区签到只在「xhh 一个 stoken 都没有」
// 时才去读逍遥的文件，导致两边各自签到过、却互相看不见对方的账号。
// 现在两个来源都读、按 stuid 去重，谁都有就用谁。
const xiaoyaoYamlPath = qq => `./plugins/xiaoyao-cvs-plugin/data/yaml/${qq}.yaml`;

// 逍遥用 game_biz 标游戏（hk4e=原神 hkrpg=星铁 nap=绝区零 bh3=崩坏3），
// 翻成小花火内部用的键
const XIAOYAO_GAME_BIZ = { hk4e_cn: 'gs', hkrpg_cn: 'sr', nap_cn: 'zzz', bh3_cn: 'bh3' };
// 但实测有一批条目根本没有 game_biz 字段（24 个里占 6 个），只有 region_name。
// region 单独不够用 —— prod_gf_cn 同时对应绝区零和星铁，得靠 region_name 区分。
// 剩下的 iOS国服 / 安卓国服 / 全平台（桌面）服 是崩三那套 region，按 isBh3Region 兜。
// 世界树是原神那边的地名（region 为 cn_qd01，原神渠道服）
const XIAOYAO_REGION_NAME = { 天空岛: 'gs', 世界树: 'gs', 星穹列车: 'sr', 新艾利都: 'zzz' };

/**
 * 「一条绑定记录 → 内部游戏键」的判据：game_biz → region_name → 崩三那套 region。
 * 名字里带 xiaoyao 只是因为最初为读逍遥文件写的，实际两个来源的条目结构一样，
 * 所以补名单等在别处算游戏的地方也复用这一份，别再抄第二套常量 ——
 * 两份实现各自演化过一次，导致只有 xhh 侧数据的人游戏全显示未知。
 */
function gameOfEntry(e) {
    const byBiz = XIAOYAO_GAME_BIZ[String(e?.game_biz || '')];
    if (byBiz) return byBiz;
    const byName = XIAOYAO_REGION_NAME[String(e?.region_name || '')];
    if (byName) return byName;
    return isBh3Region(e?.region) ? 'bh3' : '';
}

function xiaoyaoGameOf(e) {
    const byBiz = XIAOYAO_GAME_BIZ[String(e?.game_biz || '')];
    if (byBiz) return byBiz;
    const byName = XIAOYAO_REGION_NAME[String(e?.region_name || '')];
    if (byName) return byName;
    return isBh3Region(e?.region) ? 'bh3' : '';
}

function getXiaoyaoEntries(qq) {
    const path = xiaoyaoYamlPath(qq);
    if (!fs.existsSync(path)) return [];
    try {
        const data = yaml.get(path) || {};
        return Object.entries(data).map(([key, v]) => {
            const e = v || {};
            return {
                ...e,
                // 顶层键就是 stuid，但以条目里写的字段为准
                stuid: String(e.stuid || key),
                uid: e.uid != null && e.uid !== '' ? String(e.uid) : '',
                game: xiaoyaoGameOf(e),
            };
        }).filter(e => e.stuid && e.stoken);
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 读取逍遥 stoken 失败: ${err.message}`);
        return [];
    }
}

// 逍遥没有 cookie_token 时，按 xhh 同样的拼法凑一个
const xiaoyaoCk = e => e.ck_stoken || `stuid=${e.stuid};stoken=${e.stoken};${e.mid ? `mid=${e.mid};` : ''}`;

function getBbsAccounts(e) {
    const path = `./plugins/xhh/data/Stoken/${e.user_id}.yaml`;
    const accounts = new Map();
    // 收单个条目。必须和收整张表分开：原来只有 collect(data) 一个函数去遍历
    // Object.values(data)，逍遥那路传进来的是「一个扁平条目」而不是「uid→条目」的表，
    // 于是 Object.values 得到的是 stuid/stoken 这些字符串，entry?.stuid 全是 undefined，
    // 每个条目都被 continue 掉 —— 表现为日志里「逍遥条目=10 → 通行证 0」。
    const collectOne = entry => {
        if (!entry?.stuid || !entry?.stoken) return;
        if (accounts.has(String(entry.stuid))) return;
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
    };
    const collect = data => {
        for (const entry of Object.values(data || {})) collectOne(entry);
    };
    // 先收 xhh 侧的：两边有同一个 stuid 时以它为准（它带 ck_stoken，信息更全）
    if (fs.existsSync(path)) {
        try { collect(yaml.get(path)); } catch (_) {}
    }
    // 再补逍遥插件的账号。以前这里是「xhh 一个都没有才用逍遥的」，
    // 于是同一个 QQ 两边各签过一部分账号时，签到只覆盖其中一边。
    const xy = getXiaoyaoEntries(e.user_id);
    for (const entry of xy) {
        collectOne(entry);
    }
    if (config().debug) {
        // 两个来源各读了多少、最终剩几个通行证，出问题时这行能直接定位是哪边丢的。
        // 判存在要先做：yaml.get 内部会 catch 住 ENOENT 并 logger.error，
        // 而只有逍遥侧数据的人本来就没有这个文件，不判一下每次都往 error.log 刷一条。
        const hasXh = fs.existsSync(path);
        let xhN = 0;
        if (hasXh) {
            try { xhN = Object.keys(yaml.get(path) || {}).length; } catch { }
        }
        logger.mark(`[xhh][bbs] 账号来源 qq=${e.user_id} xhh文件=${hasXh ? '有' : '无'} `
            + `xhh条目=${xhN} 逍遥条目=${xy.length} → 通行证 ${accounts.size}`);
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

function bbsDeviceContext(e, account, ck) {
    const headers = bbsBaseHeaders(e, ck, '', false);
    if (account?.device_id) headers['x-rpc-device_id'] = account.device_id;
    return {
        id: headers['x-rpc-device_id'],
        fp: headers['x-rpc-device_fp'] || BBS_DEFAULT_FP,
    };
}

function bbsVerifyHeaders(e, account, query = '', body = '', challengeGame = '2', clientType = '5') {
    const device = bbsDeviceContext(e, account, account.ck);
    const headers = {
        Cookie: account.ck,
        'x-rpc-device_id': String(device.id),
        'x-rpc-app_version': GT_APP_VERSION,
        'x-rpc-client_type': String(clientType || '5'),
        'x-rpc-device_fp': device.fp || BBS_DEFAULT_FP,
        'x-rpc-challenge_game': String(challengeGame || '2'),
        'User-Agent': `Mozilla/5.0 (Linux; Android 12; ${device.id}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/${GT_APP_VERSION}`,
        'X-Requested-With': 'com.mihoyo.hyperion',
        Origin: 'https://webstatic.mihoyo.com',
        Referer: 'https://webstatic.mihoyo.com',
        DS: mhy.getDs2(query, body, 4),
    };
    if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';
    return headers;
}

/** 撞风控（1034 同族）；注意 -5003 是「今日已签过」，不是验证码 */
function isBbsCaptcha(res) {
    const rc = Number(res?.retcode);
    // 5003 是重复签到/今日已签，不是验证码；纳入验证码会触发无意义的过码请求。
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
    const res = await bbsJson(e, account, 'https://bbs-api.miyoushe.com/apihub/wapi/getUserMissionsState?point_sn=myb');
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
        const resp = await mhyFetch(url, {
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

async function bbsVerifyJson(e, account, url, body = null, query = '', challengeGame = '2', clientType = '5') {
    const bodyText = body ? JSON.stringify(body) : '';
    const headers = bbsVerifyHeaders(e, account, query, bodyText, challengeGame, clientType);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const resp = await mhyFetch(url, {
            method: body ? 'POST' : 'GET',
            headers,
            body: body ? bodyText : undefined,
            signal: controller.signal,
        });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch {
            logger.error(`[xhh][bbs_verify] 返回非JSON: ${text.slice(0, 200)}`);
            return { retcode: -500, message: '接口返回异常(非JSON)' };
        }
    } catch (err) {
        logger.error(`[xhh][bbs_verify] 请求失败: ${err.message}`);
        return { retcode: -500, message: '请求失败: ' + (err.name === 'AbortError' ? '超时' : err.message) };
    } finally {
        clearTimeout(timer);
    }
}

// 本地过码服务的可用性探测。/solve 的超时是 360 秒，端口不通时每个板块都要等满这一整轮
// （7 个板块 42 分钟）；端口上有东西但挂死不响应也一样。这里只做 TCP 连通性探测，
// 不发请求、不带凭证，几秒就能判定，不可用就整轮跳过 /solve 直接走手动。
let autoVerifyProbe = { at: 0, ok: false };
const AUTO_VERIFY_PROBE_TTL = 5 * 60 * 1000;
const AUTO_VERIFY_PROBE_TIMEOUT = 2000;

function probeTcp(host, port, timeout = AUTO_VERIFY_PROBE_TIMEOUT) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        let settled = false;
        const done = ok => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function autoVerifyAvailable() {
    const addr = autoVerifyAddr();
    // 显式配成空串 = 主动关掉了自动过码，别再退回默认端口去探
    if (!addr) return false;
    const now = Date.now();
    if (now - autoVerifyProbe.at < AUTO_VERIFY_PROBE_TTL) return autoVerifyProbe.ok;
    let host = '127.0.0.1', port = 2149;
    try {
        const u = new URL(addr);
        host = u.hostname || host;
        port = Number(u.port) || port;
    } catch (_) { /* 地址写坏了就按默认端口探，探不到自然跳过 */ }
    const ok = await probeTcp(host, port);
    autoVerifyProbe = { at: now, ok };
    if (config().debug) logger.mark(`[xhh][bbs_sign] 本地过码服务 ${host}:${port} ${ok ? '可用' : '不可用，跳过自动过码'}`);
    return ok;
}

// ─────────────────── 第三方打码平台（可选兜底） ───────────────────
// ttocr 提供米游社这类极验滑块的识别。配了 ttocr_appkey 才会走，
// 没配就当没这一级，顺序是：本机服务 → 打码平台 → 手动验证。
//
// ⚠️ 两个必须知道的前提：
//   1) 官方只提供 http://，没有 https（实测 https 连不上）。也就是说 appkey
//      每次都以明文过网。它是计费凭证，被人截获就能刷掉点数。配之前先想清楚这点。
//   2) 官方的限速很硬：查询结果、查点数都不得超过每秒 1 次，超了拉黑 IP
//      （查结果 10 分钟、查点数 24 小时）。下面的间隔都留了余量，别再压。
const TTOCR_BASE = 'http://api.ttocr.com/api';
// 三代滑块 5 点；388（三代全类别）10 点。米游社目前只发滑块，用 32 便宜一半。
const TTOCR_ITEMID_SLIDER = 32;
const TTOCR_REFERER = 'https://webstatic.mihoyo.com';
// 官方要求查询间隔 ≥1s；这里用 1.5s 留余量，整次最多等 30s
const TTOCR_POLL_GAP = 1500;
const TTOCR_MAX_WAIT = 30000;

const ttocrAppKey = () => String(config()?.ttocr_appkey || '').trim();
const ttocrItemId = () => Number(config()?.ttocr_itemid) || TTOCR_ITEMID_SLIDER;

/** 提交识别，拿 resultid。返回空串表示没配 appkey 或提交失败。 */
async function ttocrSubmit(gt, challenge) {
    const appkey = ttocrAppKey();
    if (!appkey) return '';
    const body = new URLSearchParams({
        appkey,
        gt: String(gt || ''),
        challenge: String(challenge || ''),
        itemid: String(ttocrItemId()),
        referer: TTOCR_REFERER,
    }).toString();
    try {
        const res = await fetch(`${TTOCR_BASE}/recognize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(15000),
        }).then(r => r.json());
        // status=1 且有 resultid 才是提交成功
        if (Number(res?.status) === 1 && res?.resultid) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 打码平台已提交 resultid=${String(res.resultid).slice(0, 12)}…`);
            return String(res.resultid);
        }
        logger.mark(`[xhh][bbs_sign] 打码平台提交失败 status=${res?.status} msg=${String(res?.msg || '').slice(0, 60)}`);
    } catch (err) {
        logger.mark(`[xhh][bbs_sign] 打码平台提交异常: ${err.message}`);
    }
    return '';
}

/** 轮询识别结果。官方说结果 60 秒内返回、有效期 60 秒。 */
async function ttocrPoll(resultid) {
    const appkey = ttocrAppKey();
    if (!appkey || !resultid) return null;
    const body = new URLSearchParams({ appkey, resultid }).toString();
    const deadline = Date.now() + TTOCR_MAX_WAIT;
    while (Date.now() < deadline) {
        await sleep(TTOCR_POLL_GAP);
        let res;
        try {
            res = await fetch(`${TTOCR_BASE}/results`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(15000),
            }).then(r => r.json());
        } catch (err) {
            logger.mark(`[xhh][bbs_sign] 打码平台查询异常: ${err.message}`);
            return null;
        }
        const status = Number(res?.status);
        // status=1 且带 validate 才是识别完成；其余（还在识别 / 失败）继续等
        if (status === 1 && res?.data?.validate) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 打码平台识别成功耗时=${res?.time ?? '未知'}ms`);
            return {
                challenge: res.data.challenge || '',
                validate: res.data.validate,
                seccode: res.data.seccode || `${res.data.validate}|jordan`,
            };
        }
        // 明确的失败状态就别耗着了（识别失败官方不扣点数，重来不亏）
        if (status >= 4000 || (res?.msg && /失败|错误|不存在|过期/.test(String(res.msg)))) {
            logger.mark(`[xhh][bbs_sign] 打码平台返回失败 status=${status} msg=${String(res?.msg || '').slice(0, 60)}`);
            return null;
        }
    }
    logger.mark('[xhh][bbs_sign] 打码平台等待超时');
    return null;
}

/** 一步到位：提交 + 轮询。返回 {challenge, validate, seccode} 或 null。 */
async function ttocrPass(gt, challenge) {
    if (!ttocrAppKey()) return null;
    const resultid = await ttocrSubmit(gt, challenge);
    if (!resultid) return null;
    return await ttocrPoll(resultid);
}

/** 查剩余点数。限速是 1 次/秒、超了拉黑 24 小时，所以结果缓存 5 分钟。 */
let ttocrPointsCache = { at: 0, text: '' };
async function ttocrPoints() {
    const appkey = ttocrAppKey();
    if (!appkey) return '';
    const now = Date.now();
    if (now - ttocrPointsCache.at < 5 * 60 * 1000) return ttocrPointsCache.text;
    let text = '';
    try {
        const res = await fetch(`${TTOCR_BASE}/points?appkey=${encodeURIComponent(appkey)}`, {
            signal: AbortSignal.timeout(10000),
        }).then(r => r.json());
        text = Number(res?.status) === 1
            ? `${res.points} 点`
            : `查询失败(${res?.status ?? '无返回'})`;
    } catch (err) {
        text = `查询失败：${err.message}`;
    }
    ttocrPointsCache = { at: now, text };
    return text;
}

async function bbsAutoVerify(e, account) {
    if (!(await autoVerifyAvailable())) return '';
    const device = bbsDeviceContext(e, account, account.ck);
    try {
        const res = await fetch(autoVerifyAddr(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cookie: account.ck,
                deviceId: String(device.id),
                deviceFp: String(device.fp || ''),
                clientType: '2',
            }),
            signal: AbortSignal.timeout(360000),
        }).then(r => r.json());
        if (res?.data?.result === 'ok') {
            const challenge = res.data.challenge || '';
            logger.mark(`[xhh][bbs_sign] 本地服务自动过码成功 challenge=${challenge ? '有' : '无'}`);
            return challenge;
        }
        if (res?.error === 'breaker open') {
            // 服务端熔断中：这一条没真去解滑块，是服务端主动拒的，等冷却结束会自动恢复
            logger.mark(`[xhh][bbs_sign] 本地过码服务熔断中，本次跳过（建议 ${res.retryAfter ?? '若干'} 秒后再试），直接走手动/兜底`);
        } else if (config().debug) {
            logger.mark(`[xhh][bbs_sign] 本地服务未过码: ${JSON.stringify(res).slice(0, 160)}`);
        }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_sign] 本地过码服务不可用: ${err.message}`);
    }
    return '';
}

async function bbsDailyTasks(e, account) {
    const listUrl = `https://bbs-api.miyoushe.com/post/api/getForumPostList?forum_id=${TASK_FORUM_ID}&is_good=false&is_hot=false&page_size=20&sort_type=1`;
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

// 手动过码服务已经内置默认值；是否能把链接送达交给 manual_geetest 内部判断。
function manualGeetestReady() {
    return true;
}

async function bbsForumSign(e, account, forum, ctx = {}) {
    // 社区签到认 cookie_token，纯 stoken 会触发"无验证参数的 1034"导致无法过码；先用 stoken 补 cookie_token。
    // 补出来的 ck 必须存进 ctx 并在后面的板块复用：account.ck 在整个板块循环里始终是原始值，
    // 之前每个板块都重跑一遍 ensureCookieToken。实测 ck 缺 cookie_token 时一次签到发
    // 14 个请求（getCookieAccountInfoBySToken + getLTokenBySToken 各 7 遍），
    // 全部用来推导同一个 token；而缺 cookie_token 的正是被风控的那批账号，
    // 多打 6 倍请求只会让风控更严重。
    if (!ctx.refreshedAccount) {
        const ck = await ensureCookieToken(e, account.ck, account);
        ctx.refreshedAccount = {
            ...account,
            ck,
            device_id: account.device_id || stableDeviceId(account.stuid || account.uid || ck)
        };
    }
    const refreshed = ctx.refreshedAccount;
    const signUrl = 'https://bbs-api.miyoushe.com/apihub/app/api/signIn';
    const gids = Number(forum.signId);
    // 任务态只用于后面判断要不要跑浏览/点赞/分享；板块签到仍然逐个执行。
    if (ctx.missions === undefined) {
        ctx.missions = await bbsMissions(e, refreshed);
        if (config().debug) logger.mark(`[xhh][bbs_sign] 任务态=${ctx.missions?.res?.retcode} 可获取=${ctx.missions?.canGet ?? '未知'}`);
    }
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
            // 只在「真的签上了」时收手。以前这里是 !isBbsCaptcha(retry) —— 把
            // 1005 参数错误这种「风控尚未放行」既不是验证码、也不是成功的码，
            // 当成成功立刻返回 true，CAPTCHA_RETRY_GAPS 的 6/15/30/60 秒
            // 梯度一次都跑不到。实测过码成功拿到 challenge 后立刻重签就是 1005，
            // 整轮 2.8 秒结束，后面的梯度全被跳过。
            // 0 = 签到成功；-5003 / 1008 = 今日已签，同样算过。
            const rc = Number(retry?.retcode);
            if (rc === 0 || rc === -5003 || rc === 1008) return true;
        }
        return false;
    };

    // verifyVerification(wapi)换 x-rpc-challenge → 带 challenge 重签（过码接口是老版本形态：2.40.1 + 4x 盐）
    const challengeGame = ['6', '8'].includes(String(gids)) ? String(gids) : '2';
    const verifyAndRetry = async (gch, validate, clientType = '2', verifyUrl = 'https://bbs-api.miyoushe.com/misc/api/verifyVerification') => {
        if (!validate) return false;
        const v = typeof validate === 'object' ? validate : { validate };
        const geetestValidate = v.geetest_validate || v.validate || '';
        const verifyBody = {
            geetest_challenge: v.geetest_challenge || v.challenge || gch,
            geetest_validate: geetestValidate,
            geetest_seccode: v.geetest_seccode || v.seccode || `${geetestValidate}|jordan`
        };
        if (!verifyBody.geetest_validate) return false;
        const verifyRes = await bbsVerifyJson(e, refreshed, verifyUrl, verifyBody, '', challengeGame, clientType);
        const ch = verifyRes?.data?.challenge;
        if (config().debug) logger.mark(`[xhh][bbs_sign] verifyVerification=${verifyRes?.retcode} ch=${!!ch}`);
        if (!ch) return false;
        return retryWithChallenge(ch);
    };

    // xhh-TL 同款：本地全自动过码服务优先，拿到 challenge 后按梯度重签
    if (isBbsCaptcha(signRes)) {
        const ch = await bbsAutoVerify(e, refreshed);
        if (ch) await retryWithChallenge(ch);
    }

    // 手动过码流程：createVerification 拿 gt/challenge → 打码/手动 → verifyVerification 换 challenge → 重签
    let captcha = null;
    if (isBbsCaptcha(signRes)) {
        try {
            let verifyClientType = '2';
            let verifyUrl = 'https://bbs-api.miyoushe.com/misc/api/verifyVerification';
            let query = 'is_high=false';
            let createRes = await bbsVerifyJson(e, refreshed, `https://bbs-api.miyoushe.com/misc/api/createVerification?${query}`, null, query, challengeGame, verifyClientType);
            // 兜底：网页端老接口还能拿到 gt 时也给手动链接，但 POST 签到主要依赖 App 端这套。
            if (!createRes?.data?.gt) {
                verifyClientType = '5';
                verifyUrl = 'https://bbs-api.miyoushe.com/misc/wapi/verifyVerification';
                query = 'gids=2&is_high=false';
                createRes = await bbsVerifyJson(e, refreshed, `https://bbs-api.miyoushe.com/misc/wapi/createVerification?${query}`, null, query, challengeGame, verifyClientType);
            }
            const gt = createRes?.data?.gt;
            const challenge = createRes?.data?.challenge;
            if (config().debug) logger.mark(`[xhh][bbs_sign] createVerification=${createRes?.retcode} gt=${!!gt} challenge=${!!challenge} forum=${forum.name}`);
            if (gt && challenge) {
                captcha = { gt, challenge, new_captcha: createRes.data.new_captcha || 1, success: createRes.data.success ?? 1, verifyClientType, verifyUrl };
            }
        } catch (err) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 过码失败: ${err.message}`);
        }
    }
    // 打码平台兜底：配了 ttocr_appkey 才走。放在本机服务之后、手动之前 ——
    // 本机服务免费且实测百发百中，平台是花钱的，只在它没解开时才花点数。
    if (isBbsCaptcha(signRes) && captcha?.gt && ttocrAppKey()) {
        try {
            const tt = await ttocrPass(captcha.gt, captcha.challenge);
            if (tt?.validate) {
                // ttocr 返回的是极验侧的新 challenge + validate，
                // 要再换一次米游社的 x-rpc-challenge 才能重签
                await verifyAndRetry(tt.challenge || captcha.challenge, tt, captcha.verifyClientType, captcha.verifyUrl);
            }
        } catch (err) {
            if (config().debug) logger.mark(`[xhh][bbs_sign] 打码平台过码异常: ${err.message}`);
        }
    }
    // 最后才轮到手动过码：一轮签到只弹一次(否则 7 个板块 × 120s 直接把指令卡死)
    if (isBbsCaptcha(signRes) && captcha && manualGeetestReady() && !ctx.manualUsed) {
        ctx.manualUsed = true;
        try {
            const man = await manualGeetest(e, captcha, `${forum.name} 社区签到`);
            if (man?.validate) await verifyAndRetry(man.challenge, man, captcha.verifyClientType, captcha.verifyUrl);
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
    return signTip;
}

async function finishBbsAccount(e, account, ctx, rows, lines) {
    const ok = rows.length && rows.every(r => /签到成功|今日已签/.test(r.tip));
    if (!ok) return false;
    try {
        if (ctx?.missions?.canGet !== 0) {
            const taskTip = await bbsDailyTasks(e, ctx?.refreshedAccount || account);
            if (taskTip) lines.push(`每日任务：${taskTip}`);
        }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_task] ${account.stuid || e.user_id}: ${err.message}`);
    }
    await markBbsSigned(e, account);
    return true;
}

// stuid 是米游社账号主键：定时签到的结果会发到群里，多个 stuid 全并排公开
// 等于把所有人的账号主键挂出来。只保留后 4 位，够用来分辨名下有几个通行证。
// QQ 不脱敏：它在群里本来就从成员列表可见，而且不脱敏就没法分辨这张卡是谁的。
function maskStuid(stuid) {
    const s = String(stuid || '').trim();
    if (!s) return '默认(当前绑定)';
    return s.length <= 4 ? s : `****${s.slice(-4)}`;
}

// 三个入口（BbsSign / bbsSignForEvent，以及原先只在「签到全部」时才走的 BbsAllSign）
// 原来各抄了一遍「账号遍历 → 今日缓存判断 → 逐板块签到 → 收行 → finishBbsAccount」，
// BbsAllSign 与 BbsSign 有 26/31 行完全相同。统一收在这里，入口只负责准备账号和出图。
// 顺带修掉三处原本的不一致：
//   1) BbsSign 在「今日已签」分支会打「通行证 xxx」抬头，真正签到的分支却漏了这行，
//      同一条指令在「今天已签」和「今天没签」两种情况下输出格式不同。
//   2) BbsAllSign 在没有 stoken 时直接报错，而 BbsSign 会退回 getMysUser 再试一次。
//      现在两条路径行为一致。
//   3) BbsAllSign 合并后已无调用方也不再导出，直接删掉，不再留一份会走偏的副本。
// ─────────── 游戏签到的 CK：直接从 genshin 的库里按 uid 取 ───────────
//
// 社区签到认 Cookie 里的 stoken，所以只靠 stuid/stoken 也能成。
// 游戏签到走的是 act.mihoyo.com，它要的是 genshin 那种四件套
// ltoken;ltuid;cookie_token;account_id，只补一个 cookie_token 并不够（实测补了仍 -100）。
//
// 以前这里向 NoteUser 要 ck，但它的 getCkUid 只在 Users.games 的 data 里找
// type==="ck" 的条目：很多人那里是空的，有的标成 type="reg"，于是 getCkUid 返回空串、
// getMysUser 返回 false，游戏签到就退回逍遥那份只有 stuid/stoken 的 ck，
// 被判「Cookie失效，请[刷新ck]」—— 而这些账号的 ck 其实一直是好的。
//
// 改成不看那个标记，直接按「哪个 ltuid 拥有这个游戏 uid」去 MysUsers 表里取。
const GAME_CK_DB = './data/db/data.db';
let _ckDb;          // undefined=没试过, false=不可用, 否则是 db 实例
let _ckIndex = null; // game → Map<uid, ck>

async function openGameCkDb() {
    if (_ckDb !== undefined) return _ckDb;
    try {
        if (!fs.existsSync(GAME_CK_DB)) { _ckDb = false; return false; }
        const { DatabaseSync } = await import('node:sqlite');
        _ckDb = new DatabaseSync(GAME_CK_DB, { readOnly: true });
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 游戏签到 CK 库打不开: ${err.message}`);
        _ckDb = false;
    }
    return _ckDb;
}

/** 建 game → uid → ck 的索引，只建一次 */
async function gameCkIndex() {
    if (_ckIndex) return _ckIndex;
    const db = await openGameCkDb();
    if (!db) { _ckIndex = false; return false; }
    try {
        const idx = new Map();
        for (const r of db.prepare('select ck, uids from MysUsers').all()) {
            if (!r.ck) continue;
            let uids;
            try { uids = JSON.parse(r.uids || '{}'); } catch { continue; }
            // uids._meta 形如 { bh3: { '216762582': { region: 'pc01', ... } } }，
            // 崩三的区服每个角色各不相同（安卓/iOS/PC/B站），拿不到就会按 uid
            // 首位推成原神那套 cn_gf01，查不到人。存的时候一并带上。
            const meta = (uids._meta && typeof uids._meta === 'object') ? uids._meta : {};
            for (const [game, list] of Object.entries(uids)) {
                if (!Array.isArray(list)) continue;
                if (!idx.has(game)) idx.set(game, new Map());
                const m = idx.get(game);
                // 同一个 uid 理论上只属于一个 ltuid；真撞上了先记着的赢
                for (const uid of list) {
                    const key = String(uid);
                    if (m.has(key)) continue;
                    const info = meta[game]?.[key];
                    m.set(key, {
                        ck: normalizeCk(String(r.ck)),
                        region: (info && typeof info === 'object' && info.region) ? String(info.region) : '',
                    });                }
            }
        }
        _ckIndex = idx;
        return idx;
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 游戏签到 CK 索引失败: ${err.message}`);
        _ckIndex = false;
        return false;
    }
}

/**
 * 某个游戏 uid 该用的 CK。
 *
 * 优先用 stoken 现场换一份：cookie_token 与 ltoken 都能从 stoken 换出来，
 * 实测即使 genshin 库里那份已经过期（17 条里有 6 条），换一份照样能过
 * act.mihoyo.com —— 所以不能直接信库里的缓存。
 * 没有 stoken 时（uid 来自 genshin 的 NoteUser）才退回按 uid 从库里取。
 */
async function ckForGameUid(e, game, uid, fallback, entry = null) {
    if (entry?.stuid && entry?.stoken) {
        const built = await ensureCookieToken(e, xiaoyaoCk(entry), entry);
        // 换齐了才算数：游戏签到要 ltoken 与 cookie_token 同时在
        if (/cookie_token=/.test(built) && /ltoken=/.test(built)) return built;
    }
    // 先看 xhh 自己那份 stoken —— 有些账号只在 data/Stoken 里绑过，逍遥那边没有条目，
    // 而库里缓存的 ck 可能早就过期了（genshin 那边 17 条实测有 6 条失效）。
    const own = getStokenEntry(e?.user_id, String(uid));
    if (own?.stuid && own?.stoken) {
        const built = await ensureCookieToken(e, xiaoyaoCk(own), own);
        if (/cookie_token=/.test(built) && /ltoken=/.test(built)) return built;
    }
    const idx = await gameCkIndex();
    // 库里可能只有一具通行证、两边都没有 stoken 可换，只能用这份缓存。
    // 先假定它能用，别在这里就发请求验活 —— 一轮几十个号挨个验会把请求量翻倍，
    // 实测这样会触发米游社 WAF 拦截（返回 HTML 阻断页，整片接口全挂）。
    // 真签不动的时候再回头验（见 markCkIfDead），结论落盘，之后直接跳过。
    const hit = idx && idx.get(game)?.get(String(uid));
    if (hit?.ck) return hit.ck;
    return normalizeCk(fallback);
}

// ── ck 有效性：按需验 + 结论落盘 ──────────────────────────────
// 为什么不一上来就全验一遍：验活本身也是打米游社的接口，一轮签到几十个号
// 挨个验等于把请求量翻倍。实测（18:44）这样直接把 api-takumi 整个域名
// 触发 WAF 拦截，返回 HTML 阻断页，签到从 51/59 掉到 41/59。
//
// 所以改成：先用着，等它真的报错了才验一次；验明失效就写进 data/ck_state.json，
// 之后每轮开局直接跳过，一个请求都不多发。有效的也记一笔，同样省掉重复验。
const CK_STATE_PATH = './plugins/xhh/data/ck_state.json';
const CK_STATE_TTL = 24 * 60 * 60 * 1000; // 一天后重验，别把一次误判记成永久
let _ckState = null;

function loadCkState() {
    if (_ckState) return _ckState;
    _ckState = new Map();
    try {
        if (fs.existsSync(CK_STATE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(CK_STATE_PATH, 'utf8'));
            const now = Date.now();
            for (const [k, v] of Object.entries(raw || {})) {
                // 过期的直接不记，让它下轮重新验 —— 但绝不能顺手标成 false，
                // 那等于把一条过期结论当成永久失效，好凭证会被误杀。
                if (now - (Number(v?.t) || 0) < CK_STATE_TTL) _ckState.set(k, !!v.a);
            }
        }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 读 ck 状态失败，按全空处理: ${err.message}`);
        _ckState = new Map();
    }
    return _ckState;
}

function saveCkState() {
    if (!_ckState) return;
    try {
        const now = Date.now();
        const out = {};
        for (const [k, v] of _ckState) out[k] = { a: v, t: now };
        fs.mkdirSync('./plugins/xhh/data', { recursive: true });
        fs.writeFileSync(CK_STATE_PATH, JSON.stringify(out, null, 2));
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 写 ck 状态失败: ${err.message}`);
    }
}

/** 用 ck 本身当键（含 cookie_token，各自不同）；脱敏后写进日志也不泄露 */
function ckKey(ck) {
    const m = parseCookie(ck);
    return `${m.ltuid || m.account_id || '?'}:${(m.cookie_token || '').slice(-8)}`;
}

/** 之前验过的结论：true 有效 / false 失效 / undefined 还没验过 */
function knownCkAlive(ck) {
    if (!ck || !/cookie_token=/.test(ck)) return false;
    return loadCkState().get(ckKey(ck));
}

/**
 * 只用 getUserGameRolesByCookie —— 它只认 Cookie、不需要 DS，
 * 是目前唯一能可靠区分有效/失效的探针（米游社其它接口要配 DS 才准）。
 */
async function probeCkAlive(ck) {
    const headers = mhy.getHeaders({}, ck);
    delete headers['x-rpc-signgame'];
    const res = await mhyFetch(
        'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn',
        { method: 'GET', headers }
    ).then(r => r.json());
    return res?.retcode === 0 && Array.isArray(res?.data?.list) && res.data.list.length > 0;
}

/**
 * 某个 ck 签到失败了才调它：验明确实过期就把结论记下来，
 * 下一轮直接跳过，别再拿一份必然失败的凭证去请求、也别再撑大分母。
 * 验不出来（网络问题/被风控）就当有效 —— 宁可多报一次错，不能误杀好凭证。
 */
async function markCkIfDead(ck, game) {
    if (!ck || !/cookie_token=/.test(ck)) return false;
    const key = ckKey(ck);
    const known = loadCkState().get(key);
    if (known !== undefined) return !known;
    let alive;
    try {
        alive = await probeCkAlive(ck);
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] ck 验活失败，按有效处理: ${err.message}`);
        return true;
    }
    _ckState.set(key, alive);
    saveCkState();
    if (!alive && config().debug) {
        logger.mark(`[xhh][sign] ${game} 的这份 ck 已确认过期，记下来以后跳过`);
    }
    return alive;
}

/** 库里那条记录的区服；崩三要靠它，别的游戏拿不到就返回空 */
async function ckRegionForGameUid(game, uid) {
    const idx = await gameCkIndex();
    const hit = idx && idx.get(game)?.get(String(uid));
    if (hit?.region) return hit.region;
    // 有些记录没写 _meta（实测 17 条里有 4 条），崩三就查不到人了。
    // 那个接口只认 Cookie、不需要 DS，正好拿来把区服补出来；结果缓存起来别反复问。
    if (game === 'bh3' && hit?.ck) return queryRegionByCk(hit.ck, game, String(uid));
    return '';
}

const _regionCache = new Map();

/** 用 ck 问米游社这个 uid 在哪个区服；查不到返回空 */
async function queryRegionByCk(ck, game, uid) {
    const cacheKey = `${game}/${uid}`;
    if (_regionCache.has(cacheKey)) return _regionCache.get(cacheKey);
    const BIZ = { gs: 'hk4e_cn', sr: 'hkrpg_cn', zzz: 'zzz_cn', bh3: 'bh3_cn' };
    if (!BIZ[game]) return '';
    let region = '';
    try {
        const headers = mhy.getHeaders({}, ck);
        delete headers['x-rpc-signgame'];
        const res = await mhyFetch(
            `https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=${BIZ[game]}`,
            { method: 'GET', headers }
        ).then(r => r.json());
        const list = res?.data?.list;
        if (Array.isArray(list)) {
            const hit = list.find(it => String(it?.game_uid ?? '') === String(uid));
            if (hit?.region) region = String(hit.region);
        }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][sign] 查区服失败 ${cacheKey}: ${err.message}`);
    }
    _regionCache.set(cacheKey, region);
    return region;
}

// ─────────── genshin 插件（plugins/genshin）里的 CK ───────────
// 那边用 SQLite 存 CK，表 MysUsers(ltuid, ck, uids)，没有 QQ 归属，
// 所以只能当「一批匿名通行证」用：能签到、能体检，但没法归到某个 QQ 名下。
const GENSHIN_DB = './data/db/data.db';

/** 读 genshin 的 CK 列表；插件没装 / 表不存在 / 没装 sqlite 都当没有，不抛 */
async function getGenshinCks() {
    try {
        if (!fs.existsSync(GENSHIN_DB)) return [];
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(GENSHIN_DB, { readOnly: true });
        try {
            const rows = db.prepare(
                "select ltuid, ck, uids from MysUsers where ck is not null and ck != ''"
            ).all();
            return rows.map(r => ({
                ltuid: String(r.ltuid || ''),
                ck: String(r.ck || ''),
                uids: (() => { try { return JSON.parse(r.uids || '{}'); } catch { return {}; } })(),
            })).filter(r => r.ltuid && /cookie_token=/.test(r.ck));
        } finally { db.close(); }
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][genshin_ck] 读取失败: ${err.message}`);
        return [];
    }
}

/**
 * 探 CK 是否还有效。用 genshin 的 checkCk 同一个接口：
 * getUserGameRolesByCookie 只认 Cookie、不需要 DS，是目前唯一能可靠区分的探针
 * （getCookieAccountInfoBySToken 与 getUserMissionsState 对当天签到成功的号也回 -100）。
 * 缺 cookie_token 的不探 —— 那种 ck 探出来的 -100 是假的。
 */
async function probeCk(ck) {
    if (!ck || !/cookie_token=/.test(ck)) return { state: 'unknown', retcode: null };
    try {
        const res = await mhyFetch(
            'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hk4e_cn',
            { method: 'GET', headers: { Cookie: ck } }
        ).then(r => r.json());
        const rc = Number(res?.retcode);
        if (rc === 0) return { state: 'ok', retcode: 0, roles: ((res?.data?.list) || []).length };
        if ([-100, -101, 10001].includes(rc)) return { state: 'invalid', retcode: rc };
        return { state: 'unknown', retcode: rc, message: String(res?.message || '').slice(0, 40) };
    } catch (err) {
        return { state: 'unknown', retcode: null, message: err.message };
    }
}

/**
 * 记下被判失效的通行证，供「#清理无效绑定」删除条目用。
 * 只认签到接口真实返回的 -100/-101/10001，不另造探针 ——
 * 试过 getCookieAccountInfoBySToken 和 getUserMissionsState，两者对当天签到成功的
 * 账号也一律回 -100（前者缺 cookie_token、后者认设备指纹），拿它们的返回值当判据
 * 会把全部绑定误删。这里只在真签到结论上下手。
 */
const INVALID_FILE = './plugins/xhh/data/invalid_stuid.json';
function markInvalid(account, rows) {
    if (!rows.some(r => /登录失效/.test(r.tip || ''))) return;
    const stuid = String(account?.stuid || '');
    if (!/^\d{5,}$/.test(stuid)) return;
    try {
        const old = fs.existsSync(INVALID_FILE) ? JSON.parse(fs.readFileSync(INVALID_FILE, 'utf8')) : {};
        old[stuid] = { last: new Date().toISOString().slice(0, 19).replace('T', ' ') };
        fs.writeFileSync(INVALID_FILE, JSON.stringify(old, null, 2));
    } catch (err) {
        logger.error(`[xhh][bbs_sign] 记录失效通行证失败: ${err.message}`);
    }
}

async function bbsSignCore(e, accounts, title) {
    const lines = [title];
    const msgs = [];
    for (const account of accounts) {
        lines.push(`\n通行证 ${maskStuid(account.stuid)}`);
        const rows = [];
        if (await bbsSignedToday(e, account)) {
            for (const forum of BBS_FORUMS) {
                lines.push(`${forum.name}：今日已签`);
                rows.push({ name: forum.name, tip: '今日已签' });
            }
            markInvalid(account, rows);
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
        await finishBbsAccount(e, account, ctx, rows, lines);
        markInvalid(account, rows);
        msgs.push(bbsCardItem(account, rows));
    }
    return { msgs, lines };
}

/**
 * 给「一批没有 QQ 归属的裸 CK」签社区。
 * genshin 插件的 CK 就是这种 —— 只有 ltuid 与 cookie，没法归到某个 QQ，
 * 但社区签到只认 cookie，够用了。
 */
async function bbsSignCks(e, cks) {
    const accounts = (cks || []).map(c => ({
        stuid: String(c.ltuid || ''),
        ck: c.ck,
        stoken: (String(c.ck).match(/stoken=([^;]+)/) || [])[1] || '',
        ltoken: (String(c.ck).match(/ltoken=([^;]+)/) || [])[1] || '',
        mid: '',
        device_id: stableDeviceId(String(c.ltuid || '')),
    })).filter(a2 => a2.stuid && /cookie_token=/.test(a2.ck));
    return bbsSignCore(e, accounts, '米游社社区签到（genshin 侧 CK）');
}

async function bbsSignForEvent(e, all = false) {
    const accounts = getBbsAccounts(e);
    if (!accounts.length) return { msgs: [], lines: [`米游社社区${all ? '全部' : ''}签到`, '未找到米游社SToken，请先扫码绑定'] };
    const { msgs, lines } = await bbsSignCore(e, accounts, `米游社社区${all ? '全部' : ''}签到`);
    return { msgs, lines };
}

async function BbsSign(e) {
    const all = /全部/.test(e.msg || '');
    // 社区签到必须用 Stoken 文件里的 stoken（米游社 bbs-api 认 stoken，getMysUser 只有 ltoken 无法签社区）
    const accounts = getBbsAccounts(e);
    if (!accounts.length) {
        const mys = e.user.getMysUser('gs');
        if (!mys) return e.reply('未绑定米游社,请发送[扫码绑定]', true, { recallMsg: 60 });
        accounts.push({ stuid: '', ck: mys.ck, device_id: stableDeviceId(mys.ck || e.user_id) });
        if (!/stoken=/.test(mys.ck || '')) await e.reply('未找到米游社SToken(社区签到只认stoken)，请先[小花火扫码登录]绑定', true, { recallMsg: 60 });
    }
    const { msgs, lines } = await bbsSignCore(e, accounts, `米游社社区${all ? '全部' : ''}签到`);
    return replyBbsResultImage(e, msgs, lines);
}

async function BbsAutoSign(qqs = [], group = 0) {
    const allMsgs = [];
    const allLines = ['米游社社区自动签到'];
    const users = [...new Set((qqs || []).map(v => String(v).trim()).filter(Boolean))];
    for (const qq of users) {
        const e = {
            user_id: qq,
            msg: '社区签到',
            isGroup: !!group,
            group_id: group,
            sender: { nickname: String(qq) },
            reply: async () => false,
        };
        // 只有逍遥侧数据的人，顺手把 xhh 文件补出来（不需要扫码）
        await mhy.ensureXhhFromXiaoyao(e);
        const { msgs, lines } = await bbsSignForEvent(e, false);
        allLines.push(`\nQQ ${qq}`);
        allLines.push(...lines.slice(1));
        allMsgs.push(...msgs.map(m => ({ ...m, title: `QQ ${qq} · ${m.title}` })));
        await jitter(2000, 4000);
    }
    return { msgs: allMsgs, lines: allLines };
}

/** 相邻标题与提示都相同的卡合成一张（同一通行证重复出现时用） */
function collapseMsgs(msgs) {
    const out = [];
    for (const m of msgs || []) {
        const cur = { ...m };
        const prev = out[out.length - 1];
        if (prev && prev.title === cur.title && prev.tip === cur.tip) continue;
        out.push(cur);
    }
    return out;
}

/**
 * 发社区自动签到结果。img 由调用方渲染好传进来 —— 定时任务里没有 e，
 * 而 #xhh 导出的 render 强依赖 e.runtime，只能走 apps/sign.js 里的本地包装。
 */
async function sendBbsAutoResult(group, result, img) {
    const { lines = [] } = result || {};
    if (!group) return false;
    const target = Bot.pickGroup(Number(group));
    if (img) return await target.sendMsg(img);
    return target.sendMsg(lines.join('\n') || '米游社社区自动签到完成');
}

// 结果汇总：全失败时给出可操作的排查提示，不再 60s 就把消息撤掉
function bbsResultTips(lines) {
    const body = lines.slice(1);
    const tips = [];
    if (body.some(l => /遇到验证码/.test(l))) {
        tips.push('提示：触发米游社验证码，已优先尝试本地自动过码；若仍失败，请确认 127.0.0.1:2149 过码服务已启动，或按群内链接完成手动验证');
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
    const failed = rows.filter(r => !/签到成功|今日已签/.test(r.tip));
    let tip;
    if (!failed.length) {
        tip = rows.every(r => /今日已签/.test(r.tip)) ? '今日已签' : '签到成功';
    } else {
        const okCount = rows.length - failed.length;
        // ck 一失效时 7 个版块报同一句，直接拼出来会重复 7 遍刷屏。
        // 按 tip 分组：全部同一种就收成「N 个版块均为 …」，否则「原神、崩三」这样并起来。
        const byTip = {};
        for (const r of failed) (byTip[r.tip] = byTip[r.tip] || []).push(r.name);
        const tail = Object.entries(byTip).map(([t, names]) => names.length === failed.length
            ? `${names.length} 个版块均为 ${t}`
            : `${names.join('、')}${t}`).join('  ');
        tip = `${okCount}/${rows.length} 完成 · ${tail}`;
    }
    return {
        title: `通行证 ${maskStuid(account.stuid)}`,
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
            // 社区签到用小花火立绘头像；游戏签到不传此字段，模板回退到 QQ 头像
            xhhAvatar: true,
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
        // 收集失败原因。注意 api() 对签到类请求（type 含 'sign'）是「return 错误字符串」
        // 并不走 e.reply，所以光挂一个收集用的 e.reply 什么都收不到 ——
        // 真正的原因在 zd_MysSign 里拿到的那两个返回值上，这里只兜住其余分支。
        const diag = [];
        let e = {};
        e.user_id = qq;
        // 只有逍遥侧数据的人，顺手把 xhh 文件补出来（不需要扫码）
        await mhy.ensureXhhFromXiaoyao(e);
        e.reply = async msg => {
            if (msg === undefined || msg === null) return false;
            const text = Array.isArray(msg) ? msg.join(' ') : String(msg);
            diag.push(text.slice(0, 200));
            return false;
        };
        for (let game of games) {
            let user = (await NoteUser.create(qq)).getMysUser(game); //只要当前xx游戏绑定ck的账号信息（原神可能有多个，如渠道服）
            // 逍遥插件在该游戏下也有账号时一并处理，别因为 xhh 侧没绑就整个游戏跳过
            const xiaoyaoForGame = getXiaoyaoEntries(qq).filter(v => v.game === game && v.uid);
            if (!user && !xiaoyaoForGame.length) continue;
            // 部分账号只绑定了 CK，但没有该游戏的 UID；
            // 直接读取 uids[game].length 会导致自动签到任务整体中断。
            const uids = user && Array.isArray(user.uids?.[game]) ? user.uids[game] : [];
            // 逐个 uid 去 genshin 的库里找对应的 ck。NoteUser 给的那份可能是
            // false（见上面 getCkUid 的说明），逍遥兜底那份又只有 stuid/stoken，
            // 两者都过不了 act.mihoyo.com。
            const targets = [];
            for (const uid of uids) {
                targets.push({
                    uid,
                    ck: await ckForGameUid(e, game, uid, user?.ck),
                    server: await ckRegionForGameUid(game, uid) || null,
                });
            }
            // 同 uid 两边都有只签一次，免得重复请求把风控打上去。
            // 已经收进来的同一个 uid：优先用逍遥这份带 stoken 的（能现场换出凭证），
            // 并把它的 region 带上 —— 崩三的 region 是 android01/pc01/bb01 这类，
            // 拿不到就回落到 getServer 按 uid 首位推，会推成原神那套 cn_gf01 而查不到。
            for (const v of xiaoyaoForGame) {
                const hit = targets.find(t => String(t.uid) === v.uid);
                if (hit) {
                    if (v.stuid && v.stoken) {
                        const rebuilt = await ckForGameUid(e, game, v.uid, xiaoyaoCk(v), v);
                        if (/cookie_token=/.test(rebuilt) && /ltoken=/.test(rebuilt)) {
                            hit.ck = rebuilt;
                            if (v.region) hit.server = v.region;
                        }
                    }
                    continue;
                }
                targets.push({ uid: v.uid, ck: await ckForGameUid(e, game, v.uid, xiaoyaoCk(v), v), server: v.region || null });
            }
            // 已经验明过期的凭证直接跳过，一个请求都不发 —— 那些号是在别的插件里
            // 只绑了游戏 uid、没在本插件留凭证的，凭证过期后每次签到都白报一遍错，
            // 还把「成功 x/y」的分母撑大。没验过的先留着，真签不动时再验。
            const usable = targets.filter(
                t => t.ck && /cookie_token=/.test(t.ck) && knownCkAlive(t.ck) !== false
            );
            const dropped = targets.length - usable.length;
            if (dropped && config().debug) {
                logger.mark(`[xhh][sign] ${qq} ${game} 跳过 ${dropped} 个已确认凭证失效的账号`);
            }
            for (let i = 0; i < usable.length; i++) {
                z_num++;
                const { uid, ck, server } = usable[i];
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
                    diag.push(`[${game}/${uid.slice(-4)} 查询] ${res}`);
                    // 这次请求已经打过了，才验一次是死是活：验明过期就记进
                    // data/ck_state.json，下一轮开局直接跳过这个号。
                    await markCkIfDead(ck, game);
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
                        // 同一 QQ 可能有的账号成功、有的失败。只要有一项失败就该留在失败列表；
                        // 原来这里不看 sbai_qqs，会把已拉黑的 QQ 又塞回成功段，
                        // 结果一张卡里同一个 QQ 同时出现在成功和失败两段。
                        if (!cg_qqs.includes(qq) && !sbai_qqs.includes(qq)) {
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
                            if (!cg_qqs.includes(qq) && !sbai_qqs.includes(qq)) {
                                cg_qqs.push(qq);
                            }
                            num++;
                            continue;
                        }
                        //签到失败
                        else if (typeof sign_res == 'string') {
                            diag.push(`[${game}/${uid.slice(-4)} 签到] ${sign_res}`);
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
        if (sbai_qqs.includes(qq) && config().debug) {
            // 失败原因只在 debug 下打：内容来自米游社，逐账号会很多
            logger.mark(`[xhh][sign] 游戏签到失败 qq=${qq} ${diag.length ? [...new Set(diag)].slice(0, 4).join(' | ').slice(0, 400) : '（没拿到原因）'}`);
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
    collapseMsgs,
    gameOfEntry,
    getGenshinCks,
    probeCk,
    bbsSignCks,
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
    ttocrPoints,
};
