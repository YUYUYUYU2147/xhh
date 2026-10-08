// 星铁角色详情：Bwiki 数据源（wiki.biligame.com/sr）
//
// 页面结构（实测「三月七•存护」，14 张表 + 带 class 的技能块）：
//   表0  基础信息   稀有度 / 性别 / 全名 / 命途 / 战斗属性 / 阵营 / 常驻限定 / 实装日期 / TAG
//   表1  角色名（中英文）+ 立绘
//   表2  属性成长   等级 / 生命 / 攻击 / 防御（突破前·突破后两列）+ 速度 / 能量上限
//   表3  （同上表的续表，等级断点）
//   表4  其它信息   称号 / 昵称 / 派系 / 身份 / CV…
//   表5  角色详情（故事正文）
//   表6  星魂       名称 / 效果，6 条
//   表7+ 技能块    <div class="skill-more-box" data-skilltype="pugong|zhanji|…">
//                    .skill-mark 普攻/战技/终结技/秘技/天赋
//                    .skill-name img-tx2  技能图标 + 名称
//                    .skill-atk-type [单攻]   .skill-cost 能量恢复：20
//                    .skill-text 描述
//                    .skill-data-more table   详细属性 LV1..LVn
//   行迹属性加成  <div class="skill-small" data-skilltype="shuxingN"> 名称 / 数值
//
// 任何一块解析不出来就整体返回 null，由调用方回落 nanoka ——
// 宁可退回旧数据，也不能出一张缺块的卡。
import { tables, plain, decode } from './bwiki_gs.js';

const SR_API = 'https://wiki.biligame.com/sr/api.php';
// 24px/44px 缩略图 → 原图：/thumb/a/b/xxx.png/44px-名字.png → /a/b/xxx.png
const srOrigIcon = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');
const CACHE_TTL = 6 * 3600 * 1000;
const cache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 抓一个星铁页面并返回 { page, html }，跟随重定向（三月七 → 三月七•存护） */
async function fetchSrHtml(page, tries = 3) {
  const key = `html:${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const u = `${SR_API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&redirects=1`;
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      // EdgeOne 会返回 HTTP 200 但 body 是拦截页，必须校验 content-type
      if (!(r.headers.get('content-type') || '').includes('json')) { last = '拦截'; await sleep(1500 * (i + 1)); continue; }
      const j = await r.json();
      const text = j?.parse?.text?.['*'] || '';
      if (!text) { last = '空页'; await sleep(800); continue; }
      const real = j?.parse?.title || page;
      const v = { page: real, html: text };
      cache.set(key, { t: Date.now(), v });
      return v;
    } catch (e) {
      last = e?.message || String(e);
      await sleep(1200 * (i + 1));
    }
  }
  logger.debug?.(`[xhh][bwiki_sr] ${page} 抓取失败: ${last}`);
  return null;
}

/**
 * tables() 返回的是 [{ cells: [{ raw, v, colspan, rowspan }] }]。
 * 这里把它拍平成「每行 [{ t, img }]」，img 取该格首图 URL（材料/星级图要用）。
 */
function tableRows(tb) {
  // 传 HTML 片段时自己切一遍（技能块里的「详细属性」表不是顶层表，拿不到 tables() 的结果）
  if (typeof tb === 'string') {
    return [...tb.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(tr => [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
      .map(c => ({ t: plain(c[1]), img: ((c[1] || '').match(/<img[^>]*src="([^"]+)"/) || [])[1] || '' })));
  }
  const rows = Array.isArray(tb) ? tb : (tb?.rows || []);
  return rows.map(r => (r.cells || []).map(c => ({
    t: String(c.v ?? ''),
    img: ((c.raw || '').match(/<img[^>]*src="([^"]+)"/) || [])[1] || '',
  })));
}

/** 表0：基础信息。形如 ["稀有度","","性别","女"] 的两列结构 */
function parseBasic(rows) {
  const out = {};
  for (const r of rows) {
    for (let i = 0; i + 1 < r.length; i += 2) {
      const k = String(r[i].t || '').trim();
      if (k) out[k] = { v: String(r[i + 1].t || '').trim(), img: r[i + 1].img || '' };
    }
  }
  return out;
}

/** 表2/表3：属性成长。Bwiki 给的是「突破前/突破后」双列，模板要 base+add */
function parseGrowth(rows) {
  const out = [];
  const tail = { speed: '', spNeed: '' };
  // 第 0 行是表头，第 1 行是「突破前/突破后」子表头，从第 2 行开始是数据
  // 表尾两行是「速度」「能量上限」，各自 colspan=6
  for (const r of rows) {
    const k = String(r[0]?.t || '').trim();
    const v = String(r[1]?.t || '').trim();
    if (k === '速度') tail.speed = v;
    else if (k === '能量上限') tail.spNeed = v;
  }
  const dataRows = rows.filter(r => /^\d+$/.test(String(r[0]?.t || '').trim()));
  let lastPost = { hp: 0, atk: 0, def: 0 };
  for (const r of dataRows) {
    const level = Number(String(r[0].t).trim());
    const nums = r.slice(1).map(c => String(c.t || '').trim());
    // 顺序：生命突破前/后、攻击突破前/后、防御突破前/后
    const hpPre = nums[0], hpPost = nums[1] ?? nums[0];
    const atkPre = nums[2], atkPost = nums[3] ?? nums[2];
    const defPre = nums[4], defPost = nums[5] ?? nums[4];
    if (!hpPost && !atkPost) continue;
    // 突破后的值就是「基础 + 成长」，模板分两格显示，这里沿用旧版写法：
    // base = 突破前（初始值），add = 突破后 - 突破前 的差额
    const num = v => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
    // 80 级那行「突破后」在维基上是空的（和原神一样），沿用上一级的数值，
    // 直接当 0 会让 80 级基础属性显示成 0
    const has = v => String(v || '').trim() !== '' && String(v || '').trim() !== '-';
    if (has(hpPost)) lastPost = { hp: num(hpPost), atk: has(atkPost) ? num(atkPost) : lastPost.atk, def: has(defPost) ? num(defPost) : lastPost.def };
    const hpF = has(hpPost) ? num(hpPost) : lastPost.hp;
    const atkF = has(atkPost) ? num(atkPost) : lastPost.atk;
    const defF = has(defPost) ? num(defPost) : lastPost.def;
    const hpAdd = Math.max(0, hpF - num(hpPre));
    const atkAdd = Math.max(0, atkF - num(atkPre));
    const defAdd = Math.max(0, defF - num(defPre));
    out.push({
      level,
      hp: num(hpPre) + hpAdd,
      atk: num(atkPre) + atkAdd,
      def: num(defPre) + defAdd,
      hpBase: num(hpPre), hpAdd,
      atkBase: num(atkPre), atkAdd,
      defBase: num(defPre), defAdd,
      speed: '', crit: '', critDmg: '',
    });
  }
  return { rows: out, tail };
}

/** 技能块：skill-more-box[data-skilltype] */
function parseSkills(html) {
  const out = [];
  const re = /<div class="skill-more-box" data-skilltype="([^"]+)"[\s\S]*?(?=<div class="skill-more-box"|<div class="xingji-more"|$)/g;
  for (const m of html.matchAll(re)) {
    const box = m[0];
    const type = plain((box.match(/<div class="skill-mark">([\s\S]*?)<\/div>/) || [])[1] || '');
    if (!type) continue;
    const nameBox = (box.match(/<div class="skill-name[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '';
    const icon = (nameBox.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '';
    const name = plain(nameBox).replace(/^[^一-龥A-Za-z]+/, '').trim();
    const atkType = plain((box.match(/<div class="skill-atk-type">([\s\S]*?)<\/div>/) || [])[1] || '');
    const cost = plain((box.match(/<div class="skill-cost[^"]*">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '')
      || plain((box.match(/<div class="skill-cost[^"]*">([\s\S]*?)<\/div>/) || [])[1] || '');
    const desc = plain((box.match(/<div class="skill-text">([\s\S]*?)<\/div>/) || [])[1] || '');
    // 详细属性表：列头 LV1..LVn，行是各项数值 → 拼成「普攻伤害 50.0%→140.0%」这类摘要
    const lvTable = (box.match(/<div class="skill-data-more"[\s\S]*?<\/table>/) || [])[0] || '';
    let maxLevel = 0;
    const lvRows = tableRows(lvTable);
    if (lvRows.length) {
      const heads = lvRows[0].slice(1).map(c => String(c.t || '').replace(/[^\d]/g, '')).filter(Boolean);
      maxLevel = heads.length ? Math.max(...heads.map(Number)) : 0;
    }
    if (!name && !desc) continue;
    // 行迹那一堆（额外能力 / 属性加成）不是技能，卡面只展示六个主技能，
    // 属性加成单独走 traces
    const isTrace = /额外能力|属性加成/.test(type);
    out.push({ isTrace,
      type: atkType ? `${type} ${atkType}` : type,
      name,
      icon,
      maxLevel,
      desc: [cost, desc].filter(Boolean).join(' '),
    });
  }
  return out;
}

/** 星魂：表6（名称 / 效果） */
function parseRanks(rows) {
  const out = [];
  for (const r of rows.slice(1)) {
    const name = String(r[0]?.t || '').replace(/[ \s]+/g, ' ').trim();
    const desc = String(r[1]?.t || '').trim();
    if (!name || !desc) continue;
    out.push({ no: out.length + 1, name, desc, icon: r[0]?.img || '' });
  }
  return out;
}

/** 行迹属性加成：页面底部「行迹属性加成」汇总表，拼成「效果抵抗提高10%…」一行。 */
function parseTraceBonus(html) {
  const m = html.match(/<table[^>]*>[\s\S]*?<th[^>]*colspan=["']?6["']?>\s*行迹属性加成\s*<\/th>[\s\S]*?<\/table>/i);
  if (!m) return '';
  const table = m[0];
  const items = [];
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  for (const mm of table.matchAll(re)) {
    const name = plain(mm[1]).replace(/\s+/g, ' ').trim();
    const val = plain(mm[2]).trim();
    if (!name || !val) continue;
    items.push(`${name}${val}`);
  }
  return items.join('、');
}

/**
 * 培养材料。
 * 页面里材料格的结构是：
 *   <div class="sr-iconLarge item cailiao">
 *     <a title="掠夺的本能"><img …70px 缩略图…></a>
 *     <div class="sr-iconLTop">4</div>        ← 数量
 *     <div><a title="掠夺的本能"><font>掠夺的本能</font></a></div>
 *   </div>
 * 角色晋阶那张表带「总计」行，有总计就用总计（逐档累加容易和总计对不上，
 * 也不该把同一份材料算两遍）；技能/行迹晋阶表没有总计，按格累加。
 */
function parseMaterials(tbs) {
  // 两套材料格标记：角色晋阶用 sr-iconLarge（带 sr-iconLTop 数量角标 + font 名称），
  // 技能/行迹晋阶用 cailiaoxiao（数量直接放在下一个 <div> 里，名称在 a 的 title 上）。
  const MAT_RE = /<div class="sr-iconLarge item[^"]*"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<div class="sr-iconLTop">([\s\S]*?)<\/div>[\s\S]*?<font>([^<]*)<\/font>/g;
  const MAT_RE2 = /<div class="cailiaoxiao"><a[^>]*title="([^"]+)"[^>]*><img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<div>([\s\S]*?)<\/div>/g;
  const bag = new Map();
  const icons = new Map();
  for (const tb of tbs) {
    // tables() 返回的是「行数组」（每行 { cells: [...] }），不是 { rows }，
    // 这里统一成行数组再用，之前写成 tb.rows 拿到的永远是空数组。
    const rowsArr = Array.isArray(tb) ? tb : (tb?.rows || []);
    if (!rowsArr.length) continue;
    const rowRaw = r => (r.cells || []).map(c => c.raw || '').join('');
    // 「总计」是单独一行标签，材料数字在它**下一行** —— 直接拿标签行去解析当然什么都没有
    const totalIdx = rowsArr.findIndex(r => /^\s*总计/.test(String(r.cells?.[0]?.v || '')));
    const totalRow = totalIdx >= 0 ? rowsArr[totalIdx + 1] : null;
    // 有总计的表只取总计（逐档累加既容易和总计对不上，也不该把同一份材料算两遍）；
    // 技能/行迹晋阶表没有总计，整表累加。
    const scope = totalRow ? [rowRaw(totalRow)] : [rowsArr.map(rowRaw).join('')];
    for (const seg of scope) {
      for (const m of seg.matchAll(MAT_RE)) {
        const name = plain(m[3]);
        const qty = Number(String(m[2]).replace(/[^\d.]/g, '')) || 0;
        if (!name) continue;
        bag.set(name, (bag.get(name) || 0) + qty);
        icons.set(name, srOrigIcon(m[1]));
      }
      for (const m of seg.matchAll(MAT_RE2)) {
        const name = plain(m[1]);
        const qty = Number(String(m[3]).replace(/[^\d.]/g, '')) || 0;
        if (!name) continue;
        bag.set(name, (bag.get(name) || 0) + qty);
        icons.set(name, srOrigIcon(m[2]));
      }
    }
  }
  return [...bag.entries()]
    .map(([name, total]) => ({ name, total, icon: icons.get(name) || '', iconUrl: true }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 24);
}

/**
 * 角色故事：表5 是「标题行 / 内容行」交替的结构（和原神那边一样）。
 * 坑有两个：
 *   1) 正文格带 class="mw-collapsible" 且 style="display:none"，那是维基页面上
 *      「点击展开」的折叠状态。直接渲染到图里就是一片空白，必须把 display:none 去掉。
 *   2) 正文里用 <br /> 分段，转纯文本时要换成换行（模板那边 white-space:pre-line），
 *      不然整段挤成一行。
 */
function parseStories(tb) {
  // 标题格是 <th class="mw-customtoggle-chara_storyN">，正文格是 <td class="mw-collapsible">。
  // 两者都是「单格」，光看格数分不开（表5 全是单格行），必须看 class ——
  // 之前只看格数，结果正文行也被当成新标题，11 条故事里一半是正文。
  // 注意 tables() 只保留属性、不保留标签名，所以判据用「正文格必带 mw-collapsible」。
  const rows = (Array.isArray(tb) ? tb : []).map(r => {
    const cell = (r.cells || [])[0] || {};
    const attrs = String(cell.attrs || '');
    const v = String(cell.v || '').trim();
    // 标题：带 customtoggle 类（角色故事•一…），或是「角色详情」那种短标题且下一行是长正文
    // 正文：带 mw-collapsible 类（维基上的折叠态），或明显是长段落
    const collapsible = /mw-collapsible/.test(attrs);
    return {
      cells: r.cells || [],
      // 判据用「纯文本长度」最稳：标题都是「角色详情」「角色故事•一（解锁条件…）」
      // 这种 20 字以内的一行，正文都是上百字的长段落。
      // 之前拿 raw 长度卡 120，结果「角色详情」那条 116 字符的正文被判成了标题。
      isTitle: !collapsible && v.length <= 30,
      isBody: collapsible || v.length > 30,
      v,
    };
  });
  const toText = raw => decode(String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells;
    if (!rows[i].isTitle || cells.length !== 1) continue;
    const bodyRow = rows[i + 1];
    if (!bodyRow || !bodyRow.isBody || bodyRow.cells.length !== 1) continue;
    const title = String(cells[0].v || '').trim();
    const body = toText(bodyRow.cells[0].raw);
    if (!title || !body) continue;
    const m = title.match(/^(.*?)（解锁条件[：:]\s*(.+?)）\s*$/);
    out.push({
      title: m ? m[1].trim() : title,
      unlock: m ? m[2].trim() : '',
      body,
    });
  }
  return out;
}

/**
 * 卡池信息。页面结构：
 *   <div class="sr-collapse-title">UP次数：8次</div>
 *   <p><a>跃迁</a> - 4.3下半 </p><ul><li>2026/06/24 12:00 ~ 2026/07/14 15:00</li></ul>
 * 一个角色有多期，所以要全部抓出来；「跃迁」两个字包在 <a> 里，不能直接匹配文本。
 */
export function parseSrGacha(html) {
  const s = String(html || '');
  const upCount = Number((s.match(/sr-collapse-title[^>]*>UP次数[：:]\s*(\d+)\s*次/) || [])[1] || 0) || 0;
  const banners = [];
  const re = /<p>[\s\S]{0,120}?<\/a>\s*-\s*([\d.]+\s*[上中下]半?)\s*<\/p>\s*<ul><li>([^<]+)<\/li>/g;
  for (const m of s.matchAll(re)) {
    const version = m[1].replace(/\s+/g, ' ').trim();
    const period = plain(m[2]);
    if (version && period) banners.push({ version, period });
  }
  return banners.length ? { upCount, banners } : null;
}

/**
 * 纯函数：星铁角色页 HTML → sr_role_nk 模板要的 view。
 * 关键块（基础信息 / 属性成长 / 技能 / 星魂）缺任意一块就返回 null，整体回落 nanoka。
 */
export function parseSrRolePage(page, html) {
  const T = tables(html);
  if (T.length < 6) return null;
  const basic = parseBasic(tableRows(T[0]));
  const { rows: growth, tail: growthTail } = parseGrowth([...tableRows(T[2]), ...tableRows(T[3])]);
  // 表4「其它信息」：称号 / 昵称 / 派系 / 跃迁名 / 身份 / 体型 / 种族 / 短信签名 / CV…
  const other = {};
  for (const r of (T[4] || [])) {
    const cs = r.cells || [];
    for (let i = 0; i + 1 < cs.length; i += 2) {
      const k = String(cs[i].v || '').trim();
      // 表4 有些行是「值 值 值」的三列续行（如昵称/外号后面跟一串别名），
      // 所以值只取紧跟其后的第一个非空格，剩下的当同键的补充
      const v = String(cs[i + 1].v || '').trim();
      if (!k || !v) continue;
      // 卡池信息有独立面板（「所在位置」在维基上还是折叠的），都不该进顶部徽章
      if (/卡池信息|所在位置|TAG|卡池/.test(k)) continue;
      if (/昵称|外号|TAG|成就/.test(k)) other[k] = other[k] ? `${other[k]}、${v}` : v;
      else if (!other[k]) other[k] = v;
    }
  }
  const skills = parseSkills(html);
  const ranks = parseRanks(tableRows(T[6]));
  if (!basic['稀有度'] || !growth.length || !ranks.length) return null;
  // 80 级基础属性提到顶层，模板按「生命值/攻击力/防御力/速度」键值对展示
  const g80 = growth.find(g => g.level === 80) || growth[growth.length - 1] || {};
  const traceBonus = parseTraceBonus(html);

  const pick = k => basic[k]?.v || '';
  // 稀有度 / 命途 / 战斗属性 三格在维基上是「文字 + 24px 缩略图」，
  // 图标就在格子里（存护-白.png / 冰.png / 4星.png）。缩略图 URL 反解成原图。
  const cellIcon = k => srOrigIcon(basic[k]?.img || '');
  // 头像：页面里 alt 带「头像」的那张竖版图（160x188）。
  // 注意不能只匹配「{角色名}头像」——同页的推荐角色也会带「XXX竖版头像」，
  // 所以要挑 alt 里含本页角色名的那一张。
  const shortName = String(page).split('•')[0].trim();
  const avatar = (html.match(new RegExp(`<img[^>]*alt="[^"]*${shortName}[^"]*头像[^"]*"[^>]*src="([^"]+)"`)) || [])[1]
    || (html.match(/<img[^>]*alt="[^"]*头像[^"]*"[^>]*src="([^"]+)"/) || [])[1] || '';
  // 稀有度格子里放的是星级图片（alt="4星.png"），文本是空的，得从图片 alt 取
  const rarityText = `${pick('稀有度')}${basic['稀有度']?.img ? '' : ''}${((html.match(/<td>\s*<img[^>]*alt="([45]星)\.png"/) || [])[1] || '')}`;
  const starMatch = String(rarityText).match(/([45])\s*星/);
  const name = page;
  return {
    name,
    icon: avatar,
    rarity: starMatch ? `${starMatch[1]}星` : pick('稀有度'),
    // 命途/战斗属性带图标，Bwiki 表0 里就带着
    path: plain(pick('命途')).replace(/命途$/, '') || '',
    // 图标给的是完整 URL（维基的），所以带 Url 后缀让模板直接用；
    // nanoka 那条路给的是本地图标文件名（走 {{ppath}}），两者不能混用
    pathIcon: cellIcon('命途'),
    pathIconUrl: !!cellIcon('命途'),
    rarityIcon: cellIcon('稀有度'),
    gacha: parseSrGacha(html),
    // 顶部徽章：表0（稀有度/性别/全名/命途/属性/阵营/限定/实装日期）+ 表4（称号等）
    badges: [
      ['稀有度', String(rarityText).trim() || '', cellIcon('稀有度'), true],
      ['性别', pick('性别'), '', false],
      ['全名/本名', pick('全名/本名'), '', false],
      ['命途', plain(pick('命途')).replace(/命途$/, ''), cellIcon('命途'), true],
      ['战斗属性', plain(pick('战斗属性')).replace(/战斗属性$/, ''), cellIcon('战斗属性'), true],
      ['阵营', pick('阵营'), '', false],
      ['常驻/限定', pick('常驻/限定'), '', false],
      ['实装日期', pick('实装日期'), '', false],
      ...Object.entries(other)
        .filter(([, v]) => v)
        .map(([k, v]) => [k, v, '', false]),
    ].map(([k, v, icon, isUrl]) => {
      // 徽章值必须截断：表4 的「昵称/外号」动辄几十个别名，
      // .badge 是 white-space:nowrap 的，一个长值就能把整页撑到 6000+px 宽
      let val = String(v || '').trim();
      if (val.length > 26) val = `${val.slice(0, 26)}…`;
      return { k, v: val, icon, iconUrl: isUrl };
    }),
    rarityIconUrl: !!cellIcon('稀有度'),
    damage: plain(pick('战斗属性')).replace(/战斗属性$/, '') || '',
    damageIcon: cellIcon('战斗属性'),
    damageIconUrl: !!cellIcon('战斗属性'),
    camp: pick('阵营'),
    hp: g80.hp ?? '',
    atk: g80.atk ?? '',
    def: g80.def ?? '',
    // 暴击率/暴击伤害 Bwiki 不提供（成长表无此列），用星铁角色基础值兜底
    crit: g80.crit || '5%',
    critDmg: g80.critDmg || '50%',
    speed: growthTail.speed,
    spNeed: growthTail.spNeed,
    traceBonus,
    desc: (tableRows(T[5])[0] || []).map(c => c.t).filter(Boolean).join(' ').slice(0, 400),
    stories: parseStories(T[5]),
    // 卡面只放「角色详情」那一条；角色故事•一~四 太长，挪到「#角色名故事」指令
    detailStory: parseStories(T[5]).find(x => !/解锁条件/.test(x.title)) || null,
    // 卡面只留 80 级那一行：模板标题本来就写着「基础属性 · 80级」，
    // 把 1~80 全部列出来既占地方又让人以为看的是别的等级
    growth: growth.filter(g => g.level === 80),
    skills: skills.filter(s => !s.isTrace),
    // 行迹（额外能力 + 属性加成）当作天赋那一栏
    passives: skills.filter(s => s.isTrace).map(s => ({ name: `${s.type} ${s.name}`.trim(), desc: s.desc })),
    materials: parseMaterials(T.filter((_, i) => i === 3 || i >= 12)),
    recoLightcones: [],
    relicSets4: [],
    relicSets2: [],
    mainStats: [],
    subStats: [],
    ranks,
    _basic: basic,
  };
}

/** 抓一个星铁角色的 Bwiki 数据；失败返回 null */
export async function fetchSrRole(name) {
  const got = await fetchSrHtml(name, 2);
  if (!got) return null;
  return parseSrRolePage(got.page, got.html);
}

export { fetchSrHtml };