import fetch from 'node-fetch';
import moment from 'moment';
import { segment } from 'oicq';
import { yaml, pluginPriority } from '#xhh';

const _path = './plugins/xhh/config/';
const cfgFile = _path + 'activity_remind.yaml';
const defaultCfg = {
  enable: false,
  hours_before: 24,
  push_image: true,
  at_mode: 'none',
  at_users: [],
  ban_words: '专题展示页|主题曲|前瞻特别节目预告|角色PV|签到福利|商城|周边|手办|有奖活动|已开奖|问卷|征集|作品展示|同人|大别野|米游币',
  groups: { gs: [], sr: [], zzz: [], bh3: [] },
};

const gameMap = {
  gs: { name: '原神', short: '原神' },
  sr: { name: '星穹铁道', short: '星铁' },
  zzz: { name: '绝区零', short: '绝区零' },
  bh3: { name: '崩坏3', short: '崩三' },
};

const api = {
  gs: 'https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=60&uid=100000000',
  sr: 'https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&auth_appid=announcement&authkey_ver=1&bundle_id=hkrpg_cn&channel_id=1&level=70&platform=pc&region=prod_gf_cn&sdk_presentation_style=fullscreen&sdk_screen_transparent=true&sign_type=2&uid=100000000',
  zzz: 'https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnList?game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=70&platform=pc&region=prod_gf_cn&uid=12345678',
};

const BH3_NEWS_API = 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?gids=1&page_size=80&type=1';
const BH3_POST_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull?gids=1&read=1&post_id=';
const bh3IgnoreReg = /(封禁|外挂|账号交易|公平运营|问题修复|已知问题|维护通知|更新说明|防沉迷|客服|开奖|名单|问卷|壁纸)/;

function getCfg() {
  const cfg = yaml.get(cfgFile) || {};
  const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
  return { ...defaultCfg, ...cfg, groups };
}

function saveCfg(cfg) {
  yaml.set(cfgFile, 'enable', !!cfg.enable);
  yaml.set(cfgFile, 'hours_before', Number(cfg.hours_before || 24));
  yaml.set(cfgFile, 'push_image', cfg.push_image !== false);
  yaml.set(cfgFile, 'at_mode', cfg.at_mode || 'none');
  yaml.set(cfgFile, 'at_users', normalizeList(cfg.at_users));
  yaml.set(cfgFile, 'ban_words', String(cfg.ban_words || ''));
  yaml.set(cfgFile, 'groups', cfg.groups || defaultCfg.groups);
}

function normalizeList(value = []) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[,，\s]+/).map(v => v.trim()).filter(Boolean))];
}

function parseGame(msg = '') {
  if (/原神/.test(msg)) return 'gs';
  if (/星铁|星穹铁道|崩铁/.test(msg)) return 'sr';
  if (/绝区零|ZZZ/i.test(msg)) return 'zzz';
  if (/崩三|崩坏3|崩坏三|BH3/i.test(msg)) return 'bh3';
  return '';
}

function isEnableMsg(msg = '') {
  return /开启|on/i.test(msg);
}

function cleanText(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function htmlToText(html = '') {
  return cleanText(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseEndTime(value) {
  if (!value) return null;
  const m = moment(String(value).replace(/\//g, '-'), ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', moment.ISO_8601], true);
  return m.isValid() ? m : null;
}

function remainText(now, end) {
  const diff = Math.max(0, end.valueOf() - now.valueOf());
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function inWindow(end, now, hoursBefore) {
  const diff = end.valueOf() - now.valueOf();
  return diff >= 0 && diff <= Number(hoursBefore || 24) * 3600000;
}

function banReg(cfg) {
  const text = String(cfg.ban_words || '').trim();
  if (!text) return null;
  try { return new RegExp(text); } catch (_) { return null; }
}

async function fetchJson(url, opt = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
    signal: AbortSignal.timeout(opt.timeout || 12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function flattenAnnList(json, game) {
  const items = [];
  if (Array.isArray(json?.data?.list)) {
    for (const group of json.data.list) if (Array.isArray(group?.list)) items.push(...group.list);
  }
  if (Array.isArray(json?.data?.pic_list)) {
    for (const pic of json.data.pic_list) {
      if (Array.isArray(pic?.list)) items.push(...pic.list);
      if (Array.isArray(pic?.type_list)) {
        for (const type of pic.type_list) if (Array.isArray(type?.list)) items.push(...type.list);
      }
    }
  }
  return items.map(item => {
    const title = cleanText(item.title || item.subtitle || '');
    const subtitle = cleanText(item.subtitle || item.title || '');
    return {
      game,
      id: item.ann_id || item.id || title,
      title,
      subtitle,
      banner: item.banner || item.img || item.cover || '',
      end: parseEndTime(item.end_time),
      endText: item.end_time || '',
      tag: item.tag_label || item.type_label || '',
    };
  }).filter(i => i.title && i.end);
}

function filterOfficialActivities(list, game) {
  return list.filter(item => {
    const tag = item.tag || '';
    const title = item.title || '';
    if (game === 'gs') return /活动/.test(tag) && !/传说任务|魔神任务|游戏公告/.test(title);
    if (game === 'sr') return !!title;
    if (game === 'zzz') return /活动公告|丽都资讯|活动/.test(tag) || /活动|调频|限时|补给|签到|邀约/.test(title);
    return true;
  });
}

async function getOfficialActivities(game) {
  const json = await fetchJson(api[game]);
  if (json?.retcode !== 0 && json?.retcode !== undefined) throw new Error(json?.message || json?.retcode);
  const list = flattenAnnList(json, game);
  return filterOfficialActivities(list, game);
}

async function getBh3Activities() {
  const listJson = await fetchJson(BH3_NEWS_API);
  const posts = listJson?.data?.list || [];
  const ret = [];
  // 崩三公告量较大，活动到期提醒只扫前 28 条容易被资讯/攻略挤掉，导致没有推送。
  for (const item of posts.slice(0, 60)) {
    const post = item?.post || item;
    const title = cleanText(post.subject || post.title || '');
    if (!title || bh3IgnoreReg.test(title)) continue;
    let detail = null;
    try {
      const json = await fetchJson(BH3_POST_API + post.post_id, { timeout: 10000 });
      detail = json?.data?.post?.post || null;
    } catch (_) {}
    const content = htmlToText(detail?.content || post.content || '');
    const time = extractBh3Time(content, post.created_at);
    if (!time?.end) continue;
    ret.push({
      game: 'bh3',
      id: post.post_id || title,
      title: title.replace(/^【[^】]+】/, ''),
      subtitle: title.replace(/^【[^】]+】/, ''),
      banner: item?.image_list?.[0]?.url || post.cover || post.images?.[0] || '',
      end: time.end,
      endText: time.end.format('YYYY-MM-DD HH:mm'),
      tag: '活动',
    });
  }
  return ret;
}

function extractBh3Time(text = '', createdAt = 0) {
  text = String(text || '').replace(/\s+/g, ' ');
  const year = moment.unix(Number(createdAt) || moment().unix()).year();
  const versionAfter = text.match(/(\d+\.\d+)版本更新后\s*[~～至\-—]+\s*(?:(20\d{2})[年\/-])?([0-9]{1,2})月([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/);
  if (versionAfter) {
    const s = getBh3VersionStart(versionAfter[1], createdAt);
    const e = moment(`${versionAfter[2] || year}-${versionAfter[3]}-${versionAfter[4]} ${versionAfter[5]}`, 'YYYY-M-D H:mm');
    if (s.isValid() && e.isValid()) {
      if (e.isBefore(s)) e.add(1, 'year');
      return { start: s, end: e };
    }
  }
  const regs = [
    /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{4})[年\/-]([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})(?:[:0-9]*)?\s*[~～至\-—]+\s*(?:([0-9]{4})[年\/-])?([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/,
    /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
    /([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
  ];
  for (const reg of regs) {
    const m = text.match(reg);
    if (!m) continue;
    let s, e;
    if (m.length >= 9 && m[1]?.length === 4) {
      s = moment(`${m[1]}-${m[2]}-${m[3]} ${m[4]}`, 'YYYY-M-D H:mm');
      e = moment(`${m[5] || m[1]}-${m[6]}-${m[7]} ${m[8]}`, 'YYYY-M-D H:mm');
    } else {
      s = moment(`${year}-${m[1]}-${m[2]} ${m[3]}`, 'YYYY-M-D H:mm');
      e = moment(`${year}-${m[4]}-${m[5]} ${m[6]}`, 'YYYY-M-D H:mm');
    }
    if (!s.isValid() || !e.isValid()) continue;
    if (e.isBefore(s)) e.add(1, 'year');
    return { start: s, end: e };
  }
  return null;
}

function getBh3VersionStart(version = '', createdAt = 0) {
  const map = {
    '9.0': '2026-07-23 11:00',
  };
  if (map[version]) return moment(map[version], 'YYYY-MM-DD HH:mm');
  const base = moment.unix(Number(createdAt) || moment().unix());
  return base.hour(11).minute(0).second(0).millisecond(0);
}

async function getActivities(game) {
  if (game === 'bh3') return await getBh3Activities();
  return await getOfficialActivities(game);
}

function buildMsg(cfg, item, now) {
  const game = gameMap[item.game]?.short || item.game;
  const msg = [];
  const atMode = String(cfg.at_mode || 'none').toLowerCase();
  const atUsers = normalizeList(cfg.at_users);
  if (atMode === 'all') msg.push(segment.at('all'), '\n');
  else if (atMode === 'users') {
    for (const qq of atUsers) msg.push(segment.at(qq));
    if (atUsers.length) msg.push('\n');
  }
  msg.push(`【${game}活动即将结束通知】\n活动：${item.subtitle || item.title}\n剩余时间：${remainText(now, item.end)}\n结束时间：${item.end.format('YYYY-MM-DD HH:mm')}`);
  if (cfg.push_image !== false && item.banner) msg.push('\n', segment.image(item.banner));
  return msg;
}

async function sendGroupMsg(groupId, msg, e = null) {
  const gid = Number(groupId) || groupId;
  const botObj = globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null) || globalThis.bot;
  if (e?.isGroup && String(e.group_id) === String(groupId) && e.group?.sendMsg) return e.group.sendMsg(msg);
  if (botObj?.sendGroupMsg) return botObj.sendGroupMsg(gid, msg);
  if (botObj?.pickGroup) return botObj.pickGroup(gid).sendMsg(msg);
  if (e?.bot?.pickGroup) return e.bot.pickGroup(gid).sendMsg(msg);
  if (e?.pickGroup) return e.pickGroup(gid).sendMsg(msg);
  throw new Error('Bot对象不可用，无法发送群消息');
}

export class activity_remind extends plugin {
  constructor() {
    super({
      name: '[小花火]活动到期提醒',
      dsc: '原神/星铁/绝区零/崩坏3活动到期推送',
      event: 'message',
      priority: pluginPriority('activity_remind', -1000002),
      rule: [
        { reg: '^#*(原神|星铁|星穹铁道|崩铁|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(开启|关闭)(到期活动|活动到期)(提醒|预警)?(推送)?$', fnc: 'toggleGame', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(开启|关闭)全部(游戏)?(到期活动|活动到期)(提醒|预警)?(推送)?$', fnc: 'toggleAll', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(小花火)?(活动到期|到期活动)(提醒|预警)?状态$', fnc: 'status', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(小花火)?(活动到期|到期活动)(提醒|预警)?测试$', fnc: 'testPush', priority: pluginPriority('activity_remind', -1000002) },
      ],
    });
    this.task = {
      cron: '0 0 * * * *',
      name: '[小花火]活动到期提醒检查',
      fnc: () => this.checkAndPush(),
      log: false,
    };
  }

  async toggleGame(e) {
    if (!e.isMaster) return e.reply('仅主人可操作');
    if (!e.isGroup) return e.reply('请在需要推送的群聊里操作');
    const game = parseGame(e.msg);
    if (!game) return false;
    const cfg = getCfg();
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    const list = normalizeList(groups[game]);
    const gid = String(e.group_id);
    const enable = isEnableMsg(e.msg);
    groups[game] = enable ? [...new Set([...list, gid])] : list.filter(v => v !== gid);
    cfg.groups = groups;
    cfg.enable = Object.values(groups).some(arr => normalizeList(arr).length);
    saveCfg(cfg);
    return e.reply(`${gameMap[game].short}活动到期提醒已${enable ? '开启' : '关闭'}${enable ? '\n如有即将到期的活动将自动推送至此' : ''}`);
  }

  async toggleAll(e) {
    if (!e.isMaster) return e.reply('仅主人可操作');
    if (!e.isGroup) return e.reply('请在需要推送的群聊里操作');
    const cfg = getCfg();
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    const gid = String(e.group_id);
    const enable = isEnableMsg(e.msg);
    for (const game of Object.keys(gameMap)) {
      const list = normalizeList(groups[game]);
      groups[game] = enable ? [...new Set([...list, gid])] : list.filter(v => v !== gid);
    }
    cfg.groups = groups;
    cfg.enable = Object.values(groups).some(arr => normalizeList(arr).length);
    saveCfg(cfg);
    return e.reply(`全部游戏（原神、星铁、绝区零、崩三）活动到期提醒已${enable ? '开启' : '关闭'}${enable ? '\n如有即将到期的活动将自动推送至此' : ''}`);
  }

  async status(e) {
    const cfg = getCfg();
    const lines = Object.entries(gameMap).map(([key, info]) => `${info.short}：${normalizeList(cfg.groups?.[key]).join('、') || '未开启'}`);
    return e.reply(`活动到期提醒：${cfg.enable ? '已开启' : '未开启'}\n提前时间：${cfg.hours_before || 24}小时\n${lines.join('\n')}`);
  }

  async testPush(e) {
    if (!e.isMaster) return e.reply('仅主人可操作');
    await e.reply('开始检查四游戏活动到期提醒，请稍候...');
    return this.checkAndPush(e, true);
  }

  async checkAndPush(e = null, manual = false) {
    const cfg = getCfg();
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    if (!cfg.enable && !manual) return;
    const now = moment();
    const reg = banReg(cfg);
    const resultLines = [];

    for (const game of Object.keys(gameMap)) {
      const targetGroups = normalizeList(groups[game]);
      if (!targetGroups.length && !manual) continue;
      let list = [];
      try {
        list = await getActivities(game);
      } catch (err) {
        logger.warn(`[activity_remind] 获取${gameMap[game].short}活动失败：${err?.message || err}`);
        if (manual) resultLines.push(`${gameMap[game].short}：获取失败 ${err?.message || err}`);
        continue;
      }
      list = list
        .filter(item => item.end && inWindow(item.end, now, cfg.hours_before || 24))
        .filter(item => !reg || !reg.test(item.title || '') && !reg.test(item.subtitle || ''));
      const seen = new Set();
      list = list.filter(item => {
        const k = `${item.title}|${item.end.format('YYYY-MM-DD HH:mm')}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (manual) resultLines.push(`${gameMap[game].short}：${list.length ? list.map(i => `${i.title}（剩余${remainText(now, i.end)}）`).join('、') : '暂无即将到期活动'}`);
      if (!targetGroups.length) continue;

      for (const groupId of targetGroups) {
        for (const item of list) {
          const dedup = `xhh:activity_remind:sent:${game}:${groupId}:${item.id}:${item.end.format('YYYYMMDDHHmm')}`;
          if (!manual && await redis.get(dedup)) continue;
          try {
            await sendGroupMsg(groupId, buildMsg(cfg, item, now), e);
            await redis.set(dedup, '1', { EX: 3 * 24 * 3600 });
            logger.mark(`[activity_remind] 已推送 ${gameMap[game].short} ${item.title} -> ${groupId}`);
          } catch (err) {
            logger.warn(`[activity_remind] 推送到群 ${groupId} 失败：${err?.message || err}`);
          }
        }
      }
    }
    if (manual && e) return e.reply(`活动到期检查完成：\n${resultLines.join('\n') || '无结果'}`);
  }
}
