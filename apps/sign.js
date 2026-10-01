import {
    config,
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
    collapseMsgs,
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
                {
                    reg: '^#*(小花火|xhh)*(手动验证|验证码)(服务)?(自测|测试|test)$',
                    fnc: 'gtTest',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*(手动)?(过码|过验证码|真实过码)(端到端)?(测试|test)$',
                    fnc: 'gtRealTest',
                    permission: 'master',
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
        // 手动签到不再看 zd_sign。那个开关字面写的是「自动签到：0关闭 1开启」，
        // 只该管定时任务（scheduled_sign 内部会查），拿它挡手动指令等于
        // 「关掉自动签到 → 手动也没法签」，实测很多人被这个静默返回坑住，
        // 在群里表现为「发了 xhh签到 完全没反应」。手动是明确要求的动作，直接做。
        // 「这个命令该让给别的插件」由 config.yaml 的 sign_priority 决定，
        // 不在代码里硬写 return false —— 数字越大越晚处理，想让位就把它调大。
        // sign 是群号到QQ列表的白名单映射，不是开关，不能拿它判断。
        const signCfg = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        if (signing) return e.reply('有签到任务进行中, 过会儿再试吧！');
        if (e.isGroup) {
            const wl = signCfg.sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) {
                return e.reply(`本群不在游戏签到白名单里，已跳过（白名单：${wl.join('、')}）\n可在锅巴「签到设置 → 游戏签到白名单群」里增删，或清空表示不限制`, true, { recallMsg: 120 });
            }
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

    // 手动过码端到端测试：用真实的 createVerification 造一个真实验证码，
    // 过完码再回交 verifyVerification，能完整验证「本地服务 → 页面 → 回传 → 米游社换 challenge」整条链路。
    async gtRealTest(e) {
        const { default: api } = await import('../system/api.js');
        const { default: mhy } = await import('../system/mhy.js');
        const { manualGeetest } = await import('../system/manual_geetest.js');
        const uid = e.user?.getUid?.('gs') || e.user?.getUid?.();
        if (!uid) return e.reply('未找到绑定的 UID，请先 #小花火扫码绑定', true);
        const sk = await mhy.getstoken(e, uid);
        if (!sk) return e.reply(`UID:${uid} 未绑定米游社 SToken，请先 #小花火扫码绑定`, true);

        const headers = mhy.getHeaders(e, sk, false);
        headers['x-rpc-client_type'] = 5;
        headers.DS = mhy.getDs2('gids=2&is_high=false', '', 4);

        const create = await api(e, { headers, type: 'createVerification' });
        if (Number(create?.retcode) !== 0 || !create?.data?.gt) {
            return e.reply(`获取验证码失败：retcode=${create?.retcode} message=${create?.message || '无'}`, true);
        }
        await e.reply(`已向米游社申请真实验证码（gt=${String(create.data.gt).slice(0, 12)}…），正在准备验证链接…`, true);
        const validated = await manualGeetest(e, { ...create.data, uid }, '手动过码端到端测试');
        if (!validated?.validate) return e.reply('未完成验证（超时或主动关闭），本次测试结束。', true);

        // 回交米游社，换取新的 challenge
        const body = JSON.stringify({
            geetest_challenge: validated.challenge || create.data.challenge,
            geetest_validate: validated.validate,
            geetest_seccode: validated.seccode || `${validated.validate}|jordan`,
        });
        const verifyHeaders = { ...headers, DS: mhy.getDs2('', body, 4) };
        const verify = await api(e, { headers: verifyHeaders, type: 'verifyVerification', body });
        if (Number(verify?.retcode) === 0) {
            return e.reply(
                `✅ 端到端测试通过\n` +
                '· 本地验证页渲染正常、Geetest 可加载\n' +
                '· 滑块结果成功回传\n' +
                '· 米游社 verifyVerification 校验通过（retcode=0），风控已解除\n' +
                '现在可以正常查体力/签到了。',
                true,
            );
        }
        return e.reply(`⚠️ 页面验证成功，但米游社回交校验失败：retcode=${verify?.retcode} message=${verify?.message || '无'}`, true);
    }

    // 手动验证服务自测
    async gtTest(e) {
        const { manualGeetestTest } = await import('../system/manual_geetest.js');
        return manualGeetestTest(e);
    }

    async bbsSign(e) {
        // 同上：bbs_zd_sign 只管定时任务（scheduled_bbs_sign 内部会查），
        // 不再挡手动指令；让位靠 config.yaml 的 sign_priority。
        // sign 是群号到QQ列表的白名单映射，不是开关。
        const bbsCfg = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        if (signing || bbsSigning) {
            await e.reply('有签到任务进行中, 过会儿再试吧！');
            return false;
        }
        if (e.isGroup) {
            const wl = bbsCfg.bbs_sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) {
                // 之前这里直接静默返回，群里看起来就是「指令没反应」，补一句提示便于排查
                return e.reply(`本群不在社区签到白名单里，已跳过（白名单：${wl.join('、')}）\n可在锅巴「签到设置 → 社区签到白名单群」里增删，或清空表示不限制`, true, { recallMsg: 120 });
            }
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
                const result = await BbsAutoSign(data.bbs_sign[group], group);
                // 与游戏自动签到一致：定时结果出图，渲染失败才退回文字
                let img = '';
                try {
                    img = await render('sign/sign', {
                        msgs: collapseMsgs(result.msgs || []),
                        qq: '',
                        xhhAvatar: true,
                    }, { saveId: 'bbs_auto_sign' });
                } catch (err) {
                    logger.error(`[社区自动签到] 出图失败，退回文字: ${err.message}`);
                }
                await sendBbsAutoResult(group, result, img);
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
        if (!data.zd_sign) return false;
        if (!data.sign || typeof data.sign != 'object' || !Object.keys(data.sign).length) {
            // 开关开着却没有群记录时静默 return，表现为「自动签到开了却什么都不做」。
            // 这个字典只有手动在群里签过一次才会写入，这里记一笔便于排查。
            logger.mark('[游戏自动签到] 开关已开，但没有任何登记群，未执行。'
                + '请在目标群里发「#加入自动签到」登记一次');
            return false;
        }
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

async function render(path, data_, cfg = {}) {
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
                // sign/sign.html 被游戏签到和社区签到共用，saveId 撞了会命中对方的渲染缓存
                saveId: cfg.saveId || path.split('/')[path.split('/').length - 1],
            };
        },
    });
    return img;
}
