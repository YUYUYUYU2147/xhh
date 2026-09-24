import { render, config, pluginPriority } from '#xhh';
import gachaTimer from '../system/gacha_timer.js';

// 卡池计时器：多久没复刻 / UP 总览
// 原神、星铁、绝区零数据来自 wiki.biligame.com 的卡池计时器；崩三用插件自带史料库统计

const GAME_ALIAS = {
    '原神': 'ys', 'genshin': 'ys', 'ys': 'ys',
    '星穹铁道': 'sr', '崩坏星穹铁道': 'sr', '铁道': 'sr', '穹铁': 'sr', '星铁': 'sr', 'sr': 'sr',
    '绝区零': 'zzz', '绝区': 'zzz', 'zzz': 'zzz',
    '崩坏3': 'bh3', '崩坏三': 'bh3', '崩三': 'bh3', 'bh3': 'bh3',
};

const GAME_WORDS = '原神|genshin|ys|星穹铁道|崩坏星穹铁道|铁道|穹铁|星铁|sr|绝区零|绝区|zzz|ZZZ|崩坏3|崩坏三|崩三|bh3|Bh3|BH3';
const ACTION_WORDS = '多久没复刻|多久没UP|多久没up|多久没卡池|没复刻多久|未复刻';

export class gacha_timer extends plugin {
    constructor(e) {
        super({
            name: '[小花火]卡池计时器',
            dsc: '卡池UP未复刻统计与总览',
            event: 'message',
            priority: pluginPriority('gacha_timer', -3000),
            rule: [
                // 「多久没复刻」在前：#多久没复刻 可莉 / #星铁多久没复刻 阮梅
                { reg: `^[#%*]*(${GAME_WORDS})?\\s*(${ACTION_WORDS})\\s*([\\s\\S]*)$`, fnc: 'timerQuery' },
                // 名称在前：#可莉多久没复刻 / #阮梅多久没UP
                { reg: `^[#%*]*(${GAME_WORDS})?\\s*([\\s\\S]+?)\\s*(${ACTION_WORDS})$`, fnc: 'timerQueryNameFirst' },
                { reg: `^[#%*]*(${GAME_WORDS})?\\s*(UP总览|up总览|Up总览|UP一览|复刻总览|卡池总览|未复刻排行)\\s*([\\s\\S]*)$`, fnc: 'timerOverview' },
            ],
        });
    }

    dbg(...args) {
        if (config().debug) logger.mark('[xhh][卡池计时器]', ...args);
    }

    async timerQuery(e) {
        const { game, raw } = this.parse(e);
        const m = raw.match(new RegExp(`^(${GAME_WORDS})?\\s*(${ACTION_WORDS})\\s*([\\s\\S]*)$`, 'i'));
        const keyword = String(m?.[3] || '').trim();
        // 「未复刻排行」这类写法会先被这条规则吃掉，这里转给总览处理
        if (!keyword || /总览|排行/.test(keyword)) return this.doOverview(e, game);
        return this.replyQuery(e, game, keyword);
    }

    async timerQueryNameFirst(e) {
        const { game, raw } = this.parse(e);
        const m = raw.match(new RegExp(`^(${GAME_WORDS})?\\s*([\\s\\S]+?)\\s*(${ACTION_WORDS})$`, 'i'));
        const keyword = String(m?.[2] || '').trim();
        return this.replyQuery(e, game, keyword);
    }

    parse(e) {
        const raw = String(e.msg || e.raw_message || '').trim().replace(/^[#%*]+/, '').trim();
        const m = raw.match(new RegExp(`^(${GAME_WORDS})?\\s*([\\s\\S]*)$`, 'i'));
        const game = GAME_ALIAS[String(m?.[1] || '').toLowerCase()] || '';
        return { raw, game, word: String(m?.[2] || '').trim() };
    }

    async replyQuery(e, game, keyword) {
        if (!keyword) {
            return e.reply('用法：\n#多久没复刻 可莉 / #可莉多久没复刻\n#星铁多久没复刻 阮梅 / #绝区零多久没复刻 朱鸢 / #崩三多久没复刻 真理之律者\n不写游戏名会自动跨四游戏搜索\nUP 总览：#原神UP总览', true, { recallMsg: 60 });
        }

        let hits = [];
        try {
            hits = await gachaTimer.find(keyword, game || 'all', 8);
        } catch (err) {
            logger.error(`[xhh][卡池计时器] 查询失败: ${err?.message || err}`);
            return e.reply('卡池数据获取失败，请稍后再试。');
        }

        this.dbg('查询:', `keyword=${keyword}`, `game=${game || 'all'}`, `命中=${hits.length}`);

        if (!hits.length) {
            return e.reply(`没查到「${keyword}」的 UP 记录。${game === 'bh3' ? '（崩三只收录了本地史料库中的条目）' : ''}`, true, { recallMsg: 60 });
        }

        const exact = hits.find(v => gachaTimer.cleanName(v.name) === gachaTimer.cleanName(keyword));
        const target = exact || hits[0];

        // 顺便给出它在所属游戏里「多久没复刻」的排名
        let rank = 0;
        try {
            const all = await gachaTimer.list(target.game);
            const sorted = all.filter(v => (v.days ?? -1) >= 0).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
            rank = sorted.findIndex(v => v.name === target.name && v.group === target.group) + 1;
        } catch (_) {}

        const info = {
            ...target,
            gameName: gachaTimer.TIMER_GAMES[target.game]?.name || '',
            source: gachaTimer.TIMER_GAMES[target.game]?.source || '',
            url: gachaTimer.TIMER_GAMES[target.game]?.url || '',
            rank,
            others: hits.filter(v => v !== target).slice(0, 5).map(v => ({
                ...v,
                gameName: gachaTimer.TIMER_GAMES[v.game]?.name || '',
            })),
        };
        return await render('gacha_timer/item', info, { e, ret: true });
    }

    async timerOverview(e) {
        const { game } = this.parse(e);
        return this.doOverview(e, game);
    }

    async doOverview(e, game) {
        const target = game || 'ys';
        let data = null;
        try {
            data = await gachaTimer.overview(target, 15);
        } catch (err) {
            logger.error(`[xhh][卡池计时器] 总览失败: ${err?.message || err}`);
            return e.reply('卡池数据获取失败，请稍后再试。');
        }
        if (!data?.total) return e.reply('没取到该游戏的卡池数据，请稍后再试。');

        this.dbg('总览:', `game=${target}`, `总数=${data.total}`, `近期=${data.running.length}`, `排行=${data.ranking.length}`);
        return await render('gacha_timer/overview', data, { e, ret: true });
    }
}
