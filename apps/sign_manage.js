import fs from 'node:fs';
import path from 'node:path';
import { config, yaml, sleep, makeForwardMsg, gameOfEntry, pluginPriority } from '#xhh';
import { scheduleGroupRecall } from '../system/msgRecall.js';

/**
 * 扫码绑定情况一览 + 主人代签到
 *
 * 「谁扫码过来了」的数据来自两处，插件自身存的和逍遥插件存的：
 *   ./plugins/xhh/data/Stoken/<QQ>.yaml
 *   ./plugins/xiaoyao-cvs-plugin/data/yaml/<QQ>.yaml
 * 两边可能都绑（这时按 stuid 去重），也可能只有一边。
 */

const XH_DIR = './plugins/xhh/data/Stoken';
const XY_DIR = './plugins/xiaoyao-cvs-plugin/data/yaml';
const SIGN_YAML = './plugins/xhh/config/sign.yaml';

const GAME_CN = { gs: '原神', sr: '星铁', zzz: '绝区零', bh3: '崩三' };

// Bot 是全局，稳妥起见按仓库惯例兜底
const getBot = () => globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null);

function readYaml(p) {
    // 先判存在再读：yaml.get 内部会 catch 住 ENOENT 并 logger.error，
    // 而逍遥侧的人本来就没有 xhh 侧的 yaml 文件，不判一下每次都要往 error.log 刷一条
    if (!fs.existsSync(p)) return {};
    try { return yaml.get(p) || {}; } catch { return {}; }
}

function listQq(dir) {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''));
    } catch { return []; }
}

/**
 * 汇总某个 QQ 的绑定情况。
 * @returns {null|{qq, fromXh, fromXy, stuids:Set<string>, games:Set<string>, accounts:number}}
 */
function collectAccount(qq) {
    const xh = readYaml(path.posix.join(XH_DIR, `${qq}.yaml`));
    const xy = readYaml(path.posix.join(XY_DIR, `${qq}.yaml`));
    const xhList = Object.values(xh).filter(v => v?.stuid && v?.stoken);
    const xyList = Object.values(xy).filter(v => v?.stuid && v?.stoken);
    if (!xhList.length && !xyList.length) return null;

    const stuids = new Set();
    const games = new Set();
    // 两个来源都要算游戏。以前只算逍遥那半边，导致「只在本插件存了文件、没绑逍遥」的人
    // 游戏一栏全是未知 —— 那批记录里 region_name 其实是有的，只是没被读。
    for (const v of [...xhList, ...xyList]) {
        stuids.add(String(v.stuid));
        const g = gameOfEntry(v);
        if (g) games.add(g);
    }
    return {
        qq,
        fromXh: xhList.length > 0,
        fromXy: xyList.length > 0,
        stuids,
        games,
        accounts: stuids.size,
    };
}

/** 所有绑定了 CK 的 QQ，合并两个来源 */
function collectAll() {
    const qqs = [...new Set([...listQq(XH_DIR), ...listQq(XY_DIR)])];
    return qqs.map(collectAccount).filter(Boolean);
}

/** 某个群签到过的成员（sign.yaml 里 add()/addBbs() 记的） */
function groupMembers(group) {
    const d = readYaml(SIGN_YAML);
    const gid = String(group);
    const pick = v => (Array.isArray(v) ? v.map(String) : []).filter(Boolean);
    return {
        sign: pick(d?.sign?.[gid]),
        bbs: pick(d?.bbs_sign?.[gid]),
    };
}

/** 一个 QQ 都在哪些群的签到名单里 */
function groupsOf(qq) {
    const d = readYaml(SIGN_YAML);
    const out = [];
    for (const [key, map] of [['游戏', d?.sign], ['社区', d?.bbs_sign]]) {
        for (const [gid, list] of Object.entries(map || {})) {
            if (Array.isArray(list) && list.map(String).includes(String(qq))) out.push(`${key}:${gid}`);
        }
    }
    return out;
}

const maskStuid = s => {
    const t = String(s || '').trim();
    return !t ? '—' : t.length <= 4 ? t : `****${t.slice(-4)}`;
};

function describe(acc) {
    const src = [acc.fromXh && '小花火', acc.fromXy && '逍遥'].filter(Boolean).join('+');
    const games = acc.games.size
        ? [...acc.games].map(g => GAME_CN[g] || g).join('/')
        : '未知（该来源没记游戏）';
    const stuids = [...acc.stuids].slice(0, 3).map(maskStuid).join(' ');
    const more = acc.stuids.size > 3 ? ` 等${acc.stuids.size}个` : '';
    const gs = groupsOf(acc.qq);
    return `QQ ${acc.qq}\n  来源：${src}　账号：${acc.accounts}　游戏：${games}\n  stuid：${stuids}${more}`
        + (gs.length ? `\n  已在签到名单：${gs.join('、')}` : '');
}

/**
 * 拉群成员 QQ。部分 TRSS/OneBot 连接器的群对象缓存为空，
 * 所以对象方法取不到时再用 sendApi 实时拉一次（参考 stamina_remind 的做法）。
 */
async function fetchGroupQqs(e) {
    const gid = Number(e?.group_id);
    if (!e?.isGroup || !gid) return [];
    let members = [];
    const group = e.group;
    try {
        if (group?.getMemberArray) members = await group.getMemberArray();
        if (!members?.length && group?.getMemberMap) members = await group.getMemberMap(true);
        if (!members?.length && group?.getMemberList) members = await group.getMemberList();
    } catch { /* 换下面的 sendApi */ }
    if ((!members || !members.length) && e.bot?.sendApi) {
        try {
            const res = await e.bot.sendApi('get_group_member_list', { group_id: gid, no_cache: true });
            members = res?.data || res || [];
        } catch { /* 拉不到就退回名单记录 */ }
    }
    return (Array.isArray(members) ? members : [])
        .map(m => String(m?.user_id ?? m?.userId ?? m ?? '').trim())
        .filter(v => /^\d{5,12}$/.test(v));
}

/**
 * 解析代签到目标。
 * @param {string} input 指令后面跟的内容
 * @param {string|number} groupId 当前群
 * @param {string[]} memberQqs 当前群成员（拉不到就传空数组）
 */
/** 名单卡模板用的扁平结构 */
function cardData(acc) {
    const src = [acc.fromXh && '小花火', acc.fromXy && '逍遥'].filter(Boolean).join('+');
    const games = acc.games.size ? [...acc.games].map(g => GAME_CN[g] || g).join('/') : '未知';
    const stuids = [...acc.stuids].map(maskStuid);
    const more = stuids.length > 3 ? ` 等${stuids.length}个` : '';
    return {
        qq: acc.qq,
        src,
        accounts: acc.accounts,
        games,
        stuids: (stuids.slice(0, 3).join(' ') || '无') + more,
        groups: groupsOf(acc.qq).join('、'),
    };
}

/**
 * 把这次代签到的人写进本群的签到名单，之后定时自动签到会覆盖他们。
 * 只在群已登记进白名单时才写 —— scheduled_sign 会按 sign_group 过滤，
 * 不在白名单的群写进去也是白写，不如直接说明。
 */
export function recordMembers(gid, qqs) {
    const d = readYaml(SIGN_YAML);
    const gidS = String(gid);
    const out = [];
    for (const [key, allowKey, label] of [
        ['sign', 'sign_group', '游戏'],
        ['bbs_sign', 'bbs_sign_group', '社区'],
    ]) {
        const allow = d[allowKey];
        const whitelisted = !(Array.isArray(allow) && allow.length) || allow.map(String).includes(gidS);
        if (!whitelisted) {
            out.push(`${label}：本群不在自动签到白名单，未写入（可发「#加入自动签到」）`);
            continue;
        }
        const cur = d[key] && Array.isArray(d[key][gidS]) ? d[key][gidS].map(String) : [];
        const next = [...new Set(cur.concat((qqs || []).map(String)))];
        if (next.length === cur.length) {
            out.push(`${label}：已在名单（${next.length} 人）`);
            continue;
        }
        yaml.set(SIGN_YAML, key, { ...(d[key] || {}), [gidS]: next });
        out.push(`${label}：新增 ${next.length - cur.length} 人，共 ${next.length} 人`);
    }
    return out;
}

/**
 * 从消息段里取被 @ 的 QQ。
 * 不同连接器 at 段落在 data.qq / data.target / data.user_id 上，位置参数也可能带，
 * 逐个兜住；取不到就当没有 @，退回按文字参数解析。
 */
export function atQqs(e) {
    const segs = Array.isArray(e?.message) ? e.message : [];
    const out = [];
    for (const seg of segs) {
        if (seg?.type !== 'at') continue;
        const d = seg.data || {};
        for (const v of [d.qq, d.target, d.user_id, d.uid, d.id, seg.qq]) {
            const q = String(v ?? '').trim().replace(/[^0-9]/g, '');
            if (/^\d{5,12}$/.test(q)) { out.push(q); break; }
        }
    }
    return [...new Set(out)];
}

export function resolveTargets(input = '', groupId = '', memberQqs = []) {
    const raw = String(input || '').trim();
    if (/^(全部|all|所有)$/i.test(raw)) {
        return { mode: 'all', label: '全部已绑定账号', qqs: collectAll().map(a => a.qq) };
    }
    if (/^(本群|当前群|this)$/i.test(raw)) {
        const gid = String(groupId || '');
        // 优先按群成员 ∩ 有 CK：这样连从没签到过、但绑了 CK 的成员也能代签。
        // 群成员拉不到时退回「签到名单里记录过的」。
        const bound = new Set(collectAll().map(a => a.qq));
        const inGroup = memberQqs.filter(q => bound.has(q));
        const qqs = inGroup.length ? inGroup : collectAll().filter(a => groupMembers(gid).sign.concat(groupMembers(gid).bbs).includes(a.qq)).map(a => a.qq);
        const how = inGroup.length ? `群成员中 ${inGroup.length} 人绑了 CK` : '按签到名单记录';
        return { mode: 'group', label: gid ? `本群(${gid})·${how}` : `本群·${how}`, qqs };
    }
    const qqs = raw.split(/[,，\s]+/).map(v => v.trim()).filter(v => /^\d{5,12}$/.test(v));
    return { mode: 'qq', label: qqs.join('、') || '（未识别）', qqs };
}

export class SignManage extends plugin {
    constructor(e) {
        super({
            name: '[小花火]签到名单',
            dsc: '查看扫码绑定情况，主人可代成员签到',
            event: 'message',
            priority: pluginPriority('sign', -26),
            rule: [
                // 「#签到名单 本群」要排在「#签到名单」前面：
                // 后者以 $ 结尾，本来就匹配不到带尾巴的形式，但先特指后泛指更不容易将来改错。
                {
                    reg: '^#*(小花火|xhh)*(签到|绑定|CK|ck)(名单|列表|情况|一览)\s*(本群|当前群)$',
                    fnc: 'listGroup',
                    permission: 'master',
                },
                { reg: '^#*(小花火|xhh)*(签到|绑定|CK|ck)(名单|列表|情况|一览)$', fnc: 'list', permission: 'master' },
                {
                    reg: '^#*(小花火|xhh)*(本群|当前群)(签到名单|绑定列表|名单|CK情况)$',
                    fnc: 'listGroup',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*(代|帮|代替)(游戏|社区|论坛)?签到(.*)$',
                    fnc: 'proxySign',
                    permission: 'master',
                },
                {
                    reg: '^#*(小花火|xhh)*(加入|退出|移出)(游戏)?(自动)?(签到|签到群)$',
                    fnc: 'enroll',
                    permission: 'master',
                },
            ],
        });
    }

    /**
     * 把本群登记进游戏自动签到。
     * scheduled_sign 要求 data.sign 非空才跑，而这个字典只有手动在群里签过一次
     * 才会被 add() 写入 —— 于是「自动签到开着却一个群都没有」会静默空转。
     * 这里提供显式登记，顺便把群加进 sign_group 白名单。
     */
    async enroll(e) {
        if (!e.isGroup) return e.reply('请在要自动签到的群里发这条指令。', true);
        const quit = /退出|移出/.test(e.msg);
        const gid = String(e.group_id);
        const d = readYaml(SIGN_YAML);
        const out = [];

        for (const [key, label] of [['sign_group', '游戏'], ['bbs_sign_group', '社区']]) {
            const arr = (Array.isArray(d[key]) ? d[key] : []).map(String);
            const had = arr.includes(gid);
            const value = quit ? arr.filter(g => g !== gid) : (had ? arr : [...arr, gid]);
            if (had === quit) {
                out.push(`${label}：${quit ? '本来就未登记' : '已登记过'}`);
                continue;
            }
            yaml.set(SIGN_YAML, key, value.map(v => (/^\d+$/.test(v) ? Number(v) : v)));
            out.push(`${label}自动签到${quit ? '已退出' : '已开启'}`);
        }

        for (const [key, label] of [['sign', '游戏'], ['bbs_sign', '社区']]) {
            if (quit) {
                const n = Object.keys(d[key] || {}).length;
                yaml.set(SIGN_YAML, key, {});
                out.push(`${label}签到群记录已清空（原 ${n} 个群）`);
            } else if (!(d[key] && d[key][gid])) {
                yaml.set(SIGN_YAML, key, { ...(d[key] || {}), [gid]: [String(e.user_id)] });
                out.push(`${label}签到群记录已写入（种子：发起人 QQ）`);
            }
        }

        logger.mark(`[签到名单] ${e.user_id} ${quit ? '退出' : '加入'}自动签到 群 ${gid} → ${out.join('；')}`);
        return e.reply(`${quit ? '已退出' : '已加入'}本群的自动签到\n`
            + out.map(x => '  · ' + x).join('\n')
            + '\n\n自动签到会遍历登记群里**所有绑定了 CK** 的成员，不限于发起人。', true);
    }

    /** 全量名单：所有绑定了 CK 的账号，不分群 */
    async list(e) {
        return this.showRoster(e, collectAll(), '扫码绑定情况');
    }

    /** 本群名单：群成员 ∩ 已绑定。取不到群成员时如实说明，不悄悄退化成全量 */
    async listGroup(e) {
        if (!e.isGroup) return e.reply('请在群里发这条指令。', true);
        const memberQqs = await fetchGroupQqs(e);
        if (!memberQqs.length) {
            return e.reply('拉不到本群成员列表，没法确定「本群」都有谁。\n'
                + '可以改用「#签到名单」看全部。', true);
        }
        const all = collectAll();
        const inGroup = all.filter(a => memberQqs.includes(a.qq));
        return this.showRoster(e, inGroup,
            `本群扫码绑定情况（${inGroup.length}/${memberQqs.length} 人）`, memberQqs.length);
    }

    /**
     * 出名单图，出图失败才退回合并转发（makeForwardMsg 在连接器不支持时会内部退回纯文本）。
     * 只私聊模式下必须走 base64 再私发 —— 直接 ret:true 会把带 QQ 的图发到群里，
     * 锅巴那个开关就白开了。
     */
    async showRoster(e, all, title, memberTotal) {
        if (!all.length) {
            return e.reply(memberTotal
                ? `本群 ${memberTotal} 人里，还没有人扫码绑定过 CK。\n`
                    + '让成员发「#小花火扫码绑定」完成绑定后再试。'
                : '还没有任何人扫码绑定过 CK。\n让成员发「#小花火扫码绑定」完成绑定后再试。', true);
        }
        const both = all.filter(a => a.fromXh && a.fromXy).length;
        const head = `${title}\n`
            + `小花火侧 ${all.filter(a => a.fromXh).length} 人，逍遥侧 ${all.filter(a => a.fromXy).length} 人`
            + (both ? `，其中 ${both} 人两边都绑了` : '');
        const nodes = all.map(acc => {
            const who = e.isGroup ? (e.group?.getMemberMap?.()?.get?.(Number(acc.qq))?.card) : '';
            const name = [who, `QQ ${acc.qq}`].filter(Boolean).join(' · ');
            return { user_id: Number(acc.qq) || acc.qq, nickname: name, message: describe(acc) };
        });

        const { render } = await import('#xhh');
        const card = {
            title,
            total: all.length,
            xh: all.filter(a => a.fromXh).length,
            xy: all.filter(a => a.fromXy).length,
            both,
            people: all.map(cardData),
        };

        // 先回一句数量再出图。渲染要一秒多，中间完全静默，
        // 图要是被连接器丢掉了，体感上和「没反应」一模一样。
        const accTotal = all.reduce((n, a) => n + a.accounts, 0);
        const brief = memberTotal
            ? `${title}\n本群 ${memberTotal} 人，其中 ${all.length} 人绑定了 CK（合计 ${accTotal} 个账号）`
            : `${title}\n共 ${all.length} 人，合计 ${accTotal} 个账号`;
        await e.reply(brief, true);

        const privOnly = config()?.sign_list_private === true;

        if (privOnly && e.isGroup) {
            const botObj = getBot();
            const target = botObj?.pickFriend ? botObj.pickFriend(e.user_id) : null;
            if (!target) return e.reply(await makeForwardMsg(e, nodes, head), true);
            try {
                const img = await render('sign/roster', card);
                if (img) {
                    await e.reply('名单含全体 QQ 号，按设置私聊发出。', true);
                    return target.sendMsg(img);
                }
            } catch (err) {
                logger.error(`[xhh][签到名单] 出图失败，退回合并转发: ${err.message}`);
            }
            const msg_ = await makeForwardMsg(e, nodes, head);
            await e.reply('名单含全体 QQ 号，按设置私聊发出。', true);
            return target.sendMsg(msg_);
        }

        try {
            await render('sign/roster', card, { e, ret: true });
            return true;
        } catch (err) {
            logger.error(`[xhh][签到名单] 出图失败，退回合并转发: ${err.message}`);
        }
        return e.reply(await makeForwardMsg(e, nodes, head), true);
    }

    async signGenshinCks(e) {
        const { getGenshinCks, probeCk, bbsSignCks, render } = await import('#xhh');
        const cks = await getGenshinCks();
        if (!cks.length) {
            return e.reply('没读到 genshin 插件的 CK。\n'
                + '它的库在 ./data/db/data.db 的 MysUsers 表，'
                + '插件没装或表为空时会读不到。', true);
        }
        const gNotice = await e.reply(`开始签 genshin 侧 CK：共 ${cks.length} 条，正在逐个验活并签到…`, true);
        if (e.isGroup) scheduleGroupRecall(e.group_id, gNotice, 60);
        const alive = [];
        let dead = 0;
        for (const c of cks) {
            const r = await probeCk(c.ck);
            if (r.state === 'ok') alive.push(c); else if (r.state === 'invalid') dead++;
            await sleep(400);
        }
        if (!alive.length) {
            return e.reply(`genshin 侧 ${cks.length} 条 CK 全部失效（${dead} 条确认失效），没有可签的。\n`
                + '可在 genshin 插件用它自带的清理指令删掉失效记录。', true);
        }
        const res = await bbsSignCks(e, alive);
        const botUin = Number(getBot()?.uin) || 0;
        const nodes = (res.msgs || []).map(m => ({ user_id: botUin, nickname: 'genshin CK', message: `${m.title}\n${m.tip}` }));
        const head = `genshin 侧 CK：共 ${cks.length} 条，有效 ${alive.length} 条，失效 ${dead} 条\n`
            + `本次签了 ${alive.length} 条`;
        if (nodes.length) {
            try { return e.reply(await makeForwardMsg(e, nodes, head), true); }
            catch (err) { logger.error(`[xhh][代签到] genshin 侧转发失败: ${err.message}`); }
        }
        return e.reply([head, ...(res.lines || []).slice(1)].join('\n'), true);
    }

    async proxySign(e) {
        // 「#代签到 本群」默认游戏+社区一起；写「#代游戏签到 本群」或「#代签到 游戏 本群」
        // 就只跑游戏那一半 —— 游戏失败时单独重试，不用把社区也重跑一遍。
        const raw = e.msg.replace(/^#*(小花火|xhh)*/, '').trim();
        const head = /^(?:代|帮|代替)(游戏|社区|论坛)?签到/.exec(raw);
        let scope = head && head[1] ? (head[1] === '游戏' ? 'game' : 'bbs') : 'both';
        let input = raw.replace(/^(?:代|帮|代替)(?:游戏|社区|论坛)?签到/, '').trim();
        // 范围词也可能写在签到后面：「#代签到 游戏 本群」。少了这一步，
        // 「游戏」会被当成 QQ 去解析，结果一个目标都匹配不上（实测如此）。
        const tail = /^(游戏|社区|论坛)\s+/.exec(input);
        if (tail) {
            scope = tail[1] === '游戏' ? 'game' : 'bbs';
            input = input.slice(tail[0].length).trim();
        }
        // 必须在上面算完再声明：开场白那句就要用到 scopeName，放早了取不到、放晚了 TDZ
        const scopeName = scope === 'game' ? '仅游戏' : scope === 'bbs' ? '仅社区' : '游戏+社区';
        // 「米游社」= 直接签 genshin 插件那批没有 QQ 归属的 CK
        if (/^(米游社|genshin|ck池|CK池|全部CK|全部ck)$/i.test(input)) {
            return this.signGenshinCks(e);
        }
        // @ 某人 优先于文字参数：@ 的意图最明确，写法也最短
        const ats = atQqs(e);
        const memberQqs = ats.length ? [] : await fetchGroupQqs(e);
        const { label, qqs } = ats.length
            ? { mode: 'at', label: `@${ats.join(' @')}`, qqs: ats }
            : resolveTargets(input, e.group_id, memberQqs);
        if (!qqs.length) {
            return e.reply(
                '没指定签谁。可写：\n'
                + '  #代签到 @某人　　　 直接艾特那个人\n'
                + '  #代签到 123456789　指定 QQ\n'
                + '  #代签到 本群　　　本群所有绑了 CK 的成员\n'
                + '  #代签到 全部　　　 全部绑定了 CK 的账号\n'
                + '  #代签到 米游社　　　签 genshin 插件那批 CK\n'
                + '只想跑一半时可写「#代游戏签到 本群」或「#代社区签到 本群」\n'
                + '先用「#签到名单」看看谁绑过。', true
            );
        }
        const withCk = qqs.filter(q => collectAccount(q));
        const skipped = qqs.length - withCk.length;
        // 这条只是「收到了、正在跑」的提示，结果出来后就多余了，留着刷屏。
        // 签到本身要一分多钟，60 秒足够用户看清；e.reply 的 recallMsg 选项实测
        // 多数协议层会静默忽略，所以走自己这套延时撤回。
        const notice = await e.reply(
            `开始代签到（${scopeName}）：${label}\n共 ${withCk.length} 个账号${skipped ? `，${skipped} 个没绑定 CK 已跳过` : ''}\n稍等…`,
            true
        );
        if (e.isGroup) scheduleGroupRecall(e.group_id, notice, 60);

        const { zd_MysSign, BbsAutoSign, render } = await import('#xhh');
        let game = null, bbs = null;
        if (scope !== 'bbs') {
            try { game = await zd_MysSign(withCk); } catch (err) { logger.error(`[xhh][代签到] 游戏签到异常: ${err.message}`); }
        }
        if (scope !== 'game') {
            try { bbs = await BbsAutoSign(withCk, e.isGroup ? e.group_id : 0); } catch (err) { logger.error(`[xhh][代签到] 社区签到异常: ${err.message}`); }
        }

        // 写进本群签到名单，之后定时自动签到会覆盖这些人
        let enrolled = [];
        if (e.isGroup && withCk.length) {
            try { enrolled = recordMembers(e.group_id, withCk); } catch (err) { logger.error(`[xhh][代签到] 写入名单失败: ${err.message}`); }
        }

        // 与定时签到一致出图：游戏结果用 end_list，社区结果用 sign（复用同一张模板）
        let imgs = 0;
        const shot = async (tpl, data) => {
            try {
                // ret:true 时图片由 runtime 直接发出，返回值是发送结果而不是图片本身
                await render(tpl, { ...data, qq: String(e.user_id) }, { e, ret: true });
                imgs++;
                return true;
            } catch (err) {
                logger.error(`[xhh][代签到] ${tpl} 出图失败: ${err.message}`);
                return false;
            }
        };
        if (game) await shot('sign/end_list', { qqs: withCk, ...game });
        if (bbs?.msgs?.length) {
            await shot('sign/sign', { msgs: bbs.msgs, name: e.sender?.card || e.sender?.nickname || String(e.user_id), xhhAvatar: true });
        }

        const lines = [`代签到完成（${scopeName}）：${label}`];
        if (game) {
            lines.push(`游戏签到：${game.num}/${game.z_num} 个账号成功`);
            if (game.sbai_qqs?.length) lines.push(`  失败：${game.sbai_qqs.join('、')}`);
        }
        // 出图成功就不必再把明细糊一屏，图里都有
        if (!imgs) {
            if (bbs?.lines?.length) lines.push(...bbs.lines.slice(1).filter(Boolean));
        } else if (bbs?.msgs?.length) {
            const bad = bbs.msgs.filter(m => !/签到成功|今日已签/.test(m.tip || ''));
            lines.push(`社区签到：${bbs.msgs.length} 个通行证，${bbs.msgs.length - bad.length} 个正常${bad.length ? `，${bad.length} 个需处理（见下图）` : ''}`);
        }
        if (enrolled.length) lines.push(...enrolled.map(x => '  · ' + x));
        return e.reply(lines.join('\n'), true, { recallMsg: imgs ? 0 : 300 });
    }
}
