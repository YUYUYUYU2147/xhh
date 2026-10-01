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

// 角色升级材料（角色经验素材）。所有角色通用，id/名字取自 zh/item.json 的
// type === '角色经验素材'，共 3 档，图标同样实测 200。
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
    const toMat = m => ({ name: m.name, count: m.count, rank: m.rank, icon: gsItemIcon(m.id) });
    const ascensionStages = (mats.ascensions || []).map((step, i) => ({
        no: i + 1,
        cost: step.cost,
        mats: (step.mats || []).map(toMat),
    }));
    // 天赋：talents 是 [[{mats,cost}, ...], [...]]，外层是天赋槽位，摊平成阶段
    const talentStages = [];
    for (const group of mats.talents || []) {
        for (const step of (Array.isArray(group) ? group : [group])) {
            const list = (step?.mats || []).map(toMat);
            if (list.length) talentStages.push({ no: talentStages.length + 1, cost: step.cost, mats: list });
        }
    }
    const expMats = GS_EXP_MATS.map(m => ({ ...m, icon: gsItemIcon(m.id) }));

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
            icon: firstIcon ? `https://static.nanoka.cc/assets/gi/${firstIcon}.webp` : '',
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
        icon: d.icon ? `https://static.nanoka.cc/assets/gi/${d.icon}.webp` : '',
        rarity: gsRarityCn(d.rarity),
        element: info.vision || '',
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
        })).filter(c => c.name),
        passives: (d.passives || []).map(p => ({
            name: p.name, desc: fillSrDesc(p.desc, p.param_list), unlock: p.unlock,
        })).filter(p => p.name),
        ascensionStages,
        talentStages,
        expMats,
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
