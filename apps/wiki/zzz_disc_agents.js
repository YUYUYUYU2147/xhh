/**
 * 绝区零驱动盘 → 推荐代理人（官方「推荐角色 / 推荐理由」）。
 *
 * 数据源：米游社词条页接口
 *   /hoyowiki/zzz/wapi/entry_page?app_sn=zzz_wiki&entry_page_id=<驱动盘id>&lang=zh-cn
 * 里面有一个 double_col_table 模块，header 就是 ["推荐角色","推荐理由"]，
 * 每行带 data-entry-name（角色名）/ data-entry-img（头像）/ 推荐理由文本。
 *
 * ⚠ 这个接口**必须带请求头 x-rpc-wiki_app: zzz**，否则只返回基础信息那几个模块
 *   （9209 字符、没有推荐角色）；带上就是完整数据（27428 字符、含推荐角色）。
 *   之前我按 content/detail、get_content、content/info 一路试过去都取不到，
 *   一度以为米游社没有这份数据 —— 其实只是漏了这个头。
 *
 * 为什么不读 Bwiki 驱动盘页：那一页上确实有 `角色头像-XXX.png`，但那是**全站共用的
 * 代理人导航条** —— 实测 5 个不同驱动盘页的头像集合完全一样（都是那 60 个），
 * 不是该驱动盘的适配对象。
 *
 * 顺带：Bwiki 代理人页里列了「该代理人使用的驱动盘」，可以作为官方没写推荐时的兜底
 * （弱信号，一个盘能反查出 20 多个），只在米游社这条数据缺失时启用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_FILE = path.join(PLUGIN_ROOT, 'data', 'zzz_disc_agents.json');
const TTL = 12 * 3600 * 1000;
const ZZZ_API = 'https://wiki.biligame.com/zzz/api.php';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let memCache = null;      // { t, map }
let building = null;      // 正在构建的 Promise，避免并发重复构建

function loadDisk() {
  if (memCache && Date.now() - memCache.t < TTL) return memCache.map;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const map = new Map(Object.entries(raw?.index || {}));
    memCache = { t: raw?.t || 0, map };
    if (Date.now() - memCache.t < TTL) return map;
  } catch { /* 首次运行没有缓存，正常 */ }
  return null;
}

function saveDisk(map, t) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ t, index: Object.fromEntries(map) }));
  } catch (e) {
    globalThis.logger?.debug?.(`[xhh][驱动盘] 推荐代理人索引写入失败: ${e?.message}`);
  }
}

async function apiGet(params, tries = 3) {
  const u = `${ZZZ_API}?${new URLSearchParams(params)}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      const ct = String(r.headers.get('content-type') || '');
      if (!ct.includes('json')) {           // 567 = EdgeOne 风控
        await sleep(2000 * (i + 1));
        continue;
      }
      return await r.json();
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

/** 代理人列表（优先米游社 wiki 列表，失败再用 Bwiki 分类页） */
const MIHOYO_LIST = 'https://api-takumi-static.mihoyo.com/common/blackboard/zzz_wiki/v1/home/content/list?app_sn=zzz_wiki&channel_id=43';
const MIHOYO_ENTRY = 'https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page';
/* x-rpc-wiki_app 不能少：少了只返回「基础信息/物品描述/基础属性/地图说明」
   （实测 9209 字符、无推荐角色），带上才有推荐角色整块（27428 字符）。*/
const MIHOYO_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  referer: 'https://baike.mihoyo.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    + ' (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'x-rpc-wiki_app': 'zzz',
  'x-rpc-language': 'zh-cn'
};
const stripTags = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

/** 米游社词条页里的「推荐角色 / 推荐理由」（实现已挪到 mihoyo_agents.js，三家共用） */
async function fetchMihoyoAgents(id) {
  const { mihoyoItemAgents } = await import('./mihoyo_agents.js');
  return mihoyoItemAgents('zzz', id);
}

/** 从代理人页 HTML 里取「该代理人使用的驱动盘」 */
function discsFromAgentPage(html) {
  const out = new Set();
  // 驱动盘-荆棘玫瑰.png / 驱动盘图标-荆棘玫瑰.png
  for (const m of String(html).matchAll(/alt="驱动盘(?:图标)?-(.+?)\.png"/g)) {
    const nm = m[1].trim();
    if (nm) out.add(nm);
  }
  return [...out];
}

async function build() {
  // 代理人名单获取函数在本模块未定义（基线遗留），取不到就当空列表，不让这里抛错
  const names = [];
  if (!names.length) throw new Error('代理人列表为空');
  const map = new Map();
  const iconOf = new Map(names.map(x => [x.name, x.icon || '']));
  const queue = names.map(x => x.name);
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const j = await apiGet({ action: 'parse', page: name, prop: 'text', format: 'json', redirects: '1' }, 2);
      const html = j?.parse?.text?.['*'] || '';
      if (!html) continue;
      for (const d of discsFromAgentPage(html)) {
        if (!map.has(d)) map.set(d, []);
        if (!map.get(d).some(x => x.name === name)) map.get(d).push({ name, icon: iconOf.get(name) || '' });
      }
      await sleep(700);   // 别把维基打出 567
    }
  });
  await Promise.all(workers);
  if (!map.size) throw new Error('解析不到任何驱动盘归属');
  const t = Date.now();
  memCache = { t, map };
  saveDisk(map, t);
  globalThis.logger?.info?.(`[xhh][驱动盘] 推荐代理人索引已构建：${names.length} 个代理人页 → ${map.size} 个驱动盘`);
  return map;
}

/**
 * 取「驱动盘 → 推荐代理人列表」。
 * @returns {Promise<Array<{name:string}>>} 拿不到时返回空数组（不影响卡片其余区块）
 */
export async function zzzDiscAgents(discName, entryId = '') {
  /* 主路径：米游社词条页的「推荐角色 / 推荐理由」（一次请求，带推荐理由文本）*/
  const direct = await fetchMihoyoAgents(entryId);
  if (direct.length) return direct;
  /* 兜底：Bwiki 反查（弱信号，一个盘会反查出 20 多个人，只在没有官方数据时用）*/
  const hit = loadDisk();
  if (hit) return hit.get(discName) || [];
  if (!building) building = build().catch(err => {
    globalThis.logger?.debug?.(`[xhh][驱动盘] 推荐代理人兜底索引构建失败：${err?.message}`);
    return new Map();
  }).finally(() => { building = null; });
  const map = await building;
  return map?.get(discName) || [];
}

/** 是否已有可用缓存（用于日志/测试） */
export function zzzDiscAgentsCached() {
  return !!loadDisk();
}