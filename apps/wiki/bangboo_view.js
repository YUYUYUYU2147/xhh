/**
 * 绝区零邦布卡数据合并：**Bwiki 词条 + 米游社词条**，字段名统一。
 *
 * 为什么两个都要：
 *   Bwiki（wiki.biligame.com/zzz/<名>）给：初始攻击力、伤害属性、实装版本、获取途径、
 *        技能块（含 LV1~LV10 详细属性表）、突破材料、阵营、TAG、卡池。
 *        但**没有「相关代理人/配队」** —— 页面上那些 `角色头像-*.png`
 *        是全站共用的代理人导航条（实测每个邦布页都一样）。
 *   米游社（baike.mihoyo.com/zzz/wiki/content/<id>/detail）给：基础属性五维数值
 *        （生命/攻击/防御/冲击/异常掌控，HTML 在 role_ascension 里）、
 *        技能（role_talent）、搭配组合+推荐理由（double_col_table）。
 *
 * 哪个缺就补哪个，两边都没有的字段留空（模板不渲染），不猜、不填占位。
 */
import { mihoyoItemAgents } from './mihoyo_agents.js';

const stripTags = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;|&amp;/g, v => (v === '&amp;' ? '&' : ' '))
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

const HEAD = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
  referer: 'https://baike.mihoyo.com/',
  'x-rpc-wiki_app': 'zzz',
  'x-rpc-language': 'zh-cn'
};

/** 米游社词条页 → 基础属性 / 技能 / 搭配组合 */
export async function fetchMihoyoBangboo(entryId) {
  const out = { stats: [], talents: [], teams: [] };
  if (!entryId) return out;
  let page = null;
  try {
    const r = await fetch(
      `https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page?app_sn=zzz_wiki&entry_page_id=${encodeURIComponent(entryId)}&lang=zh-cn`,
      { headers: HEAD, signal: AbortSignal.timeout(15000) }
    );
    if (!String(r.headers.get('content-type') || '').includes('json')) return out;
    page = (await r.json())?.data?.page;
  } catch {
    return out;
  }
  for (const mod of page?.modules || []) {
    for (const comp of mod?.components || []) {
      let d = null;
      try { d = JSON.parse(comp?.data || 'null'); } catch { continue; }
      // 基础属性：[{attr:[{key,value}]}]
      if (comp.component_id === 'role_ascension' && Array.isArray(d?.list)) {
        for (const row of d.list) {
          for (const a of row?.attr || []) {
            const k = stripTags(a.key || '');
            const v = stripTags(a.value || '');
            if (k && v && !out.stats.some(x => x.key === k)) out.stats.push({ key: k, value: v });
          }
        }
      }
      /* 技能：role_talent
         [{ tab_name:'主动技', title:'旱地猎鲨', desc:'…',
            children:[{ title, desc, growth:[…] }] }]
         「技能倍率」在 children[].growth 里（Bwiki 的技能块给的是 LV1~LV10 详细属性表，
         两边互补；这里把 growth 也带出去，卡上优先用米游社的倍率）。 */
      if (comp.component_id === 'role_talent' && Array.isArray(d?.list)) {
        for (const row of d.list) {
          const type = stripTags(row?.tab_name || '');
          const name = stripTags(row?.title || row?.tab_name || '');
          const desc = stripTags(row?.desc || row?.content || '');
          const kid = (row?.children || [])[0] || {};
          const growth = Array.isArray(kid.growth) ? kid.growth : [];
          if (type && !out.talents.some(x => x.type === type)) {
            out.talents.push({ type, name, desc, icon: row?.icon || '', growth });
          }
        }
      }
      // 搭配组合 / 推荐理由
      if (Array.isArray(d?.tables)) {
        for (const tb of d.tables) {
          const head = (tb?.header || []).map(v => String(v));
          const iName = head.findIndex(v => /搭配组合|推荐角色|角色名称/.test(v));
          const iWhy = head.findIndex(v => /推荐理由|推荐原因/.test(v));
          if (iName < 0) continue;
          for (const row of tb?.row || []) {
            const cell = String(row?.[iName] || '');
            // 一格里可能有多个角色（与驱动盘同理）
            const names = [...cell.matchAll(/data-entry-name="([^"]+)"/g)].map(m => m[1]);
            const icons = [...cell.matchAll(/data-entry-img="([^"]+)"/g)].map(m => m[1]);
            const reason = iWhy >= 0 ? stripTags(row?.[iWhy] || '') : '';
            if (names.length) {
              names.forEach((nm, i) => out.teams.push({ name: nm, icon: icons[i] || '', reason }));
            } else {
              const nm = stripTags(cell).split('\n')[0].slice(0, 12);
              if (nm) out.teams.push({ name: nm, icon: icons[0] || '', reason });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * 合并成统一视图。
 * @param {object} bw   Bwiki parseZzzBwikiBangboo 的产物
 * @param {object} my   fetchMihoyoBangboo 的产物
 */
/* 等级表只保留最高等级那一行（与角色卡同一口径）。
   邦布原本把 面板 / 面板·附加 / 技能倍率 / 技能面板 四个等级表全列，
   一张卡能拉到几千像素。序号型取值（lv 数字优先，其次从表头文字里取最大数字），
   都取不到就退化为原样返回，不丢数据。 */
function keepMaxLv(rows, keyOf) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || []
  const score = (r) => {
    const raw = keyOf ? keyOf(r) : r?.lv
    const n = Number(String(raw ?? '').replace(/[^\d.]/g, ''))
    return Number.isFinite(n) ? n : -1
  }
  const top = rows.reduce((a, b) => (score(b) >= score(a) ? b : a))
  return [top]
}

/* 技能倍率的每个数值格是若干 <p> 段落（伤害倍率 / 失衡倍率 / 冷却时间 各一段），
   <p> 为块级元素，逐段渲染会在卡面上竖排数行、占去大半张卡。
   合并为同一行：段间以全角空格分隔，去掉段落标签（段内的行内标记原样保留）。 */
function inlineParas(html) {
  return String(html || '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '　')
    .replace(/<\/?p[^>]*>/gi, '')
    .trim()
}

/* Bwiki 邦布面板把生命值 / 攻击力 / 防御力各拆成「突破前 / 突破后」两列。
   卡片只留最高等级一行，并排的两列已无意义（最高等级的「突破后」恒为空），
   这里按列对折成一个值：取「突破前」，为空（-）再退回「突破后」。
   仅当成对出现时折叠，避免误伤列数不成对的表。 */
function collapseBreakPairs(cells) {
  const list = Array.isArray(cells) ? cells : []
  if (list.length < 2 || list.length % 2) return list
  const pick = (v) => (v && v !== '-' ? v : '')
  const out = []
  for (let i = 0; i < list.length; i += 2) {
    const before = String(list[i] ?? '').trim()
    const after = String(list[i + 1] ?? '').trim()
    out.push(pick(before) || pick(after) || before || after)
  }
  return out
}

/* 搭配组合去重：同名角色只留一条（不同表格可能重复登记）。 */
function teamList(teams) {
  const seen = new Set()
  return (teams || []).filter(t => {
    const k = String(t?.name || '')
    //「暂无」这类占位（官方没写推荐时米游社会填字）不是角色，
    // 不然卡面会出现一个裂图 + 「暂无 暂无」的推荐理由
    if (!k || /^(暂无|无|待定|-+)$/.test(k) || seen.has(k)) return false
    seen.add(k); return true
  })
}

/* 推荐理由按内容归并：官方是「一组角色共用一句理由」，
   逐角色渲染会把同一句话重复 4 遍（用户实图）。相同理由合成一条，
   名字列表放前面，一眼能看出这句话在说哪些代理人。 */
function groupReasons(teams) {
  const map = new Map()
  for (const t of teams || []) {
    const why = String(t?.reason || '').trim()
    if (!why) continue
    if (!map.has(why)) map.set(why, [])
    map.get(why).push(t.name)
  }
  return [...map.entries()].map(([reason, names]) => ({ reason, names: [...new Set(names)] }))
}

export function buildBangbooView({ bw = {}, my = {}, name = '', icon = '', entryId = '', bgFile = '' }) {
  // 基础属性：Bwiki 给「初始攻击力」，米游社给五维；两边合并成一个表
  const stats = [];
  const keys = new Set((my.stats || []).map(x => String(x.key || '')))
  const pushStat = (k, v) => {
    if (!k || !v) return;
    if (stats.some(x => x.key === k)) return;
    stats.push({ key: k, value: String(v) });
  };
  for (const s of my.stats || []) {
    /* 米游社把 1 级基础值和「突破前 / 突破后」各档都列出来，19 行起步。
       基础属性只保留最高档（带「突破后」的那组），其余档位和下面「邦布面板」重复。 */
    const k = String(s.key || '');
    if (/^突破前/.test(k)) continue;
    if (!/^突破后/.test(k) && keys.has('突破后' + k)) continue;
    pushStat(k, s.value);
  }
  if (bw.atk) pushStat('初始攻击力', bw.atk);

  /* 技能：Bwiki 给技能块（含 LV1~LV10 详细属性表），米游游社给**技能倍率**（growth）。
     两边按类型（主动技/额外能力/邦布连携技）合并，缺哪部分留空。 */
  const byType = new Map();
  for (const t of bw.skills || []) {
    const key = t.type || t.name || '';
    if (!key) continue;
    byType.set(key, { type: t.type || '', name: t.name || '', desc: t.desc || '', panel: t.detailRows || [], growth: [] });
  }
  for (const t of my.talents || []) {
    const key = t.type || t.name || '';
    if (!key) continue;
    const cur = byType.get(key) || { type: t.type || '', name: t.name || '', desc: '', panel: [], growth: [] };
    if (!cur.desc && t.desc) cur.desc = t.desc;
    if (t.growth?.length) cur.growth = t.growth;
    if (!cur.name && t.name) cur.name = t.name;
    // 技能图标：米游社 role_talent 的 icon/animated_icon 是官方三个技能图标
    // （主动技/额外能力/邦布连携技 = a/b/c），Bwiki 那边没有
    if (t.icon) cur.icon = t.icon;
    byType.set(key, cur);
  }
  const talents = [...byType.values()];

  // 等级表只留最高等级：面板 / 面板·附加 / 技能倍率 / 技能面板
  // 最高等级行的「突破前 / 突破后」两列并排已无意义，折成一列（见 collapseBreakPairs）
  const panel = keepMaxLv(bw.panel, r => r?.lv).map(r => ({ ...r, cells: collapseBreakPairs(r.cells) }))
  // panelSub 就是 Bwiki 原样的数组形态；空的时候给 null，模板有 panelSub && 守卫
  const panelSub = keepMaxLv(bw.panelSub, r => r?.lv)
  const panelSubHead = bw.panelSubHead || []   // 属性名列名，别丢
  for (const t of talents) {
    if (Array.isArray(t.growth) && t.growth.length) {
      t.growth = keepMaxLv(t.growth, r => String(r?.name || '').replace(/^.*?(\d+)\s*级.*$/, '$1'))
      t.growthLv = t.growth[0]?.name || ''
      // 技能倍率各段合并到同一行（模板取 row[0][0] 原样输出该 HTML）
      for (const g of t.growth) {
        const cell = g?.children?.[0]?.row?.[0]
        if (Array.isArray(cell) && typeof cell[0] === 'string') cell[0] = inlineParas(cell[0])
      }
    }
    // 技能面板本身是一行一属性，保留（不是等级表）；若带 lv 列只留最高等级
    if (Array.isArray(t.panel) && t.panel.length && t.panel.every(r => Number.isFinite(Number(r?.lv))))
      t.panel = keepMaxLv(t.panel, r => r?.lv)
  }

  return {
    name: name || bw.name || '',
    icon: icon || bw.icon || '',
    rarity: bw.rarity || '',
    dmgType: bw.dmgType || '',
    rarityIcon: bw.rarityIcon || '',
    dmgIcon: bw.dmgIcon || '',
    version: bw.version || '',
    obtain: bw.obtain || '',
    camp: bw.camp || '',
    campAgent: '',            // 已改成结构化 teams，不再用会带 .png 的纯文本
    tags: bw.tags || '',
    story: bw.desc || '',
    stats,
    talents,
    teams: teamList(my.teams || []),
    // 米游社「搭配组合」一整行共用同一句推荐理由，逐个角色渲染会把同一句话重复 N 遍
    teamReasons: groupReasons(my.teams || []),
    materials: bw.materials || [],
    materialTotal: bw.materialTotal || [],
    panel,
    panelSub,
    panelSubHead,
    entryId,
    bgFile
  };
}
