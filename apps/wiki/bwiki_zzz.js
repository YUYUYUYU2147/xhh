// 绝区零角色页（Bwiki）解析：顶部徽章 12 项 + 攻略三块
//
// 为什么需要这个模块：
//   角色详情/技能/影画/养成材料来自米游社百科（更新更快、角色最全），
//   但米游社 modules[0] **缺**种族、伤害类型、全名英文、实装日期、常驻限定这 5 项，
//   所以顶部徽章改以 Bwiki 为主、两个数据源在同一张卡上分工。
//
// 接口（与 zzz_role.js 同源，免 CK）：
//   https://wiki.biligame.com/zzz/api.php?action=parse&page={角色名}&prop=text&format=json
//
// 页面结构：
//   顶部 infobox 为标准表格，每行「标签 | 值」，且值格里自带图标（alt 形如
//   角色稀有度S.png / Logo-阵营图标-维多利亚家政.png / 图标-冰.png / 图标-强攻.png / 图标-斩击.png）。
//   生日与身高不在 infobox 内，在 CV 那一段的表格里。
//   攻略分为「配装推荐（驱动盘套装 + 推荐理由）」「词条推荐（主词条 / 副词条 + 理由）」
//   「音擎推荐（毕业音擎 + 可选音擎 + 理由）」三块。


const BWIKI_API = 'https://wiki.biligame.com/zzz/api.php';
const CACHE_TTL = 12 * 3600 * 1000;
const cache = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const zzzKey = v => String(v || '')
  .replace(/&amp;/g, '&')
  .replace(/[\s·・\-—_「」『』《》【】\[\]()]/g, '')
  .toLowerCase();

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', ndash: '–', mdash: '—' };
const decodeTxt = s => String(s || '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
  .replace(/&([a-z]+|#\d+);/gi, (m, n) => ENT[String(n).toLowerCase()] ?? m)
  .replace(/&nbsp;/g, ' ');

const plain = s => decodeTxt(String(s || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|tr|div)>/gi, '\n')
  .replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

// 缩略图 → 原图
const origIcon = src => String(src || '').replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');

/** 取出单元格里的文本与首个图片（alt + 原图 URL） */
function cell(raw) {
  const alt = decodeTxt((String(raw).match(/alt="([^"]+)"/) || [])[1] || '').replace(/\.png$/i, '');
  const src = origIcon((String(raw).match(/src="([^"]+)"/) || [])[1] || '');
  return { text: plain(raw), alt, icon: src };
}

/* 567 全局熔断：EdgeOne 的限流按 IP 生效，一次被拦意味着冷却窗口内都会被拦。
   列表头像认领会并发抓 60+ 个角色页，限流期间每个还要重试 3 次（退避累计 15 秒），
   整批耗时数分钟且互相加剧限流（实测一条指令因此拖到 1 分半）。触发一次熔断后，
   冷却期内所有抓取直接返回空串（不重试不等待），调用方自然回落 nanoka/米游社。 */
let blockUntil = 0;
const BLOCK_MS = 3 * 60 * 1000;

export async function fetchZzzBwikiPage(name) {
  const key = `page:${zzzKey(name)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  if (Date.now() < blockUntil) return '';
  /* 重试 3 次 + 递增退避：Bwiki 对 zzz 站限流很凶（567 EdgeOne）。
     原来只试 2 次、每次 1.5 秒，撞上限流就直接返回空串 → 上层回落旧模板
     （旧模板没有左上角图标、基础属性也缺），用户看到的就是「没有头像/没有数值」。
     这里多给一次机会，并把失败原因记进日志便于区分「限流」和「页面不存在」。 */
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const u = `${BWIKI_API}?action=parse&page=${encodeURIComponent(name)}&prop=text&format=json&redirects=1`;
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!(r.headers.get('content-type') || '').includes('json')) {
        lastErr = `风控拦截(HTTP ${r.status})`;
        // 一次风控即触发全局熔断：逐个重试只会互相加剧限流
        blockUntil = Date.now() + BLOCK_MS;
        logger.debug?.(`[xhh][bwiki_zzz] ${name} 触发限流熔断，3 分钟内 Bwiki 抓取全部跳过，调用方回落原模板`);
        return '';
      }
      const html = (await r.json())?.parse?.text?.['*'] || '';
      if (html) { cache.set(key, { t: Date.now(), v: html }); return html; }
      await sleep(1500 * (i + 1));
    } catch (e) {
      lastErr = `请求异常: ${e?.message || e}`;
      await sleep(2000 * (i + 1));
    }
  }
  if (lastErr) logger.debug?.(`[xhh][bwiki_zzz] ${name} 抓取失败：${lastErr}，调用方会回落原模板`);
  return '';
}

/* ══════════════ 角色图鉴页 → 阵营（列表头像角标用）═══════════════
   Bwiki「角色图鉴」的卡片与星铁图鉴同一套模板，阵营直接写在卡片的筛选属性里：

     <div class="role-box divsort" data-param1="S" data-param2="风"
          data-param3="罗斯凯利法·弗林特工坊" data-param4="击破">
       <a href="/zzz/洛克茜" title="洛克茜"><img alt="Logo-阵营图标-罗斯凯利法·弗林特工坊.png" src="…"></a>
       <a href="/zzz/洛克茜" title="洛克茜"><img alt="角色头像-洛克茜.png" src="…"></a>

   即 data-param3 是阵营名，块内第一张图就是该阵营的 Logo（原图 254×251，
   体积不大且 URL 不含中文，无需再拼缩略图）。
   阵营图标本仓库没有本地资源，与单角色卡的徽章走同一份 Bwiki 图。

   角色名两种数据源写法不一致（Bwiki「艾莲·乔」/ nanoka「艾莲」），
   因此按 zzzKey 归一化后建表，取用时精确匹配优先、包含匹配兜底。
   抓取失败（含 567 限流熔断）返回空 Map，调用方不渲染角标即可，列表不受影响。 */
let roleCampCache = null;

/** @returns {Promise<Map<string, {camp: string, icon: string}>>} 归一化角色名 → 阵营 */
export async function fetchZzzBwikiRoleCamps() {
  if (roleCampCache && Date.now() - roleCampCache.t < CACHE_TTL) return roleCampCache.v;
  const map = new Map();
  const html = await fetchZzzBwikiPage('角色图鉴');
  if (html) {
    // 每张卡片截到下一张卡片为止，避免跨卡片取到别人的 Logo
    const blocks = String(html).split(/(?=<div[^>]*class="[^"]*role-box)/).slice(1);
    for (const b of blocks) {
      const name = decodeTxt((b.match(/title="([^"]+)"/) || [])[1] || '').trim();
      const camp = decodeTxt((b.match(/data-param3="([^"]*)"/) || [])[1] || '').trim();
      const icon = origIcon((b.match(/<img[^>]*alt="Logo-阵营图标-[^"]*"[^>]*src="([^"]+)"/) || [])[1] || '');
      const key = zzzKey(name);
      if (key && camp && !map.has(key)) map.set(key, { camp, icon });
    }
  }
  if (!map.size) return map;
  roleCampCache = { t: Date.now(), v: map };
  return map;
}

/**
 * 解析 Bwiki 角色页。
 * @returns 徽章数组（顺序即展示顺序）、生日身高、以及攻略三块
 */
/** 「驱动盘套装」表格 → { set4:[], set2:[], reason } */
function parseDriveSets(html, heads) {
  const i = heads.findIndex(h => /驱动盘套装/.test(h.name));
  if (i < 0) return null;
  const from = heads[i].at;
  const to = heads[i + 1] ? heads[i + 1].at : html.length;
  const seg = html.slice(from, to);
  const out = { set4: [], set2: [], reason: '' };

  // 套装名要从图片 alt 取：值格里套装名会重复两次，且后面还跟着二/四效果、
  // 获取途径等大段文本，直接取文本会把整段效果文案当成套装名。
  const namesIn = raw => {
    const seen = new Set();
    const out2 = [];
    for (const m of String(raw || '').matchAll(/<img[^>]*alt="([^"]+)"[^>]*src="([^"]+)"/g)) {
      const nm = decodeTxt(m[1]).replace(/\.png$/i, '').trim();
      if (!nm || /^(驱动盘套装|Logo-|图标-)/.test(nm)) continue;
      if (seen.has(nm)) continue;
      seen.add(nm);
      out2.push({ name: nm, icon: origIcon(m[2]) });
    }
    return out2;
  };

  for (const t of seg.match(/<table[\s\S]*?<\/table>/g) || []) {
    for (const r of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
      const cs = [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]);
      if (cs.length < 2) continue;
      const t0 = cell(cs[0]).text;
      // 一行里并排「4件套 | 值 | 2件套 | 值」，故按标签所在下标分别归类
      for (let x = 0; x + 1 < cs.length; x += 2) {
        const label = cell(cs[x]).text.replace(/件套/g, '').trim();
        if (/^4/.test(label)) out.set4.push(...namesIn(cs[x + 1]));
        else if (/^2/.test(label)) out.set2.push(...namesIn(cs[x + 1]));
      }
      if (/推荐理由/.test(t0)) {
        const v = cs[cs.length - 1];
        out.reason = cell(v).text.replace(/^套装推荐理由/, '').trim();
      }
    }
  }
  // 同一套装可能同时出现在多行/多列（4 件套格里也含 2 件套的图），按名称去重
  const uniq = arr => [...new Map(arr.map(x => [x.name, x])).values()];
  out.set4 = uniq(out.set4);
  out.set2 = uniq(out.set2).filter(x => !out.set4.some(y => y.name === x.name));
  return (out.set4.length || out.set2.length || out.reason) ? out : null;
}

export function parseZzzBwikiPage(html) {
  if (!html) return null;
  const out = { badges: [], birthday: '', height: '', profile: '', avatar: '', avatars: {}, taches: {}, tachie: '', skillIcons: {}, baseStats: null, guide: null };
  const tables = String(html).match(/<table[\s\S]*?<\/table>/g) || [];

  // ── 顶部 infobox ──
  // 逐表扫描，找到含「全名/本名」或「阵营」标签的那张，即角色 infobox
  for (const t of tables) {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m =>
      [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => cell(c[1])));
    if (!rows.length) continue;
    const hasFull = rows.some(r => r[0]?.text === '全名/本名');
    const hasCamp = rows.some(r => r[0]?.text === '阵营');
    if (!hasFull && !hasCamp) continue;

    for (const r of rows) {
      if (r.length < 2) continue;
      const k = (r[0]?.text || '').trim();
      const c = r[1];
      // override：值格为空但可从图标 alt 推出来时使用（稀有度就是这种情况）
      const push = (key, label = key, override) => {
        const v = String(override ?? c.text ?? '').trim();
        if (v) out.badges.push({ k: label, v, icon: c.icon || '', iconUrl: true });
      };
      switch (k) {
        case '全名/本名': push('全名/本名'); break;
        case '阵营': push('阵营'); break;
        case '种族': push('种族'); break;
        case '性别': push('性别'); break;
        case '稀有度': {
          // 值格为空，稀有度只体现在图标 alt 上（角色稀有度S.png）
          const g = (c.alt || '').match(/角色稀有度\s*([SAB])/i);
          push('稀有度', `稀有度`, g ? `${g[1].toUpperCase()}级` : '');
          break;
        }
        case '常驻/限定': push('常驻/限定'); break;
        case '属性': push('属性'); break;
        case '特性': push('特性'); break;
        case '伤害类型': push('伤害类型'); break;
        case '实装日期': push('实装日期'); break;
        case '生日': out.birthday = (c.text || '').trim(); break;
        case '身高': out.height = (c.text || '').trim(); break;
        default: break;
      }
    }
    break; // infobox 只取第一张匹配的表
  }

  // 生日与身高不在 infobox 内，在 CV 那一段的表格里，这里全表兜底扫一次
  if (!out.birthday || !out.height) {
    for (const t of tables) {
      const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m =>
        [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => cell(c[1])));
      for (const r of rows) {
        if (r.length < 2) continue;
        const k = (r[0]?.text || '').trim();
        if (k === '生日' && !out.birthday) out.birthday = (r[1]?.text || '').trim();
        if (k === '身高' && !out.height) out.height = (r[1]?.text || '').trim();
      }
      if (out.birthday && out.height) break;
    }
  }

  // ── 攻略三块 ──
  // 页面里以「配装推荐」「词条推荐」「音擎推荐」为标题，其后到下一个同级标题之间的内容即该块。
  const guide = { drive: null, stats: null, weapon: null };
  // 必须按**标题节点**定位，不能用 indexOf('配装推荐') —— 目录里有同名锚点，
  // 第一版就因此只切到 5~7 字（切到目录项后立刻遇到下一个目录项就结束）。
  // 标题节点的稳定特征是 class="mw-headline"。
  const heads = [...html.matchAll(/<span class="mw-headline"[^>]*>([\s\S]*?)<\/span>/g)]
    .map(m => ({ name: plain(m[1]).replace(/\[.*?\]$/g, '').trim(), at: m.index }))
    .filter(h => h.name);
  // ── 技能图标 + 角色头像（都取 Bwiki 原图，不要thumb 缩略）──
  // 技能图标 alt 形如「技能-普通攻击图标.png」，key 用中间那段技能名；
  // 角色头像 alt 形如「角色头像-艾莲.png」。页面上给的是 30px/80px 缩略，
  // origIcon() 去掉 /thumb/…/Npx- 前缀换成原图，卡面放大才不糊。
  {
    for (const m of html.matchAll(/<img[^>]*alt="技能-([^"]+?)图标\.png"[^>]*src="([^"]+)"/g)) {
      const k = decodeTxt(m[1]).trim();
      if (k && !out.skillIcons[k]) out.skillIcons[k] = origIcon(m[2]);
    }
    // 角色头像必须**按名字取**，不能取页面里第一个：
    // 未实装角色（如洛克茜）的词条页只有导航框，那 60 张 `角色头像-*.png`
    // 全是别的角色 —— 取第一个就会把希格莉德的头像安到洛克茜头上（实测）。
    // 所以这里存成 {归一化名: URL}，由 fetchZzzBwikiChar 按角色名挑。
    for (const m of html.matchAll(/<img[^>]*alt="角色头像-([^"]+?)\.png"[^>]*src="([^"]+)"/g)) {
      const k = zzzKey(decodeTxt(m[1]));
      if (k && !out.avatars[k]) out.avatars[k] = origIcon(m[2]);
    }
    // 立绘：整卡背景图用（米游社 tachie 拿不到时的回落）
    for (const m of html.matchAll(/<img[^>]*alt="角色立绘-([^"]+?)(?:-官方介绍\d*)?\.png"[^>]*src="([^"]+)"/g)) {
      const k = zzzKey(decodeTxt(m[1]));
      if (k && !out.taches[k]) out.taches[k] = origIcon(m[2]);
    }
  }

  // ── 角色详情（Bwiki「详细情报」）──
  // 为什么用它不用米游社的：米游社那边「角色详情」是 角色故事(modules[1])
  // + 角色印象(modules[5]) 拼接而成，体量极大（洛克茜 859 字、菲林斯近 9000 字），
  // 而且和技能/影画描述里的措辞大量重复，卡面被撑得很长。
  // Bwiki 的「详细情报」是同一段角色小传的精简版，一段话讲完性格与背景，
  // 长度可控且不与其它板块重复。
  {
    const i = heads.findIndex(h => h.name === '详细情报');
    if (i >= 0) {
      const to = heads[i + 1] ? heads[i + 1].at : html.length;
      const txt = plain(html.slice(heads[i].at, to))
        .replace(/^详细情报/, '')
        // 页面工具条/折叠块会留下「[编辑]」「折叠」「提升信赖至…」这类噪声行
        .replace(/^\s*(\[编辑\]|折叠|收起)\s*$/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
      // 未实装角色的「详细情报」是空壳（实测只剩 14 个字的标题残渣），
      // 这种长度视为没有，交给调用方回落米游社的角色故事+印象。
      if (txt.length >= 40) out.profile = txt;
    }
  }

  // ── 基础属性（Bwiki「属性数据」）──
  // 两张表：一张是 1/10/…/60 级的 生命/攻击/防御 成长（突破前 + 突破后），
  // 另一张是固定值（暴击率/暴击伤害/冲击力/异常掌控/异常精通/穿透率/能量自动回复）。
  // 米游社那边没有可用数值（官方是 JS 滑块，接口不返回），所以只能取 Bwiki。
  {
    const i = heads.findIndex(h => h.name === '属性数据');
    if (i >= 0) {
      const to = heads[i + 1] ? heads[i + 1].at : html.length;
      const seg = html.slice(heads[i].at, to);
      let growth = [];   // 后面要重新赋值裁到最高等级，别用 const
      const fixed = [];
      const num = v => String(v || '').replace(/,/g, '');
      const pickOf = (a, b) => (/^[\d]/.test(String(b || '')) ? b : a);
      for (const t of seg.match(/<table[^>]*>[\s\S]*?<\/table>/g) || []) {
        // 按顺序取每一行的单元格；行与行之间有换行，所以不能用 ^<tr 定位「下一行」
        const rows = (t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])
          .filter(tr => !/display\s*:\s*none/i.test(tr))
          .map(tr => ({
            cells: [...tr.matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)]
              .map(x => ({ text: cell(x[2]).text.trim(), span: Number((x[1].match(/colspan="?(\d+)/) || [])[1] || 1) })),
          }));
        for (let r = 0; r < rows.length; r++) {
          const cs = rows[r].cells;
          if (!cs.length) continue;
          const flat = [];
          for (const c of cs) for (let k = 0; k < c.span; k++) flat.push(c.text);
          // 成长表行首是等级（纯数字）
          if (/^\d+$/.test(cs[0].text)) {
            // colspan=2 的行（Lv.1）只有 4 个值：生命/攻击/防御
            const g = flat.length <= 4
              ? { lv: flat[0], hp: flat[1], atk: flat[2], def: flat[3] }
              : { lv: flat[0], hp: pickOf(flat[1], flat[2]), atk: pickOf(flat[3], flat[4]), def: pickOf(flat[5], flat[6]) };
            growth.push(g);
            continue;
          }
          // 固定值表：th 行是属性名，后面最近的 td 行是数值
          // 「突破前 / 突破后」是成长表的第二行表头，不是属性名，
          // 不跳过的话它会把下一行（Lv.1）当成数值吃掉，Lv.1 整档丢失。
          if (cs.some(c => /突破(前|后)/.test(c.text))) continue;
          const isName = cs.every(c => /[\u4e00-\u9fa5A-Za-z]/.test(c.text) && !/%$/.test(c.text));
          const nextCells = rows[r + 1]?.cells || [];
          if (isName && cs.length && nextCells.length && nextCells.every(c => !/[\u4e00-\u9fa5]{2,}/.test(c.text))) {
            const vals = [];
            for (const c of nextCells) for (let k = 0; k < c.span; k++) vals.push(c.text);
            cs.forEach((c, i) => { if (c.text && vals[i]) fixed.push({ k: c.text, v: vals[i] }); });
            r++;
          }
        }
      }
      /* 属性数据里的 1~60 级成长表只保留**最高等级**那一行（与原神/星铁角色卡同一口径）。
         ——一张表 60 行，卡片多长一屏没用。 */
      if (growth.length > 1) {
        const lvOf = g => Number(String(g?.lv ?? '').replace(/[^\d.]/g, ''))
        growth = [growth.reduce((a, b) => (Number.isFinite(lvOf(b)) && lvOf(b) >= lvOf(a) ? b : a))]
      }
      if (growth.length || fixed.length) out.baseStats = { growth, fixed };
    }
  }

  /**
   * 取某标题下**第一张**表格（桌面版 div.visible-md/sm/lg 里的那张）。
   *
   * 为什么必须只取第一张：Bwiki 每块内容渲染了两份（visible-md 桌面版 +
   * visible-xs 移动版），纯文本切片会把两份都吃进来 —— 词条推荐整块
   * 原样重复两遍（实测艾莲那块 1626 字符里有一半是重复），
   * 去重按行根本压不掉（两份的行边界不一致）。
   */
  const firstTable = kw => {
    const i = heads.findIndex(h => h.name === kw);
    if (i < 0) return '';
    const to = heads[i + 1] ? heads[i + 1].at : html.length;
    const seg = html.slice(heads[i].at, to);
    const md = seg.match(/<div class="visible-md[^"]*">([\s\S]*?)<\/table>/);
    if (md) return md[1];
    return (seg.match(/<table[\s\S]*?<\/table>/) || [''])[0];
  };
  const rowsOf = t => (String(t).match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])
    .map(r => [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => m[1]));

  // ── 词条推荐：主词条（按号位）/ 副词条 / 理由 ──
  // 原先是整块纯文本，重复且冗长；改成结构化后卡面高度能砍掉一半。
  {
    const rows = rowsOf(firstTable('词条推荐'));
    const stats = { main: [], sub: '', reason: '' };
    let wantReason = false;
    for (const cs of rows) {
      // 「词条推荐理由」那张 th 独占一行，正文在紧随其后的单格行里
      if (cs.length === 1) {
        if (/理由/.test(cell(cs[0]).text)) wantReason = true;
        else if (wantReason && plain(cs[0]).length > 10) stats.reason = plain(cs[0]).trim();
        continue;
      }
      // 桌面版一行并排「主词条 | 值 | 副词条 | 值」，按标签下标成对取
      for (let x = 0; x + 1 < cs.length; x += 2) {
        const label = cell(cs[x]).text;
        const val = cs[x + 1];
        if (/主词条/.test(label)) {
          // 值格里每个号位是一行：<span class="x-button">四号位</span>暴击伤害、暴击率
          for (const m of val.matchAll(/<span class="x-button">([\s\S]*?)<\/span>([\s\S]*?)(?=<br\s*\/?>|<span class="x-button"|$)/g)) {
            const slot = plain(m[1]).trim();
            const text = plain(m[2]).trim();
            if (slot || text) stats.main.push({ slot, text: text || slot });
          }
        } else if (/副词条/.test(label)) {
          stats.sub = plain(val).trim();
        } else if (/理由/.test(label)) {
          stats.reason = plain(val).replace(/^词条推荐理由/, '').trim();
        }
      }
    }
    guide.stats = (stats.main.length || stats.sub || stats.reason) ? stats : null;
  }

  // ── 音擎推荐：只留音擎名 + 稀有度 + 推荐理由 ──
  // 值格里塞的是完整面板（基础属性 5 档 + 技能文案 + 逐级百分比），
  // 纯文本切片后是卡面里最长的一块（艾莲那块 4000+ 字符），
  // 而「哪把毕业、为什么选它」才是玩家要的信息，数值差一档不影响判断。
  {
    const rows = rowsOf(firstTable('音擎推荐'));
    const weapon = { best: [], alt: [], reason: '' };
    const namesIn = raw => {
      const seen = new Set();
      const out = [];
      // 音擎名在 sr-iconTitle 的 font 里；图标 alt 形如「图标-材料稀有度-S.png」
      for (const m of String(raw || '').matchAll(/<div class="sr-iconTitle">[\s\S]*?<font>([^<]+)<\/font>/g)) {
        const name = decodeTxt(m[1]).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const img = String(raw).match(new RegExp(`<img[^>]*alt="${name}[^"]*"[^>]*src="([^"]+)"`)) || [];
        const rar = String(raw).match(/alt="图标-材料稀有度-([SAB])/i) || [];
        out.push({ name, icon: origIcon(img[1] || ''), rarity: rar[1] ? `${rar[1].toUpperCase()}级` : '' });
      }
      // 稀有度按出现顺序与音擎一一对应，逐条回填
      const rars = [...String(raw).matchAll(/alt="图标-材料稀有度-([SAB])/gi)].map(m => `${m[1].toUpperCase()}级`);
      out.forEach((o, i) => { if (rars[i]) o.rarity = rars[i]; });
      return out;
    };
    for (const cs of rows) {
      if (cs.length < 2) continue;
      const label = cell(cs[0]).text;
      const val = cs[cs.length - 1];
      // 「可选音擎」在页面上是**多行**（实测艾莲那块有 4 行），
      // 每行一两把；之前直接赋值只剩最后一行，8 把里丢了 6 把。
      if (/毕业音擎/.test(label)) weapon.best.push(...namesIn(val));
      else if (/可选音擎/.test(label)) weapon.alt.push(...namesIn(val));
      else if (/推荐理由/.test(label)) {
        const t = plain(val).trim();
        if (t && !weapon.reason.includes(t)) weapon.reason = weapon.reason ? `${weapon.reason}\n${t}` : t;
      }
    }
    weapon.alt = weapon.alt.filter(w => !weapon.best.some(b => b.name === w.name));
    // 去重（同一行里图标与隐藏标题会各出一份）
    const uniqW = arr => [...new Map(arr.map(x => [x.name, x])).values()];
    weapon.best = uniqW(weapon.best);
    weapon.alt = uniqW(weapon.alt).filter(w => !weapon.best.some(b => b.name === w.name));
    guide.weapon = (weapon.best.length || weapon.alt.length || weapon.reason) ? weapon : null;
  }
  // 配装推荐：正文在「驱动盘套装」标题下的表格里，纯文本切片只能拿到标题，
  // 所以这里按表格结构解析：4 件套 / 2 件套各一行（套装名 + 图标），末行是推荐理由。
  guide.drive = parseDriveSets(html, heads);
  out.guide = (guide.drive || guide.stats || guide.weapon) ? guide : null;
  return out;
}

/** 按名字取 Bwiki 角色页数据 */
export async function fetchZzzBwikiChar(name) {
  const html = await fetchZzzBwikiPage(name);
  const d = parseZzzBwikiPage(html);
  if (!d) return null;
  // 头像按名字认领；认不到就留空，让调用方回落米游社立绘，
  // 绝不能拿导航框里别的角色的头像来顶。
  d.avatar = d.avatars?.[zzzKey(name)] || '';
  d.tachie = d.taches?.[zzzKey(name)] || '';
  if (d.birthday) d.badges.push({ k: '生日', v: d.birthday, icon: '', iconUrl: false });
  if (d.height) d.badges.push({ k: '身高', v: d.height, icon: '', iconUrl: false });
  return d;
}

/* ══════════════ 音擎页（Bwiki）══════════════
   绝区零音擎卡改用 Bwiki 版式：米游社 entry_page 给的是「面板 + 技能 + 材料」三段，
   排出来和 Bwiki 词条页那种「左属性右效果、下方版本/代理人/获取途径、再下方面板与材料」
   的两列表完全不一样。这里按 Bwiki 的 7 张表逐张解析，卡面直接照抄它的结构。

   实测表结构（以深海访客为例）：
     t0 基础属性   基础攻击力 48~713         | 副属性 暴击率 9.6~24%
     t1 音擎效果   技能名 诸洋之王 + 效果正文
     t2 实装版本   1.0（2024年07月04日）| 相关代理人(头像+rarity) | 获取途径 限定调频 | 音擎特性 强攻
     t3 音擎TAG
     t4 详细面板   等级 | 基础攻击力(突破前/后) | 暴击率
     t5 突破材料   各阶段材料 + 总计
     t6 音擎信息   一句话简介 + 音擎故事
*/
const wqPlain = s => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|tr|div|td|th)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{2,}/g, '\n')
  .trim();

/**
 * 把百分比数值包成蓝色 span（Bwiki 词条页里这些数字就是 #4571ec 的）。
 * 我们取数时把 HTML 标签全剥了，颜色信息丢失，所以在解析后按数值补回来：
 * 25% / 12.5% / 30% 这类都染蓝，读卡时一眼能抓到收益点。
 * ⚠ 模板必须用 {{@talent.desc}}（不转义）输出，否则 span 会变成字面量。
 */
const paintNumbers = txt => String(txt || '')
  // 先整体处理「一串斜杠分隔的数值」：Bwiki 原文常写成 `10%/12.5%/15%/17.5/20%`，
  // 中间的 17.5 **漏了百分号**（实测多处如此），
  // 逐个匹配 `数字%` 会把它漏在染色之外，看着像少了一段。
  // 这里按「斜杠串 + 末尾 %」整段抓，再把串里每个数字逐个包起来。
  .replace(/\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*\s*%/g, run =>
    run.replace(/\d+(?:\.\d+)?/g, n => `<span class="num">${n}</span>`))
  // 落单的百分数（前面不是斜杠串的，例如单独的 24%）
  .replace(/(?<![\d/])([\d.]+)\s*%/g, '<span class="num">$1</span>')
  // % 归到 span 里（颜色连百分号一起，视觉上更整）
  .replace(/<span class="num">([\d.]+)<\/span>\s*%/g, '<span class="num">$1%</span>')
  .replace(/<span class="num">\s*<\/span>/g, '');
/**
 * 故事正文排版：Bwiki 正文每句后都有 <br>，纯文本化后每句独占一行，卡面行数暴涨。
 * 中文不需空格，把**软换行合并**（按容器宽度自然折行），只保留真正的段落分隔。
 */
const flowStory = txt => String(txt || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\u0000')
    .replace(/\n/g, '')
    .replace(/\u0000/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();



export function parseZzzBwikiWeapon(html) {
  if (!html) return null;
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  const out = { baseAtk: '', randName: '', randValue: '', talent: { name: '', desc: '' }, version: '', versionDate: '', agents: [], obtain: '', feat: '', panel: [], materials: [], materialTotal: [], brief: '', story: '' };
  for (const t of tables) {
    const txt = wqPlain(t);
    // t0 基础属性
    if (/基础攻击力/.test(txt) && /副属性/.test(txt) && !out.baseAtk) {
      out.baseAtk = (txt.match(/基础攻击力\s*([\d~]+%?)/) || [])[1] || '';
      out.randName = (txt.match(/副属性\s*([^\d\s][^\n]*?)\s*[\d~]/) || [])[1]?.trim() || '';
      out.randValue = (txt.match(/副属性[\s\S]*?([\d.]+~[\d.]+%)/) || [])[1] || '';
      continue;
    }
    // t1 音擎效果：技能名在 <div class="skill-text"> 里，正文是该表剩余文本
    if (/音擎效果/.test(txt) && !out.talent.name) {
      out.talent.name = wqPlain((t.match(/<div class="skill-text">([\s\S]*?)<\/div>/) || [])[1] || '');
      out.talent.desc = txt.replace(/^音擎效果/, '').replace(out.talent.name, '').trim();
      continue;
    }
    // t2 版本 / 代理人 / 获取途径 / 特性
    if (/实装版本/.test(txt) && !out.version) {
      out.version = (txt.match(/实装版本\s*([\d.]+)/) || [])[1] || '';
      out.versionDate = (txt.match(/（([^）]*\d{4}[^）]*)）/) || [])[1] || '';
      out.obtain = (txt.match(/获取途径\s*([^\n]+)/) || [])[1]?.trim() || '';
      out.feat = (txt.match(/音擎特性\s*([^\n]+)/) || [])[1]?.trim() || '';
      // 相关代理人：icon1-item 块里 alt 是角色名，rarity-S/A 给出稀有度
      for (const m of t.matchAll(/<div class="icon1-item">([\s\S]*?)<\/div>/g)) {
        const blk = m[1];
        // alt 形如「角色头像-艾莲.png」，要去掉前缀和扩展名才是角色名
        const nm = decodeTxt((blk.match(/alt="([^"]+)"/) || [])[1] || '')
          .replace(/^角色头像-/, '').replace(/\.png$/i, '').trim();
        const rar = (blk.match(/rarity-([SAB])/i) || [])[1] || '';
        const img = origIcon((blk.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
        if (nm && !out.agents.some(a => a.name === nm)) out.agents.push({ name: nm, icon: img, rarity: rar });
      }
      if (!out.agents.length) {
        for (const m of t.matchAll(/<img[^>]*alt="([^"]+)"[^>]*src="([^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*(\d*)/g)) {
          const nm = decodeTxt(m[1]).trim();
          if (!nm || /^(图标|Logo)/.test(nm)) continue;
          if (out.agents.some(a => a.name === nm)) continue;
          out.agents.push({ name: nm, icon: origIcon(m[2]), rarity: '' });
        }
      }
      continue;
    }
    // t4 详细面板
    // 表头三行：等级|基础攻击力(colspan=2)|暴击率 → 突破前|突破后。
    // 数据行形如 `<td>10级</td><td>122</td><td>166</td><td>12.48%</td>`，
    // 初始/满级两行则是 `<td>初始</td><td colspan=2>48</td><td>9.6%</td>`。
    if (/详细面板/.test(txt) && /等级/.test(txt)) {
      const rows = [...t.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]);
      let cols = 0;
      for (const tr of rows) {
        const cs = [...tr.matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)]
          .map(x => ({ span: Number((x[1].match(/colspan="?(\d+)/) || [])[1] || 1), t: wqPlain(x[2]) }));
        if (!cs.length) continue;
        if (/等级/.test(cs[0].t)) { cols = cs.reduce((n, c) => n + c.span, 0) - 1; continue; }
        if (/突破前|突破后/.test(cs[0].t)) continue;
        if (!cols) continue;
        const cells = [];
        for (let i = 1; i < cs.length; i++) {
          for (let k = 0; k < cs[i].span; k++) cells.push(cs[i].t);
        }
        // 只保留纯数值格（等级格已在 cs[0] 里，重复的等级数字也在这里被滤掉）。
        // **必须带上 colspan**：初始/满级两行是 `<td colspan=2>48</td>`，
        // 丢掉 colspan 就会让这两个值错位到「暴击率」列（实测显示成 初始 9.6% 48）。
        // 每格只产出一项，colspan 原样带出（不能按 span 展开成多格，
        // 否则初始/满级那两行的 48 会占掉两列，暴击率被挤出表外）。
        const vals = [];
        for (let i = 1; i < cs.length; i++) {
          const v = cs[i].t.trim();
          if (!/^\d+(\.\d+)?%?$/.test(v)) continue;
          vals.push({ v, span: cs[i].span > 1 ? cs[i].span : 0 });
        }
        if (!vals.length) continue;
        out.panel.push({ lv: cs[0].t.replace(/级$/, ''), cells: vals.slice(0, cols) });
      }
      continue;
    }
    // t5 突破材料
    // 每行只有两列：「10级突破」| 一格 HTML，里面每个材料是一个
    // div.sr-iconLarge —— sr-iconLTop 是数量、font 是名称、img 是图标。
    // （按 <td> 切分必然错位，data-entry-* 那套是米游社的写法，Bwiki 没有。）
    if (/突破材料/.test(txt) && /(总计|级突破)/.test(txt)) {
      const rows = [...t.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]);
      for (const tr of rows) {
        const cs = [...tr.matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)].map(x => ({ raw: x[2], t: wqPlain(x[2]) }));
        if (cs.length < 2) continue;
        const isTotal = /总计/.test(cs[0].t);
        if (!isTotal && !/级突破/.test(cs[0].t)) continue;
        const items = [];
        for (let i = 1; i < cs.length; i++) {
          for (const m of cs[i].raw.matchAll(/<div class="sr-iconLarge[\s\S]*?<\/div>\s*<div>([\s\S]*?)<\/div>/g)) {
            const blk = m[0];
            const num = decodeTxt((blk.match(/class="sr-iconLTop">([\s\S]*?)<\/div>/) || [])[1] || '').trim();
            const nm = decodeTxt((blk.match(/<font>([^<]+)<\/font>/) || [])[1] || '').trim();
            const img = origIcon((blk.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
            if (!nm || items.some(x => x.name === nm)) continue;
            items.push({ name: nm, num, img });
          }
          // 无 sr-iconLarge 的老写法：纯文本「12000 丁尼」
          if (!items.length) {
            const txt = cs[i].t.replace(/\s*\n\s*/g, ' ').trim();
            const m = txt.match(/^([\d.万]+)\s*(.+)$/);
            if (m) items.push({ name: m[2].trim(), num: m[1], img: '' });
          }
        }
        if (!items.length) continue;
        if (isTotal) out.materialTotal = items;
        else out.materials.push({ stage: cs[0].t, items });
      }
      continue;
    }
    // t6 音擎信息 + 音擎故事
    if (/音擎信息|音擎故事/.test(txt)) {
      const info = (txt.match(/音擎信息\s*([^\n]+)/) || [])[1]?.trim() || '';
      if (info) out.brief = info;
      const story = txt.split(/音擎故事/).slice(1).join('\n').trim();
      if (story) out.story = story;
      continue;
    }
  }
  // 百分比染蓝（音擎效果正文与故事里都可能有收益数值）
  out.talent.desc = paintNumbers(out.talent.desc);
  out.brief = paintNumbers(out.brief);
  // 故事：合并软换行，避免每句一行
  out.story = flowStory(out.story);
  const ok = out.baseAtk || out.talent.name || out.panel.length || out.materials.length;
  return ok ? out : null;
}

export async function fetchZzzBwikiWeapon(name) {
  const html = await fetchZzzBwikiPage(name);
  if (!html) return null;
  /* Bwiki 词条名跨类型共用：查音擎时「鲨牙布」会把**邦布页**当音擎页解析，
     出一张几乎全空的卡（基础攻击力空、面板空、材料还是邦布突破材料、10/40级突破还重复两次）。
     音擎页必须带「音擎」标记，否则一律判不是音擎，交回上层回落。 */
  const isWeaponPage = /音擎效果|音擎图标|音擎特性|基础攻击力/.test(html)
  const isOtherType = /邦布连携技|额外能力|主动技|驱动盘/.test(html)
  if (isOtherType && !isWeaponPage) {
    logger.debug?.(`[xhh][ZZZ音擎] 「${name}」的 Bwiki 页是邦布/驱动盘页，不是音擎页，不走音擎卡`);
    return null;
  }
  if (html && !isWeaponPage) {
    logger.debug?.(`[xhh][ZZZ音擎] 「${name}」的 Bwiki 页无音擎特征，判为非音擎`);
    return null;
  }
  const d = parseZzzBwikiWeapon(html);
  if (!d) return null;
  // 同一页有多张材料表时按「档位 + 材料」去重，避免 10级突破 出现两次
  {
    const seen = new Set();
    d.materials = (d.materials || []).filter(m => {
      const k = String(m?.stage || '') + '|' + (m?.items || []).map(i => `${i?.name}×${i?.num}`).join(',');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  // 图鉴大图：音擎方图（列表那张）
  const av = html.match(/<img[^>]*alt="([^"]*?)音擎图标\.png"[^>]*src="([^"]+)"/);
  if (av) d.icon = origIcon(av[2]);
  return d;
}

/* ══════════════ 驱动盘页（Bwiki）══════════════
   版式照抄 Bwiki 驱动盘词条：
     t0 图标（驱动盘图标-{名}.png）
     t1 二件套效果 / 四件套效果 / 驱动盘描述 / 获取途径 / 实装版本 / TAG
     「驱动盘故事」标题下是 resp-tab 页签（1~6 号位），每页一段

   与音擎页不同：驱动盘没有「基础属性/详细面板/突破材料」，
   也没有相关代理人（要自己从导航框 role-box 里捞，那是全站导航，不能当本页数据）。
*/
export function parseZzzBwikiDisc(html) {
    if (!html) return null;
    const strip = s => String(s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|li|tr|div|td|th)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n').trim();
    const out = { icon: '', set2: '', set4: '', desc: '', obtain: '', version: '', tags: '', rarity: '', stories: [] };

    // 图标 + 稀有度：class="disc-table-S2" 里的 S/A/B + 位数
    const rar = (html.match(/disc-table-([SAB])/i) || [])[1];
    out.rarity = rar ? `${rar.toUpperCase()}级` : '';
    const ic = html.match(/alt="驱动盘图标-[^"]*?\.png"[^>]*src="([^"]+)"/);
    if (ic) out.icon = origIcon(ic[1]);

    for (const t of html.match(/<table[\s\S]*?<\/table>/g) || []) {
        const txt = strip(t);
        if (!/二件套效果|四件套效果/.test(txt)) continue;
        for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
            const cs = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => strip(m[1]));
            if (!cs.length) continue;
            // 实装版本 / TAG 可能在同一 tr 的两个 td 里，要逐个单元格判断
            for (const body of cs) {
                if (/二件套效果/.test(body)) out.set2 = body.replace(/^二件套效果/, '').trim();
                else if (/四件套效果/.test(body)) out.set4 = body.replace(/^四件套效果/, '').trim();
                else if (/驱动盘描述/.test(body)) out.desc = body.replace(/^驱动盘描述/, '').trim();
                else if (/获取途径/.test(body)) out.obtain = body.replace(/^获取途径/, '').trim();
                else if (/实装版本/.test(body)) out.version = body.replace(/^实装版本/, '').trim();
                else if (/^TAG/.test(body)) out.tags = body.replace(/^TAG/, '').trim();
            }
        }
        if (out.set2 || out.set4) break;
    }

    // 驱动盘故事：标题后的 resp-tab 页签，每页一段
    const i = html.indexOf('id="驱动盘故事"');
    if (i >= 0) {
        const seg = html.slice(i, i + 20000);
        const boxEnd = seg.search(/id="WIKI底部导航"|模板:WIKI底部导航/);
        const scope = boxEnd > 0 ? seg.slice(0, boxEnd) : seg.slice(0, 8000);
            for (const m of scope.matchAll(/<div class="resp-tab-content"[^>]*>([\s\S]*?)<\/div>/g)) {
                const t = strip(m[1]);
                if (!t || out.stories.includes(t)) continue;
                // 页签容器尾部混进了全站导航框的 role-name（角色名），
                // 特征是「纯短人名、没有句读」，按这个剔除。
                if (/^[\u4e00-\u9fa5A-Za-z·\s]{1,8}$/.test(t) && !/[。！？，、]/.test(t)) continue;
                out.stories.push(t);
            }
    }
    // 百分比染蓝（套装效果里的收益数值）
    out.set2 = paintNumbers(out.set2);
    out.set4 = paintNumbers(out.set4);
    out.stories = (out.stories || []).map(v => flowStory(v));
    out.story = flowStory(out.story);
    const ok = out.set2 || out.set4 || out.desc;
    return ok ? out : null;
}

export async function fetchZzzBwikiDisc(name) {
    const html = await fetchZzzBwikiPage(name);
    return parseZzzBwikiDisc(html);
}

/**
 * 取出顶层表格的完整 HTML（正确处理嵌套）。
 * `/<table[\s\S]*?<\/table>/g` 会在**第一个** </table> 就截断，
 * 而邦布技能块的「详细属性」是嵌在技能表里的子表 ——
 * 那样截出来的主表会被拦腰砍断，子表整块丢失（实测 detailRows 恒为 0）。
 */
function topLevelTables(html) {
    const src = String(html || '');
    const out = [];
    let depth = 0, start = -1;
    const tagRe = /<table\b[^>]*>|<\/table>/g;
    let m;
    while ((m = tagRe.exec(src))) {
        if (m[0][1] === '/') {
            depth--;
            if (depth === 0 && start >= 0) { out.push(src.slice(start, m.index + m[0].length)); start = -1; }
        } else {
            if (depth === 0) start = m.index;
            depth++;
        }
    }
    return out;
}

/* ══════════════ 邦布页（Bwiki）══════════════
   版式照抄 Bwiki 邦布词条（以艾瑞儿为例）：
     t0 基础信息：初始攻击力 / 伤害属性 / 实装版本 / 获取途径 / 相关阵营 / 阵营代理人 / 邦布TAG
     t1 技能a「主动技」   —— 技能名 + 描述 + 详细属性(LV1~LV10)
     t2 技能b「额外能力」
     t3 技能c「邦布连携技」
     t4 邦布面板（等级/生命值/攻击力/防御力，各带突破前后）
     t5 邦布面板第二张（暴击率/暴击伤害/冲击力/异常掌控）
     t6 突破材料（各阶段 + 总计）—— t7 是同一份的移动版副本，只取第一份
*/
export function parseZzzBwikiBangboo(html) {
    if (!html) return null;
    const strip = s => String(s || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|li|tr|div|td|th)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n').trim();
    const out = {
        icon: '', atk: '', dmgType: '', version: '', obtain: '', camp: '', campAgent: '', tags: '', agents: [],
        rarityIcon: '', dmgIcon: '',
        skills: [], panel: [], panelSub: [], panelSubHead: [], materials: [], materialTotal: [],
    };
    const rar = (html.match(/bangboo-table-([SAB])/i) || [])[1];
    out.rarity = rar ? `${rar.toUpperCase()}级` : '';
    // 邦布没有「图标-」那类方图，导航框与本页共用「邦布立绘-{名}.png」
    const ic = html.match(/<img[^>]*alt="邦布立绘-([^"]+?)\.png"[^>]*src="([^"]+)"/);
    if (ic) out.icon = origIcon(ic[2]);

            /* 稀有度 / 属性小图标（Bwiki 页面上的官方图标，用户指定要显示）：
           稀有度在标题区 `bangboo-title-S .rarity-img` 里的「图标-材料稀有度-S.png」，
           属性在「图标-冰属性.png」这类 alt 上 —— 两者都**不在基础信息表里**，
           之前放在表格循环里取，永远取不到（实测角标为 0）。 */
        out.rarityIcon = origIcon((html.match(/alt="图标-材料稀有度-[SABC]\.png"[^>]*src="([^"]+)"/) || [])[1] || '');
        /* 属性图标 alt 是「图标-冰.png」这种**单字属性名**（不是「图标-冰属性.png」），
           出现在「伤害属性」标题右侧；页面里还有「图标-强攻/击破/异常…」是强攻类型装饰，
           用「伤害属性」标题定位才不会认错。 */
        const dmgRow = html.slice(Math.max(0, html.indexOf('title-text">伤害属性') - 200), html.indexOf('title-text">伤害属性') + 600);
        out.dmgIcon = origIcon((dmgRow.match(/alt="图标-([^"]+?)\.png"[^>]*src="([^"]+)"/) || [])[2] || '');
        if (!out.dmgType) out.dmgType = decodeTxt((dmgRow.match(/alt="图标-([^"]+?)\.png"/) || [])[1] || '');
for (const t of topLevelTables(html)) {
        const txt = strip(t);
        // t0 基础信息
        if (/初始攻击力/.test(txt) && !out.atk) {
            out.atk = (txt.match(/初始攻击力\s*([\d.]+)/) || [])[1] || '';
            out.dmgType = (txt.match(/伤害属性\s*([^\n]+)/) || [])[1]?.trim() || '';
            out.version = (txt.match(/实装版本\s*([\s\S]*?)\n/) || [])[1]?.trim() || '';
            out.obtain = (txt.match(/获取途径\s*([\n\s]*[^\n\s][^\n]*)/) || [])[1]?.trim() || '';
            out.camp = (txt.match(/相关阵营\s*([^\n]+)/) || [])[1]?.trim() || '';
            /* 相关代理人：按 icon1-item 块取（alt=「角色头像-X.png」→ 去前缀去扩展名）。
               原来直接取「阵营代理人」后面的**纯文本**，alt 里的 `xxx.png`
               会被 stripHtml 留下来，卡上就出现「阵营代理人 · 安德烈.png」这种文字（用户实图）。 */
            for (const m of t.matchAll(/<div class="icon1-item">([\s\S]*?)<\/div>/g)) {
                const blk = m[1];
                const nm = decodeTxt((blk.match(/alt="([^"]+)"/) || [])[1] || '')
                    .replace(/^角色头像-/, '').replace(/\.png$/i, '').trim();
                const rar = (blk.match(/rarity-([SAB])/i) || [])[1] || '';
                const img = origIcon((blk.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
                if (nm && !/^(图标|Logo)/.test(nm) && !out.agents.some(a => a.name === nm)) {
                    out.agents.push({ name: nm, icon: img, rarity: rar });
                }
            }
            // 没有 icon1-item 块时退回按 alt 兜（老页面结构）
            if (!out.agents.length) {
                for (const m of t.matchAll(/<img[^>]*alt="角色头像-([^"]+?)\.png"[^>]*src="([^"]+)"/g)) {
                    const nm = decodeTxt(m[1]).trim();
                    if (nm && !out.agents.some(a => a.name === nm)) {
                        out.agents.push({ name: nm, icon: origIcon(m[2]), rarity: '' });
                    }
                }
            }
            out.tags = (txt.split(/邦布TAG/)[1] || '').trim();
            continue;
        }
        // 技能块：class="skill-gradient-*"，块内 title-text=技能a/b/c、
        // button-text=「主动技」/「额外能力」/「邦布连携技」、skill-text=技能名，
        // 后面跟描述正文与「详细属性」LV1~LV10 表。
        // ⚠ 技能类型必须取 button-text，不能从整块文本里正则抓：
        // 「额外能力」的描述里也含「主动技」四个字，抓整块会全判成主动技。
        if (/skill-gradient-/.test(t)) {
            const type = strip((t.match(/<span class="button-text">([\s\S]*?)<\/span>/) || [])[1] || '').replace(/[「」]/g, '');
            const name = strip((t.match(/<div class="skill-text">([\s\S]*?)<\/div>/) || [])[1] || '');
            // 要连「」一起删掉，只 replace(type) 会剩下一对空括号
            const txt2 = strip(t).replace(/^技能[abc]/, '').replace(new RegExp(`「${type}」`), '').replace(name, '').trim();
            const detailIdx = txt2.indexOf('详细属性');
            const desc = (detailIdx > 0 ? txt2.slice(0, detailIdx) : txt2).trim();
            // 详细属性在**嵌套的子表**里（外层表只有一段描述）。
            // 子表结构：表头行「详细属性 | LV1 | … | LV10」，
            // 下面每行是「属性名 | LV1值 | … | LV10值」。
            const detailRows = [];
            // ⚠ 不能从 '详细属性' 那个位置往后切 —— 它的 <table> 开标签在**前面**，
            // 那样切出来的子表是空串。正确做法是取本表内的第一张子表。
            const innerTable = (topLevelTables(t).find(x => /详细属性/.test(x)) || '');
            for (const tr of innerTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => strip(x[1]));
                if (!cs.length || /详细属性/.test(cs[0])) continue;
                const vals = cs.slice(1).filter(v => v);
                if (vals.length) detailRows.push({ name: cs[0], vals });
            }
            if (type || name) out.skills.push({ type, name, desc, detailRows });
            continue;
        }
        // 面板第一张：等级/生命值/攻击力/防御力
        if (/等级/.test(txt) && /生命值/.test(txt) && !out.panel.length) {
            for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => strip(x[1]));
                if (!cs.length || /等级/.test(cs[0]) || /突破前|突破后/.test(cs[0])) continue;
                const nums = cs.slice(1).map(v => v.replace(/（[^）]*）/g, '').trim()).filter(Boolean);
                if (nums.length) out.panel.push({ lv: cs[0], cells: nums });
            }
            continue;
        }
        // 面板第二张：暴击率/暴击伤害/冲击力/异常掌控
        // ⚠ 表头（属性名）也要留下来：原来只取数值，卡面上一片 50% / 100%
        // 没有列名，用户完全看不出这两列是什么（用户实图）。
        if (/等级/.test(txt) && /暴击率/.test(txt) && !out.panelSub.length) {
            for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => strip(x[1]));
                if (!cs.length) continue;
                // 整行都没有数字 → 这是表头（属性名）。⚠ 必须判在「等级」跳过之前：
                // 表头首格就是「等级」（rowspan=2），先跳等级就永远拿不到列名。
                if (!cs.some(v => /\d/.test(v))) {
                    const labels = cs.filter(v => v && !/^\s*$/.test(v)).map(v => v.replace(/（[^）]*）/g, '').trim());
                    if (!out.panelSubHead.length && labels.length) out.panelSubHead = labels.slice(1);
                    continue;
                }
                if (/等级/.test(cs[0]) || /突破前|突破后/.test(cs[0])) continue;
                const nums = cs.slice(1).map(v => v.replace(/（[^）]*）/g, '').trim()).filter(Boolean);
                if (nums.length) out.panelSub.push({ lv: cs[0], cells: nums });
            }
            continue;
        }
        // 突破材料（移动版副本只取第一份：已 materials 非空就跳过）
        if (/突破材料/.test(txt) && /(总计|级突破)/.test(txt) && !out.materials.length && !out.materialTotal.length) {
            for (const tr of t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
                const cs = [...tr.matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)].map(x => ({ raw: x[2], t: strip(x[2]) }));
                if (cs.length < 2) continue;
                const isTotal = /总计/.test(cs[0].t);
                if (!isTotal && !/级突破/.test(cs[0].t)) continue;
                const items = [];
                for (let i = 1; i < cs.length; i++) {
                    for (const m of cs[i].raw.matchAll(/<div class="sr-iconLarge[\s\S]*?<\/div>\s*<div>([\s\S]*?)<\/div>/g)) {
                        const blk = m[0];
                        const num = strip((blk.match(/class="sr-iconLTop">([\s\S]*?)<\/div>/) || [])[1] || '');
                        const nm = strip((blk.match(/<font>([^<]+)<\/font>/) || [])[1] || '');
                        const img = origIcon((blk.match(/<img[^>]*src="([^"]+)"/) || [])[1] || '');
                        if (!nm || items.some(x => x.name === nm)) continue;
                        items.push({ name: nm, num, img });
                    }
                    if (!items.length) {
                        const m = cs[i].t.replace(/\s*\n\s*/g, ' ').trim().match(/^([\d.万]+)\s*(.+)$/);
                        if (m) items.push({ name: m[2].trim(), num: m[1], img: '' });
                    }
                }
                if (!items.length) continue;
                if (isTotal) out.materialTotal = items;
                else out.materials.push({ stage: cs[0].t, items });
            }
            continue;
        }
    }
    // 百分比染蓝
    for (const s of out.skills) {
        s.desc = paintNumbers(s.desc);
        for (const r of (s.detailRows || [])) r.vals = r.vals.map(v => paintNumbers(v));
    }
    out.stories = (out.stories || []).map(v => flowStory(v));
    // panelSubHead 只是列名，不算「有数据」；panelSub（面板·附加）算数
    const ok = out.atk || out.skills.length || out.panel.length || out.panelSub.length || out.materials.length;
    return ok ? out : null;
}

export async function fetchZzzBwikiBangboo(name) {
    const html = await fetchZzzBwikiPage(name);
    if (!html) return null;
    /* 同 fetchZzzBwikiWeapon：词条名跨类型共用，查邦布可能撞上音擎/角色/驱动盘页。
       邦布页必有三个技能类型之一（或初始攻击力），音擎页没有；不齐就别硬解析。 */
    if (!/主动技|额外能力|邦布连携技|邦布图标|初始攻击力/.test(html)) {
        logger.debug?.(`[xhh][ZZZ邦布] 「${name}」的 Bwiki 页无邦布特征，判为非邦布`);
        return null;
    }
    return parseZzzBwikiBangboo(html);
}
