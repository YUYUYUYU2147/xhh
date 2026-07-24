import fs from 'fs';
import fetch from 'node-fetch';
import moment from 'moment';
import { render, pluginPriority } from '#xhh';

const NEWS_API = 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?gids=1&page_size=80&type=1';
const POST_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull?gids=1&read=1&post_id=';
const CACHE_KEY = 'xhh:bh3:calendar:v3';
// 崩三公告/活动更新较频繁；原先缓存 10 分钟会让日历看起来不像实时更新。
// 保留 60 秒短缓存，避免同一分钟内重复请求米游社过多。
const CACHE_TTL = 60;

const ignoreReg = /(封禁|外挂|账号交易|公平运营|问题修复|已知问题|维护通知|更新说明|防沉迷|客服|开奖|名单|问卷|壁纸)/;
const timeTitleReg = /(开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)/;

export class bh3_calendar extends plugin {
  constructor() {
    super({
      name: '[小花火]崩三日历',
      dsc: '崩坏3活动/补给日历',
      event: 'message',
      priority: pluginPriority('bh3_calendar', -999999),
      rule: [
        { reg: '^[!！]日历$', fnc: 'calendar' },
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3)(日历|日历列表|活动)$', fnc: 'calendar' }
      ]
    });
  }

  async calendar(e) {
    try {
      // 用户主动查询日历时直接实时拉取，不读 Redis 旧缓存。
      const data = await this.getCalendarData(e, true);
      if (!data?.list?.length) return e.reply('暂未解析到崩坏3活动日历数据，请稍后再试。');
      return render('bh3_calendar/calendar', data, { e, ret: true, pct: 1.65 });
    } catch (err) {
      logger.error('[xhh][bh3_calendar] 日历生成失败:', err);
      return e.reply(`崩三日历生成失败：${err?.message || err}`);
    }
  }

  async getCalendarData(e, force = false) {
    moment.locale('zh-cn');
    const now = moment();
    let cached = force ? null : await redis.get(CACHE_KEY);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        data.nowTime = now.format('YYYY-MM-DD HH:mm');
        data.nowDate = now.date();
        data.nowLeft = this.getNowLeft(data.range, now);
        data.splash = this.getFixedSplash();
        return data;
      } catch (_) {}
    }

    const posts = await this.requestNews();
    const list = [];
    // 多扫一些公告，避免当前有效活动/补给被近期资讯挤出前 28 条后不显示。
    for (const item of posts.slice(0, 60)) {
      const post = item?.post || item;
      const title = this.cleanText(post.subject || post.title || '');
      if (!title || ignoreReg.test(title)) continue;
      let detail = null;
      try { detail = await this.requestPost(post.post_id); } catch (err) { logger.debug?.(`[xhh][bh3_calendar] 帖子详情失败 ${post.post_id}: ${err?.message || err}`); }
      const content = this.htmlToText(detail?.content || post.content || '');
      const time = this.extractTime(content, post.created_at);
      if (!time) continue;
      const banner = item?.image_list?.[0]?.url || post.cover || post.images?.[0] || '';
      list.push({
        id: post.post_id,
        title: title.replace(/^【[^】]+】/, ''),
        rawTitle: title,
        type: this.getType(title),
        typeName: this.getTypeName(title),
        start: time.start.format('MM-DD HH:mm'),
        end: time.end.format('MM-DD HH:mm'),
        startFull: time.start.format('YYYY-MM-DD HH:mm'),
        endFull: time.end.format('YYYY-MM-DD HH:mm'),
        leftTime: this.leftLabel(now, time.start, time.end),
        banner
      });
      if (list.length >= 18) break;
    }

    const range = this.getRange(now);
    const viewList = this.layout(list, range, now);
    const data = {
      game: 'bh3',
      title: '崩坏3日历',
      subtitle: '数据来源：米游社官方公告',
      nowTime: now.format('YYYY-MM-DD HH:mm'),
      nowDate: now.date(),
      dateList: this.getDateList(range.start),
      range: { start: range.start.format('YYYY-MM-DD HH:mm:ss'), end: range.end.format('YYYY-MM-DD HH:mm:ss') },
      nowLeft: this.getNowLeft({ start: range.start.format('YYYY-MM-DD HH:mm:ss'), end: range.end.format('YYYY-MM-DD HH:mm:ss') }, now),
      list: viewList,
      rawCount: list.length,
      splash: this.getFixedSplash()
    };
    await redis.set(CACHE_KEY, JSON.stringify(data), { EX: CACHE_TTL });
    return data;
  }


  getFixedSplash() {
    const dir = './plugins/xhh/resources/gacha_pool/fixed_splash/崩坏3';
    try {
      if (!fs.existsSync(dir)) return '';
      const files = fs.readdirSync(dir)
        .filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))
        .filter(f => {
          try { return fs.statSync(`${dir}/${f}`).isFile(); } catch (_) { return false; }
        });
      if (!files.length) return '';
      const file = files[Math.floor(Math.random() * files.length)];
      return `gacha_pool/fixed_splash/崩坏3/${file}`;
    } catch (_) {
      return '';
    }
  }

  async requestNews() {
    const res = await fetch(NEWS_API, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`米游社列表 HTTP ${res.status}`);
    const json = await res.json();
    if (json?.retcode !== 0 || !Array.isArray(json?.data?.list)) throw new Error(`米游社列表异常：${json?.message || json?.retcode}`);
    return json.data.list;
  }

  async requestPost(postId) {
    if (!postId) return null;
    const res = await fetch(POST_API + postId, { headers: this.headers(postId), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`帖子详情 HTTP ${res.status}`);
    const json = await res.json();
    if (json?.retcode !== 0) throw new Error(`帖子详情异常：${json?.message || json?.retcode}`);
    return json?.data?.post?.post || null;
  }

  headers(postId = '') {
    return {
      Referer: postId ? `https://www.miyoushe.com/bh3/article/${postId}` : 'https://www.miyoushe.com/bh3',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    };
  }

  cleanText(text = '') {
    return String(text || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  }

  htmlToText(html = '') {
    return this.cleanText(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim();
  }

  extractTime(text = '', createdAt = 0) {
    text = String(text || '').replace(/\s+/g, ' ');
    const year = moment.unix(Number(createdAt) || moment().unix()).year();
    const versionAfter = text.match(/(\d+\.\d+)版本更新后\s*[~～至\-—]+\s*(?:(20\d{2})[年\/-])?([0-9]{1,2})月([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/);
    if (versionAfter) {
      const s = this.getVersionStart(versionAfter[1], createdAt);
      const e = moment(`${versionAfter[2] || year}-${versionAfter[3]}-${versionAfter[4]} ${versionAfter[5]}`, 'YYYY-M-D H:mm');
      if (s.isValid() && e.isValid()) {
        if (e.isBefore(s)) e.add(1, 'year');
        return { start: s, end: e };
      }
    }
    const regs = [
      /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{4})[年\/-]([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})(?:[:0-9]*)?\s*[~～至\-—]+\s*(?:([0-9]{4})[年\/-])?([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/,
      /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
      /([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/
    ];
    for (const reg of regs) {
      const m = text.match(reg);
      if (!m) continue;
      let s, e;
      if (m.length >= 9 && m[1]?.length === 4) {
        s = moment(`${m[1]}-${m[2]}-${m[3]} ${m[4]}`, 'YYYY-M-D H:mm');
        e = moment(`${m[5] || m[1]}-${m[6]}-${m[7]} ${m[8]}`, 'YYYY-M-D H:mm');
      } else {
        const offset = timeTitleReg.test(text.slice(Math.max(0, m.index - 30), m.index + 30)) ? 0 : 0;
        s = moment(`${year}-${m[1 + offset]}-${m[2 + offset]} ${m[3 + offset]}`, 'YYYY-M-D H:mm');
        e = moment(`${year}-${m[4 + offset]}-${m[5 + offset]} ${m[6 + offset]}`, 'YYYY-M-D H:mm');
      }
      if (!s.isValid() || !e.isValid()) continue;
      if (e.isBefore(s)) e.add(1, 'year');
      return { start: s, end: e };
    }
    return null;
  }

  getVersionStart(version = '', createdAt = 0) {
    const map = {
      '9.0': '2026-07-23 11:00',
    };
    if (map[version]) return moment(map[version], 'YYYY-MM-DD HH:mm');
    const base = moment.unix(Number(createdAt) || moment().unix());
    // 兜底：没有维护结束时间时，按公告发布日期 11:00 作为版本更新后起点。
    return base.hour(11).minute(0).second(0).millisecond(0);
  }

  getType(title = '') {
    if (/补给|扩充|精准|跃升|协同/.test(title)) return 'supply';
    if (/服装|皮肤|时装/.test(title)) return 'outfit';
    if (/登录|水晶|福利|活动|挑战|关卡|作战|复刻/.test(title)) return 'event';
    return 'normal';
  }

  getTypeName(title = '') {
    const type = this.getType(title);
    return { supply: '补给', outfit: '服装', event: '活动', normal: '公告' }[type];
  }

  getRange(now) {
    // 日历默认展示“今天起”的当前/未来活动；不再把昨天已结束的补给挤在最前面。
    return { start: now.clone().startOf('day'), end: now.clone().startOf('day').add(16, 'days').endOf('day') };
  }

  getDateList(start) {
    const ret = [];
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    for (let i = 0; i < 17; i++) {
      const d = start.clone().add(i, 'days');
      ret.push({ day: d.date(), month: d.month() + 1, week: week[d.day()], isToday: d.isSame(moment(), 'day') });
    }
    return ret;
  }

  getNowLeft(range, now) {
    const s = moment(range.start);
    const e = moment(range.end);
    return Math.max(0, Math.min(100, (now - s) / (e - s) * 100));
  }

  layout(list, range, now) {
    const total = range.end - range.start;
    const rows = [];
    return list
      .filter(i => moment(i.endFull).isAfter(range.start) && moment(i.startFull).isBefore(range.end))
      .sort((a, b) => moment(a.startFull) - moment(b.startFull) || moment(a.endFull) - moment(b.endFull))
      .map(item => {
        const s = moment.max(moment(item.startFull), range.start);
        const e = moment.min(moment(item.endFull), range.end);
        const left = Math.max(0, (s - range.start) / total * 100);
        const width = Math.max(2, (e - s) / total * 100);
        let row = rows.findIndex(end => left >= end + 0.5);
        if (row < 0) { row = rows.length; rows.push(0); }
        rows[row] = left + width;
        return { ...item, left, width, row, active: moment(item.startFull).isBefore(now) && moment(item.endFull).isAfter(now) };
      });
  }

  leftLabel(now, start, end) {
    if (now.isBefore(start)) return `${start.from(now, true)}后开始`;
    if (now.isBefore(end)) return `${end.from(now, true)}后结束`;
    return '已结束';
  }
}
