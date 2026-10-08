/**
 * 原神 / 星铁 角色详细信息渲染（数据来自 nanoka.cc）
 *
 * 原来这两张卡走米游社 entry_page，只取「基础信息 / 角色晋阶 / 天赋 / 角色突破」
 * 四个模块，模板里也只有 name/img/attribute/grow/week/material，看起来就是一堆材料。
 * 换到 nanoka 后能拿到完整数据：技能逐级数值、命座/星魂、天赋、属性成长表、行迹等。
 *
 * ⚠ 参数格式必须按各自的规则还原，不能一律乘 100：
 *
 *   原神  desc 数组形如 "一段伤害|{param1:F1P}"，格式串已经说明了怎么显示：
 *         F1P = 保留1位小数并按百分比(×100)   F1 = 保留1位小数原值   P = 整数百分比
 *         实际值在 promote[组].param 数组里，下标 = paramN - 1
 *
 *   星铁  desc 里是 #1[i] 这种占位符，下标同样从 1 开始。
 *         后面跟的是 % 就 ×100，跟「层/点/次」这类计数单位就取原值。
 *         实测：普攻 #1[i]% 参数0.5→50%；天赋「可叠加#1[i]层」参数8→8层。
 */

/** 去掉 nanoka/米游社的富文本标签 */
function stripTags(s) {
    return String(s ?? '')
        // 字面两字符 "\n"：nanoka 的 JSON 里描述字段存的是转义换行，
        // parse 后仍残留 \n 两个字符（不是真换行），必须显式还原。
        // 实测 152 个原神角色里 150 个、99 个星铁角色全部存在。
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ')
        /* nanoka 的术语链接：<color=#xxx>{LINK#N11360001}递变信标{/LINK}</color>
           —— 花括号里是指向词条 id 的引用，屏幕上显示的是「递变信标」这几个字。
           不剥掉就会满屏 {LINK#N11360001} 乱码（实测测试服新角色米提亚的
           6 条命座 + 4 条天赋全中，19 处）。
           顺序要紧：必须在 <[^>]+> 那条**之前**处理，否则 {LINK#...} 里没有尖括号、
           会被后面的逻辑留着；而 LINK 标签里不含尖括号，单独剥是安全的。 */
        .replace(/\{LINK#[^}]*\}/g, '')
        .replace(/\{\/LINK\}/g, '')
        /* 引用型占位符：#{series_ref_skill_desc:UIText_SeriesSkillDescFormat,151129,2}
           —— 未实装角色的星魂/技能描述里指向「升格强化后文案」的占位，
           渲染出来就是一串代码（实测阿哈星魂2）。完整形态整块剥掉；
           个别数据缺头花括号、只剩 #xxx.yyy.zzz,2} 的残缺形态，一并兜底。
           ⚠ 别动 #N[i]（fillSrDesc 的参数占位，方括号结尾，这两条都匹配不到）。 */
        .replace(/#\{[^}]*\}/g, '')
        .replace(/#[a-z0-9_]+(?:\.[a-zA-Z0-9_]+)+,\d*\}/g, '')
        .replace(/<color=[^>]*>/g, '')
        .replace(/<\/color>/g, '')
        .replace(/<unbreak>/g, '')
        .replace(/<\/unbreak>/g, '')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<\/?(b|i|u|size)[^>]*>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

const num = v => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? '');
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
};

/** 按「后面跟的是不是百分号」决定是否 ×100 */
function fillSrDesc(desc, params) {
    const arr = Array.isArray(params) ? params : [];
    return stripTags(desc).replace(/#(\d+)\[i\]/g, (m, n, offset, whole) => {
        const v = arr[Number(n) - 1];
        if (v == null) return '—';
        const after = String(whole).slice(offset + m.length, offset + m.length + 1);
        if (after === '%') return num(Number(v) * 100);
        return num(v);
    });
}

/**
 * 按格式串还原原神技能描述。
 *
 * 格式码实测共 6 种（扫 152 个原神 + 99 个星铁角色的全部详情 json）：
 *   F1P 23952   F1 11613   P 9423   I 3645   F2P 1170   F2 77
 * 命名规则为 F{小数位数} + 可选 P（百分比）。此前只认 F1P / P / F1 / F，
 * F2P 与 F2 落到兜底 num()：F2P 的 0.0035 被 toFixed(1) 成 0，
 * 页面上出现「气氛值转化提升伤害比例：0」。改为按 F(\d+)P? 解析，
 * 小数位数不再需要逐个补。
 */
function fillGsDesc(lines, params) {
    const arr = Array.isArray(params) ? params : [];
    return (Array.isArray(lines) ? lines : []).map(line => {
        const [label, tpl] = String(line).split('|');
        if (!tpl) return stripTags(label);
        const text = tpl.replace(/\{param(\d+):([^}]+)\}/g, (m, idx, fmt) => {
            const v = arr[Number(idx) - 1];
            if (v == null) return '\u2014';
            const n = Number(v);
            if (!Number.isFinite(n)) return String(v);
            const f = /^(?:F(\d+)(P)?|P|I|F)$/.exec(fmt);
            if (!f) return num(n);
            if (f[3] === 'I') return String(Math.round(n));
            if (fmt === 'P') return `${Math.round(n * 100)}%`;
            if (fmt === 'F') return num(n);
            // 不做 Number() 归一：F1P 表示固定 1 位小数，游戏内确实显示
            // 「117.0%」而不是「117%」，尾零必须保留。d=1 时的行为与原实现
            // （F1P → toFixed(1)、F1 → toFixed(1)）完全一致。
            const digits = Number(f[1] || 1);
            const val = f[2] === 'P' ? n * 100 : n;
            return `${val.toFixed(digits)}${f[2] === 'P' ? '%' : ''}`;
        });
        return `${stripTags(label)}\uff1a${text}`;
    }).filter(Boolean);
}

const RARITY_CN = { 1: '一星', 2: '二星', 3: '三星', 4: '四星', 5: '五星' };
// 原神详情里的 rarity 是字符串枚举，不是数字
const gsRarityCn = r => {
    const s = String(r || '');
    if (s.includes('ORANGE')) return '五星';
    if (s.includes('PURPLE')) return '四星';
    return RARITY_CN[Number(r)] || '';
};
// 原神地区是枚举值（实测出现这四个，其余走 replace 兜底）
const GS_REGION_CN = {
    ASSOC_TYPE_MONDSTADT: '蒙德',
    ASSOC_TYPE_LIYUE: '璃月',
    ASSOC_TYPE_INAZUMA: '稻妻',
    ASSOC_TYPE_SUMERU: '须弥',
    ASSOC_TYPE_FONTAINE: '枫丹',
    ASSOC_TYPE_NATLAN: '纳塔',
    ASSOC_TYPE_SAYU_UMI: '渊下城',
    ASSOC_TYPE_NOD_KRAI: '挪德卡莱',
    ASSOC_TYPE_FATUI: '法外狂徒',
};
const gsRegionCn = v => GS_REGION_CN[v] || String(v || '').replace(/^ASSOC_TYPE_/, '');

/**
 * 原神道具图标：UI_ItemIcon_{道具id}.webp。
 * item.json 里每个道具的 icon 字段就是 UI_ItemIcon_{该道具的 id}（原石 201→UI_ItemIcon_201、
 * 涤净青金碎屑 104121→UI_ItemIcon_104121），所以不用拉 item.json 也能拼出来，
 * 芙宁娜 9 种突破材料实测 9/9 全 200。
 */
const gsItemIcon = id => (id ? `https://static.nanoka.cc/assets/gi/UI_ItemIcon_${id}.webp` : '');

// nanoka 给的图标是文件名（如 Skill_A_03 / 10000120），要拼成静态站路径；
// Bwiki 给的已经是完整 URL（patchwiki.biligame.com/...），再拼一次就成了
// https://static.nanoka.cc/assets/gi/https://patchwiki… 这种废串，图片直接加载不出来。
// 所有可能来自 Bwiki 的图标字段都走这里。
const gsIconUrl = v => {
    if (!v) return '';
    const s = String(v);
    if (!/^https?:\/\//i.test(s)) return `https://static.nanoka.cc/assets/gi/${s}.webp`;
    // Bwiki 给的技能/命座/天赋图标是页面渲染时压过的 30px 缩略图
    // （…/images/ys/thumb/a/b/xxx.png/30px-名称.png），放到 22~26px 的
    // 图标位上等于二次缩小，糊得看不清。缩略图 URL 里带原图路径，
    // 直接取出来就是原图，不用再查文件页。
    // 注意 thumb 段里还带两级哈希目录（/thumb/1/19/xxx.png/30px-…），
    // 所以中间那段要用「任意多层目录」匹配，不能只写 [^/]+
    // /thumb/<哈希目录>/<文件名>.png/<宽>px-<编码名>.png → /<哈希目录>/<文件名>.png
    // 中间那段必须用惰性匹配（*?），否则 [^/]+ 会把 xxx.png/30px- 也吞进去。
    return s.replace(/\/thumb\/((?:[^/]+\/)*?)([^/]+)\/\d+px-[^/]*$/i, '/$1$2');
};

// 神之眼（元素）图标：本地图标文件名，和 getWikiIcon 里的映射同源。
const GS_ELEMENT_ICON = { 水: '水.png', 火: '火.png', 冰: '冰.png', 雷: '雷.png', 风: '风.png', 岩: '岩.png', 草: '草.png' };

// 稀有度金星图。维基有现成的五星/四星星图，Bwiki 数据源会带 rarityIcon；
// nanoka 没有这个键就退回空串，模板照旧显示文字星级。
const GS_RARITY_ICON = {
    5: 'https://patchwiki.biligame.com/images/ys/f/ff/0dlkmof43y8aam8fphgixaejy571iqc.png',
    4: 'https://patchwiki.biligame.com/images/ys/2/2a/ssqzx9cint7m3yudjwviabu4nkd8s9o.png',
};

// 角色升级材料（角色经验素材）。所有角色通用，id/名字取自 zh/item.json 的
// type === '角色经验素材'，共 3 档，图标同样实测 200。
const GS_MORA_ICON = 'https://patchwiki.biligame.com/images/ys/thumb/3/34/60ggyaeh31ait5jbwj9dqjsypgd0jle.png/30px-%E6%91%A9%E6%8B%89.png';
const GS_EXP_MATS = [
    { id: 104001, name: '流浪者的经验' },
    { id: 104002, name: '冒险家的经验' },
    { id: 104003, name: '大英雄的经验' },
];

// 星铁道具图标。这个 base 是从 nanoka 站点前端组件中提取的
// （imageBase:"https://static.nanoka.cc/assets/hsr/itemfigures/"），
// 阿哈 9 种培养材料实测 9/9 全 200。
const srItemIcon = id => (id ? `https://static.nanoka.cc/assets/hsr/itemfigures/${id}.webp` : '');
const srLcIcon = id => (id ? `https://static.nanoka.cc/assets/hsr/lightconemaxfigures/${id}.webp` : '');

// 星铁遗器部位图标。nanoka 只发布了 4 个部位（实测 relicfigures 目录）：
// Body / Head / Foot / Neck 对应衣身、头部、鞋履、颈部，
// 位面球（OBJECT）与连绳（LINK）没有图，返回空串由模板跳过。
// 图是 64×64 的半透明 PNG（alpha 0~255），底色浅时会发虚，故配浅底 chip。
const SR_RELIC_SLOT_ICON = {
    BODY: 'IconRelicBody',
    HEAD: 'IconRelicHead',
    FOOT: 'IconRelicFoot',
    NECK: 'IconRelicNeck'
};
const srRelicSlotIcon = type => {
    const key = SR_RELIC_SLOT_ICON[String(type || '').toUpperCase()];
    return key ? `https://static.nanoka.cc/assets/hsr/relicfigures/${key}.webp` : '';
};

// 星铁遗器套装图标：从 SpriteOutput/ItemIcon/71060.png 这类资源路径里取尾部数字，
// 拼 assets/hsr/itemfigures/{数字}.webp。与 system/mys.js 的同名规则一致。
const srRelicIcon = raw => {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:/i.test(s)) return s;
    const num = (s.match(/(\d+)\.[a-z0-9]+$/i) || [])[1] || '';
    return num ? `https://static.nanoka.cc/assets/hsr/itemfigures/${num}.webp` : '';
};

// 星铁命途 / 属性徽章文件名。取自 apps/wiki.js 的 srIconMap，两边保持一致；
// 列表页由 getWikiIcon 解析，详情页在这里解析，模板统一按 wiki/imgs/{文件名} 取图。
const SR_BADGE_ICON = {
    '毁灭': '毁灭.png', '巡猎': '巡猎.png', '智识': '智识.png', '同谐': '同谐.png',
    '虚无': '虚无.png', '存护': '存护.png', '丰饶': '丰饶.png', '记忆': '记忆.png',
    '欢愉': '欢愉.png',
    '物理': 'sr_物理.png', '火': 'sr_火.png', '冰': 'sr_冰.png', '雷': 'sr_雷.png',
    '风': 'sr_风.png', '量子': 'sr_量子.png', '虚数': 'sr_虚数.png'
};
const srBadgeIcon = zh => SR_BADGE_ICON[String(zh || '')] || '';

// 星铁命途 / 属性。nanoka 给的是内部名（Elation / Quantum），详情页头部直接
// 渲染就会显示英文。这两张表与 system/mys.js 中的同名表保持一致。
const SR_PATH_CN = {
    Knight: '存护', Rogue: '巡猎', Mage: '智识', Warlock: '虚无',
    Warrior: '毁灭', Priest: '丰饶', Shaman: '同谐',
    Memory: '记忆', Elation: '欢愉'
};
const SR_DAMAGE_CN = {
    Physical: '物理', Fire: '火', Ice: '冰', Thunder: '雷',
    Wind: '风', Imaginary: '虚数', Quantum: '量子'
};

// 星铁遗器部位。键取自 relics.property_list[].relic_type
const SR_RELIC_SLOT_CN = { HEAD: '头部', NECK: '颈部', BODY: '衣身', FOOT: '鞋履', OBJECT: '位面球', LINK: '连绳' };

// 星铁词条。17 个键与 nanoka 站点前端用的清单（Xl 数组）完全一致，
// 别处没有第四个词条类型；中文名按游戏内界面用语。
const SR_STAT_CN = {
    HPDelta: '生命值', HPAddedRatio: '生命值%',
    AttackAddedRatio: '攻击力%', DefenceAddedRatio: '防御力%',
    SpeedDelta: '速度',
    CriticalChanceBase: '暴击率', CriticalDamageBase: '暴击伤害',
    BreakDamageAddedRatioBase: '击破特攻',
    StatusProbabilityBase: '效果命中', StatusResistanceBase: '效果抵抗',
    SPRatioBase: '能量恢复效率',
    PhysicalAddedRatio: '物理伤害加成', FireAddedRatio: '火元素伤害加成',
    IceAddedRatio: '冰元素伤害加成', ThunderAddedRatio: '雷元素伤害加成',
    WindAddedRatio: '风元素伤害加成', QuantumAddedRatio: '量子伤害加成',
    ImaginaryAddedRatio: '虚数伤害加成',
};

function gsRoleView(detail, id) {
    const d = detail || {};
    const info = d.chara_info || {};
    const mats = d.materials || {};

    // 突破：6 段逐段列。之前的写法按名字去重、只留首次出现的数量，
    // 结果显示成「涤净青金碎屑×1 / 断片×3 / 块×3」—— 那是各档的最小值，
    // 不是真实用量。真实用量是 碎屑×1 → 断片×3 → 断片×6 → 块×3 → 块×6 → 块本×6，
    // 必须逐段原样列，不能去重合并。
    // icon 优先用数据源自带的 URL：nanoka 给的是道具 id，要拼本地路径；
    // Bwiki 直接给了 patchwiki 图链，拼接反而会拼错。
    const toMat = m => ({ name: m.name, count: m.count, rank: m.rank, icon: m.icon || gsItemIcon(m.id) });
    const ascensionStages = (mats.ascensions || []).map((step, i) => ({
        no: i + 1,
        cost: step.cost,
        mats: (step.mats || []).map(toMat),
    }));
    // 天赋：talents 是三维的 —— 外层数组是【技能】（实测菲林斯 3 个有倍率的技能），
    // 每个技能内层才是该技能的 9 个升级等级。
    // 原写法两层循环全摊平并连续编号，菲林斯就成了 3×9=27 阶。数字本身是错的：
    // 第 10 阶往后是重复的垃圾（三个技能的升级材料完全一致，摊平后看起来像复制粘贴，
    // 出现「第10阶=摩拉17500+教导×2」这种明显不成梯度的内容）。
    // 同一个角色所有技能的升级材料是同一套（共用同一个天赋书体系），所以只取第一组。
    const talentGroups = Array.isArray(mats.talents) ? mats.talents : [];
    const firstTalentGroup = Array.isArray(talentGroups[0])
        ? talentGroups[0]
        : (talentGroups[0] ? [talentGroups[0]] : []);
    const talentStages = firstTalentGroup
        .map((step, i) => {
            const list = (step?.mats || []).map(toMat);
            return { no: i + 1, cost: step?.cost, mats: list };
        })
        .filter(x => x.mats.length);
    // 同角色多技能的升级材料是否真的一致——不一致时宁可保留全部组，也别只显示第一组误导人。
    const talentGroupsDiffer = talentGroups.length > 1 && talentGroups.some(
        g => JSON.stringify((Array.isArray(g) ? g : [g]).map(s => (s?.mats || []).map(m => `${m.name}x${m.count}`)))
            !== JSON.stringify(firstTalentGroup.map(s => (s?.mats || []).map(m => `${m.name}x${m.count}`)))
    );
    const expMats = GS_EXP_MATS.map(m => ({ ...m, icon: gsItemIcon(m.id) }));

    // 数量在两个数据源里有三种写法：'3'、'120000'、'2.4万'。
    // 求和前统一换成真值，显示时再按量级还原（避免 24000 和 2.4万 两种写法混在一张表里）。
    const qtyOf = v => {
        const s = String(v ?? '').replace(/,/g, '').trim();
        if (!s) return 0;
        const wan = s.match(/^([\d.]+)\s*万$/);
        if (wan) return Math.round(parseFloat(wan[1]) * 10000);
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
    };
    // 同一材料跨档合并：'最胜紫晶碎屑' 与 '最胜紫晶断片' 是不同材料，不合并。
    // 摩拉在 nanoka 里不在 mats 内，而是每档的 cost 字段（20000/40000/…），
    // 所以这里把 cost 一并累加，否则汇总里摩拉永远是空的。
    const sumMats = stages => {
        const bag = new Map();
        for (const st of stages) {
            if (st?.cost) {
                const cur = bag.get('摩拉');
                if (cur) cur.qty += qtyOf(st.cost);
                else bag.set('摩拉', { name: '摩拉', qty: qtyOf(st.cost), rank: 0, icon: GS_MORA_ICON });
            }
            for (const m of (st?.mats || [])) {
                if (!m?.name) continue;
                const prev = bag.get(m.name);
                if (prev) { prev.qty += qtyOf(m.count); continue; }
                bag.set(m.name, { name: m.name, qty: qtyOf(m.count), rank: m.rank, icon: m.icon || gsItemIcon(m.id) });
            }
        }
        return [...bag.values()].filter(m => m.qty > 0);
    };
    // 1652500 不能四舍五入成 165.3万 —— 那是错的数字，差 500 摩拉。
    // 万位以下保留两位小数，且只在真的能整除时才用短写法。
    const fmtQty = n => {
        if (n < 10000) return String(n);
        const w = n / 10000;
        if (Number.isInteger(w)) return `${w}万`;
        const s2 = w.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        return `${s2}万`;
    };


    // 等级升级消耗（1→90 分段）。这是可选数据：只有 Bwiki 路径会带 materials.levelUp，
    // nanoka 的 materials 只有 ascensions / talents 两个键，所以这里拿不到，
    // 模板会退回只列三本通用经验书的旧行为，不回归。
    const levelUpMats = (mats.levelUp || [])
        .map(seg => ({
            lv: seg.lv || (seg.from != null && seg.to != null ? `${seg.from}~${seg.to}级` : ''),
            from: seg.from ?? null,
            to: seg.to ?? null,
            approx: !!seg.approx,
            mats: (seg.mats || []).map(toMat).filter(m => m.name),
        }))
        .filter(seg => seg.lv && seg.mats.length);
    // 升级材料：Bwiki 有 levelUp（分 7 段），nanoka 只有三本通用经验书没有分段。
    // 三类材料各自求和。突破/天赋的逐档明细仍保留在 ascensionStages / talentStages，
    // 模板默认只画总和，要展开的话换字段即可。
    const ascendSum = sumMats(ascensionStages);
    const talentSum = sumMats(talentStages);
    const levelSum = sumMats(levelUpMats);
    // 技能书（天赋书）：Bwiki 放在 materials.skillUp 里，形态是 [{level, mats}]，
    // 与 ascensionStages 同构。nanoka 没有这个键，所以那一侧这组是空的。
    const skillUpStages = (mats.skillUp || []).map(s => ({ no: s.level, mats: (s.mats || []).map(toMat) }));
    const skillSum = sumMats(skillUpStages);

    const skills = (d.skills || []).map((sk, i) => {
        // promote 的键 0/1/2/3 不是「天赋组」而是【等级档】，每档自带一份 param 数组
        // （实测 普攻 是 0→Lv.1、3→满级）。展示用满级那档最有参考价值。
        const groups = Object.values(sk.promote || {})
            .map(g => ({ lines: fillGsDesc(g?.desc, g?.param), level: g?.level || 0 }))
            .filter(g => g.lines.length);
        const top = groups[groups.length - 1] || { lines: [], level: 0 };
        const firstIcon = Object.values(sk.promote || {})[0]?.icon;
        return {
            name: sk.name || `技能${i + 1}`,
            // nanoka 给的是文件名（Skill_A_03），要拼成静态站路径；
            // Bwiki 给的已经是完整 URL，直接拼会得到 https://static.nanoka.cc/assets/gi/https://… 这种废串。
            icon: gsIconUrl(firstIcon),
            lines: top.lines,
            maxLevel: top.level,
            brackets: groups.map(g => g.level).filter(Boolean),
        };
    }).filter(s => s.lines.length);

    return {
        id,
        name: d.name || '',
        // 详情页大图走 assets/gi/UI_AvatarIcon_{name}.webp，前缀必须保留。
        // 之前这里把 UI_AvatarIcon_ 剥掉再拼 .webp，得到的
        // assets/gi/Furina.webp 实测 404 —— 152 个角色无一例外全是坏的，
        // 不是个别角色缺图。列表页（nanokaGsIcon）没剥前缀所以一直正常。
        icon: gsIconUrl(d.icon),
        rarity: gsRarityCn(d.rarity),
        /* 星级图标按**归一化后的中文稀有度**取键。原来用 /(\d)/ 去原值里找数字：
           Bwiki 路径 rarity 是 '5' 能取到，nanoka 路径是「五星」取不到数字 → 图标为空
           （旅行者等走 nanoka 的角色头像上没有金星）。 */
        rarityIcon: d.rarityIcon || GS_RARITY_ICON[gsRarityCn(d.rarity) === '五星' ? 5 : gsRarityCn(d.rarity) === '四星' ? 4 : 0] || '',
        element: info.vision || '',
        // 神之眼图标（wiki/imgs/{元素}.png），模板用 {{ppath}} 拼。
        // 之前只给了元素文字，标签前面没有图标，看起来就像「神之眼没获取到」。
        elementIcon: GS_ELEMENT_ICON[info.vision] || '',
        constellation: info.constellation || '',
        region: gsRegionCn(info.region),
        title: info.title || '',
        birth: Array.isArray(info.birth) && info.birth.length === 2 ? `${info.birth[0]}月${info.birth[1]}日` : '',
        release: String(info.release_date || '').slice(0, 10),
        baseHp: d.base_hp, baseAtk: d.base_atk, baseDef: d.base_def,
        critRate: d.crit_rate, critDmg: d.crit_dmg, em: d.elemental_mastery,
        stamina: d.stamina_recovery,
        desc: stripTags(d.desc),
        skills,
        constellations: (d.constellations || []).map((c, i) => ({
            no: i + 1, name: c.name, desc: fillSrDesc(c.desc, c.param_list),
            icon: c.icon ? gsIconUrl(c.icon) : '',
        })).filter(c => c.name),
        passives: (d.passives || []).map(p => ({
            name: p.name, desc: fillSrDesc(p.desc, p.param_list), unlock: p.unlock,
            icon: p.icon ? gsIconUrl(p.icon) : '',
        })).filter(p => p.name),
        ascensionStages,
        talentStages,
        // 多技能材料不一致时（极少见）告知调用方，别让人以为这就是全部
        talentSkillCount: talentGroups.length,
        talentGroupsDiffer,
        expMats,
        levelUpMats,
        // 三类材料的合并汇总，模板画「材料总览」用。
        // 模板不能调函数，数量在这里就格式化成字符串。
        matSummary: [
            { key: 'level', label: '升级', mats: levelSum },
            { key: 'ascend', label: '突破', mats: ascendSum },
            { key: 'talent', label: '天赋', mats: talentSum },
            { key: 'skill', label: '技能', mats: skillSum },
        ]
            .filter(g => g.mats.length)
            .map(g => ({
                key: g.key, label: g.label,
                // 摩拉在 nanoka 里是每档的 cost 字段，已并进 mats 末尾，展示上与其他材料一致
                mats: g.mats.map(m => ({ ...m, count: fmtQty(m.qty) })),
                mats: g.mats.map(m => ({ ...m, count: fmtQty(m.qty) })),
            })),
    };
}

function srRoleView(detail, id) {
    const d = detail || {};
    const info = d.chara_info || {};
    const stats = d.stats || {};
    const keys = Object.keys(stats);
    const pick = k => stats[k] || null;
    const growth = keys.map(k => {
        const s = stats[k];
        return {
            level: s?.level ?? k,
            atkBase: s?.attack_base, atkAdd: s?.attack_add,
            defBase: s?.defence_base, defAdd: s?.defence_add,
            hpBase: s?.hp_base, hpAdd: s?.hp_add,
            speed: s?.speed_base, crit: s?.critical_chance, critDmg: s?.critical_damage,
        };
    });

    const skills = Object.values(d.skills || {}).map(sk => {
        const lv = sk.level || {};
        const lvKeys = Object.keys(lv);
        const maxKey = lvKeys[lvKeys.length - 1];
        const maxParams = lv?.[maxKey]?.param_list || [];
        const minParams = lv?.[lvKeys[0]]?.param_list || [];
        let icon = '';
        const tag = String(sk.tag || '');
        if (/SingleAttack|BPSkill|Skill|Magic|Attack/.test(tag)) {
            icon = sk.type_name === '普攻' ? 'Normal' : sk.type_name === '战技' ? 'BP' : sk.type_name === '终结技' ? 'Ultra' : 'Passive';
        }
        return {
            type: sk.type_name || '',
            name: sk.name || '',
            icon: icon ? `https://static.nanoka.cc/assets/hsr/skillicons/SkillIcon_${id}_${icon}.webp` : '',
            maxLevel: lvKeys.length,
            desc: fillSrDesc(sk.desc, maxParams),
            minText: fillSrDesc(sk.desc, minParams),
        };
    }).filter(s => s.desc);

    // 基础属性（模板 sr_role_nk 读的是**扁平** hp/atk/def/crit/critDmg/speed，
    // 此前这里只给了 growth 数组，模板里根本没有 growth 循环，于是这些字段全空、
    // 「基础属性 · 80级」整块是空值）。这里按最高一档还原 80 级单值。
    // 键0~6 七档，实测星铁全部如此（含已实装）；末档（键最大）的 base + add×(80-1)
    // 即该角色 80 级值（丹恒•饮月→ hp1242 / atk699，与游戏内量级一致）。
    const MAX_LEVEL = 80;
    const statKeys = Object.keys(stats).filter(k => Number.isFinite(Number(k)))
        .sort((a, b) => Number(a) - Number(b));
    const top = statKeys.length ? stats[statKeys[statKeys.length - 1]] : null;
    const atMax = (b, a) => Math.round((Number(b) || 0) + (Number(a) || 0) * (MAX_LEVEL - 1));
    const pct = v => (v == null ? '' : `${Math.round(Number(v) * 100)}%`);

    // ---- 培养材料 ----
    // 星铁没有「角色突破」这个独立字段（enhanced 是魂影强化、memosprite 是记忆灵媒），
    // 培养材料就是 skill_trees 各节点的 material_list。这里按 item_id 合并求和，
    // 页面上标注「全部点满合计」，不假装是单档用量。
    const matSum = new Map();
    for (const group of Object.values(d.skill_trees || {})) {
        for (const node of Object.values(group || {})) {
            for (const m of node?.material_list || []) {
                if (!m?.item_id) continue;
                matSum.set(m.item_id, (matSum.get(m.item_id) || 0) + (m.item_num || 0));
            }
        }
    }
    const materials = [...matSum.entries()].map(([itemId, total]) => ({
        // nanoka 的 item.json 里个别道具的 item_name 就是字面量 "..."
        // （如 110509），不是查不到 id。这种显示 id，别显示成省略号。
        name: (d.itemMap?.[itemId]?.item_name || '').trim().replace(/^\.{3}$/, '')
            || `道具 ${itemId}`,
        icon: srItemIcon(itemId),
        // ⚠ icon 已是完整 URL，模板靠 iconUrl 区分「原样输出」与「拼 ppath+wiki/imgs/
        // 本地文件名」。缺这个标记，模板会把整条 URL 当文件名拼进本地路径 → 必然裂图。
        iconUrl: true,
        total,
    })).sort((a, b) => b.total - a.total);

    // ---- 推荐光锥 / 遗器 / 词条 ----
    const recoLightcones = (d.lightcones || []).map(lcId => ({
        name: d.lightconeMap?.[lcId]?.zh || String(lcId),
        icon: srLcIcon(lcId),
    }));
    // 推荐遗器：nanoka 的 relicset.json 里 icon 字段是 SpriteOutput/ItemIcon/71060.png
    // 这种游戏内资源路径，拼整条在 assets 下取不到（实测 404），但尾部数字发布成了
    // assets/hsr/itemfigures/{数字}.webp（实测 64 套全 200）。按数字拼即可。
    const relicSets = list => (list || []).map(id => ({
        name: d.relicsetMap?.[id]?.zh || String(id),
        icon: srRelicIcon(d.relicsetMap?.[id]?.icon),
    }));
    const mainStats = (d.relics?.property_list || []).map(r => ({
        slot: SR_RELIC_SLOT_CN[r.relic_type] || r.relic_type,
        icon: srRelicSlotIcon(r.relic_type),
        stat: SR_STAT_CN[r.property_type] || r.property_type,
    }));
    const subStats = (d.relics?.sub_affix_property_list || []).map(k => SR_STAT_CN[k] || k);

    return {
        id,
        name: d.name || '',
        rarity: RARITY_CN[Number(/(\d+)\s*$/.exec(String(d.rarity || ''))?.[1])] || '',
        path: SR_PATH_CN[d.base_type] || d.base_type || '',
        pathIcon: srBadgeIcon(SR_PATH_CN[d.base_type] || d.base_type),
        damage: SR_DAMAGE_CN[d.damage_type] || d.damage_type || '',
        damageIcon: srBadgeIcon(SR_DAMAGE_CN[d.damage_type] || d.damage_type),
        camp: info.camp || '',
        spNeed: d.sp_need,
        desc: stripTags(d.desc),
        // 扁平基础属性：模板 sr_role_nk 读这几个字段（此前只给了 growth 数组，模板无growth 循环 → 空值）
        hp: top ? atMax(top.hp_base, top.hp_add) : '',
        atk: top ? atMax(top.attack_base, top.attack_add) : '',
        def: top ? atMax(top.defence_base, top.defence_add) : '',
        crit: pct(top?.critical_chance),
        critDmg: pct(top?.critical_damage),
        speed: top?.speed_base ?? '',
        traceBonus: '', // nanoka 侧没有行迹加成字段，留空由模板跳过
        growth,
        skills,
        materials,
        recoLightcones,
        relicSets4: relicSets(d.relics?.set4_id_list),
        relicSets2: relicSets(d.relics?.set2_id_list),
        mainStats,
        subStats,
        ranks: Object.entries(d.ranks || {}).map(([k, r]) => ({
            no: Number(k), name: r.name, desc: fillSrDesc(r.desc, r.param_list),
            // 图标要按 ranks[k].icon 拼，不能拿键 k 拼 Rank{k}：
            // 阿哈的 key=3 是 SkillIcon_1511_Ultra.png、key=5 是 SkillIcon_1511_BP.png，
            // 并不存在 Rank3/Rank5，按键拼出来两个都是 404（实测）。
            icon: r.icon ? `https://static.nanoka.cc/assets/hsr/skillicons/${r.icon.replace(/\.png$/, '.webp')}` : '',
        })).filter(r => r.name).sort((a, b) => a.no - b.no),
        stories: Object.values(info.stories || {}).map(s => stripTags(s)).filter(Boolean),
    };
}

export { gsRoleView, srRoleView, stripTags, fillSrDesc, fillGsDesc };
