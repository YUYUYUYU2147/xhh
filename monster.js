import { render, config, pluginPriority } from '#xhh';
import monsterWiki from '../system/monster.js';

// 怪物 / BOSS 图鉴
// 列表用 #原神怪物图鉴，单查用 #原神怪物 名称；不写游戏名时默认原神，查询会自动跨四游戏找

const PAGE_SIZE = 60;

const GAME_ALIAS = {
    '原神': 'gs', 'genshin': 'gs', 'ys': 'gs', 'gs': 'gs',
    '星穹铁道': 'sr', '崩坏星穹铁道': 'sr', '铁道': 'sr', '穹铁': 'sr', '星铁': 'sr', 'sr': 'sr',
    '绝区零': 'zzz', '绝区': 'zzz', 'zzz': 'zzz',
    '崩坏3': 'bh3', '崩坏三': 'bh3', '崩三': 'bh3', 'bh3': 'bh3',
};

const GAME_NAME = monsterWiki.MONSTER_GAMES;

// 触发词（怪物/敌人/boss/首领/图鉴/列表/大全）必须存在才接管，否则会吃掉「#崩三深渊」这类指令；
// 用前瞻保证这一点，同时允许「#崩三虚数猪图鉴」这种不写「怪物」、只带「图鉴」后缀的写法命中敌人图鉴。
const CMD_REG = /^(?=[\s\S]*(?:怪物|魔物|敌人|BOSS|boss|首领|图鉴|列表|大全))[#%*]*(原神|genshin|ys|sr|星穹铁道|崩坏星穹铁道|铁道|穹铁|星铁|绝区零|绝区|zzz|崩坏3|崩坏三|崩三|bh3)?\s*(怪物|魔物|敌人|BOSS|boss|首领)?(图鉴|列表|大全)?\s*([\s\S]*)$/i;

export class monster extends plugin {
    constructor(e) {
        super({
            name: '[小花火]怪物图鉴',
            dsc: '怪物/BOSS 图鉴查询',
            event: 'message',
            // 优先级需高于 wiki 的通用「xx图鉴」（wiki 用 -99），否则「原神怪物图鉴」会被通用规则先截走
            priority: pluginPriority('monster', -200),
            rule: [
                {
                    reg: '^[#%*]*(原神|genshin|ys|sr|星穹铁道|崩坏星穹铁道|铁道|穹铁|星铁|绝区零|绝区|zzz|zzZ|ZZZ|崩坏3|崩坏三|崩三|bh3|Bh3|BH3)?\\s*(怪物|魔物|敌人|BOSS|boss|Boss|首领)(图鉴|列表|大全)?\\s*([\\s\\S]*)$',
                    fnc: 'monster',
                },
                {
                    // 只带「图鉴」后缀、不写「怪物」的写法（#崩三虚数猪图鉴 / #原神雷音权现图鉴）：
                    // 先交给怪物库试一次，命中出怪物卡；未命中 renderDetail 会 return false，
                    // 让路给通用图鉴按角色/武器处理。
                    // 两个约束缺一不可：
                    //   1) 负向前瞻排除「怪物/敌人/boss/首领」——这些交给上面的规则，避免重复触发；
                    //   2) 游戏前缀必须存在且名字非空——否则会把「#原神图鉴」这类通用列表也截走。
                    reg: '^(?![\\s\\S]*(?:怪物|魔物|敌人|BOSS|boss|Boss|首领))[#%*]*\\s*(原神|genshin|ys|sr|星穹铁道|崩坏星穹铁道|铁道|穹铁|星铁|绝区零|绝区|zzz|zzZ|ZZZ|崩坏3|崩坏三|崩三|bh3|Bh3|BH3)\\s*(.+?)图鉴\\s*$',
                    fnc: 'monster',
                },
            ],
        });
    }

    dbg(...args) {
        if (config().debug) logger.mark('[xhh][怪物图鉴]', ...args);
    }

    async monster(e) {
        const raw = String(e.msg || e.raw_message || '').trim();
        const text = raw.replace(/^[#%*]+/, '').trim();
        const m = text.match(CMD_REG);
        if (!m) return false;

        const game = GAME_ALIAS[String(m[1] || '').toLowerCase()] || '';
        // 「图鉴」是命令词（带名称时出详情卡），只有「列表/大全」才走列表模式；
        // 带名称的「#崩三虚数猪图鉴」应出详情而非列一张只含自己的清单。
        const mode = m[3] || '';
        const isList = mode === '列表' || mode === '大全';
        // 显式写了 怪物/敌人/boss/首领 才算「明确要查怪物」：未命中时直接报错；
        // 只带「图鉴」后缀的（如 #崩三虚数猪图鉴）未命中则让路给通用图鉴插件按角色/武器处理。
        const explicit = !!m[2];
        let rest = String(m[4] || '').trim();
        if (!isList) rest = rest.replace(/(图鉴|列表|大全)$/, '').trim();

        this.dbg('指令解析:', `game=${game || '(未指定)'}`, `mode=${isList ? '列表' : '详情'}`, `explicit=${explicit}`, `参数=${rest || '(空)'}`);

        if (isList) return await this.renderList(e, game || 'gs', rest);
        return await this.renderDetail(e, game, rest, explicit);
    }

    async renderList(e, game, rest) {
        let page = 1;
        let keyword = rest;
        if (/^\d+$/.test(rest)) {
            page = Math.max(1, Number(rest));
            keyword = '';
        }

        let items = [];
        try {
            items = await monsterWiki.list(game);
        } catch (err) {
            logger.error(`[xhh][怪物图鉴] ${game} 数据加载失败: ${err?.message || err}`);
            return e.reply('怪物数据获取失败，请稍后再试。');
        }
        if (!items.length) return e.reply('未获取到该游戏的怪物列表，请稍后再试。');

        const clean = monsterWiki.cleanName;
        if (keyword) {
            const q = clean(keyword);
            items = items.filter(v => clean(v.name).includes(q));
            if (!items.length) return e.reply(`没有匹配「${keyword}」的怪物，换个关键词试试。`);
        }

        // BOSS → 精英 → 小怪，同级按名称排
        items = monsterWiki.sortByRank(items);
        const rankCount = { boss: 0, elite: 0, normal: 0 };
        items.forEach(v => { rankCount[v.rank || 'normal']++; });

        const total = items.length;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        page = Math.min(page, pages);
        const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        // 崩三列表接口只提供敌人类型；当前页详情中才有怪物属性。
        // 等属性补全后再生成徽章，避免首次打开列表时漏掉属性标签。
        if (game === 'bh3') {
            try {
                await monsterWiki.enrichBh3Items(slice);
            } catch (err) {
                this.dbg('崩三当前页属性补全失败:', err?.message || err);
            }
        }

        this.dbg('列表渲染:', `game=${game}`, `总数=${total}`, `页码=${page}/${pages}`);

        const gameName = GAME_NAME[game]?.name || '';
        const data = slice.map(v => {
            const rank = v.rank || 'normal';
            return {
                name: v.name,
                icon: v.icon,
                rankClass: v.rankClass || monsterWiki.RANK_CLASS[rank],
                // 等级徽标放第一个，一眼看出是 BOSS / 精英 / 小怪；标签与等级重复的（如崩三的BOSS类型）不重复展示
                badges: [{ text: monsterWiki.RANK_LABEL[rank] },
                  ...(v.tags || []).filter(t => t !== monsterWiki.RANK_LABEL[rank]).slice(0, 2).map(t => ({ text: t })),
                ].filter(b => b.text),
            };
        });

        const title = `${gameName}怪物${keyword ? `·${keyword}` : ''}${pages > 1 ? `第${page}页` : ''}`;
        await render('wiki/list', { name: title, data }, { e, ret: true });

        if (pages > 1) {
            const cmd = `${gameName}${keyword ? `怪物图鉴 ${keyword} ` : '怪物图鉴 '}`;
            return e.reply(`共 ${total} 个怪物（BOSS ${rankCount.boss} / 精英 ${rankCount.elite} / 小怪 ${rankCount.normal}），当前第 ${page}/${pages} 页，已按 BOSS→精英→小怪 排序。回复「#${cmd}${page + 1 <= pages ? page + 1 : 1}」翻页，或「#${gameName}怪物 名称」查看详情。`, true, { recallMsg: 60 });
        }
        return true;
    }

    async renderDetail(e, game, keyword, explicit = true) {
        if (!keyword) {
            return e.reply('用法：\n#原神怪物 名称 / #星铁怪物 名称 / #绝区零怪物 名称 / #崩三怪物 名称\n也可以不写游戏名直接 #怪物 名称（自动跨游戏搜索）\n列表：#原神怪物图鉴', true, { recallMsg: 60 });
        }

        let candidates = [];
        try {
            candidates = await monsterWiki.search(game || 'all', keyword, 8);
        } catch (err) {
            logger.error(`[xhh][怪物图鉴] 搜索失败: ${err?.message || err}`);
            return e.reply('怪物数据查询失败，请稍后再试。');
        }

        this.dbg('搜索结果:', `keyword=${keyword}`, `候选=${candidates.length}`, candidates.slice(0, 3).map(v => `${v.game}:${v.name}`).join(' / '));

        if (!candidates.length) {
            // 显式写了「怪物/敌人」但图鉴没收录：直接提示；否则让给通用图鉴插件（角色/武器）。
            if (explicit) return e.reply(`没有找到「${keyword}」相关的怪物。`, true, { recallMsg: 60 });
            return false;
        }

        // 多个候选时先列出来让用户选，避免猜错游戏；名称完全一致则直接用它
        let target = candidates[0];
        if (candidates.length > 1) {
            const q = monsterWiki.cleanName(keyword);
            const exact = candidates.find(v => monsterWiki.cleanName(v.name) === q);
            if (!exact) {
                const lines = candidates.map((v, i) => `${i + 1}. ${v.name}（${GAME_NAME[v.game]?.name || v.game}）`);
                return e.reply(
                    [`找到 ${candidates.length} 个匹配：`, ...lines, '', `回复「#${GAME_NAME[candidates[0].game]?.name || ''}怪物 ${candidates[0].name}」查看详情。`].join('\n'),
                    true,
                    { recallMsg: 60 }
                );
            }
            target = exact;
        }
        let info = null;
        try {
            info = await monsterWiki.detail(target.game, target.id);
        } catch (err) {
            logger.error(`[xhh][怪物图鉴] 详情获取失败: ${err?.message || err}`);
            return e.reply('怪物详情获取失败，请稍后再试。');
        }
        if (!info) return e.reply(`没有找到「${target.name}」的详细信息。`);

        await render('monster/detail', info, { e, ret: true });
        if (target.game === 'bh3' && info.url) {
            return e.reply(`数据来源：${info.source}\n${info.url}`, true, { recallMsg: 60 });
        }
        return true;
    }
}
