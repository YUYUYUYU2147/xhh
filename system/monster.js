// 统一用运行环境内置的 fetch（Node 18+），不额外依赖 node-fetch
const doFetch = typeof fetch === 'function' ? fetch : globalThis.fetch;

// 怪物/BOSS 图鉴数据层
// 数据源：原神 / 星穹铁道 -> Alioth.wiki 静态 JSON
//         绝区零        -> Nanoka.cc 静态资源
//         崩坏3         -> 圣芙蕾雅档案馆（baike.mihoyo.com/bh3/wiki）公开 blackboard 接口

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) xhh-monster';
const ALIOTH_DATA = 'https://json.alioth.wiki/data';
const ALIOTH_IMG = 'https://transform.alioth.wiki/i';
const NANOKA_STATIC = 'https://static.nanoka.cc';
const NANOKA_MANIFEST = 'https://static.nanoka.cc/manifest.json';
const BH3_API = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki';
const BH3_HEADERS = { 'User-Agent': UA, Referer: 'https://baike.mihoyo.com/bh3/wiki/' };
const BH3_ENEMY_CHANNEL = 47; // 图鉴 > 敌人

const CACHE = new Map();

export const MONSTER_GAMES = {
    gs: { key: 'gs', name: '原神', short: 'GENSHIN IMPACT', source: 'Alioth.wiki' },
    sr: { key: 'sr', name: '星穹铁道', short: 'STAR RAIL', source: 'Alioth.wiki' },
    zzz: { key: 'zzz', name: '绝区零', short: 'ZENLESS ZONE ZERO', source: 'Nanoka.cc' },
    bh3: { key: 'bh3', name: '崩坏3', short: 'HONKAI IMPACT', source: '圣芙蕾雅档案馆' },
};

const GI_COLOR = { Fire: '火', Water: '水', Grass: '草', Elec: '雷', Ice: '冰', Wind: '风', Rock: '岩', None: '无' };
const SR_WEAK = { Phys: '物理', Fire: '火', Ice: '冰', Wind: '风', Elec: '雷', Quantum: '量子', Imaginary: '虚数' };
const ZZZ_ELEMENT = { ice: '冰', fire: '火', electric: '电', ether: '以太', physical: '物理', wind: '风' };
// nanoka 给出的标签是英文字段名，挑常见的翻一下，认不出的保留原文
const ZZZ_TAG = {
    Ether: '以太', Small: '小型', Middle: '中型', Large: '大型',
    LittleMonster: '杂兵', BigMonster: '巨形', Boss: 'BOSS', Elite: '精英',
    Demote: '弱化', Corrosion: '侵蚀',
};

// 原神里这些分类基本等同于 BOSS / 高难敌人，给金色描边便于一眼区分
const GI_ELITE_KINGDOMS = ['值得铭记的强敌', '地方传奇', '历经百战', '幽境危战', '深渊'];
// 周本 / 世界 BOSS（图鉴里单独归类的那批）
const GI_BOSS_KINGDOMS = ['值得铭记的强敌'];

// 统一分级：BOSS > 精英 > 小怪，图鉴列表按这个顺序排，方框按等级配色
export const RANK_ORDER = { boss: 0, elite: 1, normal: 2 };
export const RANK_LABEL = { boss: 'BOSS', elite: '精英', normal: '小怪' };
export const RANK_CLASS = { boss: 'rank-boss', elite: 'rank-elite', normal: 'rank-normal' };
const rankClassOf = (rank) => RANK_CLASS[rank] || RANK_CLASS.normal;

// 图鉴列表排序：先按 BOSS→精英→小怪，同级再按名称
export function sortByRank(items = []) {
    return [...items].sort((a, b) => {
        const d = (RANK_ORDER[a?.rank] ?? 2) - (RANK_ORDER[b?.rank] ?? 2);
        if (d !== 0) return d;
        return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh');
    });
}

function stripHtml(input = '') {
    return String(input || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// 名称归一：去标点空白，便于「苍白之火-陨星」这类写法也能命中
function cleanName(name = '') {
    return String(name || '')
        .toLowerCase()
        .replace(/[\s·・:：\-—_（）()【】「」『』《》"'"'、，,。.!！?？*]/g, '');
}

async function cached(key, ttl, fn) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    CACHE.set(key, { t: Date.now(), v });
    return v;
}

async function getJson(url, headers = {}, ttl = 12 * 3600 * 1000) {
    return cached(url, ttl, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await doFetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: controller.signal });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    });
}

/* ---------------- 原神：Alioth.wiki ---------------- */

function giIcon(icon = '') {
    if (!icon) return '';
    const file = String(icon).replace(/\.png$/i, '');
    const dir = /^UI_Img_LeyLineChallenge/i.test(file) ? 'LeyLineChallenge' : 'MonsterIcon';
    return `${ALIOTH_IMG}/gi/${dir}/${file}.png?w=128&f=auto`;
}

async function giData() {
    return cached('gi-monster', 12 * 3600 * 1000, async () => {
        const json = await getJson(`${ALIOTH_DATA}/gi/ch/monster.json`);
        const templates = json.Templates || {};
        const kingdomLabel = new Map((json.Kingdoms || []).map(k => [String(k._id), k.slabel ? `${k.label}(${k.slabel})` : k.label]));
        // 每个怪物归属到 kingdom（分类）与家族（如「雷音权现」下的多个变体）
        const meta = new Map();
        for (const [kid, groups] of Object.entries(json.KingdomMons || {})) {
            for (const g of groups || []) {
                for (const id of g.Monsters || []) {
                    if (!meta.has(String(id))) meta.set(String(id), { kingdom: kingdomLabel.get(kid) || '', family: g.Name || '' });
                }
            }
        }
        const items = Object.entries(templates).map(([id, t]) => {
            const info = meta.get(id) || {};
            const element = GI_COLOR[t.Color] || '';
            const kingdom = info.kingdom || '';
            const rank = GI_BOSS_KINGDOMS.includes(kingdom) ? 'boss' : GI_ELITE_KINGDOMS.includes(kingdom) ? 'elite' : 'normal';
            return {
                id,
                name: t.Name || '',
                icon: giIcon(t.Icon),
                element,
                kingdom,
                family: info.family || '',
                hp: t.HP ?? null,
                hpCount: t.HPCount ?? null,
                rank,
                rankClass: rankClassOf(rank),
                tags: [kingdom, element].filter(Boolean),
            };
        });
        const families = new Map();
        items.forEach(it => {
            if (!it.family) return;
            if (!families.has(it.family)) families.set(it.family, []);
            families.get(it.family).push({ id: it.id, name: it.name, icon: it.icon });
        });
        return { items, families };
    });
}

/* ---------------- 星穹铁道：Alioth.wiki ---------------- */

function srIcon(icon = '') {
    if (!icon) return '';
    return `${ALIOTH_IMG}/sr/${String(icon).replace(/\.png$/i, '')}.png?w=128&f=auto`;
}

// 星铁血条数可能是数字，也可能是 "(1+1+1.5)" 这种分阶段写法，统一换算成段数
function srBars(hpCount) {
    const s = String(hpCount ?? 0);
    const m = s.match(/\(([^)]+)\)/);
    if (m) return m[1].split('+').filter(Boolean).length;
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}

async function srData() {
    return cached('sr-monster', 12 * 3600 * 1000, async () => {
        const json = await getJson(`${ALIOTH_DATA}/hsr/ch/monster.json`);
        const names = json.KingdomNames || {};
        const items = (json.Templates || []).map(t => {
            const weak = (t.Weak || []).map(w => SR_WEAK[w] || w);
            const bars = srBars(t.HPCount);
            // 三段血以上基本是周本/大 BOSS，两段是精英
            const rank = bars >= 3 ? 'boss' : bars === 2 ? 'elite' : 'normal';
            return {
                id: String(t._id),
                name: t.Name || '',
                icon: srIcon(t.Icon),
                image: srIcon(t.Figure),
                camp: names[String(t.Camp)] || names[t.Camp] || '',
                weak,
                stats: t.Stats || {},
                hpCount: t.HPCount ?? null,
                isBug: !!t.IsBug,
                isNew: !!t.New,
                bars,
                rank,
                rankClass: rankClassOf(rank),
                tags: [names[String(t.Camp)] || '', ...weak.slice(0, 3)].filter(Boolean),
            };
        });
        return { items };
    });
}

/* ---------------- 绝区零：Nanoka.cc ---------------- */

async function zzzVersion() {
    return cached('zzz-ver', 6 * 3600 * 1000, async () => {
        try {
            const manifest = await getJson(NANOKA_MANIFEST, {}, 6 * 3600 * 1000);
            const available = manifest?.zzz?.available || [];
            const latest = manifest?.zzz?.latest || available[available.length - 1];
            if (latest) return latest;
        } catch (err) {
            globalThis.logger?.warn(`[xhh][monster] Nanoka manifest 获取失败: ${err?.message || err}`);
        }
        return '3.3.3+19110104';
    });
}

function zzzIcon(imagePath = '') {
    if (!imagePath) return '';
    const file = String(imagePath).split('/').pop() || '';
    if (!file) return '';
    return `${NANOKA_STATIC}/assets/zzz/${file.replace(/\.png$/i, '.webp')}`;
}

// 绝区零：优先用 rarity 字段（3=首领 / 2=精英），字段缺失时按名称、种类、标签里的关键词兜底，
// 否则整份清单都会落到「小怪」档，看起来就像没排序。
function zzzRank(m) {
    const r = Number(m?.rarity ?? m?.rank ?? m?.star ?? NaN);
    if (Number.isFinite(r) && r > 0) return r >= 3 ? 'boss' : r === 2 ? 'elite' : 'normal';
    const txt = [m?.zh, m?.en, m?.group_desc, m?.type, ...(Array.isArray(m?.tag) ? m.tag : [m?.tag])].filter(Boolean).join(' ');
    if (/boss|首领|霸主/i.test(txt)) return 'boss';
    if (/elite|精英|强敌|上级|高等/i.test(txt)) return 'elite';
    return 'normal';
}

async function zzzData() {
    return cached('zzz-monster', 12 * 3600 * 1000, async () => {
        const version = await zzzVersion();
        const json = await getJson(`${NANOKA_STATIC}/zzz/${encodeURIComponent(version)}/monster.json`);
        const items = Object.entries(json || {}).map(([id, m]) => {
            const rarity = m.rarity ?? 1;
            const rank = zzzRank(m);
            return {
                id,
                name: m.zh || m.en || '',
                icon: zzzIcon(m.icon || m.image_path || ''),
                rarity,
                group: m.group ?? null,
                groupDesc: m.group_desc || '',
                rank,
                rankClass: rankClassOf(rank),
                tags: [m.group_desc].filter(Boolean),
            };
        });
        return { items, version };
    });
}

async function zzzDetailRaw(id, version) {
    return cached(`zzz-detail-${version}-${id}`, 24 * 3600 * 1000, async () => {
        const json = await getJson(`${NANOKA_STATIC}/zzz/${encodeURIComponent(version)}/zh/monster/${id}.json`);
        return json || null;
    });
}

/* ---------------- 崩坏3：圣芙蕾雅档案馆 ---------------- */

// 列表条目的 ext 是 JSON 字符串，里面挂着「敌人类型/BOSS」这类筛选标签
function bh3EnemyType(ext = '') {
    try {
        const text = JSON.parse(ext)?.c_47?.filter?.text;
        const arr = typeof text === 'string' ? JSON.parse(text) : text;
        return String((arr || [])[0] || '');
    } catch (_) {
        return '';
    }
}

// 详情页里的「怪物类型」才是 BOSS / 精英 / 普通 三档，列表接口只给到 BOSS / 非BOSS；
// 顺带把「怪物属性」（机械/生物/异能/量子/虚数）和「伤害类型」也提出来当标签。
// 后台逐个补全一次（结果按 id 缓存，进程内只跑一轮）。
const bh3RankCache = new Map();
let bh3RankEnriching = false;

// 把详情页 mainFields 整理成 {字段名: 值}
function bh3MonsterRows(raw) {
    const rows = bh3Parse(raw)?.rows || [];
    const map = {};
    for (const v of rows) map[v.k] = v.v;
    return map;
}

const bh3RankOf = (type) => type === 'BOSS' ? 'boss' : type === '精英' ? 'elite' : 'normal';

// 标签 = 属性（无属性不显示）+ 敌人类型；和等级徽标重复的（如 BOSS）去掉
function bh3Tags(it) {
    const out = [];
    const push = t => { if (t && !out.includes(t) && t !== RANK_LABEL[it.rank]) out.push(t); };
    push(it.attr && it.attr !== '无' ? it.attr : '');
    push(it.type);
    return out;
}

function bh3ApplyCached(it) {
    const cached = bh3RankCache.get(it.id);
    if (!cached) return;
    if (cached.rank && cached.rank !== it.rank) {
        it.rank = cached.rank;
        it.rankClass = rankClassOf(cached.rank);
    }
    if (cached.attr) it.attr = cached.attr;
    if (cached.damage) it.damage = cached.damage;
    it.tags = bh3Tags(it);
}

async function bh3EnrichRanks(items) {
    if (bh3RankEnriching) return;
    const pending = items.filter(v => !bh3RankCache.has(v.id));
    if (!pending.length) return;
    bh3RankEnriching = true;
    try {
        const queue = [...pending];
        const worker = async () => {
            while (queue.length) {
                const it = queue.shift();
                try {
                    const map = bh3MonsterRows(await bh3DetailRaw(it.id));
                    if (map['怪物类型'] || map['怪物属性']) {
                        bh3RankCache.set(it.id, {
                            rank: bh3RankOf(map['怪物类型']),
                            attr: map['怪物属性'] || '',
                            damage: map['伤害类型'] || '',
                        });
                    }
                } catch (_) {}
            }
        };
        await Promise.all(Array.from({ length: 8 }, () => worker()));
        for (const it of items) bh3ApplyCached(it);
        globalThis.logger?.mark?.(`[xhh][monster] 崩三敌人等级/属性补全完成：${bh3RankCache.size} 条`);
    } finally {
        bh3RankEnriching = false;
    }
}

// 图鉴 > 敌人（channel 47）的全量列表，206 条左右，带图标与 BOSS/非BOSS 标记
async function bh3Data() {
    return cached('bh3-monster', 12 * 3600 * 1000, async () => {
        const json = await getJson(`${BH3_API}/v1/home/content/list?app_sn=bh3_wiki&channel_id=${BH3_ENEMY_CHANNEL}`, BH3_HEADERS);
        const items = [];
        for (const group of json?.data?.list || []) {
            for (const v of group?.list || []) {
                if (!v?.content_id) continue;
                const type = bh3EnemyType(v.ext).replace(/^敌人类型\//, '');
                const item = {
                    id: String(v.content_id),
                    name: v.title || '',
                    icon: v.icon || '',
                    type: type || '',
                    attr: '',
                    damage: '',
                    // 先按列表标记兜底（BOSS / 非BOSS），等级/属性由后台按详情补全
                    rank: type === 'BOSS' ? 'boss' : 'normal',
                };
                item.rankClass = rankClassOf(item.rank);
                item.tags = bh3Tags(item);
                bh3ApplyCached(item); // 命中缓存时直接带上等级/属性
                items.push(item);
            }
        }
        // 不阻塞本次返回：先出图，等级在后台慢慢补全，下一次列表就是三档了
        setTimeout(() => { bh3EnrichRanks(items).catch(() => {}); }, 0);
        return { items };
    });
}

async function bh3Search(keyword, limit = 10) {
    const json = await getJson(
        `${BH3_API}/v1/search/content?app_sn=bh3_wiki&channel_id=${BH3_ENEMY_CHANNEL}&keyword=${encodeURIComponent(keyword)}`,
        BH3_HEADERS,
        30 * 60 * 1000
    );
    return (json?.data?.list || []).slice(0, limit).map(v => ({
        id: String(v.id),
        name: v.title || '',
        icon: v.icon || '',
        summary: stripHtml(v.summary || '').slice(0, 60),
    }));
}

async function bh3DetailRaw(id) {
    return cached(`bh3-detail-${id}`, 24 * 3600 * 1000, async () => {
        const json = await getJson(`${BH3_API}/v1/content/info?app_sn=bh3_wiki&content_id=${encodeURIComponent(id)}`, BH3_HEADERS);
        return json?.data?.content || null;
    });
}

function bh3Parse(raw) {
    if (!raw) return null;
    const contents = raw.contents || [];
    const html = contents.map(c => c.text || '').join('\n');
    const rows = [];
    let image = '';
    const descList = [];
    const skills = [];
    for (const encoded of html.matchAll(/data-data="([^"]+)"/g)) {
        let blocks = [];
        try {
            blocks = JSON.parse(decodeURIComponent(encoded[1]));
        } catch (_) {
            continue;
        }
        for (const block of blocks) {
            const { tmplKey, partKey, data } = block;
            if (tmplKey === 'monster' && partKey === 'main') {
                image = data?.image || image;
                for (const f of data?.mainFields || []) {
                    if (stripHtml(f.nameL)) rows.push({ k: stripHtml(f.nameL), v: stripHtml(f.valueL) });
                    if (stripHtml(f.nameR)) rows.push({ k: stripHtml(f.nameR), v: stripHtml(f.valueR) });
                }
            } else if (tmplKey === 'general' && partKey === 'desc') {
                const text = String(data?.text || '');
                // 表格里每一行 <tr><td> 是一段独立描述
                const cells = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => stripHtml(m[1]));
                const push = cells.length ? cells : [stripHtml(text)];
                push.filter(Boolean).forEach(line => descList.push({ title: data?.title || '简介', text: line }));
            } else if (tmplKey === 'valkyrie' && partKey === 'skill') {
                for (const item of data?.items || []) {
                    skills.push({
                        name: stripHtml(item.name_ || item.name || ''),
                        image: item.img || '',
                        list: (item.list || []).map(v => ({
                            name: stripHtml(v.name || ''),
                            desc: stripHtml(v.desc || ''),
                            icon: v.icon || '',
                        })),
                    });
                }
            }
        }
    }
    if (!rows.length && !descList.length && !skills.length) {
        // 模板解析不出来时，退回整段正文（多数是纯介绍型条目）
        descList.push({ title: '简介', text: stripHtml(html).slice(0, 600) });
    }
    return { rows, image, descList, skills };
}

/* ---------------- 对外方法 ---------------- */

async function list(game) {
    if (game === 'gs') return (await giData()).items;
    if (game === 'sr') return (await srData()).items;
    if (game === 'zzz') return (await zzzData()).items;
    if (game === 'bh3') return (await bh3Data()).items;
    return [];
}

/**
 * 模糊搜索，返回候选条目
 * @param {string} game gs/sr/zzz/bh3/all
 * @param {string} keyword 名称关键字
 */
async function search(game, keyword, limit = 10) {
    const q = cleanName(keyword);
    if (!q) return [];
    if (game === 'bh3') {
        // 全量列表已经能覆盖绝大多数名字，先本地匹配（快且稳），再用搜索接口补别名
        const out = [];
        const seen = new Set();
        try {
            for (const v of await list('bh3')) {
                const n = cleanName(v.name);
                if (n && (n === q || n.includes(q) || (q.length >= 3 && q.includes(n)))) {
                    out.push({ ...v, game: 'bh3' });
                    seen.add(String(v.id));
                }
            }
        } catch (err) {
            globalThis.logger?.warn(`[xhh][monster] bh3 本地列表加载失败: ${err?.message || err}`);
        }
        try {
            for (const v of await bh3Search(keyword, limit)) {
                if (seen.has(String(v.id))) continue;
                out.push({ ...v, game: 'bh3', rank: v.rank || 'normal', rankClass: v.rankClass || rankClassOf('normal') });
                seen.add(String(v.id));
            }
        } catch (err) {
            globalThis.logger?.warn(`[xhh][monster] bh3 搜索接口失败: ${err?.message || err}`);
        }
        return out.sort((a, b) => {
            const ae = cleanName(a.name) === q ? 0 : 1;
            const be = cleanName(b.name) === q ? 0 : 1;
            if (ae !== be) return ae - be;
            return (a.name || '').length - (b.name || '').length;
        }).slice(0, limit);
    }
    const games = game === 'all' ? ['gs', 'sr', 'zzz'] : [game];
    const out = [];
    for (const g of games) {
        let items = [];
        try {
            items = await list(g);
        } catch (err) {
            globalThis.logger?.warn(`[xhh][monster] ${g} 列表加载失败: ${err?.message || err}`);
            continue;
        }
        const hit = items.filter(v => {
            const n = cleanName(v.name);
            if (!n) return false;
            return n === q || n.includes(q) || (q.length >= 3 && q.includes(n));
        });
        hit.slice(0, limit).forEach(v => out.push({ ...v, game: g }));
    }
    // 完全一致优先，其次短名优先
    return out.sort((a, b) => {
        const ae = cleanName(a.name) === q ? 0 : 1;
        const be = cleanName(b.name) === q ? 0 : 1;
        if (ae !== be) return ae - be;
        return (a.name || '').length - (b.name || '').length;
    }).slice(0, limit);
}

async function detail(game, id) {
    const base = { game, gameName: MONSTER_GAMES[game]?.name || '', source: MONSTER_GAMES[game]?.source || '', name: '', icon: '', image: '', rows: [], tags: [], stats: [], groups: [], desc: '', url: '' };

    if (game === 'gs') {
        const { items, families } = await giData();
        const item = items.find(v => String(v.id) === String(id));
        if (!item) return null;
        const rows = [];
        if (item.element) rows.push({ k: '元素', v: item.element });
        if (item.kingdom) rows.push({ k: '类别', v: item.kingdom });
        if (item.family) rows.push({ k: '所属', v: item.family });
        if (item.hp != null) rows.push({ k: '生命倍率', v: String(item.hp) });
        if (item.hpCount) rows.push({ k: '血条数', v: String(item.hpCount) });
        const family = item.family ? (families.get(item.family) || []).filter(v => String(v.id) !== String(item.id)) : [];
        return {
            ...base,
            name: item.name,
            icon: item.icon,
            image: item.icon,
            rows,
            tags: item.tags,
            groups: family.length ? [{ title: '同族', items: family.map(v => ({ name: v.name, icon: v.icon, id: v.id })) }] : [],
        };
    }

    if (game === 'sr') {
        const item = (await srData()).items.find(v => String(v.id) === String(id));
        if (!item) return null;
        const s = item.stats || {};
        return {
            ...base,
            name: item.name,
            icon: item.icon,
            image: item.image || item.icon,
            tags: item.tags,
            rows: [
                item.camp ? { k: '阵营', v: item.camp } : null,
                item.weak.length ? { k: '弱点', v: item.weak.join(' / ') } : null,
                item.hpCount ? { k: '血条数', v: String(item.hpCount) } : null,
                item.isNew ? { k: '标记', v: '版本新增' } : null,
            ].filter(Boolean),
            stats: [
                { label: '生命', value: s.HP },
                { label: '攻击', value: s.ATK },
                { label: '防御', value: s.DEF },
                { label: '速度', value: s.SPD },
                { label: '韧性', value: s.Stance },
            ].filter(v => v.value !== undefined && v.value !== null && v.value !== ''),
        };
    }

    if (game === 'zzz') {
        const { version } = await zzzData();
        const raw = await zzzDetailRaw(id, version);
        if (!raw) return null;
        const info = Object.values(raw.monster_info || {})[0] || {};
        const element = info.element || {};
        const stats = info.stats || {};
        const weak = Object.keys(ZZZ_ELEMENT).filter(k => element[k]).map(k => ZZZ_ELEMENT[k]);
        return {
            ...base,
            name: raw.name || '',
            icon: zzzIcon(raw.image_path || info.icon || ''),
            image: zzzIcon(raw.image_path || ''),
            desc: stripHtml(raw.desc || ''),
            tags: [raw.group_desc, raw.rarity ? `稀有度 ${raw.rarity}` : ''].filter(Boolean),
            rows: [
                raw.group_desc ? { k: '种类', v: raw.group_desc } : null,
                weak.length ? { k: '属性', v: weak.join(' / ') } : null,
                (info.tag || []).length ? { k: '标签', v: info.tag.map(t => ZZZ_TAG[t] || t).join(' / ') } : null,
            ].filter(Boolean),
            stats: [
                { label: '生命', value: stats.hp },
                { label: '攻击', value: stats.attack },
                { label: '防御', value: stats.defence },
                { label: '失衡值', value: stats.stun },
            ].filter(v => v.value !== undefined && v.value !== null),
            groups: [
                raw.card_skill_desc ? { title: '战斗特性', items: [{ name: '', text: stripHtml(raw.card_skill_desc) }] } : null,
                raw.card_quote ? { title: '档案', items: [{ name: '', text: stripHtml(raw.card_quote) }] } : null,
            ].filter(Boolean),
        };
    }

    if (game === 'bh3') {
        const raw = await bh3DetailRaw(id);
        if (!raw) return null;
        const parsed = bh3Parse(raw) || { rows: [], descList: [], skills: [] };
        return {
            ...base,
            name: raw.title || '',
            icon: raw.icon || parsed.image || '',
            image: parsed.image || raw.icon || '',
            rows: parsed.rows,
            tags: parsed.rows.filter(v => /属性|类型|等级/.test(v.k)).map(v => v.v).filter(Boolean).slice(0, 3),
            groups: [
                ...parsed.descList.filter(v => v.text),
                ...parsed.skills.map(s => ({
                    title: s.name,
                    items: s.list.map(v => ({ name: v.name, text: v.desc, icon: v.icon })).filter(v => v.text || v.name),
                })),
            ].filter(v => v.text || (v.items || []).length),
            url: `https://baike.mihoyo.com/bh3/wiki/content/${id}/detail`,
        };
    }
    return null;
}

export default {
    MONSTER_GAMES,
    RANK_ORDER,
    RANK_LABEL,
    RANK_CLASS,
    sortByRank,
    list,
    search,
    detail,
    cleanName,
    stripHtml,
};
