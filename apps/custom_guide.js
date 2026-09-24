import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { makeForwardMsg, config, pluginPriority, oldPostWarn } from '#xhh';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 插件根目录（apps 的上一级），别名表读取不依赖进程 cwd、也不依赖任何外部插件
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const SEARCH_API = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list';
const DEFAULT_SIZE = 20;
const SORT_TYPE = '2';
const MAX_IMAGES = 10;
const FETCH_TIMEOUT = 15000;
// 默认作者UID：当各游戏未单独填UID、或角色不在别名表时兜底使用（无需在锅巴额外保存即生效）
const FALLBACK_UID = '74019947';

/**
 * [小花火]自定义攻略源（极简模式）
 * 只需在锅巴面板为每个游戏填一个「作者UID」，角色名即关键词。
 * 关键词自动用别名表（xhh 自带 system/default/*alias*.json）把别名/英文名/错别字
 * 归一成正式名，例如「Violet / 沃雅尼沙」都会转成「沃雅妮莎」去搜。
 * 角色属于哪个游戏由别名表判定，从而自动选对应游戏的UID。
 *
 * 指令：#角色名攻略  /  #角色名一图流  /  #角色名配对  /  #角色名配队
 *       也可加前缀避免与其它插件冲突：xhh#角色名攻略 / xhh/角色名攻略 / 小花火#角色名攻略（前缀可省略，支持 xhh/小花火 后接 / 或 #）
 *       跨游戏重名/同别名时用游戏前缀指定：#绝区零鲨鱼妹攻略 / #原神玛拉妮攻略
 */

// 三游戏别名表，各自独立加载：1) 归一化关键词；2) 判定角色所属游戏以选UID
const ALIAS_FILES = {
  gs: path.join(PLUGIN_ROOT, 'system/default/gsalias.json'),
  sr: path.join(PLUGIN_ROOT, 'system/default/sralias.json'),
  zzz: path.join(PLUGIN_ROOT, 'system/default/zzzalias.json'),
};
// 游戏前缀：#绝区零鲨鱼妹攻略 这类写法可显式指定游戏，解决跨游戏别名冲突（如 鲨鱼妹 → 原神玛拉妮 / 绝区零艾莲）
const GAME_PREFIX_MAP = {
  '原神': 'gs', 'gs': 'gs',
  '星铁': 'sr', '星穹': 'sr', '星穹铁道': 'sr', 'sr': 'sr',
  '绝区零': 'zzz', 'zzz': 'zzz',
};
let aliasMaps = null;
let aliasLoaded = false;

function loadAliasMaps() {
  if (aliasLoaded) return aliasMaps;
  aliasLoaded = true;
  const maps = {};
  for (const [game, p] of Object.entries(ALIAS_FILES)) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') maps[game] = data;
    } catch (err) {
      logger.warn(`[xhh][custom_guide] 读取别名表失败 ${p}: ${err?.message || err}`);
    }
  }
  if (Object.keys(maps).length) aliasMaps = maps;
  return aliasMaps;
}

// 在单个游戏别名表里归一化：输入即正式名(key) 或 命中别名数组 → 返回正式名；否则 null
function formalInMap(name, map) {
  if (!map) return null;
  if (Array.isArray(map[name]) && map[name].length) return name;
  for (const [key, aliases] of Object.entries(map)) {
    if (Array.isArray(aliases) && aliases.includes(name)) return key;
  }
  return null;
}

// 解析图片序号字符串，如 "0" / "0,2" / "0, 2" → [0] / [0, 2]
// 留空取该帖全部图片；填序号取指定张（0=第一张，1=第二张，从0开始）
// 注意：Number('') === 0，''.split() 会得到 ['']，若直接 map(Number) 会把「留空」变成 [0]（只取首图），
// 所以空串必须提前返回 []，并过滤掉分隔产生的空段
function parseIndexes(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  return raw.split(/[,，\s]+/)
    .filter(s => s !== '')
    .map(Number)
    .filter(v => Number.isInteger(v) && v >= 0);
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://www.miyoushe.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.warn(`[xhh][custom_guide] 请求失败 ${url}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 提取帖子完整图片：搜索接口返回的 post.images 在某些分支下只含封面 1 张，
// 完整图集在外层 image_list（每项带 url）。不同接口版本可能在 item.image_list / item.post.image_list 两处，
// 这里都尝试，并兼容「字符串数组」和「{url}对象数组」两种结构，取数量最多的那份
function extractImages(item = {}) {
  const post = item?.post?.post || {};
  const candidates = [
    post.images,
    item?.image_list,
    item?.post?.image_list,
  ].filter(Array.isArray);
  let best = [];
  for (const arr of candidates) {
    const urls = (arr[0] && typeof arr[0] === 'object' && arr[0]?.url)
      ? arr.map(x => x?.url).filter(Boolean)
      : arr.filter(Boolean);
    if (urls.length > best.length) best = urls;
  }
  return best.slice();
}

async function searchPosts(keyword, uid, size = DEFAULT_SIZE) {
  // 米游社标题普遍用「·」(U+00B7)，而别名表/输入可能是「•」(U+2022)「・」等变体，统一成「·」再搜，提高命中率
  const apiKeyword = String(keyword).replace(/[•・∙⋅]/g, '·');
  const url = `${SEARCH_API}?keyword=${encodeURIComponent(apiKeyword)}&uid=${encodeURIComponent(uid)}&size=${size}&offset=0&sort_type=${SORT_TYPE}`;
  const res = await fetchJSON(url);
  if (!res || res.retcode !== 0) return [];
  // 标题必须包含关键词才采用：比较时去掉所有非文字/数字字符（点号变体、空格、括号、书名号等全部忽略，
  // 如「零号·安比」↔「零号安比」↔「零号•安比」都能对上），过滤掉作者动态里正文提到关键词的无关帖子
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const kw = norm(keyword);
  return (res?.data?.list || [])
    .map(v => {
      const post = v?.post?.post || {};
      return {
        subject: post.subject,
        post_id: post.post_id,
        created_at: post.created_at,
        publish_at: post.publish_at,
        images: extractImages(v),
      };
    })
    .filter(p => norm(p.subject).includes(kw));
}

// 米游社图床（阿里OSS）支持链接参数实时压缩：攻略长图原图常达十几MB，QQ协议端发不动
// （表现为只发出第一张封面、其余全部失败）。统一转 jpg 并压画质（分辨率不变，gif 跳过保持动图）
function compressImg(url = '') {
  if (!url || !url.includes('upload-bbs.miyoushe.com')) return url;
  if (/\.gif($|\?)/i.test(url) || url.includes('x-oss-process')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x-oss-process=image/resize,w_1200/quality,q_85/format,jpg`;
}

function pickImages(post = {}, indexes = []) {
  const images = post.images || [];
  if (!images.length) return [];
  const idxList = indexes.length
    ? indexes
    : [...Array(Math.min(MAX_IMAGES, images.length)).keys()];
  return idxList.filter(i => images[i]).slice(0, MAX_IMAGES).map(i => compressImg(images[i]));
}

export class custom_guide extends plugin {
  constructor() {
    super({
      name: '[小花火]自定义攻略源',
      dsc: '只需配置各游戏作者UID，关键词自动取角色别名表正式名',
      event: 'message',
      priority: pluginPriority('custom_guide', -9999999999),
      rule: [
        { reg: '^(?:(?:xhh|小花火)[/#]?)?#?(\\S+)(攻略|一图流|配对|配队)$', fnc: 'guide' },
      ],
    });
  }

  async guide(e) {
    if (config()?.custom_guide_enable === false) return false;

    const match = /^(?:(?:xhh|小花火)[/#]?)?#?(\S+)(攻略|一图流|配对|配队)$/.exec(e.msg || '');
    if (!match) return false;
    let roleQuery = match[1];

    const cfg = config() || {};
    const maps = loadAliasMaps();
    const games = [
      { key: 'gs', uid: cfg.custom_guide_gs_uid, index: cfg.custom_guide_gs_index },
      { key: 'sr', uid: cfg.custom_guide_sr_uid, index: cfg.custom_guide_sr_index },
      { key: 'zzz', uid: cfg.custom_guide_zzz_uid, index: cfg.custom_guide_zzz_index },
    ];

    // 剥离游戏前缀（如 绝区零/原神/星铁），锁定游戏，避免跨游戏别名冲突
    let forced = null;
    const pm = /^(原神|星穹铁道|星穹|星铁|绝区零|zzz|gs|sr)/i.exec(roleQuery);
    if (pm && pm[1].length < roleQuery.length) {
      forced = GAME_PREFIX_MAP[pm[1].toLowerCase()];
      roleQuery = roleQuery.slice(pm[1].length);
    }

    // 按游戏匹配：哪个游戏的别名表收录了这个角色，就归哪个游戏（决定用哪个游戏的默认源）。
    // 别名冲突时（如 鲨鱼妹 同时收录于原神/绝区零）会命中多个游戏，按序依次尝试各游戏的源
    const matchedGames = [];
    for (const g of games) {
      if (forced && g.key !== forced) continue;
      const formal = formalInMap(roleQuery, maps?.[g.key]);
      if (formal) matchedGames.push({ ...g, formal });
    }

    // 关键词：别名命中用该游戏的正式名（如 大安比→零号·安比），否则用原名
    const keyword = matchedGames.length ? matchedGames[0].formal : roleQuery;
    const indexes = parseIndexes(matchedGames[0]?.index);

    // 候选（去重、按序尝试，首个有结果即停）：
    //  命中别名 → 各命中游戏的默认源；未命中 → 各游戏默认源；最后全局兜底源 → 代码内置 74019947
    const candidates = [];
    const seenCand = new Set();
    const pushCand = (kw, uid) => {
      const n = Number(uid);
      if (!uid || !Number.isSafeInteger(n) || n <= 0 || seenCand.has(`${kw}@${n}`)) return;
      seenCand.add(`${kw}@${n}`);
      candidates.push({ keyword: kw, uid: n });
    };
    if (matchedGames.length) {
      for (const m of matchedGames) pushCand(m.formal, m.uid);
    } else {
      for (const g of games) pushCand(roleQuery, g.uid);
    }
    pushCand(keyword, cfg.custom_guide_uid);
    pushCand(keyword, FALLBACK_UID);
    // 一个可用UID都没有：静默放行，交给 mora 等其它插件处理
    if (!candidates.length) return false;

    await e.reply(`正在获取「${keyword}」攻略，请稍后...`, true, { recallMsg: 60 });

    const msg = [];
    const seenImages = new Set();
    for (const cand of candidates) {
      const { keyword: kw, uid } = cand;
      try {
        const posts = await searchPosts(kw, uid, DEFAULT_SIZE);
        logger.mark(`[xhh][custom_guide] ${kw}/${uid} 搜到 ${posts.length} 帖，各帖图数: ${posts.map(p => p.images.length).join(',') || '0'}`);
        let pushed = false;
        for (const post of posts) {
          const images = pickImages(post, indexes).filter(u => !seenImages.has(u));
          if (!images.length) continue;
          images.forEach(u => seenImages.add(u));
          const lines = [`作者：UID${uid}`, post.subject || kw].filter(Boolean);
          const time = Number(post.created_at || post.publish_at || 0);
          // 老攻略在发布时间后挂时效提醒，避免拿几年前的内容当现版本作业
          if (time) lines.push(`发布：${new Date(time * 1000).toLocaleString('zh-CN', { hour12: false })}${oldPostWarn(time)}`);
          if (post.post_id) lines.push(`原帖：https://www.miyoushe.com/article/${post.post_id}`);
          // 每张图独立一个转发节点：部分适配器对「单节点多图」发送不可靠（只出第一张、其余全丢）
          // 纯图片节点也包成数组，确保适配器按节点渲染
          msg.push([lines.join('\n'), segment.image(images[0])]);
          for (const u of images.slice(1)) msg.push([segment.image(u)]);
          pushed = true;
          if (msg.length >= 12) break;
        }
        if (pushed) break; // 该候选有结果就不再试下一个
      } catch (err) {
        logger.warn(`[xhh][custom_guide] ${kw}/${uid} 获取失败: ${err?.message || err}`);
      }
    }
    if (!msg.length) {
      msg.push(`未找到「${keyword}」的攻略帖子（已尝试：${candidates.map(c => `${c.keyword}@UID${c.uid}`).join('、')}）。\n请在锅巴「自定义攻略源」填写该游戏的默认源UID，并确认该作者发过此角色攻略`);
    }

    if (!msg.length) return e.reply(`未找到「${keyword}」相关攻略图`, true);
    logger.mark(`[xhh][custom_guide] 准备发送转发节点数: ${msg.length}`);
    // 合并转发开关：关闭时逐条拼接发送，且不带「xx攻略来啦~」这类标题文字
    if (cfg.custom_guide_forward !== 'off') {
      await e.reply(await makeForwardMsg(e, msg, `「${keyword}」攻略来啦~`));
    } else {
      for (const item of msg) await e.reply(item);
    }
    return true;
  }
}
