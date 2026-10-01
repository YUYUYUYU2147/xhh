import fs from 'fs';
import { segment } from 'oicq';
import Runtime from '../../../lib/plugins/runtime.js';
import NoteUser from '../../genshin/model/mys/NoteUser.js';
import { TL } from './TL.js';
import { yaml, pluginPriority } from '#xhh';

const cfgFile = './plugins/xhh/config/bh3_remind.yaml';
const stokenDir = './plugins/xhh/data/Stoken';
const STAMINA_GAMES = ['gs', 'sr', 'zzz', 'bh3'];
const GAME_ALIASES = {
  原神: 'gs',
  星铁: 'sr',
  星穹铁道: 'sr',
  绝区零: 'zzz',
  崩三: 'bh3',
  崩坏3: 'bh3',
  崩坏三: 'bh3',
};

const GAME_META = {
  gs: { name: '原神', current: data => Number(data?.current_resin || 0), label: '原粹树脂', defaultThreshold: 200 },
  sr: { name: '星穹铁道', current: data => Number(data?.current_stamina || 0), label: '开拓力', defaultThreshold: 240 },
  zzz: {
    name: '绝区零',
    current: data => Number(data?.energy?.progress?.current ?? data?.battery_charge ?? 0),
    label: '电量',
    defaultThreshold: 240,
  },
  bh3: { name: '崩坏3', current: data => Number(data?.current_stamina || 0), label: '体力', defaultThreshold: 240 },
};

function getConfig() {
  return yaml.get(cfgFile) || {};
}

function normalizeList(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s]+/);
  return [...new Set(list.map(v => String(v).trim()).filter(Boolean))];
}

function getBoundUserIds() {
  if (!fs.existsSync(stokenDir)) return [];
  try {
    return [...new Set(
      fs.readdirSync(stokenDir)
        .filter(name => /^\d+\.yaml$/.test(name))
        .map(name => name.slice(0, -5)),
    )];
  } catch (err) {
    logger.warn(`[stamina_remind] 读取绑定用户失败：${err.message}`);
    return [];
  }
}

function getBot() {
  return globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null) || globalThis.bot;
}

async function getGroupMemberIds(groupId) {
  const bot = getBot();
  if (!bot) return [];
  let group;
  try {
    group = bot.pickGroup?.(Number(groupId), true) || bot.pickGroup?.(Number(groupId));
  } catch (_) {
    group = null;
  }
  if (!group) return [];

  let members = null;
  let lastError = null;
  try {
    if (group.getMemberArray) members = await group.getMemberArray();
    if (!members?.length && group.getMemberMap) members = await group.getMemberMap(true);
    if (!members?.length && group.getMemberList) members = await group.getMemberList();
  } catch (err) {
    lastError = err;
  }

  // 部分 TRSS/OneBot 连接器的群对象缓存为空，但 sendApi 可以实时拉取成员。
  if (!members?.length && bot.sendApi) {
    try {
      const result = await bot.sendApi('get_group_member_list', {
        group_id: Number(groupId),
        no_cache: true,
      });
      members = Array.isArray(result) ? result : result?.data;
    } catch (err) {
      lastError = err;
    }
  }
  members ||= group.memberMap || group.members || group.member_list || [];

  const ids = [];
  const add = item => {
    const id = typeof item === 'object' ? (item.user_id ?? item.uid ?? item.id) : item;
    if (/^\d+$/.test(String(id || ''))) ids.push(String(id));
  };
  if (members instanceof Map) {
    for (const [key, value] of members) add(value?.user_id ? value : key);
  } else if (Array.isArray(members)) {
    members.forEach(add);
  } else if (members && typeof members === 'object') {
    Object.entries(members).forEach(([key, value]) => add(value?.user_id ? value : key));
  }

  const botId = String(bot.uin || bot.self_id || '');
  const result = [...new Set(ids)].filter(id => id !== botId);
  if (!result.length) {
    const detail = lastError ? `：${lastError.message}` : '';
    logger.warn(`[stamina_remind] 群${groupId}成员列表为空${detail}`);
  } else {
    logger.debug?.(`[stamina_remind] 群${groupId}读取到${result.length}名成员`);
  }
  return result;
}

function makeEvent(qq, nickname = '') {
  const displayName = String(nickname || qq);
  const event = {
    user_id: String(qq),
    msg: '',
    raw_message: '',
    message: [],
    sender: {
      card: displayName,
      nickname: displayName,
    },
    user: {
      getUid: () => '',
    },
  };
  event.runtime = new Runtime(event);
  return event;
}

async function getGroupMemberInfo(groupId, qq) {
  const bot = getBot();
  let group;
  try {
    group = bot?.pickGroup?.(Number(groupId), true) || bot?.pickGroup?.(Number(groupId));
  } catch (_) {
    group = null;
  }
  if (!group) return null;

  let member = null;
  try {
    // 群名片可能已经变更，优先实时读取，避免直接使用 pickMember 的旧缓存。
    if (bot?.sendApi) {
      const result = await bot.sendApi('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(qq),
        no_cache: true,
      });
      member = result?.data || result || null;
    }
  } catch (_) {}

  if (!member?.card && !member?.nickname && !member?.name) {
    try {
      if (bot.pickMember) member = bot.pickMember(Number(groupId), Number(qq));
      if (group.pickMember) member ||= group.pickMember(Number(qq));
      if ((!member?.card && !member?.nickname) && group.getMember) {
        member = await group.getMember(Number(qq));
      }
    } catch (_) {}
  }

  if (!member?.card && !member?.nickname && !member?.name) {
    let members = group.memberMap || group.members || group.member_list;
    try {
      if (!members?.size && group.getMemberMap) members = await group.getMemberMap(true);
      if (!members?.length && group.getMemberArray) members = await group.getMemberArray();
    } catch (_) {}
    if (members instanceof Map) member = members.get(Number(qq)) || members.get(String(qq));
    else if (Array.isArray(members)) {
      member = members.find(item => String(item?.user_id ?? item?.uid ?? '') === String(qq));
    } else if (members && typeof members === 'object') {
      member = members[qq] || members[String(qq)];
    }
  }
  return member || null;
}

async function getGroupDisplayName(groupId, qq) {
  const member = await getGroupMemberInfo(groupId, qq);
  return String(
    member?.card ||
    member?.nickname ||
    member?.name ||
    member?.info?.card ||
    member?.info?.nickname ||
    member?.info?.name ||
    qq,
  );
}

function getThreshold(cfg, game) {
  const key = `stamina_push_${game}_threshold`;
  const fallback = GAME_META[game].defaultThreshold;
  const value = Number(cfg[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function staminaSwitchKey(groupId, qq, game) {
  return `xhh:stamina_remind:enabled:${groupId}:${qq}:${game}`;
}

async function getEnabledGames(groupId, qq) {
  const enabled = [];
  for (const game of STAMINA_GAMES) {
    if (await redis.get(staminaSwitchKey(groupId, qq, game))) enabled.push(game);
  }
  return enabled;
}

function formatRecord(game, uid, data, threshold) {
  const meta = GAME_META[game];
  const current = meta.current(data);
  const max = Number(
    data?.max_resin ??
    data?.max_stamina ??
    data?.energy?.progress?.max ??
    data?.max_battery_charge ??
    0,
  );
  return `${meta.name} UID${uid}：${meta.label} ${current}${max ? `/${max}` : ''}（阈值${threshold}）`;
}

function toImageSegment(image) {
  if (!image) return image;
  if (Buffer.isBuffer(image)) return segment.image(image);
  if (typeof image === 'object' && image.type === 'image') return image;
  return segment.image(String(image));
}

async function sendGroup(groupId, message, event = null) {
  const eventGroup = event?.group;
  if (eventGroup && String(event.group_id || eventGroup.group_id || '') === String(groupId)) {
    return eventGroup.sendMsg(message);
  }
  const eventBot = event?.bot;
  if (eventBot?.pickGroup) {
    return eventBot.pickGroup(Number(groupId) || groupId).sendMsg(message);
  }
  const bot = getBot();
  const gid = Number(groupId) || groupId;
  if (bot?.pickGroup) return bot.pickGroup(gid).sendMsg(message);
  if (bot?.sendGroupMsg) {
    const botId = String(bot.uin || bot.self_id || '');
    if (botId) return bot.sendGroupMsg(botId, gid, message);
    throw new Error('Bot管理器缺少bot_id，无法发送群消息');
  }
  throw new Error('Bot对象不可用');
}

export class stamina_remind extends plugin {
  constructor() {
    super({
      name: '[小花火]体力自动推送',
      dsc: '四游戏体力达到阈值后自动推送',
      event: 'message',
      priority: pluginPriority('stamina_remind', 100),
      rule: [
        {
          reg: '^#*(小花火|xhh)(开启|关闭)(原神|星铁|星穹铁道|绝区零|崩三|崩坏3|崩坏三)?体力推送$',
          fnc: 'toggleStaminaPush',
        },
        {
          reg: '^#*(小花火|xhh)体力推送测试$',
          fnc: 'pushTest',
        },
      ],
    });
    this.running = false;
    this.tl = new TL();
    this.task = {
      cron: '0 * * * * *',
      name: '[小花火]体力自动推送检查',
      fnc: () => this.checkAndPush(),
      log: false,
    };
  }

  async getUsersInGroup(groupId) {
    const members = await getGroupMemberIds(groupId);
    const bound = getBoundUserIds();
    if (!bound.length) {
      logger.warn(`[stamina_remind] 群${groupId}没有可检查的 xhh 绑定用户`);
      return [];
    }

    if (!members.length) {
      // 群成员接口不是所有 OneBot 连接器都支持；读取失败时用绑定数据本身作为候选用户来源。
      const enabledUsers = [];
      for (const qq of bound) {
        if ((await getEnabledGames(groupId, qq)).length) enabledUsers.push(qq);
      }
      logger.warn(`[stamina_remind] 群${groupId}未读取到群成员，回退检查${enabledUsers.length}名已开启用户`);
      return enabledUsers;
    }

    const boundSet = new Set(bound);
    const users = members.filter(qq => boundSet.has(qq));
    const enabledUsers = [];
    for (const qq of users) {
      if ((await getEnabledGames(groupId, qq)).length) enabledUsers.push(qq);
    }
    logger.mark(`[stamina_remind] 群${groupId}候选用户：群成员${members.length}人，已绑定${users.length}人，已开启${enabledUsers.length}人`);
    return enabledUsers;
  }

  async getUserRecords(qq, groupId, cfg, force = false) {
    const e = makeEvent(qq);
    const records = [];
    const enabledGames = await getEnabledGames(groupId, qq);
    for (const game of enabledGames) {
      const threshold = getThreshold(cfg, game);
      let uid = '';
      let user;
      try {
        user = await NoteUser.create(String(qq));
        uid = String(user.getUid(game === 'bh3' ? 'bh3' : game) || '');
      } catch (err) {
        logger.warn(`[stamina_remind] 获取${GAME_META[game].name}当前UID失败(${qq})：${err.message}`);
        continue;
      }
      if (!uid) {
        logger.debug?.(`[stamina_remind] 用户${qq}没有${GAME_META[game].name}当前UID`);
        continue;
      }

      try {
        let data;
        if (game === 'bh3') {
          data = await this.tl.bh3Note(e, true, uid);
        } else {
          // 与手动体力查询保持同一路径：临时切换当前 UID，使用普通 Widget 接口。
          // 不传 uidOverride，避免部分账号的角色接口误返回“过期”。
          const oldUid = String(user.getUid(game) || '');
          user.setMainUid(uid, game, false);
          try {
            e.user = user;
            data = await this.tl.note(e, game, true);
          } finally {
            user.setMainUid(oldUid, game, false);
          }
        }
        if (!data || data === '没有' || data === '过期' || data.error) {
          logger.warn(`[stamina_remind] ${GAME_META[game].name} 用户${qq} UID${uid}未获取到体力数据：${data?.error || data || '接口无数据'}`);
          continue;
        }
        const current = GAME_META[game].current(data);
        logger.debug?.(`[stamina_remind] ${GAME_META[game].name} 用户${qq} UID${uid}当前${GAME_META[game].label}：${current}，阈值：${threshold}`);
        const stateKey = `xhh:stamina_remind:sent:${qq}:${game}:${uid}`;
        if (current >= threshold) {
          const sent = !force && await redis.get(stateKey);
          if (sent) {
            logger.mark(`[stamina_remind] 跳过${GAME_META[game].name} 用户${qq} UID${uid}：${current} >= ${threshold}，已推送锁定`);
          } else {
            logger.mark(`[stamina_remind] 命中${GAME_META[game].name} 用户${qq} UID${uid}：${current} >= ${threshold}`);
            records.push({ game, uid, data, threshold, stateKey });
          }
        } else {
          logger.debug?.(`[stamina_remind] 未达到${GAME_META[game].name} 用户${qq} UID${uid}：${current} < ${threshold}`);
          // 用户消耗体力后解除发送锁，下一次重新达到阈值还能再次提醒。
          await redis.del(stateKey);
        }
      } catch (err) {
        logger.warn(`[stamina_remind] 获取${GAME_META[game].name}体力失败(${qq}/${uid})：${err.message}`);
      }
    }
    return records;
  }

  async checkAndPush() {
    if (this.running) return;
    const cfg = getConfig();
    if (cfg.stamina_push_enable !== true) return;
    const groups = normalizeList(cfg.all_note_groups);
    if (!groups.length) return;

    const interval = Math.max(1, Math.min(60, Number(cfg.stamina_push_interval || 5)));
    const minute = Math.floor(Date.now() / 60000);
    const dedupKey = `xhh:stamina_remind:check:${minute}`;
    if (minute % interval !== 0 || await redis.get(dedupKey)) return;
    await redis.set(dedupKey, '1', { EX: Math.max(120, interval * 60) });
    logger.mark(`[stamina_remind] 开始检查，群：${groups.join(',')}，间隔：${interval}分钟`);

    this.running = true;
    try {
      for (const groupId of groups) {
        const users = await this.getUsersInGroup(groupId);
        logger.mark(`[stamina_remind] 群${groupId}开始检查${users.length}名候选用户`);
        for (const qq of users) {
          const records = await this.getUserRecords(qq, groupId, cfg);
          if (!records.length) continue;

          try {
            const event = makeEvent(qq, await getGroupDisplayName(groupId, qq));
            const cards = records.map(record => this.tl.toMultiCard(record.game, record.data));
            const image = await this.tl.renderTlImage(event, {
              multi_list: cards,
              multi_game_name: '体力达到推送阈值',
            });
            if (!image) continue;
            const imageSegment = toImageSegment(image);
            const message = cfg.stamina_push_at_user
              ? [segment.at(qq), '\n', imageSegment]
              : imageSegment;
            logger.mark(`[stamina_remind] 准备发送群${groupId} 用户${qq}，消息类型：${Array.isArray(message) ? '合并消息' : typeof message}`);
            await sendGroup(groupId, message);
            for (const record of records) {
              await redis.set(record.stateKey, '1', { EX: 7 * 24 * 3600 });
            }
            logger.mark(`[stamina_remind] 已推送群${groupId} 用户${qq}`);
          } catch (err) {
            logger.warn(`[stamina_remind] 推送群${groupId}失败：${err.message}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  async pushTest(e) {
    if (!e.isMaster) return e.reply('仅主人可执行体力推送测试');
    const cfg = getConfig();
    if (cfg.stamina_push_enable !== true) {
      return e.reply('体力自动推送未开启，请先在锅巴开启');
    }
    const groups = normalizeList(cfg.all_note_groups);
    if (!groups.length) return e.reply('未配置体力推送群，请先在锅巴填写“四游戏体力推送群”');

    const result = [];
    for (const groupId of groups) {
      const users = await this.getUsersInGroup(groupId);
      let hitCount = 0;
      for (const qq of users) {
        const records = await this.getUserRecords(qq, groupId, cfg, true);
        if (!records.length) continue;
        hitCount += records.length;
        try {
          const image = await this.tl.renderTlImage(makeEvent(qq, await getGroupDisplayName(groupId, qq)), {
            multi_list: records.map(record => this.tl.toMultiCard(record.game, record.data)),
            multi_game_name: '体力达到推送阈值',
          });
          const imageSegment = toImageSegment(image);
          const message = cfg.stamina_push_at_user
            ? [segment.at(qq), '\n', imageSegment]
            : imageSegment;
          logger.mark(`[stamina_remind] 测试发送群${groupId} 用户${qq}`);
          await sendGroup(groupId, message, e);
        } catch (err) {
          result.push(`${groupId}: 发送失败 ${err.message}`);
        }
      }
      result.push(`${groupId}: 检查${users.length}人，命中${hitCount}条`);
    }
    return e.reply(`体力推送测试完成\n${result.join('\n')}`);
  }

  async toggleStaminaPush(e) {
    if (!e.isGroup) return e.reply('请在需要接收体力推送的群聊里操作');
    const match = String(e.msg || '').match(/^#*(?:小花火|xhh)(开启|关闭)(原神|星铁|星穹铁道|绝区零|崩三|崩坏3|崩坏三)?体力推送$/);
    if (!match) return false;

    const [, action, gameName] = match;
    const groupId = String(e.group_id);
    const qq = String(e.user_id);
    const games = gameName ? [GAME_ALIASES[gameName]] : STAMINA_GAMES;
    const enabled = action === '开启';

    for (const game of games) {
      const key = staminaSwitchKey(groupId, qq, game);
      if (enabled) await redis.set(key, '1');
      else await redis.del(key);
    }

    const names = games.map(game => GAME_META[game].name).join('、');
    return e.reply(
      enabled
        ? `已开启本群${names}体力推送\n只推送当前切换的UID，达到阈值后提醒。`
        : `已关闭本群${names}体力推送`,
      false,
      { at: true },
    );
  }
}

export default stamina_remind;
