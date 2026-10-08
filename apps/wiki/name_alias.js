/**
 * 图鉴别名统一解析（全游戏、全类型共用，不按游戏分支）。
 *
 * 背景：以前每个分支各自读各自的别名表 —— 武器读 wqname.yaml、角色读
 * miaoResolve()、绝区零读 zzz_js_names.yaml、遗器读 yiqi.yaml……
 * 表一多就必然出两种事故：
 *   ① 分派顺序是 角色 → 武器 → 遗器，别名命中晚的那张表就被前面的分支抢走
 *      （实测「快枪手」是星铁遗器，被武器分支先吃掉，出了张武器卡）
 *   ② 新表/新条目忘了在某条路径上接上（华饰类遗器就不在任何表里）
 * 所以这里把所有表**一次性摊平成一张 别名 → 正式名+类型 的索引**，
 * 分派之前先查这张表，命中就直接走对应类型的渲染。
 *
 * 数据源（全部只读本地文件，不发请求；被限流/缺文件都不影响）：
 *   system/default/*_names.yaml、wqname.yaml、syw.yaml、yiqi.yaml   官方/本地别名表
 *   miao-plugin resources/meta{,-sr}/{character,weapon,lightcone,artifact}/data.json
 *   ZZZ-Plugin config/alias.yaml、defSet/alias.yaml                   绝区零代理人别名
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 路径不按 cwd 拼：cwd 是 TRSS-Yunzai 根目录，但单测/脚本可能从别处跑。
   一律按本文件位置定位插件根（apps/wiki/ → ../../）。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');   // TRSS-Yunzai 根
/** './plugins/xhh/…' 与 './plugins/…' 两种写法都要能定位到绝对路径 */
const p = rel => {
  const v = String(rel || '');
  if (v.startsWith('./plugins/xhh/')) return path.join(PLUGIN_ROOT, v.slice('./plugins/xhh/'.length));
  // ⚠ 只剥掉 './'：REPO_ROOT 已经是 TRSS-Yunzai 根，
  //   再 slice('./plugins/'.length) 会把 plugins/ 目录名也吃掉，
  //   路径就落到 /root/TRSS_AllBot/TRSS-Yunzai/miao-plugin/…（不存在，静默 0 条）
  if (v.startsWith('./plugins/')) return path.join(REPO_ROOT, v.slice(2));
  return v;
};

/** 本地别名表：正式名 → [别名…] */
const YAML_SOURCES = [
  { file: './plugins/xhh/system/default/gs_js_names.yaml', game: 'gs', type: 'js' },
  { file: './plugins/xhh/system/default/sr_js_names.yaml', game: 'sr', type: 'js' },
  { file: './plugins/xhh/system/default/zzz_js_names.yaml', game: 'zzz', type: 'js' },
  { file: './plugins/xhh/system/default/bh3_js_names.yaml', game: 'bh3', type: 'js' },
  { file: './plugins/xhh/system/default/wqname.yaml', game: 'gs', type: 'wq' },
  { file: './plugins/xhh/system/default/gz_names.yaml', game: 'sr', type: 'gz' },
  { file: './plugins/xhh/system/default/syw.yaml', game: 'gs', type: 'syw' },
  { file: './plugins/xhh/system/default/yiqi.yaml', game: 'sr', type: 'yq' },
  { file: './plugins/xhh/system/default/zzz_wq_names.yaml', game: 'zzz', type: 'wq' },
  { file: './plugins/xhh/system/default/zzz_syw_names.yaml', game: 'zzz', type: 'syw' },
  { file: './plugins/xhh/system/default/zzz_yq_names.yaml', game: 'zzz', type: 'yq' },
  { file: './plugins/xhh/system/default/bh3_wq_names.yaml', game: 'bh3', type: 'wq' },
  { file: './plugins/xhh/system/default/bh3_syw_names.yaml', game: 'bh3', type: 'syw' },
  { file: './plugins/xhh/system/default/bh3_yq_names.yaml', game: 'bh3', type: 'yq' },
  { file: './plugins/xhh/system/default/bh3_boss_names.yaml', game: 'bh3', type: 'boss' }
];

/* 喵喵插件的别名/数据源：**自动发现**，不写死文件清单。
   它的目录结构随版本变（meta → meta-gs、lightcone → weapon/weapon/「名字」…），
   写死清单的结果就是每更新一次漏一批（实测 meta/artifact、meta/weapon 根本不存在）。
   现在扫 meta-gs / meta-sr 下的 alias.js 与 data.json，按所在目录推断类型：
     artifact → syw(原神) / yq(星铁)；character → js；weapon → wq / gz
   只读本地文件，不发请求；扫不到就当没有，不影响其它来源。 */
const MIAO_ROOTS = [
  { dir: './plugins/miao-plugin/resources/meta-gs', game: 'gs' },
  { dir: './plugins/miao-plugin/resources/meta-sr', game: 'sr' }
];

function inferMiaoType(relPath, game) {
  if (/artifact|arti/i.test(relPath)) return game === 'sr' ? 'yq' : 'syw';
  if (/weapon|lightcone/i.test(relPath)) return game === 'sr' ? 'gz' : 'wq';
  if (/character/i.test(relPath)) return 'js';
  return '';
}

/** 扫目录（深度有限，避开 imgs/ 这类大目录） */
function walkFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries = null;
  try { entries = fs.readdirSync(p(dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'imgs' || e.name === 'node_modules') continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) walkFiles(full, depth + 1, out);
    else if (/^(alias\.js|data\.json)$/.test(e.name)) out.push(full);
  }
  return out;
}

/* alias.js 形状：`export const alias = { "正式名": "别名1,别名2", ... }`。
   键**不一定带引号**（喵喵写的是 `炽烈的炎之魔女: "魔女"`），所以引号可选。
   直接用正则抠出所有 键: 值 对，不 eval、不引第三方解析器。 */
function parseMiaoAliasJs(raw) {
  const out = {};
  const re = /["']?([^"'{}:,]+)["']?\s*:\s*(?:\[([^\]]*)\]|["']([^"']*)["'])/g;
  let m;
  while ((m = re.exec(raw))) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? '';
    const list = (m[2] ? val.split(',') : String(val).split(','))
      .map(x => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (!key || !list.length) continue;
    out[key] = out[key] ? [].concat(out[key], list) : list;
  }
  return out;
}

/** ZZZ-Plugin 的代理人别名（本地表优先，默认表兜底） */
const ZZZ_ALIAS_FILES = [
  './plugins/ZZZ-Plugin/config/alias.yaml',
  './plugins/ZZZ-Plugin/defSet/alias.yaml'
];

/* 纯关键词查询不做别名解析：这些词本身就是类别名（命令路由要靠它们判断
   「这是要列武器列表」），拿去查别名索引会命中一堆含该词的角色/装备名
   （实测「武器」→ 位面武器·失序时空、「角色」→ …）。 */
const GENERIC_KEYWORDS = new Set([
  '角色', '武器', '光锥', '遗器', '音擎', '驱动盘', '圣遗物', '圣痕', '邦布', '人偶', '协同者',
  '图鉴', '列表', '一览', '测试', '全部', '所有', '五星', '四星', '三星', '二星', '角色列表',
  '武器列表', '光锥列表', '遗器列表', '驱动盘列表', '音擎列表', '圣遗物列表', '圣痕列表', '邦布列表'
]);

/** 归一化：去空格与常见标点，转小写。两边都要归一化后再比 */
export function normalizeAliasKey(v) {
  return String(v || '')
    .replace(/[\s·・\-—_「」『』《》【】\[\]()~]/g, '')
    .toLowerCase();
}

/* yaml 读取器：由 wiki.js 注入 bot 自带的 yaml.get（能正确处理行内数组、
   空 key 块、单行多别名这些写法）。没注入时退回下面的简易解析器，
   这样本模块单独跑（单测/脚本）也能用。*/
let _yamlGet = null;
export function setYamlGetter(fn) {
  if (typeof fn === 'function') _yamlGet = fn;
}

function readYaml(file) {
  if (_yamlGet) {
    try {
      const v = _yamlGet(file);
      if (v && typeof v === 'object') return v;
    } catch { /* 文件不存在/解析失败，走简易解析 */ }
  }
  return readYamlSimple(file);
}

/** 简易 yaml 解析：只支持「正式名: 别名」与「正式名:」+「  - 别名」两种形状 */
function readYamlSimple(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // 本项目的 yaml 都是简单结构，用正则解析比引第三方解析器更省事也更稳
    const out = {};
    let cur = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      /* 列表项要先判：「  - 魔法少女套」这行**没有冒号**，
           之前按「必须匹配 key: value」过滤，全表所有别名都被丢掉了
           （实测 yiqi.yaml 64 条里一条没进索引）。 */
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item) {
        if (cur) out[cur].push(unquote(item[1]));
        continue;
      }
      const kv = line.match(/^([^:：]+)[:：]\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (!val) { cur = key; out[cur] = []; continue; }   // 「正式名:」换行后跟列表
      // 行内数组：["a", "b"]
      const arr = val.match(/^\[(.*)\]$/);
      if (arr) {
        out[key] = arr[1].split(',').map(x => unquote(x.trim())).filter(Boolean);
        cur = key;
        continue;
      }
      if (val === '[]' || val === '空') { out[key] = []; cur = key; continue; }
      out[key] = [unquote(val)];
      cur = key;
    }
    return out;
  } catch {
    return null;
  }
}
const unquote = v => String(v || '').replace(/^["']|["']$/g, '').trim();

/* ── 索引 ───────────────────────────────────────────── */
let _index = null;

/* 别名质量闸门：数据表里混着 desc/usage 这类**长文本 HTML 字段**，
   直接当别名收进去就是灾难（实测「开拓者」命中了一条 desc 的整段 HTML）。
   别名必须是短的人写的词：≤24 字、不含标签与换行。 */
const MAX_ALIAS_LEN = 24;
function validAlias(v) {
  const s = String(v || '').trim();
  if (!s || s.length > MAX_ALIAS_LEN) return false;
  if (/[<>\n\r]/.test(s)) return false;
  if (/^(desc|info|usage|text|note|story|skill|lore)$/i.test(s)) return false;
  return true;
}

/* 单字别名（「鲨」「鱼」这类）只允许**完全相等**命中：
   收录进主索引会让「鱼」这种查询在模糊匹配里扫到一堆不相干的条目。
   所以单字单独放一张表，只在 exact 分支查。 */
const _single = new Map();

function add(map, alias, entry) {
  if (!validAlias(alias)) return;
  const k = normalizeAliasKey(alias);
  if (!k) return;
  if (k.length === 1) {
    if (!_single.has(k)) _single.set(k, entry);
    return;
  }
  if (!map.has(k)) map.set(k, entry);
}

function buildIndex() {
  const map = new Map();
  const addTable = (table, game, type) => {
    for (const [formal, aliases] of Object.entries(table || {})) {
      const list = Array.isArray(aliases) ? aliases : [aliases];
      const entry = { name: formal, game, type, src: 'yaml' };
      add(map, formal, entry);
      for (const a of list) add(map, a, entry);
      // 「XX套」这类后缀别名由表里自己登记（「乐园套」），这里再兜一层
      // 去掉尾部「套/ weapon」这类字后的写法
      const bare = formal.replace(/(套|之套|圣痕|遗器)$/, '');
      if (bare !== formal) add(map, bare, entry);
    }
  };
  for (const { file, game, type } of YAML_SOURCES) {
    const t = readYaml(p(file));
    if (t) addTable(t, game, type);
  }
  /* 喵喵：alias.js 与 data.json 都收。
     alias.js 里有 setAbbr/artiAbbr 这类「简称→正式名」表（绝缘→绝缘之旗印、
     风套→翠绿之影），data.json 里有套装名、散件名、角色/武器名。 */
  for (const { dir, game } of MIAO_ROOTS) {
    for (const file of walkFiles(dir)) {
      const type = inferMiaoType(file, game);
      if (!type) continue;
      let raw = null;
      try { raw = fs.readFileSync(p(file), 'utf8'); } catch { continue; }
      if (file.endsWith('alias.js')) {
        for (const [k, v] of Object.entries(parseMiaoAliasJs(raw))) {
          for (const a of [].concat(v)) add(map, a, { name: k, game, type, src: 'miao' });
          add(map, k, { name: k, game, type, src: 'miao' });
        }
        continue;
      }
      let json = null;
      try { json = JSON.parse(raw); } catch { continue; }
      /* 遗器/圣遗物有两种数据文件：
           meta-sr/artifact/data.json                → 套装条目（带 idxs）
           meta-sr/artifact/<套装名>/<部件名>/data.json → 单件条目（不带 idxs）
         单件文件的 name 就是部件名，直接当正式名会让「快枪手的野穗毡帽」
         解析成它自己（查出来还是一张遗器卡，但名字是部件名）。
         所以带 id 的单件条目一律归到**父目录的套装名**。 */
      const segs = file.split('/');
      const artIdx = segs.findIndex(x => /artifact|arti/i.test(x));
      const isArtifact = type === 'syw' || type === 'yq';
      /* 单件文件的目录有三种深度：
           artifact/<套装>/<部件>/data.json  → 套装 = 第 1 段
           artifact/<部件>/data.json          → 套装要从条目本身反推，拿不到就跳过归组
         所以这里把「紧邻 artifact 的下一段」一律当套装候选，
         条目名与它不一致又没带 idxs 的，就认为这是单件条目。 */
      const parentSet = isArtifact && artIdx >= 0 && segs.length > artIdx + 2 ? segs[artIdx + 1] : '';
      const addEntry = formal => {
        if (!formal) return;
        const setName = (type === 'syw' || type === 'yq') && parentSet && formal !== parentSet ? parentSet : formal;
        add(map, formal, { name: setName, game, type, src: 'miao' });
      };
      // data.json 可能是 { id: {name…} } 或 { name: [别名] } 两种形状，都收
      for (const [k, v] of Object.entries(json || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          /* 遗器/圣遗物：喵喵把**套装和散件都当独立条目**列在同一个 data.json 里
             （「野穗伴行的快枪手」带 idxs，是套装；「快枪手的野穗毡帽」不带，是散件）。
             以前一律当正式名收录，于是「快枪手的野穗毡帽」解析成它自己。
             现在：名字带 idxs 的是套装；不带 idxs 的，若「XX的YY」里的 XX 是已知套装名，
             就判成散件并归到那个套装。单件目录文件（parentSet）同理。 */
          if (isArtifact && v.name) {
            const nm = String(v.name);
            const owner = parentSet || nm;
            add(map, nm, { name: owner, game, type, src: 'miao' });
            // 散件：登记归属，alias.js 那边把散件名当键，靠这张表在收尾时改回来
            for (const piece of Object.values(v.idxs || {})) {
              if (!piece?.name) continue;
              PIECE_OWNER.set(String(piece.name), owner);
              add(map, piece.name, { name: owner, game, type, src: 'miao' });
              const bare = String(piece.name).replace(/^.*?的/, '');
              if (bare && bare !== piece.name) add(map, bare, { name: owner, game, type, src: 'miao' });
            }
            continue;
          }
          addEntry(v.name || '');
          for (const piece of Object.values(v.idxs || {})) {
            if (!piece?.name) continue;
            if (v.name) PIECE_OWNER.set(String(piece.name), String(v.name));
            add(map, piece.name, { name: v.name || piece.name, game, type, src: 'miao' });
            // 散件名去掉「XX的」前缀（快枪手的野穗毡帽 → 野穗毡帽）
            const short = piece.name.replace(/^.*?的/, '');
            if (short && short !== piece.name) add(map, short, { name: v.name || piece.name, game, type, src: 'miao' });
          }
          for (const ak of ['alias', 'aliases', 'c_name']) {
            for (const a of [].concat(v[ak] || [])) if (typeof a === 'string') add(map, a, { name: v.name || '', game, type, src: 'miao' });
          }
        } else if (Array.isArray(v) && validAlias(k)) {
          // { 正式名: [别名…] }
          for (const a of v) add(map, a, { name: k, game, type, src: 'miao' });
          add(map, k, { name: k, game, type, src: 'miao' });
        } else if (typeof v === 'string' && validAlias(v)) {
          add(map, v, { name: k, game, type, src: 'miao' });
        }
      }
    }
  }
  for (const file of ZZZ_ALIAS_FILES) {
    const t = readYaml(p(file));
    if (t) addTable(t, 'zzz', 'js');
  }
  /* 收尾修正：喵喵的遗器 alias.js 把**散件名当键**（「快枪手的野穗毡帽」: "快枪手的毡帽"），
     散件就被登记成了正式名。而散件名和套装名并没有字面前缀关系
     （散件「快枪手的野穗毡帽」属于套装「野穗伴行的快枪手」），靠切「的」前缀是猜不出来的。
     所以扫 data.json 时把 idxs 里的「散件名 → 套装名」记下来，这里按事实归组。 */
  for (const [alias, e] of map) {
    if (e.type !== 'syw' && e.type !== 'yq') continue;
    const owner = PIECE_OWNER.get(e.name);
    if (owner && owner !== e.name) map.set(alias, { ...e, name: owner });
  }
  return map;
}

/* 散件名 → 套装名。模块级，因为 alias.js 与 data.json 分属不同文件、
   只有先扫完 data.json 才知道归属，最后统一改写。 */
const PIECE_OWNER = new Map();

export function aliasIndex() {
  if (!_index) _index = buildIndex();
  return _index;
}

/** 只查不落盘重建（改了 yaml 想立刻生效时用） */
export function resetAliasIndex() {
  _index = null;
}

/**
 * 解析查询名 → { name, game, type }，查不到返回 null。
 *
 * 规则（全类型同一套）：
 *   ① 归一化后完全相等
 *   ② 别名包含查询名，且查询名 ≥2 字（「快枪手套」查「快枪手」能命中，
 *      单字查询会命中一大堆不相干的条目，必须挡住）
 * ③ 查询名包含别名（反向覆盖，用户打了全名只少打一个字的情况）
 */
export function resolveWikiAlias(raw) {
  const key = normalizeAliasKey(raw);
  if (!key) return null;
  // 类别关键词交给命令路由，别当别名查
  if (GENERIC_KEYWORDS.has(key)) return null;
  const map = aliasIndex();
  const exact = map.get(key) || _single.get(key);
  if (exact) return { ...exact, matched: raw, how: 'exact' };
  /* 「XX专武」「XX专属音擎」这类查询：角色名和武器名都会命中同一段文字
     （实测「薇斯纳专武」既能匹配到角色「薇斯纳」，也能匹配到武器「蝶变」）。
     带装备类后缀的查询一律优先装备类型 —— 这是按**查询意图**挑类型，
     不是按游戏开特例。 */
  const wantEquip = /专武|专属|专精|音擎|驱动盘|光锥|遗器|圣遗物|圣痕/.test(String(raw));
  if (key.length >= 2) {
    let fallback = null;
    for (const [alias, entry] of map) {
      if (alias.length < 3 || !alias.includes(key)) continue;
      const isEquip = entry.type === 'wq' || entry.type === 'gz' || entry.type === 'syw' || entry.type === 'yq';
      if (wantEquip && isEquip) return { ...entry, matched: alias, how: 'alias-contains' };
      if (!fallback || (isEquip && !wantEquip)) fallback = { ...entry, matched: alias, how: 'alias-contains' };
    }
    if (fallback) return fallback;
    for (const [alias, entry] of map) {
      if (alias.length >= 2 && key.includes(alias)) return { ...entry, matched: alias, how: 'query-contains' };
    }
  }
  return null;
}