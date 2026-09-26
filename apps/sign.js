import {
    config,
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
    yaml,
    sleep,
    pluginPriority
} from '#xhh';
import lodash from 'lodash';
import Runtime from '../../../lib/plugins/runtime.js';

let signing = false;
let bbsSigning = false;

// 各适配器 e.reply 的返回值结构不一致，尽量把 message_id 抠出来（取不到就别撤，绝不能误撤用户消息）
function pickMsgId(res) {
    if (!res) return '';
    if (Array.isArray(res)) return pickMsgId(res[0]);
    if (typeof res === 'object') return res.message_id ?? res.msg_id ?? res.data?.message_id ?? '';
    return res;
}

// 发一条会过期的临时提示：e.reply 的 recallMsg 选项在多数协议层会被静默忽略，
// 所以自己拿 message_id 定时主动撤回；不带引用（第二参数不传 true）
async function sendExpireTip(e, text, seconds = 60) {
    let msgId = '';
    try {
        msgId = pickMsgId(await e.reply(text));
    } catch (err) {
        if (config().debug) logger.mark(`[xhh][bbs_sign] e.reply 失败，退回 Bot.pickXxx: ${err.message}`);
        try {
            const target = e.isGroup ? Bot?.pickGroup?.(e.group_id) : Bot?.pickFriend?.(e.user_id);
            msgId = pickMsgId(await target?.sendMsg?.(text));
        } catch (_) {}
    }
    if (config().debug) logger.mark(`[xhh][bbs_sign] 稍等提示 message_id=${msgId || '未取到'}`);
    if (!msgId) return async () => {};
    let recalled = false;
    const recall = async () => {
        if (recalled) return true;
        const done = await recallOwnMsg(e, msgId);
        if (done) {
            recalled = true;
        } else if (config().debug) {
            logger.mark('[xhh][bbs_sign] 稍等提示撤回失败：适配器不支持主动撤回');
        }
        return done;
    };
    // 60s 兜底撤回
    setTimeout(recall, seconds * 1000);
    // 同时返回立即撤回函数：签到结果出来后提示就没用了，调用方可以马上撤
    return recall;
}

// 撤回自己发的消息：几套 API 挨个试，有一套能用就行
async function recallOwnMsg(e, messageId) {
    if (!messageId) return false;
    const tasks = e.isGroup
        ? [
            () => e.group?.recallMsg(messageId),
            () => Bot?.pickGroup?.(e.group_id)?.recallMsg(messageId),
        ]
        : [
            () => e.friend?.recallMsg(messageId),
            () => Bot?.pickFriend?.(e.user_id)?.recallMsg(messageId),
        ];
    tasks.push(() => Bot?.deleteMsg?.(messageId), () => e.bot?.recallMsg?.(messageId));
    for (const task of tasks) {
        try {
            const ret = task();
            if (ret?.then) await ret;
            return true;
        } catch (_) {}
    }
    return false;
}

export class Sign extends plugin {
    constructor(e) {
        super({
            name: '[小花火]签到',
            dsc: '签到',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [{
                    reg: '^#*(小花火|xhh)*(原神|星铁|绝区零|崩三|崩坏3|崩坏三|BH3)*签到$',
                    fnc: 'sign',
                },
                {
                    reg: '^#*(小花火|xhh)*全部游戏签到$',
                    fnc: 'sign',
                },
                {
                    reg: '^#(小花火|xhh)*(本群)*开始签到$',
                    fnc: 'scheduled_sign',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*((米游社|社区|论坛)(全部)?(米游社|社区|论坛)?|全部(米游社|社区|论坛))签到$',
                    fnc: 'bbsSign',
                },
            ],
        });
        this.task = {
            cron: '0 * * * * *', //每分钟检查一次，实际执行时间由 sign.yaml 的 sign_hour/sign_minute 控制
            name: '[小花火]米游社签到',
            fnc: async () => {
                await this.scheduled_sign();
                await this.scheduled_bbs_sign();
            },
            log: true,
        };
    }

    async sign(e) {
        if (!config().sign) return false;
        if (signing) return e.reply('有签到任务进行中, 过会儿再试吧！');
        if (e.isGroup) {
            const signData = yaml.get('./plugins/xhh/config/sign.yaml');
            const wl = signData.sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) return false;
        }
        signing = true;
        let recallTip;
        const allAccounts = /全部游戏/.test(e.msg || '');
        const GAME_MAP = {
            星铁: ['sr'],
            绝区零: ['zzz'],
            原神: ['gs'],
            崩三: ['bh3'],
            崩坏3: ['bh3'],
            崩坏三: ['bh3'],
            BH3: ['bh3'],
        };
        try {
            // 和社区签到一致：先发临时提示，签到结果出来后立刻撤回，60s 兜底撤回
            recallTip = await sendExpireTip(e, '正在进行米游社游戏签到，请稍等……', 60);
            for (const [key, value] of Object.entries(GAME_MAP)) {
                if (e.msg.includes(key)) {
                    await MysSign(e, value, allAccounts);
                    return false;
                }
            }

            await MysSign(e, ['gs', 'sr', 'zzz', 'bh3'], allAccounts);
        } catch (error) {
            logger.error(`签到异常: ${error.message}`);
        } finally {
            signing = false;
            try { await recallTip?.(); } catch (_) {}
        }
        return false;
    }

    async bbsSign(e) {
        if (!config().sign) {
            await e.reply('签到功能未开启，请在配置里把 sign 设为 true 后再试', true, { recallMsg: 60 });
            return false;
        }
        if (signing || bbsSigning) {
            await e.reply('有签到任务进行中, 过会儿再试吧！');
            return false;
        }
        if (e.isGroup) {
            const signData = yaml.get('./plugins/xhh/config/sign.yaml') || {};
            const wl = signData.bbs_sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) return false;
        }
        signing = true;
        let recallTip;
        try {
            // 只是「请稍等」的临时提示：结果出来就撤，最迟 60s 兜底撤回
            recallTip = await sendExpireTip(e, '正在进行米游社社区签到，请稍等……', 60);
            addBbs(e);
            await BbsSign(e);
        } catch (error) {
            logger.error(`社区签到异常: ${error.message}`);
        } finally {
            signing = false;
            try { await recallTip?.(); } catch (_) {}
        }
        return false;
    }

    async scheduled_bbs_sign() {
        const data = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        if (!data.bbs_zd_sign || !data.bbs_sign || typeof data.bbs_sign !== 'object') return false;
        if (!isSignTime(data, 'bbs_sign_hour', 'bbs_sign_minute', 3, 30)) return false;
        if (signing || bbsSigning) return false;
        bbsSigning = true;
        try {
            let groups = Object.keys(data.bbs_sign || {}).filter(group =>
                Array.isArray(data.bbs_sign[group]) && data.bbs_sign[group].length > 0
            );
            if (Array.isArray(data.bbs_sign_group) && data.bbs_sign_group.length) {
                const allow = new Set(data.bbs_sign_group.map(v => String(v)));
                groups = groups.filter(group => allow.has(String(group)));
            }
            for (const group of groups) {
                const result = await BbsAutoSign(data.bbs_sign[group]);
                await sendBbsAutoResult(group, result);
                await sleep(1000);
            }
        } catch (error) {
            logger.error(`社区自动签到异常: ${error.message}`);
        } finally {
            bbsSigning = false;
        }
        return false;
    }

    async scheduled_sign() {
        const data = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        const isManual = !!this.e?.msg;
        if (!isManual && !isSignTime(data, 'sign_hour', 'sign_minute', 0, 0)) return false;
        if (!data.zd_sign || !data.sign || typeof data.sign != 'object') return false;
        signing = true;
        try {

            let groups = Object.keys(data.sign).sort(
                (a, b) => data.sign[b].length - data.sign[a].length
            );
            if (this.e?.msg?.includes('本群') && this.e.isGroup)
                groups = [this.e.group_id];
            for (const group of groups) {
                if (!isAllowSignGroup(data.sign_group, group)) continue; //非白名单群
                if (!Array.isArray(data.sign[group]) || data.sign[group].length === 0) continue; //群里没人
                let data_ = {
                    qqs: data.sign[group],
                };
                let path = 'sign/list';
                //渲染
                let img = await render(path, data_);
                try {
                    Bot.pickGroup(Number(group)).sendMsg(img);
                } catch (err) {
                    logger.error(err);
                    continue;
                }
                const {
                    num,
                    z_num,
                    cg_qqs,
                    sbai_qqs
                } = await zd_MysSign(
                    data.sign[group]
                ); //开始签到
                data_ = {
                    num,
                    z_num,
                    cg_qqs,
                    sbai_qqs,
                };
                path = 'sign/end_list';
                img = await render(path, data_);
                await Bot.pickGroup(Number(group)).sendMsg(img);
                if (sbai_qqs.length) {
                    //删除签到失败的qq
                    del(sbai_qqs, group);
                    if (data.sbai) {
                        let atqq = sbai_qqs.map(v => v = segment.at(v))
                        Bot.pickGroup(Number(group)).sendMsg(atqq);
                    }
                }
                await sleep(200);
            }

        } catch (error) {
            logger.error(`自动签到异常: ${error.message}`);
        } finally {
            signing = false;
        }
    }
}

function del(qqs, group) {
    const path = './plugins/xhh/config/sign.yaml';
    const data = yaml.get(path);
    data.sign[group] = removeCommonElements(data.sign[group], qqs)
    return yaml.set(path, 'sign', data.sign);
}

function isAllowSignGroup(signGroup, group) {
    // sign_group 为空数组/空值表示不限制；旧逻辑把 [] 当成 truthy，导致所有群都被跳过。
    if (!Array.isArray(signGroup) || signGroup.length === 0) return true;
    const gid = String(group);
    return signGroup.map(v => String(v)).includes(gid);
}

function addBbs(e) {
    const path = './plugins/xhh/config/sign.yaml';
    const data = yaml.get(path) || {};
    if (!data.bbs_zd_sign || !e.isGroup) return false;
    if (!isAllowSignGroup(data.bbs_sign_group, e.group_id)) return false;
    if (!data.bbs_sign || typeof data.bbs_sign !== 'object') data.bbs_sign = {};
    const group = String(e.group_id);
    const qq = String(e.user_id);
    const qqs = Array.isArray(data.bbs_sign[group]) ? data.bbs_sign[group].map(String) : [];
    if (qqs.includes(qq)) return false;
    qqs.push(qq);
    data.bbs_sign[group] = qqs;
    return yaml.set(path, 'bbs_sign', data.bbs_sign);
}

function isSignTime(data = {}, hourKey = 'sign_hour', minuteKey = 'sign_minute', defHour = 0, defMinute = 0) {
    const hour = clampInt(data[hourKey], 0, 23, defHour);
    const minute = clampInt(data[minuteKey], 0, 59, defMinute);
    const now = new Date();
    return now.getHours() === hour && now.getMinutes() === minute;
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
}

function removeCommonElements(arr1, arr2) {
    // 将数组2转为Set提高查找效率
    const set2 = new Set(arr2);
    // 过滤掉数组1中存在于数组2的元素
    return arr1.filter(item => !set2.has(item));
}

async function render(path, data_) {
    let tplFile = process.cwd() + '/plugins/xhh/resources/' + path + '.html';
    const img = await new Runtime().render('小花火', path, data_, {
        retType: 'base64',
        beforeRender({
            data
        }) {
            return {
                sys: {
                    scale: `style=transform:scale(${(config().img_quality / 100) * 2.4 || 2.4 * 0.8})`,
                },
                ...data_,
                ppath: '../../../../../plugins/xhh/resources/',
                tplFile: tplFile,
                saveId: path.split('/')[path.split('/').length - 1],
            };
        },
    });
    return img;
}
