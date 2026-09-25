import {
    config,
    MysSign,
    zd_MysSign,
    BbsSign,
    BbsAutoSign,
    sendBbsAutoResult,
    yaml,
    sleep,
    reply_recallMsg,
    pluginPriority
} from '#xhh';
import lodash from 'lodash';
import Runtime from '../../../lib/plugins/runtime.js';

let signing = false;
let bbsSigning = false;
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
            if (wl.length > 0 && !wl.includes(e.group_id)) return false;
        }
        signing = true;
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
            for (const [key, value] of Object.entries(GAME_MAP)) {
                if (e.msg.includes(key)) {
                    await MysSign(e, value);
                    signing = false;
                    return true;
                }
            }

            await MysSign(e, ['gs', 'sr', 'zzz', 'bh3']);
        } catch (error) {
            logger.error(`签到异常: ${error.message}`);
        } finally {
            signing = false;
        }
        return true;
    }

    async bbsSign(e) {
        if (!config().sign) return false;
        if (signing || bbsSigning) return e.reply('有签到任务进行中, 过会儿再试吧！');
        if (e.isGroup) {
            const signData = yaml.get('./plugins/xhh/config/sign.yaml') || {};
            const wl = signData.bbs_sign_group || [];
            if (wl.length > 0 && !wl.includes(String(e.group_id)) && !wl.includes(Number(e.group_id))) return false;
        }
        signing = true;
        try {
            // 社区签到可能需要逐账号、逐版块请求；进度提示必须显式设置撤回时间，
            // 不能依赖框架默认值，否则会一直留在群里。
            await reply_recallMsg(e, '正在进行米游社社区签到，请稍等……', 60, false);
            addBbs(e);
            await BbsSign(e);
        } catch (error) {
            logger.error(`社区签到异常: ${error.message}`);
        } finally {
            signing = false;
        }
        return true;
    }

    async scheduled_bbs_sign() {
        const data = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        if (!data.bbs_zd_sign || !data.bbs_sign || typeof data.bbs_sign !== 'object') return false;
        if (!isSignTime(data, 'bbs_sign_hour', 'bbs_sign_minute')) return false;
        if (bbsSigning) return false;
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
        return true;
    }

    async scheduled_sign() {
        const data = yaml.get('./plugins/xhh/config/sign.yaml') || {};
        const isManual = !!this.e?.msg;
        if (!isManual && !isSignTime(data, 'sign_hour', 'sign_minute')) return false;
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

function addBbs(e) {
    const path = './plugins/xhh/config/sign.yaml';
    const data = yaml.get(path) || {};
    if (!data.bbs_zd_sign || !e.isGroup) return;
    if (!isAllowSignGroup(data.bbs_sign_group, e.group_id)) return;
    if (!data.bbs_sign || typeof data.bbs_sign !== 'object') data.bbs_sign = {};
    const group = String(e.group_id);
    const qq = String(e.user_id);
    const qqs = Array.isArray(data.bbs_sign[group]) ? data.bbs_sign[group].map(String) : [];
    if (!qqs.includes(qq)) qqs.push(qq);
    data.bbs_sign[group] = qqs;
    return yaml.set(path, 'bbs_sign', data.bbs_sign);
}

function isAllowSignGroup(signGroup, group) {
    // sign_group 为空数组/空值表示不限制；旧逻辑把 [] 当成 truthy，导致所有群都被跳过。
    if (!Array.isArray(signGroup) || signGroup.length === 0) return true;
    const gid = String(group);
    return signGroup.map(v => String(v)).includes(gid);
}

function isSignTime(data = {}, hourKey = 'sign_hour', minuteKey = 'sign_minute') {
    const hour = clampInt(data[hourKey], 0, 23, 0);
    const minute = clampInt(data[minuteKey], 0, 59, 0);
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
