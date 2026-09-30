/**
 * 主动撤回自己发的消息
 *
 * 为什么需要单独一个模块：
 * system/sign.js 和 system/manual_geetest.js 都要用这套逻辑，但 sign.js 已经
 * import 了 manual_geetest.js，两边互相 import 会成环，所以放这里被两边共用。
 *
 * 为什么要自己实现而不是用 e.reply(msg, false, { recallMsg: n })：
 * 那条路只在有真实 e 的时候能用，而且实测多数协议层会静默忽略这个选项。
 * 定时任务（社区自动签到）根本没有 e，只能 Bot.pickGroup().sendMsg()，
 * 发出去的消息如果不自己记 message_id，就永远是撤不掉的。
 */

/** 各适配器 sendMsg 的返回结构不统一，尽量把消息 id 抠出来 */
export function pickSentMsgId(res) {
    if (!res) return '';
    if (Array.isArray(res)) return pickSentMsgId(res[0]);
    if (typeof res === 'object') return res.message_id ?? res.msg_id ?? res.data?.message_id ?? '';
    return res;
}

/**
 * 群消息延时撤回
 *
 * @param {number|string} groupId 群号
 * @param {any} sent sendMsg 的返回值
 * @param {number} seconds 多少秒后撤回
 * @returns {boolean} 是否安排了撤回（取不到消息 id 时返回 false）
 */
export function scheduleGroupRecall(groupId, sent, seconds = 60) {
    const msgId = pickSentMsgId(sent);
    // 取不到 id 就不撤。宁可让消息留着刷屏，也绝不能拿个空 id 去撤别人的消息。
    if (!msgId) return false;
    const gid = Number(groupId);
    const wait = Math.max(5, Number(seconds) || 60);
    setTimeout(async () => {
        // 逐个尝试，但必须先确认这个方法真的存在再调用、且没抛错，才算这一套可用。
        // 不能像原来那样调用完就 return —— pickGroup() 返回的对象上可能根本没有
        // recallMsg，?.() 会静默返回 undefined，直接 return 就再也试不到 deleteMsg 了。
        const group = Bot?.pickGroup?.(gid);
        const attempts = [
            [group?.recallMsg, [msgId]],
            [Bot?.deleteMsg, [msgId]],
        ];
        for (const [fn, args] of attempts) {
            if (typeof fn !== 'function') continue;
            try {
                await fn.apply(group, args);
                return;
            } catch (_) {
                // 这套 API 报错了，换下一套
            }
        }
    }, wait * 1000);
    return true;
}
