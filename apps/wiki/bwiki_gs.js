// 原神 Bwiki 角色页：渲染 HTML → 16 张表 → 结构化 JSON（第 1 步定稿版）
// 材料单元格结构：<img alt="霜盏花"> + 文本 "3"  → 名称取 alt，数量取相邻文本

const API = 'https://wiki.biligame.com/ys/api.php';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 星铁 wiki 是另一个域名（wiki.biligame.com/sr），api.php 同路径但 host 不同，
// 所以这里做成参数；不传就是原神。
const SR_API = 'https://wiki.biligame.com/sr/api.php';

async function renderHtml(page, tries = 5, api = API) {
  const url = `${api}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json`;
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      // 必须带超时。bot 里没有超时的话，维基那边连接挂住会把整条指令卡死，
      // 而指令是有超时上报的，卡住会连带影响后面的任务。
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { last = `HTTP ${r.status}`; await sleep(500 * (i + 1)); continue; }
      // 腾讯 EdgeOne 会拦部分请求，返回 HTTP 200 但 body 是 HTML 拦截页，
      // 这时 .json() 会抛，靠下面 catch 兜住并重试。
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
// href 里的中文是百分号编码，解码失败时原样返回，不能让整个解析挂掉
const safeDecodeURI = s => { try { return decodeURIComponent(s); } catch { return String(s || ''); } };

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

// 本地高清图标：元素与武器类型。维基给的是文字（雷 / 长柄武器），
// 而 resources/wiki/imgs/ 里已有转成黑色剪影的高清图（与命途图标风格一致）。
// 武器类型两边叫法不同：维基「长柄武器」对应本地的「长枪.png」。
const LOCAL_ICON = {
  '雷': '雷.png', '水': '水.png', '火': '火.png', '冰': '冰.png',
  '风': '风.png', '岩': '岩.png', '草': '草.png',
  '长柄武器': '长枪.png', '单手剑': '单手剑.png', '双手剑': '双手剑.png',
  '弓': '弓.png', '法器': '法器.png',
};

// 维基「角色筛选」页有官方的图标_武器类别_单手剑 / 长柄武器 / 法器 / 弓 五张彩色图，
// 是彩色剪影（比本地的纯黑剪影信息量大，白底徽章上一眼能认出武器形态）。
// 元素图标维基给的是文字没有配图，所以元素走本地 128x128。
// 实测：维基武器原图 80x80 vs 本地 256x256 —— 像素上本地更高，
// 但本地是纯黑剪影、维基是彩色，这里取维基的彩色版，武器形态更易辨识。
const BWIKI_WEAPON_ICON = {
  '单手剑': 'https://patchwiki.biligame.com/images/ys/thumb/c/c6/1t9ir39whxf8j3svmde4ekbcjj45dpp.png/30px-%E5%9B%BE%E6%A0%87_%E6%AD%A6%E5%99%A8%E7%B1%BB%E5%88%AB_%E5%8D%95%E6%89%8B%E5%89%91.png',
  '长柄武器': 'https://patchwiki.biligame.com/images/ys/thumb/1/1d/n6htq1w82q7ir80gmi1urp1b3a75ur5.png/30px-%E5%9B%BE%E6%A0%87_%E6%AD%A6%E5%99%A8%E7%B1%BB%E5%88%AB_%E9%95%BF%E6%9F%84%E6%AD%A6%E5%99%A8.png',
  '法器': 'https://patchwiki.biligame.com/images/ys/thumb/0/0d/lvzgwtiouenuhay815zd55yw01fwcc9.png/30px-%E5%9B%BE%E6%A0%87_%E6%AD%A6%E5%99%A8%E7%B1%BB%E5%88%AB_%E6%B3%95%E5%99%A8.png',
  '弓': 'https://patchwiki.biligame.com/images/ys/thumb/8/8b/kn6pnk50kmv7fi5atmp6wnsyn59rukq.png/30px-%E5%9B%BE%E6%A0%87_%E6%AD%A6%E5%99%A8%E7%B1%BB%E5%88%AB_%E5%BC%93.png',
};

// ══════════════════════════════════════════════════════════
// 对外接口
// ══════════════════════════════════════════════════════════

// 页名映射：用户输入的名字未必是维基页名。
// 薇斯纶在维基上叫「薇斯纳」，这类差异靠硬编码补不全，
// 所以运行时先按原名试，missing 再走这里的候选表 + 模糊匹配。
/* 角色称号与别称（「仆人」→「阿蕾奇诺」、「散兵」→「流浪者」等）不应写入本表。
   此类名称由调用方通过 *_js_names.yaml 统一归一后再传入（见 wiki.js 的 role()）。
   若在此逐条登记单角色映射，只能覆盖个别角色，其余同类情况仍然遗漏。 */
const PAGE_ALIAS = {
  薇斯纶: '薇斯纳',
  温迪: '温迪',
};

// Bwiki 页面改名时内容不变，用 action=query 的 redirects 跟随重定向最稳。
// 但那要多一次请求，所以只在原名失败后才试。
async function resolvePage(name) {
  const cands = [name, PAGE_ALIAS[name]].filter(Boolean);
  for (const c of cands) {
    try {
      const html = await renderHtml(c, 5);
      if (html && html.length > 5000) return { page: c, html };
    } catch { /* 试下一个 */ }
  }
  return null;
}

const cache = new Map();
const CACHE_TTL = 6 * 3600 * 1000;

/**
 * 抓取并解析一个原神角色的 Bwiki 数据。
 * 任何环节失败都返回 null，由调用方决定是否降级到 nanoka。
 * @param {string} name 角色名（维基页名或别名）
 */
export async function fetchGsRole(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;

  // 整段包一层超时：图鉴是同步指令，维基那边卡住会拖到指令超时上报。
  // 内部 fetch 各有 15s，但 resolvePage 会试多个候选名（别名/重定向），
  // 叠加起来可能超过 20s，这里统一兜住。超时按「抓不到」处理，让调用方降级 nanoka。
  let resolved = null;
  try {
    resolved = await Promise.race([
      resolvePage(key),
      sleep(20000).then(() => { throw new Error('Bwiki 请求超时 20s'); }),
    ]);
  } catch (e) { logger.debug?.(`[xhh][bwiki_gs] ${key} 解析页名失败: ${e.message}`); return null; }
  if (!resolved) {
    logger.debug?.(`[xhh][bwiki_gs] Bwiki 无此页: ${key}`);
    return null;
  }
  const { page, html } = resolved;
  try {
    const res = parseGsPage(page, html);
    // 文件页查立绘原图（比页面上按 alt 找缩略图清晰）。失败就用页面里那张。
    res._portrait = await pickPortraitFile(res.page);
    // 头像另取：角色一览页的 icon 是 106×106 的「无背景-角色-{名}.png」方图，
    // 正好对应图鉴/故事模板里那个 112×112 的头像位。
    // 不能拿 _portrait 顶 —— 那是 2250×2250 的抽卡立绘，套进方形头像位
    // 只会截到带 miHoYo 水印的一角。角色一览有缓存，不额外增加请求压力。
    res._avatar = await pickAvatarFromList(res.page);
    cache.set(key, { t: Date.now(), v: res });
    return res;
  } catch (e) {
    logger.debug?.(`[xhh][bwiki_gs] ${page} 解析异常: ${e.message}`);
    return null;
  }
}

/** 解析已渲染好的页面 HTML → 结构化数据（纯函数，可单独测试） */
export function parseGsPage(page, html) {
  const T = tables(html);
  const res = { page, tableCount: T.length };

  if (T[0]) { res.basic = kvTable(T[0]); res.basicIcons = kvIcons(T[0]); }
  if (T[1]) res.growth = parseGrowth(T[1]);
  if (T[2]) { const a = parseAscend(T[2]); res.ascendTotal = a.total; res.ascendStages = a.stages; }
  // 等级升级消耗表不按序号找（不同角色、不同版本表数和顺序都会变），按内容认
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
        unlock: (title.match(/解锁条件[：:]\s*([^）]*)/) || [])[1] || '',
        body,
      });
    }
  }
  if (T[6]) {
    // 命座表：每行的第 0 格是「图标 + 名称」，第 1 格是效果全文。
    // 图标 alt 就是命座名（带 .png），从格内抓出来做徽章。
    res.constellations = T[6].slice(1).map(r => {
      const raw = r.cells[0]?.raw || '';
      const img = raw.match(/<img[^>]*src="([^"]+)"/);
      return {
        name: (raw.match(/<img[^>]*alt="([^"]*)"/) || [])[1]?.replace(/\.png$/i, '') || r.v0,
        desc: plain(r.cells[1]?.raw || ''),
        icon: img ? img[1] : '',
      };
    }).filter(c => c.name);
  }
  res.skillBlocks = parseSkillBlocks(html, T);
  // 技能倍率表：表头含 LV1..LVn 就是，按内容找而不是固定下标
  // （不同星级表数不同：菲林斯 5 星 9 张表，甘雨/刻晴 4 星就不同）。
  res.skillTables = [];
  for (let i = 0; i < T.length; i++) {
    const attrs = parseSkillTable(T[i]);
    if (attrs) res.skillTables.push({ table: i, attrs });
  }
  // 技能升级材料表：用数据行的「1→2」等级跳转来认，倍率表里不会有这种写法
  const matTbl = T.filter(t => t.some(r => /^\d+\s*→\s*\d+$/.test(String(r.v0 || '').replace(/&[a-z]+;/gi, '').trim())));
  res.skillMats = parseSkillMats(matTbl.flat());
  // materials 必须最后组装：之前它写在 levelUp 赋值之前，levelUp 恒为 undefined。
  // talents 保持空数组：Bwiki 的技能升级材料与 gsRoleView 期望的 talents 形态不同。
  res.materials = { ascensions: res.ascendStages || [], talents: [], levelUp: res.levelUp || [] };
  res._html = html;   // 立绘要从渲染 HTML 里挑，交给调用方用完后删
  return res;
}

export { renderHtml, tables, plain, decode, safeDecodeURI };

// ══════════════════════════════════════════════════════════
// 结构化数据 → gsRoleView 能吃的 detail + view 附加字段
// ══════════════════════════════════════════════════════════

/** 立绘：从渲染 HTML 里挑最宽的「角色名立绘」 */
// 立绘优先走「文件:{角色名}立绘.png」这个文件页（维基上就是原图，没有缩略损失），
// 拿不到再退回页面上按 alt 找最大宽度的那张。
const FILE_API = 'https://wiki.biligame.com/ys/api.php';

async function pickPortraitFile(who) {
  for (let i = 0; i < 5; i++) {
    try {
      const u = `${FILE_API}?action=query&titles=${encodeURIComponent(`文件:${who}立绘.png`)}`
        + '&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';
      const r = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!(r.headers.get('content-type') || '').includes('json')) continue;
      const j = await r.json();
      const p = Object.values(j?.query?.pages || {})[0];
      if (!p || p.missing !== undefined) continue;
      const ii = p.imageinfo?.[0];
      if (ii?.url) return ii.url;          // 原图
      if (ii?.thumburl) return ii.thumburl;
    } catch { /* 试下一次 */ }
  }
  return '';
}

/**
 * 角色一览页 → 头像 URL（无背景方图）。列表有 6 小时缓存，抓不到返回空串。
 * 走列表而不是再查一次文件页：文件页要多一次请求，而列表反正角色列表指令也要抓。
 */
async function pickAvatarFromList(who) {
  try {
    const list = await fetchGsRoleList();
    if (!list?.length) return '';
    const hit = list.find(x => String(x.name || '').trim() === String(who || '').trim());
    return hit?.icon || '';
  } catch (e) {
    logger.debug?.(`[xhh][bwiki_gs] ${who} 头像取自角色一览失败: ${e?.message}`);
    return '';
  }
}

function pickPortraitFromPage(html, who) {
  let portrait = '', best = 0;
  for (const m of (html || '').matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)) {
    const a = m[1], src = m[2];
    if (!a.includes(who) || !/立绘|抽卡立绘/.test(a)) continue;
    const w = Number((m[0].match(/width="(\d+)"/) || [])[1] || 0);
    if (w > best) { best = w; portrait = src; }
  }
  if (!portrait) {
    const m = [...(html || '').matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)]
      .find(x => x[1].includes(who));
    if (m) portrait = m[2];
  }
  return portrait;
}

// 顶部徽章：优先展示这几项，顺序也按这个来。
// 关键是要「不排斥」—— 元素那一项在不同地区/版本有不同叫法
// （老角色「月之轮」、挪德卡莱「星之楔」、更早还有「元素属性」…），
// 写死一个「月之轮」就会让薇斯纳这类角色整项消失。
// 所以：这份表只决定优先级和排序，d.basic 里剩下的键会按页面原有顺序追加到后面。
const HERO_BADGE_ORDER = ['称号', '全名/本名', '所属地区', '出身地区', '种族', '性别', '稀有度',
  '常驻/限定', '月之轮', '星之楔', '元素属性', '武器类型', '羁绊属性', '始基力', '命之座', '特殊料理', '实装日期',
  '所属', '身份', '生日'];
// 元素属性的各种叫法（神之眼=元素属性的变种），取第一个存在的
const ELEMENT_KEYS = ['月之轮', '星之楔', '元素属性', '元素', '神之眼', '神之心'];
// 七种元素，用来判断某个字段的值是不是元素（是的话才补图标）
const GS_ELEMENTS = ['火', '水', '冰', '雷', '风', '岩', '草'];
// 角色档案：剩下的补充信息，不与顶部徽章重复（也不含「卡池信息」，它单独成栏）
const ROLE_PROFILE_ORDER = [
  '中文CV', '日文CV', '英文CV', '韩文CV', '体型', '昵称/外号',
  '游逸旅闻', '尘歌壶', '名片', '卡牌', '幻想真境剧诗', '专属交互事件'];

/**
 * 纯函数：「卡池信息」长文本 → { upCount, banners: [{ version, period }] }。
 * 原文是一整条（flatVal 拼起来的）：
 *   UP次数：3次 折叠 祈愿 - 7.0下半 2026/09/01 18:00:00 ~ 2026/09/22 14:59:00 祈愿 - 月之五上半 …
 * 「祈愿 - 」后面到时间前的那个词是版本（7.0下半 / 月之五上半），其余是期间。
 * 版本名里没有空格，所以用「版本 + 一段以 ~ 收尾的时间」来切最稳。
 */
export function parseGsGachaInfo(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || s === '-') return null;
  const upCount = Number((s.match(/UP\s*次数[：:]\s*(\d+)/) || [])[1] || 0) || 0;
  const banners = [];
  const re = /(\S+)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*~\s*\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?)/g;
  for (const m of s.matchAll(re)) {
    const version = m[1].replace(/^祈愿\s*[-–—]\s*/, '').trim();
    const period = m[2].replace(/\s+/g, ' ').trim();
    if (version && period) banners.push({ version, period });
  }
  if (!banners.length) return null;
  return { upCount, banners };
}
// 「介绍」和「TAG」这类长文本不放进档案块，避免档案被撑得过长
const ROLE_PROFILE_SKIP = new Set(['介绍', 'TAG', '个人任务', '衣装', '祈愿名']);
/* Bwiki 的占位符特征。
   测试服新角色（如米提亚）的词条已建、但**技能数据尚未录入**，每个技能块里
   标题只有图标占位「文件:.png」、描述区是「请上传文件『.gif』」。
   这种块数量照样是 6，name 却全是占位串 —— 只数块数会把空卡当完整数据渲染出去。
   命座同理（「上传文件.jpg」等）。凡命中即视为未录入。 */
const PLACEHOLDER = /文件[:：]|请上传文件|\.png|\.gif|\.jpg/i;

/**
 * 把 fetchGsRole 的结果转成 gsRoleView 的输入 detail，并补齐 view 侧的附加字段。
 * 纯函数，不碰网络与文件。
 */
export function buildGsDetail(d) {
  const who = d.page;
  const html = d._html || '';
  const g = k => { const v = d.basic?.[k]; return Array.isArray(v) ? (v[0] ?? '') : (v ?? ''); };
  const flatVal = v => (Array.isArray(v) ? v.filter(Boolean).join('、') : (v ?? ''));

  // 90 级为满级，非 1 级。Bwiki 的 90 级行「突破后」列为 -，因此取 after，缺省回退 before。
  // Bwiki 成长表在 90 级之后另有 95 / 100 两个占位空行（突破后无值），
  // parseGrowth 会将其解析为「仅含 level、不含属性键」的行。
  // 若直接取 level 最大的行，将命中 100 级空行，导致 base_hp/atk/def 全部为空。
  // 因此先过滤掉不含属性数据的行，再取 level 最大者。
  const lvMax = (d.growth || []).filter(x => Number.isFinite(x.level) && (x.hp || x.atk || x.def))
    .reduce((a, b) => (!a || b.level > a.level ? b : a), null) || {};
  const at90 = k => (lvMax[k]?.after && lvMax[k].after !== '-' ? lvMax[k].after : lvMax[k]?.before) || '';

  /* 基础双暴：原神所有角色的基础值固定为暴击率 5%、暴击伤害 50%。
     Bwiki 成长表中的该列（列名为「暴击伤害」或「暴击率」，取决于角色的突破加成项）
     记录的是突破加成，并非面板值。直接将其作为 crit_dmg 会得到 38.4%，
     正确的面板值为 50% + 38.4% = 88.4%，因此在此补齐基础值：
     加成列为暴击伤害时，暴击伤害 = 50% + 加成；加成列为暴击率时，暴击率 = 5% + 加成；
     无加成列的一项取基础值。 */
  const addPct = (base, add) => {
    const n = parseFloat(String(add || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n)) return `${base}%`;
    const v = (base + n).toFixed(1).replace(/\.0$/, '');
    return `${v}%`;
  };

  // 突破：各档 → gsRoleView 的 ascensions 形状（摩拉走 cost，其余走 mats）
  const ascensions = (d.ascendStages || []).map(s => ({
    cost: Number((s.mats.find(m => m.name === '摩拉')?.count || 0).toString().replace(/[^\d]/g, '')) || 0,
    mats: s.mats.filter(m => m.name !== '摩拉').map(m => ({
      id: '', name: m.name, count: Number(String(m.count).replace(/[^\d.]/g, '')) || 0,
      icon: m.icon, _unlock: s.unlock || '',
    })),
  }));

  // 技能：倍率表 → promote。只遍历 kind==='skill' 的块来配表（不靠「表有没有 attrs」猜）。
  const blocks = d.skillBlocks || [];
  const skillBlocks = blocks.filter(b => b.kind === 'skill');
  const skillObjs = [];
  /* 用独立游标 blkIdx 配表，不能用 skillObjs.length ——
     下面遇到占位符名会 continue，skillObjs 不增长，索引就会错位拿错块。 */
  let blkIdx = 0;
  for (const t of (d.skillTables || [])) {
    if (!t.attrs.length) continue;
    const blk = skillBlocks[blkIdx++];
    const desc = [], param = [], brackets = [];
    for (const a of t.attrs) {
      const lvKeys = Object.keys(a.levels);
      const topRaw = a.levels[lvKeys[lvKeys.length - 1]];
      // 双值格 '271%/338%'（低空/高空各一套）要拆成两行，
      // 否则 parseFloat 只取到 271，被 F1P 乘 100 后拼成 271338%。
      const parts = String(topRaw).split('/').map(x => x.trim()).filter(Boolean);
      for (const part of parts) {
        const raw = parseFloat(part.replace(/[^\d.]/g, ''));
        if (Number.isNaN(raw)) continue;
        const isPct = part.includes('%');
        const unit = (part.match(/%(.)/) || [])[1] || '';
        param.push(isPct ? raw / 100 : raw);
        const fmt = isPct ? 'F1P' : 'F1';
        desc.push(unit ? `${a.name}(${unit})|{param${param.length}:${fmt}}` : `${a.name}|{param${param.length}:${fmt}}`);
      }
      brackets.push(`${a.name}：${lvKeys.map(k => a.levels[k]).join(' / ')}`);
    }
    /* 测试服新角色的技能块名是占位符「文件:.png」，渲染出来是一张空卡。
       这里直接跳过，交给调用方按「Bwiki 数据不完整」回退 nanoka/米游社。 */
    const blkName = String(blk?.name || '').trim();
    if (!blkName || PLACEHOLDER.test(blkName)) continue;
    skillObjs.push({
      name: blkName,
      promote: { 0: { level: Object.keys(t.attrs[0].levels).length, icon: blk?.icon || '', desc, param, brackets } },
    });
  }

  const detail = {
    name: who,
    // 头像：角色一览页的 106×106 无背景方图（fetchGsRole 已查好放在 _avatar）。
    // 拿不到才退回 _portrait / 页面里的立绘图 —— 模板里头像位是方形的，
    // 2250×2250 的抽卡立绘套进去只能看到带水印的一角，但有图总比没图好。
    icon: d._avatar || d._portrait || pickPortraitFromPage(html, who),
    rarity: (g('稀有度') || '5星').replace(/[^0-9]/g, '') || '5',
    // 稀有度金星图：角色一览页有现成的五星/四星星图，比自己拼 URL 稳
    rarityIcon: RARITY_ICON[(g('稀有度') || '').replace(/[^45]/g, '')] || '',
    base_hp: at90('hp'), base_atk: at90('atk'), base_def: at90('def'),
    crit_rate: at90('critRate') ? addPct(5, at90('critRate')) : '5%',
    crit_dmg: at90('bonus') ? addPct(50, at90('bonus')) : '50%',
    elemental_mastery: '', stamina_recovery: '',
    desc: g('介绍'),
    chara_info: {
      /* 元素字段各版本叫法不同：老角色用「神之心」，新角色用「神之眼」/「元素属性」等。
         原先只取「月之轮/元素属性」，导致温迪、纳西妲、雷电将军等老角色的
         元素与神之眼图标为空（模板 {{if elementIcon}} 拿不到值）。统一按 ELEMENT_KEYS 取第一个有值的。 */
      vision: ELEMENT_KEYS.map(k => g(k)).find(Boolean) || '',
      constellation: g('命之座'),
      region: g('所属地区'),
      title: g('称号'),
      /* kvTable 对单值返回字符串、多值返回数组（见 :100），
         「生日」这类格里既有 img alt 又有文字时会拿到数组，直接 .match 会抛
         TypeError: ((intermediate value) || "").match is not a function。
         `|| ''` 挡不住 —— 数组是真值。统一用 flatVal 归一，与 686/720 行一致。 */
      birth: (() => { const b = flatVal(d.other?.['生日']).match(/(\d+)月(\d+)日/); return b ? [b[1], b[2]] : []; })(),
      release_date: (g('实装日期') || '').replace(/（.*?）/, '').trim(),
    },
    skills: skillObjs,
    constellations: (d.constellations || []).filter(c => c.name && !PLACEHOLDER.test(String(c.name)))
      .map(c => ({ name: c.name, desc: c.desc, icon: c.icon || '' })),
    passives: blocks.filter(b => b.kind === 'passive' && b.desc && b.name && !PLACEHOLDER.test(String(b.name)))
      .map(b => ({ name: b.name, desc: b.desc, unlock: b.unlock || '', icon: b.icon || '' })),
    materials: {
      ascensions,
      talents: [],
      levelUp: d.materials?.levelUp || [],
      skillUp: d.skillMats || [],
    },
  };

  // view 侧附加：角色档案、徽章图标、角色详细拆分
  const profile = [];
  for (const k of ROLE_PROFILE_ORDER) {
    let v = flatVal(d.basic?.[k]);
    if (!v || !String(v).trim()) v = flatVal(d.other?.[k]);
    v = String(v).trim();
    if (!v || v === '-' || ROLE_PROFILE_SKIP.has(k)) continue;
    if (k === '稀有度') v = String(v).replace(/\.png$/i, '').trim();
    profile.push({ k, v, icons: (d.basicIcons?.[k] || []).map(x => x.icon).filter(Boolean) });
  }

  const storyList = (d.stories || []).map(x => ({
    title: String(x.title || '').replace(/\s*[（(]解锁条件[：:][^）)]*[）)]\s*$/, '').trim(),
    unlock: x.unlock || '',
    body: String(x.body || '').trim(),
  }));
  const detailIdx = storyList.findIndex(x => /角色详细|角色简介|角色介绍/.test(x.title));
  // 元素：不同版本叫法不同（月之轮 / 星之楔 / 元素属性），统一成一个值
  const elementKey = ELEMENT_KEYS.find(k => flatVal(d.basic?.[k])) || '';
  const elementVal = elementKey ? String(flatVal(d.basic?.[elementKey]) || '').trim() : '';

  // 顶部徽章与档案各自取字段，所以要从全部键值里查，不能靠「档案里没要」来推断。
  const all = {};
  // 徽章候选：优先表里的键 + basic/other 里剩下的全部键（排除档案/长文本类）
  // 卡池信息单独成栏，不进徽章；「介绍 / TAG / 个人任务 / 衣装 / 祈愿名」这类长文本也不进
  const PROFILE_KEYS = new Set([...ROLE_PROFILE_ORDER, ...ROLE_PROFILE_SKIP,
    '介绍', 'TAG', '卡池信息', '角色故事', '个人任务', '衣装', '祈愿名', '所在位置']);
  const badgeKeys = [];
  for (const k of HERO_BADGE_ORDER) if (d.basic?.[k] || d.other?.[k]) badgeKeys.push(k);
  for (const src of [d.basic, d.other]) {
    for (const k of Object.keys(src || {})) {
      if (PROFILE_KEYS.has(k) || badgeKeys.includes(k)) continue;
      badgeKeys.push(k);
    }
  }
  for (const k of badgeKeys) {
    let v = flatVal(d.basic?.[k]);
    if (!v || !String(v).trim()) v = flatVal(d.other?.[k]);
    v = String(v).trim();
    if (!v || v === '-' || ROLE_PROFILE_SKIP.has(k)) continue;
    if (k === '稀有度') v = String(v).replace(/\.png$/i, '').trim();
    // 徽章图标：武器类型用维基的彩色剪影，元素用本地 128x128，其余用维基自带的
    const bw = (d.basicIcons?.[k] || []).map(x => x.icon).filter(Boolean);
    // Bwiki 图标是完整 URL，直接用；本地图标只给文件名，由模板拼 {{ppath}}wiki/imgs/xxx
    const weapon = BWIKI_WEAPON_ICON[v] || '';
    const local = !weapon && LOCAL_ICON[v] ? LOCAL_ICON[v] : '';
    // icon: 主图标（本地文件名 或 完整 URL）；localIcon 告诉模板该用 {{ppath}} 拼还是直接用
    const main = weapon || local || bw[0] || '';
    all[k] = { k, v, icon: main, localIcon: !!(local && !weapon), icons: main ? [main] : [] };
  }
  const byKey = new Map(Object.values(all).map(x => [x.k, x]));

  if (elementVal && detail?.chara_info && !detail.chara_info.vision) {
    detail.chara_info.vision = elementVal;   // 星之楔 / 元素属性 的角色也能拿到元素值
  }

  return {
    detail,
    extra: {
      elementKey,
      profile,
      topBadges: badgeKeys.filter(k => byKey.has(k)).map(k => byKey.get(k)),
      // 卡池信息单独成栏，不混进角色档案表
      gacha: parseGsGachaInfo(d.other?.['卡池信息']),
      // 只留「角色详细」那一栏，底部角色故事区块已从模板移除，
      // 其余 7 条故事不再返回——省一次字符串拷贝，图也没用到。
      detailStory: detailIdx >= 0 ? storyList[detailIdx] : (storyList[0] || null),
      source: '数据来源 wiki.biligame.com',
    },
  };
}

// ══════════════════════════════════════════════════════════
// 角色一览（wiki.biligame.com/ys/角色）
// ══════════════════════════════════════════════════════════

// 稀有度图标：维基自己的五星/四星金星图，比「★」文字看着准。
// key 用纯数字：稀有度原文是「5星」，取值时会先剥掉「星」再查表。
const RARITY_ICON = {
  5: 'https://patchwiki.biligame.com/images/ys/f/ff/0dlkmof43y8aam8fphgixaejy571iqc.png',
  4: 'https://patchwiki.biligame.com/images/ys/2/2a/ssqzx9cint7m3yudjwviabu4nkd8s9o.png',
};

const listCache = new Map();

/**
 * 抓「角色」页并解析成角色数组。
 * 页面条目由 CardSelectTr 模板生成，结构固定：
 *   <div class="divsort g C5星" data-param1="5星" data-param2="风" data-param3="单手剑" data-param4="至冬">
 *     <img src="头像"><div class="L">名字</div><a href="/ys/名字" title="名字">
 * 所以直接按 div.divsort 抓，不依赖下标顺序。
 */
export async function fetchGsRoleList() {
  const hit = listCache.get('all');
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let html = null;
  try { html = await renderHtml('角色', 5); }
  catch (e) { logger.debug?.(`[xhh][bwiki_gs] 角色一览抓取失败: ${e.message}`); return null; }
  if (!html || !html.includes('divsort')) {
    logger.debug?.('[xhh][bwiki_gs] 角色一览结构异常（无 divsort）');
    return null;
  }
  const list = parseGsRoleList(html);
  if (!list.length) return null;
  listCache.set('all', { t: Date.now(), v: list });
  return list;
}

/**
 * 纯函数：武器一览 / 圣遗物一览页 HTML → 条目数组。
 * 两个页面用的是同一套 CardSelectTr 模板，结构和「角色」页的 divsort 不同：
 *   <div class="g">
 *     <a href="/ys/文件:雾切之回光.png" class="image"><img alt="…png" src="patchwiki…png"></a>
 *     <div class="T g5"></div>          ← g5/g4 就是五星/四星
 *     <div class="L">雾切之回光</div>     ← 名字
 *     <a href="/ys/雾切之回光" title="雾切之回光">…</a>
 *   </div>
 * 图片是 220×220 的原图（不是缩略图），直接拿来当列表头像。
 * 页面上没有 data-param，拿不到武器类型/元素，这些字段仍由 nanoka 侧提供。
 */
export function parseGsItemList(html) {
  const out = [];
  // href 里的中文是 URL 编码（%E6%96%87%E4%BB%B6: 就是「文件:」），
  // 所以不能直接匹配「文件:」三个字，先把 href 整个抓下来再解码取文件名。
  const ITEM_RE = /<div class="g"><a href="\/ys\/([^"]+\.png)"[^>]*class="image"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*>\s*<\/a>\s*<div class="T (g[45])"><\/div>\s*<div class="L">([^<]+)<\/div>/g;
  const itemsIn = seg => [...seg.matchAll(ITEM_RE)].map(m => {
    const name = decode(m[4]).trim();
    return {
      name,
      // 文件名在最后一个冒号后面（文件:雾切之回光.png → 雾切之回光）
      file: safeDecodeURI(decode(m[1]).replace(/\.png$/i, '')).split(':').pop().trim(),
      icon: m[2],
      rarity: m[3] === 'g5' ? '5' : '4',
      rarityIcon: RARITY_ICON[m[3] === 'g5' ? 5 : 4] || '',
      page: name,
    };
  }).filter(x => x.name);

  // 武器一览是响应式页签结构（resp-tabs / resp-tab-case）：
  //   页签标题依次是 全部 / 单手剑 / 双手剑 / 长柄武器 / 法器 / 弓，
  //   每个 case 里是那一类的全部条目，第一个 case 是「全部」（各类型条目的并集）。
  // 武器类型就是靠这个拿到的 —— 页签标题按顺序与 case 一一对应。
  const tabs = [...(html || '').matchAll(/<span class="tab-panel">([\s\S]*?)<\/span>/g)]
    .map(m => decode(m[1].replace(/<img[^>]*>/g, '')).replace(/&#160;|&nbsp;|\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const caseAt = [...(html || '').matchAll(/<div class="resp-tab-case"[^>]*>/g)].map(m => m.index);
  const typeOf = new Map();   // 名字 → 武器类型
  const bounds = [...caseAt, (html || '').length];
  for (let i = 0; i < caseAt.length; i++) {
    const label = tabs[i] || '';
    // 「全部」那栏是并集，不作为类型来源（后面遇到同名的会被具体类型覆盖）
    if (!label || /全部|所有/.test(label)) continue;
    for (const it of itemsIn(html.slice(bounds[i], bounds[i + 1]))) typeOf.set(it.name, label);
  }
  for (const it of itemsIn(html)) {
    const weapon = typeOf.get(it.name) || '';
    out.push(weapon ? { ...it, weapon } : it);
  }
  return out;
}

/**
 * 纯函数：星铁 wiki 的「角色图鉴 / 光锥图鉴 / 遗器图鉴」页 → 条目数组。
 * 三个页面都是 divsort + data-param 结构（和原神角色一览同一套模板）：
 *   <div class="divsort" data-param1="5星" data-param2="欢愉" data-param3="限定跃迁" data-param4="4.6">
 *     <div class="weapon-box">
 *       <div class="ping0 ping1"><img alt="角色一览-底版.png" …>   ← 底版，要跳过
 *       <div class="weapon-image"><img alt="献给明日的色彩-无背景.png" src="…">
 *       … <a href="/sr/献给明日的色彩" title="献给明日的色彩">
 * data-param 的含义按页面不同：
 *   角色图鉴 1=星级 2=命途 3=属性 4=上线版本 5=性别
 *   光锥图鉴 1=星级 2=命途 3=限定跃迁/常驻 4=上线版本
 *   遗器图鉴 1=隧洞遗器/位面遗器 2=侵蚀隧洞等 3=上线版本（没有星级字段）
 */
const srOrigIcon = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');

export function parseSrItemList(html) {
  const starts = [...(html || '').matchAll(/<div class="divsort"([^>]*)>/g)];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const attrs = starts[i][1] || '';
    const seg = (html || '').slice(starts[i].index, starts[i + 1] ? starts[i + 1].index : (html || '').length);
    /* 名称取自锚点 title 属性，其中的 & 在 HTML 源码里写作 &amp;，必须解码。
       不解码时「托帕&amp;账账」与 nanoka 的「托帕&账账」经 nmKey 归一后仍不相等，
       mergeSrBwikiIcons 会判定 Bwiki 独有条目并追加一条，列表里于是出现两个托帕，
       且追加的那条把 &amp; 原样显示出来。此处与下方 alt 的处理保持一致。 */
    const name = decode(((seg.match(/<a href="\/sr\/[^"]*" title="([^"]+)"/) || [])[1] || '').trim());
    if (!name) continue;
    // 底版图（角色一览-底版.png / 遗器一览-底版.png）要跳过，
    // 取剩下那张：光锥/角色是「xxx-无背景.png」，遗器是套装图。
    const imgs = [...seg.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g)]
      .map(m => ({ alt: decode(m[1]), src: m[2] }))
      .filter(x => x.src && !/底版/.test(x.alt));
    // 光锥的图标是 120px 缩略图（…/thumb/d/d4/xxx.png/120px-名称.png），
    // 直接用会糊；缩略图 URL 里带原图路径，取出来就是原图。
    const icon = srOrigIcon(imgs[0]?.src || '');
    const param = k => ((attrs.match(new RegExp(`data-param${k}="([^"]*)"`)) || [])[1] || '');
    const ji = param(1);
    out.push({
      name,
      icon,
      // 角色/光锥有星级字段（4星/5星），遗器没有 —— 留空，列表星级徽章会自动跳过
      ji: /^[45]星$/.test(ji) ? ji : '',
      path: param(2),
      kind: param(3),
      version: param(4),
      rarity: ji === '5星' ? '5' : ji === '4星' ? '4' : '',
    });
  }
  return out;
}

const srListCache = new Map();

/** 抓星铁的图鉴页（角色图鉴 / 光锥图鉴 / 遗器图鉴）并解析 */
export async function fetchSrItemList(page) {
  const hit = srListCache.get(page);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let html = '';
  try { html = await renderHtml(page, 3, SR_API); } catch (e) {
    logger.debug?.(`[xhh][bwiki_sr] ${page} 抓取失败: ${e.message}`);
    return null;
  }
  const list = parseSrItemList(html);
  if (!list.length) {
    logger.debug?.(`[xhh][bwiki_sr] ${page} 结构异常（未解析到条目）`);
    return null;
  }
  srListCache.set(page, { t: Date.now(), v: list });
  return list;
}

export const fetchSrRoleList = () => fetchSrItemList('角色图鉴');
export const fetchSrLcList = () => fetchSrItemList('光锥图鉴');
export const fetchSrRelicList = () => fetchSrItemList('遗器图鉴');

const itemListCache = new Map();

/** 抓「武器一览」/「圣遗物一览」并解析（页面名不同，解析逻辑共用） */
export async function fetchGsItemList(page) {
  const hit = itemListCache.get(page);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let html = '';
  try { html = await renderHtml(page, 3); } catch (e) {
    logger.debug?.(`[xhh][bwiki_gs] ${page} 抓取失败: ${e.message}`);
    return null;
  }
  const list = parseGsItemList(html);
  if (!list.length) {
    logger.debug?.(`[xhh][bwiki_gs] ${page} 结构异常（未解析到条目）`);
    return null;
  }
  itemListCache.set(page, { t: Date.now(), v: list });
  return list;
}

export const fetchGsWeaponList = () => fetchGsItemList('武器一览');
export const fetchGsArtifactList = () => fetchGsItemList('圣遗物一览');

/** 纯函数：角色一览页 HTML → 角色数组 */
export function parseGsRoleList(html) {
  const out = [];
  for (const m of (html || '').matchAll(
    /<div class="divsort g (C\d星)"([^>]*)>([\s\S]*?)<\/div>\s*(?=<div class="divsort|<\/div>)/g)) {
    const rarity = m[1].replace(/[^45]/g, '');   // 「C5星」→ 5，RARITY_ICON 的 key 是数字
    const attrs = m[2] || '';
    const body = m[3] || '';
    const g = k => ((attrs.match(new RegExp(`data-param${k}="([^"]*)"`)) || [])[1] || '');
    const img = (body.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '';
    /* 与星铁一览同理：名称里的 & 在 HTML 源码中写作 &amp;，不解码就与 nanoka 的
       正式名对不上，mergeGsBwikiRoleIcons 会把它当成独有条目再追加一条
       （如奥菲丝&「鬼火」），列表内出现重复条目且名称显示成实体原文。 */
    const name = decode(((body.match(/<div class="L">([^<]*)<\/div>/) || [])[1] || '').trim())
      || decode(((body.match(/<a[^>]*title="([^"]+)"/) || [])[1] || '').trim());
    if (!name) continue;
    out.push({
      name,
      rarity,
      element: g(2),
      weapon: g(3),
      region: g(4),
      icon: img,
      rarityIcon: RARITY_ICON[rarity] || '',
      page: name,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 攻略（wiki.biligame.com/ys/{角色}/攻略）
// ══════════════════════════════════════════════════════════

/**
 * 纯函数：攻略页 HTML → 配装推荐结构。
 * 攻略页的表格按内容认（不按下标，不同角色攻略写得详略不同、表数会变）：
 *   推荐圣遗物 / 主词条推荐 / 圣遗物+推荐理由 / 武器+推荐理由
 */

// ══════════════════════════════════════════════════════════
// 攻略（wiki.biligame.com/ys/{角色}/攻略）
// ══════════════════════════════════════════════════════════

const guideCache = new Map();

/** 抓攻略子页 HTML。Bwiki 很多角色没写攻略，页面不存在时返回空串。 */
export async function fetchGsGuidePage(who) {
  const page = `${who}/攻略`;
  const hit = guideCache.get(page);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  let html = '';
  try { html = await renderHtml(page, 5); } catch { html = ''; }
  if (!html || html.length < 2000) html = '';
  guideCache.set(page, { t: Date.now(), v: html });
  return html;
}

/**
 * 纯函数：攻略页 HTML → 配装推荐。
 * 攻略内容全在「一张大表」里（实测菲林斯攻略 15 张表，配装全在表 8），
 * 但表号会随角色变（有人写两三个人配队），所以按表内文本认表不按下标。
 *
 * 这张表的行结构是固定的（每 2~3 行一组，共 6 组）：
 *   行0      分组标题「推荐圣遗物」单格
 *   行1      3 格：4件套图标 + 套装名 + 2/4件套效果
 *   行2      3 格：每套的推荐理由（毕业 / 过渡 / …）
 *   行3      2 格：表头「主词条推荐」「副词条推荐」
 *   行4      2 格：时之沙/空之杯/理之冠 | 副词条
 *   行5      单格「毕业武器」
 *   行6      1 格：毕业武器图标 + 属性
 *   行7      1 格：毕业武器理由
 *   行8      单格「可选武器」
 *   行9      3 格：可选武器
 *   行10     3 格：可选武器理由
 *   行11     2 格：表头「技能升级推荐」「推荐理由」
 *   行12     2 格：升级优先级 | 理由
 */
export function parseGsGuide(html) {
  if (!html) return null;
  const T = tables(html);
  const txtOf = t => plain(t.map(r => r.cells.map(c => c.raw).join(' ')).join(' ')).replace(/\s+/g, ' ');

  // 认表：同时含「推荐圣遗物」与「毕业武器」的才是配装总表
  const guide = T.find(t => {
    const x = txtOf(t);
    return x.includes('推荐圣遗物') && x.includes('毕业武器');
  });
  if (!guide) return null;

  // 从一组「图标格 + 理由格」里取套装/武器
  const itemsOf = (cells) => cells.map(raw => {
    // 一个格里有套装/武器图标 + 星级图（4星.png / 5星.png），星级图要单独取。
    const imgs = [...raw.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/gi)]
      .map(m => ({ alt: decode(m[1]).replace(/\.png$/i, '').trim(), src: m[2] }));
    const main = imgs.find(x => x.alt && !/^\d星$/.test(x.alt)) || imgs[0] || { alt: '', src: '' };
    // 一个格子里可能同时有 4星.png 和 5星.png 两张星级图（攻略写「4/5 星通用」时就这么标），
    // 原来 find 取第一张，于是「穹境示现之夜」这种五星套装被标成 4星。
    // 两张都有时取最高星：攻略推荐的是能用的那一档，卡池里的套装本来就是五星。
    const starAlts = imgs.filter(x => /^\d星$/.test(x.alt)).map(x => x.alt);
    const star = starAlts.includes('5星') ? '5星' : starAlts.includes('4星') ? '4星'
      : starAlts.includes('3星') ? '3星' : starAlts[0] || '';
    const name = main.alt;
    // 真实文件名从缩略图 URL 里取：alt 只写套装简称（穹境示现之夜），
    // 文件名却是「穹境示现之夜生之花.png」，靠 alt 拼文件页标题会 404。
    const fm = main.src.match(/\/(\d+px-[^/]+\.png)$/i);
    const file = fm ? decodeURIComponent(fm[1].replace(/^\d+px-/i, '')).replace(/\.png$/i, '') : '';
    const text = plain(raw);
    // 「4件套 穹境示现之夜 最低稀有度：…」去掉开头件数与重复的名字，只留效果说明
    const why = text.replace(/^\d件套\s*/, '').replaceAll(name, ' ').replace(/\s+/g, ' ').trim();
    return { name, file, icon: main.src, star, why };
  }).filter(x => x.name && x.why);

  const rows = guide;
  const rowText = i => (rows[i]?.cells || []).map(c => plain(c.raw)).join(' | ');

  // ── 圣遗物套装 + 推荐理由（第 1~2 行，行号由「推荐圣遗物」标题行 +1 得） ──
  const artHead = rows.findIndex(r => (r.v0 || '').includes('推荐圣遗物'));
  let artifacts = [];
  if (artHead >= 0) {
    const names = itemsOf((rows[artHead + 1] || { cells: [] }).cells.map(c => c.raw));
    const reasons = ((rows[artHead + 2] || { cells: [] }).cells || []).map(c => plain(c.raw));
    artifacts = names.map((a, i) => ({ ...a, why: reasons[i] || a.why }));
  }

  // ── 主词条 / 副词条 ──
  const affixHead = rows.findIndex(r => (r.v0 || '').includes('主词条推荐'));
  let mainAffix = [], subAffix = '';
  if (affixHead >= 0) {
    const cells = (rows[affixHead + 1] || { cells: [] }).cells || [];
    // 主词条格内是「时之沙 攻击力百分比、元素精通（赤沙之杖）」这种多行，用 <br> 或缩进分段
    const raw = cells[0]?.raw || '';
    mainAffix = plain(raw).split(/\s*(?=[时空理]之[沙杯冠])/).map(x => x.trim()).filter(Boolean)
      .map(x => {
        const m = x.match(/^(.{2,4})\s*(.+)$/);
        return m ? { slot: m[1], value: m[2] } : { slot: '', value: x };
      });
    subAffix = plain(cells[1]?.raw || '');
  }

  // ── 毕业武器 + 理由 ──
  const gradHead = rows.findIndex(r => (r.v0 || '').includes('毕业武器'));
  const graduation = gradHead >= 0 ? itemsOf([(rows[gradHead + 1] || { cells: [] }).cells[0]?.raw || ''])[0] : null;
  if (graduation) graduation.why = plain((rows[gradHead + 2] || { cells: [] }).cells?.[0]?.raw || '') || graduation.why;

  // ── 可选武器 + 理由 ──
  const altHead = rows.findIndex(r => (r.v0 || '').includes('可选武器'));
  let alternates = [];
  if (altHead >= 0) {
    const names = itemsOf((rows[altHead + 1] || { cells: [] }).cells.map(c => c.raw));
    const reasons = ((rows[altHead + 2] || { cells: [] }).cells || []).map(c => plain(c.raw));
    alternates = names.map((a, i) => ({ ...a, why: reasons[i] || a.why }));
  }

  // ── 技能升级推荐 ──
  const skillHead = rows.findIndex(r => (r.v0 || '').includes('技能升级推荐'));
  let skillUp = '', skillWhy = '', skillUpParts = [];
  if (skillHead >= 0) {
    const cells = (rows[skillHead + 1] || { cells: [] }).cells || [];
    const rawUp = cells[0]?.raw || '';
    // 原文用颜色区分技能类型：元素爆发/元素战技/普通攻击 是蓝色 #4571ec，
    // 「雷元素附魔」这类是紫色 #9245e6。把带色的片段抓出来，渲染时上色，
    // 否则「元素爆发＞元素战技」读起来像普通文字，看不出是技能名。
    const marked = [...rawUp.matchAll(/<span style="color:(?:rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)|#([0-9a-f]{6}))[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(m => ({ color: `#${(m[4] || [m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join(''))}`, text: plain(m[5]) }))
      .filter(x => x.text);
    skillUp = plain(rawUp);
    skillUpParts = marked.length ? marked : [];
    skillWhy = plain(cells[1]?.raw || '');
  }

  if (!artifacts.length && !mainAffix.length && !graduation) return null;
  return { artifacts, mainAffix, subAffix, graduation, alternates, skillUp, skillUpParts, skillWhy };
}

/**
 * 把攻略里的缩略图换成文件页的原图。
 * 攻略表里的图标是页面渲染时压过的 30~70px 缩略图，放大后糊；
 * 圣遗物套装与武器在维基上都有「文件:{文件名}.png」这个文件页，取它的 url 就是原图。
 * 文件名从缩略图 URL 里反解（itemsOf 的 file），不用简称拼——简称查不到。
 * 文件页不存在就保持缩略图。
 */
const guideIconCache = new Map();

/** 文件页 → 原图 URL；titles 一次问一批（并发单条请求会被 EdgeOne 拦） */
async function guideFileIcons(keys) {
  const todo = [...new Set(keys.map(k => k.file || k.name).filter(Boolean))]
    .filter(k => !guideIconCache.has(k));
  for (let i = 0; i < todo.length && todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    let got = {};
    // 拦页（HTTP 567 / 非 json）会整批失败，退避后整批重试一次
    for (let t = 0; t < 2 && Object.keys(got).length < batch.length; t++) {
      if (t) await new Promise(r => setTimeout(r, 800));
      try {
        const titles = batch.map(k => `文件:${k}.png`).join('|');
        const u = `${FILE_API}?action=query&titles=${encodeURIComponent(titles)}`
          + '&prop=imageinfo&iiprop=url&format=json';
        const r = await fetch(u, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64: x64) Chrome/120', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        if (!(r.headers.get('content-type') || '').includes('json')) continue;
        const j = await r.json();
        for (const p of Object.values(j?.query?.pages || {})) {
          if (p.missing !== undefined) { got[p.title] = ''; continue; }
          const ii = p.imageinfo?.[0];
          got[p.title] = ii?.url || ii?.thumburl || '';
        }
      } catch { /* 试下一次 */ }
    }
    for (const k of batch) {
      const title = `文件:${k}.png`;
      guideIconCache.set(k, Object.prototype.hasOwnProperty.call(got, title) ? got[title] : '');
    }
  }
}

/** 就地替换 guide 里所有套装/武器的图标为原图（不改动 parseGsGuide 的纯函数性质） */
export async function resolveGsGuideIcons(guide) {
  if (!guide) return guide;
  const items = [...(guide.artifacts || []), ...(guide.alternates || []), guide.graduation]
    .filter(it => it?.name);
  await guideFileIcons(items);
  for (const it of items) {
    const u = guideIconCache.get(it.file || it.name);
    if (u) it.icon = u;
  }
  return guide;
}
