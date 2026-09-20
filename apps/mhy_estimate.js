import fetch from 'node-fetch';
import { makeForwardMsg, config, pluginPriority } from '#xhh';
import fs from 'fs';
import {
  getCurrentZzzDefenseInfoByEvent,
  getCurrentZzzDeadlyInfoByEvent,
  formatCurrentZzzDefenseInfo,
  formatCurrentZzzDeadlyInfo,
} from '../system/zzz_challenge_info.js';

async function loadBh3BossModule() {
  const modulePath = './plugins/xhh/system/bh3_abyss_boss.js';
  const version = fs.existsSync(modulePath) ? fs.statSync(modulePath).mtimeMs : Date.now();
  return await import(`../system/bh3_abyss_boss.js?v=${version}`);
}

const SEARCH_API = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list';
const GLOBAL_SEARCH_API = 'https://bbs-api.miyoushe.com/post/wapi/searchPosts';
const POST_FULL_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';
const GAME_GIDS = { abyss: 1, battlefield: 1, godwar: 1, zzz_defense: 8, zzz_deadly: 8 };
// 攻略视频直发：超过该大小的视频不下载，回退封面+链接
const VOD_TEMP_DIR = './plugins/xhh/temp/mys_vod/';
const VOD_MAX_SIZE = 50 * 1024 * 1024;

function pickGame(msg) {
  if (/原神|原石|gs/i.test(msg)) return 'gs';
  if (/星铁|星琼|sr/i.test(msg)) return 'sr';
  if (/(绝区零|绝区|ZZZ|zzz).*(式舆防卫战|式舆|防卫战|防卫|深渊)|^(#)?(式舆防卫战|式舆|防卫战|防卫)/i.test(msg)) return 'zzz_defense';
  if (/(绝区零|绝区|ZZZ|zzz).*(危局强袭战|危局|强袭战)|^(#)?(危局强袭战|危局)/i.test(msg)) return 'zzz_deadly';
  if (/绝区零|绝区|菲林|邦布券|邦布|zzz/i.test(msg)) return 'zzz';
  if (/崩坏三|崩三|水晶|bbb|bh3|！|前瞻/i.test(msg)) return 'bh3';
  if (/超弦|超炫|深渊/i.test(msg)) return 'abyss';
  if (/战场|记忆战场/i.test(msg)) return 'battlefield';
  if (/乐土|往世乐土/i.test(msg)) return 'godwar';
  if (/强袭|强袭战/i.test(msg)) return 'assault';
  return 'gs';
}

const presets = {
  gs: {
    name: '原神', tip: '原石统计获取中，请稍后...', none: '原神资源统计',
    custom: ['https://gitee.com/mingdiandianzhu/miaoresources/raw/master/predict/gs.jpg', '图片内作者'],
    args: [['原石资源统计', 285802042, [1], 'HoYo青枫']],
  },
  sr: {
    name: '崩坏：星穹铁道', tip: '星琼统计获取中，请稍后...', none: '星铁资源统计',
    custom: ['https://gitee.com/mingdiandianzhu/miaoresources/raw/master/predict/sr.jpg', '图片内作者'],
    args: [['星琼统计汇总', 137101761, [3], '祈鸢ya'], ['星琼资源统计', 285802042, [1], 'HoYo青枫']],
  },
  zzz: {
    name: '绝区零', tip: '菲林统计获取中，请稍后...', none: '绝区零资源统计',
    args: [['版本菲林汇总', 74642625, [0,1,2,3,4,5], '冰是真的菜QAQ'], ['菲林资源统计', 285802042, [0,1,2,3,4,5], 'HoYo青枫']],
  },
  zzz_defense: {
    name: '式舆防卫战', tip: '防卫战攻略获取中，请稍后...', none: '式舆防卫战攻略',
    args: [['式舆防卫战', 4068738, [0,1,2,3,4,5,6,7,8,9], '洗礼酱'], ['防卫战攻略', 285802042, [0,1,2,3,4,5], 'HoYo青枫']],
  },
  zzz_deadly: {
    name: '危局强袭战', tip: '危局强袭战攻略获取中，请稍后...', none: '危局强袭战攻略',
    args: [['危局强袭战', 4068738, [0,1,2,3,4,5,6,7,8,9], '洗礼酱'], ['危局攻略', 285802042, [0,1,2,3,4,5], 'HoYo青枫']],
  },
  bh3: {
    name: '崩坏3', tip: '水晶统计获取中，请稍后...', none: '崩坏3水晶统计',
    args: [['水晶统计', 80216695, [0,1], '五香麻辣小兔头']],
  },
  abyss: {
    name: '超弦空间', tip: '深渊攻略/速报获取中，请稍后...', none: '深渊攻略',
    args: [['红莲', 30269990, [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15], '朔守'], ['寂灭', 30269990, [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15], '朔守'], ['寂灭', 11956740, [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15], '残月'], ['红莲', 11956740, [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15], '残月'], ['红莲', 15491760, [0,1,3,4,5,6,7,8,9,10,11,12,13,14,15], '墨之羽']],
  },
  battlefield: {
    name: '记忆战场', tip: '战场攻略/阵容速报获取中，请稍后...', none: '记忆战场攻略',
    args: [['记忆战场', 11956740, [0,1,2,3,4,5,6,7,8,9], '残月'], ['战场作业', 15491760, [0,1,2,3,4,5,6,7,8,9], '墨之羽'], ['终极区战场', 30269990, [0,1,2,3,4,5,6,7,8,9], '朔守']],
  },
  godwar: {
    name: '往世乐土', tip: '乐土攻略获取中，请稍后...', none: '往世乐土攻略',
    args: [['往世乐土', 11956740, [0,1,2,3,4,5,6,7,8,9], '残月'], ['乐土攻略', 15491760, [0,1,2,3,4,5,6,7,8,9], '墨之羽'], ['乐土因子', 30269990, [0,1,2,3,4,5,6,7,8,9], '朔守']],
  },
  assault: {
    name: '强袭战', tip: '强袭战速报获取中，请稍后...', none: '强袭战攻略',
    args: [['强袭战', 4068738, [0,1,3,4,5], '洗礼酱']],
  },
};

function parseIndexes(text, fallback = []) {
  const indexes = String(text || '')
    .split(/[,，\s]+/)
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v >= 0);
  return indexes.length ? indexes : fallback;
}

function parseGuideSources(value, fallback = []) {
  const lines = Array.isArray(value) ? value : String(value || '').split(/\n+/);
  const result = [];
  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text || text.startsWith('#')) continue;
    const [keyword, uidText, indexText = '', author = ''] = text.split('|').map(v => v.trim());
    const uid = Number(uidText);
    if (!keyword || !Number.isSafeInteger(uid) || uid <= 0) continue;
    result.push([keyword, uid, parseIndexes(indexText, [0,1,2,3,4,5,6,7,8,9,10,11]), author || `UID${uid}`]);
  }
  return result.length ? result : fallback;
}

function getPresetArgs(key, cfg) {
  const base = cfg?.args || [];
  if (!['abyss', 'battlefield', 'godwar', 'zzz_defense', 'zzz_deadly'].includes(key)) return base;
  const userCfg = config() || {};
  if (['zzz_defense', 'zzz_deadly'].includes(key)) {
    return parseGuideSources(userCfg[`zzz_guide_${key === 'zzz_defense' ? 'defense' : 'deadly'}_sources`], base);
  }
  const parsed = parseGuideSources(userCfg[`bh3_guide_${key}_sources`], base);
  if (key === 'abyss') {
    return [...parsed].sort((a, b) => {
      const aw = a[3] === '朔守' ? 0 : 1;
      const bw = b[3] === '朔守' ? 0 : 1;
      return aw - bw;
    });
  }
  return parsed;
}

async function searchPosts(keyword, uid, size = 20) {
  const url = `${SEARCH_API}?keyword=${encodeURIComponent(keyword)}&uid=${encodeURIComponent(uid)}&size=${size}&offset=0&sort_type=2`;
  const res = await fetch(url).then(r => r.json());
  return (res?.data?.list || []).map(v => v?.post?.post).filter(Boolean);
}

async function searchPost(keyword, uid, size = 20) {
  return (await searchPosts(keyword, uid, size))[0];
}

async function searchGlobalPosts(keyword, gids = 1, size = 10) {
  const url = `${GLOBAL_SEARCH_API}?gids=${encodeURIComponent(gids)}&size=${size}&keyword=${encodeURIComponent(keyword)}&sort_type=2`;
  const res = await fetch(url, {
    headers: {
      Referer: 'https://www.miyoushe.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    },
  }).then(r => r.json());
  return (res?.data?.posts || []).map(v => v?.post).filter(Boolean);
}

async function fetchPostFull(post = {}, gids = 1) {
  if (!post?.post_id) return post;
  try {
    const url = `${POST_FULL_API}?gids=${encodeURIComponent(gids)}&read=1&post_id=${encodeURIComponent(post.post_id)}`;
    const res = await fetch(url, {
      headers: {
        Referer: 'https://www.miyoushe.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    }).then(r => r.json());
    const full = res?.data?.post?.post || res?.data?.post || {};
    return { ...post, ...full, images: full.images?.length ? full.images : post.images };
  } catch (err) {
    logger.warn(`[xhh][estimate] 获取米游社帖子详情 ${post.post_id} 失败: ${err?.message || err}`);
    return post;
  }
}

const BH3_GUIDE_TYPE_WORDS = {
  abyss: /超弦空间|超炫空间|超弦|超炫|深渊|boss|BOSS/ig,
  battlefield: /记忆战场|战场|boss|BOSS/ig,
  godwar: /往世乐土|乐土/ig,
  zzz_defense: /绝区零|绝区|ZZZ|zzz|式舆防卫战|式舆|防卫战|防卫|深渊|boss|BOSS/ig,
  zzz_deadly: /绝区零|绝区|ZZZ|zzz|危局强袭战|危局|强袭战|强袭|boss|BOSS/ig,
};

const BH3_GUIDE_ACTION_WORDS = /推荐配队|攻略图|攻略|速报|作业|阵容|配队|队伍|刻印|因子|信息|查询|查看/ig;

// 深渊 Boss 标准名 → 常用昵称（攻略作者常写昵称而非标准名，如「狐狸」而非「绯狱丸」）
// 识别到 Boss 后，搜索与过滤需同时支持标准名和昵称，否则昵称帖会被「必须命中 Boss 名」过滤掉
const ABYSS_BOSS_ALIASES = {
  '绯狱丸': ['绯狱丸', '狐狸'],
  '量子泥鳅': ['量子泥鳅', '泥鳅'],
  '神骸-虚无主义': ['神骸-虚无主义', '虚无主义'],
};

function expandAbyssBossWords(words = []) {
  const out = [];
  for (const w of (Array.isArray(words) ? words : [words])) {
    if (!w) continue;
    for (const alias of (ABYSS_BOSS_ALIASES[w] || [w])) {
      if (!out.includes(alias)) out.push(alias);
    }
  }
  return out;
}

function extractBh3GuideKeyword(msg = '', type = 'godwar') {
  const raw = String(msg || '').replace(/^#/, '').trim();
  let keyword = raw
    .replace(/崩坏三|崩坏3|崩三|BH3/ig, '')
    .replace(BH3_GUIDE_TYPE_WORDS[type] || BH3_GUIDE_TYPE_WORDS.godwar, '')
    .replace(BH3_GUIDE_ACTION_WORDS, '')
    .replace(/[：:，,。.!！?？\s]/g, '')
    .trim();
  if (!keyword || ['当前', '本期', '本周', '最新', '今日'].includes(keyword)) return '';
  return keyword.slice(0, 24);
}

function buildBh3GuideArgs(type, keyword, baseArgs) {
  if (!keyword) return baseArgs;
  const keywords = Array.isArray(keyword) ? keyword.filter(Boolean) : [keyword];
  const keywordMap = {
    abyss: word => [`${word} 深渊攻略`, `${word} 深渊配队`, `${word} 深渊阵容`, `${word} 超弦空间`, `${word} 红莲`, `${word} 寂灭`],
    battlefield: word => [`${word} 记忆战场`, `${word} 战场攻略`, `${word} 战场配队`, `${word} 战场阵容`, `${word} 战场作业`, `${word} 终极区战场`],
    godwar: word => [`${word} 乐土攻略`, `${word} 乐土配队`, `${word} 乐土阵容`, `${word} 往世乐土`, `${word} 乐土刻印`, `${word} 乐土因子`],
    zzz_defense: word => [`${word} 式舆防卫战`, `${word} 防卫战攻略`, `${word} 防卫战配队`, `${word} 防卫战阵容`, `${word} 绝区零深渊`],
    zzz_deadly: word => [`${word} 危局强袭战`, `${word} 危局攻略`, `${word} 危局配队`, `${word} 危局阵容`, `${word} 强袭战攻略`],
  };
  const args = [];
  for (const [, uid, , author] of baseArgs) {
    for (const keyword of keywords) {
      for (const word of (keywordMap[type] || keywordMap.godwar)(keyword)) {
        args.push([word, uid, [0,1,2,3,4,5,6,7,8,9,10,11], author]);
      }
    }
  }
  // 专项没搜到时，再回退本期通用攻略。
  return [...args, ...baseArgs];
}

function uniqueList(list = [], limit = 12) {
  const seen = new Set();
  const result = [];
  for (const item of list.flat().filter(Boolean)) {
    const text = String(item).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collectJsonText(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => collectJsonText(v, depth + 1));
  if (typeof value !== 'object') return [];
  const preferKeys = ['text', 'insert', 'content', 'desc', 'title'];
  const direct = preferKeys.flatMap(k => collectJsonText(value[k], depth + 1));
  if (direct.length) return direct;
  // 跳过视频/图片等媒体元数据，避免把 resolutions/definition/codec/size 等字段当正文
  const skip = new Set(['vod', 'resolutions', 'backup_resolutions', 'image', 'attributes']);
  return Object.entries(value)
    .filter(([k]) => !skip.has(k))
    .flatMap(([, v]) => collectJsonText(v, depth + 1));
}

function extractPostSummary(post = {}, maxLen = 3000) {
  let content = post.content || post.structured_content || post.summary || '';
  try {
    const json = JSON.parse(content);
    if (json?.text) content = json.text;
    else content = collectJsonText(json).join('\n');
  } catch (_) {}
  const text = decodeHtml(content)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...\n（正文较长已截断，可结合图片或原帖继续查看）` : text;
}

// 从米游社帖子详情里提取视频对象（structured_content 的 insert.vod，或兜底 vod_list）
function extractPostVod(post = {}) {
  const scan = (value, depth = 0) => {
    if (depth > 6 || value == null) return null;
    if (Array.isArray(value)) {
      for (const v of value) {
        const hit = scan(v, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof value === 'object') {
      if (value.vod && typeof value.vod === 'object') return value.vod;
      for (const k of Object.keys(value)) {
        const hit = scan(value[k], depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  let parsed = null;
  const raw = post.structured_content || post.content || '';
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  } else {
    parsed = raw;
  }
  const vod = scan(parsed);
  if (vod) return vod;
  if (Array.isArray(post.vod_list) && post.vod_list.length) return post.vod_list[0];
  return null;
}

// 提取视频封面与最高画质直链，供「纯视频攻略帖」展示
function postVodInfo(post = {}) {
  const vod = extractPostVod(post);
  if (!vod) return null;
  const res = Array.isArray(vod.resolutions) ? vod.resolutions : (Array.isArray(vod.backup_resolutions) ? vod.backup_resolutions : []);
  const best = res.length ? res[res.length - 1] : null;
  return {
    cover: vod.cover || '',
    url: best?.url || '',
    duration: vod.duration || 0,
    label: best?.label || best?.definition || '',
    resolutions: res,
  };
}

// 生成米游社原帖链接（崩三 bh3 / 绝区零 zzz）
function mysPostUrl(post = {}, gids = 1) {
  const pid = post.post_id || post.postId || '';
  if (!pid) return '';
  const path = Number(gids) === 8 ? 'zzz' : 'bh3';
  return `https://www.miyoushe.com/${path}/article/${pid}`;
}

// 选择合适画质：不超过 VOD_MAX_SIZE 的最高画质；全部超限时取最小画质兜底
function pickVodUrl(vod = {}, maxSize = VOD_MAX_SIZE) {
  const res = Array.isArray(vod.resolutions) ? vod.resolutions : [];
  const list = res.filter(r => r?.url).sort((a, b) => (b.size || 0) - (a.size || 0));
  if (!list.length) return null;
  const under = list.find(r => (r.size || 0) <= maxSize);
  return under || list[list.length - 1];
}

// 清理过期攻略视频缓存：删除 temp/mys_vod 下修改时间超过 24 小时的文件
function cleanupMysVod(maxAgeMs = 24 * 3600 * 1000) {
  try {
    if (!fs.existsSync(VOD_TEMP_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(VOD_TEMP_DIR)) {
      const p = VOD_TEMP_DIR + name;
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
      } catch (e) { /* 忽略单文件删除失败 */ }
    }
  } catch (e) { /* 忽略目录读取失败 */ }
}

// 流式下载米游社视频到本地（完整 mp4，无需 ffmpeg 合并）
async function downloadMysVideo(url, filePath) {
  cleanupMysVod(); // 下载前顺带清理超过 24h 的旧视频
  if (!fs.existsSync(VOD_TEMP_DIR)) fs.mkdirSync(VOD_TEMP_DIR, { recursive: true });
  const res = await fetch(url, {
    headers: {
      Referer: 'https://www.miyoushe.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // 兼容 node-fetch v2/v3 与 Node 原生 fetch（后者 res.body 是 web stream，没有 pipe）
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// 模块加载即清理一次历史残留（超过 24h 的攻略视频）
cleanupMysVod();

// 直接发送视频（放宽超时，不进合并转发），与 b 站 sendVideoWithTimeout 同思路
async function sendVodVideo(e, video) {
  const bot = e.bot || Bot[Number(Bot.uin)];
  const oldTimeout = bot?.timeout;
  if (bot && typeof oldTimeout === 'number') bot.timeout = Math.max(oldTimeout, 600000);
  try {
    return await e.reply(video);
  } finally {
    if (bot && typeof oldTimeout === 'number') bot.timeout = oldTimeout;
  }
}

function postPlainText(post = {}) {
  return [
    post.subject,
    post.content,
    post.structured_content,
    post.summary,
  ].filter(Boolean).join('\n');
}

function postCreatedAt(post = {}) {
  return Number(post.created_at || post.publish_at || post.created_time || 0);
}

function isRecentPost(post = {}, maxDays = 5) {
  const ts = postCreatedAt(post);
  if (!ts) return true;
  return Math.floor(Date.now() / 1000) - ts <= maxDays * 24 * 3600;
}

function isThisWeekPost(post = {}) {
  const ts = postCreatedAt(post);
  if (!ts) return true;
  const start = new Date();
  const day = start.getDay() || 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day + 1);
  return ts * 1000 >= start.getTime();
}

function cycleStartByWeekday(weekday = 2) {
  const start = new Date();
  const current = start.getDay();
  const normalized = current === 0 ? 7 : current;
  start.setHours(0, 0, 0, 0);
  let diff = normalized - weekday;
  if (diff < 0) diff += 7;
  start.setDate(start.getDate() - diff);
  return start.getTime();
}

function currentAbyssStartMs(now = new Date()) {
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = d.getDay();
    if (day === 1 || day === 5) {
      d.setHours(15, 0, 0, 0);
      if (d.getTime() <= now.getTime()) return d.getTime();
    }
  }
  return Date.now() - 4 * 24 * 3600 * 1000;
}

function isCurrentAbyssPost(post = {}) {
  const ts = postCreatedAt(post);
  if (!ts) return true;
  return ts * 1000 >= currentAbyssStartMs() - 30 * 60 * 1000;
}

function isCurrentBattlefieldPost(post = {}) {
  const ts = postCreatedAt(post);
  if (!ts) return true;
  // 记忆战场周二刷新：周二 00:00 后算本期，周一则回退到上周二。
  return ts * 1000 >= cycleStartByWeekday(2);
}

function normalizeSearchWord(text = '') {
  return String(text || '').replace(/[·・!！♪♡♥～~\s]/g, '');
}

function postContainsAny(post = {}, words = []) {
  const text = normalizeSearchWord(postPlainText(post));
  return words.some(word => {
    const clean = normalizeSearchWord(word);
    return clean && clean.length >= 2 && text.includes(clean);
  });
}

function postMatchesGuideType(post = {}, type) {
  const raw = postPlainText(post);
  const title = String(post.subject || '');
  if (type === 'abyss') {
    // 只收深渊/超弦相关；单纯战场帖即使命中同名 Boss 也过滤掉。
    if (!/(超弦|超炫|深渊|红莲|寂灭|苦痛|扰动)/.test(raw)) return false;
    if (/(记忆战场|战场)/.test(title) && !/(超弦|超炫|深渊)/.test(title)) return false;
  }
  if (type === 'battlefield') {
    if (!/(记忆战场|战场|终极区)/.test(raw)) return false;
    if (/(超弦|超炫|深渊)/.test(title) && !/(记忆战场|战场)/.test(title)) return false;
  }
  if (type === 'godwar') return /(往世乐土|乐土|刻印|因子)/.test(raw);
  if (type === 'zzz_defense') {
    if (!/(式舆防卫战|式舆|防卫战|防卫|剧变节点|稳定节点)/.test(raw)) return false;
    if (/(危局强袭战|危局|强袭战)/.test(title) && !/(式舆|防卫)/.test(title)) return false;
  }
  if (type === 'zzz_deadly') {
    if (!/(危局强袭战|危局|强袭战)/.test(raw)) return false;
    if (/(式舆防卫战|式舆|防卫战)/.test(title) && !/(危局|强袭)/.test(title)) return false;
  }
  return true;
}

function isGuidePostUsable(post = {}, type, queryList = []) {
  if (!postMatchesGuideType(post, type)) return false;
  const queries = (Array.isArray(queryList) ? queryList : [queryList]).filter(Boolean);
  // 当期深渊/战场/危局已经识别出 Boss 时，必须命中 Boss 名，避免历史深渊混进来。
  if (queries.length && ['abyss', 'battlefield', 'zzz_deadly'].includes(type)) {
    if (type === 'battlefield' && !isCurrentBattlefieldPost(post)) return false;
    if (type === 'abyss' && !isCurrentAbyssPost(post)) return false;
    return postContainsAny(post, queries);
  }
  // 没有当期 Boss 时只放最近攻略，避免全站搜索返回很久以前的历史深渊。
  if (type === 'battlefield') return isCurrentBattlefieldPost(post);
  if (['abyss', 'battlefield', 'zzz_defense', 'zzz_deadly'].includes(type)) {
    return type === 'abyss' ? isCurrentAbyssPost(post) : isRecentPost(post, 5);
  }
  return true;
}

function formatPostInfo(prefix, post = {}, fallback = '', gids = 1) {
  const lines = [
    prefix,
    post.subject || fallback,
  ].filter(Boolean);
  const time = Number(post.created_at || post.publish_at || 0);
  if (time) lines.push(`发布：${new Date(time * 1000).toLocaleString('zh-CN', { hour12: false })}`);
  const summary = extractPostSummary(post);
  if (summary) lines.push(`摘要：${summary}`);
  if (post.post_id) {
    const url = mysPostUrl(post, gids);
    lines.push(url ? `原帖ID：${post.post_id}\n原帖：${url}` : `原帖ID：${post.post_id}`);
  }
  return lines.join('\n');
}

function buildGlobalGuideWords(type, queryList, baseArgs) {
  const rawQueries = Array.isArray(queryList) ? queryList.filter(Boolean) : [queryList].filter(Boolean);
  if (rawQueries.length) {
    return uniqueList(rawQueries.map(word => {
      if (type === 'abyss') return [`${word} 深渊攻略`, `${word} 超弦空间`, `${word} 红莲`, `${word} 寂灭`, word];
      if (type === 'battlefield') return [`${word} 记忆战场`, `${word} 战场攻略`, `${word} 终极区战场`, word];
      if (type === 'godwar') return [`${word} 往世乐土`, `${word} 乐土攻略`, `${word} 乐土刻印`, word];
      if (type === 'zzz_defense') return [`${word} 式舆防卫战`, `${word} 防卫战攻略`, `${word} 绝区零深渊`, word];
      if (type === 'zzz_deadly') return [`${word} 危局强袭战`, `${word} 危局攻略`, `${word} 强袭战攻略`, word];
      return [word];
    }), 14);
  }
  if (type === 'battlefield') {
    return uniqueList([
      '记忆战场阵容分配推荐',
      '记忆战场每周分配推荐',
      '终极区 记忆战场 阵容分配',
      '本周 记忆战场',
      '记忆战场',
      ...baseArgs.map(([word]) => word),
    ], 10);
  }
  return uniqueList(baseArgs.map(([word]) => word), 8);
}

export class mhy_estimate extends plugin {
  constructor() {
    super({
      name: '[小花火]米游社资源预估与攻略取图',
      dsc: '原石/星琼/菲林/水晶预估，崩三深渊战场乐土攻略取图',
      event: 'message',
      priority: pluginPriority('mhy_estimate', -Infinity),
      rule: [
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3).*(深渊|超弦|超弦空间|超炫|超炫空间).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'bh3AbyssGuide' },
        { reg: '^#?(?!.*(原神|星铁|星穹|绝区零|绝区|ZZZ|zzz)).*(深渊|超弦|超弦空间|超炫|超炫空间).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'bh3AbyssGuide' },
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3).*(战场|记忆战场).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'bh3BattlefieldGuide' },
        { reg: '^#?(?!.*(原神|星铁|星穹|绝区零|绝区|ZZZ|zzz)).*(战场|记忆战场).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'bh3BattlefieldGuide' },
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3).*(乐土|往世乐土).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|刻印|因子)$', fnc: 'bh3GodwarGuide' },
        { reg: '^#?(?!.*(原神|星铁|星穹|绝区零|绝区|ZZZ|zzz)).*(乐土|往世乐土).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|刻印|因子)$', fnc: 'bh3GodwarGuide' },
        { reg: '^#?(绝区零|绝区|ZZZ|zzz).*(式舆防卫战|式舆|防卫战|防卫|深渊).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'zzzDefenseGuide' },
        { reg: '^#?(式舆防卫战|式舆|防卫战|防卫).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'zzzDefenseGuide' },
        { reg: '^#?(绝区零|绝区|ZZZ|zzz).*(危局强袭战|危局|强袭战|强袭).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'zzzDeadlyGuide' },
        { reg: '^#?(危局强袭战|危局).*(攻略|攻略图|速报|作业|阵容|配队|推荐配队|队伍|boss|BOSS)$', fnc: 'zzzDeadlyGuide' },
        { reg: '^#?((原神|原石|gs)|(星铁|星琼|sr)|(崩坏三|崩三|水晶|bbb|bh3|！)|(绝区零|绝区|菲林|邦布券|邦布|zzz)|(超弦空间|超炫空间|深渊)|(战场|记忆战场)|(乐土|往世乐土)|(强袭|强袭战))?(前瞻信息|速报|预估|盘点|攻略)$', fnc: 'mysEstimate' },
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3)(深渊|超弦|超弦空间|战场|记忆战场|乐土|往世乐土)(攻略|速报|作业)$', fnc: 'bh3Guide' },
      ],
    });
  }

  async bh3Guide(e) {
    return this.mysEstimate(e);
  }

  async bh3AbyssGuide(e) {
    return this.mysEstimate(e, 'abyss');
  }

  async bh3BattlefieldGuide(e) {
    return this.mysEstimate(e, 'battlefield');
  }

  async bh3GodwarGuide(e) {
    return this.mysEstimate(e, 'godwar');
  }

  async zzzDefenseGuide(e) {
    return this.mysEstimate(e, 'zzz_defense');
  }

  async zzzDeadlyGuide(e) {
    return this.mysEstimate(e, 'zzz_deadly');
  }

  async mysEstimate(e, forceKey = '') {
    const key = forceKey || pickGame(e.msg || '');
    const cfg = presets[key] || presets.gs;
    const guideKeys = ['abyss', 'battlefield', 'godwar', 'zzz_defense', 'zzz_deadly'];
    let query = guideKeys.includes(key) ? extractBh3GuideKeyword(e.msg || '', key) : '';
    let queryList = query ? [query] : [];
    let currentAbyssInfo = null;
    let currentBattlefieldInfo = null;
    let currentZzzDefenseInfo = null;
    let currentZzzDeadlyInfo = null;
    if (key === 'abyss' && !query) {
      try {
        const { getCurrentAbyssInfoByEvent } = await loadBh3BossModule();
        currentAbyssInfo = await getCurrentAbyssInfoByEvent(e);
        if (currentAbyssInfo?.boss && currentAbyssInfo.boss !== '未知') {
          query = currentAbyssInfo.boss;
          queryList = expandAbyssBossWords([currentAbyssInfo.boss]);
        }
      } catch (err) {
        logger.warn(`[xhh][estimate] 获取当前深渊Boss失败: ${err?.message || err}`);
      }
    }
    if (key === 'battlefield' && !query) {
      // 记忆战场接口返回的是个人历史战报，可能刚好还是上期 Boss。
      // 无指定 Boss 时不再用它拼“正在搜索 xxx”，直接按本周战场关键词搜索，避免提示混入上周内容。
      query = '';
      queryList = [];
    }
    if (key === 'zzz_defense' && !query) {
      try {
        currentZzzDefenseInfo = await getCurrentZzzDefenseInfoByEvent(e);
      } catch (err) {
        logger.warn(`[xhh][estimate] 获取当前防卫战信息失败: ${err?.message || err}`);
      }
    }
    if (key === 'zzz_deadly' && !query) {
      try {
        currentZzzDeadlyInfo = await getCurrentZzzDeadlyInfoByEvent(e);
        if (currentZzzDeadlyInfo?.bosses?.length) {
          queryList = currentZzzDeadlyInfo.bosses;
          query = currentZzzDeadlyInfo.bosses.join(' / ');
        }
      } catch (err) {
        logger.warn(`[xhh][estimate] 获取当前危局Boss失败: ${err?.message || err}`);
      }
    }
    const guideName = key === 'abyss' ? '深渊' : key === 'battlefield' ? '战场' : key === 'godwar' ? '乐土' : key === 'zzz_defense' ? '防卫战' : key === 'zzz_deadly' ? '危局' : cfg.name;
    await e.reply(query ? `正在搜索「${query}」${guideName}攻略，请稍后...` : cfg.tip, true, { recallMsg: 60 });

    const msg = [];
    const seenPosts = new Set();
    const seenImages = new Set();
    let downloadedVod = false; // 一次攻略搜索最多直发 1 个视频，避免拖慢整个流程
    let vodSend = null; // 待单独直发的视频 { filePath, postInfo }（不进合并转发）
    if (cfg.custom?.[0]) msg.push([`作者：${cfg.custom[1] || '自定义图片源'}`, segment.image(cfg.custom[0])]);
    if (currentAbyssInfo) { const { formatCurrentAbyssInfo } = await loadBh3BossModule(); msg.push(`已识别当期深渊：\n${formatCurrentAbyssInfo(currentAbyssInfo, true)}`); }
    if (currentBattlefieldInfo) { const { formatCurrentBattlefieldInfo } = await loadBh3BossModule(); msg.push(`已识别当期战场：\n${formatCurrentBattlefieldInfo(currentBattlefieldInfo, true)}`); }
    if (currentZzzDefenseInfo) msg.push(`已识别当前防卫战：\n${formatCurrentZzzDefenseInfo(currentZzzDefenseInfo, true)}`);
    if (currentZzzDeadlyInfo) msg.push(`已识别当前危局：\n${formatCurrentZzzDeadlyInfo(currentZzzDeadlyInfo, true)}`);

    const baseArgs = getPresetArgs(key, cfg);
    const args = guideKeys.includes(key) ? buildBh3GuideArgs(key, queryList.length ? queryList : query, baseArgs) : baseArgs;
    const detailGid = GAME_GIDS[key] || 1;
    for (const [searchWord, uid, indexes, author] of args) {
      try {
        const posts = query ? await searchPosts(searchWord, uid, 8) : [await searchPost(searchWord, uid)];
        for (let post of posts.filter(Boolean)) {
          if (!isGuidePostUsable(post, key, queryList.length ? queryList : query)) continue;
          post = await fetchPostFull(post, detailGid);
          const postKey = post.post_id || post.subject || `${uid}:${searchWord}`;
          if (seenPosts.has(postKey)) continue;
          const images = post?.images || [];
          const imageSegments = indexes
            .filter(i => images[i] && !seenImages.has(images[i]))
            .slice(0, 12)
            .map(i => {
              seenImages.add(images[i]);
              return segment.image(images[i]);
            });
          // 有视频的攻略帖：视频下载成功则单独直发，文字简介仍进合并转发；失败回退封面+链接
          const vod = postVodInfo(post);
          const hasText = !!extractPostSummary(post);
          const postInfo = formatPostInfo(`作者：${author}`, post, searchWord, detailGid);
          let vodLine = '';
          let vodCoverSeg = null;
          let vodDownloaded = false;
          if (vod && !downloadedVod) {
            const picked = pickVodUrl(vod);
            if (picked?.url) {
              try {
                const filePath = await downloadMysVideo(picked.url, `${VOD_TEMP_DIR}${post.post_id || Date.now()}.mp4`);
                vodSend = { filePath };
                downloadedVod = true;
                vodDownloaded = true;
              } catch (err) {
                logger.warn(`[xhh][estimate] 攻略视频下载失败 ${post.post_id}: ${err?.message || err}`);
              }
            }
          }
          if (vod && !vodDownloaded) {
            // 下载失败或已下载过其他视频：回退封面+链接
            if (vod.cover && !seenImages.has(vod.cover)) {
              seenImages.add(vod.cover);
              vodCoverSeg = segment.image(vod.cover);
            }
            const vodDesc = [`${vod.label || ''}`, vod.duration ? `约${Math.round(vod.duration / 1000)}秒` : ''].filter(Boolean).join(' · ');
            vodLine = `视频攻略${vodDesc ? `（${vodDesc}）` : ''}：${mysPostUrl(post, detailGid) || vod.url}`;
          }
          if (!imageSegments.length && !vodCoverSeg && !hasText && !vodLine) continue;
          seenPosts.add(postKey);
          msg.push([postInfo, vodLine, ...imageSegments, vodCoverSeg].filter(Boolean));
          if (query && msg.length >= 6) break;
        }
        if (query && msg.length >= 6) break;
      } catch (err) {
        logger.warn(`[xhh][estimate] 获取 ${searchWord}/${uid} 失败: ${err?.message || err}`);
      }
    }

    if (guideKeys.includes(key) && config()?.mys_global_guide_search !== false && (!query || msg.length < 3)) {
      const gids = GAME_GIDS[key] || 1;
      const globalWords = buildGlobalGuideWords(key, queryList.length ? queryList : query, baseArgs);
      for (const searchWord of globalWords) {
        try {
          const posts = await searchGlobalPosts(searchWord, gids, query ? 8 : 5);
          for (let post of posts) {
            if (!isGuidePostUsable(post, key, queryList.length ? queryList : query)) continue;
            post = await fetchPostFull(post, gids);
            const postKey = post.post_id || post.subject || `global:${gids}:${searchWord}`;
            if (seenPosts.has(postKey)) continue;
            const images = post?.images || [];
            const imageSegments = images
              .filter(url => url && !seenImages.has(url))
              .slice(0, 12)
              .map(url => {
                seenImages.add(url);
                return segment.image(url);
              });
            const vod = postVodInfo(post);
            const hasText = !!extractPostSummary(post);
            const postInfo = formatPostInfo('来源：米游社全站搜索', post, searchWord, gids);
            let vodLine = '';
            let vodCoverSeg = null;
            let vodDownloaded = false;
            if (vod && !downloadedVod) {
              const picked = pickVodUrl(vod);
              if (picked?.url) {
                try {
                  const filePath = await downloadMysVideo(picked.url, `${VOD_TEMP_DIR}${post.post_id || Date.now()}.mp4`);
                  vodSend = { filePath };
                  downloadedVod = true;
                  vodDownloaded = true;
                } catch (err) {
                  logger.warn(`[xhh][estimate] 攻略视频下载失败 ${post.post_id}: ${err?.message || err}`);
                }
              }
            }
            if (vod && !vodDownloaded) {
              // 下载失败或已下载过其他视频：回退封面+链接
              if (vod.cover && !seenImages.has(vod.cover)) {
                seenImages.add(vod.cover);
                vodCoverSeg = segment.image(vod.cover);
              }
              const vodDesc = [`${vod.label || ''}`, vod.duration ? `约${Math.round(vod.duration / 1000)}秒` : ''].filter(Boolean).join(' · ');
              vodLine = `视频攻略${vodDesc ? `（${vodDesc}）` : ''}：${mysPostUrl(post, gids) || vod.url}`;
            }
            if (!imageSegments.length && !vodCoverSeg && !hasText && !vodLine) continue;
            seenPosts.add(postKey);
            msg.push([postInfo, vodLine, ...imageSegments, vodCoverSeg].filter(Boolean));
            if (msg.length >= 6) break;
          }
          if (msg.length >= 6) break;
        } catch (err) {
          logger.warn(`[xhh][estimate] 米游社全站搜索 ${searchWord} 失败: ${err?.message || err}`);
        }
      }
    }

    const title = query ? `${cfg.name}「${query}」攻略来啦~` : `${cfg.name}来啦~`;
    let sent = false;
    if (msg.length) {
      await e.reply(await makeForwardMsg(e, msg, `${title}\n如果出现图片错误，请忽略`));
      sent = true;
    }
    if (vodSend) {
      // 视频单独直发（简介文字已在合并转发里）
      await sendVodVideo(e, segment.video(vodSend.filePath));
      sent = true;
    }
    if (!sent) return e.reply(`未找到${query ? `「${query}」` : ''}${cfg.none || cfg.name}相关图片，请稍后再试！`, true);
    return true;
  }
}
