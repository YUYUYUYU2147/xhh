/**
 * 统一取玩家资料（头像 + 昵称 + 服务器名）
 *
 * 为什么要有这个模块：
 * 崩三水晶统计（apps/bh3_ledger.js）一直靠 index 接口拿头像，
 * 但原石/星琼/菲林账本（apps/currency_ledger.js）没走这套 —— 账本接口
 * （ys_ledger / srledger / nap_ledger）自己根本不返回头像：
 *   原神  data 顶层有 nickname，没有头像字段
 *   星铁  既没有 nickname 也没有头像
 *   绝区零 data.role_info.{nickname,avatar} 都有
 * 所以同一个插件里两套取头像的逻辑，用户看到的就是「水晶统计有头像、
 * 账本没有」。这里把四个游戏统一到同一套。
 *
 * 为什么走 MysInfo.get 而不是自己 fetch：
 * index 接口对 device_fp 敏感，缺了会返回 -10001 invalid request。
 * genshin 插件的 getData() 会自动补 getFp，而且 URL / DS / 各游戏的 hostRecord
 * 都在它自己的 apiTool 里维护好了 —— 自己拼很容易漏头（第一版就是这么翻车的，
 * 星铁报「米游社接口异常」）。MysInfo.get 不校验 auth 名单，
 * 'index' 虽然不在 auth 数组里但能正常调用。
 *
 * 四个游戏的 index 路径（取自 genshin/model/mys/apiTool.js）：
 *   崩三    game_record/appv2/honkai3rd/api/index
 *   原神    game_record/app/genshin/api/index
 *   星铁    game_record/app/hkrpg/api/index
 *   绝区零  event/game_record_zzz/api/zzz/index
 */

import MysInfo from '../../genshin/model/mys/mysInfo.js';
import { api, mhy } from '#xhh';

// 服务器代码 → 中文名
const SERVER_CN = {
    cn_gf01: '国服', cn_qd01: 'B服', prod_gf_cn: '国服', prod_qd_cn: 'B服',
    os_usa: '美服', os_asia: '亚服', os_euro: '欧服', os_cht: '港澳台服',
    android01: '安卓官服', ios01: 'iOS服',
    prod_gf_us: '美服', prod_gf_eu: '欧服', prod_gf_jp: '日服', prod_gf_sg: '新加坡服',
    prod_official_usa: '国际服', prod_official_asia: '亚服',
    prod_official_eur: '欧服', prod_official_euro: '欧服', prod_official_cht: '港澳台服',
};

/** 服务器代码转中文，认不出来就原样返回 */
export function serverName(code) {
    const key = String(code || '').trim();
    if (!key) return '';
    if (SERVER_CN[key]) return SERVER_CN[key];
    const guess = key.match(/^(?:prod_(?:gf|official)_|os_)([a-z]{2,4})$/)?.[1];
    if (guess && SERVER_CN[`os_${guess}`]) return SERVER_CN[`os_${guess}`];
    return key;
}

// 各版本 index 接口把头像放在不同字段名里，这些是实测出现过的
const FACE_KEYS = [
    'game_head_icon', 'game_head', 'AvatarUrl', 'avatarUrl', 'cur_head_icon_url',
    'head_icon', 'headIcon', 'avatar_url', 'avatar_icon', 'avatar', 'icon_url',
    'icon_path', 'role_square_url', 'hollow_icon_path', 'group_icon_path',
];

/** 在对象里找头像字段；recursive=true 时往下找一层数组/对象 */
function findFaceUrl(data, recursive = true) {
    if (!data || typeof data !== 'object') return '';
    for (const key of FACE_KEYS) {
        const val = data[key];
        if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    if (!recursive) return '';
    // 原神/星铁的 index 返回 data.avatars[] / data.avatar_list[]，
    // 优先取 is_chosen 的那个（玩家当前使用的头像）
    const chosen = data.avatars?.find?.(a => a?.is_chosen) || data.avatar_list?.find?.(a => a?.is_chosen);
    const fromChosen = findFaceUrl(chosen, false);
    if (fromChosen) return fromChosen;
    for (const list of [data.avatars, data.avatar_list, data.characters, data.avatar_info]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const hit = findFaceUrl(item, false);
            if (hit) return hit;
        }
    }
    const hit = findFaceUrl(data.role, false);
    if (hit) return hit;
    // 再兜一层：zzz 的 data.avatar_info 是对象
    if (data.avatar_info && typeof data.avatar_info === 'object') return findFaceUrl(data.avatar_info, false);
    return '';
}

/** 昵称：各游戏字段位置也不一样 */
function findNickname(d) {
    return String(
        d?.nickname || d?.nick_name || d?.role?.nickname ||
        d?.player_info?.nickname || d?.avatar_info?.nickname || ''
    ).trim();
}

/**
 * 取玩家资料
 *
 * @param {object} e 事件对象（会被临时改写 e.game，取完还原）
 * @param {string|number} uid 该游戏的 uid（必须是当前游戏自己的，不能混用）
 * @param {string} game gs | sr | zzz | bh3
 * @param {object} auth 取崩三资料时必填：{ headers, server }
 * @returns {Promise<{nickname:string, avatar:string, serverName:string, userLevel:number}>}
 */
export async function getRoleProfile(e, uid, game, auth = {}) {
    const out = { nickname: '', avatar: '', serverName: '', userLevel: 0 };
    if (!uid) return out;
    out.serverName = serverName(mhy.getServer(String(uid), game));
    // e.game 必须先设好：MysInfo.get 内部靠它选游戏和对应的 hostRecord
    const oldGame = e.game;
    e.game = game;
    try {
        let res;
        if (game === 'bh3') {
            // 崩三改走小花火自己的 api()。
            // genshin 的 MysApi 打 api-takumi-record 的 honkai3rd/index 会被米游社
            // 403，且那个域名没被 WAF 拦、响应体不是拦截页，代理兜底不会被触发。
            // 小花火的 api() 本就带 DS 签名并走 mhyFetch，
            // 且 api.js 里 bh3_index 与该URL 完全一致（bh3_abyss_boss 已在用）。
            res = auth.headers
                ? await api(e, {
                    type: 'bh3_index',
                    uid,
                    headers: auth.headers,
                    game: 'bh3',
                    server: auth.server || mhy.getServer(String(uid), 'bh3'),
                    silent: true,
                })
                : null;
        } else {
            res = await MysInfo.get(e, 'index', {}, { log: false, game });
        }
        if (!res || res.retcode !== 0 || !res.data) return out;
        const d = res.data;
        out.nickname = findNickname(d);
        out.avatar = findFaceUrl(d);
        out.userLevel = Number(d?.role?.level || d?.level || d?.player_info?.level || 0) || 0;
        // 接口回传的 region 比我们推算的更准（有B服/渠道服时推算不出来）
        const region = d.region || d.role?.region || '';
        if (region) out.serverName = serverName(region);

        // 星铁的 index 确实不带 nickname，但 avatar 藏在 avatar_info/avatars 里
        // （所以头像有、昵称空）。昵称要另外找 basicInfo。
        // 注意 basicInfo 这个 key 只对星铁安全：原神同名 key 指的是
        // game_record/app/genshin/api/gcg/basicInfo（七圣召唤），
        // 跟角色资料完全不相干，不能通用化。
        if (!out.nickname && game === 'sr') {
            const bi = await MysInfo.get(e, 'basicInfo', {}, { log: false, game });
            if (bi?.retcode === 0 && bi?.data) {
                out.nickname = findNickname(bi.data) || out.nickname;
                out.avatar = findFaceUrl(bi.data) || out.avatar;
                out.userLevel = Number(bi.data?.level || 0) || out.userLevel;
            }
        }
    } catch (err) {
        logger.debug?.('[xhh][资料] 获取玩家资料失败:', err?.message || err);
    } finally {
        e.game = oldGame;
    }
    return out;
}

export default { getRoleProfile, serverName };
