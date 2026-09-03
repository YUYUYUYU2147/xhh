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
  const next = /下一期|下期|下一/i.test(raw);
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
  return { game, version, prev, next, type };
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
  // id >= 20000 为测试服/占位条目，正式服深渊只取 < 20000
  const items = Object.entries(list).map(([id, v]) => ({ id: Number(id), ...v })).filter(v => Number(v.id) < 20000);
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

  if (opts.next) {
    const i = keys.indexOf(curKey);
    const nk = i > 0 ? keys[i - 1] : null;
    if (nk && map[nk]?.length) {
      return { id: map[nk].at(-1), label: `版本 ${nk}（下一期）` };
    }
    return { id: map[curKey].at(-1), label: `当前版本 ${curKey}`, tip: `${reqType} 暂无下一期数据` };
  }

  return { id: map[curKey].at(-1), label: `当前版本 ${curKey}` };
}

// 无版本映射的玩法（虚构叙事 / 末日幻影）：按收录期号序列选择当期、上一期或下一期。
// 依据列表条目是否已命名（zh/en 等字段）判断已发布，跳过预留占位 id（例如末日幻影最新的占位期）。
function pickSeqEntry(detailBase, list, reqType, opts, live = '') {
  const named = Object.entries(list || {})
    .map(([id, v]) => ({
      id: Number(id),
      value: v,
      ok: !!(v && (v.zh || v.en || v.ko || v.ja)),
    }))
    .filter(x => Number.isFinite(x.id) && x.ok)
    .sort((a, b) => {
      const at = Date.parse(a.value?.live_begin || a.value?.begin || '') || 0;
      const bt = Date.parse(b.value?.live_begin || b.value?.begin || '') || 0;
      return bt - at || b.id - a.id;
    });
  if (!named.length) return { tip: `${reqType} 暂无可用期数据` };

  // 有明确起止时间时按当前时间定位，避免把已发布的下一期误判为当期；
  // 无时间字段时沿用 Nanoka 的期号降序，第一条视为最新可查期。
  const now = moment();
  let curIndex = named.findIndex(x => {
    const begin = x.value?.live_begin || x.value?.begin;
    const end = x.value?.live_end || x.value?.end;
    return begin && end && now.isBetween(moment(begin), moment(end), undefined, '[]');
  });
  if (curIndex < 0) curIndex = 0;
  const cur = named[curIndex].id;
  if (opts.prev) {
    const target = named[curIndex + 1];
    if (!target) return { id: cur, label: `当前版本 ${live}`, tip: `${reqType} 已是最早收录的一期，没有更早数据` };
    return { id: target.id, label: `上一期（当前 #${cur} → #${target.id}）` };
  }
  if (opts.next) {
    const target = named[curIndex - 1];
    if (!target) return { id: cur, label: `当前版本 ${live}`, tip: `${reqType} 暂无下一期数据` };
    return { id: target.id, label: `下一期（当前 #${cur} → #${target.id}）` };
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
  const weak = srWeakList(entry?.weak || child?.weak || []);
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

// 星铁七元素图标：Mar-7th/StarRailRes 官方资源（jsDelivr CDN 镜像）
// 雷元素文件名为 Thunder，与 SR_DMG_LABEL 中的 Lightning/Thunder 统一映射
const SR_ELEMENT_ICON = {
  物理: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Physical.png',
  火: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Fire.png',
  冰: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Ice.png',
  雷: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Thunder.png',
  风: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Wind.png',
  量子: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Quantum.png',
  虚数: 'https://cdn.jsdelivr.net/gh/Mar-7th/StarRailRes@master/icon/element/Imaginary.png',
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
    const color = SR_DMG_COLOR[name] || '#ffffff';
    out.push({ name, color, icon: SR_ELEMENT_ICON[name] || '' });
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
        hsrMonsterChildMap[String(cid)] = {
          name,
          icon: entry?.icon || '',
          // Nanoka 的关卡里经常只给 child ID，弱点实际挂在父级怪物上。
          weak: entry?.weak || [],
        };
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
        { label: star ? '上' : '上半', star: !!star, ...srSide(row.event_id_list1, row.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', star: !!star, ...srSide(row.event_id_list2, row.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '下', star: true, ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
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
        { label: star ? '上' : '上半', star: !!star, ...srSide(lv.event_id_list1, lv.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', star: !!star, ...srSide(lv.event_id_list2, lv.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '下', star: true, ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
      }
      // 星启模式：使用星启节点自己的 challenge（分数/挑战条件），否则用主节点
      const goalSource = (star && Array.isArray(star.challenge) && star.challenge.length) ? star.challenge : lv.challenge;
      return {
        title: srCleanText(lv.name || '') || '关卡',
        goals: srChallengeTexts(goalSource),
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
        { label: star ? '上' : '上半', star: !!star, ...srSide(lv.event_id_list1, lv.damage_type1, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
        { label: star ? '中' : '下半', star: !!star, ...srSide(lv.event_id_list2, lv.damage_type2, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) },
      ];
      if (star) {
        sides.push({ label: '下', star: true, ...srSide(star.event_id_list, star.damage_type, hsrMonsterMap, hsrMonsterChildMap, [], srRefs) });
      }
      // 星启模式：使用星启节点自己的 challenge，否则用主节点
      const goalSource = (star && Array.isArray(star.challenge) && star.challenge.length) ? star.challenge : lv.challenge;
      return {
        title: srCleanText(lv.name || '') || (fallback ? `${fallback}·难度 ${idx + 1}` : `难度 ${idx + 1}`),
        goals: srChallengeTexts(goalSource),
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

// ZZZ 六元素官方图标：gachabase.net 官方资源直链（cdn.gachabase.net，无需 token）
const ZZZ_ELEMENT_ICON = {
  物理: 'https://cdn.gachabase.net/zzz/assets/3a1691eb594ebc4a15029e0c52bdbedf.png',
  火: 'https://cdn.gachabase.net/zzz/assets/e110cb79353b1dd78b7b816f152e9e7c.png',
  冰: 'https://cdn.gachabase.net/zzz/assets/ef764d3d8c48a4eb57ce3f39fa013d49.png',
  电: 'https://cdn.gachabase.net/zzz/assets/09a41aa7b7037ff1566289aabf888b3c.png',
  风: 'https://cdn.gachabase.net/zzz/assets/8096776d00b473d1551fb2eacdc9b91a.png',
  以太: 'https://cdn.gachabase.net/zzz/assets/a504a8c66926faa4ac46716adf7f3264.png',
};

function zzzElementIconUrl(name) {
  return ZZZ_ELEMENT_ICON[name] || '';
}

function zzzIconUrl(image = '') {
  const m = String(image).match(/([^\\/]+)\.(?:png|webp|jpg|jpeg)$/i);
  if (!m) return '';
  return `https://static.nanoka.cc/assets/zzz/${m[1]}.webp`;
}

function zzzWeaknessList(weaknessObj = {}) {
  return Object.entries(weaknessObj)
    .map(([code, label]) => {
      const name = String(label).replace(/属性$/, '');
      return {
        code,
        name,
        color: ZZZ_ELEMENT_COLOR[name] || '#ffffff',
        icon: zzzElementIconUrl(name),
      };
    })
    .filter(v => v.name);
}

function zzzMonsterCard(mon = {}) {
  const icon = zzzIconUrl(mon.image);
  const buildElementList = (filterVal) => Object.entries(mon.element || {})
    .filter(([_, v]) => v === filterVal)
    .map(([k]) => {
      const name = ZZZ_ELEMENT_LABEL[k] || k;
      return {
        name,
        code: k,
        color: ZZZ_ELEMENT_COLOR[name] || '#ffffff',
        icon: zzzElementIconUrl(name),
      };
    })
    .filter(v => v.name);
  const elementText = buildElementList(1);
  const resistText = buildElementList(-1);
  const stats = mon.stats || {};
  return {
    name: mon.name || '未知敌人',
    icon,
    elementText,
    resistText,
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
  // 下一期：优先按 live_begin 时间推进；危局等列表的未发布期次没有 live 时间，退回按 id 顺延
  if (opts.next) {
    const allItems = Object.entries(list || {})
      .map(([k, v]) => ({ id: Number(k), ...v }))
      .filter(v => Number.isFinite(v.id))
      .sort((a, b) => a.id - b.id);
    const items = allItems
      .filter(v => v.live_begin && v.live_end)
      .sort((a, b) => Date.parse(a.live_begin) - Date.parse(b.live_begin));
    const now = moment();
    const activeIdx = items.findIndex(v => now.isBetween(moment(v.live_begin), moment(v.live_end), undefined, '[]'));
    const idx = activeIdx >= 0 ? activeIdx : items.length - 1;
    const row = items[idx + 1];
    if (row) {
      id = row.id;
      label = '下一期';
    } else {
      // 危局强袭战等列表的下一期通常还没写入 live_begin/live_end，只有 begin/end 占位时间，按期次 id 顺延
      const curId = items[idx]?.id;
      const pending = curId == null ? null : allItems.find(v => v.id > curId && (v.live_begin || v.begin));
      if (pending) {
        id = pending.id;
        label = '下一期';
      } else if (items[idx]) {
        id = items[idx].id;
        tip = `${reqType} 暂无下一期数据`;
      }
    }
  }
  // 版本索引仅在显式请求版本号 / 上一期时使用；默认当期沿用列表 live 状态判定，避免误选未发布占位数据
  if (!id && map && (opts.version || opts.prev)) {
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

    const collectBuffs = (obj) => Object.values(obj || {})
      .map(v => ({ title: stripHtml(v.title || ''), desc: stripHtml(v.desc || '') }))
      .filter(v => v.title || v.desc);

    const buildRoom = (zone) => {
      return Object.values(zone.layer_room || {}).map((room, ridx) => {
        const monsters = Object.values(room.monster_list || {}).map(v => zzzMonsterCard(v));
        const weakness = zzzWeaknessList(room.monster_weakness);
        return {
          title: `房间 ${ridx + 1}`,
          meta: `Lv.${zone.monster_level || ''} · ${room.waves_num || 1} Wave`,
          weakness,
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
      rooms = rooms.map((room, idx) => ({ ...room, title: `房间 ${idx + 1}` }));
      return {
        title: zone.name || `节点 ${zone.stage_num || ''}`,
        meta: `Lv.${zone.monster_level || ''}`,
        buffs: collectBuffs(zone.layer_buff),
        selectable: collectBuffs(zone.selectable_buff),
        rooms,
      };
    }).filter(Boolean);

    logger.info(`[xhh][abyss_report] 式舆防卫战 ${id} 节点数=${nodes.length} buffs=${nodes.map(n => (n.buffs || []).length).join('/')}`);
    return { version: nv, id, title: '式舆防卫战', period, tip, gameKey: 'zzz', mode: 'shiyu', nodes };
  }

  if (reqType === '危局强袭战') {
    const modes = Array.isArray(detail?.modes) ? detail.modes : [];
    const collectBuffs = (obj) => Object.values(obj || {})
      .map(v => ({ title: stripHtml(v.title || ''), desc: stripHtml(v.desc || '') }))
      .filter(v => v.title || v.desc);
    const modeLabel = (t) => t === 1002 ? '困难' : t === 1001 ? '普通' : '';
    const items = [];
    let seq = 0;
    for (const mode of modes) {
      const modeName = modeLabel(mode.zone_type);
      for (const zone of Object.values(mode.zone || {})) {
        const room = Object.values(zone.layer_room || {})[0] || {};
        const monster = Object.values(room.monster_list || {})[0] || {};
        const boss = zzzMonsterCard(monster);
        const weakness = zzzWeaknessList(room.monster_weakness);
        // 自身元素和弱点重复时不再重复展示（如基塔布鲁自身风/弱点风）
        if (weakness.length && boss.elementText?.length) {
          const weakNames = new Set(weakness.map(w => w.name));
          boss.elementText = boss.elementText.filter(el => !weakNames.has(el.name));
        }
        const buffs = collectBuffs(zone.layer_buff);
        const selectable = collectBuffs(zone.selectable_buff);
        items.push({
          title: (modeName ? `[${modeName}] ` : '') + (zone.name || `节点 ${seq + 1}`),
          meta: `Lv.${zone.monster_level || ''}`,
          rankGoals: `S ${formatNum(zone.s_rank_goal)} · A ${formatNum(zone.a_rank_goal)} · B ${formatNum(zone.b_rank_goal)}`,
          boss,
          weakness,
          buffs,
          selectable,
        });
        seq += 1;
      }
    }
    return { version: nv, id, title: '危局强袭战', period, tip, gameKey: 'zzz', mode: 'boss', items };
  }

  return null;
}

const DEFAULT_LEYLINE_ICON = 'data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"%23fbbf24\"%3E%3Cpath d=\"M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z\"/%3E%3C/svg%3E';

async function loadGsTower(opts = {}) {
  const manifest = await fetchJson(MANIFEST_URL, 6000);
  const nv = manifest?.gi?.latest || '7.0.53';
  const live = String(manifest?.gi?.live || '');
  const list = await fetchJson(`https://static.nanoka.cc/gi/${nv}/tower.json`, 8000);
  const rows = Object.entries(list || {})
    .map(([id, v]) => ({ id: Number(id), ...v }))
    // 20000 以上是数据库预留/测试条目，不能参与上一期、下一期计算。
    .filter(v => Number.isFinite(v.id) && v.id < 20000 && (v.begin || v.live_begin || v.zh || v.en))
    .sort((a, b) => {
      const at = Date.parse(a.live_begin || a.begin || '') || 0;
      const bt = Date.parse(b.live_begin || b.begin || '') || 0;
      return at - bt || a.id - b.id;
    });
  let active = pickCurrentTower(list);
  let tip = '';
  // 指定版本：优先用正式服 ID 映射定位对应版本数据（如 7.1 -> ID 123）
  if (opts.version) {
    const reqId = gsTowerVersionToId(opts.version);
    const target = reqId != null ? rows.find(v => v.id === reqId) : null;
    if (target) {
      active = target;
    } else {
      tip = `暂无 ${opts.version} 版本数据，已显示数据库最新 ${live || opts.version} 版本`;
    }
  }
  if (opts.prev && active) {
    const idx = rows.findIndex(v => v.id === active.id);
    const prevRow = idx > 0 ? rows[idx - 1] : null;
    if (prevRow) active = prevRow;
    else tip = tip || '这已是收录范围内最早的一期深境螺旋';
  }
  if (opts.next && active) {
    const idx = rows.findIndex(v => v.id === active.id);
    const nextRow = idx >= 0 ? rows[idx + 1] : null;
    if (nextRow) active = nextRow;
    else tip = tip || '原神深境螺旋暂无下一期数据';
  }
  if (!active?.id) return null;
  const data = await fetchJson(`https://static.nanoka.cc/gi/${nv}/zh/tower/${active.id}.json`, 8000);
  const floor = data?.floor?.['12'];
  if (!floor) return null;
  const rooms = Object.entries(floor.room || {}).map(([idx, room]) => buildTowerRoom(room, idx)).sort((a, b) => Number(a.idx) - Number(b.idx));
  const hpMatch = (floor.buff || []).join(' ').match(/怪物血量提升(\d+)%/);
  const hpPct = hpMatch ? Number(hpMatch[1]) + 100 : '';
  const versionLabel = opts.version || gsTowerIdToVersion(active.id) || live || '';
  // begin/end 为占位（跨度不足 2 天）时，period 置空，仅用版本号展示
  const begin = active.live_begin || active.begin || '';
  const end = active.live_end || active.end || '';
  const spanDays = (Date.parse(end) - Date.parse(begin)) / 86400000;
  const period = (begin && end && spanDays >= 2) ? `${begin} ~ ${end}` : '';
  return {
    version: nv,
    id: active.id,
    versionLabel,
    period,
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

// 原神深境螺旋/幻想真境剧诗 正式服 ID ↔ 版本号 映射（参考 https://gi.nanoka.cc/tower/）
// 6.x 起始 ID 118（对应 6.4），7.x 起始 ID 122（对应 7.0）；6.7 之后没有 6.8/6.9，直接跳到 7.0
const GS_TOWER_VER_ID = {
  '6.4': 118, '6.5': 119, '6.6': 120, '6.7': 121,
  '7.0': 122, '7.1': 123,
};
const GS_TOWER_ID_VER = Object.fromEntries(Object.entries(GS_TOWER_VER_ID).map(([k, v]) => [v, k]));
const GS_TOWER_MIN_ID = Math.min(...Object.values(GS_TOWER_VER_ID));

function gsTowerVersionToId(version) {
  return GS_TOWER_VER_ID[String(version)] ?? null;
}

function gsTowerIdToVersion(id) {
  return GS_TOWER_ID_VER[id] ?? null;
}

// ID+1=下一版本，ID-1=上一版本（6.7→7.0 直跳，无 6.8/6.9）
function gsTowerOffsetVersion(version, offset) {
  const id = gsTowerVersionToId(version);
  if (id == null) return null;
  return gsTowerIdToVersion(id + offset);
}

async function listRepoImageNumbers(type) {
  const key = `${type}:${repoList().join('|')}`;
  if (repoImageCache.has(key)) return repoImageCache.get(key);
  const set = new Set();
  // 同时匹配 X.Y 格式（6.7, 6.7A）和纯 ID 格式（121, 123A）
  const re = /\b(?:([1-9]\d*\.\d{1,2}[A-Za-z]?)|([1-9]\d{2,3}[A-Z]?))\.png\b/g;
  for (const repo of repoList()) {
    const url = rawRepoToTreeUrl(repo, type);
    try {
      const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 xhh' } }).then(r => r.text());
      for (const match of html.matchAll(re)) {
        set.add(match[1] || match[2]);
      }
    } catch (err) {
      logger.warn(`[xhh][abyss_report] 仓库目录读取失败 ${url}: ${err.message}`);
    }
  }
  // 排序：先按"是否为 ID 命名"分组（ID 靠后），组内按 versionBase / ID 数值降序
  const list = [...set].sort((a, b) => {
    const aIsVer = String(a).includes('.');
    const bIsVer = String(b).includes('.');
    if (aIsVer !== bIsVer) return aIsVer ? -1 : 1;
    if (aIsVer) {
      const diff = versionBase(b) - versionBase(a);
      return diff !== 0 ? diff : String(a).localeCompare(String(b));
    }
    return Number(b) - Number(a) || String(a).localeCompare(String(b));
  });
  repoImageCache.set(key, list);
  return list;
}

async function fallbackImageNumbers(game, version, type) {
  if (game !== 'gs') return null;
  const list = await listRepoImageNumbers(type);
  if (!list.length) return null;

  // 优先按正式服 ID 递减找（处理 6.7→7.0 直跳，无 6.8/6.9）
  const reqId = gsTowerVersionToId(version);
  if (reqId != null) {
    for (let id = reqId; id >= GS_TOWER_MIN_ID; id--) {
      const ver = gsTowerIdToVersion(id);
      if (!ver) continue;
      // 收集所有匹配的文件名：版本号命名（6.7, 6.7A, 6.7B）和 ID 命名（121, 121A）
      const nums = list.filter(num => {
        if (String(num).match(/^([1-9]\d*\.\d{1,2})/)?.[1] === ver) return true;
        if (String(num) === String(id)) return true;
        return false;
      });
      if (nums.length) return { version: ver, numbers: nums };
    }
  }

  // 兜底：旧逻辑（按 versionBase 找 ≤ 请求版本的最大），处理未收录的新大版本
  const reqBase = versionBase(version);
  if (reqBase < 0) return null;
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
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?(上一期|上期|上一|下一期|下期|下一)(${allAliasReg()})$`, fnc: 'report' },
        { reg: `^#*xhh(原神|星铁|星穹|崩铁|绝区零|ZZZ)?(${allAliasReg()})(上一期|上期|上一|下一期|下期|下一)$`, fnc: 'report' },
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
        const tower = await loadGsTower({ prev: req.prev, next: req.next, version: req.version });
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
        return e.reply(`暂无 原神 ${version} 深境螺旋数据，已回退到数据库仍无可用数据，请稍后再试。`, true, { recallMsg: 60 });
      } catch (err) {
        logger.warn(`[xhh][abyss_report] tower 数据渲染失败: ${err.message}`);
        return e.reply(`原神深境螺旋数据获取失败，请稍后再试。`, true, { recallMsg: 60 });
      }
    }
    if (req.game === 'sr' || req.game === 'zzz') {
      try {
        const loadOpts = { version: req.version, prev: req.prev, next: req.next };
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
