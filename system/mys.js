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

    //图鉴
    async tujian(isSr = false, isZZZ = false, isBH3 = false) {
        if (isZZZ) {
            return await this.zzz_tujian();
        }
        if (isBH3) {
            return await this.bh3_tujian();
        }
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
            markNanokaDown();
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
            let id; 
            for (let va of list) {
                id = va.content_id;
                if (va.title.replace(/ /g, '') == name) return {
                    id
                };
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
            markNanokaDown();
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
