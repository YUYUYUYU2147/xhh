/**
 * 图鉴列表统一排序（全游戏通用，不给任何游戏开特例）。
 *
 * 排序键只有三层，从上到下：
 *   ① 测试服置顶  —— 未实装/测试服/体验服/前瞻，列表最前面，卡面挂 TEST 角标
 *   ② 最新优先    —— 版本号大的在前（4.6 > 4.5 > 1.0）；没有版本号时用日期；
 *                    再没有就用 id/上线序号（这些字段都随上线时间单调递增）
 *   ③ 星级降级    —— 五星 → 四星 → 三星 → 二星；绝区零 S/A/B 级同理
 * 三层都相同就保持原顺序（稳定排序）。
 *
 * 为什么要有「id/上线序号」这层兜底：三个游戏的数据源能给的时间字段并不统一 ——
 *   星铁：Bwiki 图鉴页有 data-param 里的上线版本（4.6 这种）
 *   原神：Bwiki 武器/圣遗物一览**没有版本字段**，只能靠 nanoka 的 content_id（随上线递增）
 *   绝区零：mys.js 里已经算好一个 _ord（未上线置顶 → 卡池首发日期新→旧 → id 降序）
 * 与其在每个游戏里各写一套 if，���是把「这条数据能给出的新旧程度」统一折成一个
 * recency 分值，谁有谁给，没有就当未知（排在有数的后面）。
 */

/** 版本号 "4.6" → 406，"10.0" → 1000；取不到返回 null */
function versionScore(v) {
  const m = String(v ?? '').match(/(\d+)\s*[.．]\s*(\d+)/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

/** 各种日期写法 → 时间戳；取不到返回 null */
function dateScore(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // 纯数字：nanoka 的 SR release 是秒级 epoch
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return s.length >= 12 ? Math.floor(n / 1000) : n;
  }
  const m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** id / content_id / numId：nanoka 与米游社的 id 都随上线时间递增 */
function idScore(item) {
  for (const k of ['numId', 'contentId', 'content_id']) {
    const n = Number(item?.[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const n = Number(item?.id);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

/**
 * 测试服判定。所有游戏同一套：先看数据里的标志位（不同源字段名不统一，都查一遍），
 * 再按名字/版本里的关键词兜底（维基写「（测试服）」、前瞻实装名等）。
 */
export function isTestItem(item = {}) {
  if (item.isUnreleased || item.isTest || item.test || item.preview || item.isNew) return true;
  const txt = `${item.name || ''} ${item.version || ''}`;
  return /测试服|体验服|前瞻|未实装|未上线|test/i.test(txt);
}

/* 中文数字星级：原神角色/武器/圣遗物的 ji 写的是「五星」「四星」，
   星铁写「5星」，绝区零写「S级」。三种都得认。
   之前只匹配 [1-5]，「五星/四星」全部落到兜底档 3 —— 同一档里再按新旧排，
   于是原神角色图鉴就变成五星四星交错（用户实图）。 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };

/** 星级 → 排序权重（权重越小越靠前）。兼容 五星/5星/S级/A级/数字稀有度 */
export function starRank(item = {}) {
  const raw = String(item.ji || item.rarity || '').trim();
  if (!raw) return 3;
  // 先按等级字母（绝区零 S/A/B）—— 必须在数字之前，
  // 否则「A5」这类写法会先被数字规则吃掉
  if (/S/i.test(raw)) return 0;
  if (/A/i.test(raw)) return 1;
  if (/B/i.test(raw)) return 2;
  const cn = raw.match(/[一二三四五]/)?.[0];
  if (cn) return 5 - CN_NUM[cn];
  const num = raw.match(/[1-5]/)?.[0];
  if (num) return 5 - Number(num);
  return 3;
}

/**
 * 新旧程度分值，越大越新。任意一种来源都行，取最大可用值；
 * 全都没有 → null（会排在有数的后面，而不是被当成最新的）。
 */
/* 新旧程度的来源分档：档次高的整体排在档次低的前面，
   同档内再比数值。这样「有版本号的 4.6 条目」永远压过「只有 id 的老条目」，
   不会因为 406 < 655 这种量纲差异把老条目顶到前面。 */
const RECENCY_RANK = { version: 4, date: 3, ord: 2, id: 1 };

/**
 * 新旧程度。返回 { rank, val }（rank 越大来源越可信，val 越大越新），
 * 任何来源都算不出来时返回 null —— 「未知」不等于「最新」，会排在有数的后面。
 */
export function recencyScore(item = {}) {
  const v = versionScore(item.version);
  if (v !== null) return { rank: RECENCY_RANK.version, val: v };
  for (const k of ['date', 'versionDate', 'release_date', 'release']) {
    const d = dateScore(item[k]);
    if (d !== null) return { rank: RECENCY_RANK.date, val: d };
  }
  // 绝区零 mys.js 算好的 _ord：值越小越新（未上线 -1e15、卡池首发 -时间戳）
  if (item._ord !== undefined && item._ord !== null && Number.isFinite(Number(item._ord))) {
    return { rank: RECENCY_RANK.ord, val: -Number(item._ord) };
  }
  const id = idScore(item);
  if (id !== null) return { rank: RECENCY_RANK.id, val: id };
  return null;
}

/**
 * 统一排序。就地排数组并返回它（调用方本来就持有 data 引用）。
 * @param {Array} items 条目数组
 * @param {object} [opts]
 * @param {boolean} [opts.byStar=true] 是否按星级分层（关掉就是纯时间序）
 */
export function orderWikiList(items, opts = {}) {
  const arr = Array.isArray(items) ? items : [];
  const byStar = opts.byStar !== false;
  // 先把每条的判定结果算出来存回去：① 模板要用 isTest 画 TEST 角标
  // ② 排序时反复调函数太浪费，也不好单测
  for (const it of arr) {
    if (it && typeof it === 'object') {
      it.isTest = isTestItem(it);
      it._rec = recencyScore(it);
      it._star = starRank(it);
    }
  }
  arr.sort((a, b) => {
    const at = a?.isTest ? 0 : 1;
    const bt = b?.isTest ? 0 : 1;
    if (at !== bt) return at - bt;                     // ① 测试服置顶
    /* ② 星级分层：五星整组在前，四星整组在后。
       组内再按新旧排（③）：所以绝区零驱动盘这种「只有 S 级」的列表，
       星级这一层自动退化，第二层的「最新优先」就是唯一可见规则。 */
    if (byStar) {
      const as = a?._star ?? 9;
      const bs = b?._star ?? 9;
      if (as !== bs) return as - bs;
    }
    /* ③ 组内新的在前。先比来源档次（版本 > 日期 > _ord > id），
       再比同档内的数值 —— 不能直接比数值：版本 406 和 id 655 量纲不同，
       直接比会让「只有 id 的老条目」压过「4.6 的新条目」。 */
    const ar = a?._rec ?? null;
    const br = b?._rec ?? null;
    // 有新旧数据的排在没数据的前面（「未知」不等于「最新」）
    if (!ar && br) return 1;
    if (br && !ar) return -1;
    if (ar && br) {
      if (ar.rank !== br.rank) return br.rank - ar.rank;
      if (ar.val !== br.val) return br.val - ar.val;
    }
    return 0;                                          // 同层保持原顺序
  });
  return arr;
}

/** 只判定不排序，给详情页/调试用 */
export function explainOrder(item) {
  return {
    name: item?.name,
    isTest: isTestItem(item),
    version: item?.version || '',
    recency: recencyScore(item),
    star: starRank(item),
  };
}