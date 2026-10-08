// 原神 Bwiki 角色页：渲染 HTML → 16 张表 → 结构化 JSON（第 1 步定稿版）
// 材料单元格结构：<img alt="霜盏花"> + 文本 "3"  → 名称取 alt，数量取相邻文本
import { writeFileSync, mkdirSync } from 'node:fs';

const API = 'https://wiki.biligame.com/ys/api.php';
mkdirSync('/tmp/opencode/out', { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function renderHtml(page, tries = 5) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { last = `HTTP ${r.status}`; await sleep(500 * (i + 1)); continue; }
      const j = await r.json();
      const t = j?.parse?.text;
      if (!t) { last = '无 parse.text'; await sleep(500); continue; }
      return typeof t === 'string' ? t : t['*'];
    } catch (e) { last = e.message; await sleep(500 * (i + 1)); }
  }
  throw new Error(`渲染失败：${last}`);
}

const ENT = { nbsp: ' ', ndash: '–', mdash: '—', times: '×', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = s => String(s || '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&([a-z]+|#\d+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const plain = s => decode(String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 材料单元格 → [{name, count, icon}]：名字来自 <img alt>，数量来自紧邻的纯文本数字 */
function parseMatCell(html) {
  const out = [];
  // 以 <img alt="NAME"> 为锚，锚之后、下一个锚之前的纯文本里的第一个数字即数量
  const imgs = [...html.matchAll(/<img[^>]*alt="([^"]*)"[^>]*>/gi)];
  for (let i = 0; i < imgs.length; i++) {
    const name = decode(imgs[i][1]).replace(/\.png$/i, '').trim();
    if (!name) continue;
    const start = imgs[i].index + imgs[i][0].length;
    const end = i + 1 < imgs.length ? imgs[i + 1].index : html.length;
    // 数量：锚点后紧邻的数字（允许「×」和空格），如 "3 毁损机轴×6"
    const after = plain(html.slice(start, end));
    const num = after.match(/^[\s×:]*([\d][\d,.]*\s*万?)/);
    const icon = (imgs[i][0].match(/src="([^"]+)"/i) || [])[1] || '';
    // 同一格里有 hidden-xs / hidden-sm 两套 DOM（移动端与桌面端各一份），
    // 名字完全相同。同一格里按名字去重，只留第一次出现的数量。
    const dup = out.find(o => o.name === name);
    if (dup) { if (!dup.icon && icon) dup.icon = icon; continue; }
    out.push({ name, count: num ? num[1].replace(/\s/g, '') : null, icon });
  }
  return out;
}

/** 单元格数组 → 材料数组（汇总所有单元格） */
function matsOf(cellsHtml) {
  const all = [];
  for (const h of cellsHtml) all.push(...parseMatCell(h));
  return all;
}

/** 纯键值表：第 0 列是键 */
function kvTable(rows) {
  const o = {};
  for (const r of rows) {
    if (!r.cells.length) continue;
    const k = r.v0;
    if (!k) continue;
    // 值格里的文字标签和 <img alt> 往往重复（例：所属地区那格是
    // 「挪德卡莱」图标 + 「挪德卡莱」文字，且 hidden-xs / hidden-sm 两套 DOM 各一份），
    // 直接取纯文本会得到「挪德卡莱 挪德卡莱」。这里按文字去重。
    const vals = [];
    for (const c of r.cells.slice(1)) {
      // 有些格「图标 alt + 文字」并存（月之轮是「雷 元素」、武器类型是「长柄武器 武器使用」，
      // 稀有度则只有图标没文字）。alt 是规范名称，文字是冗余的补充说明，
      // 所以有图标就取 alt，否则退回纯文本。
      const alts = [...c.raw.matchAll(/<img[^>]*alt="([^"]*)"[^>]*>/gi)]
        .map(m => decode(m[1]).replace(/\.png$/i, '').trim())
        .filter(Boolean);
      const picked = alts.length ? [...new Set(alts)] : [];
      if (!picked.length) {
        // smwttcontent 是 Semantic MediaWiki 的悬浮提示，月之轮格里塞着
        // 「元素」、武器类型格里塞着「武器使用」，这些是注解不是数据，取值前要剔掉。
        const v = plain(c.raw.replace(/<span class="smwttcontent">[\s\S]*?<\/span>/gi, ''));
        if (v) picked.push(v);
      }
      for (const v of picked) if (!vals.includes(v)) vals.push(v);
    }
    o[k] = vals.length === 1 ? vals[0] : vals;
  }
  return o;
}

// 键值表里带图标的字段：把 <img> 抓出来单独存一份，渲染时要显示。
// 同一格里 hidden-xs / hidden-sm 两套 DOM 会重复给同一个 alt，按 alt 去重。
function kvIcons(rows) {
  const o = {};
  for (const r of rows) {
    if (!r.cells.length || !r.v0) continue;
    const list = [];
    for (const c of r.cells.slice(1)) {
      for (const m of c.raw.matchAll(/<img[^>]*alt="([^"]*)"[^>]*>/gi)) {
        const name = decode(m[1]).replace(/\.png$/i, '').trim();
        if (!name || list.some(x => x.name === name)) continue;
        list.push({ name, icon: (m[0].match(/src="([^"]+)"/i) || [])[1] || '' });
      }
    }
    if (list.length) o[r.v0] = list;
  }
  return o;
}

function tables(html) {
  return [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(m => {
    const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => {
      const cs = [...r[0].matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/gi)].map(c => ({
        raw: c[2], attrs: c[1] || '',
        colspan: Number((c[1].match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1),
        rowspan: Number((c[1].match(/rowspan\s*=\s*"?(\d+)/i) || [])[1] || 1),
        v: plain(c[2]),
      }));
      return { cells: cs, raw0: cs[0]?.raw || '', v0: cs[0]?.v || '' };
    });
    return rows;
  }).filter(r => r.length);
}

// 属性成长表。
// 这张表有两层表头，且第一个数据格带 colspan=2、等级格带 rowspan=2，
// 所以「按 colspan 横向展开」和「表头逻辑宽度」对不齐（暴击伤害那格同时
// rowspan=2 和 colspan=2，展开就多出一格，后面全错位）。
// 稳妥做法：先按表头算出每个属性的 before/after 在逻辑列上的位置，
// 再对数据行只做纵向跳过 rowspan 的展开。
function expandSkipRowspan(cells, width) {
  const out = [];
  for (const c of cells) {
    if (c.rowspan > 1) { out.push(c.v); continue; }   // 跨行格只占一列
    for (let i = 0; i < c.colspan; i++) out.push(c.v);
  }
  return out;
}
function parseGrowth(rows) {
  const KEY = {
    '生命上限': 'hp', '攻击力': 'atk', '防御力': 'def',
    '暴击伤害': 'bonus', '暴击率': 'critRate', '元素精通': 'em',
  };
  // 表头第 1 行：等级 | 生命上限(2) | 攻击力(2) | 防御力(2) | 暴击伤害(2,rowspan=2)
  const h1 = rows[0]?.cells || [];
  const h2 = rows[1]?.cells || [];
  // 属性 → [before列, after列] 的逻辑列号。等级占 1 列（rowspan=2，不展开）
  const map = {};
  let col = 0;
  for (const c of h1) {
    const name = String(c.v || '').replace(/\s/g, '');
    if (/等级/.test(name)) { col += 1; continue; }        // rowspan=2 → 只占 1
    const k = KEY[name];
    if (!k) { col += c.rowspan > 1 ? 1 : c.colspan; continue; }
    const n = c.rowspan > 1 ? 1 : c.colspan;             // 暴击伤害 rowspan=2 → 只占 1 逻辑列组
    map[k] = { before: col, after: col + (n > 1 ? 1 : 0) };
    col += n;
  }
  const out = [];
  for (const r of rows.slice(1)) {
    if (!/^\d+$/.test(r.v0)) continue;
    // 数据行：第 1 格是等级且 colspan=2，展开后从索引 1 开始才是 HP
    const cols = expandSkipRowspan(r.cells, col);
    const g = { level: Number(r.v0) };
    for (const [k, pos] of Object.entries(map)) {
      const b = (cols[pos.before] ?? '').trim();
      const a = (cols[pos.after] ?? '').trim();
      if (b || a) {
        g[k] = {};
        if (b && b !== '-') g[k].before = b;
        if (a && a !== '-') g[k].after = a;
      }
    }
    out.push(g);
  }
  return out;
}

// 突破表（表3 总计 + 表4 各档）：表头行给档位名，数据行按 colspan 分组
function parseAscend(rows) {
  const total = [], stages = [];
  let curLabels = null;
  for (const r of rows) {
    const v0 = r.v0;
    if (/共计需要/.test(v0)) {
      // 「0~90级共计需要」是带 colspan 的表头，材料在同一行的下一组格里；
      // 也有版本把它单独放一行。两种都兜住。
      for (const c of r.cells) total.push(...parseMatCell(c.raw));
      if (!total.length && rows[rows.indexOf(r) + 1]) {
        for (const c of rows[rows.indexOf(r) + 1].cells) total.push(...parseMatCell(c.raw));
      }
      continue;
    }
    if (/^\d+级$/.test(v0)) {                       // 表头：20级|40级|50级
      curLabels = r.cells.map(c => c.v);
      continue;
    }
    if (curLabels && r.cells.length) {              // 数据行：每格就是一个突破档位
      // 这张表的数据行第 0 格就是材料格（内容形如「20000 摩拉 1 最胜紫晶碎屑 3 霜盏花」），
      // 等级名只出现在上面的表头行里。原写法从 i=1 开始、并用 curLabels[i-1] 配对，
      // 于是整体错位一格：20000 摩拉那档被标成 40级，实际是 20级，6 阶也只认出 4 阶。
      // 「解锁天赋」行整行跳过：它是突破顺带解锁天赋的说明，不是突破档位。
      // 这行的图标 alt 是天赋名（如「寒冬的交响」），会被 parseMatCell 当成材料抓出来，
      // 所以不能靠「有没有材料」判断，得看这行本身是不是在讲解锁。
      if (/解锁天赋/.test(r.cells.map(c => c.raw).join(''))) continue;
      for (let i = 0; i < r.cells.length && i < curLabels.length; i++) {
        const cell = r.cells[i];
        const mats = parseMatCell(cell.raw);
        if (mats.length) stages.push({ level: curLabels[i], mats });
      }
      continue;
    }
    if (/解锁天赋/.test(v0)) continue;
  }
  return { total, stages };
}

// 技能详细属性表
function parseSkillTable(rows) {
  if (!rows.length) return null;
  const hdr = rows[0].cells.map(c => c.v);
  const lvCols = hdr.map((v, i) => (/^LV\d+$/i.test(v) ? i : -1)).filter(i => i >= 0);
  if (!lvCols.length) return null;
  const attrs = [];
  for (const r of rows.slice(1)) {
    const name = r.v0;
    if (!name) continue;
    const levels = {};
    for (const i of lvCols) { const v = r.cells[i]?.v; if (v) levels[hdr[i]] = v; }
    if (Object.keys(levels).length) attrs.push({ name, levels });
  }
  return attrs;
}

// 技能块：<div class="r-skill-title-1">技能名[ 解锁条件]</div> + <span class="r-skill-p">描述</span><br>正文</p>
// 一次拿到「名称 + 描述 + 解锁条件」，倍率表另走 parseSkillTable。
function parseSkillBlocks(html, tables = []) {
  const out = [];
  const parts = html.split(/(?=<div class="r-skill-title-1">)/);
  for (const blk of parts.slice(1)) {
    const hd = blk.match(/<div class="r-skill-title-1">([\s\S]*?)<\/div>\s*<div class="r-skill-bg-2">/)
      || blk.match(/<div class="r-skill-title-1">([\s\S]*?)<\/div>/);
    if (!hd) continue;
    // 标题里混着技能图标 <img alt="扈圣魔枪">，剥标签后剩「　扈圣魔枪 角色突破等级1解锁」
    const head = plain(hd[1]);
    const name = (head.match(/([^\s]{2,20}?)(?:\s*角色突破等级\d+解锁)?\s*$/) || [])[1] || head.trim();
    const unlock = (head.match(/角色突破等级(\d+)解锁/) || [])[0] || '';
    const dm = blk.match(/<span class="r-skill-p">描述<\/span>\s*<br\s*\/?>([\s\S]*?)<\/p>/);
    const desc = dm ? plain(dm[1]) : '';
    if (name) out.push({ name, unlock, desc, icon: (hd[1].match(/<img[^>]*src="([^"]+)"/) || [])[1] || '' });
  }
  // 技能与天赋在同一个数组里，靠位置区分。
  // 原先 render.mjs 用「对应表有没有 attrs」来分，那是间接推断：倍率表与技能块一一对应，
  // 于是 attrs 为空就判成天赋。菲林斯/甘雨/刻晴都恰好成立，但那是巧合——
  // 天赋本来就没有倍率表，一旦某个天赋也带属性表就会误判成技能。
  //
  // 页面结构是维基模板固定编排的：前若干个是主动技能（普攻/战技/爆发），
  // 之后全部是突破解锁的天赋。所以这里直接按位置切，不去猜。
  // 主动技能的个数取「有真实数值的倍率表」的数量（LV1..LVn 且首行非空），
  // 技能块数与倍率表数相等，差值即天赋数。
  const nTable = tables.filter(t => {
    const a = parseSkillTable(t);
    return a && a.length;
  }).length;
  const split = Math.min(nTable, out.length);
  out.forEach((b, i) => { b.kind = i < split ? 'skill' : 'passive'; });
  return out;
}

// 技能升级材料表：两列组（等级|材料 × 2），行内可能有「等级 所需材料 等级 所需材料」表头
function parseSkillMats(rows) {
  const out = [];
  for (const r of rows) {
    // 形如 1→2 | 材料格 | 6→7 | 材料格
    let i = 0;
    while (i < r.cells.length) {
      const lv = r.cells[i]?.v || '';
      if (/^\d+\s*→\s*\d+$/.test(lv.replace(/&[a-z]+;/gi, ''))) {
        const mats = i + 1 < r.cells.length ? parseMatCell(r.cells[i + 1].raw) : [];
        out.push({ level: lv.replace(/\s/g, ''), mats });
        i += 2;
      } else i++;
    }
  }
  // 去重（同一条在表15/表16 各出现一次）
  const seen = new Set();
  return out.filter(x => !seen.has(x.level) && seen.add(x.level));
}

/** 等级升级消耗表：每行一个等级段，整行只有一个格，形如
 *    「1~20级消耗 约 [大英雄的经验] × 6 与 [摩拉] × 2.4万」
 *  这里不能复用 parseMatCell：格内的 <a> 同时包着图标和文字标签，
 *  图标后面的纯文本是「名字 × N 与」而不是「N」，所以 parseMatCell
 *  「锚点后紧邻数字」那条规则匹配不上，得改成找「× N」。
 *  这张表和「突破材料」是两回事：突破看的是角色突破等级，等级消耗看的是 1→90 升级。 */
function parseLevelMats(rows) {
    const out = [];
    for (const r of rows) {
        const raw = r.raw0 || '';
        const txt = plain(raw);
        const lv = txt.match(/(\d+)\s*[~～]\s*(\d+)\s*级/);
        if (!lv) continue;
        const mats = [];
        const imgs = [...raw.matchAll(/<img[^>]*alt="([^"]*)"[^>]*>/gi)];
        for (let i = 0; i < imgs.length; i++) {
            const name = decode(imgs[i][1]).replace(/\.png$/i, '').trim();
            if (!name || mats.some(x => x.name === name)) continue;
            const start = imgs[i].index + imgs[i][0].length;
            const end = i + 1 < imgs.length ? imgs[i + 1].index : raw.length;
            const qty = plain(raw.slice(start, end)).match(/[×x*]\s*([\d][\d,.]*\s*万?)/i);
            const icon = (imgs[i][0].match(/src="([^"]+)"/i) || [])[1] || '';
            mats.push({ name, count: qty ? qty[1].replace(/\s/g, '') : null, icon });
        }
        if (!mats.length) continue;
        out.push({
            from: Number(lv[1]), to: Number(lv[2]),
            lv: `${lv[1]}~${lv[2]}级`,
            // 维基给的是取整后的量，实际消耗有零头，所以标一下「约」
            approx: /约/.test(txt),
            mats,
        });
    }
    return out;
}

// ── 主流程 ──
const page = process.argv[2] || '菲林斯';
const html = await renderHtml(page);
writeFileSync(`/tmp/opencode/out/${page}.html`, html);   // 存下来给渲染步骤复用，避免二次抓取
const T = tables(html);
const res = { page, tableCount: T.length };
console.log(`════ ${page}：${html.length} 字符 / ${T.length} 张表 ════\n`);

// gsRoleView 从 detail.materials 读材料，模板渲染也吃这个结构，
// 所以解析结果按「nanoka 那套键名」归拢到 materials 下。

if (T[0]) { res.basic = kvTable(T[0]); res.basicIcons = kvIcons(T[0]); }
if (T[1]) res.growth = parseGrowth(T[1]);
if (T[2]) { const a = parseAscend(T[2]); res.ascendTotal = a.total; res.ascendStages = a.stages; }
// 等级升级消耗表不按序号找（不同角色、不同版本表数和顺序都会变），
// 按内容里「N~M级消耗」的行来认。
const lvTbl = T.find(t => t.some(r => /\d+\s*[~～]\s*\d+\s*级\s*消耗/.test(r.v0 || '')));
if (lvTbl) res.levelUp = parseLevelMats(lvTbl);
if (T[4]) res.other = kvTable(T[4]);
if (T[5]) {
  // 表6 是「标题行 + 内容行」交替，每行单格。正文在下一行，不在同行的第二格。
  res.stories = [];
  for (let i = 0; i < T[5].length; i += 2) {
    const title = T[5][i]?.v0 || '';
    const body = plain(T[5][i + 1]?.cells?.[0]?.raw || '');
    if (title) res.stories.push({
      title,
      // 「角色故事1 （解锁条件：好感2级）」把解锁条件拆出来
      unlock: (title.match(/解锁条件[：:]\s*([^）]*)/) || [])[1] || '',
      body,
    });
  }
}
if (T[6]) res.constellations = T[6].slice(1).map(r => ({ name: r.v0, desc: plain(r.cells[1]?.raw || '') })).filter(c => c.name);
res.skillBlocks = parseSkillBlocks(html, T);
// 技能倍率表：表头含 LV1..LVn 就是，按内容找而不是从固定下标 7 开始
// （不同角色星级不同，表数会变：菲林斯 5 星 9 张表，甘雨/刻晴 4 星表数就不同）。
res.skillTables = [];
for (let i = 0; i < T.length; i++) {
  const attrs = parseSkillTable(T[i]);
  if (attrs) res.skillTables.push({ table: i, attrs });
}
// 技能升级材料表：表头第 1 格是「等级」、第 2 格是「所需材料」（首格只有「等级」，
// 「所需材料」在第二个格子里，早先只匹配首格所以一张都没命中）。
// 用「数据行含 1→2 这种等级跳转」来认更稳，倍率表里不会有这种写法。
const matTbl = T.filter(t => t.some(r => /^\d+\s*→\s*\d+$/.test(String(r.v0 || '').replace(/&[a-z]+;/gi, '').trim())));
res.skillMats = parseSkillMats(matTbl.flat());
// materials 必须在上面这些字段都算完之后再组装。
// 之前它写在 levelUp 赋值之前，levelUp 恒为 undefined，升级材料段数一直是 0。
// talents 保持空数组：Bwiki 的天赋材料是技能升级材料（1→2、6→7…），
// 与 gsRoleView 期望的 talents（三维：外层=技能、内层=等级）形态不同。
// 硬塞进去会让「天赋材料」区块把技能升级材料当天赋材料显示。留空，模板会跳过该区块。
res.materials = { ascensions: res.ascendStages || [], talents: [], levelUp: res.levelUp || [] };

const P = (t, s) => console.log(t + s);
P('【基础】', Object.entries(res.basic || {}).map(([k, v]) => `${k}=${String(v).slice(0, 26)}`).join('  '));
P('\n【属性成长】\n', (res.growth || []).map(g => `  ${g.level}级 HP ${g.hp?.before}→${g.hp?.after}  ATK ${g.atk?.before}→${g.atk?.after}  DEF ${g.def?.before}→${g.def?.after}  爆伤 ${g.bonus?.before}→${g.bonus?.after}`).join('\n'));
P('\n【突破材料总计】\n', (res.ascendTotal || []).map(m => `  ${m.name} ×${m.count}`).join('\n'));
P('\n【突破各档】\n', (res.ascendStages || []).map(s => `  ${s.level}: ${s.mats.map(m => m.name + '×' + m.count).join(', ')}${s.unlock ? '  →解锁 ' + s.unlock : ''}`).join('\n'));
P('\n【其他信息】\n', Object.entries(res.other || {}).map(([k, v]) => `  ${k} = ${String(v).slice(0, 44)}`).join('\n'));
P(`\n【角色故事】${(res.stories || []).length} 条: ${(res.stories || []).map(s => s.k).join(' / ').slice(0, 120)}`);
P('\n【命座】\n', (res.constellations || []).map((c, i) => `  ${i + 1}. ${c.name}  ${c.desc.slice(0, 60)}`).join('\n'));
P('\n【技能块】\n', (res.skillBlocks || []).map(x => `  【${x.name}】${x.unlock || '—'}  ${x.desc.length}字  ${x.desc.slice(0, 50)}`).join('\n'));
P('\n【技能详细属性】\n', (res.skillTables || []).map(s => `  表${s.table}: ${s.attrs.length} 组，${s.attrs[0]?.name} ${s.attrs[0]?.levels?.LV1}…${Object.keys(s.attrs[0]?.levels || {}).slice(-1)[0]}`).join('\n'));
P('\n【技能升级材料】\n', (res.skillMats || []).map(s => `  ${s.level}: ${s.mats.map(m => m.name + '×' + m.count).join(', ')}`).join('\n'));

writeFileSync('/tmp/opencode/out/gs-html.json', JSON.stringify(res, null, 2));
console.log('\n已写入 /tmp/opencode/out/gs-html.json');
