import fs from 'fs';
import { segment } from 'oicq';
import NoteUser from '../../genshin/model/mys/NoteUser.js';
import { TL } from './TL.js';
import { yaml, pluginPriority } from '#xhh';

const cfgFile = './plugins/xhh/config/bh3_remind.yaml';
const stokenDir = './plugins/xhh/data/Stoken';

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
  try {
    if (group.getMemberMap) members = await group.getMemberMap();
    else if (group.getMemberList) members = await group.getMemberList();
  } catch (_) {}
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
  return [...new Set(ids)].filter(id => id !== botId);
}

function makeEvent(qq) {
  return {
    user_id: String(qq),
    msg: '',
    raw_message: '',
    message: [],
    sender: {
      card: '',
      nickname: String(qq),
    },
    user: {
      getUid: () => '',
    },
  };
}

function getThreshold(cfg, game) {
  const key = `stamina_push_${game}_threshold`;
  const fallback = GAME_META[game].defaultThreshold;
  const value = Number(cfg[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

async function sendGroup(groupId, message) {
  const bot = getBot();
  const gid = Number(groupId) || groupId;
  if (bot?.sendGroupMsg) return bot.sendGroupMsg(gid, message);
  if (bot?.pickGroup) return bot.pickGroup(gid).sendMsg(message);
  throw new Error('Bot对象不可用');
}

export class stamina_remind extends plugin {
  constructor() {
    super({
      name: '[小花火]体力自动推送',
      dsc: '四游戏体力达到阈值后自动推送',
      event: 'message',
      priority: pluginPriority('stamina_remind', 100),
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
    if (!members.length || !fs.existsSync(stokenDir)) return members;
    // 没有 xhh Stoken 的成员不可能被当前体力组件查询，先过滤掉，避免无效请求。
    const bound = new Set(
      fs.readdirSync(stokenDir)
        .filter(name => name.endsWith('.yaml'))
        .map(name => name.slice(0, -5)),
    );
    return members.filter(qq => bound.has(qq));
  }

  async getUserRecords(qq, cfg) {
    const e = makeEvent(qq);
    const records = [];
    for (const game of Object.keys(GAME_META)) {
      const threshold = getThreshold(cfg, game);
      let uid = '';
      try {
        const user = await NoteUser.create(String(qq));
        uid = String(user.getUid(game === 'bh3' ? 'bh3' : game) || '');
      } catch (err) {
        logger.warn(`[stamina_remind] 获取${GAME_META[game].name}当前UID失败(${qq})：${err.message}`);
        continue;
      }
      if (!uid) continue;

      try {
        const data = game === 'bh3'
          ? await this.tl.bh3Note(e, true, uid)
          : await this.tl.note(e, game, true, uid);
        if (!data || data === '没有' || data === '过期' || data.error) continue;
        const current = GAME_META[game].current(data);
        const stateKey = `xhh:stamina_remind:sent:${qq}:${game}:${uid}`;
        if (current >= threshold) {
          if (!(await redis.get(stateKey))) {
            records.push({ game, uid, data, threshold, stateKey });
          }
        } else {
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
    if (Math.floor(Date.now() / 60000) % interval !== 0) return;

    this.running = true;
    try {
      for (const groupId of groups) {
        const users = await this.getUsersInGroup(groupId);
        for (const qq of users) {
          const records = await this.getUserRecords(qq, cfg);
          if (!records.length) continue;

          const cards = records.map(record => this.tl.toMultiCard(record.game, record.data));
          const image = await this.tl.renderTlImage(e, {
            multi_list: cards,
            multi_game_name: '体力达到推送阈值',
          });
          const message = cfg.stamina_push_at_user
            ? [segment.at(qq), '\n', image]
            : image;
          try {
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
}

export default stamina_remind;
