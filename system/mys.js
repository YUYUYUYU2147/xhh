import fetch from 'node-fetch';
import fs from 'fs';
import {
    yaml
} from '#xhh';
import YAML from 'yaml';

const ZZZ_NANOKA_VERSION = '3.3.3+19110104';
const ZZZ_NANOKA_BASE = `https://static.nanoka.cc/zzz/${ZZZ_NANOKA_VERSION}`;
// 新版 nanoka 列表 icon：角色/武器为 key（如 IconRole01 / Weapon_B_Common_01），驱动盘/邦布为资源路径。
// key 形态拼接 assets webp 得到可访问图片；已有 http 或含 / 的资源路径原样透传。
const nanokaIcon = key => {
    if (!key) return '';
    if (/^https?:/i.test(key) || key.includes('/')) return key;
    // 角色立绘 IconRole01 是竖版大立绘（1267×1715），列表格子会严重变形；
    // 圆形头像 IconRoleCircle01 又会裁掉头部。改用绳网卡方形头像
    // IconInterKnotRole0001（199×199，头部完整），序号补零到 4 位
    if (/^IconRole\d/.test(key)) {
        key = key.replace(/^IconRole(\d+)/, (m, n) => 'IconInterKnotRole' + n.padStart(4, '0'));
    }
    return `https://static.nanoka.cc/assets/zzz/${key}.webp`;
};
// 米游社图床缩略图：列表渲染几百张图时，把原图压成 100w webp（约 110KB -> 3KB），
// 否则 puppeteer 全量下载几十 MB 原图会渲染 2 分钟并触发框架 Chromium 超时重启
const thumbIcon = url => {
    if (!url || typeof url !== 'string') return url;
    if (url.includes('x-oss-process')) return url; // 已是缩略图
    if (/act-upload\.mihoyo\.com|act-webstatic\.mihoyo\.com/.test(url)) {
        return `${url}?x-oss-process=image/resize,w_100/format,webp`;
    }
    return url;
};
// nanoka 数据源故障冷却：一旦请求失败，1 小时内所有绝区零查询直接走米游社官方 Wiki，
// 不再反复请求已失效的 nanoka（每次白打 4+ 个 404、多耗 1~2 秒并刷 ERRO）
const NANOKA_RETRY_MS = 60 * 60 * 1000;
let nanokaDownUntil = 0;
const nanokaDown = () => Date.now() < nanokaDownUntil;
const markNanokaDown = () => { nanokaDownUntil = Date.now() + NANOKA_RETRY_MS; };

/**
 * 判断错误是否为「网络/接口类」失败。
 *
 * markNanokaDown 的冷却是 1 小时且为全局：一旦触发，期间所有原神/星铁图鉴
 * 都会跳过 nanoka、退回米游社官方 Wiki，渲染成旧模板（只有材料那版）。
 * 因此只有真正的网络/接口失败才允许触发它。
 *
 * 起因：一次 ReferenceError（批量编辑时误删了 SR_STANDARD_LC 的定义）
 * 走进 catch 后触发 markNanokaDown，把一个语法级 bug 放大成 1 小时全局故障，
 * 而且被 fallback 伪装成「wiki 无此角色条目」，未上线角色（官方源没有）
 * 随之整批消失，现场完全看不出是代码问题。
 *
 * 代码 bug（ReferenceError / TypeError / SyntaxError / RangeError）不在此列，
 * 应当直接抛出，让错误暴露在日志里。
 */
const isTransientNetError = err => {
    if (!err) return false;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    const code = err.code || err.errno || '';
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(code))) return true;
    const msg = String(err.message || '');
    return /fetch failed|network|ECONN|ETIMEDOUT|socket hang up|非 JSON|返回非 JSON|HTTP\s*5\d\d|timed?\s*out/i.test(msg);
};

const ZZZ_ITEM_ICON_CACHE = './plugins/xhh/temp/zzz_item_icons';
const localFileUrl = file => `file://${process.cwd()}/${String(file).replace(/^\.\//, '')}`;
// 邦布本地补图目录：resources/xhh/wiki/zzz_bangboo/<邦布名>.png|webp|jpg
// 剧情邦布（如伊埃斯）不在 nanoka/官方观测枢/bwiki 任何图鉴里，上游永远拿不到图标；
// 用户往该目录放一张同名图片即可修复，对以后其它缺图邦布同样通用。
const ZZZ_BANGBOO_ICON_DIR = './plugins/xhh/resources/wiki/zzz_bangboo';
const localBangbooIcon = name => {
    const clean = String(name || '').replace(/[「」『』·\s]/g, '');
    if (!clean) return '';
    try {
        if (!fs.existsSync(ZZZ_BANGBOO_ICON_DIR)) return '';
        for (const f of fs.readdirSync(ZZZ_BANGBOO_ICON_DIR)) {
            const m = f.match(/^(.+)\.(png|webp|jpe?g)$/i);
            if (m && m[1].replace(/[「」『』·\s]/g, '') === clean) {
                return localFileUrl(`${ZZZ_BANGBOO_ICON_DIR}/${f}`);
            }
        }
    } catch (_) {}
    return '';
};
const ZZZ_WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/zzz_wiki';
const ZZZ_WIKI_APP_SN = 'zzz_wiki';
const ZZZ_WIKI_CHANNEL_MAP = {
    js: 43,   // 代理人
    yq: 44,   // 邦布
    wq: 45,   // 音擎
    syw: 46   // 驱动盘
};

/* ---------------------------------------------------------------------------
 * 原神 / 星铁 改用 nanoka.cc（与绝区零同一套模式：每个游戏一个站，
 * 数据 static.nanoka.cc/{gi|hsr}/{版本}/，资源 static.nanoka.cc/assets/{gi|hsr}/）
 *
 * 为什么不直接用米游社官方 blackboard：那份列表是 5.8MB(原神) / 1.9MB(星铁)，
 * 渲染几百个格子时会把 Chromium 拖到超时重启；nanoka 对应文件只有 64KB / 53KB。
 *
 * ⚠ 两边的 id 体系完全不同，而且会撞号（nanoka 1214=雪衣，米游社 1214=刃；
 * 星铁 99 个角色 id 交集只有 1 个，172 个光锥 id 交集为 0），
 * 所以列表与详情必须同源，不能拿 nanoka 的 id 去请求米游社。
 * -------------------------------------------------------------------------- */
const NANOKA_ASSET = 'https://static.nanoka.cc/assets';
// 版本号从 manifest 动态取，nanoka 与米游社用的是同一份 manifest
let NANOKA_VER_CACHE = {};
const getNanokaVer = async game => {
    if (NANOKA_VER_CACHE[game]) return NANOKA_VER_CACHE[game];
    let v = '';
    try {
        const m = await (await fetch('https://static.nanoka.cc/manifest.json')).json();
        v = String(m?.[game]?.latest || m?.[game]?.live || '');
    } catch (_) { v = ''; }
    NANOKA_VER_CACHE[game] = v;
    return v;
};
const nanokaBase = async game => {
    const v = await getNanokaVer(game);
    return v ? `https://static.nanoka.cc/${game}/${v}` : '';
};
// manifest.json 除了 latest/available/live 还有个 new —— 按实体列出「这一版
// 新增的 id」。live 落后 latest 的那部分就是测试服，所以 new.* 就是未上线内容
// 的权威名单，不用再靠 release 是不是 1970 去猜、也不用手维护武器名。
// 实测（gi live=7.1 / latest=7.1.51）：
//   new.character [10000136, 10000137] 米提亚、瓦列里
//   new.weapon    [14525, 224101, 224102]
// hsr new.character [1511]（阿哈）、new.lightcone [22009, 23065]
// zzz new.character [1631, 1641]、new.weapon [13022, 14163, 14164]
let nanokaManifestCache = null;
const getNanokaNew = async game => {
    if (!nanokaManifestCache) {
        try {
            // .json() 也要 await：写成 (await fetch(..)).json() 的话存进去的是
            // Promise，取值恒为 undefined，未上线判定会静默全部失效。
            nanokaManifestCache = (await (await fetch('https://static.nanoka.cc/manifest.json')).json()) || {};
        } catch (err) {
            logger.debug?.('[xhh][图鉴] 读 nanoka manifest.json 失败:', err?.message || err);
            nanokaManifestCache = {};
        }
    }
    const g = nanokaManifestCache?.[game];
    const out = {};
    for (const [k, v] of Object.entries(g?.new || {})) {
        if (Array.isArray(v)) out[k] = new Set(v.map(x => String(x)));
    }
    return out;
};


// 原神头像：nanoka 的 icon 字段本身就是 UI_AvatarIcon_Ayaka 这种方形头像名，
// 对应资源是 assets/gi/UI_AvatarIcon_Ayaka.webp（256×256，实测 152/152 可用）。
// 注意别用 UI_Gacha_AvatarImg_* —— 那是 2048×1024 的立绘，列表里裁成 90×90
// 只能裁到头发和背景，角色脸完全露不出来。
//
// nanoka 对同一个角色还给圆形版 _Circle 和卡面版 _Card，列表一律用**方形**基础版：
// 列表的头像框是 90×90 + border-radius:10px（不是圆形），方形图正好填满，
// 圆形图四角是透明的，会被圆角削掉一圈白边。实测三种（152 个角色）：
//   无后缀  152/152  ← 用这个
//   _Circle  131/152  缺 Nefer Durin Columbina Zibai Illuga Mitya Valeriy + 14 个 Mannequin 占位
//   _Card    128/152  比 _Circle 还少 Gaming Jahoda Varka
// 万一以后基础版缺图，回落到 _Circle（覆盖面次广），由 list.html 的 onerror 自动切换。
// 不硬编码「哪几个角色缺图」——名单会随版本变。
const nanokaGsIcon = icon => {
    const key = String(icon || '').replace(/^UI_AvatarIcon_/, '');
    if (!key) return '';
    return `${NANOKA_ASSET}/gi/UI_AvatarIcon_${key}.webp`;
};
const nanokaGsIconCircle = icon => {
    const key = String(icon || '').replace(/^UI_AvatarIcon_/, '');
    if (!key) return '';
    return `${NANOKA_ASSET}/gi/UI_AvatarIcon_${key}_Circle.webp`;
};
// 原神武器/遗器等小图标
//
// 资源名必须**保留** UI_EquipIcon_ / UI_ItemIcon_ 前缀。
// 之前这里把 UI_EquipIcon_ 剥掉了，拼成 assets/gi/Sword_Blunt.webp → 404，
// 原神武器图鉴整页没有图（实测 UI_EquipIcon_Sword_Blunt.webp 是 200）。
// 遗器一直是 UI_ItemIcon_201 这种，前缀没被剥，所以遗器是好的。
//
// 皮肤/变形武器（实测 20 条，weapon.json 里 detail 的 skin:true）：
//   weapon.json 给的是  UI_EquipIcon_Bow_MorphYayu_{0}
//   真实资源名是       UI_Gacha_EquipIcon_Bow_MorphYayu_Great.webp
// 规律是「UI_EquipIcon_ → UI_Gacha_EquipIcon_」并且去掉结尾的 _{0}。
// 之前误以为这些没托管、直接返回空串走首字占位，其实只是拼错了名字。
const nanokaGsItemIcon = icon => {
    const key = String(icon || '');
    if (!key) return '';
    if (/_\{0\}$/.test(key)) return gsSkinIcon(key);
    if (/Template/.test(key)) return '';
    return `${NANOKA_ASSET}/gi/${key}.webp`;
};
/** 皮肤武器的 Gacha 版图标，用作 onerror 兜底（见 nanokaGsItemIcon 的注释） */
const gsSkinIcon = key => {
    const base = String(key || '').replace(/_\{0\}$/, '');
    if (!base) return '';
    return `${NANOKA_ASSET}/gi/${base.replace(/^UI_EquipIcon_/, 'UI_Gacha_EquipIcon_')}.webp`;
};
// 星铁立绘（详情页大图用）：avatardrawcard/{角色id}.webp，实测 99/99 全部 200。
// 列表头像不用它 —— 那是 2048×2048 的卡面，裁成 90×90 只能看到头发。
const nanokaSrIcon = id => (id ? `${NANOKA_ASSET}/hsr/avatardrawcard/${id}.webp` : '');

// nanoka 的 zh 字段偶尔带内部标记，星铁「银狼」就是
// "银狼LV.<unbreak>999</unbreak>"（实测唯一一条，原神 152 条全干净）。
// 只去掉这一类标记，不能无脑剥所有标签 —— 日文名里 {RUBY_B#…} 是注音结构，剥了会散。
const cleanNanokaName = v => String(v || '')
    .replace(/LV\.<unbreak>.*?<\/unbreak>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** nanoka 的 id 可能是 10000005-2 这种多形态拼接，取数字前缀 */
const numId = id => {
    const m = String(id ?? '').match(/^\d+/);
    return m ? Number(m[0]) : 0;
};

/**
 * 上线时间排序权重（越大越新）。
 *
 * nanoka 的 release 两种形态都要认：
 *   原神  '2021-07-21 00:00:00'  字符串
 *   星铁  1713344400            秒级时间戳数字
 *
 * 「是否未上线」由调用方按 manifest.json 的 new.* 传入，不再靠 release 是不是
 * 1970 去猜 —— 1970 只说明「nanoka 没填日期」。实测旅行者全部形态
 * （10000005-2 等 16 条）都是 1970，但它们是最早上线的角色，靠猜就还得再开
 * 一个 /旅行者/ 特例把它按下去。现在未上线置顶、1970 沉底都交给数据说话，
 * 两个特例一起删掉。
 */
const releaseRank = (c, id, isUnreleased = false) => {
    if (isUnreleased) return Number.POSITIVE_INFINITY;
    const v = c?.release;
    let t = NaN;
    if (typeof v === 'number') {
        // 星铁是秒；万一是毫秒就除以 1000
        t = v > 1e11 ? v / 1000 : v;
    } else if (typeof v === 'string') {
        // 原神 'YYYY-MM-DD HH:mm:SS' —— 按 UTC 解析，避免本地时区把顺序搞乱
        t = Date.parse(v.replace(' ', 'T') + 'Z');
    }
    // 解析不出日期（1970 占位 / undefined）就当作最早，沉到末尾
    return Number.isFinite(t) && t >= 946684800 ? t : 0;
};


// 星铁商店常驻 5★ 光锥，共 14 个（黑塔商店「超过 16 张给星轨通票」，
// 现有 14 张，与该说法吻合）。
// nanoka 的 lightcone.json 只有 rank/baseType/en/atk/desc/ko/zh/ja，
// 没有常驻标记也没有上线时间，所以只能按名字认。
// 分两批进游戏：早期 7 个在 23xxx，记忆/欢愉命途那批在 24xxx。
const SR_STANDARD_LC = new Set([
    // 黑塔商店（较新）
    '记一位星神的陨落', '星海巡航', '记忆的质料', '孤独的疗愈',
    '不息的演算', '记忆永不落幕', '欢愉满溢祝福',
    // 早期常驻（星芒兑换，同属常驻）
    '无可取代的东西', '如泥酣眠', '银河铁道之夜', '但战斗还未结束',
    '制胜的瞬间', '以世界之名', '时节不居',
]);
// 原神武器的上线时间，来源是 system/default/gslogs.yaml 的卡池记录。
// nanoka 本身没有任何时间字段，这一点已穷尽确认：
//   weapon.json 只有 icon/rank/type/en/atk/sub/desc/ko/zh/ja/skin/tag；
//   zh/weapon/{id}.json 也没有；
//   gi.nanoka.cc/weapon/{id} 页面只加载 3 个数据源，都没有。
// 而且 id 段虽按武器类型分块（11xxx 单手剑 / 12xxx 双手剑 / 13xxx 长枪 /
// 14xxx 法器 / 15xxx 弓，31xxx–35xxx 是「真化」皮肤），同类型内 id 递增
// 并不等于时间递增 —— 实测 59 个相邻对里 22 个违反。
//
// 卡池日期本身会被返场污染（62 个 up 角色里 53 个的卡池日期和角色 release
// 对不上，钟离 release=2020-12-02 却出现在 4.0下半卡池，差 1007 天），
// 所以不能直接用「卡池日期」。这里的做法是：
//   把所有卡池按解析出的起止日期【升序】排一遍，取每把武器的【首次出现】
//   作为它的首发日期。返场晚于首发，只会影响重复项，首次出现即首发。
// ⚠️ 不能靠反序遍历文件来近似：文件里存在重复日期的条目
//    （【月之五下半】和【6.4下半】都是 2026/03/17），文件顺序不等于时间顺序。
// 排序必须按解析出的日期显式做。
// 该文件由 apps/gacha_pool.js 每次刷新卡池后自动更新，运行时读，
// 不写死顺序，新版本上线不用改代码。
const GS_LOGS_YAML = './plugins/xhh/system/default/gslogs.yaml';
let gsDebutCache = null;

// ITEM_TPS_WEAPON 的武器类型是占位值，getWikiIcon 映射表里显示成「特殊武器」，
// 但那不是真实类型。能确认的按名字覆盖：
//   索斯卢科的灼炎 = 瓦列里的专武，瓦列里 character.json 的 weapon 字段是
//   WEAPON_SWORD_ONE_HAND → 单手剑。
// 其余 ITEM_TPS_WEAPON（224001~224008、艾维萨缇的山狩）没有可靠依据，
// 暂不硬凑，保留占位显示。
const GS_WEAPON_CN_OVERRIDE = {
    '索斯卢科的灼炎': '单手剑',
};

/** 武器中文名 → 首发时间戳(ms)。读不到返回空 Map，退化成 id 降序。 */
function getGsDebut() {
    if (gsDebutCache) return gsDebutCache;
    const map = new Map();
    try {
        const data = YAML.parse(fs.readFileSync(GS_LOGS_YAML, 'utf-8'));
        const banners = data?.date;
        if (banners && typeof banners === 'object') {
            const dated = Object.entries(banners)
                .map(([key, lists]) => {
                    const m = String(key).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
                    if (!m) return null;
                    const t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`);
                    return Number.isFinite(t) ? [t, lists] : null;
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
            for (const [t, lists] of dated) {
                const up5 = String(lists?.[2] || '').split(',')[0].trim();
                if (up5 && !map.has(up5)) map.set(up5, t);
            }
        }
    } catch (err) {
        logger.debug?.('[xhh][图鉴] 读 gslogs.yaml 失败，武器退回 id 降序:', err?.message || err);
    }
    gsDebutCache = map;
    return map;
}

function sortWeaponEntries(weapons, isSr = false, isGs = false, newIds = null) {
    const entries = Object.entries(weapons || {}).filter(([, w]) => w?.zh);
    // 原神分四段，规则和角色那边一致（未上线置顶，其余按上线时间新→旧）：
    //    0 有首发日期的，按首发日期新→旧
    //    1 「真化」皮肤：本体是 4★，gslogs 只记 5★ up，拿不到日期
    //    2 完全没有卡池记录的开服期常驻武器
    const gsDebut = isGs ? getGsDebut() : null;
    const gsGroup = ([, w]) => {
        if (gsDebut.has(w.zh)) return 0;
        return /_\{0\}$/.test(String(w.icon || '')) ? 1 : 2;
    };
    return entries.sort((a, b) => {
        // 未上线（测试服）置顶：manifest.json 的 new.weapon / new.lightcone。
        // 原神和星铁同一套规则，在常驻/首发日期/皮肤分组之前先判。
        if (newIds) {
            const ua = newIds.has(String(a[0])) ? 0 : 1;
            const ub = newIds.has(String(b[0])) ? 0 : 1;
            if (ua !== ub) return ua - ub;
        }
        // 星铁的商店常驻 5★ 在游戏数据里是按「加入时间」排的 id，
        // 24xxx 整段 7 个正好一条命途一个，id 最大 → 纯 id 降序会把
        // 这 7 个常驻顶到最前面，看着像「常驻被置顶」。
        // 数据里没有任何常驻标记，只能按名字认（名单见 SR_STANDARD_LC）。
        if (isSr) {
            const sa = SR_STANDARD_LC.has(a[1]?.zh) ? 1 : 0;
            const sb = SR_STANDARD_LC.has(b[1]?.zh) ? 1 : 0;
            if (sa !== sb) return sa - sb;
        }
        if (gsDebut) {
            const ga = gsGroup(a), gb = gsGroup(b);
            if (ga !== gb) return ga - gb;
            if (ga === 0) {
                // 时间戳越大越新，所以要 b - a（升序会变成最旧在前）
                const d = gsDebut.get(b[1].zh) - gsDebut.get(a[1].zh);
                if (d) return d;
            }
        }
        return numId(b[0]) - numId(a[0]);
    });
}

// 星铁头像：avatarshopicon/{角色id}.webp（376×512 商店立绘，顶部是脸部特写）。
// 列表按 90×90 + object-fit:cover + object-position:top center 裁，正好取到脸。
//
// 四个候选全量实测（99 个角色，每个都单独发请求确认过）：
//   avatarshopicon     99/99  ← 用这个，零缺失
//   avatarroundicon    99/99  但 128×128 四角透明，会被圆角削掉一圈白边
//   avataricon/avatar  95/99  缺 1507 1511 1512 1513
//   gridfight/icon     10/99
//
// 之前选了 avataricon/avatar（方形脸部）再加 avatarroundicon 兜底，
// 结果那 4 个角色要走一次 404 才有图，截图时机不对就显示空白。
// 改成 shopicon 之后 99 个角色同一套源、零 404、不需要兜底链。
// （上一版注释里写「avatarshopicon 98/99 缺 1224」是测错了 ——
//   那轮只抽查了部分样本，1224 实测是 200。）
const nanokaSrAvatar = id => (id ? `${NANOKA_ASSET}/hsr/avatarshopicon/${id}.webp` : '');
const nanokaSrLcIcon = id => (id ? `${NANOKA_ASSET}/hsr/lightconemaxfigures/${id}.webp` : '');
const nanokaSrSkillIcon = (id, kind) => (id && kind ? `${NANOKA_ASSET}/hsr/skillicons/SkillIcon_${id}_${kind}.webp` : '');

const GS_ELEMENT_CN = {
    Pyro: '火', Cryo: '冰', Electro: '雷', Hydro: '水', Anemo: '风',
    Geo: '岩', Dendro: '草', None: '无'
};
const GS_WEAPON_CN = {
    WEAPON_SWORD_ONE_HAND: '单手剑', WEAPON_CATALYST: '法器', WEAPON_CLAYMORE: '双手剑',
    WEAPON_BOW: '弓', WEAPON_POLE: '长枪', WEAPON_CROSSBOW: '特弓', ITEM_TPS_WEAPON: '特殊武器'
};
// 命途内部名 → 中文名。
// 这张表必须和 nanoka 官方一致（从站点代码里挖出来的原文：
//   path:{knight:"存护",mage:"智识",priest:"丰饶",rogue:"巡猎",shaman:"同谐",
//         warlock:"虚无",warrior:"毁灭",memory:"记忆",elation:"欢愉"}）
// 之前凭印象写错了 5 个：Warlock 写成毁灭（应为虚无）、Warrior 写成「纷争」
// （游戏里根本没这个命途，导致 16 个角色的徽章没图标）、Priest 写成同谐
// （应为丰饶）、Shaman 写成欢愉（应为同谐）、Elation 写成虚无（应为欢愉）。
// 内部名和中文名的对应基本不成规律，不能按字面猜。
const SR_PATH_CN = {
    Knight: '存护', Rogue: '巡猎', Mage: '智识', Warlock: '虚无',
    Warrior: '毁灭', Priest: '丰饶', Shaman: '同谐',
    Memory: '记忆', Elation: '欢愉'
};
const SR_DAMAGE_CN = {
    Physical: '物理', Fire: '火', Ice: '冰', Thunder: '雷',
    Wind: '风', Imaginary: '虚数', Quantum: '量子'
};
// 星级：原神用 QUALITY_*，星铁用 CombatPower*，原神武器是 1~5 的数字
const gsRarityCn = r => (String(r).includes('ORANGE') ? '五星' : String(r).includes('PURPLE') ? '四星' : '');
const gsWeaponRarityCn = r => {
    const n = Number(r);
    return n === 5 ? '五星' : n === 4 ? '四星' : n === 3 ? '三星' : n === 2 ? '二星' : n === 1 ? '一星' : '';
};
const srRarityCn = r => {
    // 星铁的 rank 有两种写法：角色是 CombatPowerAvatarRarityType5，
    // 光锥是 CombatPowerLightconeRarity3（没有 Type），所以统一取末尾数字。
    const m = /(\d+)\s*$/.exec(String(r || ''));
    const n = m ? Number(m[1]) : 0;
    return n === 5 ? '五星' : n === 4 ? '四星' : n === 3 ? '三星' : n === 2 ? '二星' : n === 1 ? '一星' : '';
};

/**
 * 合成米游社格式的 ext。
 * mys.data() 里是 `text.c_25 || text.c_5 || text.c_19 || text.c_18` 然后取
 * `filter.text`，也就是 filter 必须放在 c_* 盒子「里面」而不是顶层——
 * 放顶层的话 data() 取到 undefined，列表的星级徽章和筛选全会失效。
 * 真实米游社样例：{"c_18":{"filter":{"text":"[\"星级/五星\",...]"},"picture":{...}}}
 */
const makeExt = (strings, icon) => {
    const box = {
        filter: { text: JSON.stringify(strings.filter(Boolean)) },
        picture: { list: icon ? [icon] : [] }
    };
    return JSON.stringify({ c_25: box, c_5: box, c_18: box, c_19: box, fallbackIcon: '' });
};


const BH3_WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki';
const BH3_APP_SN = 'bh3_wiki';

const BH3_CHANNEL_MAP = {
    js: 18,     // 角色
    wq: 20,     // 武器
    syw: 19,    // 圣痕
    yq: 21,     // 人偶/协同者
    hb: 218     // 协同者
};

class mys {
    // 部分第三方图鉴源异常时会返回 HTML 错误页，不能直接调用 response.json()。
    async fetchJson(url, label = '') {
        const response = await fetch(url, {
            headers: {
                Referer: 'https://www.miyoushe.com/',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        const text = await response.text();
        if (!response.ok || !/^\s*[\[{]/.test(text)) {
            throw new Error(`${label || url} 返回非 JSON（HTTP ${response.status}）`);
        }
        return JSON.parse(text);
    }

    // 绝区零道具映射（zh/item.json），懒加载并缓存
    async zzzItemMap() {
        if (this._zzzItemMap) return this._zzzItemMap;
        try {
            this._zzzItemMap = await this.fetchJson(`${ZZZ_NANOKA_BASE}/zh/item.json`, 'ZZZ nanoka道具');
        } catch (_) {
            return {}; // 失败不缓存，下次重试
        }
        return this._zzzItemMap;
    }

    // 资源路径（Assets/.../xxx.png）或资源 key（ExBigBoss001 等）→ 可访问 webp 图标
    zzzItemIcon(path = '') {
        if (!path) return '';
        if (/^https?:/i.test(path)) return path;
        // nanoka 的部分核心技/周本材料图标不是完整路径，而是 ExSmallBoss001 / ExBigBoss001 这类资源 key。
        // 之前这里直接跳过 ExBoss，导致艾莲图鉴最后两个核心技能材料没有图标。
        // 虽然这两个资源是较大的 boss 素材图，但 nanoka 当前 item.json 没给更小的材料图标，只能先展示它，避免空图标。
        const base = String(path).split('/').pop().replace(/\.(png|jpe?g|webp)$/i, '');
        return base ? `https://static.nanoka.cc/assets/zzz/${base}.webp` : '';
    }

    // ExBigBoss / ExSmallBoss 是 2048×2048 序列帧图集，直接缩成 44px 会变成“马赛克宫格”。
    // 裁出左上角第一帧后缓存成本地图标，显示效果与 nanoka 材料卡一致。
    async zzzItemIconResolved(info = {}) {
        const icon = info.icon || '';
        const key = String(icon).split('/').pop().replace(/\.(png|jpe?g|webp)$/i, '');
        if (!/^Ex(?:Small|Big)?Boss\d+/i.test(key)) return this.zzzItemIcon(icon);

        try {
            fs.mkdirSync(ZZZ_ITEM_ICON_CACHE, { recursive: true });
            const file = `${ZZZ_ITEM_ICON_CACHE}/${key}.webp`;
            if (fs.existsSync(file)) return localFileUrl(file);

            const url = `https://static.nanoka.cc/assets/zzz/${key}.webp`;
            const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const sharp = (await import('sharp')).default;
            await sharp(buffer)
                .extract({ left: 0, top: 0, width: 150, height: 120 })
                .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .resize(88, 88, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp()
                .toFile(file);
            return localFileUrl(file);
        } catch (err) {
            logger.warn?.(`[xhh] ZZZ boss材料图标裁剪失败 ${key}: ${err.message || err}`);
            return this.zzzItemIcon(icon);
        }
    }

    async zzzMaterialView(id, amount, map = {}) {
        const info = map[id] || {};
        return { name: info.name || id, img: await this.zzzItemIconResolved(info), amount };
    }

    // 解析音擎「Lv.60」升级/突破总素材（对齐 nanoka 官网口径）：
    // 1) materials 字符串按阶段("|"分隔)累加 —— 丁尼 + 各阶突破组件
    // 2) level 表键 1..60 的 exp 累加(排除键 0)，按面值换算经验道具：
    //    301003 音擎能源模块 3000 / 301002 变频音擎电源 600 / 301001 音擎蓄电池 100
    async zzzParseMaterials(str = '', level = null) {
        const map = await this.zzzItemMap();
        const acc = new Map();
        String(str || '').split('|').filter(Boolean).forEach(stage => {
            stage.split(',').filter(Boolean).forEach(kv => {
                const [id, num] = kv.split(':');
                const n = Number(num);
                if (!Number.isFinite(n) || n <= 0) return;
                acc.set(id, (acc.get(id) || 0) + n);
            });
        });
        if (level && typeof level === 'object') {
            let total = 0;
            for (const [k, v] of Object.entries(level)) {
                const lv = Number(k);
                const exp = Number(v?.exp ?? 0);
                if (Number.isFinite(lv) && lv > 0 && Number.isFinite(exp)) total += exp;
            }
            if (total > 0) {
                const big = Math.floor(total / 3000);
                const mid = Math.floor((total % 3000) / 600);
                const small = Math.floor((total % 600) / 100);
                if (small) acc.set('301001', (acc.get('301001') || 0) + small);
                if (mid) acc.set('301002', (acc.get('301002') || 0) + mid);
                if (big) acc.set('301003', (acc.get('301003') || 0) + big);
            }
        }
        return await Promise.all([...acc.keys()].map(id => this.zzzMaterialView(id, acc.get(id), map)));
    }

    // 解析角色突破材料：level[1..5].materials（{材料id:数量}），全阶段累加（对齐 nanoka 官网 Lv.1→60 口径）
    async zzzParseRoleAscendMaterials(level = null) {
        const map = await this.zzzItemMap();
        if (!level || typeof level !== 'object') return [];
        const acc = new Map();
        for (const [, lv] of Object.entries(level)) {
            const mats = lv?.materials || {};
            for (const [id, num] of Object.entries(mats)) {
                const n = Number(num);
                if (!Number.isFinite(n) || n <= 0) continue;
                acc.set(id, (acc.get(id) || 0) + n);
            }
        }
        return await Promise.all([...acc.keys()].map(id => this.zzzMaterialView(id, acc.get(id), map)));
    }

    // 解析角色技能材料：各技能 1→12 级全程累加（material 每个非空等级都计入），累加去重
    async zzzParseRoleSkillMaterials(skill = null) {
        const map = await this.zzzItemMap();
        if (!skill || typeof skill !== 'object') return [];
        const acc = new Map();
        for (const [, sv] of Object.entries(skill)) {
            const mat = sv?.material || {};
            for (const [, lv] of Object.entries(mat)) {
                if (!lv || typeof lv !== 'object') continue;
                for (const [id, num] of Object.entries(lv)) {
                    const n = Number(num);
                    if (!Number.isFinite(n) || n <= 0) continue;
                    acc.set(id, (acc.get(id) || 0) + n);
                }
            }
        }
        return await Promise.all([...acc.keys()].map(id => this.zzzMaterialView(id, acc.get(id), map)));
    }

    // 解析角色升级经验道具：level_exp 数组（index 0 为 0 级初始值，需排除），
    // 面值同音擎经验道具：300003 资深调查员记录 3000 / 300002 正式调查员记录 600 / 300001 见习调查员记录 100
    async zzzParseRoleExpMaterials(level_exp = null) {
        const map = await this.zzzItemMap();
        if (!Array.isArray(level_exp) || !level_exp.length) return [];
        let total = 0;
        level_exp.forEach((exp, i) => {
            const e = Number(exp);
            if (i > 0 && Number.isFinite(e) && e > 0) total += e;
        });
        if (total <= 0) return [];
        const big = Math.floor(total / 3000);
        const mid = Math.floor((total % 3000) / 600);
        const small = Math.floor((total % 600) / 100);
        const acc = new Map();
        if (small) acc.set('300001', small);
        if (mid) acc.set('300002', mid);
        if (big) acc.set('300003', big);
        return await Promise.all([...acc.keys()].map(id => this.zzzMaterialView(id, acc.get(id), map)));
    }

    // 解析角色核心技能（被动）材料：passive.materials 0→6 级全程累加（含周本 Boss 材料）
    async zzzParseRolePassiveMaterials(passive = null) {
        const map = await this.zzzItemMap();
        if (!passive || typeof passive !== 'object') return [];
        const mat = passive.materials || {};
        const acc = new Map();
        for (const [, lv] of Object.entries(mat)) {
            if (!lv || typeof lv !== 'object') continue;
            for (const [id, num] of Object.entries(lv)) {
                const n = Number(num);
                if (!Number.isFinite(n) || n <= 0) continue;
                acc.set(id, (acc.get(id) || 0) + n);
            }
        }
        return await Promise.all([...acc.keys()].map(id => this.zzzMaterialView(id, acc.get(id), map)));
    }

    async zzz_official_list(type) {
        const channelId = ZZZ_WIKI_CHANNEL_MAP[type];
        if (!channelId) return [];
        const url = `${ZZZ_WIKI_BASE}/v1/home/content/list?app_sn=${ZZZ_WIKI_APP_SN}&channel_id=${channelId}`;
        const res = await this.fetchJson(url, `ZZZ 官方 Wiki ${type}`);
        const root = res?.data?.list?.[0];
        return Array.isArray(root?.list) ? root.list : [];
    }

    zzz_official_item(item, type) {
        const channelId = ZZZ_WIKI_CHANNEL_MAP[type];
        let ext = item?.ext;
        if (typeof ext !== 'string') ext = JSON.stringify(ext || {});
        let parsed = {};
        try { parsed = JSON.parse(ext || '{}'); } catch (_) {}
        const channelExt = parsed[`c_${channelId}`] || {};
        const filterText = channelExt.filter?.text || parsed.filter?.text || '[]';
        // 官方 Wiki 的筛选文案与 nanoka 不一致：角色用「稀有度/S」「特性/强攻」，
        // 而 zzz_data / 图鉴列表只认「星级/S级」「强攻类型/强攻」，不归一会导致列表星级、属性徽章全空且排序失效
        let filterArr = [];
        try { filterArr = typeof filterText === 'string' ? JSON.parse(filterText) : (Array.isArray(filterText) ? filterText : []); } catch (_) { filterArr = []; }
        const filterList = filterArr.map(entry => {
            const s = String(entry || '');
            // 邦布（yq）同样用「稀有度/S」，不归一会导致邦布列表没有星级徽章、排序失效
            if (type === 'js' || type === 'yq') {
                if (s.includes('稀有度/')) return `星级/${s.split('/').slice(1).join('/')}级`;
                if (s.includes('特性/')) return `强攻类型/${s.split('/').slice(1).join('/')}`;
            }
            return s;
        });
        // 保留旧版 xhh 读取 ext.filter.text 的兼容格式。
        const normalizedExt = JSON.stringify({
            ...parsed,
            filter: { text: JSON.stringify(filterList) },
            c_30: parsed.c_30 || { picture: { list: [item?.icon || ''] } }
        });
        return {
            content_id: item?.content_id,
            title: item?.title || item?.alias_name || String(item?.content_id || ''),
            icon: item?.icon || '',
            summary: item?.summary || '',
            alias_name: item?.alias_name || '',
            ext: normalizedExt
        };
    }

    async zzz_official_detail(id, type) {
        const list = await this.zzz_official_list(type);
        const item = list.find(v => String(v.content_id) === String(id));
        if (!item) return false;
        const normalized = this.zzz_official_item(item, type);
        let filters = [];
        try { filters = JSON.parse(JSON.parse(normalized.ext).filter.text || '[]'); } catch (_) {}
        const values = {};
        for (const entry of filters) {
            const [key, ...rest] = String(entry).split('/');
            if (key && rest.length) values[key] = rest.join('/');
        }
        // 角色条目已被归一成「星级/S级」，此处两种写法都要认
        const rarityRaw = values['稀有度'] || String(values['星级'] || '').replace('级', '');
        const rarity = rarityRaw === 'S' ? 4 : rarityRaw === 'A' ? 3 : undefined;
        const content = {
            name: normalized.title,
            title: normalized.title,
            icon: normalized.icon,
            summary: normalized.summary,
            desc: normalized.summary,
            story: normalized.summary,
            rarity,
            element_type: values['属性'] ? [values['属性']] : [],
            weapon_type: values['特性'] || values['强攻类型'] ? [values['特性'] || values['强攻类型']] : [],
            camp: values['阵营'] ? [values['阵营']] : [],
            ext: normalized.ext
        };
        return { content };
    }

    // 邦布本地补图：resources/xhh/wiki/zzz_bangboo/<名>.png|webp|jpg（详情页与列表共用）
    zzzBangbooLocalIcon(name) {
        return localBangbooIcon(name);
    }

    // 原神/星铁官方 Wiki 列表（nanoka 失效时的兜底）
    async official_tujian(isSr = false) {
        let url =
            'https://api-takumi-static.mihoyo.com/common/blackboard/ys_obc/v1/home/content/list?app_sn=ys_obc&channel_id=189';
        if (isSr)
            url =
            'https://api-static.mihoyo.com/common/blackboard/sr_wiki/v1/home/content/list?app_sn=sr_wiki&channel_id=17';
        let res;
        try {
            res = await fetch(url).then(res => res.json());
        } catch (error) {
            logger.error('米游社访问失败');
            return false;
        }
        let children = res.data.list[0].children;
        let data = {};
        children.map(va => {
            if (va.name == '角色') data['js_list'] = va.list;
            else if (va.name == '武器') data['wq_list'] = va.list;
            else if (va.name == '圣遗物') data['syw_list'] = va.list;
            else if (va.name == '光锥') data['gz_list'] = va.list;
            else if (va.name == '遗器') data['yq_list'] = va.list;
        });
        return data;
    }

    //原神/星铁图鉴：nanoka 优先（体积小一个数量级），米游社官方 Wiki 兜底
    async tujian(isSr = false, isZZZ = false, isBH3 = false) {
        if (isZZZ) {
            return await this.zzz_tujian();
        }
        if (isBH3) {
            return await this.bh3_tujian();
        }
        if (!nanokaDown()) {
            try {
                const data = await this.nanoka_tujian(isSr);
                if (data && (data.js_list?.length || data.gz_list?.length || data.wq_list?.length)) return data;
                logger.warn?.('[xhh][图鉴] nanoka 返回空，回退米游社官方 Wiki');
            } catch (error) {
                // 仅网络/接口类失败才全局降级，代码 bug 直接抛出（见 isTransientNetError）
                if (isTransientNetError(error)) markNanokaDown();
                logger.error('原神/星铁 nanoka 图鉴访问失败，切换米游社官方 Wiki:', error);
            }
        }
        return await this.official_tujian(isSr);
    }

    /**
     * nanoka 版原神/星铁图鉴列表。
     * 产出与米游社一致的 {js_list, wq_list, syw_list, gz_list, yq_list}，
     * 其中 ext 里的 filter.text 决定列表的星级徽章与筛选，必须在此处合成。
     */
    async nanoka_tujian(isSr = false) {
        const game = isSr ? 'hsr' : 'gi';
        const base = await nanokaBase(game);
        if (!base) throw new Error('nanoka 版本号获取失败');
        const isGs = !isSr;
        const wqFile = isGs ? 'weapon.json' : 'lightcone.json';
        const [chars, equips, weapons] = await Promise.all([
            this.fetchJson(`${base}/character.json`, `${game} nanoka角色`),
            this.fetchJson(`${base}/zh/item.json`, `${game} nanoka物品`),
            this.fetchJson(`${base}/${wqFile}`, `${game} nanoka武器/光锥`)
        ]);
        if (!chars) throw new Error('nanoka 角色数据为空');

        // 物品（圣遗物/遗器）按 nanoka 的数字 id 分组
        const itemList = Object.values(equips || {}).filter(v => v && (v.name || v.icon));

        // nanoka 把旅行者/奇偶的七个形态平铺成 xxx-2 ~ xxx-8（实测 28 条），
        // 而且 character.json 里**没有本体条目**（10000005 / 10000117 等都不存在），
        // 直接全部过滤会让旅行者和奇偶从列表里彻底消失（旧米游社列表里是有这 16 条的）。
        // 这些形态共用同一份立绘（PlayerBoy / PlayerGirl / MannequinBoy / MannequinGirl，实测均 200），
        // 所以按名字去重、每个只留第一条，既不出现 7 个重复条目，也不会拼出
        // UI_Gacha_AvatarImg_XXX-5.webp 这种不存在的地址。
        const seenName = new Set();
        // nanoka 会用 {NICKNAME} 占位未实装角色，这种条目没有名字也没有图，直接剔掉
        const newChars = (await getNanokaNew(game))?.character || new Set();
        const charEntries = Object.entries(chars)
            .filter(([, c]) => c?.zh && !/^\{[A-Z_]+\}$/.test(c.zh))
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }))
            .filter(([, c]) => {
                const key = `${c.zh}|${c.element || ''}`;
                if (seenName.has(key)) return false;
                seenName.add(key);
                return true;
            })
            // 按上线时间降序 = 新的排前面。
            //
            // 两个坑：
            // 1) release 的形态两个游戏不一样：原神是 'YYYY-MM-DD HH:mm:SS' 字符串
            //    （实测 152 条全是这种），星铁是秒级时间戳数字（97 条）。
            //    原来直接 String().localeCompare 混着比，跨游戏毫无意义。
            // 2) nanoka 用 1970-01-01 / undefined 表示「没有上线时间」。
            //    实测这类条目是：原神 米提亚(10000136)、瓦列里(10000137)、
            //    旅行者的一堆形态(10000005-2 等)；星铁 真珠(1503)、星神★阿哈(1511)。
            //    之前这些会被当成「时间最早」直接沉到列表最底 —— 用户要的是
            //    「米提亚是新角色应该排最前」，实际排在了五星组最后一名。
            //    没有上线时间 = 尚未实装 = 比所有已上线的新 → 当作最新。
            //    例外是旅行者：它同样是 1970，但它是最初的角色，必须沉到最后，
            //    所以单独按主角处理。
            // 3) 时间相同时（同一批上线的角色）再按 id 降序兜底，
            //    否则顺序取决于 JSON 的键序，每次刷新可能不一样。
            .sort((a, b) => (releaseRank(b[1], b[0]) - releaseRank(a[1], a[0]))
                || (numId(b[0]) - numId(a[0])));

        const js_list = charEntries.map(([id, c]) => {
            // 两个游戏都用方形头像：原神 UI_AvatarIcon_XXX，星铁 avataricon/avatar/{id}。
            // 方形贴方形框（90×90 + border-radius:10px），圆形图四角透明会被圆角削掉。
            // 两边都同源 nanoka，不会再出现两套 id 撞号查错人。
            const icon = isGs ? nanokaGsIcon(c.icon) : nanokaSrAvatar(id);
            const strings = isGs
                ? [`星级/${gsRarityCn(c.rank)}`, `元素/${GS_ELEMENT_CN[c.element] || ''}`, `武器/${GS_WEAPON_CN[c.weapon] || ''}`]
                : [`星级/${srRarityCn(c.rank)}`, `命途/${SR_PATH_CN[c.baseType] || ''}`, `属性/${SR_DAMAGE_CN[c.damageType] || ''}`];
            return {
                content_id: id,
                title: cleanNanokaName(c.zh) || c.en || id,
                icon,
                // 兜底链由 list.html 的 onerror 逐级切换（mys.data() 负责把
                // iconFallback 透传下来，缺了这条链整段就是死的）。
                // 星铁不需要了：avatarshopicon 全量 99/99，零缺失、零 404。
                // 原神保留一层 _Circle 兜底（实测 131/152，比基础版少 21 个）。
                iconFallback: isGs ? nanokaGsIconCircle(c.icon) : '',
                aliases: [c.code, c.en, c.codename].filter(v => v && v !== c.zh),
                ext: makeExt(strings, icon)
            };
        });

        const equipList = itemList.map(it => ({
            content_id: String(it.id ?? it.ID ?? ''),
            title: it.name || '',
            icon: isGs ? nanokaGsItemIcon(it.icon) : `${NANOKA_ASSET}/hsr/itemfigures/${it.id ?? it.ID}.webp`,
            ext: makeExt([], '')
        }));

        // 武器/光锥预排序，理由见 sortWeaponEntries 的注释。
        // 这里只排一次，wiki.js 的 list() 还会按星级排一次；
        // Array.sort 是稳定的，所以同星级内会保住这里的顺序。
        const newWeapons = (await getNanokaNew(game))?.[isGs ? 'weapon' : 'lightcone'] || new Set();
        const weaponEntries = sortWeaponEntries(weapons, !isGs, isGs, newWeapons);

        let gz_list = [], wq_list = [];
        if (isGs) {
            wq_list = weaponEntries.map(([id, w]) => {
                const icon = nanokaGsItemIcon(w.icon);
                return {
                    content_id: id,
                    title: w.zh || w.en || id,
                    icon,
                    // 皮肤武器再兜一层 Gacha 版：有一把（380002「超厉害魔法钥匙」）
                    // weapon.json 给的是 UI_EquipIcon_Claymore_LoliFriend，
                    // 页面引用的是 UI_Gacha_EquipIcon_Claymore_LoliFriend.webp，
                    // 但那个文件实测 404 —— 留着兜底链，指不定 nanoka 哪天补上。
                    iconFallback: /_\{0\}$/.test(String(w.icon || '')) ? '' : gsSkinIcon(w.icon),
                    ext: makeExt([`武器星级/${gsWeaponRarityCn(w.rank)}`, `武器类型/${GS_WEAPON_CN_OVERRIDE[w.zh] || GS_WEAPON_CN[w.type] || ''}`], icon)
                };
            });
        } else {
            gz_list = weaponEntries.map(([id, l]) => {
                const icon = nanokaSrLcIcon(id);
                return {
                    content_id: id,
                    title: l.zh || l.en || id,
                    icon,
                    ext: makeExt([`星级/${srRarityCn(l.rank)}`, `命途/${SR_PATH_CN[l.baseType] || ''}`], icon)
                };
            });
        }

        return {
            js_list,
            ...(isGs ? { wq_list, syw_list: equipList, yq_list: equipList } : { gz_list, yq_list: equipList })
        };
    }

    // 绝区零图鉴（nanoka.cc 优先，米游社官方 Wiki 回退）
    async zzz_tujian() {
        // 冷却期内直接走官方 Wiki，不再请求已失效的 nanoka
        if (nanokaDown()) return await this.zzz_official_tujian();
        try {
            const [chars, weapons, equipments, bangboos] = await Promise.all([
                this.fetchJson(`${ZZZ_NANOKA_BASE}/character.json`, 'ZZZ nanoka角色'),
                this.fetchJson(`${ZZZ_NANOKA_BASE}/weapon.json`, 'ZZZ nanoka音擎'),
                this.fetchJson(`${ZZZ_NANOKA_BASE}/equipment.json`, 'ZZZ nanoka驱动盘'),
                this.fetchJson(`${ZZZ_NANOKA_BASE}/bangboo.json`, 'ZZZ nanoka邦布')
            ]);
            // 官方 Wiki 代理人半身像（act-upload 图床支持缩略，覆盖新角色，构图同星铁官方图鉴卡片）
            let officialIconMap = {};
            try {
                const cleanName = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '');
                // 邦布（yq）的 nanoka icon 是游戏内资源路径（UI/Sprite/...），拼不出可访问链接，
                // 因此官方邦布图标也一并纳入映射，邦布列表按名字回退使用，避免整列裂图
                const [officialChars, officialBangboos] = await Promise.all([
                    this.zzz_official_list('js'),
                    this.zzz_official_list('yq')
                ]);
                const collect = items => {
                    (items || []).forEach(item => {
                        const raw = String(item.title || '');
                        const full = cleanName(raw);
                        if (!full || full.length < 2 || !item.icon) return;
                        const thumb = `${item.icon}?x-oss-process=image/resize,w_300/format,webp`;
                        if (!officialIconMap[full]) officialIconMap[full] = thumb;
                        const short = cleanName(raw.split('·')[0]);
                        if (short && short.length >= 2 && !officialIconMap[short]) officialIconMap[short] = thumb;
                    });
                };
                collect(officialChars);
                collect(officialBangboos);
            } catch (_) {}
            const matchOfficialIcon = zh => {
                const key = String(zh || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '');
                if (!key) return '';
                if (officialIconMap[key]) return officialIconMap[key];
                const hit = Object.keys(officialIconMap).find(k => key.includes(k) || k.includes(key));
                return hit ? officialIconMap[hit] : '';
            };
            return {
                js_list: Object.entries(chars).map(([id, c]) => {
                    const squareIcon = matchOfficialIcon(c.zh) || nanokaIcon(c.icon);
                    return {
                    content_id: id,
                    title: c.zh,
                    icon: squareIcon,
                    aliases: [c.code, c.en].filter(v => v && v !== c.zh),
                    ext: JSON.stringify({
                        c_30: { picture: { list: [squareIcon] } },
                        fallbackIcon: `https://static.nanoka.cc/assets/zzz/${c.icon}.webp`,
                        filter: { text: JSON.stringify([
                            `星级/${c.rank == 4 ? 'S级' : 'A级'}`,
                            `属性/${this.zzz_element_map[c.element] || '未知'}`,
                            `强攻类型/${this.zzz_type_map[c.type] || '未知'}`
                        ])}
                    })
                    };
                }),
                wq_list: Object.entries(weapons).map(([id, w]) => ({
                    content_id: id,
                    title: w.zh,
                    icon: nanokaIcon(w.icon),
                    aliases: [w.code].filter(Boolean),
                    ext: JSON.stringify({
                        c_30: { picture: { list: [nanokaIcon(w.icon)] } },
                        filter: { text: JSON.stringify([
                            `武器星级/${w.rank == 4 ? 'S级' : w.rank == 3 ? 'A级' : 'B级'}`,
                            `武器类型/${this.zzz_wq_type_map[w.type] || '未知'}`
                        ])}
                    })
                })),
                syw_list: Object.entries(equipments).map(([id, e]) => ({
                    content_id: id,
                    title: e.zh?.name || id,
                    icon: nanokaIcon(e.icon),
                    ext: JSON.stringify({
                        c_30: { picture: { list: [nanokaIcon(e.icon)] } },
                        filter: { text: '[]' }
                    })
                })),
                yq_list: Object.entries(bangboos).map(([id, b]) => {
                    // nanoka 的邦布 icon 是游戏内资源路径，拼 assets 前缀也是 404；
                    // 优先用本地补图目录，其次官方 Wiki 图标；都没有就留空走首字占位
                    const icon = localBangbooIcon(b.zh) || matchOfficialIcon(b.zh);
                    return {
                    content_id: id,
                    title: b.zh,
                    icon,
                    aliases: [b.codename, b.en].filter(v => v && v !== b.zh),
                    ext: JSON.stringify({
                        c_30: { picture: { list: icon ? [icon] : [] } },
                        fallbackIcon: '',
                        // 与角色/音擎一致写「星级/S级」，否则列表拿不到星级徽章、排序也会失效
                        filter: { text: JSON.stringify([
                            `星级/${b.rank == 4 ? 'S级' : b.rank == 3 ? 'A级' : 'B级'}`
                        ]) }
                    })
                };
                })
            };
        } catch (error) {
            if (isTransientNetError(error)) markNanokaDown();
            logger.error('ZZZ nanoka访问失败，切换米游社官方 Wiki:', error);
            return await this.zzz_official_tujian();
        }
    }

    // 米游社官方 Wiki 版绝区零图鉴列表（nanoka 失效/冷却时的数据源）
    async zzz_official_tujian() {
        try {
            const [chars, weapons, equipments, bangboos] = await Promise.all([
                this.zzz_official_list('js'),
                this.zzz_official_list('wq'),
                this.zzz_official_list('syw'),
                this.zzz_official_list('yq')
            ]);
            return {
                js_list: chars.map(v => this.zzz_official_item(v, 'js')),
                wq_list: weapons.map(v => this.zzz_official_item(v, 'wq')),
                syw_list: equipments.map(v => this.zzz_official_item(v, 'syw')),
                yq_list: bangboos.map(v => this.zzz_official_item(v, 'yq'))
            };
        } catch (fallbackError) {
            logger.error('ZZZ 官方 Wiki 访问失败:', fallbackError);
            return false;
        }
    }

    zzz_element_map = {
        200: '物理',
        201: '火',
        202: '冰',
        203: '电',
        204: '风',
        205: '以太',
        300: '流明'
    };

    zzz_type_map = {
        1: '强攻',
        2: '击破',
        3: '异常',
        4: '支援',
        5: '防护',
        6: '命破',
        7: '锋御'
    };

    // 音擎与角色使用同一套特性编码：3=异常、5=防护。
    zzz_wq_type_map = {
        1: '强攻',
        2: '击破',
        3: '异常',
        4: '支援',
        5: '防护',
        6: '命破',
        7: '锋御'
    };

    zzz_weapon_type_map = {
        1: '单手剑',
        2: '双手剑',
        3: '长柄武器',
        4: '法器',
        5: '弓'
    };

    // 崩坏3图鉴 (使用官方 wiki API)
    async bh3_tujian() {
        try {
            const [chars, weapons, stigmatas, elves, partners] = await Promise.all([
                fetch(`${BH3_WIKI_BASE}/v1/home/content/list?app_sn=${BH3_APP_SN}&channel_id=${BH3_CHANNEL_MAP.js}`).then(r => r.json()),
                fetch(`${BH3_WIKI_BASE}/v1/home/content/list?app_sn=${BH3_APP_SN}&channel_id=${BH3_CHANNEL_MAP.wq}`).then(r => r.json()),
                fetch(`${BH3_WIKI_BASE}/v1/home/content/list?app_sn=${BH3_APP_SN}&channel_id=${BH3_CHANNEL_MAP.syw}`).then(r => r.json()),
                fetch(`${BH3_WIKI_BASE}/v1/home/content/list?app_sn=${BH3_APP_SN}&channel_id=${BH3_CHANNEL_MAP.yq}`).then(r => r.json()),
                fetch(`${BH3_WIKI_BASE}/v1/home/content/list?app_sn=${BH3_APP_SN}&channel_id=${BH3_CHANNEL_MAP.hb}`).then(r => r.json())
            ]);
            const parseList = (res, channelKey) => {
                if (!res.data || !res.data.list || !res.data.list[0]) return [];
                return res.data.list[0].list.map(item => ({
                    content_id: item.content_id,
                    title: item.title,
                    icon: item.icon,
                    ext: typeof item.ext === 'string' ? item.ext : JSON.stringify(item.ext || {})
                }));
            };
            return {
                js_list: parseList(chars, 'c_18'),
                wq_list: parseList(weapons, 'c_20'),
                syw_list: parseList(stigmatas, 'c_19'),
                yq_list: parseList(elves, 'c_21'),      // 人偶
                hb_list: parseList(partners, 'c_218'),  // 协同者（与人偶分开，避免两个指令出同一份合并列表）
            };
        } catch (error) {
            logger.error('BH3 wiki访问失败:', error);
            return false;
        }
    }
    /*
原神
js,wq,syw 角色,武器,圣遗物 默认js
获取角色特有id,图标,星级,元素,武器类型
获取武器特有id,图标,星级,武器类型
获取圣遗物特有id,图标

传name回一个id，不传name回全部(包括名字)

星铁
js,gz,yq 角色,光锥,遗器
获取角色id,图标,星级,属性,命途
获取武器id,图标,星级,命途
获取遗器id,图标

绝区零
js,wq,syw,yq 角色,音擎,驱动盘,邦布
获取角色id,图标,星级,属性,强攻类型
获取音擎id,图标,星级,音擎类型
获取驱动盘id,图标
获取邦布id,图标

崩坏3
js,wq,syw,yq 角色,武器,圣痕,人偶
获取角色id,图标,星级,属性,角色名
获取武器id,图标,星级,武器类型
获取圣痕id,图标,星级,位置,属性
获取人偶id,图标
*/
    async data(name = '', type = 'js', isSr = false, isZZZ = false, isBH3 = false) {
        if (isZZZ) {
            return await this.zzz_data(name, type);
        }
        if (isBH3) {
            return await this.bh3_data(name, type);
        }
        let data = await this.tujian(isSr);
        if (!data) return false;
        let list = data.js_list;
        switch (type) {
            case 'wq':
                list = data.wq_list;
                break;
            case 'gz':
                list = data.gz_list;
                break;
            case 'syw':
                list = data.syw_list;
                if (name) return list;
                break;
            case 'yq':
                list = data.yq_list;
                if (name) return list;
        }
        let text;
        if (name) {
            // 官方 Wiki 标题可能带装饰符（实测「星神★阿哈」含 ★、「开拓者·毁灭」含 ·），
            // 原来的严格相等（只去空格）会让「阿哈」「星神阿哈」都匹配不上。
            // 改为「精确 -> 包含」两级匹配，与绝区零图鉴的匹配策略保持一致。
            const cleanKey = v => String(v || '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').toLowerCase();
            const target = cleanKey(name);
            let id;
            for (let va of list) {
                id = va.content_id;
                if (cleanKey(va.title) == target) return {
                    id
                };
            }
            // 包含匹配要求至少 2 个字，避免单字查询命中一堆无关条目
            if (target.length >= 2) {
                for (let va of list) {
                    id = va.content_id;
                    if (cleanKey(va.title).includes(target)) return {
                        id
                    };
                }
            }
            return false;
        } else {
            let names = [],
                ids = [],
                icons = [],
                jis = [],
                yuanshus = [],
                wuqis = [],
                shuxs = [],
                mingtus = [];
            data = [];
            for (let n in list) {
                const title = list[n].title.replace(/ /g, '');
                if (title.includes('预告')) continue;
                else if (title.includes('奇偶·')) continue;
                else if (title == '开拓者·毁灭') continue;
                names.push(title);
                ids.push(list[n].content_id);
                icons.push(list[n].icon);
                if (!['syw', 'yq'].includes(type)) {
                    text = JSON.parse(list[n].ext);
                    text = text.c_25 || text.c_5 || text.c_19 || text.c_18;
                    text = text.filter.text;
                    text = JSON.parse(text);
                    if (type == 'gz') {
                        for (let s of text) {
                            if (s.includes('星级')) jis.push(s.replace(/星级\//, ''));
                            else if (s.includes('命途')) mingtus.push(s.replace(/命途\//, ''));
                        }
                        continue;
                    }
                    if (type != 'wq') {
                        for (let s of text) {
                            if (s.includes('星级')) jis.push(s.replace(/星级\//, ''));
                            else if (s.includes('元素')) yuanshus.push(s.replace(/元素\//, ''));
                            else if (s.includes('武器')) wuqis.push(s.replace(/武器\//, ''));
                            else if (s.includes('属性')) shuxs.push(s.replace(/属性\//, ''));
                            else if (s.includes('命途')) mingtus.push(s.replace(/命途\//, ''));
                        }
                    } else {
                        for (let s of text) {
                            if (s.includes('武器星级')) jis.push(s.replace(/武器星级\//, ''));
                            else if (s.includes('武器类型')) wuqis.push(s.replace(/武器类型\//, ''));
                        }
                    }
                }
            }
            // 图鉴别名补缺
            //  const pa='./plugins/xhh/system/default/gz_names.yaml'
            //  const _data=yaml.get(pa)
            //  names.map(v=>{
            //     if(!_data[v]) _data[v]=[v]
            //  })
            //  fs.writeFileSync(pa,YAML.stringify(_data))

            names.map((v, i) => {
                data[i] = {
                    name: v,
                    id: ids[i],
                    icon: thumbIcon(JSON.parse(list[i].ext).c_30?.picture?.list[0] || icons[i]),
                    // 必须透传，list.html 的 onerror 靠它做兜底换图。
                    // 之前这里漏了字段，data-alt 恒为空串，整条兜底链从来没生效过。
                    iconFallback: list[i].iconFallback || '',
                    ji: jis[i],
                    yuanshu: yuanshus[i],
                    wuqi: wuqis[i],
                    shuxing: shuxs[i],
                    mingtu: mingtus[i],
                };
            });
            return data;
        }
    }

    // 绝区零数据获取
    async zzz_data(name = '', type = 'js') {
        let data = await this.zzz_tujian();
        if (!data) return false;
        let list = data.js_list;
        switch (type) {
            case 'wq':
                list = data.wq_list;
                break;
            // 驱动盘（syw）与邦布（yq）在绝区零是按名字单查的，不能像原神圣遗物那样
            // 传 name 就整表返回：调用方拿的是 ret.id，整表会导致邦布/驱动盘单查永远查不到
            case 'syw':
                list = data.syw_list;
                break;
            case 'yq':
                list = data.yq_list;
        }
        if (name) {
            const clean = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase();
            const target = clean(name);
            // 别名（英文名/代号）精确匹配优先，其次标题精确、再次标题包含兜底
            let found = list.find(va => (va.aliases || []).some(a => clean(a) === target));
            if (!found) found = list.find(va => clean(va.title) == target);
            // 兼容官方 Wiki 返回全名、nanoka 只用简称的情况，例如「雨果·维拉德」=>「雨果」
            if (!found) found = list.find(va => {
                const title = clean(va.title);
                return target && title && (title.includes(target) || target.includes(title));
            });
            // nanoka 数据版本滞后未收录新内容时，退回官方 Wiki 列表再匹配一次（如新代理人「菲欧妮·蕾法爱菈」）
            // official: true 标记 id 是官方 content_id，detail 应直接走官方源，避免拿官方 id 请求 nanoka 误触发冷却
            if (!found) {
                try {
                    const offList = (await this.zzz_official_tujian())?.[`${type}_list`] || [];
                    found = offList.find(va => {
                        const title = clean(va.title);
                        return target && title && target.length >= 2 && (title === target || title.includes(target) || target.includes(title));
                    });
                    if (found) {
                        // 官方详情缺星级/属性数值/技能等模板字段，优先回 nanoka 按简称匹配同一角色拿完整数据
                        // （如官方「菲欧妮·蕾法爱菈」→ nanoka「菲欧妮」；nanoka 不可用时才走官方详情）
                        if (!nanokaDown()) {
                            try {
                                const short = clean(String(found.title || '').split('·')[0]);
                                const cand = (data?.[`${type}_list`] || [])
                                    .filter(va => {
                                        const t = clean(va.title);
                                        return short && short.length >= 2 && (t === short || t.includes(short));
                                    })
                                    .sort((a, b) => clean(a.title).length - clean(b.title).length)[0];
                                if (cand) return { id: cand.content_id };
                            } catch (_) {}
                        }
                        return { id: found.content_id, official: true };
                    }
                } catch (_) {}
            }
            if (found) return { id: found.content_id };
            return false;
        } else {
            let names = [], ids = [], icons = [], jis = [], attributes = [], types = [], factions = [];
            data = [];
            for (let n in list) {
                const title = list[n].title.replace(/ /g, '');
                if (title.includes('预告')) continue;
                names.push(title);
                ids.push(list[n].content_id);
                icons.push(list[n].icon);
                let text = {};
                try { text = JSON.parse(list[n].ext || '{}'); } catch (_) {}
                text = text.filter?.text || text.c_43?.filter?.text || '[]';
                try { text = JSON.parse(text); } catch (_) { text = []; }
                for (let s of text) {
                    if (type === 'wq') {
                        if (s.includes('武器星级')) jis.push(s.replace(/武器星级\//, ''));
                        else if (s.includes('稀有度')) jis.push(s.replace(/稀有度\//, '') + '级');
                        else if (s.includes('武器类型')) types.push(s.replace(/武器类型\//, ''));
                        else if (s.includes('特性')) types.push(s.replace(/特性\//, ''));
                    } else {
                        if (s.includes('星级')) jis.push(s.replace(/星级\//, ''));
                        else if (s.includes('属性')) attributes.push(s.replace(/属性\//, ''));
                        else if (s.includes('强攻类型')) types.push(s.replace(/强攻类型\//, ''));
                    }
                }
            }
            names.map((v, i) => {
                let extObj = {};
                try { extObj = JSON.parse(list[i].ext || '{}'); } catch (_) {}
                data[i] = {
                    name: v,
                    id: ids[i],
                    icon: extObj.c_30?.picture?.list[0] || icons[i],
                    iconFallback: extObj.fallbackIcon || '',
                    ji: jis[i],
                    yuanshu: attributes[i],
                    wuqi: types[i],
                };
            });
            return data;
        }
    }

    // 崩坏3数据获取
    async bh3_data(name = '', type = 'js') {
        let data = await this.bh3_tujian();
        if (!data) return false;
        let list = data.js_list;
        switch (type) {
            case 'wq':
                list = data.wq_list;
                break;
            case 'syw':
                list = data.syw_list;
                break;
            case 'yq':
                list = data.yq_list;
                break;
            case 'hb':
                list = data.hb_list;
        }
        if (name) {
            const cleanName = String(name).replace(/[（(](上|中|下)[）)]|·(上|中|下)$|-(上|中|下)$/g, '').replace(/\s+/g, '');
            const isSetItem = va => {
                if (type !== 'syw') return true;
                try {
                    const ext = JSON.parse(va.ext || '{}');
                    const filters = JSON.parse(ext.c_19?.filter?.text || ext.filter?.text || '[]');
                    return filters.some(s => s.includes('圣痕构成') && s.includes('套装'));
                } catch (_) { return false; }
            };
            const matchTitle = va => {
                const cleanTitle = String(va.title).replace(/[（(](上|中|下)[）)]|·(上|中|下)$|-(上|中|下)$/g, '').replace(/\s+/g, '');
                return cleanTitle == cleanName || cleanTitle.startsWith(cleanName) || cleanName.startsWith(cleanTitle);
            };
            let found = list.find(va => matchTitle(va) && isSetItem(va));
            if (!found) found = list.find(va => matchTitle(va));
            if (found) return { id: found.content_id };
            return false;
        } else {
            data = [];
            const channelKey = type == 'wq' ? 'c_20' : type == 'syw' ? 'c_19' : type == 'js' ? 'c_18' : type == 'hb' ? 'c_218' : 'c_21';
            const normalizeDamageTypes = (text = '', title = '') => {
                const src = String(text || '');
                const result = [];
                const add = v => {
                    v = { 火焰: '火伤', 冰冻: '冰伤', 雷电: '雷伤', 物理属性: '物理' }[v] || v;
                    if (v && !result.includes(v)) result.push(v);
                };
                for (const m of src.matchAll(/物理属性|物理|火伤|冰伤|雷伤|火焰|冰冻|雷电|流血/g)) add(m[0]);
                return result;
            };
            for (let n in list) {
                const item = list[n];
                const title = item.title.replace(/ /g, '');
                if (title.includes('预告')) continue;

                let ji = '未知', attribute = '未知', damage = '', wuqi = type == 'syw' ? '未知' : '未知', isSet = 'false';
                let starRingField = '';
                const starRing = [];
                try {
                    const ext = JSON.parse(item.ext || '{}');
                    const filterText = ext[channelKey]?.filter?.text || ext.filter?.text || '[]';
                    const filters = JSON.parse(filterText);
                    for (let s of filters) {
                        if (s.includes('初始阶级')) {
                            const rank = s.replace('初始阶级/', '');
                            ji = rank === 'S' ? '五星' : '四星';
                        } else if (s.includes('星级') || s.includes('武器星级') || s.includes('圣痕星级') || s.includes('人偶星级')) {
                            ji = s.replace(/(武器|圣痕|人偶)?星级\//, '');
                        } else if (s.includes('属性')) {
                            attribute = s.replace('属性/', '');
                        } else if (s.includes('装甲特性')) {
                            damage = s.replace('装甲特性/', '');
                        } else if (s.includes('武器类型')) {
                            wuqi = s.replace('武器类型/', '');
                        } else if (s.startsWith('星之环分野/')) {
                            starRingField = s.slice('星之环分野/'.length).trim();
                        } else if (s.startsWith('星之环特性/')) {
                            const trait = s.slice('星之环特性/'.length).trim();
                            if (trait && !starRing.includes(trait)) starRing.push(trait);
                        } else if (s.includes('人偶类型')) {
                            wuqi = s.replace('人偶类型/', '');
                        } else if (s.includes('圣痕位置')) {
                            wuqi = s.replace('圣痕位置/', '');
                        } else if (s.includes('圣痕构成') && s.includes('套装')) {
                            isSet = 'true';
                        }
                    }
                } catch (err) {
                    try { if ((yaml.get('./plugins/xhh/config/config.yaml') || {}).debug) logger.mark(`[xhh] BH3 wiki ext解析失败: ${title}`); } catch (_) {}
                }

                const damageTypes = normalizeDamageTypes(damage, title);
                data.push({
                    name: title,
                    id: item.content_id,
                    icon: item.icon,
                    ji,
                    yuanshu: attribute,
                    wuqi,
                    damage: damageTypes,
                    abnormal: [],
                    starRingField,
                    starRing,
                    isSet
                });
            }
            // 2.0 之后部分角色/协同者的列表筛选项不再提供完整字段；
            // 从详情 basicIntroduction 补齐角色徽章及协同者星环特性。
            if (type === 'js' || type === 'hb') {
                const parseDetailFields = detail => {
                    const content = detail?.content || {};
                    const parts = [];
                    for (const section of content.contents || []) {
                        for (const match of String(section.text || '').matchAll(/data-data="([^"]+)"/g)) {
                            try {
                                const parsed = JSON.parse(decodeURIComponent(match[1]));
                                if (Array.isArray(parsed)) parts.push(...parsed);
                            } catch (_) {}
                        }
                    }
                    const basic = parts.find(v =>
                        v?.tmplKey === 'valkyrie' && v?.partKey === 'basicIntroduction'
                    )?.data || {};
                    const fields = (basic.mainFields || []).flatMap(v => [
                        { key: v.nameL, value: v.valueL },
                        { key: v.nameR, value: v.valueR }
                    ]);
                    const value = key => fields.find(v => v.key === key && String(v.value || '').trim())?.value || '';
                    const ring = fields.find(v => v.key === '星之环')?.value || '';
                    const subRing = (basic.subFields || []).find(v => v.name === '星之环')?.value || '';
                    const ringText = String(ring || subRing)
                        .replace(/<[^>]+>/g, '')
                        .replace(/&nbsp;/g, ' ');
                    const field = ringText.match(/分野\s*[：:]\s*(.*?)(?=特性\s*[：:]|$)/)?.[1] || '';
                    const traits = ringText.match(/特性\s*[：:]\s*(.*?)(?=注\s*[：:]|$)/)?.[1] || '';
                    // 协同者详情把星环特性标为「特征」（如“命运之轮”），
                    // 而非角色详情使用的「星之环」字段。
                    const collaboratorTrait = type === 'hb'
                        ? fields.find(v => /^(特征|星之环特性)$/.test(v.key) && String(v.value || '').trim())?.value || ''
                        : '';
                    const roleType = value('装甲特性') || value('角色定位');
                    const damage = normalizeDamageTypes(roleType, content.title);
                    // 异常状态不能从元素伤害直接推导：只有详情技能确实描述该异常的
                    // 积蓄值或伤害时才展示，避免把火伤误当点燃、冰伤误当冻结等。
                    const detailText = (content.contents || [])
                        .map(section => String(section.text || '')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/<[^>]+>/g, ' '))
                        .join(' ');
                    const abnormal = ['点燃', '冻结', '麻痹', '流血', '眩晕']
                        .filter(status => new RegExp(`${status}[^。；;]{0,30}(?:积蓄值|伤害)`).test(detailText));
                    return {
                        weapon: value('武器类型'),
                        damage,
                        abnormal,
                        starRingField: field.trim(),
                        starRing: String(collaboratorTrait || traits)
                            .split(/[、,，、\/；;]+/).map(v => v.trim()).filter(Boolean)
                    };
                };
                // 详情字段才是异常状态的可靠来源；即使列表已有武器/伤害字段，
                // 也要读取详情补齐真正拥有的异常状态徽章。
                for (let i = 0; i < data.length; i += 8) {
                    await Promise.all(data.slice(i, i + 8).map(async item => {
                        try {
                            const detail = await this.bh3_detail(item.id);
                            const fields = parseDetailFields(detail);
                            if (type === 'js') {
                                if (fields.weapon) item.wuqi = fields.weapon;
                                if (fields.damage) item.damage = fields.damage;
                                item.abnormal = fields.abnormal;
                            }
                            if (fields.starRingField) item.starRingField = fields.starRingField;
                            if (fields.starRing?.length) item.starRing = fields.starRing;
                        } catch (_) {}
                    }));
                }
            }
            return data;
        }
    }

    //获取详细信息
    async detail(id, isSr = false, isZZZ = false, isBH3 = false, zzzOfficial = false) {
        if (isZZZ) {
            return await this.zzz_detail(id, zzzOfficial);
        }
        if (isBH3) {
            return await this.bh3_detail(id);
        }
        // nanoka 优先。米游社的 entry_page 免鉴权会返回空 content（实测 retcode=0 但
        // content 是空串、ext 是 {}），也就是说这条链本来就得依赖用户 Cookie；
        // 换到 nanoka 后连 Cookie 都不需要了。
        if (!nanokaDown()) {
            try {
                const data = await this.nanoka_detail(id, isSr);
                if (data) return data;
                logger.warn?.('[xhh][图鉴] nanoka 详情为空，回退米游社官方 Wiki');
            } catch (error) {
                // 仅网络/接口类失败才全局降级，代码 bug 直接抛出（见 isTransientNetError）
                if (isTransientNetError(error)) markNanokaDown();
                logger.error('原神/星铁 nanoka 详情访问失败，切换米游社官方 Wiki:', error);
            }
        }
        let url = `https://api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page?app_sn=ys_obc&entry_page_id=${id}`;
        if (isSr)
            url = `https://api-static.mihoyo.com/common/blackboard/sr_wiki/v1/content/info?app_sn=sr_wiki&content_id=${id}`;
        let res;
        try {
            res = await fetch(url).then(res => res.json());
        } catch (error) {
            logger.error('米游社访问失败');
            return false;
        }
        return res.data;
    }

    /**
     * nanoka 版原神/星铁角色详情。
     * 返回 { content: <nanoka 原始对象> }，调用方用 isSr 判断渲染哪套模板。
     *
     * 星铁：ranks(星魂) / skills(技能, 含逐级数值) / unique.stats(1~80级属性成长)
     *       / skill_trees(行迹) / relics / chara_info(语音剧情)
     * 原神：skills(4个, 含等级缩放) / constellations(命座) / passives(天赋)
     *       / materials(突破材料) / attack / energy / chara_info
     */
    async nanoka_detail(id, isSr = false) {
        const game = isSr ? 'hsr' : 'gi';
        const base = await nanokaBase(game);
        if (!base) return false;
        const data = await this.fetchJson(`${base}/zh/character/${id}.json`, `${game} nanoka详情 ${id}`);
        if (!data || !data.name) return false;
        // 详情 JSON 里没有 id 字段，但立绘/技能图标全靠它拼，缺了会拼成
        // avatardrawcard/.webp 这种空地址
        return { content: { ...data, id: String(id), ...(isSr ? await this.hsr_detail_maps(base) : {}) }, nanoka: true };
    }

    /**
     * 星铁详情页要用到名字/图标，但都不在 character/{id}.json 里：
     *   培养材料  只有 item_id  → zh/item.json      取 item_name
     *   推荐光锥  只有 id       → lightcone.json    取 zh
     *   推荐遗器  只有 id       → relicset.json     取 zh
     * 三个文件都不小，按 base 缓存一次，别每个角色重拉。
     * （原神不用：突破材料的名字内联在 materials 里，图标又能由
     *   UI_ItemIcon_{item_id} 直接推出，实测 9/9 全 200。）
     */
    async hsr_detail_maps(base) {
        this._hsrMaps ||= {};
        if (this._hsrMaps[base]) return this._hsrMaps[base];
        const [item, lightcone, relicset] = await Promise.all([
            this.fetchJson(`${base}/zh/item.json`, 'hsr nanoka物品'),
            this.fetchJson(`${base}/lightcone.json`, 'hsr nanoka光锥'),
            this.fetchJson(`${base}/relicset.json`, 'hsr nanoka遗器'),
        ]);
        this._hsrMaps[base] = { itemMap: item || {}, lightconeMap: lightcone || {}, relicsetMap: relicset || {} };
        return this._hsrMaps[base];
    }

    // 绝区零详细信息（nanoka.cc 优先，米游社官方 Wiki 回退）
    // forceOfficial=true：id 已知是官方 content_id（来自 zzz_data 的官方兜底匹配），跳过 nanoka 直接走官方
    async zzz_detail(id, forceOfficial = false) {
        let type = id >= 1000 && id < 2000 ? 'js'
            : id >= 12000 && id < 20000 ? 'wq'
            : id >= 31000 && id < 40000 ? 'syw'
            : id >= 53000 && id < 60000 ? 'yq' : '';
        // 米游社官方 Wiki 的 content_id 并不沿用 nanoka 的编号区间，
        // 例如角色 1624、音擎 2162、邦布 2108，因此按分类列表补判一次。
        if (!type) {
            for (const candidate of ['js', 'wq', 'syw', 'yq']) {
                try {
                    const list = await this.zzz_official_list(candidate);
                    if (list.some(item => String(item.content_id) === String(id))) {
                        type = candidate;
                        break;
                    }
                } catch (_) {}
            }
        }
        if (!type) return false;
        // 冷却期内直接走官方 Wiki，不再请求已失效的 nanoka
        if (nanokaDown() || forceOfficial) {
            try {
                return await this.zzz_official_detail(id, type);
            } catch (fallbackError) {
                logger.error('ZZZ 官方 Wiki 详情访问失败:', fallbackError);
                return false;
            }
        }
        try {
            let url;
            if (type === 'js') {
                url = `${ZZZ_NANOKA_BASE}/zh/character/${id}.json`;
            } else if (type === 'wq') {
                url = `${ZZZ_NANOKA_BASE}/zh/weapon/${id}.json`;
            } else if (type === 'syw') {
                url = `${ZZZ_NANOKA_BASE}/zh/equipment/${id}.json`;
            } else if (type === 'yq') {
                url = `${ZZZ_NANOKA_BASE}/zh/bangboo/${id}.json`;
            }
            const res = await this.fetchJson(url, `ZZZ nanoka详情 ${id}`);
            if (type === 'wq') {
                try {
                    const list = await this.fetchJson(`${ZZZ_NANOKA_BASE}/weapon.json`, 'ZZZ nanoka音擎列表');
                    res.max_attack = list?.[String(id)]?.atk || 0;
                } catch (_) {}
            }
            return { content: res };
        } catch (error) {
            if (isTransientNetError(error)) markNanokaDown();
            logger.error('ZZZ nanoka详情访问失败，切换米游社官方 Wiki:', error);
            try {
                return await this.zzz_official_detail(id, type);
            } catch (fallbackError) {
                logger.error('ZZZ 官方 Wiki 详情访问失败:', fallbackError);
                return false;
            }
        }
    }

    // 崩坏3详细信息 (官方 wiki API)
    async bh3_detail(id) {
        try {
            const url = `${BH3_WIKI_BASE}/v1/content/info?app_sn=${BH3_APP_SN}&content_id=${id}`;
            const res = await fetch(url).then(r => r.json());
            if (res.retcode !== 0) return false;
            return { content: res.data.content };
        } catch (error) {
            logger.error('BH3 wiki详情访问失败:', error);
            return false;
        }
    }
}
export default new mys();
