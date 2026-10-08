/**
 * 米游社词条页的「角色推荐」（原神圣遗物 / 星铁遗器 / 绝区零驱动盘 通用）。
 *
 * 接口（三家只是 app_sn / wiki_app / path 不同）：
 *   原神   /hoyowiki/genshin/wapi/entry_page?app_sn=ys_obc&entry_page_id=<id>&lang=zh-cn
 *   星铁   /hoyowiki/hsr/wapi/entry_page?app_sn=sr_wiki&entry_page_id=<id>&lang=zh-cn
 *   绝区零 /hoyowiki/zzz/wapi/entry_page?app_sn=zzz_wiki&entry_page_id=<id>&lang=zh-cn
 *
 * ⚠ 必须带 `x-rpc-wiki_app` 请求头（ys / sr / zzz），否则只返回基础信息那几个模块，
 *   推荐角色整块不会出现（实测绝区零：9209 字符无推荐 vs 27428 字符有推荐）。
 *
 * ⚠ 三家的表头措辞不一样，必须都认：
 *   原神「搭配推荐 → 角色推荐」表头 = [角色名称, 推荐原因, 词缀搭配]
 *   绝区零               表头 = [推荐角色, 推荐理由]
 *   星铁：目前米游社词条里**没有**这一块（实测 97841 字符无推荐字段），
 *         所以星铁走 Bwiki 的「推荐角色」小节。
 *
 * 返回的每个角色带 icon（头像）与 reason（推荐原因），两者都是官方原文。
 */
const APIS = {
  gs: { url: 'https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page', app: 'ys_obc', wiki: 'ys', search: 'https://api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/search' },
  sr: { url: 'https://act-api-takumi-static.mihoyo.com/hoyowiki/hsr/wapi/entry_page', app: 'sr_wiki', wiki: 'sr', search: 'https://api-takumi-static.mihoyo.com/hoyowiki/hsr/wapi/search' },
  zzz: { url: 'https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page', app: 'zzz_wiki', wiki: 'zzz', search: 'https://api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/search' }
};

const decodeTxt = v => String(v || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;|&#160;/g, ' ');

const stripTags = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;|&amp;/g, v => (v === '&amp;' ? '&' : ' '))
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

/**
 * @param {'gs'|'sr'|'zzz'} game
 * @param {string|number} entryId 米游社词条页 id
 * @returns {Promise<Array<{name:string,icon:string,reason:string}>>} 取不到返回空数组
 */
export async function mihoyoItemAgents(game, entryId) {
  const api = APIS[game];
  if (!api || !entryId) return [];
  const u = `${api.url}?app_sn=${api.app}&entry_page_id=${encodeURIComponent(entryId)}&lang=zh-cn`;
  try {
    const r = await fetch(u, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        referer: 'https://baike.mihoyo.com/',
        'x-rpc-wiki_app': api.wiki,
        'x-rpc-language': 'zh-cn'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!String(r.headers.get('content-type') || '').includes('json')) return [];
    const page = (await r.json())?.data?.page;
    for (const mod of page?.modules || []) {
      for (const comp of mod?.components || []) {
        let data = null;
        try { data = JSON.parse(comp?.data || 'null'); } catch { continue; }
        for (const tb of data?.tables || []) {
          const head = (tb?.header || []).map(v => String(v));
          const iName = head.findIndex(v => /角色名称|推荐角色/.test(v));
          const iWhy = head.findIndex(v => /推荐原因|推荐理由/.test(v));
          if (iName < 0) continue;
          /* ⚠ 一格里可能塞**多个**角色：绝区零驱动盘的推荐角色表，
             每一行的「推荐角色」格里并排放着两个人的头像链接，
             而「推荐理由」只有一段（同时描述这几个人）。
             以前只取第一个 data-entry-name，
             于是「极地重金属」明明官方推荐了艾莲·乔 + 冯·莱卡恩，卡上只显示 1 个。
             现在把这一格里所有 data-entry-name / data-entry-img 按顺序取出，
             共享同一段推荐理由。 */
          const out = [];
          for (const row of tb?.row || []) {
            const cell = String(row?.[iName] || '');
            const reason = iWhy >= 0 ? stripTags(row?.[iWhy] || '') : '';
            const names = [...cell.matchAll(/data-entry-name="([^"]+)"/g)].map(m => decodeTxt(m[1]));
            const icons = [...cell.matchAll(/data-entry-img="([^"]+)"/g)].map(m => m[1]);
            if (names.length) {
              names.forEach((nm, i) => out.push({ name: decodeTxt(nm), icon: icons[i] || '', reason }));
              continue;
            }
            // 没有 data-entry-name 时退回按纯文本取名
            const nm = stripTags(cell).split('\n')[0].slice(0, 12);
            if (nm) out.push({ name: nm, icon: icons[0] || '', reason });
          }
          if (out.length) return out;
        }
      }
    }
  } catch {
    // 网络异常按「官方没写推荐」处理，调用方会回落到维基数据
  }
  return [];
}

/* ── 按名字取米游社词条 id ───────────────────────────────────
   绝区零有 zzz_official_list、崩三有 bh3_tujian 能列全量条目拿 content_id，
   原神/星铁没有官方列表接口，只能走百科搜索。
   搜索结果里同名条目可能有好几条（角色/武器/圣遗物混在一起），
   优先取「去标签后名字完全相等」的那条，取不到才用第一条。
   按名字缓存，避免同一套装每次查询都搜一遍。 */
const searchCache = new Map();
const SEARCH_TTL = 12 * 3600 * 1000;

/**
 * @param {'gs'|'sr'|'zzz'} game
 * @param {string} name 套装/道具名
 * @returns {Promise<string>} entry_page_id，取不到返回空串
 */
export async function mihoyoEntryId(game, name) {
  const api = APIS[game];
  const kw = String(name || '').trim();
  if (!api?.search || !kw) return '';
  const ck = `${game}:${kw}`;
  const hit = searchCache.get(ck);
  if (hit && Date.now() - hit.t < SEARCH_TTL) return hit.v;
  let id = '';
  try {
    const u = `${api.search}?app_sn=${api.app}&keyword=${encodeURIComponent(kw)}&lang=zh-cn`;
    const r = await fetch(u, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        referer: 'https://baike.mihoyo.com/',
        'x-rpc-wiki_app': api.wiki,
        'x-rpc-language': 'zh-cn'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (String(r.headers.get('content-type') || '').includes('json')) {
      const list = ((await r.json())?.data || {}).list || [];
      const exact = list.find(it => stripTags(it?.name || '') === kw);
      id = String((exact || list[0])?.entry_page_id || '');
    }
  } catch {
    // 搜不到按「官方没有该词条」处理，调用方回落维基数据
  }
  searchCache.set(ck, { t: Date.now(), v: id });
  return id;
}

/**
 * 绝区零驱动盘的 **6 个部位图标 + 主属性**。
 *
 * 米游社词条页有个 `driver_disk` 组件：
 *   disks_icon = 6 张部位图 URL
 *   disks_name = ["1号位", ..., "6号位"]
 *   disks_desc = 每个号位的主属性 HTML（含 S/A/B 三档满级数值）
 * Bwiki 驱动盘页只给 `驱动盘-X-A.png` / `-B.png` 两张（合并图 + 分件图），
 * 所以之前卡上「套装与散件」只有 2 个图标，而游戏里驱动盘是 6 个位置 ——
 * 数据在米游社，直接取官方这份。
 *
 * @returns {Promise<Array<{name:string,icon:string,attrs:Array<{name:string,s:string,a:string,b:string}>}>>} 取不到返回空数组
 */
export async function mihoyoDiscParts(game, entryId) {
  const api = APIS[game];
  if (!api || !entryId || game !== 'zzz') return [];
  try {
    const r = await fetch(`${api.url}?app_sn=${api.app}&entry_page_id=${encodeURIComponent(entryId)}&lang=zh-cn`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        referer: 'https://baike.mihoyo.com/',
        'x-rpc-wiki_app': api.wiki,
        'x-rpc-language': 'zh-cn'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!String(r.headers.get('content-type') || '').includes('json')) return [];
    const page = (await r.json())?.data?.page;
    for (const mod of page?.modules || []) {
      for (const comp of mod?.components || []) {
        if (comp?.component_id !== 'driver_disk') continue;
        const d = JSON.parse(comp.data || '{}');
        const icons = Array.isArray(d.disks_icon)
          ? d.disks_icon
          : String(d.disks_icon || '').split(',').map(v => v.trim()).filter(Boolean);
        const names = Array.isArray(d.disks_name)
          ? d.disks_name
          : String(d.disks_name || '').split(',').map(v => v.trim());
        const descs = Array.isArray(d.disks_desc) ? d.disks_desc : [];
        const parseDesc = html => {
          const out = [];
          const re = /<strong>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/strong>[\s\S]*?<p>S级：([^<]+)<\/p>[\s\S]*?<p>A级：([^<]+)<\/p>[\s\S]*?<p>B级：([^<]+)<\/p>/gi;
          for (const m of String(html || '').matchAll(re)) {
            out.push({ name: stripTags(m[1]), s: stripTags(m[2]), a: stripTags(m[3]), b: stripTags(m[4]) });
          }
          return out;
        };
        return icons.map((icon, i) => ({
          name: names[i] || `${i + 1}号位`,
          icon,
          attrs: parseDesc(descs[i])
        }));
      }
    }
  } catch {
    // 取不到就回落到 Bwiki 的 A/B 图
  }
  return [];
}

/** 星铁是否也该走官方：探测一次并记住（省掉每条命令的一次请求） */
let srHasOfficial = null;
export async function srHasOfficialAgents(entryId) {
  if (srHasOfficial !== null) return srHasOfficial;
  const list = await mihoyoItemAgents('sr', entryId);
  srHasOfficial = list.length > 0;
  return srHasOfficial;
}