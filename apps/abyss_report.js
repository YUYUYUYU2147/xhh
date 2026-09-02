import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import _ from 'lodash';
import moment from 'moment';
import { render, config, pluginPriority } from '#xhh';
import sharp from '../node_modules/sharp/lib/index.js';

const MANIFEST_URL = 'https://static.nanoka.cc/manifest.json';
const DEFAULT_REPOS = [
  'https://cnb.cool/JIUXJIU/Abyss/-/git/raw/main',
  'https://cnb.cool/JIUXJIU/AbyssBeta/-/git/raw/main',
];

const ALIASES = {
  gs: {
    '深境螺旋': ['深渊', '深境', '螺旋', '深渊速报', '当前深渊'],
    '幻想真境剧诗': ['幻想', '真境', '剧诗', '幻想剧诗', '幻想真境'],
    '幽境危战': ['幽境', '危战'],
  },
  sr: {
    '混沌回忆': ['混沌', '回忆', '深渊', '混沌速报', '深渊速报'],
    '虚构叙事': ['虚构', '叙事', '构事', '虚构速报'],
    '末日幻影': ['末日', '幻影', '末影', '末日速报'],
    '异相仲裁': ['异相', '仲裁', '王棋'],
  },
  zzz: {
    '式舆防卫战': ['式舆', '防卫战', '防卫', '深渊', 'shiyu'],
    '危局强袭战': ['危局', '强袭战', '强袭', 'boss'],
  },
};

const SR_VERSION_MAP = {
  '混沌回忆': { '1.3': ['1001', '1002', '1003'], '1.4': ['1004', '1005', '1006'], '1.5': ['1007', '1008'], '1.6': ['1009', '1010'], '2.0': ['1011'], '2.1': ['1013'], '2.7': ['1020'], '3.0': ['1021'], '3.8': ['1029'], '4.0': ['1030'] },
  '虚构叙事': { '1.6': ['2003'], '2.0': ['2004'], '2.7': ['2011'], '3.0': ['2012'], '3.8': ['2020'], '4.0': ['2021'] },
  '末日幻影': { '2.7': ['3005'], '3.0': ['3006'], '3.8': ['3014'], '4.0': ['3015'] },
};

const TYPE_CLASS = {
  '深境螺旋': 'spiral',
  '幻想真境剧诗': 'theater',
  '幽境危战': 'war',
  '混沌回忆': 'chaos',
  '虚构叙事': 'fiction',
  '末日幻影': 'apoc',
  '异相仲裁': 'arbitration',
};

const CACHE_DIR = path.join(process.cwd(), 'data', 'xhh_abyss_report');
const repoImageCache = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stripHtml(text = '') {
  return String(text || '')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function repoList() {
  const raw = config().abyss_report_repos;
  const list = String(raw || '').split(/\n+/).map(v => v.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_REPOS;
}

async function scaleImage(input, scale) {
  if (!input || scale === 1) return input;
  try {
    let file = input;
    if (typeof input === 'object' && input.file) file = input.file;
    let buf;
    if (Buffer.isBuffer(file)) {
      buf = file;
    } else if (typeof file === 'string' && file.startsWith('base64://')) {
      buf = Buffer.from(file.slice(9), 'base64');
    } else if (typeof file === 'string' && file.startsWith('data:image')) {
      buf = Buffer.from(file.split(',')[1], 'base64');
    } else {
      logger.warn(`[xhh][abyss_report] scaleImage 跳过非图片输入: ${typeof file}`);
      return input;
    }
    const { width, height } = await sharp(buf).metadata();
    const resized = await sharp(buf, { animated: false })
      .resize(Math.round(width * scale), Math.round(height * scale), { kernel: sharp.kernel.lanczos3, fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    logger.mark(`[xhh][abyss_report] 图片缩放 ${width}x${height} -> ${Math.round(width * scale)}x${Math.round(height * scale)}`);
    if (typeof input === 'object' && input.file) return { ...input, file: resized };
    return `base64://${resized.toString('base64')}`;
  } catch (err) {
    logger.warn(`[xhh][abyss_report] scaleImage 失败: ${err.message}`);
    return input;
  }
}

async function fetchJson(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 xhh' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function currentVersion(game) {
  const cfg = config();
  const fallback = game === 'sr' ? '4.3' : game === 'zzz' ? '3.2.12+18601660' : '6.7';
  const cfgVer = game === 'sr' ? cfg.abyss_report_sr_version : game === 'zzz' ? cfg.abyss_report_zzz_version : cfg.abyss_report_gs_version;
  if (cfgVer) return String(cfgVer);
  try {
    const manifest = await fetchJson(MANIFEST_URL, 6000);
    const live = game === 'sr' ? manifest?.hsr?.live : game === 'zzz' ? manifest?.zzz?.live : manifest?.gi?.live;
    if (live) return String(live);
  } catch (err) {
    logger.warn(`[xhh][abyss_report] Nanoka manifest 获取失败: ${err.message}`);
  }
  return fallback;
}

function formalTypeOrNull(input, game) {
  const table = ALIASES[game] || {};
  for (const [name, arr] of Object.entries(table)) {
    if (input === name || arr.includes(input)) return name;
  }
  return null;
}

function formalType(input, game) {
  return formalTypeOrNull(input, game) || (game === 'sr' ? '混沌回忆' : game === 'zzz' ? '式舆防卫战' : '深境螺旋');
}

function allAliasReg() {
  const list = Object.values(ALIASES).flatMap(obj => Object.entries(obj).flatMap(([k, v]) => [k, ...v]));
  return Array.from(new Set(list)).map(_.escapeRegExp).join('|');
}

function parseMsg(msg = '') {
  const raw = String(msg || '').replace(/^#*xhh/i, '').trim();
  const version = raw.match(/([1-9]\.[0-9]{1,2})/)?.[1];
  const prev = /上一期|上期|上一/i.test(raw);
  let game = /星铁|星穹|崩铁|SR|HSR/i.test(raw) ? 'sr' : (/绝区零|ZZZ/i.test(raw) ? 'zzz' : 'gs');
  const aliases = allAliasReg();
  const typeText = raw.match(new RegExp(`(${aliases})`))?.[1];
  let type = formalType(typeText, game);
  // 不带游戏名的专属别名（如"防卫/防卫战/式舆/危局/混沌"）也能反推出正确游戏
  if (typeText && !formalTypeOrNull(typeText, game)) {
    for (const g of ['zzz', 'sr', 'gs']) {
      const hit = formalTypeOrNull(typeText, g);
      if (hit) {
        game = g;
        type = hit;
        break;
      }
    }
  }
  return { game, version, prev, type };
}

function imageNumbers(game, version, type) {
  if (game === 'gs') {
    if (type === '深境螺旋' || type === '幻想真境剧诗') return [version, `${version}A`, `${version}B`];
    return [version];
  }
  if (type === '异相仲裁') return [version];
  const mapped = SR_VERSION_MAP[type]?.[version];
  if (mapped) return mapped;
  const base = { '混沌回忆': 1030, '虚构叙事': 2021, '末日幻影': 3015 }[type];
  if (!base) return [version];
  const [a, b] = version.split('.').map(Number);
  return [String(base + (a - 4) * 10 + b)];
}

function isImageBuffer(buf) {
  if (!buf || buf.length < 16) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return png || jpg || webp;
}

function rawRepoToTreeUrl(repo, type) {
  const clean = String(repo || '').replace(/\/$/, '');
  let match = clean.match(/^(.*)\/-\/git\/raw\/([^/]+)$/);
  if (match) return `${match[1]}/-/tree/${match[2]}/${encodeURIComponent(type)}`;
  match = clean.match(/^(.*)\/-\/raw\/([^/]+)$/);
  if (match) return `${match[1]}/-/tree/${match[2]}/${encodeURIComponent(type)}`;
  return `${clean.replace(/\/$/, '')}/${encodeURIComponent(type)}`;
}

function versionBase(num = '') {
  const m = String(num).match(/^([1-9]\d*)\.(\d{1,2})/);
  if (!m) return -1;
  return Number(m[1]) * 100 + Number(m[2]);
}

function formatNum(num = 0) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('zh-CN');
}

function shortLabel(name = '') {
  const text = String(name || '').replace(/\s+/g, '');
  if (!text) return '怪';
  return text.length <= 2 ? text : text.slice(0, 2);
}

function hashColor(text = '') {
  const palette = ['#5a67d8', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f97316', '#ec4899', '#22c55e', '#eab308'];
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function formatCondText(cond = []) {
  return cond.map(v => `${v?.[1]}s`).filter(Boolean).join(' / ');
}

function buildTowerMonsterList(list = []) {
  return list.map(mon => ({
    name: mon?.name || '未知敌人',
    hp: formatNum(mon?.hp),
    level: mon?.level ? `Lv.${mon.level}` : '',
    abbr: shortLabel(mon?.name || ''),
    color: hashColor(mon?.name || ''),
    icon: mon?.icon ? `https://gi.yatta.moe/assets/UI/monster/${mon.icon}.png` : '',
  }));
}

function buildTowerRoom(room = {}, idx = 0) {
  return {
    idx,
    level: room?.level || 0,
    condText: formatCondText(room?.cond || []),
    conds: (room?.cond || []).map((c, i) => ({ label: `挑战条件${i + 1}`, value: `${c?.[1] ?? ''}s` })),
    first: buildTowerMonsterList(room?.first || []),
    second: buildTowerMonsterList(room?.second || []),
  };
}

function pickCurrentTower(list = {}) {
  const now = moment();
  const items = Object.entries(list).map(([id, v]) => ({ id: Number(id), ...v }));
  // nanoka tower.json 使用 begin/end 字段；兼容 live_begin/live_end 两种命名。
  return items.find(v => (v.live_begin || v.begin) && (v.live_end || v.end) && now.isBetween(moment(v.live_begin || v.begin), moment(v.live_end || v.end), undefined, '[]'))
    || items.sort((a, b) => b.id - a.id)[0]
    || null;
}

function pickHighestNumericKey(obj = {}) {
  return Object.keys(obj).map(v => Number(v)).filter(v => Number.isFinite(v)).sort((a, b) => a - b).at(-1) || null;
}

function pickVersionIdByLive(map = {}, live = '') {
  const arr = map?.[live];
  if (Array.isArray(arr) && arr.length) return arr.at(-1);
  const keys = Object.keys(map || {}).filter(v => v !== 'static' && v !== 'unknown').sort((a, b) => versionBase(b) - versionBase(a));
  for (const key of keys) {
    const arr2 = map[key];
    if (Array.isArray(arr2) && arr2.length) return arr2.at(-1);
  }
  return null;
}

// 从"版本 -> [期id]"映射里按版本号 / 上一期 / 当期 解析目标
// 返回 { id, label, tip }；tip 仅在发生回退或无法满足时需要提示用户
function resolveMapId(map = {}, live = '', reqType = '', opts = {}) {
  const keys = Object.keys(map || {})
    .filter(v => v !== 'static' && v !== 'unknown' && Array.isArray(map[v]) && map[v].length)
    .sort((a, b) => versionBase(b) - versionBase(a));
  if (!keys.length) return { tip: `${reqType} 暂无可用期数据` };
  const curKey = map?.[live]?.length ? String(live) : keys[0];

  if (opts.version) {
    if (map[opts.version]?.length) {
      const arr = map[opts.version];
      return {
        id: arr.at(-1),
        label: `版本 ${opts.version}`,
        tip: arr.length > 1 ? `${reqType} ${opts.version} 期间有 ${arr.length} 期，默认显示末期` : '',
      };
    }
    const near = keys.find(k => versionBase(k) <= versionBase(opts.version));
    if (near) {
      return {
        id: map[near].at(-1),
        label: `版本 ${near}（${opts.version} 无记录）`,
        tip: `${reqType} ${opts.version} 暂无数据，已回退到最近可查的 ${near} 期`,
      };
    }
    return {
      id: map[curKey].at(-1),
      label: `当前版本 ${curKey}`,
      tip: `${reqType} ${opts.version} 早于最早收录版本（${keys.at(-1)}），已显示当期`,
    };
  }

  if (opts.prev) {
    const i = keys.indexOf(curKey);
    const pk = i >= 0 ? keys[i + 1] : null;
    if (pk && map[pk]?.length) {
      return { id: map[pk].at(-1), label: `版本 ${pk}（上一期）` };
    }
    return { id: map[curKey].at(-1), label: `当前版本 ${curKey}`, tip: `${reqType} 已是最早收录的一期，没有更早数据` };
  }

  return { id: map[curKey].at(-1), label: `当前版本 ${curKey}` };
}

// 无版本映射的玩法（虚构叙事 / 末日幻影）：按收录期号序列选择当期或上一期。
// 依据列表条目是否已命名（zh/en 等字段）判断已发布，跳过预留占位 id（例如末日幻影最新的占位期）。
function pickSeqEntry(detailBase, list, reqType, opts, live = '') {
  const named = Object.entries(list || {})
    .map(([id, v]) => ({ id: Number(id), ok: !!(v && (v.zh || v.en || v.ko || v.ja)) }))
    .filter(x => Number.isFinite(x.id) && x.ok)
    .sort((a, b) => b.id - a.id);
  const cur = named[0]?.id;
  const prev = named[1]?.id;
  if (cur == null) return { tip: `${reqType} 暂无可用期数据` };
  if (opts.prev) {
    if (prev == null) return { id: cur, label: `当前版本 ${live}`, tip: `${reqType} 已是最早收录的一期，没有更早数据` };
    return { id: prev, label: `上一期（当前 #${cur} → #${prev}）` };
  }
  return { id: cur, label: `当前版本 ${live}` };
}

// 虚构叙事 / 末日幻影：Nanoka 无版本映射文件，但期 id 在 2.x/3.x/4.x 按次版本线性递增。
// 依据 SR_VERSION_MAP 已知锚点推回任意版本对应的期 id；无法推导时返回 null。
function srSeqId(type, version) {
  const [a, b] = String(version || '').split('.').map(Number);
  if (!a || Number.isNaN(b)) return null;
  if (type === '虚构叙事') {
    if (a === 1) return b === 6 ? 2003 : null;
    if (a === 2) return 2004 + b;
    if (a === 3) return 2012 + b;
    if (a === 4) return 2021 + b;
    return null;
  }
  if (type === '末日幻影') {
    if (a === 2) return b >= 7 ? 3005 + (b - 7) : null;
    if (a === 3) return 3006 + b;
    if (a === 4) return 3015 + b;
    return null;
  }
  return null;
}

function makeTextCard(title, meta = '', desc = '', color = '#7f5cff') {
  return {
    title: stripHtml(String(title || '')),
    meta: stripHtml(String(meta || '')),
    desc: stripHtml(String(desc || '')),
    badge: shortLabel(stripHtml(String(title || ''))),
    color,
  };
}

function splitListText(list = [], joiner = ' / ') {
  return list.map(v => stripHtml(String(v || ''))).filter(Boolean).join(joiner);
}

function formatSrMonsterName(id, map, childMap) {
  const key = String(id);
  return map?.[key]?.zh || map?.[key]?.en || childMap?.[key]?.name || key;
}

// 星铁怪物图：数据源给出游戏内资源相对路径（SpriteOutput/MonsterFigure/Monster_xxx.png），
// Nanoka 已提供 static.nanoka.cc/assets/hsr/monstermiddleicon/{filename}.webp 镜像。
// 对占位图标 BossIconTemporary 直接置空，避免请求无效图片。
function srMonsterIconUrl(icon = '') {
  const m = String(icon).match(/([^\\/]+)\.(?:png|webp|jpg)$/i);
  if (!m) return '';
  const file = m[1];
  if (file === 'BossIconTemporary') return '';
  return `https://static.nanoka.cc/assets/hsr/monstermiddleicon/${file}.webp`;
}

function srMonsterInfo(id, map, childMap) {
  const key = String(id);
  const entry = map?.[key];
  const child = childMap?.[key];
  const weak = srWeakList(entry?.weak || []);
  if (entry?.zh || entry?.en || child?.name) {
    return {
      name: entry?.zh || entry?.en || child?.name || key,
      icon: srMonsterIconUrl(entry?.icon || child?.icon || ''),
      weak,
    };
  }
  // 兜底：末日幻影/异相仲裁的 BOSS 未单独收录时，逐级截断父级 id 匹配
  // 例：200401401 -> 2004014(勾魂摄魄的支配者)、406401201 -> 4064012(迷惘之渊的裁定者)
  for (let k = key.slice(0, -1); k.length >= 6; k = k.slice(0, -1)) {
    const p = map?.[k];
    if (p) return { name: p.zh || p.en || key, icon: srMonsterIconUrl(p.icon || ''), weak: srWeakList(p.weak || []) };
  }
  return { name: key, icon: '', weak: [] };
}

// 计算怪物在指定关卡等级下的血量/速度/韧性（与 Nanoka 站点计算公式一致）
// HP  = HPBase   * child.HPModifyRatio   * EliteGroup.HPRatio   * HardLevelGroup.HPRatio
// SPD = SpeedBase* child.SpeedModifyRatio * EliteGroup.SpeedRatio * HardLevelGroup.SpeedRatio + SpeedModifyValue
// Toughness = StanceBase * child.StanceModifyRatio * EliteGroup.StanceRatio * HardLevelGroup.StanceRatio / 3
// EliteGroup 优先使用 stage 的 elite_group（混沌/末日），缺失时回退到怪物自身的 EliteGroup（虚构叙事）。
function srMonsterStats(pid, level, stageEliteGroup, valueByChild, eliteMap, hlgMap) {
  if (!pid || !valueByChild || !eliteMap || !hlgMap) return null;
  const cv = valueByChild.get(String(pid));
  if (!cv) return null;
  const lv = Number(level) || cv.level || 95;
  const eg = eliteMap.get(stageEliteGroup ?? cv.eliteGroup) || {};
  const hl = hlgMap.get(`${cv.hardLevelGroup}_${lv}`) || {};
  const hp = cv.HPBase * (cv.HPModifyRatio || 1) * (eg.HPRatio || 1) * (hl.HPRatio || 1);
  const spd = cv.SpeedBase * (cv.SpeedModifyRatio || 1) * (eg.SpeedRatio || 1) * (hl.SpeedRatio || 1) + (cv.SpeedModifyValue || 0);
  const tough = cv.StanceBase * (cv.StanceModifyRatio || 1) * (eg.StanceRatio || 1) * (hl.StanceRatio || 1) / 3;
  return {
    hp: Math.round(hp).toLocaleString('en-US'),
    speed: Math.round(spd),
    toughness: (Math.round(tough * 10) / 10).toFixed(1),
  };
}

function formatSrStage(list, label, monsterMap, monsterChildMap) {
  const stage = (list || [])[0];
  if (!stage) return '';
  const waves = (stage.monster_list || []).map((wave, widx) => {
    const names = Object.values(wave || {}).map(mid => formatSrMonsterName(mid, monsterMap, monsterChildMap)).filter(Boolean).join(' / ');
    return names ? `波次 ${widx + 1}：${names}` : '';
  }).filter(Boolean);
  const header = `${label}${stage.level ? ` Lv.${stage.level}` : ''}`;
  return [header, ...waves].filter(Boolean).join('\n');
}

const SR_DMG_LABEL = {
  Physical: '物理',
  Fire: '火',
  Ice: '冰',
  Lightning: '雷',
  Thunder: '雷',
  Wind: '风',
  Quantum: '量子',
  Imaginary: '虚数',
};

const SR_DMG_COLOR = {
  物理: '#d6dae2',
  火: '#f2673a',
  冰: '#5aa7ff',
  雷: '#a970ff',
  风: '#53d2bd',
  量子: '#8f9bff',
  虚数: '#e8c258',
};

function srCleanText(text = '', params) {
  let s = String(text || '').replace(/\\n/g, ' ');
  s = s.replace(/<color=#?[0-9a-fA-F]{6,8}>/gi, '').replace(/<\/color>/gi, '');
  s = s.replace(/<\/?unbreak>/gi, '').replace(/<\/?[^>]+>/g, '');
  s = s.replace(/#(\d+)(?:\[i\])?/g, (m, idx, off, full) => {
    const p = Array.isArray(params) ? params[Number(idx) - 1] : params;
    if (p === undefined || p === null) return '';
    const isPct = full.charAt(off + m.length) === '%';
    let v = Number(p);
    if (Number.isFinite(v)) {
      if (isPct && v <= 1) v = Math.round(v * 100);
      return String(v);
    }
    return String(p);
  });
  return s.replace(/\s+/g, ' ').trim();
}

function srWeakList(keys = []) {
  const out = [];
  for (const key of keys || []) {
    const name = SR_DMG_LABEL[key] || '';
    if (!name) continue;
    out.push({ name, color: SR_DMG_COLOR[name] || '#ffffff' });
  }
  return out;
}

function srChallengeTexts(list = []) {
  return (list || []).map(v => srCleanText(v?.name, v?.param)).filter(Boolean);
}

function srSide(stages = [], weakness = [], monsterMap, monsterChildMap, bossIds = [], refs = {}) {
  const stage = (stages || [])[0];
  const level = stage?.level;
  const stageEliteGroup = stage?.elite_group;
  const { valueByChild, eliteMap, hlgMap } = refs || {};
  const addInfo = (pid) => {
    const k = String(pid);
    const info = srMonsterInfo(k, monsterMap, monsterChildMap);
    if (!info.name || info.name === k) return null;
    info.stats = srMonsterStats(k, level, stageEliteGroup, valueByChild, eliteMap, hlgMap);
    info.pid = k;
    return info;
  };
  const waves = ((stage && stage.monster_list) || [])
    .map(wave => {
      const group = new Map();
      Object.values(wave || {}).forEach(pid => {
        const info = addInfo(pid);
        if (!info) return;
        const prev = group.get(info.pid);
        if (prev) {
          prev.count += 1;
        } else {
          info.count = 1;
          group.set(info.pid, info);
        }
      });
      return [...group.values()];
    })
    .filter(v => v.length);
  // 末日幻影等模式把 BOSS 放在最前面单独一波，确保 BOSS 图标一定显示
  const bossWave = [];
  for (const pid of bossIds || []) {
    if (!pid) continue;
    const info = addInfo(pid);
    if (info) {
      info.count = info.count || 1;
      bossWave.push(info);
    }
  }
  if (bossWave.length) waves.unshift(bossWave);
  // 星启模式（污染入侵）模式：提取 stage.invasion，附加到 side 供模板渲染
  let invasion = null;
  if (config().abyss_report_sr_invasion !== false && stage?.invasion) {
    const monsters = [];
    for (const m of stage.invasion.monster_list || []) {
      const pid = m?.unk_0;
      if (pid == null) continue;
      const info = addInfo(pid);
      if (info) {
        info.count = info.count || 1;
        monsters.push(info);
      }
    }
    invasion = {
      level: stage.invasion.level,
      desc: stripHtml(stage.invasion.desc || ''),
      monsters,
    };
  }
  return {
    level: level || '',
    weakness: srWeakList(weakness || []),
    waves,
    invasion,
  };
}

async function loadSrNanoka(reqType, opts = {}) {
  const manifest = await fetchJson(MANIFEST_URL, 6000);
  const nv = manifest?.hsr?.latest || '4.5.52';
  const live = manifest?.hsr?.live || '4.5';
  let hsrMonsterMap = {};
  const hsrMonsterChildMap = {};
  const hsrMonsterValueByChild = new Map();
  let hsrEliteMap = new Map();
  let hsrHardLevelMap = new Map();
  try {
    hsrMonsterMap = await fetchJson(`https://static.nanoka.cc/hsr/${nv}/monster.json`, 8000) || {};
    Object.entries(hsrMonsterMap).forEach(([pid, entry]) => {
      const name = entry?.zh || entry?.en || pid;
      (entry?.child || []).forEach(cid => {
        hsrMonsterChildMap[String(cid)] = { name, icon: entry?.icon || '' };
      });
    });
  } catch (err) {
    logger.warn(`[xhh][abyss_report] 加载星铁怪物映射失败: ${err.message}`);
  }
  try {
    const valueData = await fetchJson(`https://static.nanoka.cc/hsr/${nv}/monstervalue.json`, 8000) || {};
    Object.entries(valueData).forEach(([parentId, entry]) => {
      (entry?.child || []).forEach(c => {
        const k = String(c?.Id);
        if (!k) return;
        hsrMonsterValueByChild.set(k, {
          HPBase: entry?.HPBase ?? 0,
          SpeedBase: entry?.SpeedBase ?? 0,
          StanceBase: entry?.StanceBase ?? 0,
          HPModifyRatio: c?.HPModifyRatio ?? 1,
          SpeedModifyRatio: c?.SpeedModifyRatio ?? 1,
          StanceModifyRatio: c?.StanceModifyRatio ?? 1,
          SpeedModifyValue: c?.SpeedModifyValue ?? 0,
          eliteGroup: c?.EliteGroup,
          hardLevelGroup: c?.HardLevelGroup,
          level: c?.Level,
        });
      });
    });
  } catch (err) {
    logger.warn(`[xhh][abyss_report] 加载星铁怪物数值失败: ${err.message}`);
  }
  try {
    const eliteNormal = await fetchJson(`https://static.nanoka.cc/hsr/${nv}/EliteGroup.json`, 8000);
    const eliteInfinite = await fetchJson(`https://static.nanoka.cc/hsr/${nv}/InfiniteEliteGroup.json`, 8000);
    const eliteList = [
      ...(Array.isArray(eliteNormal) ? eliteNormal : []),
      ...(Array.isArray(eliteInfinite) ? eliteInfinite : []),
    ];
    hsrEliteMap = new Map(eliteList.filter(e => e?.EliteGroup !== undefined).map(e => [e.EliteGroup, e]));
  } catch (err) {
    logger.warn(`[xhh][abyss_report] 加载星铁精英组数据失败: ${err.message}`);
  }
  try {
    const hlgListRaw = await fetchJson(`https://static.nanoka.cc/hsr/${nv}/HardLevelGroup.json`, 8000);
    const hlgList = Array.isArray(hlgListRaw) ? hlgListRaw : [];
    hsrHardLevelMap = new Map(hlgList.filter(e => e?.HardLevelGroup !== undefined && e?.Level !== undefined).map(e => [`${e.HardLevelGroup}_${e.Level}`, e]));
  } catch (err) {
    logger.warn(`[xhh][abyss_report] 加载星铁等级成长数据失败: ${err.message}`);
  }
  const srRefs = { valueByChild: hsrMonsterValueByChild, eliteMap: hsrEliteMap, hlgMap: hsrHardLevelMap };
  const routeMap = {
    '混沌回忆': { versionMap: `https://static.nanoka.cc/hsr/${nv}/zh/maze/version.json`, detail: `https://static.nanoka.cc/hsr/${nv}/zh/maze`, mode: 'maze' },
    '虚构叙事': { list: `https://static.nanoka.cc/hsr/${nv}/maze_extra.json`, detail: `https://static.nanoka.cc/hsr/${nv}/zh/story`, mode: 'story' },
    '末日幻影': { list: `https://static.nanoka.cc/hsr/${nv}/maze_boss.json`, detail: `https://static.nanoka.cc/hsr/${nv}/zh/boss`, mode: 'doom' },
    '异相仲裁': { versionMap: `https://static.nanoka.cc/hsr/${nv}/zh/peak/version.json`, detail: `https://static.nanoka.cc/hsr/${nv}/zh/peak`, mode: 'peak' },
  };
  const cfg = routeMap[reqType];
  if (!cfg) return null;
  let id = null;
  let list = null;
  let label = '';
  let tip = '';
  if (cfg.versionMap) {
    const map = await fetchJson(cfg.versionMap, 8000);
    const pick = resolveMapId(map, live, reqType, opts);
    id = pick.id ?? null;
    label = pick.label || '';
    tip = pick.tip || '';
  }
  if (!id && cfg.list) {
    list = await fetchJson(cfg.list, 8000);
    if (opts.version) {
      const seqId = srSeqId(reqType, opts.version);
      if (seqId != null && list?.[String(seqId)]) {
        id = String(seqId);
        label = `版本 ${opts.version}`;
      } else {
        tip = `${reqType} ${opts.version} 暂无收录，已显示当期；可回复「${reqType}上一期」查看更早一期`;
      }
    }
    if (!id) {
      const pick = await pickSeqEntry(cfg.detail, list, reqType, opts, live);
      id = pick.id ?? null;
      if (pick.label) label = pick.label;
      if (pick.tip) tip = pick.tip;
    }
  }
  if (!id) return null;
  const detail = await fetchJson(`${cfg.detail}/${id}.json`, 8000);
  const base = { version: nv, id, title: reqType, period: label || `当前版本 ${live}`, tip, gameKey: 'sr', mode: cfg.mode };

  if (reqType === '混沌回忆') {
    const mazeLevels = String(config().abyss_report_sr_maze_levels || '11,12')
      .split(/[,，\s]+/)
      .map(s => Number(s))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= 12);
    const allRows = (Array.isArray(detail) ? detail : []).filter(r => r && (r.name || r.event_id_list) && (r.event_id_list1 || r.event_id_list2 || r.event_id_list));
    const starRows = allRows.filter(r => r.event_id_list && !r.event_id_list1);
    let rows = allRows.filter(r => r.event_id_list1 || r.event_id_list2);
    if (mazeLevels.length) {
      rows = rows.filter(r => mazeLevels.includes(Number(String(r.id).slice(-2))));
    }
    const nodes = rows.map(row => {
      const star = starRows.find(s => Number(s.pre_id) === Number(row.id));
      const sides = [
        { label: star ? '上' : '上半', ...srSide(row.event_id_list1, row.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', ...srSide(row.event_id_list2, row.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '星启', ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
      }
      return { title: srCleanText(row.name), goals: srChallengeTexts(row.challenge), sides };
    });
    const first = rows[0] || {};
    return {
      ...base,
      intro: srCleanText(first.desc, first.param),
      goals: srChallengeTexts(first.challenge),
      nodes,
    };
  }

  if (reqType === '虚构叙事') {
    const groups = [];
    if ((detail.option || []).length) {
      groups.push({
        title: '可选增益',
        items: detail.option.map(v => ({ name: srCleanText(v.name || ''), desc: srCleanText(v.desc, v.param) })),
      });
    }
    if ((detail.sub_option || []).length) {
      groups.push({
        title: '附加条目',
        items: detail.sub_option.map(v => ({ name: srCleanText(v.name || ''), desc: srCleanText(v.desc, v.param) })),
      });
    }
    const fictionLevels = String(config().abyss_report_sr_fiction_levels || '3,4')
      .split(/[,，\s]+/)
      .map(s => Number(s))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= 5);
    const allLevels = (Array.isArray(detail.level) ? detail.level : []).filter(lv => (lv.event_id_list1 || []).length || (lv.event_id_list2 || []).length || (lv.event_id_list || []).length);
    const starLevels = allLevels.filter(lv => lv.event_id_list && !lv.event_id_list1);
    let levels = allLevels.filter(lv => lv.event_id_list1 || lv.event_id_list2);
    if (fictionLevels.length) {
      levels = levels.filter(lv => fictionLevels.includes(Number(String(lv.id).slice(-1))));
    }
    const nodes = levels.map(lv => {
      const star = starLevels.find(s => Number(s.pre_id) === Number(lv.id));
      const sides = [
        { label: star ? '上' : '上半', ...srSide(lv.event_id_list1, lv.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', ...srSide(lv.event_id_list2, lv.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '星启', ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
      }
      return {
        title: srCleanText(lv.name || '') || '关卡',
        goals: srChallengeTexts(lv.challenge),
        sides,
      };
    });
    return {
      ...base,
      intro: srCleanText(detail.buff?.desc, detail.buff?.param),
      groups,
      nodes,
    };
  }

  if (reqType === '末日幻影') {
    const groups = [];
    if (detail.buff?.desc) {
      groups.push({
        title: '核心效果',
        items: [{ name: srCleanText(detail.buff.name || ''), desc: srCleanText(detail.buff.desc, detail.buff.param) }],
      });
    }
    for (const [name, buffs] of [['第一阶段', detail.buff_list1], ['第二阶段', detail.buff_list2], ['第三阶段', detail.buff_list3]]) {
      if ((buffs || []).length) {
        groups.push({
          title: name,
          items: buffs.map(v => ({ name: srCleanText(v.name || ''), desc: srCleanText(v.desc, v.param) })),
        });
      }
    }
    const fallback = srCleanText(detail.name || '');
    const doomLevels = String(config().abyss_report_sr_doom_levels || '3,4')
      .split(/[,，\s]+/)
      .map(s => Number(s))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= 5);
    const allLevels = (Array.isArray(detail.level) ? detail.level : []).filter(lv => (lv.event_id_list1 || []).length || (lv.event_id_list2 || []).length || lv.boss_monster_id1 || lv.boss_monster_id2 || (lv.event_id_list || []).length);
    const starLevels = allLevels.filter(lv => lv.event_id_list && !lv.event_id_list1);
    let levels = allLevels.filter(lv => lv.event_id_list1 || lv.event_id_list2 || lv.boss_monster_id1 || lv.boss_monster_id2);
    if (doomLevels.length) {
      levels = levels.filter(lv => doomLevels.includes(Number(String(lv.id).slice(-1))));
    }
    const nodes = levels.map((lv, idx) => {
      const star = starLevels.find(s => Number(s.pre_id) === Number(lv.id));
      const sides = [
        { label: star ? '上' : '上半', ...srSide(lv.event_id_list1, lv.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', ...srSide(lv.event_id_list2, lv.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '星启', ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
      }
      return {
        title: srCleanText(lv.name || '') || (fallback ? `${fallback}·难度 ${idx + 1}` : `难度 ${idx + 1}`),
        goals: srChallengeTexts(lv.challenge),
        sides,
      };
    });
    return { ...base, groups, nodes };
  }

  if (reqType === '异相仲裁') {
    const pres = Array.isArray(detail.pre_level) ? detail.pre_level : [];
    const nodes = pres.map(v => {
      const rules = (v.tag_list || []).map(t => ({ name: srCleanText(t.name || ''), desc: srCleanText(t.desc, t.param) }));
      return {
        title: srCleanText(v.name || '') || '节点',
        rules,
        sides: [{ label: '', ...srSide(v.event_id_list, v.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) }],
      };
    });
    const bc = detail.boss_config || {};
    const bl = detail.boss_level || {};
    const groups = [];
    if ((bc.buff_list || []).length) {
      groups.push({
        title: '战前增益',
        items: bc.buff_list.map(v => ({ name: srCleanText(v.name || ''), desc: srCleanText(v.desc, v.param) })),
      });
    }
    const boss = {
      title: srCleanText(bc.hard_name || bl.name || '首领挑战'),
      boss: true,
      rules: (bc.tag_list || []).map(t => ({ name: srCleanText(t.name || ''), desc: srCleanText(t.desc, t.param) })),
      sides: [{ label: '', ...srSide(bc.event_id_list, [], hsrMonsterMap, hsrMonsterChildMap, [], srRefs), weakness: srWeakList(bl.damage_type || []) }],
    };
    return { ...base, groups, nodes: [...nodes, boss] };
  }

  return null;
}

const ZZZ_ELEMENT_LABEL = {
  ice: '冰',
  fire: '火',
  electric: '电',
  ether: '以太',
  physical: '物理',
  wind: '风',
};

const ZZZ_ELEMENT_COLOR = {
  冰: '#7fd6ff',
  火: '#ff6b4a',
  电: '#b47aff',
  以太: '#ff8ccf',
  物理: '#d0d0d0',
  风: '#72e3c3',
};

function zzzIconUrl(image = '') {
  const m = String(image).match(/([^\\/]+)\.(?:png|webp|jpg|jpeg)$/i);
  if (!m) return '';
  return `https://static.nanoka.cc/assets/zzz/${m[1]}.webp`;
}

function zzzWeaknessList(weaknessObj = {}) {
  return Object.entries(weaknessObj)
    .map(([code, label]) => {
      const name = String(label).replace(/属性$/, '');
      return { code, name, color: ZZZ_ELEMENT_COLOR[name] || '#ffffff' };
    })
    .filter(v => v.name);
}

function zzzMonsterCard(mon = {}) {
  const icon = zzzIconUrl(mon.image);
  const elementText = Object.entries(mon.element || {})
    .filter(([_, v]) => v === 1)
    .map(([k]) => ZZZ_ELEMENT_LABEL[k] || k)
    .filter(Boolean);
  const stats = mon.stats || {};
  return {
    name: mon.name || '未知敌人',
    icon,
    elementText,
    statsText: `HP ${formatNum(stats.hp)} · ATK ${formatNum(stats.attack)} · DEF ${formatNum(stats.defence)} · 眩晕 ${formatNum(stats.stun)}`,
    shortStat: `HP ${formatNum(stats.hp)} · ATK ${formatNum(stats.attack)}`,
  };
}

async function loadZzzNanoka(reqType, opts = {}) {
  const manifest = await fetchJson(MANIFEST_URL, 6000);
  const nv = manifest?.zzz?.latest || '3.2.12+18601660';
  const live = manifest?.zzz?.live || '3.1';
  const routeMap = {
    '式舆防卫战': { list: `https://static.nanoka.cc/zzz/${nv}/shiyu.json`, detail: `https://static.nanoka.cc/zzz/${nv}/zh/shiyu`, map: `https://static.nanoka.cc/zzz/${nv}/zh/shiyu/version.json` },
    '危局强袭战': { list: `https://static.nanoka.cc/zzz/${nv}/boss.json`, detail: `https://static.nanoka.cc/zzz/${nv}/zh/boss`, map: `https://static.nanoka.cc/zzz/${nv}/zh/boss/version.json` },
  };
  const cfg = routeMap[reqType];
  if (!cfg) return null;
  let id = null;
  let label = '';
  let tip = '';
  let map = null;
  if (cfg.map) {
    try {
      map = await fetchJson(cfg.map, 8000);
    } catch (err) {
      logger.warn(`[xhh][abyss_report] ${reqType} 版本索引获取失败: ${err.message}`);
    }
  }
  const list = await fetchJson(cfg.list, 8000);
  // 版本索引仅在显式请求版本号 / 上一期时使用；默认当期沿用列表 live 状态判定，避免误选未发布占位数据
  if (map && (opts.version || opts.prev)) {
    const pick = resolveMapId(map, live, reqType, opts);
    id = pick.id ?? null;
    label = pick.label || '';
    tip = pick.tip || '';
  }
  if (!id) {
    const now = moment();
    const items = Object.entries(list || {}).map(([k, v]) => ({ id: Number(k), ...v })).filter(v => v.live_begin && v.live_end);
    const active = items.find(v => now.isBetween(moment(v.live_begin), moment(v.live_end), undefined, '[]')) || items.sort((a, b) => b.id - a.id)[0];
    const sorted = items.length ? items.sort((a, b) => b.id - a.id) : Object.keys(list || {}).map(v => ({ id: Number(v) })).sort((a, b) => b.id - a.id);
    id = opts.prev ? (sorted[1]?.id || sorted[0]?.id || null) : (active?.id || sorted[0]?.id || null);
    label = opts.prev ? '上一期' : '';
    if (opts.prev && !tip) tip = `${reqType} 暂无版本索引，可回复「${reqType}上一期」往前翻`;
    if (opts.version && !tip) tip = `${reqType} ${opts.version} 暂无版本索引，已显示当期`;
  }
  if (!id) return null;
  const detail = await fetchJson(`${cfg.detail}/${id}.json`, 8000);
  const sections = [];
  let period = label || (detail?.begin_time || detail?.end_time ? `${detail.begin_time || ''} ~ ${detail.end_time || ''}` : `当前版本 ${live}`);

  if (reqType === '式舆防卫战') {
    const zoneMap = detail?.zone || {};
    const allZones = Object.entries(zoneMap);
    const childIds = new Set(allZones.flatMap(([_, z]) => (z.child || []).map(String)));
    const shiyuStages = String(config().abyss_report_zzz_shiyu_stages || '4,5')
      .split(/[,，\s]+/)
      .map(s => Number(s))
      .filter(n => Number.isFinite(n) && n >= 1);
    let zoneEntries = allZones;
    if (shiyuStages.length) {
      zoneEntries = zoneEntries.filter(([_, z]) => shiyuStages.includes(Number(z.stage_num)));
    }

    const buildRoom = (zone) => {
      return Object.values(zone.layer_room || {}).map((room, ridx) => {
        const monsters = Object.values(room.monster_list || {}).map(v => zzzMonsterCard(v));
        const weakness = zzzWeaknessList(room.monster_weakness);
        const buffs = Object.values(zone.layer_buff || {}).map(v => v.title || v.desc).filter(Boolean);
        return {
          title: room.name || `房间 ${ridx + 1}`,
          meta: `Lv.${zone.monster_level || ''} · ${room.waves_num || 1} Wave`,
          weakness,
          buff: stripHtml(buffs.join(' / ') || ''),
          monsters,
        };
      });
    };

    const nodes = zoneEntries.map(([zoneId, zone]) => {
      if (childIds.has(zoneId)) return null;
      let rooms = [];
      if (zone.child?.length) {
        rooms = zone.child.flatMap(childId => buildRoom(zoneMap[String(childId)]));
      } else {
        rooms = buildRoom(zone);
      }
      return {
        title: zone.name || `节点 ${zone.stage_num || ''}`,
        meta: `Lv.${zone.monster_level || ''}`,
        rooms,
      };
    }).filter(Boolean);

    return { version: nv, id, title: '式舆防卫战', period, tip, gameKey: 'zzz', mode: 'shiyu', nodes };
  }

  if (reqType === '危局强袭战') {
    const modes = Array.isArray(detail?.modes) ? detail.modes : [];
    const items = modes.map((mode, idx) => {
      const zone = Object.values(mode.zone || {})[0] || {};
      const room = Object.values(zone.layer_room || {})[0] || {};
      const monster = Object.values(room.monster_list || {})[0] || {};
      const boss = zzzMonsterCard(monster);
      const buffs = Object.values(zone.layer_buff || {}).map(v => v.title || v.desc).filter(Boolean).map(stripHtml);
      const selectable = Object.values(zone.selectable_buff || {}).map(v => v.title || v.desc).filter(Boolean).map(stripHtml);
      return {
        title: zone.name || `节点 ${idx + 1}`,
        meta: `Lv.${zone.monster_level || ''}`,
        rankGoals: `S ${formatNum(zone.s_rank_goal)} · A ${formatNum(zone.a_rank_goal)} · B ${formatNum(zone.b_rank_goal)}`,
        boss,
        buffs,
        selectable,
      };
    });
    return { version: nv, id, title: '危局强袭战', period, tip, gameKey: 'zzz', mode: 'boss', items };
  }

  return null;
}

const DEFAULT_LEYLINE_ICON = 'data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"%23fbbf24\"%3E%3Cpath d=\"M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z\"/%3E%3C/svg%3E';

async function loadGsTower(opts = {}) {
  const manifest = await fetchJson(MANIFEST_URL, 6000);
  const nv = manifest?.gi?.latest || '7.0.53';
  const live = String(manifest?.gi?.live || '');
  // 指定了历史版本且与当前 live 版本不一致时，Nanoka 塔数据无法按版本回查，返回 null 走仓库图片下载
  if (opts.version && live && versionBase(opts.version) !== versionBase(live)) return null;
  const list = await fetchJson(`https://static.nanoka.cc/gi/${nv}/tower.json`, 8000);
  const rows = Object.entries(list || {})
    .map(([id, v]) => ({ id: Number(id), ...v }))
    .filter(v => Number.isFinite(v.id) && (v.begin || v.live_begin || v.zh || v.en))
    .sort((a, b) => Date.parse(a.live_begin || a.begin || '') - Date.parse(b.live_begin || b.begin || ''));
  let active = pickCurrentTower(list);
  let tip = '';
  if (opts.prev && active) {
    const idx = rows.findIndex(v => v.id === active.id);
    const prevRow = idx > 0 ? rows[idx - 1] : null;
    if (prevRow) active = prevRow;
    else tip = '这已是收录范围内最早的一期深境螺旋';
  }
  if (!active?.id) return null;
  const data = await fetchJson(`https://static.nanoka.cc/gi/${nv}/zh/tower/${active.id}.json`, 8000);
  const floor = data?.floor?.['12'];
  if (!floor) return null;
  const rooms = Object.entries(floor.room || {}).map(([idx, room]) => buildTowerRoom(room, idx)).sort((a, b) => Number(a.idx) - Number(b.idx));
  const hpMatch = (floor.buff || []).join(' ').match(/怪物血量提升(\d+)%/);
  const hpPct = hpMatch ? Number(hpMatch[1]) + 100 : '';
  return {
    version: nv,
    id: active.id,
    period: `${active.live_begin || active.begin || ''} ~ ${active.live_end || active.end || ''}`,
    tip,
    leyline: {
      name: data?.leyline?.name || active.zh || active.en || '深境螺旋',
      desc: stripHtml(data?.leyline?.desc || active.desc || ''),
      icon: data?.leyline?.icon || active.icon || '',
      iconUrl: DEFAULT_LEYLINE_ICON,
    },
    floorNum: 12,
    floorLabel: '第12层',
    floorBuffs: (floor.buff || []).map(v => stripHtml(v)),
    firstHalfBuff: stripHtml(floor.first_half_buff || ''),
    secondHalfBuff: stripHtml(floor.second_half_buff || ''),
    challenge: (floor.room || {}),
    rooms,
    hpAbility: floor.hp_ability || '',
    hpPct,
  };
}

async function listRepoImageNumbers(type) {
  const key = `${type}:${repoList().join('|')}`;
  if (repoImageCache.has(key)) return repoImageCache.get(key);
  const set = new Set();
  for (const repo of repoList()) {
    const url = rawRepoToTreeUrl(repo, type);
    try {
      const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 xhh' } }).then(r => r.text());
      for (const match of html.matchAll(/\b([1-9]\d*\.\d{1,2}[A-Za-z]?)\.png\b/g)) {
        set.add(match[1]);
      }
    } catch (err) {
      logger.warn(`[xhh][abyss_report] 仓库目录读取失败 ${url}: ${err.message}`);
    }
  }
  const list = [...set].sort((a, b) => versionBase(b) - versionBase(a) || String(a).localeCompare(String(b)));
  repoImageCache.set(key, list);
  return list;
}

async function fallbackImageNumbers(game, version, type) {
  if (game !== 'gs') return null;
  const reqBase = versionBase(version);
  if (reqBase < 0) return null;
  const list = await listRepoImageNumbers(type);
  const latest = list.find(num => versionBase(num) <= reqBase);
  if (!latest) return null;
  const base = String(latest).match(/^([1-9]\d*\.\d{1,2})/)?.[1] || latest;
  const nums = list.filter(num => String(num).match(/^([1-9]\d*\.\d{1,2})/)?.[1] === base);
  return { version: base, numbers: nums.length ? nums : [latest] };
}

async function downloadImage(type, number) {
  ensureDir(CACHE_DIR);
  const safe = `${type}_${number}`.replace(/[\\/:*?"<>|]/g, '_');
  const local = path.join(CACHE_DIR, `${safe}.png`);
  if (fs.existsSync(local) && fs.statSync(local).size > 1024) return local;
  for (const repo of repoList()) {
    const url = `${repo.replace(/\/$/, '')}/${encodeURIComponent(type)}/${number}.png`.replace(/%2F/g, '/');
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 xhh' } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 || !isImageBuffer(buf)) continue;
      fs.writeFileSync(local, buf);
      return local;
    } catch (err) {
      logger.warn(`[xhh][abyss_report] 下载失败 ${url}: ${err.message}`);
    }
  }
  return '';
}


async function mergeImages(imageList = [], meta = {}) {
  const paths = imageList.map(v => v.path).filter(Boolean);
  if (!paths.length) return '';
  if (paths.length === 1) return paths[0];
  ensureDir(CACHE_DIR);
  const out = path.join(CACHE_DIR, `merged_${meta.type || 'report'}_${meta.version || ''}_${imageList.map(v => v.num).join('_')}.jpg`.replace(/[\\/:*?"<>|]/g, '_'));
  const stats = paths.map(p => fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0).join('|');
  const needBuild = !fs.existsSync(out) || fs.statSync(out).size < 1024 || fs.statSync(out).mtimeMs < Math.max(...paths.map(p => fs.statSync(p).mtimeMs));
  if (!needBuild) return out;

  const imgs = [];
  for (const p of paths) {
    const img = sharp(p).rotate();
    const m = await img.metadata();
    imgs.push({ path: p, width: m.width || 0, height: m.height || 0 });
  }
  const width = Math.max(...imgs.map(v => v.width), 1200);
  const gap = 24;
  const pad = 28;
  const titleH = 112;
  const footerH = 58;
  const totalH = titleH + footerH + pad * 2 + imgs.reduce((sum, v) => sum + v.height, 0) + gap * (imgs.length - 1);
  const bg = Buffer.from(`
  <svg width="${width + pad * 2}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#111b35"/><stop offset="0.55" stop-color="#251b3c"/><stop offset="1" stop-color="#10131f"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <text x="${pad}" y="48" fill="#ffe8a8" font-size="22" font-family="sans-serif" letter-spacing="3">XHH ABYSS REPORT</text>
    <text x="${pad}" y="88" fill="#ffffff" font-size="34" font-family="sans-serif" font-weight="700">${meta.gameName || ''} v${meta.version || ''} ${meta.type || ''}</text>
    <text x="${(width + pad * 2) / 2}" y="${totalH - 24}" text-anchor="middle" fill="#c8d2ea" font-size="18" font-family="sans-serif">数据来源：Abyss Repo / Nanoka · from 小花火</text>
  </svg>`);
  let top = titleH + pad;
  const composite = [];
  for (const img of imgs) {
    composite.push({ input: img.path, left: pad + Math.floor((width - img.width) / 2), top });
    top += img.height + gap;
  }
  await sharp(bg).composite(composite).jpeg({ quality: 92 }).toFile(out);
  return out;
}

async function loadGsBlessing(version) {
  try {
    const manifest = await fetchJson(MANIFEST_URL, 6000);
    const nv = manifest?.gi?.latest || version;
    const data = await fetchJson(`https://static.nanoka.cc/gi/${nv}/tower.json`, 8000);
    const now = moment();
    const rows = Object.values(data || {}).filter(v => v?.zh || v?.desc);
    const active = rows.find(v => v.begin && v.end && now.isBetween(moment(v.begin), moment(v.end), undefined, '[)')) || rows.at(-1);
    if (!active) return null;
    return {
      title: active.zh || active.en || '深渊祝福',
      desc: stripHtml(active.desc || active.zh || ''),
      begin: active.begin || '',
      end: active.end || '',
      version: nv,
    };
  } catch (err) {
    logger.warn(`[xhh][abyss_report] 原神 tower 数据获取失败: ${err.message}`);
    return null;
  }
}

export class abyss_report extends plugin {
  constructor() {
    super({
      name: '[小花火]三游戏深渊速报',
      dsc: '原神/星铁/绝区零版本深渊速报图',
      event: 'message',
      priority: pluginPriority('abyss_report', 100),
      rule: [
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?([1-9]\\.[0-9]{1,2})(${allAliasReg()})$`, fnc: 'report' },
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?(${allAliasReg()})(上一期|上期|上一)$`, fnc: 'report' },
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?(${allAliasReg()})(速报|攻略|查询|信息|图)$`, fnc: 'report' },
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?(${allAliasReg()})$`, fnc: 'report' },
      ],
    });
  }

  async report(e) {
    const req = parseMsg(e.msg || '');
    const version = req.version || await currentVersion(req.game);
    if (req.game === 'gs' && req.type === '深境螺旋') {
      try {
        const tower = await loadGsTower({ prev: req.prev, version: req.version });
        if (tower?.rooms?.length) {
          if (tower.tip) await e.reply(tower.tip, true, { recallMsg: 90 });
          const img = await scaleImage(await render('abyss_report/tower_report', {
            ...tower,
            gameName: '原神',
            gameShort: 'GENSHIN IMPACT',
            generatedAt: moment().format('MM-DD HH:mm'),
          }, { e, pct: 1 }), 1.8);
          return e.reply(img);
        }
      } catch (err) {
        logger.warn(`[xhh][abyss_report] tower 数据渲染失败: ${err.message}`);
      }
    }
    if (req.game === 'sr' || req.game === 'zzz') {
      try {
        const loadOpts = { version: req.version, prev: req.prev };
        const nanoka = req.game === 'sr' ? await loadSrNanoka(req.type, loadOpts) : await loadZzzNanoka(req.type, loadOpts);
        const hasData = nanoka && (nanoka.sections?.length || nanoka.nodes?.length || nanoka.items?.length || nanoka.boss);
        if (hasData) {
          if (nanoka.tip) await e.reply(nanoka.tip, true, { recallMsg: 90 });
          const isZzz = req.game === 'zzz';
          const srModes = ['maze', 'story', 'doom', 'peak'];
          const isSrNew = req.game === 'sr' && srModes.includes(nanoka.mode);
          const tpl = isZzz ? 'abyss_report/nanoka_report_zzz' : isSrNew ? 'abyss_report/nanoka_report_sr' : 'abyss_report/nanoka_report';
          const img = await scaleImage(await render(tpl, {
            gameName: isZzz ? '绝区零' : '崩坏：星穹铁道',
            gameShort: isZzz ? 'ZENLESS ZONE ZERO' : 'STAR RAIL',
            title: nanoka.title || req.type,
            id: nanoka.id,
            period: nanoka.period || '',
            mode: nanoka.mode || '',
            nodes: nanoka.nodes || [],
            items: nanoka.items || [],
            sections: nanoka.sections || [],
            intro: nanoka.intro || '',
            goals: nanoka.goals || [],
            groups: nanoka.groups || [],
            boss: nanoka.boss || null,
            generatedAt: moment().format('MM-DD HH:mm'),
          }, { e, pct: 1 }), isZzz ? 1.5 : isSrNew ? 1.5 : 1.65);
          return e.reply(img);
        }
      } catch (err) {
        logger.warn(`[xhh][abyss_report] nanoka ${req.game} 数据渲染失败: ${err.message}`);
      }
    }
    let numbers = imageNumbers(req.game, version, req.type);
    let displayVersion = version;
    let fallbackFrom = '';
    await e.reply(`正在获取${req.game === 'sr' ? '星铁' : '原神'} ${version} ${req.type}速报，请稍后...`, true, { recallMsg: 60 });

    const images = [];
    for (const num of numbers) {
      const img = await downloadImage(req.type, num);
      if (img) images.push({ num, path: img });
    }
    if (!images.length) {
      const fallback = await fallbackImageNumbers(req.game, version, req.type);
      if (fallback?.numbers?.length && fallback.version !== version) {
        numbers = fallback.numbers;
        displayVersion = fallback.version;
        fallbackFrom = version;
        for (const num of numbers) {
          const img = await downloadImage(req.type, num);
          if (img) images.push({ num, path: img });
        }
      }
    }
    const blessing = req.game === 'gs' && req.type === '深境螺旋' && !req.version ? await loadGsBlessing(displayVersion) : null;
    const data = {
      gameName: req.game === 'sr' ? '崩坏：星穹铁道' : '原神',
      gameShort: req.game === 'sr' ? 'STAR RAIL' : 'GENSHIN IMPACT',
      version: displayVersion,
      type: req.type,
      typeClass: TYPE_CLASS[req.type] || 'spiral',
      imageCount: images.length,
      imageNums: images.map(v => v.num).join(' / ') || '暂无',
      blessing,
      source: images.length ? 'Abyss Repo / Nanoka' : 'Nanoka / 小花火',
      generatedAt: moment().format('MM-DD HH:mm'),
    };
    if (!images.length) {
      await render('abyss_report/report', data, { e, pct: 1 });
      return e.reply(`暂无 ${data.gameName} ${version} ${req.type} 速报图片。可以稍后再试，或在锅巴里调整"深渊速报图片仓库"。`);
    }
    if (fallbackFrom) await e.reply(`暂无 ${data.gameName} ${fallbackFrom} ${req.type} 速报图片，已自动回退到仓库最新可用 ${displayVersion} 版本。`);
    const merged = await mergeImages(images, { gameName: data.gameName, version: displayVersion, type: req.type });
    return e.reply(segment.image(`file://${merged}`));
  }
}
