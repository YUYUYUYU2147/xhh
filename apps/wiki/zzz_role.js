// 绝区零角色详情卡：数据源为米游社百科（免 CK）
//
// 接口（ZZZ_HANDOFF.md 已实测）：
//   https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page
//     ?app_sn=zzz_wiki&entry_page_id={id}
//   必需 header：x-rpc-wiki_app: zzz、referer: https://baike.mihoyo.com/（根域名，带路径取不到）
//   数据在 data.page，modules 共 14 个。
//
// 关键事实：
//   - 列表接口的 content_id 就是 entry_page_id（实测 洛克茜 content_id=2152 → 详情 id=2152），
//     所以不需要单独维护 id 映射表。
//   - components[0].data 是 JSON 字符串，必须 parse；当成对象用会「抓到页面但字段全空」。
//   - 星级/属性/特性/阵营不在 ext.filter 里，而在 modules[0] 的 data 内：
//     grade、role_attribute、role_profession、addition_text、custom_field、tachie_pc。
//   - 属性成长数值官方接口不返回（官方为 JS 滑块），stats 只能留空由视图兜底。

import { fetchZzzBwikiChar } from './bwiki_zzz.js';

const API = 'https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page';
const LIST_API = 'https://act-api-takumi-static.mihoyo.com/common/blackboard/zzz_wiki/v1/home/content/list';
const HEADERS = {
  'x-rpc-wiki_app': 'zzz',
  'referer': 'https://baike.mihoyo.com/',
  'User-Agent': 'Mozilla/5.0',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CACHE_TTL = 12 * 3600 * 1000;
const cache = new Map();

/** 名称归一化：去掉装饰符与空格，与 list() 侧的匹配规则保持一致 */
export const zzzKey = v => String(v || '')
  .replace(/&amp;/g, '&')
  .replace(/[\s·・\-—_「」『』《》【】\[\]()]/g, '')
  .toLowerCase();

const modData = (m, idx = 0) => {
  const raw = m?.components?.[idx]?.data;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw && typeof raw === 'object' ? raw : {};
};

/** 角色 id 表：agent 频道列表，提供 name → entry_page_id */
export async function fetchZzzRoleIndex() {
  const key = 'idx:agent';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let list = [];
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${LIST_API}?app_sn=zzz_wiki&channel_id=43`, {
        headers: { 'referer': 'https://baike.mihoyo.com/', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!(r.headers.get('content-type') || '').includes('json')) { await sleep(1500); continue; }
      list = (await r.json())?.data?.list?.[0]?.list || [];
      break;
    } catch { await sleep(1500); }
  }
  const idx = new Map();
  for (const it of list) {
    const id = it?.content_id;
    if (!id) continue;
    for (const k of [it.title, it.alias_name, ...String(it.alias_name || '').split(/[、,，/|；;\s]+/)]) {
      const key2 = zzzKey(k);
      if (key2 && !idx.has(key2)) idx.set(key2, { id, title: it.title, icon: it.icon || '' });
    }
  }
  cache.set(key, { t: Date.now(), v: idx });
  return idx;
}

export async function fetchZzzRolePage(entryId) {
  const key = `page:${entryId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${API}?app_sn=zzz_wiki&entry_page_id=${entryId}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20000),
      });
      if (!(r.headers.get('content-type') || '').includes('json')) { await sleep(1500); continue; }
      const page = (await r.json())?.data?.page;
      if (page) { cache.set(key, { t: Date.now(), v: page }); return page; }
      await sleep(1200);
    } catch { await sleep(1500); }
  }
  return null;
}

const ATTR_CN = { wind: '风', electric: '电', ether: '以太', physical: '物理', fire: '火', ice: '冰' };
const PROF_CN = { strike: '强攻', pierce: '异常', support: '支援', rupture: '击破', abnormal: '异常', armor: '防护' };
const GRADE_CN = { 'S': 'S级', 'A': 'A级', 'B': 'B级' };

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', ndash: '–', mdash: '—' };
const decodeTxt = s => String(s || '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
  .replace(/&([a-z]+|#\d+);/gi, (m, n) => ENT[String(n).toLowerCase()] ?? m);

/**
 * 米游社文案里带两类未渲染的占位符，直接输出到卡面上：
 *   1) #{series_refskill_desc:JiText_SeriesSkillDescFormat,151129,2}
 *      —— 文本模板占位符，服务端本该替换成实际描述，返回的是原始串
 *   2) 「欢愉] 这类半边括号 —— 源数据里的脏字符
 * 两者都在这里清掉，否则影画/星魂描述会出现一大串代码。
 */
const cleanText = s => String(s || '')
  .replace(/#\{[^{}]*\}/g, '')
  .replace(/「([^」\]]{1,12})\]/g, '「$1」')
  .replace(/\[([^\]\n]{1,12})\]/g, '$1');

const plain = s => cleanText(s)
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<\/(p|li|tr)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

/**
 * 顶部 tag（属性/职业/阵营）的图标。
 * 原来 .tags 只渲染纯文字，所以「冰 / 强攻 / 维多利亚家政」三个只有字没有图。
 * 属性与职业在 resources/wiki/imgs/ 下有本地图标（zzz_*.png，共 11 个），直接挂；
 * 阵营（维多利亚家政、白祇亭…）没有本地图标，从下面 Bwiki 徽章里的阵营项复用。
 * 与 system/wiki.js 的 zzzIconMap 同源，新增属性时两边都要补。
 */
const TAG_ICON = {
  '物理': 'zzz_物理.png', '火': 'zzz_火.png', '冰': 'zzz_冰.png', '电': 'zzz_电.png',
  '以太': 'zzz_以太.png', '风': 'zzz_风.png', '强攻': 'zzz_强攻.png',
  '击破': 'zzz_击破.png', '异常': 'zzz_异常.png', '支援': 'zzz_支援.png',
  '防护': 'zzz_防护.png', '命破': 'zzz_命破.png'
};

/**
 * 顶部简介（.brief）过滤。
 * Bwiki 词条页的 desc 字段塞的是 SEO 关键词串，不是简介，例如：
 *   「文莲·乔,艾莲,鲨鱼,鲨鱼妹,艾莲技能,艾莲驱动盘,艾莲图鉴,…,深海访客,巡游,强攻,…」
 * 整串几十个短词用逗号拼在一起，一个句号都没有，渲染出来是顶部一大坨垃圾。
 * 真简介是成句的散文，必然带句末标点。所以判据是：
 *   没有任何句末标点（。！？；）却逗号/顿号很多 → 判为关键词串，丢弃。
 * 完整描述仍在下面的「角色详情」面板里，不会丢内容。
 */
const briefOf = s => {
  const t = plain(s);
  if (!t) return '';
  if (/[。！？；]/.test(t)) return t;
  const seps = (t.match(/[,，、]/g) || []).length;
  return seps >= 5 ? '' : t;
};

/**
 * 把 modules 归一成与星铁卡一致的字段结构，
 */
export function parseZzzRolePage(page, fallbackName = '', badgeIcons = null) {
  if (!page?.modules?.length) return null;
  const mods = page.modules;
  const m0 = modData(mods[0]);

  // ── 基础信息 ──
  const custom = {};
  for (const c of m0.custom_field || []) {
    if (c?.key && c?.value != null) custom[String(c.key).trim()] = String(c.value).trim();
  }
  const grade = GRADE_CN[String(m0.grade || '').trim()] || String(m0.grade || '').trim();
  const attr = ATTR_CN[String(m0.role_attribute || '').toLowerCase()] || String(m0.role_attribute || '');
  const profKey = String(m0.role_profession || '').toLowerCase();
  const prof = PROF_CN[profKey] || String(m0.role_profession || '');

  // ── 技能（modules[2]）──
  // 结构：list[].children[].growth[].children[].{name,header,row}
  const skills = [];
  for (const group of modData(mods[2]).list || []) {
    const kids = group?.children || [];
    for (const k of kids) {
      const lv = [];
      for (const g of k.growth || []) {
        const rows = [];
        for (const c of g.children || []) {
          const txt = (c.row || []).map(x => plain(x)).filter(Boolean).join('\n');
          if (txt) rows.push({ name: String(c.name || '').trim(), text: txt });
        }
        if (rows.length) lv.push({ grade: String(g.name || '').trim(), rows });
      }
      // 每组技能只保留最高等级那一档。
      // 绝区零一个角色有 9~17 组技能、每组 16 级，全展开实测页面高达 21317px，
      // 远超图片尺寸上限（Chromium 截图上限 65535px，且超过 4MB 发不出 QQ），
      // 玩家实际也只看满级数值 —— 与原神/星铁卡只给满级数值的做法一致。
      const maxLv = lv.length ? lv[lv.length - 1] : null;
      skills.push({
        type: String(group.tab_name || k.title || '').trim(),
        name: String(k.title || '').trim(),
        // 技能图标只在 animated_icon 上，icon 字段恒为 null
        icon: k.animated_icon || k.icon || '',
        desc: plain(k.desc || ''),
        levels: maxLv ? [maxLv] : [],
      });
    }
  }

  // ── 影画（modules[3]）──
  // 数据行字段是 `row`，不是 `list`（按 list 取会永远为空）。
  // 表头首格不固定：有的是「影画名称」，有的是「影画等级」，两种都要认。
  // 行首格形如「LEVEL1犯罪顾问」，需拆出等级与影画名。
  const achi = [];
  for (const t of modData(mods[3]).tables || []) {
    const header = (t.header || []).map(x => String(x || '').trim());
    if (!/影画(名称|等级)/.test(header[0] || '')) continue;
    for (const r of t.row || []) {
      const cells = (r || []).map(x => String(x || ''));
      if (!cells.length) continue;
      // 首格可能是纯文本，也可能是 <p>…<br>LEVEL1<br>全能执事</p>，
      // 先抽掉 HTML 标签，再按 LEVEL 数字拆分
      const first = plain(cells[0]).replace(/\s+/g, ' ').trim();
      if (!first) continue;
      const m = first.match(/LEVEL\s*(\d+)\s*(.*)$/i);
      achi.push({
        level: m ? `Lv.${m[1]}` : '',
        name: (m ? m[2] : first).trim(),
        effect: plain(cells.slice(1).join('\n')),
      });
    }
  }
  // ── 信赖度（modules[6]，绝区零特有：提升信赖至友好/亲近/信赖可领取）──
  const trust = [];   // 信赖度暂不进卡面（内容冗长且与养成材料重复），保留解析以备后用
  for (const t of modData(mods[6]).tables || []) {
    const header = (t.header || []).map(x => String(x || '').trim());
    if (!/信赖/.test(header.join(''))) continue;
    for (const r of t.row || []) {
      (r || []).forEach((cell, i) => {
        const txt = plain(cell);
        const img = (String(cell).match(/data-entry-img="([^"]+)"/) || [])[1] || '';
        if (txt || img) trust.push({ stage: header[i] || '', text: txt, icon: img });
      });
    }
  }

  // ── 养成材料（modules[8]）──
  // 交接文档称「该模块只给说明文案」，实测不成立：它同时含材料数据。
  // 结构：list[0].children[0].growth[] 共 8 档，档名依次为
  //   总计 / 初始 / 10 / 20 / 30 / 40 / 50 / 满级
  // 每档 children[0].row 是一组 HTML 片段，材料以 data-entry-* 挂在标签上：
  //   data-entry-name（名称）、data-entry-amount（数量）、
  //   data-entry-img（图标）、data-entry-grade（稀有度）
  // 「总计」档即卡面要展示的养成消耗总计。
  // row 的层级不稳定：有时 row[i] 直接是 HTML 字符串，有时是只含键 "0" 的对象，
  // 递归取值避免依赖具体层级。
  const flattenText = v => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(flattenText).join('\n');
    if (typeof v === 'object') return Object.values(v).map(flattenText).join('\n');
    return '';
  };
  // 以 data-entry-name 为锚点，在**同一个标签**内取其余属性。
  // 不用单条正则串起 name→amount→img：属性顺序在不同条目里并不一致，
  // 一旦中间夹了 `>` 就会整条失配（实测导致材料解析结果恒为 0）。
  const parseMats = raw => {
    const html = flattenText(raw);
    const out = [];
    const tagRe = /<[^>]*data-entry-name="[^"]*"[^>]*>/g;
    let tm;
    while ((tm = tagRe.exec(html))) {
      const tag = tm[0];
      const name = decodeTxt((tag.match(/data-entry-name="([^"]*)"/) || [])[1] || '');
      if (!name) continue;
      // 数量有两个来源：认证章/记录类写在 data-entry-amount，
      // 芯片类（基础/进阶/特化冰结芯片等）只写在 data-entry-desc，
      // 实测芯片类 amount 为 undefined，需回落到 desc，否则数量整列为空。
      const num = (tag.match(/data-entry-amount="([^"]*)"/) || [])[1]
        || (tag.match(/data-entry-desc="([^"]*)"/) || [])[1] || '';
      const img = (tag.match(/data-entry-img="([^"]*)"/) || [])[1] || '';
      const grade = (tag.match(/data-entry-grade="([^"]*)"/) || [])[1] || '';
      out.push({
        name,
        num: String(num).trim(),
        icon: String(img).split('?')[0],
        grade: String(grade).trim(),
      });
    }
    return out;
  };

  const matList = modData(mods[8]).list || [];
  const matStages = [];
  for (const grp of matList) {
    for (const child of grp?.children || []) {
      for (const g of child?.growth || []) {
        const stage = String(g?.name || '').trim();
        const rows = g?.children?.[0]?.row || [];
        const mats = parseMats(rows);
        if (stage && mats.length) matStages.push({ stage, mats });
      }
    }
  }
  const matTotal = matStages.find(s => s.stage === '总计')?.mats || [];

  // ── 角色详情 / 印象 / CV ──
  const detailStory = plain(modData(mods[1]).rich_text || '');
  const impression = plain(modData(mods[5]).rich_text || '');
  const cv = plain(modData(mods[10]).rich_text || '');
  const story = plain(modData(mods[12]).rich_text || '');

  // 徽章图标：属性/特性用本地图标，稀有度/阵营取自 Bwiki（见 fetchZzzBadgeIcons）
  const badges = buildBadges({ grade, attr, prof, camp: String(m0.addition_text || '').trim(), custom, icons: badgeIcons });

  // ── 技能按类型合并 ──
  // 官方把一个技能拆成多条（分支/变体）：闪避类含闪避、冲刺、冲刺攻击、闪避反击；
  // 支援技含快速支援、招架支援、支援突击；特殊技含特殊技与强化特殊技；
  // 终结技含连携技与终结技；核心技含核心被动与额外能力。
  // 实测一个角色 16~17 条，按类型合并后正好 6 类（普攻 / 闪避 / 支援技 / 特殊技 / 终结技 / 核心技），
  // 与原神「6 个技能 + 每个有延伸」的结构一致，卡面高度大幅下降。
  const SKILL_ORDER = ['普攻', '闪避', '支援技', '特殊技', '终结技', '核心技'];
  const grouped = new Map();
  for (const s of skills) {
    const t = String(s.type || '').replace(/[:：]/g, '').trim() || '其他';
    if (!grouped.has(t)) grouped.set(t, []);
    grouped.get(t).push({
      name: s.name,
      desc: s.desc,
      levels: s.levels,
      // icon 必须一起带上：下面 skillGroups 用 branches[0].icon 当组图标，
      // 这里漏掉的话整组技能图标全空（模板只认 group.icon）。
      icon: s.icon || '',
    });
  }
  const skillGroups = [
    ...SKILL_ORDER.filter(t => grouped.has(t)).map(t => ({ type: t, icon: grouped.get(t)[0]?.icon || '', branches: grouped.get(t) })),
    ...[...grouped.entries()].filter(([t]) => !SKILL_ORDER.includes(t)).map(([t, v]) => ({ type: t, icon: v[0]?.icon || '', branches: v })),
  ];

  return {
    name: fallbackName || page.name || '',
    fullName: page.name || '',
    icon: page.icon_url || '',
    // 方形透明人物卡面，正方形大图，用作详情页头像；
    // 同一张也用来当整卡背景（bg），所以单独留一份字段名
    portrait: m0.tachie_pc || '',
    tachie: m0.tachie_pc || m0.tachie_m || '',
    desc: briefOf(page.desc || ''),
    rarity: grade,
    damage: attr,
    profession: prof,
    camp: String(m0.addition_text || '').trim(),
    damageIcon: TAG_ICON[attr] || '',
    professionIcon: TAG_ICON[prof] || '',
    // 阵营复用 Bwiki 徽章里的阵营图标，徽章没带图标时留空，模板会自动退回纯文字
    campIcon: (badges || []).find(b => String(b?.k || '').includes('阵营'))?.iconUrl || '',
    custom,
    badges,
    detailStory,
    impression,
    cv,
    story,
    skills,
    skillGroups,
    achi,
    trust,
    // 养成消耗总计（materials）与各档位（matStages）
    materials: matTotal,
    matStages,
    // 职级晋升的档位名称（总计/初始/10…/满级），属性成长数值官方不返回，此处只留档位
    stages: matStages.map(s => s.stage),
    gacha: null,
  };
}

/** 按角色名取详情卡数据；取不到返回 null */
export async function fetchZzzRoleCard(name) {
  const idx = await fetchZzzRoleIndex();
  const hit = idx.get(zzzKey(name));
  if (!hit) return null;
  const page = await fetchZzzRolePage(hit.id);
  if (!page) return null;
  const badgeIcons = await fetchZzzBadgeIcons().catch(() => null);
  const d = parseZzzRolePage(page, hit.title, badgeIcons);
  // 顶部徽章改以 Bwiki 为主：米游社 modules[0] 缺种族、伤害类型、全名英文、
  // 实装日期、常驻限定这 5 项，而 Bwiki 的角色 infobox 十二项齐全且多数自带图标。
  // 属性与特性图标仍用本仓库的 zzz_*.png（与列表页同一套），其余用 Bwiki 图标。
  // Bwiki 页名是简称（「艾莲」），而列表给的是全名（「艾莲·乔」），
  // 直接用全名会取不到页面，徽章就仍是米游社那 6 项。逐个候选尝试。
  const bwName = [String(hit.title || '').split(/[·・]/)[0].trim(), name, hit.title].filter(Boolean);
  let bw = null;
  for (const cand of bwName) {
    bw = await fetchZzzBwikiChar(cand).catch(() => null);
    if (bw?.badges?.length) break;
  }
  if (bw?.badges?.length) {
    const LOCAL_ICON_NAME = {
  '物理': 'zzz_物理.png', '火': 'zzz_火.png', '冰': 'zzz_冰.png', '电': 'zzz_电.png',
  '以太': 'zzz_以太.png', '风': 'zzz_风.png', '强攻': 'zzz_强攻.png', '击破': 'zzz_击破.png',
  '异常': 'zzz_异常.png', '支援': 'zzz_支援.png', '防护': 'zzz_防护.png', '命破': 'zzz_命破.png',
  };
    // 「伤害类型」（斩击/贯穿/冲击/感电）**不要**塞本地的 zzz_物理.png：
    // 那是个属性图标，语义不对，而且它是细线条透明 PNG，20px 下几乎看不见。
    // Bwiki 那一格自带「图标-斩击.png」，直接用它自己的图。
    d.badges = bw.badges.map(b => {
      if (b.k === '属性' || b.k === '特性') {
        const f = LOCAL_ICON_NAME[b.k === '属性' ? b.v : b.v];
        if (f) return { ...b, icon: f, iconUrl: false };
      }
      return b;
    });
  }
  // 伤害类型图标**保持 Bwiki 原图**，不再做任何加工。
  // 试过三套方案都失败：CSS filter 压暗→半透明灰影；垫深色底托→阵营/稀有度
  // 一起变黑；sharp 加固填金色→金底上完全看不见。
  // 既然怎么改都不好看，就回归原图：看不见总比错色好。

  // 阵营图标跟着徽章一起换成 Bwiki 的：
  // campIcon 原先只在 parseZzzRolePage 里从**米游社**徽章取，
  // 而米游社那个阵营格没有图标 → 维多利亚家政这类阵营图标永远是空的。
  // Bwiki 的阵营格自带 Logo-阵营图标-*.png，这里在替换徽章后同步补一次。
  if (bw?.badges?.length) {
    const cb = d.badges.find(b => String(b?.k || '').includes('阵营'));
    if (cb?.icon && cb.iconUrl !== false) d.campIcon = cb.icon;
  }

  // 技能图标：米游社那边的 icon 字段给的是游戏内资源名，拼出来的 URL 多数取不到，
  // 改用 Bwiki 角色页里的「技能-{技能名}图标.png」原图，按技能名对上即可。
  // 组图标取 branches[0].icon，缺失时回落到同名技能图标。
  if (bw?.skillIcons && Object.keys(bw.skillIcons).length) {
    // 米游社那边有两套叫法，和 Bwiki 的「技能-{名}图标.png」对不上：
    //   分组名「普攻」            ↔ Bwiki「普通攻击」（实测就是这一个没对上，
    //                              普攻组回落到米游社的 .gif 才显示错）
    //   分支名「普通攻击：利齿修剪法」↔ 去掉「：后半段」才是「普通攻击」
    //   冲刺 / 冲刺攻击 / 闪避反击  ↔ 闪避；支援突击/快速支援/招架支援 ↔ 支援技
    const aliases = {
      普攻: '普通攻击', 普通攻击: '普通攻击',
      冲刺: '闪避', 冲刺攻击: '闪避', 闪避反击: '闪避', 闪避: '闪避',
      终结技: '连携技', 连携技: '连携技',
      特殊技: '特殊技', 强化特殊技: '强化特殊技',
      支援突击: '支援技', 快速支援: '支援技', 招架支援: '支援技', 支援技: '支援技',
      核心技: '核心技', 被动: '核心技',
    };
    const pick = name => {
      const base = String(name || '').split(/[：:]/)[0].trim();
      return bw.skillIcons[base] || bw.skillIcons[aliases[base]] || '';
    };
    for (const g of d.skillGroups || []) {
      // Bwiki 优先：米游社给的 icon 是游戏内资源名，拼出来的 URL 要么取不到、
      // 要么张冠李戴（普攻图标显示成别的技能），所以有 Bwiki 就直接覆盖。
      for (const br of g.branches || []) br.icon = pick(br.name) || br.icon || '';
      g.icon = pick(g.type) || g.branches?.[0]?.icon || '';
    }
  }
  // 整卡背景图：立绘（tachie）铺满整卡。
  // 必须在下面把 portrait 换成方形头像**之前**取，否则背景会变成 90px 的方头像。
  d.bg = d.tachie || bw?.tachie || '';
  // 顶部头像：Bwiki 的「角色头像-{名}.png」是方形卡面，
  // 米游社的 tachie_pc 是竖版立绘 —— 方形头像框里塞竖版立绘会变形。
  if (bw?.avatar) d.portrait = bw.avatar;

  // 角色详情改用 Bwiki「详细情报」（bw.profile），不用米游社的
  // 角色故事+角色印象拼接 —— 后者体量大且与其它板块措辞大量重复，
  // 是卡面「角色详情」那一栏字数爆炸的主因。Bwiki 缺失时才回落米游社。
  // 基础属性：Bwiki「属性数据」（米游社官方是 JS 滑块，接口不返回数值）
  if (bw?.baseStats) d.baseStats = bw.baseStats;
  if (bw?.profile) {
    d.detailStory = bw.profile;
    d.impression = '';
  }
  d.guide = bw?.guide || null;
  if (!d) return null;
  // 卡池单独取（Bwiki 往期调频），与详情分属两个数据源，互不干扰。
  // 取不到不影响出图，只是没有卡池栏。
  const alias = String(hit.title || '').split(/[·・]/)[0].trim();
  const gacha = await fetchZzzGacha([hit.title, alias, name]).catch(() => []);
  return { ...d, entryId: hit.id, listIcon: hit.icon, gacha };
}


/* ══════════════ 卡池信息（Bwiki 往期调频）══════════════
   绝区零角色页不含卡池，Bwiki 也没有「卡池一览」结构化页，
   但「往期调频」页逐期列出了独家频段信息，正是所需：
     https://wiki.biligame.com/zzz/往期调频
   实测 69 期，每期含：独家频段/音擎频段标题、时间（起止）、版本、
   S级代理人、A级代理人。角色写作「洛克茜（击破·风）」，
   即「简称（特性·属性）」，A 级为多条、换行分隔。

   数据源与角色详情分开取：详情来自米游社百科，卡池来自 Bwiki，
   两者接口与数据格式互不干扰。
   注意：两边编号体系不通用（官方 content_id 与 Bwiki 不同），
   因此只能按角色名匹配，不能按 id。 */

const PERIOD_API = 'https://wiki.biligame.com/zzz/api.php';

/* ══════════════ 徽章图标 ═══════════════
   属性与特性图标用本仓库自带资源（resources/wiki/imgs/zzz_*.png，共 12 个：
   6 属性 物理/火/冰/电/以太/风 + 6 特性 强攻/击破/支援/异常/防护/命破），
   与列表页 system/wiki.js 的 zzzIconMap 是同一套，不重复上传。
   稀有度与阵营图标本仓库没有，取自 Bwiki「角色图鉴」页：
     角色稀有度{S,A,B}.png          → 稀有度
     Logo-阵营图标-{阵营名}.png      → 阵营
   两个数据源这样分工：内容取米游社百科（更新更快，角色最全），
   缺什么图标再从 Bwiki 补，互补而非二选一。 */

const LOCAL_ICON = {
  '物理': 'zzz_物理.png', '火': 'zzz_火.png', '冰': 'zzz_冰.png', '电': 'zzz_电.png',
  '以太': 'zzz_以太.png', '风': 'zzz_风.png',
  '强攻': 'zzz_强攻.png', '击破': 'zzz_击破.png', '异常': 'zzz_异常.png',
  '支援': 'zzz_支援.png', '防护': 'zzz_防护.png', '命破': 'zzz_命破.png',
};

/** Bwiki 图标：{ 归一化key → 原图URL }，覆盖角色稀有度与阵营 Logo */
export async function fetchZzzBadgeIcons() {
  const key = 'badgeIcons';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  const map = { grade: {}, camp: {} };
  // 用 allimages 按文件名前缀取，比解析页面稳（页面上不一定引用了全部图标）
  for (const [prefix, bucket, re] of [
    ['角色稀有度', 'grade', /^角色稀有度\s*([SAB])$/i],
    ['Logo-阵营图标-', 'camp', /^Logo-阵营图标-(.+)$/],
  ]) {
    for (let i = 0; i < 2; i++) {
      try {
        const u = `${PERIOD_API}?action=query&list=allimages&aiprefix=${encodeURIComponent(prefix)}&ailimit=60&format=json`;
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
        if (!(r.headers.get('content-type') || '').includes('json')) { await sleep(1200); continue; }
        for (const it of (await r.json())?.query?.allimages || []) {
          const nm = decodeTxt(it.name).replace(/\.png$/i, '');
          const m = nm.match(re);
          if (!m) continue;
          const url = srOrigIconLocal(it.url);
          if (bucket === 'grade') map.grade[m[1].toUpperCase()] = url;
          else { const k = zzzKey(m[1]); if (k && !map.camp[k]) map.camp[k] = url; }
        }
        break;
      } catch { await sleep(1200); }
    }
  }
  cache.set(key, { t: Date.now(), v: map });
  return map;
}

// 缩略图 → 原图（与 bwiki_gs 的 srOrigIcon 同规则，就地实现避免跨文件依赖）
const srOrigIconLocal = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');

/** 组装徽章：value 为纯文本，icon/iconUrl 决定模板取本地图标还是远程 URL */
function buildBadges({ grade, attr, prof, camp, custom, icons }) {
  const g = String(grade || '').trim();                       // S级 / A级 / B级
  const gKey = g.replace(/级$/, '').toUpperCase();
  const out = [];
  if (g) out.push({ k: '稀有度', v: g, icon: icons?.grade?.[gKey] || '', iconUrl: true });
  if (attr) out.push({ k: '属性', v: attr, icon: LOCAL_ICON[attr] || '', iconUrl: false });
  if (prof) out.push({ k: '特性', v: prof, icon: LOCAL_ICON[prof] || '', iconUrl: false });
  if (camp) {
    const ck = zzzKey(camp);
    const hit = icons?.camp ? Object.entries(icons.camp).find(([k]) => k === ck || ck.includes(k) || k.includes(ck)) : null;
    out.push({ k: '阵营', v: camp, icon: hit?.[1] || '', iconUrl: !!hit });
  }
  if (custom?.['出生日期']) out.push({ k: '出生日期', v: String(custom['出生日期']).trim(), icon: '', iconUrl: false });
  if (custom?.['身高']) out.push({ k: '身高', v: String(custom['身高']).trim(), icon: '', iconUrl: false });
  return out.filter(b => b.v);
}


/** 「洛克茜（击破·风）」→「洛克茜」+ 特性 + 属性 */
const splitGachaName = raw => {
  const t = decodeTxt(String(raw || '')).replace(/[［］\[\]]/g, '').trim();
  const m = t.match(/^(.+?)[（(](.+?)[)）]\s*$/);
  if (!m) return { name: t, profession: '', damage: '' };
  const inner = m[2].split(/[·・]/).map(x => x.trim()).filter(Boolean);
  return { name: m[1].trim(), profession: inner[0] || '', damage: inner[1] || '' };
};

/**
 * @param {string|string[]} name 角色名。列表侧给的是全名（如「洛克茜·伊芙莉塔·普莱斯」），
 *   而往期调频页写的是简称（「洛克茜」），所以允许传多个候选名，命中任一即算匹配。
 */
export async function fetchZzzGacha(name) {
  const key = 'gacha:往期调频';
  let periods = cache.get(key);
  if (!(periods && Date.now() - periods.t < CACHE_TTL)) {
    periods = null;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(`${PERIOD_API}?action=parse&page=${encodeURIComponent('往期调频')}&prop=text&format=json&redirects=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000),
        });
        if (!(r.headers.get('content-type') || '').includes('json')) { await sleep(1500); continue; }
        const html = (await r.json())?.parse?.text?.['*'] || '';
        periods = { t: Date.now(), v: parseZzzPeriods(html) };
        cache.set(key, periods);
        break;
      } catch (e) {
        // Bwiki 有风控（实测会返 567 的 HTML 错误页），失败时静默返回 []
        // 会让「卡池信息」整栏消失且毫无线索，这里留一条日志便于区分
        // 「真没有卡池」和「被风控/网络失败」。
        console.log(`[xhh][ZZZ卡池] 往期调频抓取失败: ${e?.message || e}`);
        await sleep(1500);
      }
    }
  }
  if (!periods?.v) {
    console.log('[xhh][ZZZ卡池] 往期调频无可用数据，卡池栏将不显示');
    return [];
  }
  const keys = new Set((Array.isArray(name) ? name : [name]).filter(Boolean).map(zzzKey));
  if (!keys.size) return [];
  const hit = p => p.sRank.some(x => keys.has(zzzKey(x.name))) || p.aRank.some(x => keys.has(zzzKey(x.name)));
  return periods.v.filter(hit);
}

/** 往期调频页 → 期数列表 */
function parseZzzPeriods(html) {
  const tables = String(html || '').match(/<table class="wikitable">[\s\S]*?<\/table>/g) || [];
  const out = [];
  for (const t of tables) {
    const rec = {};
    let title = '';
    for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
      const cs = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]);
      if (cs.length < 2) continue;
      const k = plain(cs[0]).trim();
      // 单元格内 <br> 会被 plain 压成空格，这里先换成换行以便区分多条
      const raw = cs.slice(1).join('\n').replace(/<br\s*\/?>/gi, '\n');
      const v = plain(raw).replace(/\n{2,}/g, '\n').trim();
      if (k.startsWith('独家频段')) title = v.replace(/\n/g, '');
      if (k === '时间') rec.time = v.replace(/\n/g, ' ');
      if (k === '版本') rec.version = v.replace(/\n/g, ' ');
      if (k === 'S级代理人') rec.s = v;
      if (k === 'A级代理人') rec.a = v;
    }
    if (!rec.time || !rec.version) continue;
    const split = x => String(x || '').split('\n').map(plain).filter(Boolean).map(splitGachaName);
    out.push({
      title,
      time: rec.time,
      version: rec.version,
      sRank: split(rec.s),
      aRank: split(rec.a),
    });
  }
  return out;
}
