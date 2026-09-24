import fs from 'fs';
import { yaml } from '#xhh';

// 卡池计时器 / UP 总览数据层
// 原神、星铁、绝区零：抓取 wiki.biligame.com 的「卡池计时器」页面（MediaWiki，静态渲染，无需鉴权）
// 崩坏3：该站没有对应页面，改用插件自带的崩三卡池史料（system/default/bh3_gacha_pool_history.yaml | .json）统计

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_NAME = '卡池计时器';
const DAY = 86400000;

export const TIMER_GAMES = {
    ys: { key: 'ys', name: '原神', source: 'BWiki·原神', url: `https://wiki.biligame.com/ys/${encodeURIComponent(PAGE_NAME)}` },
    sr: { key: 'sr', name: '星穹铁道', source: 'BWiki·星穹铁道', url: `https://wiki.biligame.com/sr/${encodeURIComponent(PAGE_NAME)}` },
    zzz: { key: 'zzz', name: '绝区零', source: 'BWiki·绝区零', url: `https://wiki.biligame.com/zzz/${encodeURIComponent(PAGE_NAME)}` },
    bh3: { key: 'bh3', name: '崩坏3', source: '本地卡池史料库', url: '' },
};

const BH3_YAML_PATH = './plugins/xhh/system/default/bh3_gacha_pool_history.yaml';
const BH3_JSON_PATH = './plugins/xhh/system/default/bh3_gacha_pool_history.json';
const BH3_JS_NAMES_PATH = './plugins/xhh/system/default/bh3_js_names.yaml';

const CACHE = new Map();

function cached(key, ttl, fn) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = fn();
    CACHE.set(key, { t: Date.now(), v });
    return v;
}

async function cachedAsync(key, ttl, fn) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    CACHE.set(key, { t: Date.now(), v });
    return v;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// biligame 偶尔返回 567（风控页），这里重试到拿到正常长度的正文
async function fetchPage(url) {
    for (let i = 0; i < 4; i++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            const res = await globalThis.fetch(url, {
                headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
                signal: controller.signal,
            });
            const text = await res.text();
            clearTimeout(timer);
            if (res.ok && text.length > 50000) return text;
            globalThis.logger?.warn(`[xhh][卡池计时器] 第${i + 1}次抓取异常: HTTP ${res.status} ${text.length}字节`);
        } catch (err) {
            globalThis.logger?.warn(`[xhh][卡池计时器] 第${i + 1}次抓取失败: ${err?.message || err}`);
        }
        await sleep(2000);
    }
    return '';
}

function parseCard(card, game, group) {
    // 名称：优先取头像链接的 title，其次 data-name，最后取文本里的第一个链接
    let name = (card.match(/<div class="Gacha-img">[\s\S]{0,600}?title="([^"]+)"/) || [])[1] || '';
    if (!name) name = (card.match(/data-name="([^"]+)"/) || [])[1] || '';
    if (!name) name = (card.match(/<div><a[^>]*>([^<]+)<\/a><\/div>/) || [])[1] || '';
    name = String(name).trim();
    if (!name) return null;

    const times = Number((card.match(/UP次数：(\d+)次/) || [])[1] || 0);
    const version = String((card.match(/UP版本：([^<]+)/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const date = String((card.match(/UP时间：([0-9/]+)/) || [])[1] || '').trim();
    const days = Number((card.match(/计时：(\d+)天/) || [])[1] || -1);
    const icon = String((card.match(/src="(https:\/\/patchwiki\.biligame\.com\/[^"]+)"/) || [])[1] || '');

    return {
        game,
        group,
        name,
        times,
        version,
        date,
        days,
        icon,
        current: /现在/.test(version),
    };
}

// 页面用 <div class="Gacha"> 卡片陈列，分组放在 <div class="resp-tab-content"> 段落里
// （标题是该段第一个 mw-headline，如 五星角色 / 四星角色 / 五星武器 …）
function parseGachaPage(html, game) {
    const out = [];
    if (!html) return out;

    const sections = html.split(/<div class="resp-tab-content"/).slice(1);
    for (const sec of sections) {
        const head = String((sec.match(/class="mw-headline"[^>]*>([^<]+)<\/span>/) || [])[1] || '').trim();
        const cards = sec.split(/<div class="Gacha"/).slice(1);
        for (const card of cards) {
            const item = parseCard(card.slice(0, 4000), game, head);
            if (item) out.push(item);
        }
    }

    // 少数卡片挂在折叠面板里（如原神的常驻五星），补一遍，标题取 panel-title
    if (!out.length) {
        for (const pan of html.split(/<span class="panel-title pull-left">/).slice(1)) {
            const title = String((pan.match(/>([^<>]+)</) || [])[1] || '').trim();
            for (const card of pan.split(/<div class="Gacha"/).slice(1)) {
                const item = parseCard(card.slice(0, 4000), game, title);
                if (item) out.push(item);
            }
        }
    }
    return out;
}

async function wikiItems(game) {
    const meta = TIMER_GAMES[game];
    if (!meta?.url) return [];
    return cachedAsync(`timer-${game}`, 12 * 3600 * 1000, async () => {
        const html = await fetchPage(meta.url);
        const items = parseGachaPage(html, game);
        if (!items.length) globalThis.logger?.warn(`[xhh][卡池计时器] ${game} 解析到 0 条数据`);
        return items;
    });
}

/* ---------------- 崩三：本地史料库 ---------------- */

function loadBh3History() {
    return cached('bh3-history', 30 * 60 * 1000, () => {
        try {
            const data = yaml.get(BH3_YAML_PATH);
            if (data?.pools?.length) return data;
        } catch (err) {
            globalThis.logger?.warn(`[xhh][卡池计时器] 崩三 YAML 读取失败: ${err?.message || err}`);
        }
        try {
            const data = JSON.parse(fs.readFileSync(BH3_JSON_PATH, 'utf8'));
            if (data?.pools?.length) return data;
        } catch (err) {
            globalThis.logger?.warn(`[xhh][卡池计时器] 崩三 JSON 读取失败: ${err?.message || err}`);
        }
        return null;
    });
}

function bh3Items() {
    return cached('bh3-timer', 6 * 3600 * 1000, () => {
        const data = loadBh3History();
        if (!data) return [];
        const map = new Map();
        const dedup = new Set();
        for (const block of data.pools || []) {
            const version = String(block.version || '');
            for (const pool of block.pools || []) {
                const end = String(pool.end || block.end || '');
                const start = String(pool.start || block.start || '');
                const add = (rawName, kind) => {
                    const name = String(rawName || '').replace(/[（(].*?[)）]/g, '').trim();
                    if (!name) return;
                    const key = `${kind}|${name}`;
                    const slot = `${key}|${version}|${end}`;
                    if (dedup.has(slot)) return;
                    dedup.add(slot);
                    if (!map.has(key)) map.set(key, { name, kind, times: 0, version: '', date: '', end: '' });
                    const o = map.get(key);
                    o.times += 1;
                    if (end && (!o.end || String(end) > String(o.end))) {
                        o.end = end;
                        o.version = version;
                        o.date = end.slice(0, 10).replace(/-/g, '/');
                    } else if (!end && start) {
                        o.date = o.date || start.slice(0, 10).replace(/-/g, '/');
                    }
                };
                add(pool.s, pool.type === 'char' ? '角色' : '装备');
                add(pool.target, '装备');
                (pool.a || []).forEach(a => add(a, pool.type === 'char' ? '陪跑角色' : '陪跑装备'));
            }
        }
        const now = Date.now();
        return [...map.values()].map(o => {
            let days = -1;
            if (o.end) {
                const ts = new Date(String(o.end).replace(/-/g, '/')).getTime();
                if (Number.isFinite(ts)) days = Math.floor((now - ts) / DAY);
            }
            return {
                game: 'bh3',
                group: o.kind,
                name: o.name,
                times: o.times,
                version: o.version,
                date: o.date,
                days,
                icon: '',
                current: days >= 0 && days < 1,
            };
        });
    });
}

/* ---------------- 崩三头像（baike.mihoyo 全局搜索补齐） ---------------- */

const BH3_WIKI_API = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki';
const BH3_ICON_TTL = 12 * 3600 * 1000;
// 搜索结果里的攻略/视频帖没有参考价值，跳过
const BH3_ICON_NOISE = /版本|攻略|教学|指南|前瞻|阵容|装配|推荐|测评|PV|剧情|动画/i;

async function bh3Search(keyword) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await globalThis.fetch(
            `${BH3_WIKI_API}/v1/search/content?app_sn=bh3_wiki&keyword=${encodeURIComponent(keyword)}&size=10`,
            { headers: { 'User-Agent': UA, Referer: 'https://baike.mihoyo.com/bh3/wiki/' }, signal: controller.signal }
        );
        if (!res.ok) return [];
        const j = await res.json();
        return j?.data?.list || [];
    } catch (err) {
        globalThis.logger?.warn(`[xhh][卡池计时器] 崩三头像搜索失败「${keyword}」: ${err?.message || err}`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

// 依次放宽：词条完全一致 → 去掉【】后缀/前后包含（优先「女武神」角色词条）
function pickBh3Entry(entryList, keyword) {
    const q = cleanName(keyword);
    if (!q) return null;
    let exact = null, exactRole = null, loose = null;
    for (const v of entryList) {
        const title = String(v?.title || '').trim();
        if (!title) continue;
        const t = cleanName(title.replace(/【[^】]*】/g, ''));
        if (!t) continue;
        const hasIcon = /^https:\/\//.test(String(v?.icon || ''));
        const ch = Array.isArray(v?.channels) ? v.channels[0] : v?.channels;
        const isRole = String(ch?.channel_id || '') === '18';
        if (t === q) {
            if (isRole && !exactRole) exactRole = v;
            if (!exact) exact = v;
        } else if (!loose && t.includes(q) && !BH3_ICON_NOISE.test(title) && hasIcon) {
            loose = v;
        }
    }
    return exactRole || exact || loose;
}

// 角色立绘：详情页 valkyrie/basicIntroduction 模板的 data.avatar（比词条封面头像更完整）
async function bh3ContentAvatar(id) {
    if (!id) return '';
    const key = `bh3avatar-${id}`;
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < BH3_ICON_TTL) return hit.v;
    let avatar = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await globalThis.fetch(
            `${BH3_WIKI_API}/v1/content/info?app_sn=bh3_wiki&content_id=${encodeURIComponent(id)}`,
            { headers: { 'User-Agent': UA, Referer: 'https://baike.mihoyo.com/bh3/wiki/' }, signal: controller.signal }
        );
        if (res.ok) {
            const j = await res.json();
            const text = (j?.data?.content?.contents || []).map(c => String(c?.text || '')).join('');
            for (const m of text.matchAll(/data-data="([^"]+)"/g)) {
                try {
                    const arr = JSON.parse(decodeURIComponent(m[1]));
                    const part = (Array.isArray(arr) ? arr : []).find(p => p?.tmplKey === 'valkyrie' && p?.data?.avatar);
                    if (part) { avatar = String(part.data.avatar); break; }
                } catch (_) {}
            }
            if (!avatar) {
                avatar = (decodeURIComponent(text).match(/"avatar":"(https:\/\/[^"]+)"/) || [])[1] || '';
            }
        }
    } catch (err) {
        globalThis.logger?.warn(`[xhh][卡池计时器] 崩三立绘获取失败 id=${id}: ${err?.message || err}`);
    } finally {
        clearTimeout(timer);
    }
    CACHE.set(key, { t: Date.now(), v: avatar });
    return avatar;
}

async function bh3Icon(name) {
    const q = cleanName(name);
    if (!q) return '';
    const key = `bh3icon-${q}`;
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < BH3_ICON_TTL) return hit.v;

    // 多级尝试：全名 → 去括号 → 按 · 拆词 → 末两字（如「神州折剑」的词条叫「XX·折剑(上)」）
    const tries = [name, String(name).replace(/[（(][^)）]*[)）]/g, '').trim()];
    for (const seg of String(name).split(/[·・]/)) {
        const s = seg.trim();
        if (s && cleanName(s).length >= 2 && !tries.includes(s)) tries.push(s);
    }
    let icon = '';
    for (const kw of tries) {
        if (icon) break;
        const entry = pickBh3Entry(await bh3Search(kw), kw);
        if (!entry) continue;
        // 优先角色立绘，失败回退词条封面（头像）
        if (entry.id) {
            const avatar = await bh3ContentAvatar(entry.id);
            if (avatar) { icon = avatar; break; }
        }
        if (/^https:\/\//.test(String(entry.icon || ''))) icon = String(entry.icon);
    }
    CACHE.set(key, { t: Date.now(), v: icon });
    return icon;
}

// 就地补齐 bh3 条目的 icon（只处理没图的，并发 6）
async function fillBh3Icons(items) {
    const targets = items.filter(v => v?.game === 'bh3' && !v.icon && v.name);
    if (!targets.length) return;
    for (let i = 0; i < targets.length; i += 6) {
        await Promise.all(targets.slice(i, i + 6).map(async v => {
            v.icon = await bh3Icon(v.name);
        }));
    }
}

/* ---------------- 对外方法 ---------------- */

async function list(game) {
    if (game === 'bh3') return bh3Items();
    return await wikiItems(game);
}

function cleanName(name = '') {
    return String(name || '').toLowerCase().replace(/[\s·・:：\-—_（）()【】「」『』《》"'"'、，,。.!！?？*]/g, '');
}

/**
 * 查询某角色/武器的 UP 记录
 * @param {string} keyword 名称
 * @param {string} game 限定游戏，all 为全部
 */

// 崩三：把用户输入的名称经图鉴别名表归一化到主名（规则与 apps/wiki.js 的 resolveBh3RoleAlias 一致）
function loadBh3JsNames() {
    return cached('bh3-js-names', 30 * 60 * 1000, () => {
        try { return yaml.get(BH3_JS_NAMES_PATH) || {}; } catch (err) {
            globalThis.logger?.warn(`[xhh][卡池计时器] 崩三别名表读取失败: ${err?.message || err}`);
            return {};
        }
    });
}
function resolveBh3Alias(name = '') {
    const roleNames = loadBh3JsNames();
    if (roleNames[name]) return name;
    const clean = String(name || '').replace(/[\s·・!！♪♥☆★「」『』:：-]/g, '').toLowerCase();
    if (!clean) return '';
    let first = '';
    for (const [role, aliases] of Object.entries(roleNames)) {
        const list = [role, ...(Array.isArray(aliases) ? aliases : [])];
        for (const alias of list) {
            const a = String(alias || '').replace(/[\s·・!！♪♥☆★「」『』:：-]/g, '').toLowerCase();
            if (!a) continue;
            if (a === clean) return role;
            if (!first && (a.includes(clean) || clean.includes(a))) first = role;
        }
    }
    return first;
}
async function find(keyword, game = 'all', limit = 12) {
    const q = cleanName(keyword);
    if (!q) return [];
    const games = game === 'all' ? ['ys', 'sr', 'zzz', 'bh3'] : [game];
    const out = [];
    for (const g of games) {
        let items = [];
        try {
            items = await list(g);
        } catch (err) {
            globalThis.logger?.warn(`[xhh][卡池计时器] ${g} 数据加载失败: ${err?.message || err}`);
            continue;
        }
        for (const it of items) {
            const n = cleanName(it.name);
            if (!n) continue;
            if (n === q || n.includes(q) || (q.length >= 3 && q.includes(n))) out.push(it);
        }
    }

    // 崩三：图鉴里常用的别名/简称（如「星辰爱莉」「爱莉希雅」）不在史料库的 s/a/target 字段里，
    // 单独再走一遍别名归一化，把关键词映射到主名后再匹配一次。
    if (games.includes('bh3')) {
        const aliasKey = resolveBh3Alias(keyword);
        if (aliasKey) {
            const aq = cleanName(aliasKey);
            const bh3Items2 = await list('bh3');
            for (const it of bh3Items2) {
                const n = cleanName(it.name);
                if (!n) continue;
                if (n === aq || n.includes(aq) || (aq.length >= 3 && aq.includes(n))) {
                    if (!out.includes(it)) out.push(it);
                }
            }
        }
    }
    const hits = out.sort((a, b) => {
        const ae = cleanName(a.name) === q ? 0 : 1;
        const be = cleanName(b.name) === q ? 0 : 1;
        if (ae !== be) return ae - be;
        return (b.days ?? -1) - (a.days ?? -1);
    }).slice(0, limit);
    // 崩三条目补头像（之前写在 return 后面，永远执行不到，单条查询一直没图）
    await fillBh3Icons(hits);
    return hits;
}

/**
 * UP 总览：当期正在 UP 的条目 + 最久没复刻的排行
 */
async function overview(game, topN = 15) {
    const items = await list(game);
    const valid = items.filter(v => (v.days ?? -1) >= 0);
    // 页面不直接给「正在UP」标记，用最近 25 天内 UP 过近似（一个版本周期约为 21~42 天）
    const running = valid
        .filter(v => v.current || v.days <= 25)
        .sort((a, b) => (a.days ?? 999) - (b.days ?? 999))
        .slice(0, 12);
    const ranking = valid
        .filter(v => !running.includes(v))
        .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
        .slice(0, topN);
    await fillBh3Icons([...running, ...ranking]);
    return {
        game,
        name: TIMER_GAMES[game]?.name || '',
        source: TIMER_GAMES[game]?.source || '',
        url: TIMER_GAMES[game]?.url || '',
        total: items.length,
        running,
        ranking,
    };
}

export default {
    TIMER_GAMES,
    list,
    find,
    overview,
    cleanName,
};
