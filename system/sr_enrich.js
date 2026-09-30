/**
 * 星铁深渊「双数据源互补」
 *
 * 两个站的数据各有对方没有的字段，单用一边必然残缺：
 *
 *   字段                          nanoka(速报)   alioth(速览)
 *   HPCount    血条数 ×N             ✗             ✓
 *   VoracityHP 污染额外血量          ✗             ✓
 *   IAR        效果抗性              ✗             ✓
 *   Summons    召唤物(含子怪数值)     ✗             ✓
 *   invasion    污染机制说明/等级     ✓             ✗
 *   MaxMonsterPhase  血条数 ×N       ✓             ✗
 *   StatusResistanceBase 效果抗性    ✓             ✗
 *   maze_buff_param[1] 贪饕回血比例  ✓             ✗
 *
 * 两边的 stage_id 与期 id 同号（实测 nanoka 迷宫集 1035 ↔ alioth chaos/1035
 * 的 stage 30125121 完全对应），因此可以直接按 stage_id 交叉查表，无需映射。
 *
 * 本模块只做「取另一个源补齐缺失字段」，不改变任一源的原始算法，
 * 查不到就返回空，调用方按原样渲染即可。
 */

const ALIOTH_DATA = 'https://json.alioth.wiki/data';
const NANOKA = 'https://static.nanoka.cc/hsr';

/** 期 id -> 解析结果，避免同一期重复请求 */
const CACHE = new Map();

async function getJson(url, timeout = 8000) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

/**
 * 从 alioth 补：按期 id 取出该期所有 stage 的怪，返回 stage_id -> { 怪id: 补充字段 }
 * 速报（nanoka）遇到污染怪时调用，补 HPCount / VoracityHP / IAR。
 */
export async function enrichFromAlioth(phaseId, file = 'chaos') {
    if (!phaseId) return {};
    const key = `alioth:${file}:${phaseId}`;
    if (CACHE.has(key)) return CACHE.get(key);
    const data = await getJson(`${ALIOTH_DATA}/hsr/ch/${file}/${phaseId}.json`);
    const out = {};
    if (data?.Stages) {
        for (const [stageId, stage] of Object.entries(data.Stages)) {
            const map = {};
            for (const wave of (stage.Waves ? (Array.isArray(stage.Waves) ? stage.Waves : [stage.Waves]) : [])) {
                for (const m of (wave?.Monsters || [])) {
                    if (m?.ID == null) continue;
                    const info = data.Monsters?.[String(m.ID)] || {};
                    map[String(m.ID)] = {
                        hpCount: Number(info.HPCount) > 1 ? Number(info.HPCount) : 0,
                        voracityHp: m.VoracityHP ? Number(m.VoracityHP) : 0,
                        iar: info.IAR != null ? Number(info.IAR) : null,
                    };
                }
            }
            out[String(stageId)] = map;
        }
    }
    CACHE.set(key, out);
    return out;
}

/**
 * 从 nanoka 补：按迷宫集 id 取出该期所有 stage 的污染信息，
 * 返回 stage_id -> { desc, level, healPct }。
 * 速览（alioth）遇到污染怪时调用，补机制说明与回血比例。
 */
export async function enrichFromNanoka(phaseId, version) {
    if (!phaseId || !version) return {};
    const key = `nanoka:${version}:${phaseId}`;
    if (CACHE.has(key)) return CACHE.get(key);
    const data = await getJson(`${NANOKA}/${version}/zh/maze/${phaseId}.json`);
    const out = {};
    if (Array.isArray(data)) {
        for (const row of data) {
            for (const half of ['event_id_list1', 'event_id_list2']) {
                for (const st of (row?.[half] || [])) {
                    const inv = st?.invasion;
                    if (!inv || st?.stage_id == null) continue;
                    out[String(st.stage_id)] = {
                        desc: String(inv.desc || '').replace(/\\n/g, '\n'),
                        level: Number(inv.level) || 0,
                        healPct: Number(inv.maze_buff_param?.[1]) || 0,
                    };
                }
            }
        }
    }
    CACHE.set(key, out);
    return out;
}

/** 取某个 stage 下某只怪的补充字段 */
export function pickEnrich(map, stageId, monsterId) {
  return map?.[String(stageId)]?.[String(monsterId)] || null;
}

/** 取某个 stage 的污染机制补充字段（贪饕回血比例等） */
export function pickStageEnrich(map, stageId) {
  return map?.[String(stageId)] || null;
}

const NANOKA_MANIFEST = 'https://static.nanoka.cc/manifest.json';

/**
 * 取 nanoka 当前版本号（形如 4.6.51）。
 * alioth 那边没有版本号的概念，要按期 id 去 nanoka 取数据就必须先有这个。
 */
export async function nanokaVersion() {
  const key = 'nanoka:version';
  if (CACHE.has(key)) return CACHE.get(key);
  let v = '';
  try {
    const m = await getJson(NANOKA_MANIFEST);
    v = String(m?.hsr?.latest || m?.hsr?.live || '');
  } catch {
    v = '';
  }
  CACHE.set(key, v);
  return v;
}

/**
 * 速览（alioth 源）专用：按 alioth 的期 id 去 nanoka 取同期的污染机制。
 *
 * 两边期 id 是同号的（实测 nanoka maze/1035 与 alioth chaos/1035 有 6 个
 * stage_id 重合，而 maze/1036 与之零重合），但仍然做一次 stage_id 交集校验，
 * 万一哪天 nanoka 改了期号编排，也只是查不到、不会取到错的那一期的数值。
 *
 * @param {string} phaseId alioth 的期 id
 * @param {object} detail   alioth 的期详情，用来校验 stage_id 是否真的对得上
 * @param {string} file     alioth 的文件类型（chaos/fiction/boss/arbitration）
 */
export async function enrichNanokaForAlioth(phaseId, detail, file = 'chaos') {
  if (!phaseId || !detail) return {};
  const version = await nanokaVersion();
  if (!version) return {};
  let map = {};
  try {
    map = await enrichFromNanoka(phaseId, version);
  } catch (err) {
    logger.warn?.('[xhh][sr_enrich] nanoka 污染机制补充失败:', err?.message || err);
    return {};
  }
  // 校验：至少要有一个 stage_id 同时存在于 alioth 与 nanoka，否则视为期号对不上
  const aliothStages = detail?.Stages || {};
  const hit = Object.keys(map).some(sid => aliothStages[sid] != null);
  if (!hit) {
    if (config().debug) {
      logger.mark('[xhh][sr_enrich] nanoka 期号与 alioth 对不上，跳过污染机制补充:', phaseId, file);
    }
    return {};
  }
  return map;
}
