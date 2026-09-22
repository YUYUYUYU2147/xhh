import fetch from 'node-fetch';
import moment from 'moment';
import { render, pluginPriority } from '#xhh';

// 数据来源：Alioth.wiki（开源站点，静态 JSON 直出，无需鉴权）
// 数据：https://json.alioth.wiki/data/{gi|hsr}/ch/{file}.json 与 {file}/{期id}.json
// 图标：https://transform.alioth.wiki/i/{gi|sr}/...（图片目录用 sr，数据目录用 hsr）
// 注意：transform 服务只接受固定宽度（实测 64/128 可用，48/96 会 400）
const DATA_BASE = 'https://json.alioth.wiki/data';
const IMG_BASE = 'https://transform.alioth.wiki/i';
const LANG = 'ch';

const MODES = {
  gs_abyss: {
    game: 'gs', data: 'gi', img: 'gi', file: 'abyss',
    title: '深境螺旋', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildAbyss,
  },
  gs_theater: {
    game: 'gs', data: 'gi', img: 'gi', file: 'theater',
    title: '幻想真境剧诗', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildTheater,
  },
  gs_stygian: {
    game: 'gs', data: 'gi', img: 'gi', file: 'stygian',
    title: '幽境危战', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildStygian,
  },
  sr_chaos: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'chaos',
    title: '混沌回忆', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_fiction: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'fiction',
    title: '虚构叙事', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_shadow: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'as',
    title: '末日幻影', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_arb: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'arbitration',
    title: '异相仲裁', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildArb,
  },
};

const GI_ELEM = { Fire: '火', Water: '水', Grass: '草', Elec: '雷', Ice: '冰', Wind: '风', Rock: '岩', All: '全' };
const SR_ELEM = { Phys: '物理', Fire: '火', Ice: '冰', Wind: '风', Elec: '雷', Quantum: '量子', Imaginary: '虚数' };

// 期数索引 10 分钟、当期详情 6 小时缓存（当期数据在版本内基本不变，避免每次请求都打对方 CDN）
const CACHE = new Map();

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 xhh-abyss-now' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, ttl = 10 * 60 * 1000) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fetchJson(url);
  CACHE.set(url, { t: Date.now(), v });
  return v;
}

// Time 形如「2026/10/16 - 2026/11/16」或「2026/11」，解析成时间戳用于判断当期
function periodRange(time = '') {
  const t = String(time || '');
  const toDate = s => {
    const m = String(s || '').match(/(\d{4})[\/.](\d{1,2})(?:[\/.](\d{1,2}))?/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)).getTime();
  };
  const parts = t.split('-').map(v => v.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const start = toDate(parts[0]);
    let end = toDate(parts[1]);
    if (start && end) {
      // 结束时间可能省略年份，补上起始年份
      if (!/^\d{4}/.test(parts[1])) {
        const ds = new Date(start);
        const mp = String(parts[1]).split('/');
        end = new Date(ds.getFullYear(), Number(mp[0] || ds.getMonth() + 1) - 1, Number(mp[1] || 1)).getTime();
      }
      return { start, end: end + 24 * 3600 * 1000 - 1 };
    }
  }
  const single = toDate(t);
  return single ? { start: single, end: single + 31 * 24 * 3600 * 1000 } : null;
}

// 期数选择：默认当期（按时间命中），支持指定版本、指定期号、上一期/下一期
async function loadPhase(mode, opts = {}) {
  const index = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}.json`);
  const phases = index.Phases || [];
  if (!phases.length) return null;

  let idx = 0;
  let tag = '当期';
  const verList = () => phases.slice(0, 6).map(p => p.Ver).filter(Boolean).join(' / ');

  if (opts.periodId) {
    idx = phases.findIndex(p => String(p._id) === String(opts.periodId));
    if (idx < 0) return { error: `未找到第 ${opts.periodId} 期数据，可用期号：${phases.slice(0, 6).map(p => p._id).join(' / ')}` };
    tag = `第${opts.periodId}期`;
  } else if (opts.version) {
    const v = String(opts.version);
    idx = phases.findIndex(p => String(p.Ver || '').startsWith(v));
    if (idx < 0) idx = phases.findIndex(p => String(p.Ver || '').includes(v));
    if (idx < 0) return { error: `未找到版本 ${v} 的${mode.title}数据，可用版本：${verList()}` };
    tag = `${phases[idx].Ver || v}`;
  } else {
    // 未指定时按时间定位当期（进行中的一期），取不到再用最新一期兜底
    const now = Date.now();
    let cur = phases.findIndex(p => {
      const r = periodRange(p.Time);
      return r && now >= r.start && now <= r.end;
    });
    if (cur < 0) cur = 0;
    const off = Number(opts.offset || 0);
    idx = cur + off;
    if (idx < 0) return { error: `已是最新一期（${phases[0].Ver || ''} ${phases[0].Time || ''}），暂无下一期数据` };
    if (idx > phases.length - 1) return { error: '没有更早的期数了' };
    if (off === 0) tag = '当期';
    else if (off === 1) tag = '上一期';
    else if (off === -1) tag = '下一期';
    else tag = off > 0 ? `往前第${off}期` : `往后第${-off}期`;
  }

  const phase = phases[idx];
  const detail = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}/${phase._id}.json`, 6 * 60 * 60 * 1000);
  if (!detail) return null;
  return { phase, detail, tag };
}

function fmt(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return '-';
  return Math.round(n).toLocaleString('en-US');
}

function pct(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n * 1000) / 10}%`;
}

// 站点文案里带有 <color style='...'>、<b class='...'> 和星铁的 @数字# 占位符，转成模板可直接渲染的标签
function cleanRich(text = '') {
  return String(text || '')
    .replace(/@([^#\n]{0,40})#/g, '$1')
    .replace(/<color[^>]*>/gi, '<span class="hl">')
    .replace(/<\/color>/gi, '</span>')
    .replace(/<b[^>]*>/gi, '<b class="hl">')
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/<(?!\/?(?:b|span|br|i|u)\b)[^>]*>/gi, '')
    // 源数据在行内高亮数字前后会带换行（如“伤害提高\n<span>80%</span>\n，持续”），紧贴标签的换行是排版噪音，删掉；
    // 句子之间的换行才转成 <br>
    .replace(/\n(?=<)|(?<=>)\n/g, '')
    .replace(/\n+/g, '<br>')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function elemView(game, keys = []) {
  const map = game === 'gi' ? GI_ELEM : SR_ELEM;
  return (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(k => ({
    key: k,
    cn: map[k] || k,
    // 站点里 All 表示「全属性」，没有对应图标，只显示文字
    icon: k === 'All' ? '' : `${IMG_BASE}/ui/${game}/element/${k}.png?w=64&f=auto`,
  })).filter(v => v.cn);
}

function monsterIcon(game, icon = '') {
  if (!icon) return '';
  icon = String(icon).replace(/^\//, '').replace(/\.png$/i, '');
  if (game === 'sr') return `${IMG_BASE}/sr/${icon}.png?w=128&f=auto`;
  // 幽境危战首领立绘在独立目录
  const dir = icon.startsWith('UI_Img_LeyLineChallenge') ? 'LeyLineChallenge' : 'MonsterIcon';
  return `${IMG_BASE}/gi/${dir}/${icon}.png?w=128&f=auto`;
}

function avatarIcon(icon = '') {
  if (!icon) return '';
  return `${IMG_BASE}/gi/AvatarIcon/${String(icon).replace(/\.png$/i, '')}.png?w=128&f=auto`;
}

// 对象/数组统一转数组（星铁 as 玩法的 Skills/Tags 是 {1:..,2:..} 形式）
function valuesOf(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function buffList(items = []) {
  return items.map(v => ({ name: cleanRich(v.Name), desc: cleanRich(v.Desc || v.desc) }))
    .filter(v => v.name || v.desc);
}

/* ---------------- 原神：深境螺旋 ---------------- */

// RES = [[['冰','草','岩'], '40%'], [['火'], '-20%']]
function giRes(show) {
  return (show || []).map(entry => ({
    elems: elemView('gi', Array.isArray(entry?.[0]) ? entry[0] : [entry?.[0]]),
    value: entry?.[1] || '',
  })).filter(v => v.elems.length && v.value);
}

function giMonster(detail, m = {}) {
  const info = detail.Monsters?.[m.ID] || {};
  return {
    name: info.Name || m.Note || `怪物 ${m.ID}`,
    icon: monsterIcon('gi', info.Icon),
    hp: fmt(m.HP),
    count: Number(m.Num) > 1 ? m.Num : (m.HPCount || ''),
    res: giRes(info.RES),
    mech: '',
  };
}

async function buildAbyss(mode, opts = {}) {
  const layer = opts.layer;
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const floors = detail.Floors || [];
  if (!floors.length) return null;
  const nums = floors.map(f => Number(f.Index)).filter(Number.isFinite);
  const want = nums.includes(Number(layer)) ? Number(layer) : Math.max(...nums);
  const floor = floors.find(f => Number(f.Index) === want) || floors[floors.length - 1];

  const chambers = (floor.Chambers || []).slice().sort((a, b) => a.Index - b.Index || a.Half - b.Half);
  const halvesMap = new Map();
  for (const c of chambers) {
    const half = {
      label: Number(c.Half) === 1 ? '上半' : '下半',
      level: c.Level,
      waves: (c.Waves || []).map(w => ({
        name: w.Wave || '',
        monsters: (w.Monsters || []).map(m => giMonster(detail, m)),
      })),
    };
    if (!halvesMap.has(c.Index)) halvesMap.set(c.Index, []);
    halvesMap.get(c.Index).push(half);
  }
  const rooms = [...halvesMap.keys()].sort((a, b) => a - b).map(idx => ({ idx, halves: halvesMap.get(idx) }));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '渊月祝福',
    buffs: buffList(detail.Blessings),
    disorder: cleanRich(floor.Disorder || ''),
    hasDisorder: true,
    sections: [{ title: `第${floor.Index}层`, meta: `HP ${pct(floor.HPRatio)}`, rooms }],
    tip: layer ? '' : '默认展示最高层，可发送如「xhh原神11层深渊速览」查看其它层',
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 原神：幻想真境剧诗 ---------------- */

function theaterMonsters(detail, list = []) {
  return list.map(id => ({
    name: '',
    icon: monsterIcon('gi', typeof detail.Monsters?.[id] === 'string' ? detail.Monsters[id] : detail.Monsters?.[id]?.Icon),
    hp: '',
    count: '',
    res: [],
    mech: '',
  }));
}

async function buildTheater(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const halvesOf = (arr, prefix, timeFirst = false) => (arr || []).map((v, i) => ({
    label: `${prefix}${arr.length > 1 ? ` ${i + 1}` : ''}`,
    time: v.Time || '',
    waves: [{ name: '', monsters: theaterMonsters(detail, (v.Monsters || []).map(m => m.ID)) }],
  }));

  const rooms = [];
  if (detail.Boss?.length) rooms.push({ idx: rooms.length + 1, halves: halvesOf(detail.Boss, '首领关卡') });
  if (detail.Arcana?.length) rooms.push({ idx: rooms.length + 1, halves: halvesOf(detail.Arcana, '秘域关卡') });

  const chamberHalves = (detail.Chambers || []).map(c => {
    const waves = (c.Configs || []).map(cfg => ({
      name: '',
      monsters: theaterMonsters(detail, detail.MP?.[cfg] || []),
    }));
    return { label: `第${c._id}幕`, level: c.Level, waves };
  });
  if (chamberHalves.length) rooms.push({ idx: rooms.length + 1, halves: chamberHalves });

  const sections = [];
  if (rooms.length) sections.push({ title: '当期关卡', meta: '', rooms });
  if (detail.MonDesc && Object.keys(detail.MonDesc).length) {
    // MonDesc 按 MP 配置 id 索引，反查所属幕并按幕数排序（对象键顺序不保证按幕数）；纯文本截断（不能切 HTML，否则切在标签中间会渲染出乱码）
    const cfgChamber = {};
    for (const c of (detail.Chambers || [])) for (const cfg of (c.Configs || [])) cfgChamber[cfg] = c._id;
    const mechHalves = Object.entries(detail.MonDesc)
      .map(([cfg, d]) => ({ cfg, d, chamber: Number(cfgChamber[cfg]) || 999 }))
      .sort((a, b) => a.chamber - b.chamber)
      .slice(0, 6)
      .map(({ cfg, d, chamber }, i) => {
        const text = String(d || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const label = chamber !== 999 ? `第${chamber}幕 · 机制` : `机制 ${i + 1}`;
        return { label, waves: [{ name: text.length > 160 ? `${text.slice(0, 160)}…` : text, monsters: [] }] };
      });
    sections.push({ title: '首领机制', meta: '', rooms: [{ idx: 1, halves: mechHalves }] });
  }

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    elems: elemView('gi', detail.Elem),
    charRows: [
      { label: '开幕角色', chars: (detail.Initial || []).map(c => ({ icon: avatarIcon(c.Icon) })) },
      { label: '特邀角色', chars: (detail.Invitation || []).map(c => ({ icon: avatarIcon(c.Icon) })) },
    ].filter(v => v.chars.length),
    buffTitle: '',
    buffs: [],
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 原神：幽境危战 ---------------- */

function styMonster(detail, id, diffIdx) {
  const info = detail.Monsters?.[id] || {};
  return {
    name: info.Name || `怪物 ${id}`,
    icon: monsterIcon('gi', info.Icon),
    hp: info.Stats ? `HP ${fmt(info.Stats.HP)}` : '',
    count: '',
    res: giRes((info.RESShow || [])[diffIdx] || (info.RESShow || [])[0]),
    mech: (info.Buff || []).map(b => b.Name).filter(Boolean).join(' / '),
  };
}

async function buildStygian(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const levels = detail.Levels || [];
  if (!levels.length) return null;

  const sections = levels.map((lv, idx) => ({
    title: `难度 ${lv.Level}`,
    meta: (lv.Monsters || []).map(id => detail.Monsters?.[id]?.Advantage).filter(Boolean).length ? '' : '',
    rooms: [{
      idx: 1,
      halves: [{
        label: '敌人',
        waves: [{ name: '', monsters: (lv.Monsters || []).map(id => styMonster(detail, id, idx)) }],
      }],
    }],
  }));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '',
    buffs: [],
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 星铁：混沌回忆 / 虚构叙事 / 末日幻影 ---------------- */

function srMonster(detail, m = {}) {
  const info = detail.Monsters?.[m.ID] || {};
  const res = Object.entries(info.RES || {}).map(([k, v]) => ({
    elems: elemView('sr', k),
    value: pct(v),
  })).filter(v => v.elems.length);
  return {
    name: info.Name || `怪物 ${m.ID}`,
    icon: monsterIcon('sr', info.Icon),
    hp: fmt(m.HP),
    count: '',
    weak: elemView('sr', info.Weak),
    res,
    mech: '',
  };
}

// 混沌/虚构的 Waves 是数组；末日幻影的 Waves 是单个对象（首领本体）
function srWaves(detail, stage) {
  const raw = stage.Waves;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((w, i) => {
    let monsters = [];
    if (Array.isArray(w.Monsters)) monsters = w.Monsters.map(m => srMonster(detail, m));
    else if (w.ID) monsters = [srMonster(detail, w)];
    return {
      name: w.WaveName || (Array.isArray(raw) && list.length > 1 ? `第${w.Wave ?? i + 1}波` : ''),
      monsters,
    };
  }).filter(v => v.monsters.length);
}

function srStageHalf(detail, st, label) {
  const stage = detail.Stages?.[String(st.StageID)] || detail.Stages?.[st.StageID] || {};
  return {
    label,
    level: stage.Level,
    elems: elemView('sr', st.Elem),
    waves: srWaves(detail, stage),
  };
}

async function buildSr(mode, opts = {}) {
  const layer = opts.layer;
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const floors = detail.Floors || [];
  if (!floors.length) return null;
  const nums = floors.map(f => Number(f.Floor)).filter(Number.isFinite);
  const want = nums.includes(Number(layer)) ? Number(layer) : Math.max(...nums);
  const floor = floors.find(f => Number(f.Floor) === want) || floors[floors.length - 1];

  const halves = (floor.Stages || []).map(st => srStageHalf(detail, st, Number(st.Half) === 1 ? '上半' : Number(st.Half) === 2 ? '下半' : `第${st.Half}关`))
    .filter(v => v.waves.length);

  const buffs = [];
  if (detail.Buff?.Name || detail.Buff?.Desc) buffs.push(...buffList([detail.Buff]));
  buffs.push(...buffList(valuesOf(detail.NewBuffs)));
  for (const v of valuesOf(detail.Skills)) {
    const desc = [v.Desc, v.Desc2].filter(Boolean).map(cleanRich).filter(Boolean).join('<br>');
    if (v.Name || desc) buffs.push({ name: cleanRich(v.Name), desc });
  }
  // 末日幻影的 Tags 是首领机制
  for (const v of valuesOf(detail.Tags)) buffs.push(...buffList(valuesOf(v.Tags).length ? valuesOf(v.Tags) : [v]));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: mode.file === 'fiction' ? '关卡增益 / 战技' : mode.file === 'as' ? '关卡增益 / 首领机制' : '关卡增益',
    buffs,
    disorder: '',
    hasDisorder: false,
    sections: [{
      title: `第${floor.Floor}层`,
      meta: [floor.HP ? `总HP ${fmt(floor.HP)}` : '', floor.HP_S ? `单 ${fmt(floor.HP_S)} / 群 ${fmt(floor.HP_M)}` : '', halves[0]?.level ? `Lv.${halves[0].level}` : ''].filter(Boolean).join(' · '),
      rooms: [{ idx: floor.Floor, halves }],
    }],
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 星铁：异相仲裁 ---------------- */

async function buildArb(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;

  const tagMap = new Map();
  for (const v of valuesOf(detail.KnightTags)) tagMap.set(`K${v.Index}`, valuesOf(v.Tags));
  for (const v of valuesOf(detail.KingTags)) tagMap.set(`G${v.Index}`, valuesOf(v.Tags));

  const buildGroup = (list, prefix, tagKey) => (list || []).map(v => {
    const half = srStageHalf(detail, v, `${prefix} ${v.Index}`);
    const tags = tagMap.get(`${tagKey}${v.Index}`) || [];
    half.mechTags = tags.map(t => cleanRich(t.Name)).filter(Boolean);
    return half;
  }).filter(v => v.waves.length);

  const knightHalves = buildGroup(detail.Knight, '骑士关卡', 'K');
  const kingHalves = buildGroup(detail.King, '王棋关卡', 'G');

  const sections = [];
  if (knightHalves.length) {
    sections.push({ title: '骑士关卡', meta: detail.HP_Knight ? `总HP ${fmt(detail.HP_Knight)}` : '', rooms: [{ idx: 1, halves: knightHalves }] });
  }
  if (kingHalves.length) {
    sections.push({ title: '王棋关卡', meta: detail.HP_King ? `总HP ${fmt(detail.HP_King)}${detail.HP_King_Hard ? ` / 困难 ${fmt(detail.HP_King_Hard)}` : ''}` : '', rooms: [{ idx: 1, halves: kingHalves }] });
  }

  const buffs = buffList(valuesOf(detail.Buffs));
  for (const [key, tags] of tagMap) {
    const label = key.startsWith('K') ? '骑士' : '王棋';
    for (const t of tags) {
      if (t.Name || t.Desc) buffs.push({ name: `${label}关卡 · ${cleanRich(t.Name)}`, desc: cleanRich(t.Desc) });
    }
  }

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '关卡增益 / 首领机制',
    buffs,
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 消息解析 ---------------- */

function parseMsg(msg = '') {
  const text = String(msg || '').replace(/^[#＃]{0,2}xhh/i, '').trim();
  const layer = text.match(/(\d{1,2})层/)?.[1] || '';
  // 版本（7.1）优先于层数；期号支持「58期」「第58期」
  const version = text.match(/([0-9]{1,2}\.[0-9]{1,2})/)?.[1] || '';
  const periodId = text.match(/第?([0-9]{2,4})期/)?.[1] || '';
  let offset = 0;
  if (/上一期|上期|上一|前一期/.test(text)) offset = 1;
  else if (/下一期|下期|下一|后一期/.test(text)) offset = -1;
  const game = /原神/.test(text) ? 'gs' : /星铁|星穹|崩铁/.test(text) ? 'sr' : '';
  let modeKey = '';
  if (/幻想|真境|剧诗/.test(text)) modeKey = 'gs_theater';
  else if (/幽境|危战/.test(text)) modeKey = 'gs_stygian';
  else if (/末日|幻影/.test(text)) modeKey = 'sr_shadow';
  else if (/异相|仲裁|王棋/.test(text)) modeKey = 'sr_arb';
  else if (/深境|螺旋/.test(text)) modeKey = 'gs_abyss';
  else if (/混沌|回忆/.test(text)) modeKey = 'sr_chaos';
  else if (/虚构/.test(text)) modeKey = 'sr_fiction';
  else if (game === 'sr') modeKey = 'sr_chaos';
  else modeKey = 'gs_abyss'; // 未写游戏/玩法时默认原神深渊
  return { layer, version, periodId, offset, modeKey };
}

export class AbyssNow extends plugin {
  constructor(e) {
    super({
      name: '[小花火]深渊速览',
      dsc: 'Alioth 深渊当期速览（原神/星铁全玩法）',
      event: 'message',
      priority: pluginPriority('abyss_now', 100),
      rule: [
        {
          reg: '^#*xhh(原神|星铁|星穹|崩铁)?(?:([0-9]{1,2}\\.[0-9]{1,2}))?(?:第?([0-9]{2,4})期)?(?:上一期|上期|上一|下一期|下期|下一)?(?:([0-9]{1,2})层)?(深境螺旋|深境|深渊|幻想真境剧诗|幻想剧诗|幻想|真境|剧诗|幽境危战|幽境|危战|混沌回忆|混沌|回忆|虚构叙事|虚构|末日幻影|末日|幻影|异相仲裁|异相|仲裁|王棋)(?:([0-9]{1,2})层)?(?:上一期|上期|上一|下一期|下期|下一)?(速览|一览|详情|情报|阵容)$',
          fnc: 'overview',
        },
      ],
    });
  }

  async overview(e) {
    const sel = parseMsg(e.msg);
    const mode = MODES[sel.modeKey];
    try {
      const view = await mode.build(mode, sel);
      if (view?.error) {
        return e.reply(view.error, true, { recallMsg: 60 });
      }
      if (!view || !view.sections?.length) {
        return e.reply('未获取到 Alioth 当期数据，请稍后再试。', true, { recallMsg: 60 });
      }
      const img = await render('abyss_now/overview', view, { e, pct: 1 });
      if (view.tip) await e.reply(view.tip, true, { recallMsg: 60 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[xhh][abyss_now] ${mode.title} 速览失败: ${err?.message || err}`);
      return e.reply(`${mode.title}数据获取失败，请稍后再试。`, true, { recallMsg: 60 });
    }
  }
}
