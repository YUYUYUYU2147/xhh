// B站直播间解析：从消息文本抽取房间号 → 拉房间信息 → 组装回复
// 直播间接口不需要登录，和视频解析（需 bili ck）互相独立

import fs from 'node:fs';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import common from '../../../lib/common/common.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' };
const LIVE_HOST = 'https://live.bilibili.com/';
const TEMP_DIR = './plugins/xhh/temp/bili_live/';

// live.bilibili.com/房间号 与 live.bilibili.com/h5/房间号
const LIVE_LINK_RE = /live\.bilibili\.com\/(?:h5\/)?(\d+)/g;
// 短链需要跟着跳转才能拿到真实地址
const SHORT_LINK_RE = /b23\.tv\/[A-Za-z0-9]+/g;

const STATUS_TEXT = ['未开播', '直播中', '轮播中'];

// 直播清晰度：B站直播间按 qn 取值，房间没开某档会自动降级到可用档
export const LIVE_QN = {
    10000: '原画',
    400: '蓝光',
    250: '超清',
    150: '高清',
    80: '流畅',
};

// 人气/粉丝数：过万显示 X.X万
function fmtNum(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v)) return '0';
    return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v);
}

async function getJson(url) {
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// 短链跟随跳转，返回最终 URL（失败返回空串）
async function resolveShort(url) {
    try {
        const res = await fetch(url, { headers: HEADERS, redirect: 'follow', timeout: 15000 });
        return res?.url || '';
    } catch (err) {
        return '';
    }
}

/**
 * 从一段文本里抽取直播间号
 * @param {string} text 消息原文/卡片跳转链接
 * @returns {Promise<string[]>} 房间号数组（去重，最多 2 个）
 */
export async function extractRooms(text) {
    const raw = String(text || '');
    const rooms = [];
    const seen = new Set();
    const push = id => {
        if (id && !seen.has(id)) {
            seen.add(id);
            rooms.push(id);
        }
    };

    for (const m of raw.matchAll(LIVE_LINK_RE)) push(m[1]);

    for (const m of raw.matchAll(SHORT_LINK_RE)) {
        const short = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
        const finalUrl = await resolveShort(short);
        if (!finalUrl) continue;
        const hit = finalUrl.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/);
        if (hit) push(hit[1]);
    }

    return rooms.slice(0, 2);
}

/**
 * 拉取直播间信息
 * @param {string|number} roomId 房间号（短号也可以）
 */
export async function roomInfo(roomId) {
    // 先 room_init 把短号（如 live.bilibili.com/6）换成真实房间号，
    // 老短号直接查 get_info 会返回「房间不存在」
    let realId = roomId;
    let init = null;
    try {
        init = await getJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`);
        if (init?.code === 0 && init.data?.room_id) realId = init.data.room_id;
    } catch (err) { }

    const json = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(realId)}`).catch(() => null);
    if (json?.code !== 0) {
        // get_info 拿不到时，用 room_init 的最小信息兜底
        if (init?.code === 0 && init.data?.room_id) {
            return {
                roomId: init.data.room_id,
                shortId: init.data.short_id || 0,
                uid: init.data.uid,
                title: '',
                area: '',
                parentArea: '',
                cover: '',
                online: 0,
                liveStatus: init.data.live_status ?? 0,
                liveTime: init.data.live_time || '',
            };
        }
        throw new Error(json?.message || init?.message || '直播间不存在');
    }
    const d = json.data || {};
    return {
        roomId: d.room_id || Number(roomId),
        shortId: d.short_id || 0,
        uid: d.uid,
        title: d.title || '',
        area: d.area_name || '',
        parentArea: d.parent_area_name || '',
        // keyframe 是直播封面，没开播时可能是空的，回退到主播封面
        cover: d.keyframe || d.user_cover || '',
        online: d.online ?? 0,
        liveStatus: d.live_status ?? 0,
        liveTime: d.live_time || '',
    };
}

// 主播信息：空间卡片接口优先，失败回退直播用户信息接口
async function anchorInfo(uid) {
    if (!uid) return { name: '', fans: 0 };
    try {
        const j = await getJson(`https://api.bilibili.com/x/web-interface/card?mid=${uid}&photo=false`);
        if (j?.code === 0) {
            return { name: j.data?.card?.name || '', fans: j.data?.follower ?? 0 };
        }
    } catch (err) { }
    // 空间卡片接口偶尔被风控，用直播的批量接口再拿一次主播昵称
    try {
        const j2 = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${uid}`);
        if (j2?.code === 0) {
            return { name: j2.data?.[uid]?.uname || '', fans: 0 };
        }
    } catch (err) { }
    return { name: '', fans: 0 };
}

// 封面：先下载到本地（部分协议端发外链图会失败），失败再直接发链接
async function coverSegment(url, roomId) {
    if (!url) return '';
    try {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
        const file = `${TEMP_DIR}${roomId}.jpg`;
        await common.downFile(url, file);
        return segment.image(file);
    } catch (err) {
        return segment.image(url);
    }
}

/**
 * 组装直播间回复消息
 * @returns {Promise<Array>} 可直接 e.reply 的消息数组
 */
export async function buildMsg(info) {
    const anchor = await anchorInfo(info.uid);
    const status = STATUS_TEXT[info.liveStatus] || '未知';
    const lines = [
        `【B站直播间】${info.liveStatus === 1 ? '🔴 ' : ''}${status}`,
        `标题：${info.title || '（无）'}`,
        `主播：${anchor.name || info.uid}${anchor.fans ? `　粉丝 ${fmtNum(anchor.fans)}` : ''}`,
        `分区：${[info.parentArea, info.area].filter(Boolean).join(' · ') || '未知'}`,
        `人气：${fmtNum(info.online)}`,
    ];
    if (info.liveStatus === 1 && info.liveTime) lines.push(`开播：${info.liveTime}`);
    lines.push(`链接：${LIVE_HOST}${info.roomId}`);

    const msg = [lines.join('\n')];
    const img = await coverSegment(info.cover, info.roomId);
    if (img) msg.push(img);
    return msg;
}

/* ---------------- 实时截屏 ---------------- */

// 抓一小段直播流（默认2秒，够拿一帧）再用 ffmpeg 取第一帧
export async function screenshot(roomId, opts = {}) {
    const { qn = 250, seconds = 2 } = opts;
    const rec = await recordLive(roomId, { seconds, qn, maxBytes: 10 * 1024 * 1024 });
    const imgPath = String(rec.path).replace(/\.flv$/i, '.jpg');

    const ok = () => fs.existsSync(imgPath) && fs.statSync(imgPath).size > 0;
    try {
        execSync(`ffmpeg -y -i "${rec.path}" -frames:v 1 -q:v 2 "${imgPath}"`, { stdio: 'ignore', timeout: 30000 });
        // 首帧偶尔是黑屏/只有metadata，往后挪一点再试一次
        if (!ok()) {
            execSync(`ffmpeg -y -i "${rec.path}" -ss 1 -frames:v 1 -q:v 2 "${imgPath}"`, { stdio: 'ignore', timeout: 30000 });
        }
    } catch (err) {
        fs.rmSync(rec.path, { force: true });
        fs.rmSync(imgPath, { force: true });
        throw new Error('截图失败：需要服务器安装 ffmpeg（b站视频下载也依赖它）');
    }
    fs.rmSync(rec.path, { force: true });
    if (!ok()) throw new Error('截图失败：ffmpeg 没输出图片，可能这段流里没有可解码的画面');

    return { path: imgPath, size: fs.statSync(imgPath).size };
}

/* ---------------- 发送弹幕 ---------------- */

// 直播间发弹幕：需要已登录的 b 站 ck（bili_jct 当 csrf）
export async function sendDanmaku(roomId, text, ck) {
    const jct = String(ck || '').match(/bili_jct=([\w-]+)/)?.[1] || '';
    if (!jct) throw new Error('ck 里没有 bili_jct，请重新登录B站');

    const form = {
        bubble: 0,
        msg: text,
        color: 16777215, // 白色
        mode: 1, // 滚动
        roomid: roomId,
        fontsize: 25,
        rnd: Date.now(),
        csrf: jct,
        csrf_token: jct,
    };
    const body = Object.entries(form)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    const res = await fetch('https://api.live.bilibili.com/msg/send', {
        method: 'POST',
        headers: {
            ...HEADERS,
            Referer: `${LIVE_HOST}${roomId}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: ck,
            Origin: 'https://live.bilibili.com',
        },
        body,
        timeout: 15000,
    });
    const data = await res.json().catch(() => ({ code: -1, message: '接口返回异常' }));

    const tips = {
        '-101': 'B站ck已失效，请重新「小花火b站登录」',
        '-102': 'B站账号被封停了',
        '-111': 'csrf 校验失败，请重新登录B站',
        '-400': '弹幕内容不合法或超长（直播间弹幕最多20字）',
        '-403': '没权限发这条弹幕（可能被禁言 / 未实名 / 等级不足）',
        '-500': 'B站接口开小差了，稍后再试',
    };
    if (data?.code !== 0) {
        throw new Error(tips[String(data?.code)] || data?.message || `发送失败(code ${data?.code})`);
    }
    return true;
}

/* ---------------- 直播录制 ---------------- */

// 取直播流地址（flv）。房间没开播时会拿不到
export async function playUrl(roomId, qn = 250) {
    const j = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/playUrl/playUrl?cid=${encodeURIComponent(roomId)}&qn=${encodeURIComponent(qn)}&platform=web&ptype=8`);
    if (j?.code !== 0) throw new Error(j?.message || '未获取到直播流');
    return {
        url: String(j?.data?.durl?.[0]?.url || ''),
        qn: j?.data?.current_qn ?? qn,
    };
}

/**
 * 录制直播片段：连上 flv 流，录满 seconds 秒或写满 maxBytes 字节就断开
 * @returns {Promise<{path:string, size:number, qn:number}>}
 */
export async function recordLive(roomId, opts = {}) {
    const { seconds = 60, qn = 250, maxBytes = 0 } = opts;
    const { url, qn: realQn } = await playUrl(roomId, qn);
    if (!url) throw new Error('没拿到直播流地址，可能刚下播');

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const rawPath = `${TEMP_DIR}live_${roomId}_${Date.now()}.flv`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, seconds) * 1000);
    const res = await fetch(url, { headers: { ...HEADERS, Referer: LIVE_HOST }, signal: controller.signal });
    if (!res?.ok) {
        clearTimeout(timer);
        throw new Error(`直播流 HTTP ${res?.status}`);
    }

    const out = fs.createWriteStream(rawPath);
    let bytes = 0;
    try {
        const body = res.body;
        if (body && typeof body[Symbol.asyncIterator] === 'function') {
            for await (const chunk of body) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                out.write(buf);
                bytes += buf.length;
                if (maxBytes && bytes >= maxBytes) break;
            }
        } else if (body?.pipe) {
            // node-fetch v2 的 body 是 Node 流
            await new Promise((resolve, reject) => {
                body.on('data', c => {
                    bytes += c.length;
                    if (maxBytes && bytes >= maxBytes) body.destroy();
                });
                body.pipe(out);
                body.on('end', resolve);
                body.on('close', resolve);
                body.on('error', reject);
            });
            bytes = fs.existsSync(rawPath) ? fs.statSync(rawPath).size : 0;
        } else {
            const buf = Buffer.from(await res.arrayBuffer());
            out.write(buf);
            bytes = buf.length;
        }
    } catch (err) {
        // AbortError = 录满时间主动断开，属于正常结束
        if (err?.name !== 'AbortError' && err?.type !== 'aborted') throw err;
    } finally {
        clearTimeout(timer);
        await new Promise(r => out.end(r));
    }

    if (!bytes) {
        fs.rmSync(rawPath, { force: true });
        throw new Error('没录到数据，可能已下播或流被掐断');
    }
    return { path: rawPath, size: bytes, qn: realQn };
}

// flv 转 mp4（只换容器不重编码，很快）；没装 ffmpeg 就退回原 flv
export function toMp4(rawPath) {
    const mp4Path = String(rawPath).replace(/\.flv$/i, '.mp4');
    try {
        execSync(`ffmpeg -y -i "${rawPath}" -c copy -movflags +faststart -f mp4 "${mp4Path}"`, { stdio: 'ignore' });
        if (fs.existsSync(mp4Path) && fs.statSync(mp4Path).size > 0) return mp4Path;
    } catch (err) {
        // 没装 ffmpeg 或转封装失败：直接发 flv
    }
    return rawPath;
}

// 清掉超过 24 小时的录制文件，避免 temp 越堆越大
export function cleanTemp() {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const now = Date.now();
        for (const f of fs.readdirSync(TEMP_DIR)) {
            const p = TEMP_DIR + f;
            try {
                if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { force: true });
            } catch (_) { }
        }
    } catch (_) { }
}

export default {
    LIVE_QN,
    extractRooms,
    roomInfo,
    buildMsg,
    screenshot,
    sendDanmaku,
    playUrl,
    recordLive,
    toMp4,
    cleanTemp,
};
