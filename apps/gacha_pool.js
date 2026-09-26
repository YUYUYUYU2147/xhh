import { makeForwardMsg, render, yaml, pluginPriority } from '#xhh';
import fs from 'fs';
import YAML from 'yaml';
import { bh3_gacha } from './bh3_gacha.js';
import officialPool from '../system/gacha_pool_official.js';

const ZZZ_HISTORY_URL = 'https://raw.githubusercontent.com/iaoongin/GachaClock/main/spider/data/zzz/history.json';
const ZZZ_META_URL = 'https://raw.githubusercontent.com/iaoongin/GachaClock/main/spider/data/meta.json';
const ZZZ_RAW_BASE = 'https://raw.githubusercontent.com/iaoongin/GachaClock/main/spider/';
const ZZZ_CACHE_KEY = 'xhh:zzz:pool_history:data:v2';
const ZZZ_CACHE_EXPIRE_KEY = 'xhh:zzz:pool_history:expire:v2';
const ZZZ_POOL_HISTORY_YAML_PATH = './plugins/xhh/system/default/zzz_gacha_pool_history.yaml';
const ZZZ_BWIKI_URL = 'https://wiki.biligame.com/zzz/%E8%B0%83%E9%A2%91';
// 星铁只认「历史跃迁」页：当期「跃迁」页只列当前版本的少数几期，且联动池（长期）与常规池共用同一版本标签，
// 用它同步会把「长期」时间写进常规池条目（4.4上半被改成 07/24 ~ 长期）。
const SR_BWIKI_URL = 'https://wiki.biligame.com/sr/' + encodeURIComponent('历史跃迁');
// 米游社「官方号搜索接口」：按标题关键词搜某个官方号发的公告，再按图片索引取图。
// 结构参考社区插件：['帖子标题关键字段', 作者uid, [图片索引数组], '作者名']
const MYS_SEARCH_API = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list';
const MYS_OFFICIAL_UID = { gs: '75276539', sr: '288909600', zzz: '152039148', bh3: '73565430' };
// 各游戏卡池公告的标题特征：只认带这些词的帖子，避免匹配到「版本更新说明/问题反馈」之类
const MYS_TITLE_MATCH = {
  gs: /祈愿/,
  sr: /跃迁/,
  zzz: /频段|调频/,
  bh3: /补给|跃升|协同|神之键|服装|扩充|精准/
};
const MYS_MAX_IMAGES = 10;
const MYS_COVER_CACHE = new Map();
const MYS_ASPECT_CACHE = new Map();
const YS_BWIKI_URL = 'https://wiki.biligame.com/ys/' + encodeURIComponent('往期祈愿');
const GS_POOL_HISTORY_YAML_PATH = './plugins/xhh/system/default/gslogs.yaml';
const SR_POOL_HISTORY_YAML_PATH = './plugins/xhh/system/default/sr_logs.yaml';
const BH3_POOL_HISTORY_YAML_PATH = './plugins/xhh/system/default/bh3_gacha_pool_history.yaml';
const BH3_POOL_HISTORY_PATH = './plugins/xhh/system/default/bh3_gacha_pool_history.json';
const BH3_MARK_ICON = 'bh3_note/bh3_pool_banner.png';
const BH3_CARD_FALLBACK_ICON = 'bh3_note/bh3_icon.png';
const ZZZ_MARK_ICON = 'zzz_md/imgs/ellen.png';
const GS_MARK_ICON = 'gs_mark/paimon.png';
const SR_MARK_ICON = '/root/TRSS_AllBot/TRSS-Yunzai/plugins/miao-plugin/resources/meta-sr/character/三月七/imgs/splash.webp';
const MYS_MARK_ICON = 'gacha_pool/mys.png';
const CURRENT_VERSION = { gs: '7.1', sr: '4.5', zzz: '3.1', bh3: '9.0' };
const ZZZ_VERSION_UP_NAMES = {
  '3.0上半': ['维琳娜', '叶瞬光'],
  '3.0下半': ['诺姆', '千夏'],
  '3.0': ['维琳娜', '叶瞬光', '诺姆', '千夏']
};

// —— 崩三版本更新时间 ——
// 优先用自动抓取的结果（落盘 bh3_version_start.json，来源：米游社「X.X版本更新公告」），
// 抓不到时用种子表，最后按 BH3_VERSION_DAYS（约 63 天）外推。
// bh3_calendar.js 也从这里取，崩三日历与卡池同步共用一份，无需手工维护版本号。
const BH3_VERSION_START_FILE = './plugins/xhh/system/default/bh3_version_start.json';
const BH3_VERSION_START_SEED = {
  // 崩三补给节奏：12:00 开、04:00 收（如 9月4日12:00~9月24日04:00）
  '9.0': '2026-07-23 12:00',
  '9.1': '2026-09-24 12:00'
};
// 注意：这里一律不要 export —— Yunzai 的插件加载器会遍历本模块的导出项，
// 普通函数也有 prototype，会被误当成插件类实例化，导致真正的插件类没被注册（指令全部失效）。
const BH3_VERSION_DAYS = 63;

function readBh3VersionStartMap() {
  try {
    const json = JSON.parse(fs.readFileSync(BH3_VERSION_START_FILE, 'utf-8'));
    return (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
  } catch (_) {
    return {};
  }
}

// 合并写入：{ '9.1': '2026-09-24 06:00' }
function writeBh3VersionStarts(map = {}) {
  const merged = { ...readBh3VersionStartMap() };
  for (const [k, v] of Object.entries(map || {})) {
    if (k && v) merged[String(k)] = String(v);
  }
  try {
    fs.writeFileSync(BH3_VERSION_START_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  } catch (_) {
    return null;
  }
}

// 取版本开始时间戳：自动抓取结果 > 种子表；都没有返回 null（由调用方按节奏外推）
function bh3VersionStart(version = '') {
  const raw = String(version ?? '').trim();
  const num = Number(raw);
  const keys = [raw, Number.isNaN(num) ? '' : num.toFixed(1)];
  const file = readBh3VersionStartMap();
  for (const k of keys) {
    if (!k) continue;
    const val = file[k] || BH3_VERSION_START_SEED[k];
    if (!val) continue;
    const ts = new Date(String(val).replace(/-/g, '/')).getTime();
    if (!Number.isNaN(ts)) return ts;
  }
  return null;
}

export class xhh_gacha_pool extends plugin {
  constructor(e) {
    super({
      name: '[小花火]全游戏卡池',
      dsc: '原神/星铁/绝区零/崩三卡池查询',
      event: 'message',
      // Yunzai 的优先级数值越小越先执行；卡池命令容易被 gs_logs/mora 等宽泛规则抢走，
      // 这里放到极前面，先让统一卡池图片接管；未命中的再交给历史卡池兜底。
      priority: pluginPriority('gacha_pool', -1000000000),
      rule: [
        // 最常用的原神当前卡池放最前，使用最简单正则，避免被通用“xx卡池”规则误判。
        { reg: '^#?(?:xhh)?原神卡池$', fnc: 'gsCurrentPool' },
        { reg: '^#?(?:xhh)?原神(当前|本期|当期)卡池$', fnc: 'gsCurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)(当前|本期|当期)?(卡池|补给)$', fnc: 'bh3CurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)v?(\\d+\\.\\d+)(上半|下半)?(卡池|补给)$', fnc: 'bh3VersionPool' },
        { reg: '^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)(卡池|补给)(统计|记录|历史|全)$', fnc: 'bh3AllPool' },
        // 「崩三历史卡池 / 崩三全部卡池」：历史/全部 在前的新叫法，与绝区零「绝区零历史卡池」保持一致
        { reg: '^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)(历史|全部|统计|记录)(卡池|补给)$', fnc: 'bh3AllPool' },
        // 原神卡池
        { reg: '^[#＃井]*(?:xhh)?\\s*(?:小花火)?\\s*原神\\s*(?:当前|本期|当期)?\\s*卡池$', fnc: 'gsCurrentPool' },
        { reg: '^[#＃井]*(?:xhh)?\\s*(?:小花火)?\\s*原神\\s*v?(\\d+\\.\\d+)\\s*(上半|下半)?\\s*卡池$', fnc: 'gsVersionPool' },
        { reg: '^#*(?:xhh)?(小花火)?原神(统计|记录|历史|全部|全|时间轴)卡池$', fnc: 'gsAllPool' },
        { reg: '^#*(?:xhh)?(小花火)?原神(?!官方|米游社)(.+)卡池$', fnc: 'gsNameHistory' },
        { reg: '^#*(?:xhh)?(小花火)?原神(卡池)(统计|记录|历史|全)$', fnc: 'gsAllPool' },
        // 星铁卡池
        { reg: '^#*(?:xhh)?(小花火)?(星铁|崩铁|星穹铁道)(当前|本期|当期)?(卡池|跃迁)$', fnc: 'srCurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(星铁|崩铁|星穹铁道)v?(\\d+\\.\\d+)(上半|下半)?(卡池|跃迁)$', fnc: 'srVersionPool' },
        { reg: '^#*(?:xhh)?(小花火)?(星铁|崩铁|星穹铁道)(统计|记录|历史|全部|全|时间轴)(卡池|跃迁)$', fnc: 'srAllPool' },
        { reg: '^#*(?:xhh)?(小花火)?(星铁|崩铁|星穹铁道)(?!v?\\d+\\.\\d+)(?!官方|米游社)(.+)(卡池|跃迁)$', fnc: 'srNameHistory' },
        // 官方/米游社卡池必须在 bh3NameHistory 之前，否则"崩三官方卡池"会被误判为角色名
        // 强制刷新：绕过风控冷却，用来确认米游社是否已解除风控
        { reg: '^#*(?:xhh)?(小花火)?(强制|立即)(更新|刷新)卡池(数据)?$', fnc: 'refreshOfficialPools' },
        { reg: '^#*(?:xhh)?(小花火)?((原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3))?(米游社|官方)?(更新|刷新)卡池(数据)?$', fnc: 'refreshOfficialPools' },
        { reg: '^#*(?:xhh)?(小花火)?(全游戏|全部|所有)?(当前|本期|当期)卡池$', fnc: 'allCurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)?(米游社|官方)(当前|本期|当期)?卡池$', fnc: 'officialCurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(\\d+\\.\\d+)(米游社|官方)卡池$', fnc: 'officialVersionPool' },
        { reg: '^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)(?!v?\\d+\\.\\d+)(?!官方|米游社)(.+)(卡池|补给)$', fnc: 'bh3NameHistory' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)(当前|本期|当期)?卡池$', fnc: 'zzzCurrentPool' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)v?(\\d+\\.\\d+)(上半|下半)?卡池$', fnc: 'zzzVersionPool' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)(统计|记录|历史|全部|全|时间轴)卡池$', fnc: 'zzzAllPool' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)(?!v?\\d+\\.\\d+)(.+)卡池$', fnc: 'zzzNameHistory' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)(.+)(卡池|复刻)(统计|记录|历史)$', fnc: 'zzzNameHistory' },
        { reg: '^#*(?:xhh)?(小花火)?(绝区零|ZZZ)(卡池|复刻)(统计|记录|历史)$', fnc: 'zzzAllPool' },
        // 类似"雷神卡池/德莉莎卡池/白厄卡池"的用法：依次查绝区零、崩三、星铁、原神
        { reg: '^(?!#*(?:xhh)?(?:小花火)?(?:原神|星铁|崩铁|崩三|崩坏3|崩坏三|BH3|绝区零|ZZZ))#*(?:xhh)?(小花火)?([\u4e00-\u9fa5A-Za-z0-9·・•!！「」『』（）()]{1,16})(卡池|复刻)(统计|记录|历史)?$', fnc: 'genericNameHistory' }
      ]
    });
    // 每 24 小时自动跑一次「#刷新卡池」的等价逻辑（不回复消息，只打日志）
    this.task = {
      cron: '0 30 5 * * *', // 每天 05:30（秒 分 时 日 月 周）
      name: '[小花火]全游戏卡池数据自动刷新',
      fnc: () => this.autoRefreshPools(),
      log: true
    };
  }

  async accept(e) {
    const msg = String(e?.msg || '')
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
      .replace(/[＃井]/g, '#')
      .replace(/\s+/g, '');
    // 有些插件/适配器会在规则前抢“原神卡池”，这里用 accept 兜底优先接管当前卡池。
    if (/^(?:[#＃井]*\s*)?(?:小花火)?\s*原神\s*(?:当前|本期|当期)?\s*卡池$/.test(msg)) {
      e.msg = msg;
      await this.gsCurrentPool(e);
      return 'return';
    }
    // 兜底优先接管“原神官方卡池/星铁官方卡池”等指定游戏官方卡池。
    // 部分环境下进入 rule 后 e.msg 可能只剩“#官方卡池”，这里在 accept 阶段保留完整命令。
    if (/^#*(?:小花火)?(?:原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(?:米游社|官方)(?:当前|本期|当期)?卡池$/i.test(msg)) {
      e.msg = msg;
      await this.officialCurrentPool(e);
      return 'return';
    }
    return false;
  }

  parseTime(pool = {}) {
    const start = pool.startTime ? new Date(pool.startTime) : null;
    const end = pool.endTime ? new Date(pool.endTime) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { start: null, end: null };
    return { start, end };
  }

  normalizeZzzData(raw = []) {
    const data = Array.isArray(raw) ? [...raw] : [];
    if (!data.some(v => v.version === '1.0上半')) {
      data.push({
        img: 'https://patchwiki.biligame.com/images/zzz/thumb/7/7f/8pesvtvchbs3t2jhqjhckd9k08pe7ui.png/900px-%E7%8B%AC%E5%AE%B6%E9%A2%91%E6%AE%B5001%E6%9C%9F.png',
        title: '「慵懒逐浪」001期独家频段', type: '角色', version: '1.0上半',
        timer: '2024/07/04 10:00:00 ~ 2024/07/24 11:59:59', s: '艾莲', a: ['安东', '苍角']
      }, {
        img: 'https://patchwiki.biligame.com/images/zzz/thumb/3/32/gs2uajlo6v2h6pljzij84wdiwhu9fkj.png/900px-%E9%9F%B3%E6%93%8E%E9%A2%91%E6%AE%B5001%E6%9C%9F.png',
        title: '「喧哗奏鸣」001期音擎频段', type: '武器', version: '1.0上半',
        timer: '2024/07/04 10:00:00 ~ 2024/07/24 11:59:59', s: '深海访客', a: ['含羞恶面', '旋钻机-赤轴']
      });
    }
    if (!data.some(v => v.version === '3.0上半')) {
      data.push({
        img: '', title: '「凛风吟仪」独家频段', type: '角色', version: '3.0上半',
        timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '维琳娜', a: ['妮可', '派派']
      }, {
        img: '', title: '「光落于指尖」独家频段', type: '角色', version: '3.0上半',
        timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '叶瞬光', a: ['妮可', '派派']
      }, {
        img: '', title: '「琳琅鎏心」音擎频段', type: '武器', version: '3.0上半',
        timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '琳琅鎏心', a: ['轰鸣座驾', '聚宝箱']
      }, {
        img: '', title: '「云霓孤光」音擎频段', type: '武器', version: '3.0上半',
        timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '云霓孤光', a: ['轰鸣座驾', '聚宝箱']
      });
    }
    const ensureZzzPool = pool => {
      if (!data.some(v => v.version === pool.version && v.type === pool.type && v.s === pool.s)) data.push(pool);
    };
    ensureZzzPool({
      img: '', title: '「琳琅鎏心」音擎频段', type: '武器', version: '3.0上半',
      timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '琳琅鎏心', a: ['轰鸣座驾', '聚宝箱']
    });
    ensureZzzPool({
      img: '', title: '「云霓孤光」音擎频段', type: '武器', version: '3.0上半',
      timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '云霓孤光', a: ['轰鸣座驾', '聚宝箱']
    });
    if (!data.some(v => v.version === '3.0下半')) {
      data.push({
        img: '', title: '「天才不等式」独家频段', type: '角色', version: '3.0下半',
        timer: '2026/07/08 12:00:00 ~ 2026/07/28 14:59:59', s: '诺姆', a: ['可琳', '波可娜']
      }, {
        img: '', title: '「四三拍想」独家频段', type: '角色', version: '3.0下半',
        timer: '2026/07/08 12:00:00 ~ 2026/07/28 14:59:59', s: '千夏', a: ['可琳', '波可娜']
      }, {
        img: '', title: '「首席跟班」音擎频段', type: '武器', version: '3.0下半',
        timer: '2026/07/08 12:00:00 ~ 2026/07/28 14:59:59', s: '首席跟班', a: ['家政员', '裁纸刀']
      }, {
        img: '', title: '「思络成歌」音擎频段', type: '武器', version: '3.0下半',
        timer: '2026/07/08 12:00:00 ~ 2026/07/28 14:59:59', s: '思络成歌', a: ['家政员', '裁纸刀']
      });
    }
    for (const pool of data) {
      if (pool?.version === '3.0上半' && (pool.s === '光于指尖' || /光于指尖/.test(pool.title || ''))) {
        pool.title = '「云霓孤光」音擎频段';
        pool.s = '云霓孤光';
      }
      if (pool?.version === '3.0上半' && pool.type === '武器' && (pool.s === '云霓孤光' || pool.s === '琳琅鎏心')) {
        pool.a = ['轰鸣座驾', '聚宝箱'];
      }
      if (pool?.version === '3.0下半' && pool.s === '千夏') {
        pool.title = '「四三拍谬想」独家频段';
        pool.a = ['可琳', '波可娜'];
      }
      if (pool?.version === '3.0下半' && pool.s === '诺姆') {
        pool.a = ['可琳', '波可娜'];
      }
      if (pool?.version === '3.0下半' && (pool.s === '首席跟班' || pool.s === '思络成歌')) {
        pool.a = ['家政员', '裁纸刀'];
      }
    }
    data.sort((a, b) => this.poolEndStamp(a) - this.poolEndStamp(b));
    for (let i = 0; i < data.length; i++) {
      const pool = data[i];
      if (!pool.timer) continue;
      if (pool.timer.startsWith('公测开启后')) {
        const end = pool.timer.split('~')[1]?.trim();
        pool.startTime = '2024/07/04 10:00:00';
        pool.endTime = end;
      } else if (pool.timer.includes('版本更新后')) {
        const end = pool.timer.split('~')[1]?.trim();
        const prev = [...data].slice(0, i).reverse().find(v => this.poolEndStamp(v) > 0 && this.poolEndStamp(v) < this.poolEndStamp(pool));
        const d = prev ? new Date(this.poolEndStamp(prev)) : null;
        if (d) {
          d.setDate(d.getDate() + 1);
          pool.startTime = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} 11:00:00`;
          pool.endTime = end;
        }
      } else {
        const [start, end] = pool.timer.split('~').map(v => v?.trim());
        pool.startTime = start;
        pool.endTime = end;
      }
      if (pool.startTime && pool.endTime) pool.timer = `${pool.startTime} ~ ${pool.endTime}`;
    }
    return data;
  }

  nextZzzStage(version = '') {
    const m = String(version).match(/^(\d+)\.(\d+)(上半|下半)$/);
    if (!m) return '';
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return m[3] === '上半' ? `${major}.${minor}下半` : `${major}.${minor + 1}上半`;
  }

  normalizeZzzCurrentPools(raw = [], history = []) {
    if (!Array.isArray(raw) || !raw.length) return [];
    const latest = [...history].sort((a, b) => this.poolEndStamp(b) - this.poolEndStamp(a))[0];
    const version = this.nextZzzStage(latest?.version) || '最新';
    return raw.map(pool => {
      const gachas = Array.isArray(pool.gachas) ? pool.gachas : [];
      const [start, end] = Array.isArray(pool.timer) ? pool.timer : String(pool.timer || '').split('~').map(v => v.trim());
      return {
        // meta 当前池只有角色/音擎小图，patchwiki 的 112px 缩略图经常被 OneBot 下载判 404。
        // 这里不直接发送小图，避免整条消息发送失败；历史池仍保留 900px 大图。
        img: pool.img || '',
        title: pool.title || '',
        type: pool.type || '角色',
        version,
        timer: start && end ? `${start} ~ ${end}` : '',
        startTime: start,
        endTime: end,
        s: gachas[0]?.title || pool.s || '',
        a: gachas.slice(1).map(v => v.title).filter(Boolean)
      };
    }).filter(v => v.s);
  }

  loadGsPoolHistory() {
    return yaml.get(GS_POOL_HISTORY_YAML_PATH);
  }

  loadSrPoolHistory() {
    return yaml.get(SR_POOL_HISTORY_YAML_PATH);
  }

  loadZzzLocalPools() {
    try {
      if (!fs.existsSync(ZZZ_POOL_HISTORY_YAML_PATH)) return [];
      const data = yaml.get(ZZZ_POOL_HISTORY_YAML_PATH);
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.pools)) return data.pools;
      return [];
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 绝区零本地卡池YAML加载失败:', err);
      return [];
    }
  }

  mergeZzzLocalPools(remote = []) {
    const data = Array.isArray(remote) ? [...remote] : [];
    for (const pool of data) {
      if (pool?.version === '3.0上半' && (pool.s === '光于指尖' || /光于指尖/.test(pool.title || ''))) {
        pool.title = '「云霓孤光」音擎频段';
        pool.s = '云霓孤光';
      }
      if (pool?.version === '3.0上半' && pool.type === '武器' && (pool.s === '云霓孤光' || pool.s === '琳琅鎏心')) {
        pool.a = ['轰鸣座驾', '聚宝箱'];
      }
      if (pool?.version === '3.0下半' && pool.s === '千夏') {
        pool.title = '「四三拍谬想」独家频段';
        pool.a = ['可琳', '波可娜'];
      }
      if (pool?.version === '3.0下半' && pool.s === '诺姆') {
        pool.a = ['可琳', '波可娜'];
      }
      if (pool?.version === '3.0下半' && (pool.s === '首席跟班' || pool.s === '思络成歌')) {
        pool.a = ['家政员', '裁纸刀'];
      }
    }
    const ensureZzzPool = pool => {
      if (!data.some(v => v.version === pool.version && v.type === pool.type && v.s === pool.s)) data.push(pool);
    };
    ensureZzzPool({
      img: '', title: '「琳琅鎏心」音擎频段', type: '武器', version: '3.0上半',
      timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '琳琅鎏心', a: ['轰鸣座驾', '聚宝箱'],
      startTime: '2026/06/17 10:00:00', endTime: '2026/07/08 11:59:59'
    });
    ensureZzzPool({
      img: '', title: '「云霓孤光」音擎频段', type: '武器', version: '3.0上半',
      timer: '2026/06/17 10:00:00 ~ 2026/07/08 11:59:59', s: '云霓孤光', a: ['轰鸣座驾', '聚宝箱'],
      startTime: '2026/06/17 10:00:00', endTime: '2026/07/08 11:59:59'
    });
    const local = this.loadZzzLocalPools().map(pool => {
      const item = { ...pool };
      if (item.timer) {
        const [start, end] = String(item.timer).split('~').map(v => v?.trim());
        item.startTime = item.startTime || start;
        item.endTime = item.endTime || end;
        if (item.startTime && item.endTime) item.timer = `${item.startTime} ~ ${item.endTime}`;
      }
      return item;
    }).filter(v => v.s && v.version);
    if (!local.length) return data;
    const keyOf = pool => `${pool.version || '-'}|${pool.type || '-'}|${pool.s || '-'}|${pool.title || ''}`;
    const map = new Map(data.map(pool => [keyOf(pool), pool]));
    for (const pool of local) map.set(keyOf(pool), pool);
    return this.resolveZzzVersionUpdateTimes([...map.values()])
      .sort((a, b) => this.poolEndStamp(a) - this.poolEndStamp(b));
  }

  resolveZzzVersionUpdateTimes(data = []) {
    const pools = Array.isArray(data) ? data : [];
    const endStamp = pool => {
      const end = pool?.endTime || String(pool?.timer || '').split('~')[1]?.trim() || '';
      const t = new Date(end).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const sorted = [...pools].sort((a, b) => endStamp(a) - endStamp(b));
    for (let i = 0; i < sorted.length; i++) {
      const pool = sorted[i];
      const timer = String(pool?.timer || '');
      if (timer.includes('公测开启后')) {
        const end = timer.split('~')[1]?.trim() || pool.endTime || '';
        pool.startTime = '2024/07/04 10:00:00';
        pool.endTime = end;
        pool.timer = `${pool.startTime} ~ ${pool.endTime}`;
        continue;
      }
      if (!timer.includes('版本更新后')) continue;
      const end = timer.split('~')[1]?.trim() || pool.endTime || '';
      const prev = [...sorted].slice(0, i).reverse().find(v => endStamp(v) > 0 && endStamp(v) < endStamp(pool));
      const d = prev ? new Date(endStamp(prev)) : null;
      if (!d || Number.isNaN(d.getTime())) continue;
      d.setSeconds(d.getSeconds() + 1);
      const start = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      pool.startTime = start;
      pool.endTime = end;
      pool.timer = `${start} ~ ${end}`;
    }
    return pools;
  }

  async fetchZzzCurrentAppend(history = []) {
    try {
      const meta = await fetch(ZZZ_META_URL, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      if (!meta?.zzz) return [];
      const raw = await fetch(`${ZZZ_RAW_BASE}${meta.zzz}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      return this.normalizeZzzCurrentPools(raw, history);
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 绝区零当前卡池附加数据获取失败:', err);
      return [];
    }
  }

  poolEndStamp(pool = {}) {
    const text = pool.endTime || pool.timer?.split('~')[1]?.trim() || '';
    const t = new Date(text).getTime();
    return Number.isNaN(t) ? 0 : t;
  }

  async fetchZzzPools() {
    const valid = await redis.get(ZZZ_CACHE_EXPIRE_KEY);
    if (valid) {
      const cache = await redis.get(ZZZ_CACHE_KEY);
      if (cache) return this.mergeZzzLocalPools(JSON.parse(cache));
      await redis.del(ZZZ_CACHE_EXPIRE_KEY);
    }
    try {
      const res = await fetch(ZZZ_HISTORY_URL, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = this.mergeZzzLocalPools(this.normalizeZzzData(await res.json()));
      const extra = await this.fetchZzzCurrentAppend(data);
      for (const pool of extra) {
        const key = `${pool.title}:${pool.timer}:${pool.s}`;
        if (!data.some(v => `${v.title}:${v.timer}:${v.s}` === key)) data.push(pool);
      }
      data.sort((a, b) => this.poolEndStamp(a) - this.poolEndStamp(b));
      await redis.set(ZZZ_CACHE_KEY, JSON.stringify(data));
      await redis.set(ZZZ_CACHE_EXPIRE_KEY, '1', { EX: 24 * 60 * 60 });
      return data;
    } catch (err) {
      const cache = await redis.get(ZZZ_CACHE_KEY);
      if (cache) return this.mergeZzzLocalPools(JSON.parse(cache));
      logger.error('[xhh][gacha_pool] 绝区零卡池数据获取失败:', err);
      const local = this.mergeZzzLocalPools([]);
      return local.length ? local : null;
    }
  }

  formatPoolLine(pool) {
    const a = Array.isArray(pool.a) ? pool.a.join('，') : (pool.a || '-');
    const type = pool.type === '武器' ? '音擎' : '角色';
    return `◈ ${type}：S-${pool.s || '-'} | A-${a}`;
  }

  poolTypeName(pool = {}) {
    return pool.type === '武器' ? '音擎频段' : '代理人频段';
  }

  poolToCard(pool = {}) {
    return {
      version: pool.version || '-',
      title: pool.title || (pool.s ? `${this.poolTypeName(pool)}·${pool.s}` : this.poolTypeName(pool)),
      type: this.poolTypeName(pool),
      time: this.zzzPoolTime(pool),
      s: pool.s || '-',
      a: Array.isArray(pool.a) ? pool.a.join(' / ') : (pool.a || '-'),
      img: pool.img || '',
      weapon: pool.type === '武器'
    };
  }

  gameMarkIcon(game = '') {
    if (game === '原神') return GS_MARK_ICON;
    if (game === '星穹铁道') return SR_MARK_ICON;
    if (game === '绝区零') return ZZZ_MARK_ICON;
    if (game === '崩坏3') return BH3_MARK_ICON;
    if (game === '米游社') return MYS_MARK_ICON;
    return '';
  }

  randomPick(list = []) {
    const arr = (Array.isArray(list) ? list : []).filter(Boolean);
    if (!arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
  }

  getFixedCornerImage(game = '') {
    if (!this.useCustomGachaArt()) return '';
    const gameName = String(game || '').trim();
    const primaryDirs = [
      `./plugins/xhh/resources/gacha_pool/fixed_splash/${gameName}`,
      `./plugins/xhh/resources/gacha_pool/fixed_splash/${this.detectOfficialGame(gameName) || gameName}`
    ];
    const fallbackDirs = [];
    if (gameName === '星穹铁道') fallbackDirs.push('./plugins/xhh/resources/srlogs/imgs/sr');
    if (gameName === '绝区零') fallbackDirs.push('./plugins/xhh/resources/zzz_md/imgs/custom', './plugins/xhh/resources/zzzlogs/imgs');
    const readDirImages = (dir, safeCheck = true) => {
      if (!dir || !fs.existsSync(dir)) return [];
      const files = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(png|webp|jpg|jpeg)$/i.test(f)) continue;
          const p = `${dir}/${f}`;
          if (fs.statSync(p).isFile() && (!safeCheck || this.isSafeCornerSplashFile(p))) files.push(fs.realpathSync(p));
        }
      } catch (_) {}
      return files;
    };
    // fixed_splash 是用户指定目录：只要该游戏目录里有图，就直接从这里随机选，不再混入其它兜底目录。
    for (const dir of [...new Set(primaryDirs)]) {
      const files = readDirImages(dir, false);
      if (files.length) return this.randomPick(files);
    }
    for (const dir of [...new Set(fallbackDirs)]) {
      const files = readDirImages(dir, true);
      if (files.length) return this.randomPick(files);
    }
    return '';
  }

  fixedCornerFallback(game = '') {
    const fixed = this.getFixedCornerImage(game);
    if (fixed) return fixed;
    return this.getMarkIcon(game) || this.gameMarkIcon(game);
  }

  shuffleList(list = []) {
    const arr = [...(Array.isArray(list) ? list : [])];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  useCustomGachaArt(kind = 'header') {
    try {
      const cfg = yaml.get('./plugins/xhh/config/config.yaml') || {};
      const legacy = cfg.gacha_art_source || 'custom';
      const key = kind === 'up' ? 'gacha_up_icon_source' : 'gacha_header_art_source';
      return (cfg[key] || legacy || 'custom') !== 'official';
    } catch (_) {
      return true;
    }
  }

  async renderPoolImage(e, data) {
    const fixed = this.getFixedCornerImage(data?.game);
    if (fixed) {
      data.markIcon = fixed;
      data.markWide = true;
    }
    if (Array.isArray(data?.cards) && data.mode !== 'gs-history') {
      data.cards.forEach((card, i) => {
        if (!card.index) card.index = i + 1;
      });
    }
    if (!data.markIcon) {
      const mark = this.gameMarkIcon(data?.game);
      if (mark) {
        data.markIcon = mark;
        data.markWide = data.game === '原神' || data.game === '崩坏3';
      }
    }
    return render('gacha_pool/pool', data, { e, ret: true });
  }

  getSectionUpNames(sections = []) {
    const names = [];
    for (const sec of sections || []) {
      for (const row of sec.rows || []) {
        if (row.weapon) continue;
        for (const item of row.items || []) if (item?.name) names.push(item.name);
      }
    }
    return names;
  }

  getHistorySplash(game = '', sections = []) {
    if (this.useCustomGachaArt()) return this.fixedCornerFallback(game);
    // 历史卡池右上角空间很小，官方模式使用干净的 UP 头像/小图，避免竖向立绘背景色和标题框冲突。
    const name = this.getSectionUpNames(sections)[0] || '';
    if (!name) return '';
    if (game === '原神') return this.getGsCharacterIcon(name) || '';
    if (game === '星穹铁道') return this.getSrCharacterIcon(name) || '';
    if (game === '绝区零') return this.getZzzIcon(name, false) || '';
    return '';
  }

  async renderSrLogs(e, data, query = '') {
    // 星铁也统一走新的“版本 + 时间 + UP头像行”样式，避免特定角色卡池还显示原版大卡片。
    const sections = this.buildSrHistorySections(data, query);
    const splash = this.getHistorySplash('星穹铁道', sections);
    return render('gslogs/logs', { data: sections, splash }, { e, ret: true });
  }

  async renderGsLogs(e, sections) {
    const splash = this.getHistorySplash('原神', sections);
    return render('gslogs/logs', { data: sections, splash }, { e, ret: true });
  }

  async renderZzzLogs(e, sections, query = '') {
    const splash = this.getHistorySplash('绝区零', sections);
    return render('zzzlogs/logs', { data: sections, splash }, { e, ret: true });
  }

  async renderBh3Logs(e, sections) {
    let splash = '';
    if (this.useCustomGachaArt()) {
      splash = this.fixedCornerFallback('崩坏3') || BH3_MARK_ICON;
    } else {
      // 官方模式下使用本期 UP 小图/头像，避免回退到 bh3_pool_banner.png 这种补给截图。
      for (const sec of sections || []) {
        for (const row of sec.rows || []) {
          if (row.weapon) continue;
          const icon = (row.items || []).find(v => v?.icon)?.icon;
          if (icon) { splash = icon; break; }
        }
        if (splash) break;
      }
    }
    return render('bh3logs/logs', { data: sections, splash }, { e, ret: true });
  }

  zzzPoolTime(pool = {}) {
    const start = pool.startTime || String(pool.timer || '').split('~')[0]?.trim();
    const end = pool.endTime || String(pool.timer || '').split('~')[1]?.trim();
    if (start && end) return `${start} ~ ${end}`;
    return pool?.timer || '-';
  }

  formatGsHistoryTime(dateKey = '') {
    const raw = String(dateKey || '').replace(/^【.*?】/, '').trim();
    const [start, end] = raw.split('~').map(v => v?.trim()).filter(Boolean);
    if (!start || !end) return raw || '-';
    return `${this.ensureFullTime(start, true)} ~ ${this.ensureFullTime(end, false)}`;
  }

  ensureFullTime(text = '', isStart = true) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (/\d{2}:\d{2}(?::\d{2})?/.test(t)) return /\d{2}:\d{2}:\d{2}/.test(t) ? t : `${t}:00`;
    if (/\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}/.test(t)) {
      return `${t}${t.includes(' ') ? '' : ' '}${isStart ? '00:00:00' : '23:59:59'}`;
    }
    return t;
  }

  normalizeSrHistoryTime(time = '', prevEnd = '') {
    const raw = String(time || '').trim();
    if (!raw) return { time: '-', end: '' };
    const parts = raw.split('~').map(v => v.trim()).filter(Boolean);
    if (!parts.length) return { time: raw, end: '' };
    const startText = parts[0];
    const endText = parts[1] || '';
    let start = startText;
    if (/版本更新后/.test(startText) && prevEnd) {
      const d = new Date(prevEnd);
      if (!Number.isNaN(d.getTime())) {
        d.setSeconds(d.getSeconds() + 1);
        start = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      }
    } else {
      start = this.ensureFullTime(startText, true);
    }
    const end = this.ensureFullTime(endText || startText, false);
    return { time: `${start} ~ ${end}`, end };
  }

  buildZzzPoolsReply(title, pools = [], extra = '') {
    const msg = [`【${title}】${extra ? `\n${extra}` : ''}`];
    const stages = [...new Set(pools.map(p => p.version).filter(Boolean))];
    for (const stage of stages) {
      const ps = pools.filter(p => p.version === stage);
      msg.push(`\n【${stage}】\n⏱ ${this.zzzPoolTime(ps[0])}`);
      for (const pool of ps) {
        msg.push(this.formatPoolLine(pool));
        if (pool.img) msg.push(segment.image(pool.img));
      }
    }
    return msg;
  }

  async replyWithImageFallback(e, msg) {
    try {
      return await e.reply(msg);
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 图片消息发送失败，改为纯文本发送:', err);
      if (Array.isArray(msg)) {
        const textOnly = msg
          .filter(v => !(v?.type === 'image' || v?.type === 'node'))
          .map(v => typeof v === 'string' ? v : v?.data?.text || '')
          .filter(Boolean);
        return e.reply(textOnly.join('\n'));
      }
      throw err;
    }
  }

  getMarkIcon(game) {
    const iconMap = {
      '崩坏3': BH3_MARK_ICON,
      '绝区零': ZZZ_MARK_ICON,
      '原神': GS_MARK_ICON,
    };
    return iconMap[game] || '';
  }

  getMarkWide(game) {
    return game === '崩坏3' || game === '原神';
  }

  getCustomCornerSplash(gameName = '', name = '') {
    if (!this.useCustomGachaArt()) return '';
    const game = String(gameName || '').trim();
    const raw = String(name || '').trim();
    if (!game || !raw) return '';
    const base = './plugins/xhh/resources/gacha_pool/custom_splash';
    const names = [...new Set([
      raw,
      raw.replace(/[「」『』【】［］]/g, ''),
      raw.split(/[·•]/).pop(),
      raw.replace(/Pro$/i, '')
    ].map(v => String(v || '').trim()).filter(Boolean))];
    const exts = ['.webp', '.png', '.jpg', '.jpeg'];
    const files = [];
    for (const n of names) {
      const dir = `${base}/${game}/${n}`;
      if (fs.existsSync(dir)) {
        try {
          for (const f of fs.readdirSync(dir)) {
            if (exts.some(ext => f.toLowerCase().endsWith(ext))) files.push(`${dir}/${f}`);
          }
        } catch (_) {}
      }
      for (const ext of exts) {
        const file = `${base}/${game}/${n}${ext}`;
        if (fs.existsSync(file)) files.push(file);
      }
    }
    const unique = [...new Set(files)];
    return this.randomPick(unique.map(p => {
      try { return fs.realpathSync(p); } catch (_) { return ''; }
    }).filter(Boolean));
  }

  currentVersionByGame(game = '') {
    if (game === '原神') return CURRENT_VERSION.gs;
    if (game === '星穹铁道') return CURRENT_VERSION.sr;
    if (game === '绝区零') return CURRENT_VERSION.zzz;
    if (game === '崩坏3') return CURRENT_VERSION.bh3;
    return '';
  }

  splitPoolNames(text = '') {
    return String(text || '')
      .split(/[\/,，、]/)
      .map(v => v.trim())
      .filter(Boolean);
  }

  getZzzRarityFromMap(name = '', weapon = false) {
    const target = this.cleanZzzName(this.normalizeZzzName(name));
    if (!target) return '';
    const file = weapon
      ? './plugins/ZZZ-Plugin/resources/map/WeaponId2Data.json'
      : './plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json';
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      for (const info of Object.values(data)) {
        const names = weapon
          ? [info?.Name, info?.name]
          : [info?.name, info?.full_name, info?.Name, info?.FullName];
        if (!names.some(v => this.cleanZzzName(v) === target)) continue;
        const rarity = String(info?.Rarity || info?.rarity || '').toUpperCase();
        if (rarity === 'S') return 'five';
        if (rarity === 'A') return 'four';
        return '';
      }
    } catch (_) {}
    return '';
  }

  getZzzActualRarity(name = '') {
    return this.getZzzRarityFromMap(name, false) || this.getZzzRarityFromMap(name, true) || '';
  }

  expandZzzPoolNames(names = []) {
    const ret = [];
    const pushUnique = (name = '') => {
      const clean = String(name || '').trim();
      if (clean && !ret.includes(clean)) ret.push(clean);
    };
    let known = [];
    try {
      const collect = (file, fields) => {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const info of Object.values(data)) {
          for (const field of fields) {
            const name = String(info?.[field] || '').trim();
            if (name) known.push(name);
          }
        }
      };
      collect('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', ['name', 'full_name', 'Name', 'FullName']);
      collect('./plugins/ZZZ-Plugin/resources/map/WeaponId2Data.json', ['Name', 'name']);
      known = [...new Set(known)].sort((a, b) => b.length - a.length);
    } catch (_) {}
    for (const raw of names) {
      const text = String(raw || '').trim();
      if (!text) continue;
      const exact = this.getZzzActualRarity(text);
      if (exact) {
        pushUnique(text);
        continue;
      }
      let matched = false;
      const cleanText = this.cleanZzzName(text);
      for (const name of known) {
        const cleanName = this.cleanZzzName(name);
        if (!cleanName || !cleanText.includes(cleanName)) continue;
        pushUnique(name);
        matched = true;
      }
      if (!matched) pushUnique(text);
    }
    return ret;
  }

  fixZzzOfficialRanks(s = '', a = '') {
    const sNames = this.expandZzzPoolNames(this.splitPoolNames(s));
    const aNames = this.expandZzzPoolNames(this.splitPoolNames(a));
    const fixedS = [];
    const fixedA = [];
    const pushUnique = (arr, name) => {
      if (name && !arr.includes(name)) arr.push(name);
    };
    for (const name of [...sNames, ...aNames]) {
      const rarity = this.getZzzActualRarity(name);
      if (rarity === 'five') pushUnique(fixedS, name);
      else if (rarity === 'four') pushUnique(fixedA, name);
      else if (sNames.includes(name)) pushUnique(fixedS, name);
      else pushUnique(fixedA, name);
    }
    return {
      s: fixedS.join(' / '),
      a: fixedA.join(' / ')
    };
  }

  officialCard(r, gameName = '') {
    let s = Array.isArray(r.up?.s) ? r.up.s.join(' / ') : (r.up?.s || '');
    let a = Array.isArray(r.up?.a) ? r.up.a.join(' / ') : (r.up?.a || '');
    const game = gameName || r.gameName;
    if (game === '绝区零') {
      ({ s, a } = this.fixZzzOfficialRanks(s, a));
    }
    // 卡池立绘统一只放页面顶部右侧；单个 UP 卡片不再重复放立绘，避免画面太挤。
    // 若官方公告没有封面图，则尝试用 UP 角色/武器本地立绘兜底。
    let img = r.cover || r.images?.[0] || '';
    if (!img) {
      const names = String(s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
      img = this.getCardSplashByGame(game, names) || '';
    }
    return {
      version: r.version || this.currentVersionByGame(game) || '-',
      title: r.title,
      type: game || '米游社公告',
      time: r.createdAt ? `发布：${new Date(r.createdAt).toLocaleDateString('zh-CN')}` : '',
      s,
      a,
      note: s || a ? '' : (r.url ? '查看公告原文' : ''),
      img,
      weapon: false
    };
  }

  // 官方公告卡池缺少 4 星时，用本地库同池数据兜底补齐；本地库也缺失时回退到硬编码兜底。
  async patchGsOfficialCards(cards = [], gsLocalCurrent = null) {
    if (!Array.isArray(cards) || !cards.length) return;
    if (!gsLocalCurrent) gsLocalCurrent = await this.loadGsLocalCards('current');
    if (gsLocalCurrent?.length) {
      for (const card of cards) {
        if (card.a) continue;
        const isWpn = /武器/.test(card.title || '') || /^祈愿/.test(card.title || '');
        const cardS = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
        if (!cardS.length) continue;
        const localMatch = gsLocalCurrent.find(c => {
          if (c.weapon !== isWpn || !c.s) return false;
          const localS = c.s.split(' / ').map(v => v.trim());
          return localS.some(n => cardS.some(cs => cs.includes(n) || n.includes(cs)));
        });
        if (localMatch?.a) card.a = localMatch.a;
      }
    }
    await this.patchGsCardsHardcoded(cards);
  }

  // 原神四星兜底：优先从米游社官方公告自动解析（自动适配任意新版本），解析不到再回退已知版本硬编码。
  async patchGsCardsHardcoded(cards = []) {
    if (!Array.isArray(cards) || !cards.length) return;
    // 1) 自动解析：官方公告正文里的四星，任意版本生效，无需维护
    try {
      const { records } = await officialPool.fetch('gs');
      if (records?.length) {
        for (const card of cards) {
          if (card.a) continue;
          const isWpn = /武器/.test(card.title || '') || /^祈愿/.test(card.title || '');
          const cardS = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
          if (!cardS.length) continue;
          const hit = records.find(r => {
            const rS = (r.up?.s || []).map(v => String(v).trim());
            return rS.some(n => cardS.some(cs => cs.includes(n) || n.includes(cs)));
          });
          if (hit?.up?.a?.length) {
            const aList = Array.isArray(hit.up.a) ? hit.up.a : String(hit.up.a || '').split(/[\/，,、]/);
            card.a = aList.map(v => String(v).trim()).filter(Boolean).join(' / ');
          }
        }
        // 背景图兜底：本地库没配公告图、且本地立绘缺质量档时，用官方公告封面补背景
        // （如 7.1上半 沃雅妮莎：无公告图 + 无立绘，掉到 face 小头像被拉伸糊掉）。
        for (const card of cards) {
          // 本地库没配公告图（用的是本地资源拼的立绘）时，用官方公告封面覆盖，保证各卡池用各自公告的图
          if (card.img && !card.imgFallback) continue;
          const isWpnCard = /武器|神铸/.test(card.title || '');
          const cardS = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
          if (!cardS.length) continue;
          const hit = records.find(r => {
            const t = r.title || '';
            // 池类型必须一致，且排除「活动祈愿预告」这类汇总公告：
            // 否则武器卡会匹配到角色/预告公告的封面（角色立绘），导致和角色卡撞图。
            if (/预告/.test(t)) return false;
            const rWpn = /神铸赋形|武器/.test(t);
            if (isWpnCard !== rWpn) return false;
            const rS = (r.up?.s || []).map(v => String(v).trim());
            if (rS.some(n => cardS.some(cs => cs && (cs.includes(n) || n.includes(cs))))) return true;
            const rText = `${t}${r.summary || ''}`;
            return cardS.some(cs => cs && rText.includes(cs));
          });
          const cover = hit ? (hit.cover || hit.images?.[0] || '') : '';
          if (cover) card.img = cover;
        }
      }
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 原神四星公告自动解析失败，回退硬编码:', err?.message || err);
    }
    // 2) 已知版本硬编码兜底
    const HARDCODED = {
      '7.0下半': {
        '伊涅芙': ['爱诺', '伊安珊', '蓝砚'],
        '菲林斯': ['爱诺', '伊安珊', '蓝砚'],
        '血染荒城': ['笛剑', '西风大剑', '西风长枪', '昭心', '绝弦'],
        '支离轮光': ['笛剑', '西风大剑', '西风长枪', '昭心', '绝弦']
      }
    };
    for (const card of cards) {
      if (card.a) continue;
      const ver = String(card.version || '').trim();
      if (!/7\.0[上下]半/.test(ver)) continue;
      const verMap = HARDCODED['7.0下半'];
      const sNames = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
      for (const s of sNames) {
        if (verMap[s]) { card.a = verMap[s].join(' / '); break; }
      }
    }
  }

  // 绝区零官方公告缺少 A 级/UP 信息时，用本地卡池库当前期数据兜底补齐
  async patchZzzOfficialCards(cards = [], zzzLocal = null) {
    if (!Array.isArray(cards) || !cards.length) return;
    if (!zzzLocal) zzzLocal = this.loadZzzLocalPools();
    if (!Array.isArray(zzzLocal) || !zzzLocal.length) return;
    const now = new Date();
    const current = zzzLocal.filter(p => {
      const { start, end } = this.parseTime(p);
      return start && end && now >= start && now <= end;
    });
    if (!current.length) return;
    for (const card of cards) {
      if (card.a) continue;
      const cardS = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
      if (!cardS.length) continue;
      const hit = current.find(p => {
        const sNames = String(p.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
        return sNames.some(n => cardS.some(cs => cs.includes(n) || n.includes(cs)));
      });
      if (hit?.a?.length) {
        const aList = Array.isArray(hit.a) ? hit.a : String(hit.a || '').split(/[\/，,、]/);
        card.a = aList.map(v => String(v).trim()).filter(Boolean).join(' / ');
      }
    }
  }

  getCardSplashByGame(gameName = '', names = []) {
    const list = (Array.isArray(names) ? names : [names])
      .flatMap(v => String(v || '').split(/[\/,，、]/))
      .map(v => v.trim())
      .filter(Boolean);
    // 多 UP 时按卡片顺序优先取最新/最靠前的 UP 角色；角色内部仍可随机挑图。
    for (const name of list) {
      const custom = this.getCustomCornerSplash(gameName, name);
      if (custom) return custom;
      let img = '';
      if (gameName === '原神') img = this.getGsCharacterSplash(name);
      else if (gameName === '星穹铁道') img = this.getSrCharacterSplash(name);
      else if (gameName === '绝区零') img = this.getZzzCharacterSplash(name);
      // 崩坏3角色立绘走异步 getHeaderSplashByGame，这里只处理本地可同步读取的游戏。
      if (img) return img;
    }
    return '';
  }

  async getHeaderSplashByGame(gameName = '', records = [], fallback = '') {
    const names = [];
    for (const r of records || []) {
      if (Array.isArray(r.up?.s)) names.push(...r.up.s);
      else if (r.up?.s) names.push(r.up.s);
      const re = /[「『]([^」』]+)[」』]/g;
      let m;
      while ((m = re.exec(r.title || ''))) names.push(m[1]);
      if (r.contentText) {
        re.lastIndex = 0;
        let cm; while ((cm = re.exec(r.contentText))) names.push(cm[1]);
      }
    }
    if (gameName === '崩坏3') {
      for (const name of names) {
        const custom = this.getCustomCornerSplash('崩坏3', name);
        if (custom) return custom;
        const splash = await this.getBh3CharacterSplash(name);
        if (splash) return splash;
      }
    } else {
      const splash = this.getCardSplashByGame(gameName, names);
      if (splash) return splash;
    }
    return fallback || this.getMarkIcon(gameName) || this.gameMarkIcon(gameName);
  }


  getCardNames(cards = []) {
    const names = [];
    for (const c of cards || []) {
      if (c?.s) names.push(...String(c.s).split(/[\/，,、]/));
      if (c?.title) {
        const re = /[「『]([^」』]+)[」』]/g;
        let m; while ((m = re.exec(c.title))) names.push(m[1]);
      }
    }
    return names.map(v => String(v || '').trim()).filter(Boolean);
  }

  getHeaderSplashFromCards(gameName = '', cards = [], fallback = '') {
    const splash = this.getCardSplashByGame(gameName, this.getCardNames(cards));
    return splash || fallback || this.gameMarkIcon(gameName);
  }


  getZzzHeaderSplashFromCards(cards = [], fallback = ZZZ_MARK_ICON) {
    // 绝区零顶部立绘只从当前展示卡片里的 S 级代理人里选，避免回退到旧版本自定义图。
    let names = [];
    for (const card of cards || []) {
      if (card?.weapon) continue;
      if (card?.s && card.s !== '-') names.push(...String(card.s).split(/[\/，,、]/));
    }
    names = names.map(v => String(v || '').trim()).filter(Boolean);
    const versions = [...new Set((cards || []).map(c => String(c?.version || '').trim()).filter(Boolean))];
    const allow = [];
    for (const ver of versions) {
      if (ZZZ_VERSION_UP_NAMES[ver]) allow.push(...ZZZ_VERSION_UP_NAMES[ver]);
      else if (ver.startsWith(CURRENT_VERSION.zzz)) allow.push(...ZZZ_VERSION_UP_NAMES[CURRENT_VERSION.zzz] || []);
    }
    if (allow.length) {
      const allowClean = new Set(allow.map(v => this.cleanZzzName(v)));
      const filtered = names.filter(v => allowClean.has(this.cleanZzzName(this.normalizeZzzName(v))));
      // 如果官方解析混入了旧角色/武器名，直接丢弃，只在该版本真实 UP 中选。
      names = filtered.length ? filtered : allow;
    }
    const splash = this.getCardSplashByGame('绝区零', names);
    if (!splash && names.length) logger.mark('[xhh][gacha_pool] 绝区零顶部立绘未取到，候选:', names.join('/'));
    return splash || fallback;
  }

  async getBh3HeaderSplashFromPools(pools = [], fallback = BH3_MARK_ICON) {
    // 顶部右侧只取角色补给的角色立绘，避免装备/圣痕图标被误当成立绘。
    const charPools = (pools || []).filter(p => !p.weapon && p.type !== 'weapon');
    for (const name of this.shuffleList(this.getCardNames(charPools))) {
      const splash = await this.getBh3CharacterSplash(name);
      if (splash) return splash;
    }
    return fallback;
  }

  detectOfficialGame(text = '') {
    const msg = String(text || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '').replace(/[＃井]/g, '#').replace(/\s+/g, '').toLowerCase();
    if (/原神/.test(msg)) return 'gs';
    if (/(星铁|崩铁|星穹铁道)/.test(msg)) return 'sr';
    if (/(绝区零|绝区|zzz)/i.test(msg)) return 'zzz';
    if (/(崩三|崩坏3|崩坏三|bh3)/i.test(msg)) return 'bh3';
    return '';
  }

  eventText(e = {}) {
    const parts = [e.msg, e.raw_message, e.message?.map?.(v => v?.text || v?.data?.text || '').join('')].filter(Boolean);
    return parts.join(' ');
  }

  async officialCurrentPool(e) {
    const msg = this.eventText(e).replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '').replace(/[＃井]/g, '#').replace(/\s+/g, '');
    // 明确指定游戏时必须按单游戏查，避免“#原神官方卡池”被当成“官方卡池”汇总。
    const gameLabel = msg.match(/(?:#|小花火)*(原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(?:米游社|官方)/i)?.[1] || '';
    const game = this.detectOfficialGame(msg) || officialPool.resolveGame(gameLabel) || officialPool.resolveGame(msg) || officialPool.resolveGame(e.msg);
    logger.mark('[xhh][gacha_pool] 官方卡池识别:', msg, '=>', game || 'all');
    if (!game) {
      const results = await officialPool.fetchAll();
      const resultOf = key => results.find(r => r.game === key) || { records: [] };
      const cards = [];

      // 汇总页也优先使用各游戏“当前期”的本地结构化数据，避免米游社公告列表混入旧版本公告。
      const gsCards = await this.loadGsLocalCards('current');
      if (gsCards.length) {
        // 封面统一走米游社：本地库没有公告图时会退回 miao-plugin 竖版立绘（塞进横卡面被放大裁成特写），
        // 先用公告图覆盖，列表里没有祈愿公告时再用搜索接口补横版图
        try {
          const gsRecords = resultOf('gs').records || [];
          if (gsRecords.length) this.applyGsOfficialCovers(gsCards, gsRecords);
        } catch (_) {}
        await this.attachGsOfficialCovers(gsCards, true);
        cards.push(...gsCards);
      } else {
        // 本地库没数据时走公告，米游社列表常不带封面，用搜索接口补回来
        const gsOfficialCards = (resultOf('gs').records || [])
          .filter(v => String(v.version || '').startsWith(CURRENT_VERSION.gs))
          .slice(0, 5).map(v => this.officialCard(v, '原神'));
        await this.attachGsOfficialCovers(gsOfficialCards);
        cards.push(...gsOfficialCards);
      }

      const srCards = await this.loadSrLocalCards('current', resultOf('sr').records || []);
      if (srCards.length) cards.push(...srCards);
      else cards.push(...(resultOf('sr').records || [])
        .filter(v => String(v.version || '').startsWith(CURRENT_VERSION.sr))
        .slice(0, 5).map(v => this.officialCard(v, '星穹铁道')));

      const zzzData = await this.fetchZzzPools();
      if (Array.isArray(zzzData)) {
        const now = new Date();
        const zzzCurrent = zzzData.filter(p => {
          const { start, end } = this.parseTime(p);
          return start && end && now >= start && now <= end;
        });
        if (zzzCurrent.length) cards.push(...await this.applyZzzCardBackgrounds(zzzCurrent.map(p => this.poolToCard(p)), resultOf('zzz').records || []));
      }
      if (!cards.some(c => c.type === '代理人频段' || c.type === '音擎频段')) {
        cards.push(...(resultOf('zzz').records || [])
          .filter(v => String(v.version || '').startsWith(CURRENT_VERSION.zzz))
          .slice(0, 5).map(v => this.officialCard(v, '绝区零')));
      }

      const bh3Cards = await this.loadBh3CurrentPools();
      if (bh3Cards.length) {
        await this.attachBh3OfficialCovers(bh3Cards);
        cards.push(...bh3Cards);
      } else {
        cards.push(...(resultOf('bh3').records || []).slice(0, 5).map(v => this.officialCard(v, '崩坏3')));
      }

      if (!cards.length) return e.reply('暂未从米游社官方公告匹配到卡池/补给信息。');
      // 排查用：打印每张卡最终使用的封面链接，确认封面来源（公告图 / 本地立绘 / 无图）
      logger.mark('[xhh][gacha_pool] 汇总卡池封面:', '\n  ' + cards.map(c => `${c.title} => ${c.img || '(无图)'}${c.imgFallback ? ' [Fallback]' : ''}`).join('\n  '));
      return this.renderPoolImage(e, {
        game: '米游社',
        title: '官方当前卡池',
        subtitle: '原神 / 星铁 / 绝区零 / 崩坏3 · 数据来源：米游社官方公告',
        mode: 'official',
        markIcon: MYS_MARK_ICON,
        markWide: false,
        cards
      });
    }
    const meta = officialPool.games[game];
    logger.mark(`[xhh][gacha_pool] 命中${meta.name}官方卡池:`, e.msg);
    // 星铁 4.4 起一条公告里同时包含多角色、多光锥，通用公告解析容易混排或漏项。
    // 指定“星铁米游社/官方卡池”时优先用按官方公告整理后的本地结构化表。
    if (game === 'sr') {
      const srOfficial = await officialPool.fetch(game);
      const cards = await this.loadSrLocalCards('current', srOfficial.records || []);
      if (cards.length) {
        return this.renderPoolImage(e, {
          game: meta.name,
          title: `${meta.name}米游社官方卡池`,
          subtitle: this.formatCurrentPoolSubtitle(cards[0]?.version, cards[0]?.time, `数据来源：米游社公告整理 · v${CURRENT_VERSION.sr}`),
          mode: 'official official-game',
          markIcon: this.fixedCornerFallback(meta.name),
          markWide: true,
          cards
        });
      }
    }
    // 原神公告的 4 星写法较多样，且米游社详情接口 content 偶发缺失，通用公告解析容易漏掉 4 星。
    // 指定“原神米游社/官方卡池”时同样优先用本地结构化卡池表，保证 5 星/4 星稳定展示（与星铁一致）。
    if (game === 'gs') {
      const gsLocal = await this.loadGsLocalCards('current');
      if (gsLocal.length) {
        // 本地 yaml 缺失四星时，用公告自动解析兜底补齐
        await this.patchGsCardsHardcoded(gsLocal);
        gsLocal.forEach((card, i) => {
          card.index = i + 1;
          card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        });
        const markIcon = this.getHeaderSplashFromCards('原神', gsLocal, GS_MARK_ICON);
        return this.renderPoolImage(e, {
          game: meta.name,
          title: `${meta.name}米游社官方卡池`,
          subtitle: this.formatCurrentPoolSubtitle(gsLocal[0]?.version, gsLocal[0]?.time, '数据来源：米游社公告整理 · 本地卡池库'),
          mode: 'official official-game',
          markIcon,
          markWide: !!markIcon,
          cards: gsLocal
        });
      }
    }
    const { records, error, cache } = await officialPool.fetch(game);
    if (!records.length) return e.reply(`${meta.name}米游社公告卡池数据获取失败${error ? '：' + error : ''}`);
    const cards = records.map(r => this.officialCard(r, meta.name));
    // 原神官方公告若没解析出 4 星，用本地库同池数据兜底补齐；封面缺失时用搜索接口找回公告 banner
    if (game === 'gs') {
      await this.patchGsOfficialCards(cards);
      await this.attachGsOfficialCovers(cards);
    }
    // 绝区零官方公告若没解析出 UP 信息，用本地卡池库兜底补齐
    else if (game === 'zzz') await this.patchZzzOfficialCards(cards);
    const markIcon = game === 'zzz'
      ? this.getZzzHeaderSplashFromCards(cards, this.getMarkIcon(meta.name))
      : await this.getHeaderSplashByGame(meta.name, records, this.getMarkIcon(meta.name));
    return this.renderPoolImage(e, {
      game: meta.name,
      title: `${meta.name}米游社官方卡池`,
      subtitle: `数据来源：米游社公告${cache ? '（缓存）' : ''}`,
      mode: 'official official-game',
      markIcon,
      markWide: !!markIcon,
      cards
    });
  }

  async allCurrentPool(e) {
    // “#当前卡池 / #全游戏当前卡池”默认走米游社官方公告汇总。
    e.msg = '#官方当前卡池';
    return this.officialCurrentPool(e);
  }

  async officialVersionPool(e) {
    const m = e.msg.match(/(原神|星铁|崩铁|星穹铁道|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(\d+\.\d+)/);
    if (!m) return false;
    const [, gameLabel, version] = m;
    const game = officialPool.resolveGame(gameLabel);
    if (!game) return false;
    const meta = officialPool.games[game];
    logger.mark(`[xhh][gacha_pool] 命中${meta.name}v${version}官方卡池:`, e.msg);
    // 原神版本官方卡池同样优先本地结构化卡池表，保证 5 星/4 星稳定展示（与星铁一致）。
    if (game === 'gs') {
      const localCards = await this.loadGsLocalCards(version);
      if (localCards.length) {
        // 本地 yaml 缺失四星时，用公告自动解析兜底补齐
        await this.patchGsCardsHardcoded(localCards);
        localCards.forEach((card, i) => {
          card.index = i + 1;
          card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        });
        const markIcon = this.getHeaderSplashFromCards('原神', localCards, GS_MARK_ICON);
        return this.renderPoolImage(e, {
          game: meta.name,
          title: `${meta.name} v${version} 官方卡池`,
          subtitle: '数据来源：米游社公告整理 · 本地卡池库',
          mode: 'official official-game',
          markIcon,
          markWide: !!markIcon,
          cards: localCards
        });
      }
    }
    const { records, error, cache } = await officialPool.fetch(game, { version });
    if (!records.length) return e.reply(`${meta.name} v${version} 未找到米游社官方卡池公告${error ? '：' + error : ''}`);
    const cards = records.map(r => this.officialCard(r, meta.name));
    // 原神官方公告若没解析出 4 星，用本地库同池数据兜底补齐；封面缺失时用搜索接口找回公告 banner
    if (game === 'gs') {
      await this.patchGsOfficialCards(cards);
      await this.attachGsOfficialCovers(cards);
    }
    // 绝区零官方公告若没解析出 UP 信息，用本地卡池库兜底补齐
    else if (game === 'zzz') await this.patchZzzOfficialCards(cards);
    const markIcon = game === 'zzz'
      ? this.getZzzHeaderSplashFromCards(cards, this.getMarkIcon(meta.name))
      : await this.getHeaderSplashByGame(meta.name, records, this.getMarkIcon(meta.name));
    return this.renderPoolImage(e, {
      game: meta.name,
      title: `${meta.name} v${version} 官方卡池`,
      subtitle: `数据来源：米游社公告${cache ? '（缓存）' : ''}`,
      mode: 'official official-game',
      markIcon,
      markWide: !!markIcon,
      cards
    });
  }

  // 定时任务：24 小时自动刷新一次，与 #刷新卡池 等价但不回复消息。
  // 米游社风控冷却期内自动跳过，避免定时任务加重风控；同步结果只写本地库 + 打日志。
  async autoRefreshPools() {
    try {
      if (await redis.get('xhh:gacha_pool:risk_control')) {
        logger.mark('[xhh][gacha_pool] 米游社风控冷却中，跳过本次自动刷新');
        return;
      }
    } catch (_) {}
    try {
      await redis.del(ZZZ_CACHE_KEY);
      await redis.del(ZZZ_CACHE_EXPIRE_KEY);
    } catch (_) {}
    try {
      const results = await officialPool.refreshAll();
      if (results.some(r => r.riskControl)) {
        try {
          await redis.set('xhh:gacha_pool:risk_control', '1', { EX: 30 * 60 });
        } catch (_) {}
        logger.warn('[xhh][gacha_pool] 自动刷新命中米游社风控(1034)，已跳过本地卡池库同步');
        await this.fillBh3TimesOnRisk(results);
        return;
      }
      const lines = await this.syncLocalPoolsFromOfficial(results);
      logger.mark(`[xhh][gacha_pool] 卡池自动刷新完成：${results.map(r => `${r.game} ${r.records.length} 条`).join('，')}` +
        (lines.length ? ` | ${lines.join(' | ')}` : ''));
    } catch (err) {
      logger.error('[xhh][gacha_pool] 卡池自动刷新失败:', err);
    }
  }

  async refreshOfficialPools(e) {
    logger.mark('[xhh][gacha_pool] 刷新米游社官方卡池数据:', e.msg);
    // 风控冷却期内默认拒绝刷新（继续请求会加重风控），但主人或「强制刷新」可绕过，方便随时验证是否已解除
    const force = /强制|立即|force/i.test(String(e?.msg || ''));
    try {
      if (!force && !e?.isMaster && await redis.get('xhh:gacha_pool:risk_control')) {
        return e.reply('米游社接口处于风控冷却期（触发后 10 分钟内不再刷新）；确认要试可用「#强制刷新卡池数据」，卡池查询不受影响。');
      }
    } catch (_) {}
    // 刷新官方公告时，同时清理绝区零本地历史缓存，避免旧缓存遮住新版本数据。
    try {
      await redis.del(ZZZ_CACHE_KEY);
      await redis.del(ZZZ_CACHE_EXPIRE_KEY);
    } catch (_) {}
    const results = await officialPool.refreshAll();
    const lines = results.map(r => {
      const meta = officialPool.games[r.game];
      return `${meta?.name || r.game}：${r.records.length} 条${r.error ? '（' + r.error + '）' : ''}`;
    });
    // 米游社详情接口风控（1034）时公告正文拿不全：本次不做本地库同步，
    // 避免用残缺数据覆盖好数据；并进入冷却，防止继续猛刷加重风控。
    const risk = results.some(r => r.riskControl);
    if (risk) {
      try {
        await redis.set('xhh:gacha_pool:risk_control', '1', { EX: 10 * 60 });
      } catch (_) {}
      // 详情接口被风控时同步整体跳过，但崩三的开放时间走「瞬间搜索」接口（不受影响），单独补录一次
      const bh3Note = await this.fillBh3TimesOnRisk(results);
      return e.reply('米游社官方卡池数据已刷新：\n' + lines.join('\n') + bh3Note +
        '\n\n【注意】米游社详情接口命中风控(1034)，本次已跳过本地卡池库同步（避免写入残缺数据），10 分钟内请不要重复刷新；确认已解除可用「#强制刷新卡池数据」，查询指令不受影响。');
    }
    // 未命中风控：清掉冷却标记，后续刷新恢复正常
    try {
      await redis.del('xhh:gacha_pool:risk_control');
    } catch (_) {}
    // 刷新成功后自动同步本地卡池库，避免每个版本都要手动维护 gslogs.yaml / sr_logs.yaml。
    const syncLines = await this.syncLocalPoolsFromOfficial(results);
    const syncText = syncLines.length ? '\n\n【本地卡池库自动同步】\n' + syncLines.join('\n') : '';
    return e.reply('米游社官方卡池数据已刷新：\n' + lines.join('\n') + syncText);
  }

  // —— 本地卡池库自动同步 ——
  // 每次 #刷新卡池 拉取官方公告成功后，自动把当前版本卡池数据写入本地库并推进版本号。
  // 官方公告解析不到关键信息时跳过（保持本地库原样，可人工修正），避免写入脏数据。

  gsLocalShortName(name = '') {
    return String(name || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/^.+·(?=[\u4e00-\u9fa5])/, '')
      .replace(/[「」『』]/g, '')
      .trim();
  }

  srLocalName(name = '') {
    return String(name || '').replace(/[（(].*?[）)]/g, '').trim();
  }

  srLocalCone(name = '') {
    const m = String(name || '').match(/^(.+?)[（(]([^）)]+)[）)]$/);
    if (m) return `${m[2].split(/[·•]/)[0]}/${m[1].trim()}`;
    return String(name || '').trim();
  }

  fmtTs(ts = 0, hhmm = '') {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
    return hhmm ? `${date} ${hhmm}` : date;
  }

  // 解析「X.X版本活动祈愿预告」公告正文里的真实祈愿起止时间。
  // 例：「本期活动祈愿时间为 2026/09/01 18:00 ~ 2026/09/22 14:59 。」
  // 返回 '2026/09/01 18:00~2026/09/22 14:59'；解析失败返回空串（调用方回退到估算）。
  parseGsPreviewTime(text = '') {
    const raw = String(text || '');
    // 「X.X版本更新后 ~ 2026/10/13 17:59」：开始端无具体日期（版本更新前发布的预告）。
    // 保留「版本更新后」占位——parseGsDateKey 解析不到开始时间，当前卡池不会误匹配未开池的预录条目。
    const rel = raw.match(/祈愿时间[\s\S]{0,300}?版本更新后[^0-9]{0,20}?(\d{4}\/\d{1,2}\/\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    if (rel) {
      const nd = rel[1].split('/').map((v, i) => (i === 0 ? v : String(v).padStart(2, '0'))).join('/');
      return `版本更新后~${nd} ${rel[2] ? rel[2].slice(0, 5) : '17:59'}`;
    }
    const seg = raw.match(/活动祈愿时间[为:：]?([^。\n]{0,120})/)?.[1] || '';
    if (!seg) return '';
    const times = [...seg.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/g)];
    if (times.length < 2) return '';
    const normDate = m => `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
    const start = normDate(times[0]);
    const end = normDate(times[times.length - 1]);
    // 开始端写「版本更新后」缺时分时用 18:00 兜底；结束端缺时分用 14:59 兜底。
    const startTime = times[0][4] ? String(times[0][4]).slice(0, 5) : '18:00';
    const endTime = times[times.length - 1][4] ? String(times[times.length - 1][4]).slice(0, 5) : '14:59';
    return `${start} ${startTime}~${end} ${endTime}`;
  }

  // 调官方号搜索接口取某个官方号发的帖子列表
  async mysSearchPosts(uid = '', keyword = '') {
    const url = `${MYS_SEARCH_API}?keyword=${encodeURIComponent(keyword)}&uid=${uid}&size=20&offset=0&sort_type=2`;
    const res = await fetch(url, {
      headers: { Referer: 'https://www.miyoushe.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json();
    return (json?.data?.list || []).map(it => it?.post?.post || {});
  }

  // 通用取图：游戏 + 标题关键词 + 图片索引数组 → 图片 URL 数组
  async mysSearchImages(game = '', keyword = '', indexes = [0]) {
    const uid = MYS_OFFICIAL_UID[game];
    if (!uid || !keyword) return [];
    const key = `${game}|${keyword}|${indexes.join(',')}`;
    if (MYS_COVER_CACHE.has(key)) return MYS_COVER_CACHE.get(key);
    let out = [];
    try {
      const posts = await this.mysSearchPosts(uid, keyword);
      const re = MYS_TITLE_MATCH[game] || /./;
      // 命中多条时优先选「标题里就带这个关键词」的那条：
      // 否则同版本的两个 UP（如 维琳娜/叶瞬光）会都取到同一张公告图，崩三还可能取到不相干的情报帖
      const cands = posts
        .filter(p => re.test(String(p.subject || '')) && ((p.images || []).length || p.cover?.url))
        .map(p => ({ p, hit: String(p.subject || '').includes(keyword) ? 1 : 0 }))
        .sort((a, b) => b.hit - a.hit);
      const hit = cands[0]?.p;
      if (hit) {
        const imgs = [hit.cover?.url || '', ...(hit.images || [])].filter(Boolean).slice(0, MYS_MAX_IMAGES);
        out = indexes.map(i => imgs[i]).filter(Boolean);
        if (!out.length && imgs.length) out = [imgs[0]];
      }
    } catch (err) {
      logger.warn(`[xhh][gacha_pool] 米游社取图失败（${game}/${keyword}）:`, err);
    }
    MYS_COVER_CACHE.set(key, out);
    return out;
  }

  // 用「官方号搜索接口」按版本号/UP名找回已滚出 getNewsList 列表的旧公告封面。
  // 公告列表只保留最新几十条，上半那种早过期的公告列表里翻不到，但搜索接口仍能命中
  // （如「4.5版本活动跃迁（其一）」就有封面 + 8 张正文图）。
  async srSearchPoolImages(ver = '', upNames = [], weapon = false) {
    const verRaw = String(ver || '');
    const isCollab = /^联动/.test(verRaw);
    const version = verRaw.replace(/联动|上半|下半/g, '').trim();
    const phase = /下半/.test(verRaw) ? '其二' : (/上半/.test(verRaw) ? '其一' : '');
    const names = (upNames || []).filter(Boolean);
    const key = `${verRaw}|${weapon ? 1 : 0}|${names[0] || ''}`;
    if (SR_COVER_CACHE.has(key)) return SR_COVER_CACHE.get(key);
    const keywords = isCollab
      ? ['联动跃迁']
      : [...(version ? [`${version}版本活动跃迁`] : []), ...(names[0] ? [names[0]] : [])];
    let result = '';
    for (const kw of keywords) {
      let list = [];
      try {
        list = await this.mysSearchPosts(MYS_OFFICIAL_UID.sr, kw);
      } catch (err) {
        logger.warn(`[xhh][gacha_pool] 星铁封面搜索失败（${kw}）:`, err);
        continue;
      }
      let best = null;
      let bestScore = -1;
      for (const p of list) {
        const subject = String(p.subject || '');
        if (!/跃迁/.test(subject)) continue;
        const imgs = [p.cover?.url || '', ...(p.images || [])].filter(Boolean);
        if (!imgs.length) continue;
        let score = 0;
        if (version && subject.includes(version)) score += 10;
        if (phase && subject.includes(phase)) score += 8;
        if (isCollab && /联动/.test(subject)) score += 6;
        for (const n of names) if (n && subject.includes(n)) score += 3;
        if (score > bestScore) {
          best = imgs;
          bestScore = score;
        }
      }
      if (best) {
        result = weapon ? (best[1] || best[0]) : best[0];
        break;
      }
    }
    MYS_COVER_CACHE.set(key, result);
    return result;
  }

  async syncSrImagesFromOfficial(records = []) {
    // 用官方公告列表为本地已有条目补背景图，即使正文为空也能更新图片。
    const history = this.loadSrPoolHistory();
    if (!Array.isArray(history)) return false;
    let changed = false;
    let searched = 0;
    for (const item of history) {
      if ((item.imgs || []).filter(Boolean).length) continue;
      const roleImg = this.getSrOfficialPoolImage(item, false, records);
      const weaponImg = this.getSrOfficialPoolImage(item, true, records);
      let imgs = [...new Set([roleImg, weaponImg].filter(Boolean))];
      // 公告列表里翻不到（旧版本/过期池）时，改用官方号搜索接口找回封面
      if (!imgs.length && searched < 12) {
        searched++;
        const found = await this.srSearchPoolImages(item.ver, item.js_five || [], false);
        if (found) imgs = [found];
      }
      if (imgs.length) {
        item.imgs = imgs;
        changed = true;
      }
    }
    if (!changed) return false;
    try {
      fs.writeFileSync(SR_POOL_HISTORY_YAML_PATH, YAML.stringify(history), 'utf-8');
      return true;
    } catch (err) {
      logger.error('[xhh][gacha_pool] sr_logs.yaml 背景图补写失败:', err);
      return false;
    }
  }

  async syncSrLocalFromOfficial(records = []) {
    // 优先用 Bwiki 跃迁页的准确「版本+时间区间+S级」合并进本地库（米游社公告解析易失败）。
    const bwiki = await this.fetchSrPoolHistoryFromBwiki();
    if (Array.isArray(bwiki) && bwiki.length) {
      try {
        const local = Array.isArray(this.loadSrPoolHistory()) ? this.loadSrPoolHistory() : [];
        // 同一版本可能有多期（上半/下半/复刻/联动），只用 ver 做键会让它们互相覆盖数据
        // （如 4.4上半 的复刻池被联动池的「长期」时间覆盖）。改用「版本 + 时间区间」做主键，
        // 再用 UP 名交集做二次匹配；联动（长期）只匹配本地已有的 联动* 条目。
        const periodKey = e => `${e.ver || ''}||${String(e.time || '').split('~')[1]?.trim() || ''}||${String(e.time || '').split('~')[0]?.trim() || ''}`;
        const upsOf = e => [...(e.js_five || []), ...(e.gz_five || [])].map(v => String(v).split('/').pop());
        const byKey = new Map(local.map(e => [periodKey(e), e]));
        let added = 0, updated = 0;
        for (const b0 of bwiki) {
          const b = { ...b0 };
          const isCollab = /长期/.test(b.time || '');
          const bUps = upsOf(b);
          // Bwiki 的联动池挂在普通版本号下面（如 3.4上半 / 4.4上半）且时间为 长期：
          // 直接按 Bwiki 的版本号新增会让「3.4上半 长期」这类条目永远赖在当前卡池里。
          // 统一归到本地的「联动X.0」标签下，已存在同 UP 的联动条目就合并进去。
          if (isCollab && !/^联动/.test(String(b.ver || ''))) {
            const existCollab = local.find(v => /^联动/.test(String(v.ver || '')) && upsOf(v).some(n => bUps.includes(n)));
            b.ver = existCollab?.ver || '联动2.0';
          }
          let ex = byKey.get(periodKey(b));
          if (!ex && isCollab) {
            ex = local.find(v => /^联动/.test(String(v.ver || '')) && upsOf(v).some(n => bUps.includes(n)));
          }
          if (!ex) {
            ex = local.find(v => v.ver === b.ver && upsOf(v).some(n => bUps.includes(n)));
          }
          if (!ex) {
            // 长线/永久联动（结束年超过当前+1 年）按 长期 处理，避免具体未来日期抢占"最新"。
            const addEnd = (b.time || '').split('~')[1]?.trim() || '';
            const addYear = new Date(addEnd).getFullYear();
            const addFar = !/长期/.test(b.time || '') && !Number.isNaN(addYear) && addYear > new Date().getFullYear() + 1;
            ex = { ver: b.ver, time: addFar ? '长期' : b.time, js_five: b.js_five, js_four: b.js_four, gz_five: b.gz_five, gz_four: b.gz_four, imgs: [] };
            local.unshift(ex);
            byKey.set(periodKey(ex), ex);
            added++;
          } else {
            // 只有真的改了才算「修正」：先快照，改完比对，避免每次刷新都报一堆修正数
            const before = JSON.stringify(ex);
            // 已标记为 长期 的条目不被 Bwiki 的具体时间覆盖；同时拒绝结束年超过当前+1 年的未来时间。
            const curIsLong = /长期/.test(ex.time || '');
            const candEnd = (b.time || '').split('~')[1]?.trim() || '';
            const curEnd = (ex.time || '').split('~')[1]?.trim() || '';
            const candYear = new Date(candEnd).getFullYear();
            const farFuture = !/长期/.test(b.time || '') && !Number.isNaN(candYear) && candYear > new Date().getFullYear() + 1;
            // 只有匹配到的是联动条目（本身就是长期）时才允许写「长期」时间，
            // 否则联动池的 长期 会把常规池的具体结束时间顶掉（4.4上半被改成 07/24 ~ 长期）。
            const allowLong = isCollab && /^联动/.test(String(ex.ver || ''));
            if (b.time && !curIsLong && !farFuture && (allowLong || (/长期/.test(b.time) === allowLong)) && (!ex.time || new Date(candEnd) > new Date(curEnd || 0))) ex.time = b.time;
            if (!ex.js_five?.length && b.js_five?.length) ex.js_five = b.js_five;
            if (!ex.gz_five?.length && b.gz_five?.length) ex.gz_five = b.gz_five;
            if (!ex.js_four?.length && b.js_four?.length) ex.js_four = b.js_four;
            if (!ex.gz_four?.length && b.gz_four?.length) ex.gz_four = b.gz_four;
            if (JSON.stringify(ex) !== before) updated++;
          }
        }
        // 结束时间倒序；「长期」/无法解析的时间戳视为最远，避免 new Date('长期') = NaN 导致排序错乱
        const endTime = e => {
          const t = String(e?.time || '').split('~')[1]?.trim() || '';
          const n = new Date(t).getTime();
          return /长期/.test(t) || !t || Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
        };
        local.sort((a, b) => endTime(b) - endTime(a));
        fs.writeFileSync(SR_POOL_HISTORY_YAML_PATH, YAML.stringify(local), 'utf-8');
        // 联动池长期开放（结束时间最远），不能算「最新版本」；排除后再取最新。
        const latest = local.find(v => !/^联动/.test(String(v?.ver || ''))) || local[0];
        await this.syncSrImagesFromOfficial(records); // 仍尝试用官方公告补背景图
        logger.mark(`[xhh][gacha_pool] 星铁 Bwiki 同步明细：新增 ${added} / 修正 ${updated}`);
        return `星穹铁道：本地库已同步 Bwiki 跃迁（最新 v${latest?.ver || ''}）`;
      } catch (err) {
        logger.warn('[xhh][gacha_pool] 星铁 Bwiki 合并失败，卡池数据保持现状:', err);
      }
    }
    // 卡池数据只认 wiki（Bwiki）：Bwiki 抓不到时不用米游社公告写条目/时间/UP，仅用公告补封面。
    const imgsSynced = await this.syncSrImagesFromOfficial(records);
    return imgsSynced
      ? '星穹铁道：Bwiki 抓取失败，卡池数据保持现状（已用米游社补封面）'
      : '星穹铁道：Bwiki 抓取失败，卡池数据保持现状';
  }

  async syncGsLocalFromOfficial(records = []) {
    // 优先用 Bwiki 往期祈愿页的准确「版本+时间区间+S级」补齐本地库（米游社公告解析易失败）。
    const bwiki = await this.fetchYsPoolHistoryFromBwiki();
    if (Array.isArray(bwiki) && bwiki.length) {
      try {
        const data = this.loadGsPoolHistory() || {};
        if (!data.date) data.date = {};
        if (!data.imgs) data.imgs = {};
        const sorted = [...bwiki].sort((a, b) => new Date(b.time.split('~')[1]) - new Date(a.time.split('~')[1]));
        const latest = sorted[0];
        // Bwiki 数据视为权威：解析成 ver → lines，按结束时间倒序保证新版本条目排在最前。
        const bwikiEntries = [];
        for (const b of sorted) {
          // 本地行格式是「5星,4星,4星,4星」：Bwiki 的 4 星角色（charA）是整期共用的，
          // 必须拼到每个角色行后面，否则同步后四星角色会整期丢失。
          const fourRoles = (b.charA || []).map(c => this.gsLocalShortName(c)).filter(Boolean);
          const roleLines = b.charS.map(c => this.gsLocalShortName(c)).filter(Boolean)
            .map(name => [name, ...fourRoles].join(','));
          const wpnLine = [...b.wpnS, ...b.wpnA].map(w => this.gsLocalShortName(w)).filter(Boolean).join(',');
          let lines = [...roleLines, wpnLine].filter(Boolean);
          // Bwiki 该期还没填 4 星（如刚开的新期）时，沿用本地已整理的 4 星，避免刷新把四星抹掉
          if (!fourRoles.length) {
            const localKey = Object.keys(data.date).find(k => k.startsWith(`【${b.ver}】`));
            const localLines = localKey ? (data.date[localKey] || []).map(String) : [];
            if (localLines.length) {
              lines = lines.map((line, i) => {
                if (i >= roleLines.length) return line;
                const oldFour = (localLines[i] || '').split(',').slice(1).join(',');
                return oldFour ? `${line},${oldFour}` : line;
              });
            }
          }
          if (lines.length) bwikiEntries.push([`【${b.ver}】${b.time}`, lines]);
        }
        const bwikiKeySet = new Set(bwikiEntries.map(([k]) => k));
        const coveredVers = new Set([...bwikiKeySet].map(k => k.match(/^【([^】]+)】/)?.[1]).filter(Boolean));
        const beforeVers = new Set(Object.keys(data.date).map(k => k.match(/^【([^】]+)】/)?.[1]).filter(Boolean));
        let added = 0, updated = 0;
        // 只统计真正发生变化的版本：与本地已有条目逐条比对，
        // 避免每次刷新都把所有 Bwiki 覆盖到的版本算成「修正」（曾天天显示修正 107 个）。
        const beforeByVer = new Map();
        for (const [k, v] of Object.entries(data.date)) {
          const ver = k.match(/^【([^】]+)】/)?.[1];
          if (ver && !beforeByVer.has(ver)) beforeByVer.set(ver, JSON.stringify(v));
        }
        for (const [k, lines] of bwikiEntries) {
          const ver = k.match(/^【([^】]+)】/)?.[1] || '';
          const prev = beforeByVer.get(ver);
          if (prev === undefined) added++;
          else if (prev !== JSON.stringify(lines)) updated++;
        }
        // 同版本条目以 Bwiki 为准覆盖：修复早期公告同步把「上半」误标成「下半」、
        // 或预录占位时间残留后，被 ver 前缀去重规则固化的问题；Bwiki 未覆盖的本地条目原样保留。
        const nextDate = {};
        for (const [k, v] of bwikiEntries) nextDate[k] = v;
        for (const [k, v] of Object.entries(data.date)) {
          const ver = k.match(/^【([^】]+)】/)?.[1];
          if (ver && coveredVers.has(ver)) {
            if (!bwikiKeySet.has(k)) delete data.imgs?.[`【${ver}】`];
            continue;
          }
          nextDate[k] = v;
        }
        data.date = nextDate;
        const latestNum = Number(String(latest.ver || '').replace(/[^0-9.]/g, ''));
        if (latestNum && latestNum > Number(CURRENT_VERSION.gs || 0)) CURRENT_VERSION.gs = String(latestNum);
        fs.writeFileSync(GS_POOL_HISTORY_YAML_PATH, YAML.stringify(data), 'utf-8');
        logger.mark(`[xhh][gacha_pool] 原神 Bwiki 同步明细：新增 ${added} / 修正 ${updated}`);
        // 封面统一走米游社：数据以 Bwiki 为准，图片仍用官方公告封面补录
        await this.syncGsImagesFromOfficial(records);
        return `原神：本地库已同步 Bwiki 往期祈愿（最新 v${latest?.ver || ''}）`;
      } catch (err) {
        logger.warn('[xhh][gacha_pool] 原神 Bwiki 合并失败，卡池数据保持现状:', err);
      }
    }
    // 卡池数据只认 wiki（Bwiki）：Bwiki 抓不到时不用米游社公告写条目/时间/UP，仅用公告补封面。
    const imgsSynced = await this.syncGsImagesFromOfficial(records);
    return imgsSynced
      ? '原神：Bwiki 抓取失败，卡池数据保持现状（已用米游社补封面）'
      : '原神：Bwiki 抓取失败，卡池数据保持现状';
  }

  // imgs 段按版本号倒序输出（新期在前）：原写法 { ...旧值, 新键 } 会把新补的期追加到最末尾，
  // 人工查看/对比时顺序是乱的。取图只靠 key，顺序本身不影响功能。
  sortGsImgsByVersion(imgs = {}) {
    const score = k => {
      const v = String(k).match(/【([^】]+)】/)?.[1] || '';
      const m = v.match(/(\d+)\.(\d+)/);
      if (!m) return -Infinity;
      const phase = /下半/.test(v) ? 1 : (/中间/.test(v) ? 0.5 : 0);
      return Number(m[1]) * 100 + Number(m[2]) + phase;
    };
    return Object.fromEntries(Object.entries(imgs || {}).sort((a, b) => score(b[0]) - score(a[0])));
  }

  // 期签名：该期各池子首位 UP 名拼接（如「薇斯纳/沃雅妮莎/蝶变」）。
  gsPoolSignature(pools = []) {
    return (pools || []).map(line => String(line).split(',')[0]?.trim()).filter(Boolean).join('/');
  }

  // 已有封面是否和当前期对不上：手动补错、跨期公告误写、旧库遗留都会导致签名不一致，
  // 此时必须覆盖，否则「已有 N 张就跳过」的保护会把错图永久锁住。
  gsImgsStale(data, key, pools = []) {
    const sig = this.gsPoolSignature(pools);
    if (!sig) return true;
    const stored = data.imgs_src?.[key] || '';
    return !stored || stored !== sig;
  }

  // 封面统一走米游社：只写 data.imgs（图片），绝不改 data.date（卡池数据只由 Bwiki 维护）。
  async syncGsImagesFromOfficial(records = []) {
    try {
      const data = this.loadGsPoolHistory();
      if (!data?.date || !Object.keys(data.date).length) return false;
      const gacha = (records || [])
        .filter(r => /概率UP/.test(r.title || '') && /「.+」/.test(r.title || ''))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!gacha.length) return await this.syncGsImagesFromSearch(data);
      // 只取最新发布的一批公告（同一期祈愿发布间隔很短），避免历史卡池公告干扰
      const latestTs = gacha[0].createdAt || 0;
      const batch = gacha.filter(r => latestTs > 0 && Math.abs((r.createdAt || 0) - latestTs) < 86400000);
      const current = batch.length ? batch : gacha;
      const charPools = [];
      const wpnPools = [];
      for (const r of current) {
        const title = r.title || '';
        if (/集录|混池|溯光|常驻|新手|祈愿预告|活动祈愿预告/.test(title)) continue;
        if (/神铸赋形|武器祈愿|武器活动祈愿/.test(title) || /^祈愿：/.test(title)) wpnPools.push(r);
        else if (/祈愿：「[^」]+」/.test(title)) charPools.push(r);
      }
      const imgs = [];
      for (const r of charPools.slice(0, 2)) imgs.push(r.images?.[0] || r.cover || '');
      if (wpnPools[0]) imgs.push(wpnPools[0].images?.[0] || wpnPools[0].cover || '');
      const list = imgs.filter(Boolean);
      if (!list.length) return false;
      // 目标版本号必须与渲染时读到的一致：直接取「当前卡池」解析出的 version。
      // 旧逻辑取 date 首条 / 自行按时间匹配，在 date 键序乱序、上下半区间重叠时会挂错 key
      // （如当前期是 7.1下半，图却写进【7.1上半】，导致当前卡池永远取不到公告图）。
      const curCards = await this.loadGsLocalCards('current');
      const ver = curCards[0]?.version
        || Object.keys(data.date)[0]?.match(/^【([^】]+)】/)?.[1] || '';
      if (!ver) return false;
      const key = `【${ver}】`;
      const firstKey = Object.keys(data.date).find(k => k.startsWith(`【${ver}】`)) || Object.keys(data.date)[0] || '';
      const pools = data.date[firstKey] || [];
      const stale = this.gsImgsStale(data, key, pools);
      if ((data.imgs?.[key] || []).filter(Boolean).length >= 3 && !stale) return false;
      data.imgs = this.sortGsImgsByVersion({ ...(data.imgs || {}), [key]: list });
      data.imgs_src = { ...(data.imgs_src || {}), [key]: this.gsPoolSignature(pools) };
      fs.writeFileSync(GS_POOL_HISTORY_YAML_PATH, YAML.stringify(data), 'utf-8');
      logger.mark(`[xhh][gacha_pool] 原神 ${key} 已用米游社公告补封面 ${list.length} 张${stale ? '（覆盖旧封面）' : ''}`);
      return true;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 原神封面补录失败:', err?.message || err);
      return false;
    }
  }

  // 米游社列表里没有祈愿公告时（常见），退回搜索接口按当前期 UP 名补图，仍写入 data.imgs 持久化。
  // 只写图片，不改卡池数据（与 syncGsImagesFromOfficial 同一约定）。
  async syncGsImagesFromSearch(data) {
    try {
      // 与渲染保持一致：用「当前卡池」解析出的 version 定位 date 条目
      const curCards = await this.loadGsLocalCards('current');
      const ver = curCards[0]?.version
        || Object.keys(data.date)[0]?.match(/^【([^】]+)】/)?.[1] || '';
      if (!ver) return false;
      const firstKey = Object.keys(data.date).find(k => k.startsWith(`【${ver}】`)) || Object.keys(data.date)[0] || '';
      const key = `【${ver}】`;
      const pools = data.date[firstKey] || [];
      const stale = this.gsImgsStale(data, key, pools);
      if ((data.imgs?.[key] || []).filter(Boolean).length >= 3 && !stale) return false;
      const cards = [];
      for (const row of pools.slice(0, 4)) {
        const arr = String(row || '').split(',').map(v => v.trim()).filter(Boolean);
        if (!arr.length) continue;
        const weapon = this.isGsWeaponPool(arr);
        cards.push({ version: ver, title: '', type: '原神', weapon, s: arr.join('/'), a: '', img: '', imgFallback: true });
      }
      if (!cards.length) return false;
      await this.attachGsOfficialCovers(cards, true);
      const list = cards.map(c => c.img).filter(Boolean);
      if (!list.length) return false;
      data.imgs = this.sortGsImgsByVersion({ ...(data.imgs || {}), [key]: list });
      data.imgs_src = { ...(data.imgs_src || {}), [key]: this.gsPoolSignature(pools) };
      fs.writeFileSync(GS_POOL_HISTORY_YAML_PATH, YAML.stringify(data), 'utf-8');
      logger.mark(`[xhh][gacha_pool] 原神 ${key} 列表无祈愿公告，已用搜索接口补封面 ${list.length} 张${stale ? '（覆盖旧封面）' : ''}`);
      return true;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 原神搜索补封面失败:', err?.message || err);
      return false;
    }
  }

  // 预录条目修复：旧版本同步曾把开始时间错误估算成「公告发布时间」（版本上线前就落在过去），
  // 导致预录条目被当成当前卡池。这里把开始时间统一改回「版本更新后」占位（不参与当前卡池时间匹配）。
  repairGsPreviewEntry(data, version, phase, records = []) {
    const latestKey = Object.keys(data.date)[0] || '';
    const { start } = this.parseGsDateKey(latestKey);
    let timeRange = '';
    const previews = records
      .filter(r => /活动祈愿预告/.test(r.title || ''))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (previews.length) timeRange = this.parseGsPreviewTime(previews[0].contentText || '');
    const endPart = latestKey.replace(/^【.*?】/, '').split('~')[1]?.trim() || '';
    if (!timeRange) timeRange = `版本更新后~${endPart || this.fmtTs(Date.now() + 21 * 86400000, '15:00')}`;
    const fixedKey = `【${version}${phase}】${timeRange}`;
    const note = `原神：v${version}${phase} 已预录（${version}版本更新后生效，当前仍为 v${CURRENT_VERSION.gs}）`;
    // 开始时间未过期（占位/未来时间）且 key 已一致时无需重写
    if (fixedKey === latestKey || (start && start > new Date())) return note;
    try {
      const nextDate = { [fixedKey]: data.date[latestKey] };
      for (const [k, v] of Object.entries(data.date)) {
        if (k !== latestKey) nextDate[k] = v;
      }
      fs.writeFileSync(GS_POOL_HISTORY_YAML_PATH, YAML.stringify({ date: nextDate, imgs: data.imgs || {}, imgs_src: data.imgs_src || {} }), 'utf-8');
      return `原神：已修正 v${version}${phase} 预录时间（${version}版本更新后生效，当前仍为 v${CURRENT_VERSION.gs}）`;
    } catch (err) {
      logger.error('[xhh][gacha_pool] gslogs.yaml 预录时间修正失败:', err);
      return note;
    }
  }

  // —— 绝区零本地同步 ——
  // 绝区零「版本+时间区间」在米游社公告里不可靠，但 Bwiki「调频」页面有结构化的时间/版本/S级列。
  // 参考社区插件做法：扒 wikitable，按「时间/版本/S级代理人|S级音擎|S级邦布」提取每个卡池，写入本地库。
  // 数据形状与 normalizeZzzData 保持一致：{ title, type:'角色'|'武器'|'邦布', version, timer, s, a }。
  async fetchZzzPoolHistoryFromBwiki() {
    const cacheKey = 'xhh:zzz:bwiki:history:v1';
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
    try {
      const res = await fetch(ZZZ_BWIKI_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const pools = this.parseZzzBwikiHtml(html);
      if (Array.isArray(pools) && pools.length) {
        try { await redis.set(cacheKey, JSON.stringify(pools), { EX: 2 * 60 * 60 }); } catch (_) {}
        return pools;
      }
      return null;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 绝区零 Bwiki 调频抓取失败:', err);
      return null;
    }
  }

  parseZzzBwikiHtml(html = '') {
    const tables = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi) || [];
    const META = ['时间', '版本', 'S级代理人', 'A级代理人', 'S级音擎', 'A级音擎', 'S级邦布', 'A级邦布', 'B级音擎', 'B级代理人'];
    const GEN = ['独家频段', '音擎频段', '邦布频段'];
    const cleanName = s => String(s || '').replace(/（页面不存在）|（待补全）|\(页面不存在\)/g, '').replace(/[「」『』]/g, '').trim();
    const out = [];
    const seen = new Set();
    for (const t of tables) {
      const ths = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (!ths.some(h => /时间/.test(h)) || !ths.some(h => /版本/.test(h))) continue;
      const timer = (t.match(/<th[^>]*>\s*时间\s*<\/th>\s*<td>([\s\S]*?)<\/td>/i) || [, ''])[1]
        .replace(/<[^>]+>/g, '').replace(/[-—]/g, '~').replace(/\s+/g, ' ').trim();
      if (!timer.includes('~')) continue;
      const version = (t.match(/<th[^>]*>\s*版本\s*<\/th>\s*<td>([\s\S]*?)<\/td>/i) || [, ''])[1].replace(/<[^>]+>/g, '').trim() || '未知版本';
      let title = ths.find(h => !META.includes(h) && !GEN.includes(h) && /期/.test(h))
        || ths.find(h => !META.includes(h) && !GEN.includes(h))
        || ths.find(h => !META.includes(h)) || '';
      title = cleanName(title);
      let type = '角色';
      if (/音擎|武器/.test(title) || ths.some(h => /音擎/.test(h) && /S级/.test(h))) type = '武器';
      else if (/邦布/.test(title)) type = '邦布';
      const lab = type === '武器' ? 'S级音擎' : type === '邦布' ? 'S级邦布' : 'S级代理人';
      const grab = L => {
        const m = t.match(new RegExp('<th[^>]*>\\s*' + L + '\\s*<\\/th>\\s*<td>([\\s\\S]*?)<\\/td>', 'i'));
        if (!m) return [];
        let names = [...m[1].matchAll(/title="([^"]+)"/g)].map(a => cleanName(a[1]));
        if (!names.length) names = [...m[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(a => cleanName(a[1]));
        return names.filter(Boolean);
      };
      const sNames = grab(lab);
      if (!sNames.length) continue;
      // 关键点：Bwiki 调频页同时给出 A 级列，必须把 A 级陪跑也抓下来，否则本地库写入后 A 级整列丢失。
      const labA = type === '武器' ? 'A级音擎' : type === '邦布' ? 'A级邦布' : 'A级代理人';
      const aNames = grab(labA);
      const key = `${version}|${title}|${timer}|${sNames[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, type, version, timer, s: sNames[0], a: aNames });
    }
    return out;
  }

  // 绝区零条目「实质差异」比对：只比对受管字段，并把时间归一到「年月日 时:分」（忽略秒/空格/波浪线写法），
  // A 级列表忽略顺序。返回发生变化的字段名（空数组 = 无实质变化）。
  zzzPoolDiff(base = {}, entry = {}) {
    const normTimer = t => {
      const parts = [...String(t || '').matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2})/g)]
        .map(m => `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')} ${String(m[4]).padStart(2, '0')}:${m[5]}`);
      return parts.length ? parts.join('~') : String(t || '').replace(/\s+/g, '');
    };
    const normArr = v => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]))
      .map(x => String(x).trim()).filter(Boolean).sort();
    const str = v => String(v ?? '').trim();
    const fields = { title: str, type: str, version: str, timer: normTimer, s: str, a: normArr };
    return Object.keys(fields).filter(k => JSON.stringify(fields[k](base[k])) !== JSON.stringify(fields[k](entry[k])));
  }

  async syncZzzLocalFromOfficial(records = []) {
    try {
      // 优先用 Bwiki 调频页拉真实「版本+时间区间」写入本地库；失败则退回重建蜘蛛缓存。
      const bwiki = await this.fetchZzzPoolHistoryFromBwiki();
      if (Array.isArray(bwiki) && bwiki.length) {
        // 合并而非整体覆盖：保留 Bwiki 未覆盖到的人工校订条目，同时用 Bwiki 的 A 级列补回被冲掉的 A 级。
        const keyOf = p => `${p.version || '-'}|${p.type || '-'}|${p.title || ''}`;
        const bwikiMap = new Map(bwiki.map(p => [keyOf(p), p]));
        const curated = this.loadZzzLocalPools();
        // 同一「版本|类型|标题」在库里/Bwiki 里都可能有重复行，所以要按 key 收集多个候选，
        // 逐行比对时会永远和“另一行”不同 → 每次刷新都报修正。改为：任一候选已匹配即不算改动。
        const curatedByKey = new Map();
        for (const c of curated) {
          const k = keyOf(c);
          if (!curatedByKey.has(k)) curatedByKey.set(k, []);
          curatedByKey.get(k).push(c);
        }
        const merged = [];
        let added = 0, updated = 0;
        const samples = [];
        for (const p of bwiki) {
          const cands = curatedByKey.get(keyOf(p)) || [];
          const base = cands[0];
          const a = Array.isArray(p.a) && p.a.length ? p.a : (Array.isArray(base?.a) ? base.a : []);
          const entry = { ...(base || {}), ...p, a };
          merged.push(entry);
          // 与其它游戏统一口径：只有「受管字段」真的变了才算修正。
          // 不能整对象比 JSON：键顺序、img 之类附加字段的差异也会被判成改动，
          // 于是每次刷新都把同一批条目报成「修正」（曾天天报「修正 55」）。
          if (!cands.length) added++;
          else if (!cands.some(c => this.zzzPoolDiff(c, entry).length === 0)) {
            updated++;
            if (samples.length < 2) samples.push(`${base.title || base.s || ''}（${this.zzzPoolDiff(base, entry).join('、')}）`);
          }
        }
        for (const c of curated) {
          if (!bwikiMap.has(keyOf(c))) merged.push(c);
        }
        const sorted = [...merged].sort((a, b) => this.poolEndStamp(b) - this.poolEndStamp(a));
        const latest = sorted[0];
        try {
          fs.writeFileSync(ZZZ_POOL_HISTORY_YAML_PATH, YAML.stringify(merged), 'utf-8');
        } catch (err) {
          logger.warn('[xhh][gacha_pool] 绝区零本地库写入失败:', err);
        }
        logger.mark(`[xhh][gacha_pool] 绝区零 Bwiki 同步明细：新增 ${added} / 修正 ${updated}` +
          (samples.length ? `（示例：${samples.join('；')}）` : ''));
        return `绝区零：本地库已同步 Bwiki 调频（最新 v${latest.version}）`;
      }
      // 卡池数据只认 wiki（Bwiki）：抓不到时保持本地库现状，不再写第三方（蜘蛛）缓存数据
      return '绝区零：Bwiki 抓取失败，卡池数据保持现状';
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 绝区零同步失败:', err);
      return '绝区零：同步失败，下次查询时自动重建';
    }
  }

  // —— 星穹铁道 / 原神：Bwiki 跃迁 / 往期祈愿（版本+时间区间+S级，结构化可靠）——
  // 与绝区零同理：米游社公告解析易失败，Bwiki 调频/跃迁/往期祈愿页面表格给出带可靠版本号+时间区间的卡池历史。
  _bwikiCleanName(s) {
    return String(s || '').replace(/（页面不存在）|（待补全）|\(页面不存在\)/g, '').replace(/[「」『』]/g, '').trim();
  }
  _bwikiCellNames(cell = '') {
    let names = [...String(cell).matchAll(/title="([^"]+)"/g)].map(a => this._bwikiCleanName(a[1]));
    if (!names.length) names = [...String(cell).matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map(a => this._bwikiCleanName(a[1]));
    // wiki 的图片/文件链接（如「文件:真珠.png」）会被当成角色名，必须剔除
    return [...new Set(names)].filter(Boolean).filter(n => !/^(文件|File|image|Image)[:：]/i.test(n));
  }
  _bwikiTables(html = '') {
    return html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi) || [];
  }
  _bwikiThs(table) {
    return [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }
  _bwikiCell(table, label) {
    const m = table.match(new RegExp('<th[^>]*>\\s*' + label + '\\s*<\\/th>\\s*<td>([\\s\\S]*?)<\\/td>', 'i'));
    return m ? m[1] : '';
  }
  _bwikiTime(table) {
    return this._bwikiCleanName(this._bwikiCell(table, '时间').replace(/<[^>]+>/g, '').replace(/[-—]/g, '~').replace(/\s+/g, ' ').trim()).replace(/（页面不存在）|（待补全）/g, '');
  }
  _bwikiVer(table) {
    return this._bwikiCleanName(this._bwikiCell(table, '版本').replace(/<[^>]+>/g, '')).trim();
  }

  // 星穹铁道：历史跃迁页 → 按「版本 + 时间区间」聚合（角色池+光锥池分表）成 {ver,time,js_five,js_four,gz_five,gz_four}
  // 不能只按 ver 聚合：同一版本下可能有新角色池/复刻池/联动池（长期）多条，
  // 合并成一条会让联动的「长期」时间顶掉常规池的具体结束时间。
  parseSrBwikiHtml(html = '') {
    const map = new Map();
    for (const t of this._bwikiTables(html)) {
      const ths = this._bwikiThs(t);
      if (!ths.some(h => /时间/.test(h)) || !ths.some(h => /版本/.test(h))) continue;
      const ver = this._bwikiVer(t);
      if (!ver) continue;
      const time = this._bwikiTime(t);
      const key = `${ver}||${time || ''}`;
      const e = map.get(key) || { ver, time: '', js_five: [], js_four: [], gz_five: [], gz_four: [] };
      // 时间：已有具体时间就不要被「版本更新后」覆盖；「长期」也不再抢占具体时间
      if (time && (!e.time || (/版本更新后/.test(e.time) && !/版本更新后/.test(time)))) e.time = time;
      for (const [lab, key] of [['5星角色', 'js_five'], ['4星角色', 'js_four'], ['5星光锥', 'gz_five'], ['4星光锥', 'gz_four']]) {
        e[key].push(...this._bwikiCellNames(this._bwikiCell(t, lab)));
      }
      e.js_five = [...new Set(e.js_five)]; e.js_four = [...new Set(e.js_four)];
      e.gz_five = [...new Set(e.gz_five)]; e.gz_four = [...new Set(e.gz_four)];
      map.set(ver, e);
    }
    return [...map.values()];
  }

  // 原神：往期祈愿页 → 按版本聚合（角色池/武器池分表）成 {ver,time,charS,charA,wpnS,wpnA}
  parseYsBwikiHtml(html = '') {
    const map = new Map();
    for (const t of this._bwikiTables(html)) {
      const ths = this._bwikiThs(t);
      if (!ths.some(h => /时间/.test(h)) || !ths.some(h => /版本/.test(h))) continue;
      const ver = this._bwikiVer(t);
      if (!ver) continue;
      const time = this._bwikiTime(t);
      const e = map.get(ver) || { ver, time: '', charS: [], charA: [], wpnS: [], wpnA: [] };
      if (time && (!e.time || /版本更新后/.test(e.time))) e.time = time;
      const isWpn = ths.some(h => /5星武器/.test(h));
      if (isWpn) {
        e.wpnS.push(...this._bwikiCellNames(this._bwikiCell(t, '5星武器')));
        e.wpnA.push(...this._bwikiCellNames(this._bwikiCell(t, '4星武器')));
        e.wpnS = [...new Set(e.wpnS)]; e.wpnA = [...new Set(e.wpnA)];
      } else {
        e.charS.push(...this._bwikiCellNames(this._bwikiCell(t, '5星角色')));
        e.charA.push(...this._bwikiCellNames(this._bwikiCell(t, '4星角色')));
        e.charS = [...new Set(e.charS)]; e.charA = [...new Set(e.charA)];
      }
      map.set(ver, e);
    }
    return [...map.values()];
  }

  async fetchSrPoolHistoryFromBwiki() {
    // 数据源从「跃迁」改为「历史跃迁」后必须换 key，否则会继续读旧缓存（旧数据里联动池挂在普通版本号下）
    const cacheKey = 'xhh:sr:bwiki:history:v2';
    try { const c = await redis.get(cacheKey); if (c) return JSON.parse(c); } catch (_) {}
    try {
      const res = await fetch(SR_BWIKI_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pools = this.parseSrBwikiHtml(await res.text());
      if (Array.isArray(pools) && pools.length) {
        try { await redis.set(cacheKey, JSON.stringify(pools), { EX: 2 * 60 * 60 }); } catch (_) {}
        return pools;
      }
      return null;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 星铁 Bwiki 跃迁抓取失败:', err);
      return null;
    }
  }

  async fetchYsPoolHistoryFromBwiki() {
    const cacheKey = 'xhh:ys:bwiki:history:v1';
    try { const c = await redis.get(cacheKey); if (c) return JSON.parse(c); } catch (_) {}
    try {
      const res = await fetch(YS_BWIKI_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pools = this.parseYsBwikiHtml(await res.text());
      if (Array.isArray(pools) && pools.length) {
        try { await redis.set(cacheKey, JSON.stringify(pools), { EX: 2 * 60 * 60 }); } catch (_) {}
        return pools;
      }
      return null;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 原神 Bwiki 往期祈愿抓取失败:', err);
      return null;
    }
  }

  // —— 崩坏3本地同步 ——
  // 崩三本地库（bh3_gacha_pool_history.yaml）是人工+社区整理的结构化数据，且「当前卡池」依赖 start/end 时间区间。
  // 米游社崩三公告写法散、且官方模块未解析时间区间，故 buildBh3PoolGroup 优先用公告正文里的时间区间，
  // 解析不到时退回公告发布时间(createdAt)作为开启时间、按单版本约 3 周补齐结束时间，从而能把新版本真正写进本地库。
  // 仍只在能定位到开始时间+主UP时才写入，且不改写已有版本数据，避免破坏当前卡池识别。
  async syncBh3LocalFromOfficial(records = []) {
    logger.mark(`[xhh][gacha_pool] 崩三版本更新时间表: ${JSON.stringify(readBh3VersionStartMap())}`);
    // 当前版本号跟随版本更新时间表：到了更新时间就自动推进（如 9.1 于 09-24 06:00 上线后自动变 9.1）
    for (const v of Object.keys(readBh3VersionStartMap()).map(Number).filter(n => !Number.isNaN(n))) {
      const ts = bh3VersionStart(v);
      if (ts && ts <= Date.now() && v > Number(CURRENT_VERSION.bh3 || 0)) CURRENT_VERSION.bh3 = v.toFixed(1);
    }
    // 先自动抓米游社「版本更新公告」补齐各版本实际更新时间，再判定版本号（无需手工维护版本号）。
    // 加硬超时：米游社接口慢时最多等 12 秒就放弃，绝不能把 #刷新卡池 拖到超时无回复。
    try {
      await Promise.race([
        this.refreshBh3VersionStarts(),
        new Promise(resolve => setTimeout(resolve, 12000))
      ]);
    } catch (_) {}
    const data = await this.loadBh3PoolHistory();
    const history = (data && Array.isArray(data.pools)) ? data : null;
    if (!history) {
      const hasRecords = Array.isArray(records) && records.length;
      return hasRecords
        ? '崩坏3：本地库读取失败，无法判定当前版本，请检查 bh3_gacha_pool_history.yaml'
        : '崩坏3：本地库读取失败，跳过同步';
    }
    // 清理脏版本（保守规则）：只删「比最高官方锚点版本还超出 2 个小版本以上、且无锚点」的条目
    // （如锚点最高 9.0/9.1 时，凭空生成的 9.3~9.9）。历史版本（8.x、9.0 等）永远不会命中。
    // 本轮对 history 做的内存维护（脏版本清理 / 版本号归一化 / 归位 / 封面补录）计数，
    // >0 时在封面补录后统一落盘一次（否则下次刷新会重复做同样的处理）。
    let bh3Maintenance = 0;
    {
      const anchored = (history?.pools || [])
        .map(p => Number(p.version))
        .filter(n => !Number.isNaN(n) && bh3VersionStart(n));
      const maxAnchored = anchored.length ? Math.max(...anchored) : 0;
      const maxAnchoredStart = maxAnchored ? bh3VersionStart(maxAnchored) : 0;
      const bogus = (history?.pools || []).filter(p => {
        const n = Number(p.version);
        if (Number.isNaN(n) || bh3VersionStart(n)) return false; // 有锚点 = 官方确认的版本，保留
        if (n <= maxAnchored) return false; // 不比锚点版本新 = 历史版本，保留
        // 比最新锚点版本还新却没有锚点：开始时间必须晚于锚点版本，否则是凭空推出来的版本号
        // （如 9.1 锚点 09-24，却出现 v9.2 起始 08-12 → 必是脏数据）
        const s = new Date(String(p.start || '').replace(/-/g, '/')).getTime();
        if (!Number.isNaN(s) && maxAnchoredStart > 0) return s <= maxAnchoredStart;
        return n > maxAnchored + 0.11;
      });
      // 版本号归一化：浮点进位会丢掉小数点（8.9 + 0.1 = 9），统一补成 9.0 / 10.0
      for (const p of history?.pools || []) {
        const n = Number(p.version);
        if (!Number.isNaN(n) && !String(p.version ?? '').includes('.')) {
          p.version = n.toFixed(1);
          bh3Maintenance++;
        }
      }
      if (bogus.length) {
        history.pools = (history.pools || []).filter(p => !bogus.includes(p));
        bh3Maintenance += bogus.length;
        logger.mark(`[xhh][gacha_pool] 崩三本地库清理脏版本：${bogus.map(p => `v${p.version}`).join('、')}`);
      }
    }
    // 每个补给自己的开放时间：正文优先，拿不到就用米游社「瞬间搜索」按 UP 名取公告正文
    // （走 painter/user_instant 接口，不受「公告详情」接口风控影响）。
    // 放在「归位」之前：这样同一轮刷新里就能“先取到开放时间 → 再按开放时间归位”。
    try {
      const r = await this.fillBh3PoolTimes(history, records);
      if (r.times || r.covers) {
        bh3Maintenance += r.times + r.covers;
        logger.mark(`[xhh][gacha_pool] 崩三补给信息已补录：开放时间 ${r.times} 条、封面 ${r.covers} 张`);
      }
    } catch (err) {
      logger.error('[xhh][gacha_pool] bh3 开放时间补录失败:', err);
    }
    // 存量归位：已错位到新版本的旧补给，按「自身开放时间」挪回正确版本。
    // 只认补给自己的开放时间，或公告正文里解析出的开放时间；
    // 不能用公告「发布时间」兜底（公告常在开池前一天发布，会把明天才开的 9.1 补给搬回 9.0）。
    {
      const moved = [];
      for (const vp of [...(history?.pools || [])]) {
        const stay = [];
        for (const p of vp.pools || []) {
          let ts = 0;
          if (p.start) {
            const t = new Date(String(p.start).replace(/-/g, '/')).getTime();
            if (!Number.isNaN(t)) ts = t;
          }
          if (!ts) {
            const r = (records || []).find(x => String(x.title || '') === String(p.name || ''));
            const ranges = r ? this.parseBh3AllTimeRanges(r.contentText || r.summary || '') : [];
            if (ranges.length) ts = ranges[0].start;
          }
          const target = ts ? this.bh3VersionForTs(history, ts) : null;
          if (!target || target === vp) {
            stay.push(p);
            continue;
          }
          this.bh3MergePoolInto(target, p);
          moved.push(`v${vp.version}「${p.s || p.name}」→ v${target.version}`);
        }
        vp.pools = stay;
      }
      if (moved.length) {
        bh3Maintenance += moved.length;
        logger.mark(`[xhh][gacha_pool] 崩三存量补给按开放时间归位：${moved.join('、')}`);
      }
    }
    // 剔除混进来的「【公告】/【活动】」条目：那是「七日登录领补给卡」这类活动公告，不是卡池
    {
      let dropped = 0;
      for (const vp of history?.pools || []) {
        const before = (vp.pools || []).length;
        vp.pools = (vp.pools || []).filter(p => !/^【?(公告|活动)】/.test(String(p.name || '').trim()));
        dropped += before - vp.pools.length;
      }
      if (dropped) {
        bh3Maintenance += dropped;
        logger.mark(`[xhh][gacha_pool] 崩三本地库剔除 ${dropped} 条非补给公告条目`);
      }
    }
    // 同名补给去重：同一补给被误并进了新版本时会两个版本各留一份（如 9.0 末期补给又出现在 9.1）。
    // 只处理「窗口相邻」的版本对（9.0 结束 09-24、9.1 开始 09-24），保留版本号较小的那份；
    // 历史复刻（如 7.4 与 7.5 的「真我·人之律者」、8.1 与 8.3 的「天光驰彻」）窗口不相邻，一律保留，
    // 绝不动历史数据。副本的封面/时间/target 会合并到保留的那份上。
    {
      const toTs = s => {
        const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
        return Number.isNaN(t) ? null : t;
      };
      const byName = new Map();
      for (const vp of history?.pools || []) {
        for (const p of vp.pools || []) {
          const k = String(p.name || '').trim();
          if (!k) continue;
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push({ vp, p });
        }
      }
      let dedup = 0;
      for (const list of byName.values()) {
        if (list.length < 2) continue;
        const copies = [...list].sort((a, b) => Number(a.vp.version) - Number(b.vp.version));
        const keep = copies[0];
        const keepEnd = toTs(keep.vp.end);
        for (const dup of copies.slice(1)) {
          const dupStart = toTs(dup.vp.start);
          // 两个版本窗口必须相邻（新版本在同日/次日接上旧版本）才算「误并」
          if (!keepEnd || !dupStart || dupStart > keepEnd + 86400000) continue;
          const ownStart = toTs(dup.p.start);
          if (ownStart !== null) {
            const dvs = toTs(dup.vp.start), dve = toTs(dup.vp.end);
            // 副本自己有开放时间且落在它所在版本的窗口内 → 是正经记录（复刻），不要合并
            if (dvs !== null && dve !== null && ownStart >= dvs && ownStart <= dve) continue;
          }
          dup.vp.pools = (dup.vp.pools || []).filter(x => x !== dup.p);
          for (const k of ['imgs', 'start', 'end', 'target']) {
            const empty = keep.p[k] === undefined || (Array.isArray(keep.p[k]) && !keep.p[k].filter(Boolean).length);
            if (empty && dup.p[k] !== undefined) keep.p[k] = dup.p[k];
          }
          dedup++;
          logger.mark(`[xhh][gacha_pool] 崩三同名补给去重：v${dup.vp.version}「${dup.p.s || dup.p.name}」并入 v${keep.vp.version}`);
        }
      }
      if (dedup) bh3Maintenance += dedup;
    }
    // 封面补全：把官方公告的封面 URL 按「卡池名」补进已有补给（与原神/星铁的 imgs 一致），
    // 这样风控或公告缓存过期时封面仍然在，不必等下一次写入新版本。
    let coverAdded = 0;
    try {
      const coverByTitle = new Map();
      for (const r of records || []) {
        const c = r?.cover || (Array.isArray(r?.images) ? r.images[0] : '') || '';
        if (c && r?.title) coverByTitle.set(String(r.title), c);
      }
      for (const vp of history?.pools || []) {
        for (const p of vp.pools || []) {
          if (Array.isArray(p.imgs) && p.imgs.filter(Boolean).length) continue;
          const c = coverByTitle.get(String(p.name || ''));
          if (c) {
            p.imgs = [c];
            coverAdded++;
          }
        }
      }
      if (coverAdded) logger.mark(`[xhh][gacha_pool] 崩三补给封面已补录 ${coverAdded} 张`);
    } catch (err) {
      logger.error('[xhh][gacha_pool] bh3 封面补录失败:', err);
    }
    bh3Maintenance += coverAdded;
    // 清理历史误写的 target（如把「跃升武装」这种补给类型当成角色名写进来的）
    {
      const junkTargets = ['跃升武装', '跃升补给', '角色补给', '装备补给', '精准补给', '主题补给', '服装补给', '协同者轮替'];
      let cleaned = 0;
      for (const vp of history?.pools || []) {
        for (const p of vp.pools || []) {
          if (p.target && junkTargets.includes(String(p.target))) {
            delete p.target;
            cleaned++;
          }
        }
      }
      if (cleaned) {
        bh3Maintenance += cleaned;
        logger.mark(`[xhh][gacha_pool] 崩三清理 ${cleaned} 处错误 target`);
      }
    }
    // 修正历史误判的类型：「位面武器·XX」是第二部女武神的名号前缀（S级角色），
    // 早期按标题关键词分类时被「武器」二字误判成装备补给（如 失序时空）
    {
      let fixed = 0;
      for (const vp of history?.pools || []) {
        for (const p of vp.pools || []) {
          if (/位面武器·/.test(String(p.name || '')) && p.type !== 'char') {
            p.type = 'char';
            fixed++;
          }
        }
      }
      if (fixed) {
        bh3Maintenance += fixed;
        logger.mark(`[xhh][gacha_pool] 崩三修正 ${fixed} 条「位面武器·」角色补给的类型（weapon→char）`);
      }
    }
    // 清理/归一化/归位/封面补录此前都只改内存，若本次没有新版本要写就会提前 return，
    // 改动全丢 → 下次刷新又做一遍（曾每次刷都重复打印同一批「归位」和「补录 10 张」）。
    // 这里统一落盘一次，保证维护动作是幂等的：下一轮刷新应显示「无新增」。
    if (bh3Maintenance > 0) {
      try {
        fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify({
          ...(data || {}),
          updated: new Date().toISOString().slice(0, 10),
          pools: history.pools
        }), 'utf-8');
        logger.mark(`[xhh][gacha_pool] 崩三本地库维护已落盘（${bh3Maintenance} 处：清理/归一化/归位/封面）`);
      } catch (err) {
        logger.error('[xhh][gacha_pool] bh3 维护落盘失败:', err);
      }
    }
    const numberedVers = (history?.pools || [])
      .map(p => ({ raw: p.version, num: Number(p.version) }))
      .filter(p => !Number.isNaN(p.num));
    const maxVerEntry = numberedVers.sort((a, b) => b.num - a.num)[0] || { raw: '0', num: 0 };
    const maxYamlVer = maxVerEntry.num;
    // 当前最大版本已记录的 UP 名集合，用于识别“标题里没写版本号”的新补给。
    const maxEntryPools = (history?.pools || []).find(p => Number(p.version) === maxYamlVer)?.pools || [];
    const knownS = new Set(maxEntryPools.map(p => String(p.s || '').toLowerCase()).filter(Boolean));
    if (!Array.isArray(records) || !records.length) {
      logger.mark(`[xhh][gacha_pool] 崩三同步明细：无新增${coverAdded ? `，已补录 ${coverAdded} 张封面` : ''}`);
      return `崩坏3：本地库已同步 官方补给（最新 v${Number(maxYamlVer).toFixed(1)}）`;
    }
    const byVer = new Map();
    const orphans = [];
    for (const r of records) {
      const v = Number(String(r.version || '').replace(/^v/i, ''));
      const hasUp = Array.isArray(r.up?.s) && r.up.s.some(Boolean);
      if (!Number.isNaN(v) && v > maxYamlVer) {
        if (!byVer.has(v)) byVer.set(v, []);
        byVer.get(v).push(r);
        continue;
      }
      // 版本号缺失或不超过当前最大版本，但 UP 名是当前库里没有的（新增角色/装备补给），
      // 视为新版本候选，避免“标题不写版本号”导致刷新永远写不进去。
      if (hasUp && !r.up.s.some(s => knownS.has(String(s).toLowerCase()))) orphans.push(r);
    }
    // 旧版数据自动修复：早期同步的条目可能把活动公告当成卡池、UP 用了对应角色名/垃圾值、
    // 且所有补给共用一段时间（没有各池独立时间）。检测到时用新解析重建当前最大版本条目，
    // 按卡池名合并（同名覆盖为修正后的数据），手动补充的、公告里没有的池子会保留。
    const maxEntry = (history?.pools || []).find(p => Number(p.version) === maxYamlVer);
    const legacyJunkS = ['跃升武装', '跃升补给', '角色补给', '装备补给', '精准补给', '主题补给', '服装补给'];
    const needRepair = maxEntry && (
      !(maxEntry.pools || []).some(p => p.start && p.end)
      || (maxEntry.pools || []).some(p => /^【(公告|活动)】/.test(String(p.name || '')))
      || (maxEntry.pools || []).some(p => legacyJunkS.includes(String(p.s || '')))
      // 有补给自己的时间但窗口短得离谱（<20 小时）= 把维护时间当成了补给时间
      || (maxEntry.pools || []).some(p => p.start && p.end
        && (new Date(String(p.end).replace(/-/g, '/')) - new Date(String(p.start).replace(/-/g, '/'))) < 20 * 3600000)
    );
    if (needRepair && !byVer.size && !orphans.length) {
      // 只修复「库里已有的池子」；公告里全新的补给交给后面的新版本/并入逻辑，
      // 否则会把下一版本的补给全塞进当前版本（曾把 9.1 的补给并进 v9.0）。
      const oldNames = new Set((maxEntry.pools || []).map(p => String(p.name || '')));
      const eligible = records.filter(r => oldNames.has(String(r.title || '')) && this.parseBh3UpFromTitle(r).s.length);
      if (eligible.length) {
        const win = this.inferBh3VersionWindow(history, maxYamlVer);
        const rebuilt = this.buildBh3PoolGroup(maxYamlVer, eligible, win);
        if (rebuilt && rebuilt.pools.length) {
          const newNameSet = new Set(rebuilt.pools.map(p => String(p.name || '')));
          const kept = (maxEntry.pools || [])
            .filter(p => !newNameSet.has(String(p.name || '')))
            // 活动公告/垃圾 UP 的旧条目直接丢弃，不保留
            .filter(p => !/^【(公告|活动)】/.test(String(p.name || '')) && !legacyJunkS.includes(String(p.s || '')));
          maxEntry.pools = [...rebuilt.pools, ...kept];
          maxEntry.start = rebuilt.start;
          maxEntry.end = rebuilt.end;
          const movedPools = this.reassignBh3PoolsByTime(history);
          if (movedPools.length) logger.mark(`[xhh][gacha_pool] 崩三补给按时间归位：${movedPools.join('、')}`);
          try {
            fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify({
              ...(data || {}),
              updated: new Date().toISOString().slice(0, 10),
              pools: history.pools
            }), 'utf-8');
            logger.mark(`[xhh][gacha_pool] 崩三同步明细：修复 ${rebuilt.pools.length} 条旧数据`);
            return `崩坏3：本地库已同步 官方补给（最新 v${Number(maxYamlVer).toFixed(1)}）`;
          } catch (err) {
            logger.error('[xhh][gacha_pool] bh3 旧数据修复写入失败:', err);
          }
        }
      }
    }
    // 崩三公告标题不带版本号、UP 又都在库里 → 说明确实没有新补给，不要报「解析不出 UP」
    if (!byVer.size && !orphans.length) {
      logger.mark(`[xhh][gacha_pool] 崩三同步明细：无新增（官方 ${records.length} 条公告均已在库）`);
      return `崩坏3：本地库已同步 官方补给（最新 v${Number(maxYamlVer).toFixed(1)}）`;
    }
    const newGroups = [];
    const skipped = [];
    for (const [ver, recs] of [...byVer.entries()].sort((a, b) => a[0] - b[0])) {
      // 公告正文多半没有可靠时间区间，用本地库版本排期推断起止（与其它三款游戏一致）
      const win = this.inferBh3VersionWindow(history, ver);
      const group = this.buildBh3PoolGroup(ver, recs, win);
      if (group) newGroups.push(group);
      else skipped.push(ver);
    }
    // 标题缺版本号的新补给：崩三一个版本有多个补给，只有在「版本更新时间表」里确有该版本
    // （或公告自带更大版本号）时才开新版本；否则并入当前最大版本，绝不凭空造出 v9.2 这种脏版本。
    if (!newGroups.length && orphans.length) {
      const tableNext = Object.keys(readBh3VersionStartMap())
        .map(Number)
        .filter(n => !Number.isNaN(n) && n > maxYamlVer)
        .sort((a, b) => a - b)[0];
      // 版本号必须保留小数位（8.9 + 0.1 = 9 会变成 v9，用 toFixed(1) 得到 9.0）
      const derived = Number.isFinite(tableNext) ? tableNext.toFixed(1) : (maxYamlVer + 0.1).toFixed(1);
      if (bh3VersionStart(derived)) {
        const win = this.inferBh3VersionWindow(history, derived);
        const group = this.buildBh3PoolGroup(derived, orphans, win);
        if (group) newGroups.push(group);
        else skipped.push(derived);
      } else {
        // 无版本锚点：按「开放时间 / 公告发布时间」把新补给归到对应版本（不再一律塞进最新版本）
        const groups = new Map();
        for (const r of orphans) {
          const vp = this.bh3VersionForTs(history, this.bh3RecordTs(r)) || maxEntry;
          if (!vp) continue;
          if (!groups.has(vp)) groups.set(vp, []);
          groups.get(vp).push(r);
        }
        let addTotal = 0;
        const addedNames = [];
        for (const [vp, recs] of groups) {
          const merged = this.buildBh3PoolGroup(Number(vp.version), recs, null);
          const nameSet = new Set((vp.pools || []).map(p => String(p.name || '')));
          const add = (merged?.pools || []).filter(p => !nameSet.has(String(p.name || '')));
          if (add.length) {
            vp.pools = [...(vp.pools || []), ...add];
            addTotal += add.length;
            for (const p of add) addedNames.push(p.s || p.name);
          }
        }
        if (addTotal) {
          const movedPools = this.reassignBh3PoolsByTime(history);
          if (movedPools.length) logger.mark(`[xhh][gacha_pool] 崩三补给按时间归位：${movedPools.join('、')}`);
          try {
            fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify({
              ...(data || {}),
              updated: new Date().toISOString().slice(0, 10),
              pools: history.pools
            }), 'utf-8');
            logger.mark(`[xhh][gacha_pool] 崩三同步明细：并入 ${addTotal} 条新补给（${addedNames.slice(0, 3).join('、')}）`);
            return `崩坏3：本地库已同步 官方补给（最新 v${Number(maxYamlVer).toFixed(1)}）`;
          } catch (err) {
            logger.error('[xhh][gacha_pool] bh3 并入新补给写入失败:', err);
          }
        }
        return `崩坏3：本地库已同步 官方补给（最新 v${Number(maxYamlVer).toFixed(1)}）`;
      }
    }
    // 这次没有新补给可写时，若已抓到新版本的更新时间，至少把上一版本过期的占位结束时间对齐掉，
    // 避免「当前卡池」因结束时间过期只能靠兜底命中（如 9.0 的 end 当初写成 09-04）。
    if (!newGroups.length) {
      const nextVer = Object.keys(readBh3VersionStartMap())
        .map(Number)
        .filter(n => !Number.isNaN(n) && n > maxYamlVer)
        .sort((a, b) => a - b)[0];
      const nextTs = Number.isFinite(nextVer) ? bh3VersionStart(nextVer) : null;
      if (nextTs) {
        const restPools = [...(history?.pools || [])];
        const r = this.alignBh3PrevVersionEnd(restPools, nextVer, nextTs);
        if (r) {
          try {
            fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify({
              ...(data || {}),
              updated: new Date().toISOString().slice(0, 10),
              pools: restPools
            }), 'utf-8');
            logger.mark(`[xhh][gacha_pool] 崩三同步明细：v${r.version} 结束时间已对齐为 ${r.to}`);
            return `崩坏3：本地库已同步 官方补给（最新 v${Number(nextVer).toFixed(1)}）`;
          } catch (err) {
            logger.error('[xhh][gacha_pool] bh3 结束时间对齐写入失败:', err);
          }
        }
      }
      const vs = skipped.map(v => `v${v}`).join('、');
      // 打样本日志，便于定位是「版本没识别」还是「UP 没解析」
      logger.mark(`[xhh][gacha_pool] 崩三同步未命中（当前库最大 v${maxVerEntry.raw}）：` +
        (records || []).slice(0, 8).map(r => `[v${r.version || '-'}|UP:${(r.up?.s || []).join('/') || '无'}] ${r.title || ''}`).join(' || '));
      return `崩坏3：检测到官方新补给，但公告未解析出 UP（${vs}），暂不自动写入；请手动补充 bh3_gacha_pool_history.yaml`;
    }
    try {
      // 新版本上线后，把上一版本结束时间对齐到「新版本开始前一刻（04:00）」，
      // 与崩三「末期 04:00 收尾 → 同日 11:00 开新版」节奏一致，避免区间重叠或留空档。
      const toTs = s => {
        const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
        return Number.isNaN(t) ? null : t;
      };
      const fmtTs = t => {
        const d = new Date(t);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
      };
      const restPools = [...(history?.pools || [])];
      const aligned = [];
      for (const g of newGroups) {
        const r = this.alignBh3PrevVersionEnd(restPools, g.version, toTs(g.start));
        if (r) aligned.push(`v${r.version} 结束时间 ${r.from.slice(5, 16)} → ${r.to.slice(5, 16)}`);
      }
      const movedPools = this.reassignBh3PoolsByTime(history);
      if (movedPools.length) logger.mark(`[xhh][gacha_pool] 崩三补给按时间归位：${movedPools.join('、')}`);
      const next = {
        ...(data || {}),
        version: data?.version || '1.0',
        updated: new Date().toISOString().slice(0, 10),
        source: data?.source || '米游社官方公告+社区整理',
        pools: [...newGroups, ...restPools]
      };
      fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify(next), 'utf-8');
      logger.mark(`[xhh][gacha_pool] 崩三同步明细：新增 v${newGroups.map(g => g.version).join('、v')}（${newGroups.map(g => `${g.start.slice(5, 16)}~${g.end.slice(5, 16)}`).join('、')}）` +
        (aligned.length ? `；${aligned.join('、')}` : '') +
        (skipped.length ? `；v${skipped.join('、')} 因缺少 UP 未写入` : ''));
      return `崩坏3：本地库已同步 官方补给（最新 v${Number(newGroups.map(g => Number(g.version)).sort((a, b) => b - a)[0]).toFixed(1)}）`;
    } catch (err) {
      logger.error('[xhh][gacha_pool] bh3 yaml 自动同步写入失败:', err);
      return '';
    }
  }

  // 把「上一版本」最后一条的结束时间对齐到新版本开始前一刻（维护窗口），
  // 与崩三「末期收尾 → 同日开新版」节奏一致，避免区间重叠或留空档。
  alignBh3PrevVersionEnd(pools = [], version, startTs) {
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const fmtTs = t => {
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
    };
    const gv = Number(version);
    const gs = Number(startTs);
    if (!gs || Number.isNaN(gv)) return null;
    let last = null;
    for (const p of pools || []) {
      const pv = Number(p.version);
      if (Number.isNaN(pv) || pv >= gv || !toTs(p.end)) continue;
      if (!last || toTs(p.end) > toTs(last.end)) last = p;
    }
    if (!last) return null;
    // 上一版本补给的结束时间对齐到「新版本开始当天 04:00」（崩三补给 12:00 开、04:00 收）
    const cut = gs - 8 * 3600000;
    if (cut <= (toTs(last.start) || 0)) return null;
    const from = last.end;
    last.end = fmtTs(cut);
    return { version: last.version, from, to: last.end };
  }

  // 自动从米游社「X.X版本更新公告」抓取各版本的实际更新时间，写回共享表
  // （system/default/bh3_version_start.json），版本号与更新时间都不用手工维护。
  async refreshBh3VersionStarts() {
    try {
      // 12 小时内只抓一次，且已知的版本不再重复请求，避免 #刷新卡池 被串行网络请求拖超时
      const cacheKey = 'xhh:bh3:version_start:v1';
      try {
        if (await redis.get(cacheKey)) return null;
      } catch (_) {}
      const list = await officialPool.requestNews('bh3', 30);
      const cands = (list || [])
        .map(it => it?.post || {})
        // 崩三的版本公告标题写作「9.1版本维护通知 / 版本更新公告 / 停机维护公告」，
        // 只匹配「版本更新」会漏掉「维护通知」，导致版本更新时间表一直是空的。
        .filter(p => /版本更新|维护通知|版本维护|停机维护|停机更新|更新公告/.test(p.subject || '')
          && !/补偿|问题|修复|说明|问卷|封禁|前瞻|内容前瞻/.test(p.subject || ''));
      const fmt = t => {
        const d = new Date(t);
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      const found = {};
      for (const p of cands.slice(0, 3)) {
        const ver = String(p.subject || '').match(/(\d+\.\d+)/)?.[1];
        if (!ver || found[ver]) continue;
        // 表里已有该版本的更新时间就不再抓（版本更新时间基本不会变）
        if (bh3VersionStart(ver)) continue;
        const detail = await officialPool.requestPostFull('bh3', p.post_id);
        const text = officialPool.htmlToText(detail?.content || '');
        const ts = this.parseBh3VersionUpdateTime(text, Number(detail?.created_at || p.created_at || 0) * 1000);
        if (ts) found[ver] = fmt(ts);
      }
      try {
        await redis.set(cacheKey, '1', { EX: 12 * 3600 });
      } catch (_) {}
      if (Object.keys(found).length) {
        writeBh3VersionStarts(found);
        logger.mark(`[xhh][gacha_pool] 崩三版本更新时间已自动更新: ${JSON.stringify(found)}`);
      }
      return found;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 崩三版本更新时间自动抓取失败:', err?.message || err);
      return null;
    }
  }

  // 从版本更新公告正文里解析实际更新时间：维护区间取结束时刻（开服/更新完成），单个时间取该时刻。
  parseBh3VersionUpdateTime(text = '', refTs = 0) {
    if (!text) return null;
    const year = new Date(refTs > 0 ? refTs : Date.now()).getFullYear();
    const mk = (mo, d, h, mi) => {
      const ts = new Date(year, Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
      return Number.isNaN(ts) ? null : ts;
    };
    for (const line of String(text).split(/\n+/).map(v => v.trim()).filter(Boolean)) {
      if (!/更新|维护|停机|开服/.test(line)) continue;
      const dm = line.match(/(?:20\d{2}年)?(\d{1,2})月(\d{1,2})日?/);
      if (!dm) continue;
      const range = line.match(/(\d{1,2})[:：](\d{2})\s*[~～至\-—]\s*(\d{1,2})[:：](\d{2})/);
      if (range) return mk(dm[1], dm[2], range[3], range[4]);
      const single = line.match(/(\d{1,2})[:：](\d{2})/);
      if (single) return mk(dm[1], dm[2], single[1], single[2]);
    }
    return null;
  }

  // 崩三版本排期推断：优先用米游社版本更新公告的实测时间，其次本地库，最后按单版本约 63 天外推。
  // 崩三节奏（本地库可验证）：8.8 04-02→05-28、8.9 05-28→07-23、9.0 07-23→…，版本边界当天 04:00 收尾、11:00 开新版。
  // 米游社公告缺时间区间时用它兜底，刷新才能真正把新版本写进本地库。
  inferBh3VersionWindow(history, ver) {
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const target = Number(ver);
    if (Number.isNaN(target)) return null;
    const byVer = new Map();
    for (const p of (history?.pools || [])) {
      const n = Number(p.version);
      const s = toTs(p.start), e = toTs(p.end);
      if (Number.isNaN(n) || !s || !e) continue;
      const cur = byVer.get(n) || { s: Infinity, e: -Infinity };
      cur.s = Math.min(cur.s, s);
      cur.e = Math.max(cur.e, e);
      byVer.set(n, cur);
    }
    const vers = [...byVer.entries()].sort((a, b) => a[0] - b[0]);
    // 相邻版本「开始时间」间隔的中位数 = 单版本时长（历史节奏）
    const gaps = [];
    for (let i = 1; i < vers.length; i++) {
      const d = Math.round((vers[i][1].s - vers[i - 1][1].s) / 86400000);
      if (d >= 20 && d <= 90) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    // 崩三单版本实测约 62~63 天；历史间隔受库内残缺条目影响可能偏小，只采信合理区间的中位数
    const mid = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const lenDays = (mid >= 55 && mid <= 70) ? mid : BH3_VERSION_DAYS;
    // 1) 权威版本更新时间表优先：官方公告的实际更新时间，不受历史节奏/库内占位值影响
    const known = bh3VersionStart(target);
    if (known) {
      // 来自官方版本更新时间表（权威），标记后 buildBh3PoolGroup 会优先于正文解析的噪声时间
      const nextTs = bh3VersionStart((Math.round((target + 0.1) * 10) / 10).toFixed(1));
      if (nextTs && nextTs > known) return { start: known, end: nextTs, fromTable: true };
      // 崩三补给 12:00 开、04:00 收
      const endDay = new Date(known + lenDays * 86400000);
      endDay.setHours(4, 0, 0, 0);
      return { start: known, end: endDay.getTime(), fromTable: true };
    }
    // 2) 本地库已有该版本：直接沿用
    if (!vers.length) return null;
    const exact = byVer.get(target);
    if (exact) return { start: exact.s, end: exact.e };
    // 3) 都没有：按历史节奏外推（上一版本开始 + N × 单版本时长）
    let prev = null;
    for (const [n, v] of vers) if (n < target) prev = { n, s: v.s, e: v.e };
    if (!prev) return null;
    const steps = Math.max(1, Math.round((target - prev.n) * 10));
    const startDay = new Date(prev.s + steps * lenDays * 86400000);
    startDay.setHours(12, 0, 0, 0);
    const endDay = new Date(startDay.getTime() + lenDays * 86400000);
    endDay.setHours(4, 0, 0, 0);
    return { start: startDay.getTime(), end: endDay.getTime() };
  }

  // 崩三 UP 解析：公告标题「丨」后面才是真正的 UP（官方模块常把对应角色名当成 UP）。
  // 例：【补给】装备补给丨镜见之钥&名以时序 → s=镜见之钥(武器) a=名以时序(圣痕)
  //     【补给】角色补给丨「时序之律者」主题补给限时开启 → s=时序之律者
  //     【补给】跃升武装丨劫烬归虹&命运抉择 → s=劫烬归虹 a=命运抉择
  //     【补给】协同者补给丨周年庆典限时轮替开启 → 无具体 UP，跳过
  parseBh3UpFromTitle(r = {}) {
    const junk = /周年|庆典|限时|轮替|开启|活动|主题|补给|跃升|精准|扩充|装备|武装|概率|UP|更新|调整|说明|版本|登录|奖励|直购|折扣/;
    const clean = s => String(s || '')
      .replace(/[「」『』【】\[\]（）()]/g, '')
      .replace(/(?:主题补给|限时开启|开启)[!！]*$/, '')
      .replace(/^位面武器·/, '')
      .trim();
    const usable = n => n && n.length <= 20 && !junk.test(n);
    // 去掉开头的【补给】标签后按「丨」分段：名字一般在后段，服装补给在前段
    const title = String(r.title || '').replace(/^【[^】]*】/, '').trim();
    const segs = title.split(/[丨｜|]/);
    const before = segs[0] || '';
    const seg = segs.slice(1).join('丨') || '';
    const quoted = text => [...String(text || '').matchAll(/[「『]([^」』]+)[」』]/g)]
      .map(m => clean(m[1]))
      .filter(usable);
    let names = [];
    // 服装补给：「镌刻于黎明的誓约丨服装补给限时开启」—— 服装名在「丨」前面
    if (/服装|时装|皮肤/.test(title)) {
      names = quoted(before);
      if (!names.length) {
        const one = clean(before);
        if (usable(one)) names = [one];
      }
    }
    if (!names.length) {
      names = quoted(seg);
      if (!names.length) {
        // 无「」时按 & 拆：「装备+圣痕」/「武器+圣痕」
        names = seg.split(/[&＆]/).map(clean).filter(usable);
        if (names.length === 1 && !/[&＆]/.test(seg)) {
          // 整段就是一个名字（如「位面武器·失序时空」），去掉尾部套话后用整段
          const one = clean(seg.replace(/(?:限时)?开启[!！]*$/, '').replace(/主题补给.*$/, ''));
          names = usable(one) ? [one] : [];
        }
      }
    }
    names = [...new Set(names.filter(Boolean))].slice(0, 3);
    if (!names.length) {
      // 标题取不到时，退回正文：协同者补给常把 UP 写在正文里
      const text = String(r.contentText || r.summary || '');
      for (const re of [
        /(?:角色补给|扩充补给|装备补给|精准补给|跃升补给|协同补给|协同者补给|跃升武装)[^\n]{0,60}?[「『]([^」』]+)[」』]/,
        /(?:协同者|S级协同者)[^\n]{0,30}?[「『]([^」』]+)[」』]/,
        /(?:S级|A级)(?:角色|女武神|人偶|协同者|武器|圣痕)[^\n]{0,40}?[「『]([^」』]+)[」』]/
      ]) {
        const m = text.match(re);
        const one = m ? clean(m[1]) : '';
        if (usable(one)) { names = [one]; break; }
      }
    }
    // 协同者轮替补给确实没有单一 UP（多协同者轮换），给个可显示的名字，不要整条跳过
    if (!names.length && /协同/.test(title)) names = ['协同者轮替'];
    if (!names.length) return { s: [], a: [] };
    return { s: [names[0]], a: names.slice(1) };
  }

  buildBh3PoolGroup(ver, recs = [], win = null) {
    // 崩三公告常缺可解析的结束时间，单版本补给约 3 周；只拿到开始时间时按此补齐结束时间。
    const BH3_DEFAULT_PHASE_DAYS = 21;
    let start = null, end = null;
    const pools = [];
    for (const r of recs) {
      // 【公告】/【活动】是登录活动类公告（如「七日登录领取装备补给卡」），不是卡池，直接跳过
      if (/^【?(公告|活动)】/.test(String(r.title || '').trim())) continue;
      // 崩三一个版本里多个补给轮替、时间各不相同：解析正文里的全部时间区间
      const times = this.parseBh3AllTimeRanges(r.contentText || r.summary || '');
      for (const t of times) {
        if (!start || t.start < start) start = t.start;
        if (!end || t.end > end) end = t.end;
      }
      if (!times.length && r.createdAt) {
        // 正文没时间区间时，用公告发布时间兜底作为开启时间（崩三补给详情通常于开启当日发布）。
        if (!start || r.createdAt < start) start = r.createdAt;
      }
      // 标题里的「A&B」才是真正 UP（装备+圣痕）；官方模块常把对应角色当 UP，故优先用标题解析结果
      const fb = this.parseBh3UpFromTitle(r);
      const offS = (r.up?.s || []).filter(Boolean);
      const offA = (r.up?.a || []).filter(Boolean);
      const s = fb.s.length ? fb.s : offS;
      const a = fb.a.length ? fb.a : offA;
      if (!s.length) continue;
      const isOutfit = /服装|时装|皮肤/.test(r.title || '');
      // 「位面武器·XX」是第二部女武神的名号前缀（如「位面武器·失序时空」是S级角色，用速射弩），
      // 不是武器类型，必须先摘掉再匹配武器类关键词，否则角色补给会被误判成装备补给
      const weapon = !isOutfit && /装备|精准|武器|圣痕|神之键|武装/.test(String(r.title || '').replace(/位面武器·/g, ''));
      const pool = {
        name: r.title || (isOutfit ? `「${s[0]}」服装补给` : (weapon ? `「${s[0]}」装备补给` : `「${s[0]}」角色补给`)),
        type: isOutfit ? 'outfit' : (weapon ? 'weapon' : 'char'),
        s: s[0],
        a: a.slice(0, 6)
      };
      // 装备补给的官方 UP 名是对应角色（如 镜见之钥 → 时序之律者），存进 target 便于按角色查装备
      if (weapon && offS.length && offS[0] !== s[0]) pool.target = offS[0];
      // 封面图落盘（与原神/星铁的 imgs 字段一致）：风控或公告缓存过期时也能显示公告封面
      const cover = r.cover || (Array.isArray(r.images) ? r.images[0] : '') || '';
      if (cover) pool.imgs = [cover];
      // 该公告正文只有一段区间时，视为这个补给自己的时间（轮替池各池各段时间）
      if (times.length === 1) {
        pool.ownStart = times[0].start;
        pool.ownEnd = times[0].end;
      }
      pools.push(pool);
    }
    if (!pools.length) return null;
    // 正文时间噪声大（维护窗口、活动日期等），版本级窗口以官方更新表为准；
    // 只有没有权威窗口时才用正文解析结果，缺什么补什么。
    if (win && (win.fromTable || !start || !end)) {
      if (win.fromTable || !start) start = win.start;
      if (win.fromTable || !end) end = win.end;
    }
    // 只有开始时间、没有结束时间时，按默认相位长度补齐，保证能写入本地库并被「当前卡池」识别。
    if (start && !end) end = start + BH3_DEFAULT_PHASE_DAYS * 86400000;
    // 连开始时间（时间区间 / 公告发布时间）都没有则无法定位，跳过以免写入脏数据。
    if (!start || !end) return null;
    const fmt = t => {
      const d = new Date(t);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    // 把各补给自己的时间格式化进池子（轮替池各自有各自的起止）
    for (const p of pools) {
      if (p.ownStart && p.ownEnd) {
        p.start = fmt(p.ownStart);
        p.end = fmt(p.ownEnd);
      }
      delete p.ownStart;
      delete p.ownEnd;
    }
    // 崩三没有上下半之分，只按版本号归档
    return { version: String(ver), start: fmt(start), end: fmt(end), pools };
  }

  // 崩三一个版本里多个补给轮替、时间各不相同：返回正文里找到的全部时间区间（而非合并成一条）
  parseBh3AllTimeRanges(text = '') {
    if (!text) return [];
    const toTs = (s) => {
      let str = String(s).trim();
      if (/^\d{1,2}月/.test(str)) str = `${new Date().getFullYear()}年${str}`;
      str = str
        // 「12:00 / 12：00 / 12时 / 12时30分」统一成 12:30 这种形式
        .replace(/(\d{1,2})\s*[:：时]\s*(\d{1,2})?\s*分?/g, (m, h, mi) => `${h}:${String(mi || 0).padStart(2, '0')}`)
        .replace(/年/g, '/')
        .replace(/月/g, '/')
        // 「日」换成空格：崩三公告写「9月4日12:00」，直接删「日」会拼成「412:00」解析失败
        .replace(/日/g, ' ')
        .replace(/[.\-]/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
      const d = new Date(str);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    };
    const out = [];
    const push = (a, b) => {
      if (a && b && b > a) out.push({ start: a, end: b });
    };
    // 「开放时间 9.1版本更新后~10月16日12:00」：开始端是相对写法，用该版本的更新时间（版本表）补全
    {
      const relRe = /(\d+\.\d+)\s*版本更新后\s*(?:~|～|至|到|-|—|－)\s*(\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?|\d{4}[\/年]\d{1,2}[\/月]\d{1,2}日?(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?)/g;
      let rm;
      while ((rm = relRe.exec(text))) {
        const vs = bh3VersionStart(rm[1]);
        const endTs = toTs(rm[2]);
        if (vs) push(vs, endTs);
      }
    }
    for (const re of [
      /(\d{4}\/\d{1,2}\/\d{1,2}(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)\s*(?:~|～|至|到|-|—|－)\s*(\d{4}\/\d{1,2}\/\d{1,2}(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)/g,
      /(\d{4}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?)\s*(?:~|～|至|到|-|—|－)\s*(\d{4}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?)/g,
      // 崩三最常见写法：9月4日12:00~9月24日04:00（日期与时分之间没有空格，时分可省略）
      /(\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?)\s*(?:~|～|至|到|-|—|－)\s*(\d{1,2}月\d{1,2}日(?:\s*\d{1,2}[:：时]\d{0,2}(?:分)?)?)/g
    ]) {
      let m;
      while ((m = re.exec(text))) push(toTs(m[1]), toTs(m[2]));
    }
    const seen = new Set();
    // 过滤掉维护窗口之类的短区间（如「9月24日 06:00~11:00」只有几小时），只留真正的补给时间
    return out.filter(r => {
      if (r.end - r.start < 20 * 3600000) return false;
      const k = `${r.start}|${r.end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  parseBh3TimeRange(text = '') {
    const list = this.parseBh3AllTimeRanges(text);
    if (!list.length) return null;
    return list.reduce((best, r) => (!best || r.end > best.end ? r : best), null);
  }

  async syncLocalPoolsFromOfficial(results = []) {
    const lines = [];
    for (const { game, records } of results) {
      try {
        // 卡池数据来源：gs/sr/zzz = wiki（Bwiki），bh3 = 米游社公告（Bwiki 没有崩三补给表）。
        // 封面来源：四个游戏统一走米游社（在各 syncXxx 内部只写图片字段，不写卡池数据）。
        if (game === 'sr') {
          const l = await this.syncSrLocalFromOfficial(records || []);
          if (l) lines.push(l);
        } else if (game === 'gs') {
          const l = await this.syncGsLocalFromOfficial(records || []);
          if (l) lines.push(l);
        } else if (game === 'zzz') {
          const l = await this.syncZzzLocalFromOfficial(records || []);
          if (l) lines.push(l);
        } else if (game === 'bh3' && Array.isArray(records) && records.length) {
          const l = await this.syncBh3LocalFromOfficial(records);
          if (l) lines.push(l);
        }
      } catch (err) {
        logger.error(`[xhh][gacha_pool] 本地卡池库自动同步失败(${game}):`, err);
      }
    }
    // 通用：从「X.X（上半/下半）」公告自动推进各游戏 CURRENT_VERSION（不回落）
    for (const { game, records } of results) {
      const cur = CURRENT_VERSION[game];
      if (!cur || !Array.isArray(records) || !records.length) continue;
      const vs = records
        .map(r => String(r.version || '').match(/^(\d+\.\d+)/))
        .filter(Boolean)
        .map(m => m[1]);
      if (!vs.length) continue;
      const maxV = vs.map(Number).sort((a, b) => b - a)[0].toFixed(1);
      if (Number(maxV) > Number(cur)) CURRENT_VERSION[game] = maxV;
    }
    return lines;
  }

  getLocalZzzMarkIcon() {
    const customDir = './plugins/xhh/resources/zzz_md/imgs/custom/';
    if (!fs.existsSync(customDir)) return '';
    try {
      const files = fs.readdirSync(customDir)
        .filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))
        .map(f => ({ f, mtime: fs.statSync(`${customDir}/${f}`).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length) return `zzz_md/imgs/custom/${files[0].f}`;
    } catch (_) {}
    return '';
  }

  formatCurrentPoolSubtitle(version = '', time = '', fallback = '') {
    const ver = String(version || '').trim();
    const raw = String(time || '').trim();
    const dateMatches = [...raw.matchAll(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/g)];
    const fmt = m => {
      const date = `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
      return m[4] ? `${date} ${String(m[4]).slice(0, 5)}` : date;
    };
    const parse = m => {
      const hhmm = m[4] || '23:59:59';
      const t = new Date(`${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')} ${hhmm}`).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    let range = raw;
    let days = '';
    if (dateMatches.length >= 2) {
      range = `${fmt(dateMatches[0])} ~ ${fmt(dateMatches[dateMatches.length - 1])}`;
      const end = parse(dateMatches[dateMatches.length - 1]);
      if (end) days = ` · 剩余约${Math.max(Math.ceil((end - Date.now()) / 86400000), 0)}天`;
    }
    const parts = [];
    if (ver) parts.push(`v${ver}`);
    if (range) parts.push(range);
    const text = parts.join(' · ') + days;
    return text || fallback;
  }

  applyCardVersion(cards = [], version = '') {
    if (!version) return cards;
    for (const card of cards) {
      card.version = version;
      if (card.index) card.versionTag = `#${card.index} ${version}`;
    }
    return cards;
  }

  getZzzOfficialCardImage(card = {}, records = []) {
    const list = Array.isArray(records) ? records : [];
    if (!list.length) return '';
    const clean = v => String(v || '').replace(/[「」『』\s/，,•·\-]/g, '').toLowerCase();
    const names = [card.s, card.title]
      .flatMap(v => String(v || '').split(/[\/，,、]/))
      .map(v => v.trim())
      .filter(Boolean);
    const cardVer = String(card.version || '').replace(/上半|下半/g, '');
    let best = null;
    let bestScore = -1;
    for (const r of list) {
      const imgs = [r.cover, ...(r.images || [])].filter(Boolean);
      if (!imgs.length) continue;
      const text = `${r.title || ''}
${r.contentText || ''}
${r.summary || ''}`;
      const ct = clean(text);
      let score = 0;
      if (cardVer && String(r.version || '').startsWith(cardVer)) score += 8;
      if (card.weapon && /(音擎|武器|频段)/.test(text)) score += 3;
      if (!card.weapon && /(代理人|独家频段|角色|调频)/.test(text)) score += 3;
      for (const name of names) {
        const cn = clean(name);
        if (cn && ct.includes(cn)) score += 8;
      }
      if (score > bestScore) {
        best = { imgs, score };
        bestScore = score;
      }
    }
    if (!best || bestScore <= 0) return '';
    return best.imgs[0];
  }

  async applyZzzCardBackgrounds(cards = [], officialRecords = []) {
    if (!Array.isArray(cards)) return cards;
    let roleBg = '';
    let searched = 0;
    for (const card of cards) {
      // 封面统一优先米游社官方公告图；本地/wiki 图只作兜底
      const mysImg = (officialRecords || []).length ? this.getZzzOfficialCardImage(card, officialRecords) || '' : '';
      if (mysImg) {
        card.img = mysImg;
        if (!roleBg && !card?.weapon) roleBg = mysImg;
        continue;
      }
      if (card?.weapon) continue;
      if (!card.img && card.s) {
        const firstName = String(card.s).split(/[\/，,、]/)[0]?.trim();
        card.img = this.getZzzCharacterSplash(firstName) || '';
        // 官方号搜索接口兜底：按 UP 名取「独家频段/音擎频段」公告图
        if (!card.img && firstName && searched < 4) {
          searched++;
          card.img = (await this.mysSearchImages('zzz', firstName, [0]))[0] || '';
        }
      }
      if (!roleBg && card.img) roleBg = card.img;
    }
    // 音擎卡本地数据没有官方图时，沿用同期开幕代理人立绘/公告图，避免纯色空卡。
    if (roleBg) {
      for (const card of cards) {
        if (card?.weapon && !card.img) card.img = roleBg;
      }
    }
    return cards;
  }

  async getZzzCurrentLocalVersion() {
    const data = await this.fetchZzzPools();
    if (!Array.isArray(data) || !data.length) return '';
    const now = new Date();
    const current = data.find(p => {
      const { start, end } = this.parseTime(p);
      return start && end && now >= start && now <= end;
    });
    return current?.version || '';
  }

  async zzzCurrentPool(e) {
    logger.mark('[xhh][gacha_pool] 命中绝区零当前卡池:', e.msg);
    // 优先使用本地当前时间段数据，避免米游社公告按版本筛选时把 3.0上半/下半混在一起。
    const zzzOfficial = await officialPool.fetch('zzz');
    const data = await this.fetchZzzPools();
    if (data) {
      const now = new Date();
      const pools = data.filter(p => {
        const { start, end } = this.parseTime(p);
        return start && end && now >= start && now <= end;
      });
      if (pools.length) {
        const sample = pools[0];
        const { end } = this.parseTime(sample);
        const days = end ? Math.max(Math.ceil((end.getTime() - now.getTime()) / 86400000), 0) : '?';
        const cards = await this.applyZzzCardBackgrounds(pools.map((p, i) => { const c = this.poolToCard(p); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }), zzzOfficial.records || []);
        const markIcon = this.getZzzHeaderSplashFromCards(cards, ZZZ_MARK_ICON);
        return this.renderPoolImage(e, {
          game: '绝区零',
          title: '绝区零当前卡池',
          subtitle: `v${sample.version} · ${this.zzzPoolTime(sample)} · 剩余约${days}天`,
          mode: 'zzz',
          markIcon,
          markWide: !!markIcon,
          cards
        });
      }
    }
    // 本地没有当前期时，再尝试从米游社公告获取。
    const { records } = zzzOfficial;
    if (records.length) {
      // 只使用公告标题能明确解析到当前版本的记录；避免旧公告解析不到版本时被 officialCard 兜底成 3.0，导致右上角抽到旧角色（如比利）。
      const useRecords = records.filter(r => String(r.version || '').startsWith(CURRENT_VERSION.zzz));
      if (!useRecords.length) {
        logger.mark('[xhh][gacha_pool] 绝区零官方公告未解析到当前版本记录，改用本地卡池数据兜底');
      } else {
      const rawCards = useRecords.map((r, i) => {
        const card = this.officialCard(r, '绝区零');
        card.index = i + 1;
        card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        return card;
      });
      // 官方公告 UP 全部解析为空（米游社详情接口异常）时，改用本地卡池库当前期数据兜底。
      if (!rawCards.some(c => c.s || c.a)) {
        const now = new Date();
        const localPools = (data || []).filter(p => {
          const { start, end } = this.parseTime(p);
          return start && end && now >= start && now <= end;
        });
        if (localPools.length) {
          const sample = localPools[0];
          const { end } = this.parseTime(sample);
          const days = end ? Math.max(Math.ceil((end.getTime() - now.getTime()) / 86400000), 0) : '?';
          const localCards = await this.applyZzzCardBackgrounds(localPools.map((p, i) => { const c = this.poolToCard(p); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }), zzzOfficial.records || []);
          const markIcon = this.getZzzHeaderSplashFromCards(localCards, ZZZ_MARK_ICON);
          return this.renderPoolImage(e, {
            game: '绝区零',
            title: '绝区零当前卡池',
            subtitle: `v${sample.version} · ${this.zzzPoolTime(sample)} · 剩余约${days}天`,
            mode: 'zzz',
            markIcon,
            markWide: !!markIcon,
            cards: localCards
          });
        }
      }
      const currentCards = rawCards.filter(c => String(c.version || '').startsWith(CURRENT_VERSION.zzz));
      const cards = (currentCards.length ? currentCards : rawCards).slice(0, 4).map((card, i) => {
        card.index = i + 1;
        card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        return card;
      });
      // 官方公告缺 A 级时用本地卡池库补齐
      await this.patchZzzOfficialCards(cards);
      this.applyCardVersion(cards, await this.getZzzCurrentLocalVersion());
      const markIcon = this.getZzzHeaderSplashFromCards(cards, ZZZ_MARK_ICON);
      let markWide = !!markIcon;
      return this.renderPoolImage(e, {
        game: '绝区零',
        title: '绝区零当前卡池',
        subtitle: `数据来源：米游社公告 · v${CURRENT_VERSION.zzz}`,
        mode: 'zzz',
        markIcon,
        markWide,
        cards
      });
      }
    }
    // 兜底：使用本地最新收录数据
    if (!data) return e.reply('绝区零卡池数据获取失败，请稍后再试。');
    const now = new Date();
    const pools = data.filter(p => {
      const { start, end } = this.parseTime(p);
      return start && end && now >= start && now <= end;
    });
    if (!pools.length) {
      const latestEnd = Math.max(...data.map(p => this.poolEndStamp(p)).filter(Boolean));
      const latest = data.filter(p => this.poolEndStamp(p) === latestEnd);
      if (!latest.length) return e.reply('当前没有匹配到正在开放的绝区零活动卡池。');
      const latestStage = latest[0]?.version ? `；数据源最新收录：${latest[0].version}` : '';
      const cards = await this.applyZzzCardBackgrounds(latest.map((p, i) => { const c = this.poolToCard(p); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }), zzzOfficial.records || []);
      const markIcon = this.getZzzHeaderSplashFromCards(cards, ZZZ_MARK_ICON);
      return this.renderPoolImage(e, {
        game: '绝区零',
        title: '最新收录卡池',
        subtitle: `当前版本 ${CURRENT_VERSION.zzz}${latestStage}；展示最新收录内容`,
        mode: 'zzz',
        markIcon,
        markWide: !!markIcon,
        cards
      });
    }
    const sample = pools[0];
    const { end } = this.parseTime(sample);
    const days = end ? Math.max(Math.ceil((end.getTime() - now.getTime()) / 86400000), 0) : '?';
    const cards = await this.applyZzzCardBackgrounds(pools.map((p, i) => { const c = this.poolToCard(p); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }));
    const markIcon = this.getZzzHeaderSplashFromCards(cards, ZZZ_MARK_ICON);
    return this.renderPoolImage(e, {
      game: '绝区零',
      title: '本期卡池',
      subtitle: `v${sample.version} · ${this.zzzPoolTime(sample)} · 剩余约${days}天`,
      mode: 'zzz',
      markIcon,
      markWide: !!markIcon,
      cards
    });
  }

  async zzzVersionPool(e) {
    if (!config().zzz_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中绝区零版本卡池:', e.msg);
    const data = await this.fetchZzzPools();
    if (!data) return e.reply('绝区零卡池数据获取失败，请稍后再试。');
    const m = e.msg.match(/(?:绝区零|ZZZ)v?(\d+\.\d+)(上半|下半)?卡池/);
    if (!m) return false;
    const [, version, phase] = m;
    const pools = data.filter(p => p.version?.startsWith(version) && (!phase || p.version?.includes(phase)));
    if (!pools.length && version === CURRENT_VERSION.zzz) {
      return e.reply(`绝区零当前版本已标记为 ${CURRENT_VERSION.zzz}，但卡池数据源还没有收录 ${CURRENT_VERSION.zzz}${phase || ''} 的具体UP信息。`);
    }
    if (!pools.length) return e.reply(`未查询到绝区零 ${version}${phase || ''} 卡池数据。`);
    const cards = await this.applyZzzCardBackgrounds(pools.map((p, i) => { const c = this.poolToCard(p); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }));
    const markIcon = this.getZzzHeaderSplashFromCards(cards, ZZZ_MARK_ICON);
    return this.renderPoolImage(e, {
      game: '绝区零',
      title: `v${phase ? pools[0].version : version} 卡池`,
      subtitle: phase ? this.zzzPoolTime(pools[0]) : '历史版本卡池记录',
      mode: 'zzz',
      markIcon,
      markWide: !!markIcon,
      cards
    });
  }

  async zzzNameHistory(e) {
    if (!config().zzz_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中绝区零名称卡池:', e.msg);
    const name = e.msg.replace(/^#*(?:xhh)?(小花火)?(绝区零|ZZZ)/, '').replace(/(卡池|复刻)(统计|记录|历史)$/, '').replace(/卡池$/, '').trim();
    return this.replyZzzNameHistory(e, name, false);
  }

  async genericNameHistory(e) {
    const normalized = String(e?.msg || '')
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
      .replace(/[＃井]/g, '#')
      .replace(/\s+/g, '');
    // 兜底：如果“原神卡池/#原神卡池”被通用规则误吞，直接转到当前卡池。
    if (/^(?:[#＃井]*\s*)?(?:小花火)?\s*原神\s*(?:当前|本期|当期)?\s*卡池$/.test(normalized)) {
      e.msg = normalized;
      return this.gsCurrentPool(e);
    }
    const name = normalized.replace(/^#*(?:xhh)?(小花火)?/, '').replace(/(卡池|复刻)(统计|记录|历史)?$/, '').trim();
    const cnName = name.replace(/[^\u4e00-\u9fa5]/g, '');
    // 兜底中的兜底：如果通用名称规则已经把“#原神卡池”吃进来了，name 会变成“原神”。
    // 这时不要继续查历史名称，直接转当前卡池。
    if (/^(原神|原神当前|原神本期|原神当期)$/.test(cnName)) {
      e.msg = '#原神卡池';
      return this.gsCurrentPool(e);
    }
    if (!name || /^(当前|本期|当期|时间|剩余|剩下)$/i.test(name)) return false;
    // 通用“xx卡池”只接短命令，避免群聊普通句子以“雨果卡池/雷神卡池”等结尾时误触发。
    // 如果带 #，视为明确命令；不带 # 时过滤长句和明显句读符号。
    if (!normalized.startsWith('#') && (
      cnName.length > 16
      || /[，,。！？?、；;：:…]/.test(name)
      || /^(为啥|为什么|怎么|居然|可惜|没有|是不是|如果|但是|不过|然后|还有|我想|我看|你看|帮我)/.test(cnName)
    )) return false;
    logger.mark('[xhh][gacha_pool] 尝试通用名称卡池:', name);
    // 先查绝区零
    const zzzResult = await this.replyZzzNameHistory(e, name, true);
    if (zzzResult !== false) return zzzResult;
    // 再查崩三
    const bh3Result = await this.replyBh3NameHistory(e, name, true);
    if (bh3Result !== false) return bh3Result;
    // 再查星铁
    const srResult = await this.replySrNameHistory(e, name, true);
    if (srResult !== false) return srResult;
    // 再查原神
    const gsResult = await this.replyGsNameHistory(e, name, true);
    if (gsResult !== false) return gsResult;
    return false;
  }

  async replyZzzNameHistory(e, name, silent = false) {
    const data = await this.fetchZzzPools();
    if (!data) return silent ? false : e.reply('绝区零卡池数据获取失败，请稍后再试。');
    if (!name) return false;
    const query = this.normalizeZzzName(name);
    const qClean = this.cleanZzzName(query);
    const strict = qClean === '安比' || this.cleanZzzName(name) !== qClean;
    const isAgentQuery = this.isZzzAgentName(query);
    const hitName = v => {
      const raw = String(v || '');
      const vClean = this.cleanZzzName(this.normalizeZzzName(raw));
      if (!vClean || !qClean) return false;
      if (vClean === qClean) return true;
      // 别名已归一或“安比”这种有大小号歧义时，只允许精确命中，避免大安比串到小安比。
      if (strict) return false;
      // 普通查询允许较长名称互相包含，但要求至少2字符，避免“雅”误匹配。
      return vClean.length >= 2 && qClean.length >= 2 && (vClean.includes(qClean) || qClean.includes(vClean));
    };
    // 查询代理人时，只用“代理人频段”判断命中，再补同一期音擎频段。
    // 避免“艾莲卡池”被她的专属音擎「深海访客」后续复刻/陪跑记录串出来。
    const matched = data.filter(p => {
      if (isAgentQuery && p.type === '武器') return false;
      return hitName(p.s) || (Array.isArray(p.a) && p.a.some(hitName));
    });
    let records = [];
    if (isAgentQuery) {
      // 查询代理人时，只展示命中的代理人频段，并按同一期顺序补“对应”的音擎频段。
      // 以前直接把同一期所有音擎都带出来，双 UP 期会把另一个角色的专武（如怒目金刚）也混进艾莲卡池。
      for (const p of matched) {
        records.push(p);
        if (p.type === '武器' || !hitName(p.s)) continue; // A级陪跑没有对应专武，别强行带音擎。
        const key = `${p.version || '-'}|${this.zzzPoolTime(p)}`;
        const same = data.filter(v => `${v.version || '-'}|${this.zzzPoolTime(v)}` === key);
        const chars = same.filter(v => v.type !== '武器');
        const weapons = same.filter(v => v.type === '武器');
        const idx = chars.indexOf(p);
        const signature = this.getZzzSignatureWeaponName(p.s);
        const signatureClean = this.cleanZzzName(signature);
        const weapon = (signatureClean && weapons.find(w => this.cleanZzzName(w.s) === signatureClean)) || (idx >= 0 ? weapons[idx] : null);
        if (weapon) records.push(weapon);
      }
      records = records.filter((v, i, arr) => arr.indexOf(v) === i);
    } else {
      // 查询音擎/非代理人关键词时保留原逻辑：展示同一期命中的相关记录。
      const hitKeys = new Set(matched.map(p => `${p.version || '-'}|${this.zzzPoolTime(p)}`));
      records = data.filter(p => {
        const key = `${p.version || '-'}|${this.zzzPoolTime(p)}`;
        return hitKeys.has(key) && (matched.includes(p) || p.type === '武器');
      });
    }
    if (!records.length) return silent ? false : e.reply(`未找到【${name}】的绝区零卡池记录。`);
    const sections = this.buildZzzHistorySections(records, query);
    if (sections.length) {
      return this.renderZzzLogs(e, sections, query);
    }
    const first = records[0];
    const rarity = hitName(first.s) ? 'S级' : 'A级';
    const type = first.type === '武器' ? '音擎' : '代理人';
    return this.renderPoolImage(e, {
      game: '绝区零',
      title: `${query} 卡池记录`,
      subtitle: `${rarity}${type} · 共 ${records.length} 次记录`,
      mode: 'gs-history',
      cards: sections
    });
  }

  cleanZzzName(name = '') {
    return String(name || '').replace(/[\s「」『』【】［］()（）·・•!！&]/g, '').trim();
  }

  getZzzSignatureWeaponName(agentName = '') {
    const agentClean = this.cleanZzzName(this.normalizeZzzName(agentName));
    if (!agentClean) return '';
    const manualMap = {
      叶瞬光: '云霓孤光',
      维琳娜: '琳琅鎏心',
      千夏: '思络成歌',
      诺姆: '首席跟班'
    };
    for (const [agent, weapon] of Object.entries(manualMap)) {
      if (this.cleanZzzName(agent) === agentClean) return weapon;
    }
    try {
      const partner = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', 'utf-8'));
      const agents = [];
      for (const info of Object.values(partner)) {
        const names = [info?.name, info?.full_name, info?.Name, info?.FullName].filter(Boolean);
        if (names.some(v => this.cleanZzzName(v) === agentClean)) agents.push(...names);
      }
      if (!agents.length) agents.push(agentName);
      const agentTargets = [...new Set(agents.map(v => this.cleanZzzName(v)).filter(Boolean))];
      const weapons = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/WeaponId2Data.json', 'utf-8'));
      for (const info of Object.values(weapons)) {
        const weaponName = info?.Name || info?.name || '';
        const text = [info?.Desc, info?.Desc3, info?.Talents && JSON.stringify(info.Talents)].filter(Boolean).join('');
        const cleanText = this.cleanZzzName(text);
        if (weaponName && agentTargets.some(v => cleanText.includes(v))) return weaponName;
      }
    } catch (_) {}
    return '';
  }

  normalizeZzzName(name = '') {
    const raw = String(name || '').trim();
    const clean = this.cleanZzzName(raw);
    const aliasMap = {
      大安比: '零号·安比',
      零号安比: '零号·安比',
      零号: '零号·安比',
      小安比: '安比',
      普安比: '安比'
    };
    if (aliasMap[clean]) return aliasMap[clean];
    try {
      const data = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', 'utf-8'));
      for (const info of Object.values(data)) {
        const name = info?.name || '';
        const full = info?.full_name || '';
        if (this.cleanZzzName(name) === clean || this.cleanZzzName(full) === clean) return name || full || raw;
      }
    } catch (_) {}
    return raw;
  }

  isZzzAgentName(name = '') {
    const target = this.cleanZzzName(name);
    if (!target) return false;
    try {
      const data = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', 'utf-8'));
      for (const info of Object.values(data)) {
        const name = this.cleanZzzName(info?.name || '');
        const full = this.cleanZzzName(info?.full_name || '');
        if (name === target || full === target) return true;
      }
    } catch (_) {}
    return false;
  }

  getZzzCharSprite(name = '') {
    try {
      const data = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', 'utf-8'));
      const clean = s => String(s || '').replace(/[「」&]/g, '');
      const target = clean(name);
      for (const info of Object.values(data)) {
        const entry = clean(info?.name || '');
        if (entry === target || entry.startsWith(target) || target.startsWith(entry)) {
          return info.sprite_id || '';
        }
      }
      for (const info of Object.values(data)) {
        const full = clean(info?.full_name || '');
        if (full === target || full.startsWith(target) || target.startsWith(full)) {
          return info.sprite_id || '';
        }
      }
    } catch (_) {}
    return '';
  }

  getZzzCharacterSplash(name = '') {
    // 卡池右上角装饰位优先用 Nanoka 的角色立体图；不要用 role_general 横版大头照。
    // 本地自定义立绘只作为补充，且 getZzzPanelSplash 会过滤横版/过长图。
    const nanoka = this.getZzzNanokaRoleImage(name);
    const panel = this.getZzzPanelSplash(name);
    return this.randomPick([nanoka, nanoka, panel].filter(Boolean));
  }

  getZzzNanokaRoleImage(name = '') {
    const sprite = this.getZzzCharSprite(name);
    if (!sprite) return '';
    const local = `./plugins/ZZZ-Plugin/resources/images/nanoka/role/IconRole${sprite}_01.webp`;
    if (fs.existsSync(local)) return fs.realpathSync(local);
    return `https://static.nanoka.cc/assets/zzz/IconRole${sprite}_01.webp`;
  }

  getZzzRoleGeneralImage(name = '') {
    const sprite = this.getZzzCharSprite(name);
    if (!sprite) return '';
    const local = `./plugins/ZZZ-Plugin/resources/images/nanoka/role_general/IconRoleGeneral${sprite}.webp`;
    if (fs.existsSync(local)) return fs.realpathSync(local);
    return `https://static.nanoka.cc/assets/zzz/IconRoleGeneral${sprite}.webp`;
  }

  getLocalImageSize(path = '') {
    try {
      const buf = fs.readFileSync(path);
      if (buf.length < 16) return null;
      // PNG
      if (buf.toString('ascii', 1, 4) === 'PNG') {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      // JPEG
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        let pos = 2;
        while (pos < buf.length) {
          if (buf[pos] !== 0xff) break;
          const marker = buf[pos + 1];
          const len = buf.readUInt16BE(pos + 2);
          if (marker >= 0xc0 && marker <= 0xc3) {
            return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
          }
          pos += 2 + len;
        }
      }
      // WebP: VP8X / VP8L / VP8
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const type = buf.toString('ascii', 12, 16);
        if (type === 'VP8X' && buf.length >= 30) {
          return {
            width: 1 + buf.readUIntLE(24, 3),
            height: 1 + buf.readUIntLE(27, 3)
          };
        }
        if (type === 'VP8L' && buf.length >= 25) {
          const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
          return {
            width: 1 + (((b1 & 0x3f) << 8) | b0),
            height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
          };
        }
        if (type === 'VP8 ' && buf.length >= 30) {
          return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
      }
    } catch (_) {}
    return null;
  }

  isSafeCornerSplashFile(path = '') {
    const size = this.getLocalImageSize(path);
    if (!size?.width || !size?.height) return true;
    const ratio = size.height / size.width;
    // 右上角装饰位不要横版海报；允许祈愿竖版/角色立绘这类较高的图。
    return ratio >= 0.5 && ratio <= 4.2;
  }

  isSafeZzzSplashFile(path = '') {
    const size = this.getLocalImageSize(path);
    if (!size?.width || !size?.height) return true;
    const ratio = size.height / size.width;
    // 绝区零本地 panel 过长时头像容易被挤到边缘，单独收紧一点。
    return ratio >= 0.75 && ratio <= 2.15;
  }

  getZzzPanelSplash(name = '') {
    const root = './plugins/ZZZ-Plugin/resources/images/panel';
    if (!fs.existsSync(root)) return '';
    const clean = v => String(v || '').replace(/[「」&·•\s]/g, '');
    const target = clean(name) || '艾莲';
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const dirName = dirs.find(d => clean(d) === target)
        || dirs.find(d => clean(d).includes(target) || target.includes(clean(d)))
        || (target === '艾莲' ? '艾莲' : '');
      if (!dirName) return '';
      const dir = `${root}/${dirName}`;
      const files = fs.readdirSync(dir)
        .filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))
        .filter(f => !/avatar|icon|face|头像/i.test(f))
        // Gu/咕咕牛图下方经常自带文字，不适合放在右上角装饰位。
        .filter(f => !/Gu[1-9]/i.test(f))
        // 过滤过窄长图，避免随机到头像被裁没/看不清的立绘。
        .filter(f => this.isSafeZzzSplashFile(`${dir}/${f}`))
        .map(f => ({ f, size: fs.statSync(`${dir}/${f}`).size }))
        .map(v => ({
          ...v,
          score: (() => {
            if (/backgrounderaser/i.test(v.f)) return 120;
            if (/-\d{3,4}-\d{3,4}\.png$/i.test(v.f)) return 100;
            if (/\.png$/i.test(v.f)) return 80;
            if (/立绘|半身|panel/i.test(v.f)) return 60;
            return 0;
          })()
        }))
        .sort((a, b) => {
          // 右上角装饰图优先选高分辨率透明 PNG，避免自带文字/海报裁切影响观感。
          return b.score - a.score || b.size - a.size;
        });
      if (files.length) {
        const bestScore = files[0].score;
        const pool = files.filter(v => v.score >= Math.max(60, bestScore - 20));
        return fs.realpathSync(`${dir}/${this.randomPick(pool).f}`);
      }
    } catch (_) {}
    return '';
  }

  getZzzPanelIcon(name = '') {
    const root = './plugins/ZZZ-Plugin/resources/images/panel';
    if (!fs.existsSync(root)) return '';
    const clean = v => String(v || '').replace(/[「」&·•\s]/g, '');
    const target = clean(name);
    if (!target) return '';
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      const dirName = dirs.find(d => clean(d) === target)
        || dirs.find(d => clean(d).includes(target) || target.includes(clean(d)));
      if (!dirName) return '';
      const dir = `${root}/${dirName}`;
      const files = fs.readdirSync(dir)
        .filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))
        .filter(f => !/avatar|icon|face|头像/i.test(f))
        .filter(f => this.isSafeZzzSplashFile(`${dir}/${f}`))
        .map(f => ({ f, size: fs.statSync(`${dir}/${f}`).size }))
        .sort((a, b) => {
          const score = f => {
            if (/Gu[1-9]/i.test(f)) return 100;
            if (/backgrounderaser/i.test(f)) return 60;
            if (/半身|panel/i.test(f)) return 40;
            return 0;
          };
          return score(b.f) - score(a.f) || b.size - a.size;
        });
      if (files.length) {
        const bestScore = (() => {
          const score = f => {
            if (/Gu[1-9]/i.test(f)) return 100;
            if (/backgrounderaser/i.test(f)) return 60;
            if (/半身|panel/i.test(f)) return 40;
            return 0;
          };
          return score(files[0].f);
        })();
        const scoreFile = f => {
          if (/Gu[1-9]/i.test(f)) return 100;
          if (/backgrounderaser/i.test(f)) return 60;
          if (/半身|panel/i.test(f)) return 40;
          return 0;
        };
        const pool = files.filter(v => scoreFile(v.f) >= Math.max(40, bestScore - 20));
        return fs.realpathSync(`${dir}/${this.randomPick(pool).f}`);
      }
    } catch (_) {}
    return '';
  }

  getZzzIcon(name = '', weapon = false) {
    if (weapon) {
      const mapPath = './plugins/ZZZ-Plugin/resources/map/WeaponId2Data.json';
      try {
        const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        const clean = v => String(v || '').replace(/[「」&·•\s]/g, '');
        const target = clean(name);
        for (const info of Object.values(data)) {
          if (clean(info?.Name) === target) {
            const code = info?.CodeName || '';
            const local = `./plugins/ZZZ-Plugin/resources/images/weapon/${code}_High.png`;
            if (code && fs.existsSync(local)) return fs.realpathSync(local);
            break;
          }
        }
      } catch (_) {}
      // Atlas 的 W-Engine 图不少是带文字海报，卡池小图里容易裁切/露字；没有 ZZZ-Plugin 干净图标时宁可只显示名称。
      return '';
    }
    const sprite = this.getZzzCharSprite(name);
    const officialIcon = (() => {
      if (!sprite) return '';
      const circlePath = `./plugins/ZZZ-Plugin/resources/images/role_circle/IconRoleCircle${sprite}.png`;
      if (fs.existsSync(circlePath)) return fs.realpathSync(circlePath);
      const localPath = `./plugins/ZZZ-Plugin/resources/images/role/IconRole${sprite}.png`;
      if (fs.existsSync(localPath)) return fs.realpathSync(localPath);
      return `https://static.nanoka.cc/assets/zzz/IconRole${sprite}.webp`;
    })();
    const panelIcon = this.getZzzPanelIcon(name);
    // UP 小图跟随锅巴“卡池立绘来源”：自定义优先本地立绘，官方优先游戏官方头像。
    if (this.useCustomGachaArt('up') && panelIcon) return panelIcon;
    if (officialIcon) return officialIcon;
    if (panelIcon) return panelIcon;
    const dir = './plugins/Atlas/zzz-atlas/material for role';
    const path = `${dir}/${name}.webp`;
    if (fs.existsSync(path)) return fs.realpathSync(path);
    return '';
  }

  buildZzzHistoryItem(name = '', rarity = 'four', weapon = false, highlightName = '') {
    return {
      name,
      icon: this.getZzzIcon(name, weapon),
      rarity,
      weapon,
      highlight: name === highlightName || String(name).includes(highlightName) || String(highlightName).includes(name)
    };
  }

  getZzzHistoryRarity(name = '', weapon = false, fallback = 'four') {
    return this.getZzzRarityFromMap(name, weapon) || fallback;
  }

  buildZzzHistorySections(records = [], query = '') {
    const map = new Map();
    for (const p of records) {
      const key = `${p.version || '-'}|${this.zzzPoolTime(p)}`;
      if (!map.has(key)) map.set(key, { version: p.version || '-', time: this.zzzPoolTime(p), rows: [] });
      const weapon = p.type === '武器';
      const items = [this.buildZzzHistoryItem(p.s || '-', this.getZzzHistoryRarity(p.s, weapon, 'five'), weapon, query)];
      for (const a of (Array.isArray(p.a) ? p.a : String(p.a || '').split(/[，,/]/).filter(Boolean))) {
        items.push(this.buildZzzHistoryItem(a, this.getZzzHistoryRarity(a, weapon, 'four'), weapon, query));
      }
      map.get(key).rows.push({ title: weapon ? '音擎频段' : '代理人频段', weapon, items, showNames: weapon });
    }
    return [...map.values()].map(sec => ({
      ...sec,
      // 同一期同时展示代理人与专属音擎时，固定代理人频段在上、音擎频段在下。
      // 避免“艾莲卡池”这类结果出现武器 UP 压在角色 UP 上面。
      rows: (sec.rows || []).sort((a, b) => Number(!!a.weapon) - Number(!!b.weapon))
    }));
  }

  async zzzAllPool(e) {
    if (!config().zzz_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中绝区零全卡池:', e.msg);
    const data = await this.fetchZzzPools();
    if (!data) return e.reply('绝区零卡池数据获取失败，请稍后再试。');
    const versions = [...new Set(data.map(p => p.version?.replace(/(上半|下半)$/g, '')).filter(Boolean))].reverse();
    const chunks = versions.map(v => {
      const ps = data.filter(p => p.version?.startsWith(v));
      const lines = [`【v${v}】`];
      for (const p of ps) lines.push(`${p.version} ${this.formatPoolLine(p)}`);
      return lines.join('\n');
    });
    const title = '绝区零全版本卡池记录';
    return this.replyAllPoolForward(e, title, chunks);
  }

  // 全量历史条目多，渲染长图容易超限，统一按版本分组生成文字转发。
  buildAllPoolTextChunks(cards = []) {
    const groups = [];
    const map = new Map();
    for (const c of cards) {
      const v = c.version || '-';
      if (!map.has(v)) { map.set(v, []); groups.push(v); }
      map.get(v).push(c);
    }
    return groups.map(v => {
      const lines = [`【v${String(v).replace(/^v/i, '')}】`];
      for (const c of map.get(v)) {
        const up = [`S-${c.s || '-'}`];
        if (c.a) up.push(`A-${c.a}`);
        // 标题本身已带版本号（如「4.5下半 角色活动跃迁」）时不再重复前缀，既省体积也更易读
        const vStr = String(c.version || v || '');
        const rawTitle = c.title || '卡池';
        const head = !vStr ? rawTitle : (rawTitle.startsWith(vStr) ? rawTitle : `${vStr} ◆ ${rawTitle}`);
        lines.push(`${head}：${up.join(' | ')}`);
      }
      return lines.join('\n');
    });
  }

  // OneBot 对单条转发有总量限制：原神全版本 ~100KB 文本整发会 res_id 上传失败，实测 ~20 节点（约 16KB）一批可发。
  // 策略：按「估算字节 + 节点数」双阈值打包安全批次直接分批发；小数据才尝试单条整发；失败的单批再二分，仍失败退化纯文本。
  static POOL_FORWARD_MAX_BYTES = 16 * 1024;
  static POOL_FORWARD_MAX_NODES = 20;

  async replyAllPoolForward(e, title, chunks = []) {
    if (!chunks.length) return e.reply(`${title}：暂无数据`);
    const totalBytes = chunks.reduce((sum, c) => sum + Buffer.byteLength(String(c)), 0);
    if (chunks.length <= 8 && totalBytes < 20000) return e.reply([title, ...chunks].join('\n'));
    if (chunks.length <= this.constructor.POOL_FORWARD_MAX_NODES && totalBytes < this.constructor.POOL_FORWARD_MAX_BYTES) {
      try {
        return await e.reply(await makeForwardMsg(e, chunks, title));
      } catch (err) {
        logger.warn?.(`[xhh][gacha_pool] ${title} 单条转发失败，改用安全分批:`, err?.message || err);
      }
    }
    const batches = this.packPoolBatches(chunks);
    let idx = 0;
    for (const batch of batches) {
      const label = batches.length > 1 ? `${title}（${++idx}/${batches.length}）` : title;
      try {
        await e.reply(await makeForwardMsg(e, batch, label));
      } catch (err) {
        logger.warn?.(`[xhh][gacha_pool] ${label} 转发失败，尝试对半拆分:`, err?.message || err);
        // 单批失败多半是协议端限流，先等一下再降级，避免连续重试被进一步限流
        await this.sleepMs(600);
        await this.sendForwardSplit(e, batch, label);
      }
      // 批次之间留出间隔，连续发多条转发容易被协议端/风控限流
      if (idx < batches.length) await this.sleepMs(400);
    }
  }

  sleepMs(ms = 300) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 按字节 + 节点数双阈值把版本块打包成安全批次。
  packPoolBatches(chunks = [], maxBytes = this.constructor.POOL_FORWARD_MAX_BYTES, maxNodes = this.constructor.POOL_FORWARD_MAX_NODES) {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const chunk of chunks) {
      const len = Buffer.byteLength(String(chunk));
      if (cur.length && (size + len > maxBytes || cur.length >= maxNodes)) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(chunk);
      size += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async sendForwardSplit(e, chunks, title) {
    if (!chunks.length) return;
    if (chunks.length === 1) {
      return this.sendChunksAsText(e, chunks, title);
    }
    const bytes = chunks.reduce((s, c) => s + Buffer.byteLength(String(c)), 0);
    // 已经失败过一次的批次不再整批重试（多半是总量超限），只有明显更小的批次才再试一次
    if (chunks.length <= 10 && bytes < 8 * 1024) {
      try {
        return await e.reply(await makeForwardMsg(e, chunks, title));
      } catch (err) {
        logger.warn?.(`[xhh][gacha_pool] ${title} 拆分后转发仍失败，退化纯文本:`, err?.message || err);
        return this.sendChunksAsText(e, chunks, title);
      }
    }
    const mid = Math.ceil(chunks.length / 2);
    await this.sendForwardSplit(e, chunks.slice(0, mid), title ? `${title}·上` : '');
    await this.sleepMs(400);
    await this.sendForwardSplit(e, chunks.slice(mid), title ? `${title}·下` : '');
  }

  async sendChunksAsText(e, chunks, title) {
    const text = (title ? title + '\n\n' : '') + chunks.join('\n\n');
    for (let i = 0; i < text.length; i += 2000) {
      try {
        await e.reply(text.slice(i, i + 2000));
        await this.sleepMs(400);
      } catch (err) {
        logger.warn?.(`[xhh][gacha_pool] ${title} 纯文本分段发送失败:`, err?.message || err);
        return;
      }
    }
  }

  async srAllPool(e) {
    if (!config().sr_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中星铁全卡池:', e.msg);
    const srOfficial = await officialPool.fetch('sr');
    const cards = await this.loadSrLocalCards('', srOfficial.records || [], true);
    if (!cards.length) return e.reply('星铁卡池数据获取失败，请稍后再试。');
    const chunks = this.buildAllPoolTextChunks(cards);
    const title = '星铁全版本卡池记录';
    return this.replyAllPoolForward(e, title, chunks);
  }

  async srCurrentPool(e) {
    logger.mark('[xhh][gacha_pool] 命中星铁当前卡池:', e.msg);
    // 优先走本地结构化卡池表，但仍使用“当前卡池”统一卡片样式，和原神/绝区零/崩三保持一致。
    const srOfficial = await officialPool.fetch('sr');
    const localCards = await this.loadSrLocalCards('current', srOfficial.records || []);
    if (localCards.length) {
      return this.renderPoolImage(e, {
        game: '星穹铁道',
        title: '星铁当前卡池',
        subtitle: this.formatCurrentPoolSubtitle(localCards[0]?.version, localCards[0]?.time, `数据来源：米游社公告整理 · v${CURRENT_VERSION.sr}`),
        mode: 'sr',
        markIcon: this.fixedCornerFallback('星穹铁道'),
        markWide: true,
        cards: localCards
      });
    }
    const { records = [], error, cache } = srOfficial || {};
    if (records.length) {
      const cards = records.slice(0, 6).map((r, i) => {
        const card = this.officialCard(r, '星穹铁道');
        card.index = i + 1;
        card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        return card;
      });
      let ver = records.find(r => r.version && r.version !== '-')?.version;
      if (!ver) {
        const srData = this.loadSrPoolHistory();
        if (Array.isArray(srData) && srData.length) ver = srData[0]?.ver || '';
      }
      if (ver) cards.forEach(c => { if (!c.version || c.version === '-') { c.version = ver; c.versionTag = `#${c.index} ${ver}`; } });
      let markIcon = SR_MARK_ICON;
      let markWide = false;
      for (const r of records) {
        const names = [];
        if (Array.isArray(r.up?.s)) names.push(...r.up.s);
        const re = /[「『]([^」』]+)[」』]/g;
        let m; while ((m = re.exec(r.title || ''))) names.push(m[1]);
        if (r.contentText) { re.lastIndex = 0; let cm; while ((cm = re.exec(r.contentText))) names.push(cm[1]); }
        for (const name of names) {
          const splash = this.getSrCharacterSplash(name);
          if (splash) { markIcon = splash; markWide = true; break; }
        }
        if (markIcon !== SR_MARK_ICON) break;
      }
      return this.renderPoolImage(e, {
        game: '星穹铁道',
        title: '星铁当前卡池',
        subtitle: `数据来源：米游社公告${cache ? '（缓存）' : ''}`,
        mode: 'sr',
        markIcon,
        markWide,
        cards
      });
    }
    return e.reply(`星铁米游社公告卡池数据获取失败${error ? '：' + error : ''}`);
  }

  async srVersionPool(e) {
    if (!config().sr_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中星铁版本卡池:', e.msg);
    const m = e.msg.match(/(?:星铁|崩铁|星穹铁道)v?(\d+\.\d+)(上半|下半)?(?:卡池|跃迁)/);
    if (!m) return false;
    const [, version, phase] = m;
    const { records, error, cache } = await officialPool.fetch('sr', { version });
    if (records.length) {
      const filtered = phase ? records.filter(r => (r.title || '').includes(phase) || (r.version || '').includes(phase)) : records;
      const cards = (filtered.length ? filtered : records).map((r, i) => {
        const card = this.officialCard(r, '星穹铁道');
        card.index = i + 1;
        const ver = card.version && card.version !== '-' ? ' ' + card.version : '';
        card.versionTag = `#${card.index}${ver}`;
        return card;
      });
      let markIcon = SR_MARK_ICON;
      let markWide = false;
      for (const r of records) {
        const names = [];
        if (Array.isArray(r.up?.s)) names.push(...r.up.s);
        const re = /[「『]([^」』]+)[」』]/g;
        let m; while ((m = re.exec(r.title || ''))) names.push(m[1]);
        if (r.contentText) { re.lastIndex = 0; let cm; while ((cm = re.exec(r.contentText))) names.push(cm[1]); }
        for (const name of names) {
          const splash = this.getSrCharacterSplash(name);
          if (splash) { markIcon = splash; markWide = true; break; }
        }
        if (markIcon !== SR_MARK_ICON) break;
      }
      return this.renderPoolImage(e, {
        game: '星穹铁道',
        title: `星铁 v${version}${phase || ''} 卡池`,
        subtitle: `数据来源：米游社公告${cache ? '（缓存）' : ''}`,
        mode: 'sr',
        markIcon,
        markWide,
        cards
      });
    }
    const srData = this.loadSrPoolHistory();
    if (Array.isArray(srData) && srData.length) {
      const queryVer = `${version}${phase || ''}`;
      const matched = srData.filter(v => {
        const ver = String(v.ver || '');
        return ver === queryVer || ver.startsWith(version + (phase || ''));
      });
      if (matched.length) {
        return this.renderSrLogs(e, matched);
      }
    }
    return e.reply(`星铁 v${version}${phase || ''} 未找到卡池数据${error ? '：' + error : ''}`);
  }

  async srNameHistory(e) {
    if (!config().sr_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中星铁名称卡池:', e.msg);
    const name = e.msg.replace(/^#*(?:xhh)?(小花火)?(星铁|崩铁|星穹铁道)/, '').replace(/(卡池|跃迁)$/, '').trim();
    if (!name) return false;
    return this.replySrNameHistory(e, name, false);
  }

  async replySrNameHistory(e, name, silent = false) {
    if (!name) return false;
    const srData = this.loadSrPoolHistory();
    if (Array.isArray(srData) && srData.length) {
      const query = this.normalizeSrName(name);
      const matched = srData.filter(v => {
        const jsMatch = (v.js_five || []).includes(query) || (v.js_four || []).includes(query);
        const gzMatch = this.clSrNames(v.gz_five || []).includes(query) || this.clSrNames(v.gz_four || []).includes(query);
        return jsMatch || gzMatch;
      });
      if (matched.length) {
        return this.renderSrLogs(e, matched, query);
      }
    }
    const { records } = await officialPool.fetch('sr');
    const hit = records.filter(r => (r.title || '').includes(name));
    if (!hit.length) return silent ? false : e.reply(`未找到【${name}】的星铁卡池记录。`);
    return this.renderPoolImage(e, {
      game: '星穹铁道',
      title: `${name} 卡池记录`,
      subtitle: `共 ${hit.length} 条记录 · 数据来源：米游社公告`,
      mode: 'sr',
      cards: hit.map(r => this.officialCard(r, '星穹铁道'))
    });
  }

  normalizeSrName(name = '') {
    let query = String(name || '').trim();
    try {
      const jsNames = yaml.get('./plugins/xhh/system/default/sr_js_names.yaml') || {};
      for (const [key, aliases] of Object.entries(jsNames)) {
        if (key === query || (Array.isArray(aliases) && aliases.includes(query))) return key;
      }
      const gzNames = yaml.get('./plugins/xhh/system/default/gz_names.yaml') || {};
      for (const [key, aliases] of Object.entries(gzNames)) {
        if (key === query || (Array.isArray(aliases) && aliases.includes(query))) return key;
      }
    } catch (_) {}
    return query;
  }

  getMiaoProfileImage(name = '', safeCorner = false) {
    const target = String(name || '').replace(/Pro$/i, '').replace('•', '·');
    if (!target) return '';
    const roots = [
      './plugins/miao-plugin/resources/profile/normal-character',
      './plugins/miao-plugin/resources/profile/super-character'
    ];
    for (const root of roots) {
      const dir = `${root}/${target}`;
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir)
          .filter(f => /\.(webp|png|jpg|jpeg)$/i.test(f))
          .filter(f => !safeCorner || this.isSafeCornerSplashFile(`${dir}/${f}`))
          .map(f => ({ f, size: fs.statSync(`${dir}/${f}`).size }))
          .map(v => ({
            ...v,
            score: (() => {
              // miao 的额外图优先用 y 系列/纯数字图，Gu 系列常带字，放最后兜底。
              if (/^y/i.test(v.f)) return 120;
              if (/^\d+\.(webp|png|jpg|jpeg)$/i.test(v.f)) return 100;
              if (!/Gu\d+/i.test(v.f)) return 80;
              return 20;
            })()
          }))
          .sort((a, b) => {
            return b.score - a.score || b.size - a.size;
          });
        if (files.length) {
          const bestScore = files[0].score;
          const pool = files.filter(v => v.score >= Math.max(80, bestScore - 20));
          return fs.realpathSync(`${dir}/${this.randomPick(pool).f}`);
        }
      } catch (_) {}
    }
    return '';
  }

  getSrCharacterIcon(name = '') {
    const names = [name, String(name).replace(/Pro$/i, ''), String(name).replace('•', '·')].filter(Boolean);
    const customFirst = this.useCustomGachaArt('up');
    for (const n of [...new Set(names)]) {
      const profile = this.getMiaoProfileImage(n);
      if (customFirst && profile) return profile;
      const base = `./plugins/miao-plugin/resources/meta-sr/character/${n}/imgs`;
      for (const file of ['face.webp', 'face-q.webp', 'preview.webp', 'card.webp']) {
        const path = `${base}/${file}`;
        if (fs.existsSync(path)) return fs.realpathSync(path);
      }
      if (profile) return profile;
    }
    return '';
  }

  getSrCharacterSplash(name = '') {
    const names = [name, String(name).replace(/Pro$/i, ''), String(name).replace('•', '·')].filter(Boolean);
    const primary = [];
    const fallback = [];
    const profileFallback = [];
    for (const n of [...new Set(names)]) {
      const profile = this.getMiaoProfileImage(n, true);
      const base = `./plugins/miao-plugin/resources/meta-sr/character/${n}/imgs`;
      for (const file of ['splash.webp', 'preview.webp']) {
        const path = `${base}/${file}`;
        if (fs.existsSync(path) && this.isSafeCornerSplashFile(path)) primary.push(fs.realpathSync(path));
      }
      if (this.useCustomGachaArt() && profile) profileFallback.push(profile);
      for (const file of ['card.webp']) {
        const path = `${base}/${file}`;
        if (fs.existsSync(path) && this.isSafeCornerSplashFile(path)) fallback.push(fs.realpathSync(path));
      }
    }
    if (!this.useCustomGachaArt()) {
      for (const n of [...new Set(names)]) {
        const profile = this.getMiaoProfileImage(n, true);
        if (profile) profileFallback.push(profile);
      }
    }
    return this.randomPick(primary) || this.randomPick(profileFallback) || this.randomPick(fallback);
  }

  getSrWeaponIcon(name = '') {
    const root = './plugins/miao-plugin/resources/meta-sr/weapon';
    if (!fs.existsSync(root)) return '';
    const raw = String(name || '');
    const clean = raw.includes('/') ? raw.split('/').pop() : raw;
    const direct = raw.includes('/') ? `${root}/${raw}` : '';
    const candidates = direct ? [direct] : [];
    try {
      for (const type of fs.readdirSync(root)) candidates.push(`${root}/${type}/${clean}`);
    } catch (_) {}
    for (const base of candidates) {
      for (const file of ['icon.webp', 'icon-s.webp', 'splash.webp']) {
        const path = `${base}/${file}`;
        if (fs.existsSync(path)) return fs.realpathSync(path);
      }
    }
    return '';
  }

  buildSrHistoryItem(name = '', rarity = 'four', weapon = false, query = '') {
    const display = weapon ? String(name || '').split('/').pop() : String(name || '');
    const icon = weapon ? this.getSrWeaponIcon(name) : this.getSrCharacterIcon(display);
    const q = this.normalizeSrName(query || '');
    const cq = String(q || '').split('/').pop();
    return {
      name: display,
      icon,
      rarity,
      weapon,
      highlight: !!cq && (display === cq || display.includes(cq) || cq.includes(display))
    };
  }

  buildSrHistorySections(data = [], query = '') {
    if (!Array.isArray(data)) return [];
    const q = this.normalizeSrName(query || '');
    let prevEnd = '';
    return data.map(item => {
      const rows = [];
      let jsFive = item.js_five || [];
      let jsFour = item.js_four || [];
      let gzFive = item.gz_five || [];
      let gzFour = item.gz_four || [];
      if (q) {
        const charIdx = jsFive.indexOf(q);
        const weaponNames = this.clSrNames(gzFive || []);
        const weaponIdx = weaponNames.indexOf(q);
        if (charIdx >= 0) {
          jsFive = [jsFive[charIdx]];
          gzFive = gzFive[charIdx] ? [gzFive[charIdx]] : [];
        } else if (weaponIdx >= 0) {
          jsFive = [];
          jsFour = [];
          gzFive = [gzFive[weaponIdx]];
        } else if ((jsFour || []).includes(q)) {
          jsFive = [];
          jsFour = [q];
          gzFive = [];
          gzFour = [];
        }
      }
      const jsItems = [
        ...jsFive.map(n => this.buildSrHistoryItem(n, 'five', false, query)),
        ...jsFour.map(n => this.buildSrHistoryItem(n, 'four', false, query))
      ];
      if (jsItems.length) rows.push({ title: '角色活动跃迁', weapon: false, items: jsItems });
      const gzItems = [
        ...gzFive.map(n => this.buildSrHistoryItem(n, 'five', true, query)),
        ...gzFour.map(n => this.buildSrHistoryItem(n, 'four', true, query))
      ];
      if (gzItems.length) rows.push({ title: '光锥活动跃迁', weapon: true, items: gzItems });
      const timeRes = this.normalizeSrHistoryTime(item.time || '-', prevEnd);
      prevEnd = timeRes.end || prevEnd;
      return { version: item.ver || '-', time: timeRes.time, rows };
    }).filter(v => v.rows.length);
  }

  getSrOfficialPoolImage(item = {}, weapon = false, records = []) {
    const list = Array.isArray(records) ? records : [];
    if (!list.length) return '';
    const version = String(item.ver || '').replace(/上半|下半/g, '');
    const names = weapon ? this.clSrNames(item.gz_five || []) : (item.js_five || []);
    const clean = v => String(v || '').replace(/[「」『』\s/，,•·]/g, '');
    let best = null;
    let bestScore = -1;
    const isCollab = /^联动/.test(item.ver || '');
    for (const r of list) {
      const imgs = [r.cover, ...(r.images || [])].filter(Boolean);
      if (!imgs.length) continue;
      const text = `${r.title || ''}
${r.contentText || ''}
${r.summary || ''}`;
      const cleanText = clean(text);
      let score = 0;
      // 联动/合作卡池优先使用带「联动」标题的卡池公告图。
      // 「联动跃迁说明」这类标题本质是卡池公告（正文含完整 UP 列表），不应被当作普通「活动说明」减分；
      // 只有既带「说明」又不含卡池词（跃迁/祈愿/频段/补给）的公告图才排除。
      if (isCollab && /联动/.test(r.title || '')) {
        score += (/说明/.test(r.title || '') && !/跃迁|祈愿|频段|补给/.test(r.title || '')) ? -30 : 20;
        // 标题直接带「跃迁」的是卡池公告本体，再额外加分，压过同期的「联动更新公告」。
        if (/跃迁/.test(r.title || '')) score += 5;
      }
      if (version && String(r.version || '').startsWith(version)) score += 8;
      if (/活动跃迁|跃迁/.test(text)) score += 5;
      if (weapon && /光锥|流光定影|真意之汇/.test(text)) score += 3;
      if (!weapon && /角色|拓星启明|铭心之萃/.test(text)) score += 3;
      for (const name of names) if (clean(name) && cleanText.includes(clean(name))) score += 6;
      if (score > bestScore) {
        best = { imgs, score };
        bestScore = score;
      }
    }
    if (!best || bestScore <= 0) return '';
    const imgs = best.imgs.filter((v, i, a) => a.indexOf(v) === i);
    // 联动公告详情接口的 cover 即横幅图（如「Fate[UBW] 联动跃迁说明」的 690x320 横图），
    // 直接取首图；正文第一张（images[0]）反而是竖版封面小图（132x172），不能取。
    if (isCollab) return imgs[0];
    return weapon ? (imgs[1] || imgs[0]) : imgs[0];
  }

  async loadSrLocalCards(type = '', officialRecords = [], all = false) {
    const data = this.loadSrPoolHistory();
    if (!Array.isArray(data)) return [];
    const query = this.normalizeSrName(type);
    const isCurrent = query === 'current';
    const cards = [];
    const currentVersion = CURRENT_VERSION.sr;
    let prevEnd = '';
    let srImgDirty = false;
    for (const item of data) {
      const ver = item.ver || '';
      const timeRes = this.normalizeSrHistoryTime(item.time || '-', prevEnd);
      prevEnd = timeRes.end || prevEnd;
      const now = Date.now();
      const startAt = new Date(String(timeRes.time || '').split('~')[0]?.trim()).getTime();
      const endAt = new Date(String(timeRes.end || '').trim()).getTime();
      // 「~ 长期」的联动池：结束时间解析为 NaN，按「已开始即有效」处理，否则会从当前卡池里消失
      const longTerm = /长期/.test(String(item.time || ''));
      const timeActive = longTerm
        ? (Number.isNaN(startAt) || now >= startAt)
        : (!Number.isNaN(startAt) && !Number.isNaN(endAt) && now >= startAt && now <= endAt);
      const versionHit = !isCurrent && (ver === query || ver.startsWith(query) || ver.replace(/上半|下半/g, '') === query);
      const nameHit = !isCurrent && (
        (item.js_five || []).includes(query) ||
        (item.js_four || []).includes(query) ||
        this.clSrNames(item.gz_five || []).includes(query) ||
        this.clSrNames(item.gz_four || []).includes(query)
      );
      // 当前卡池：只看「正在开放」的，不能按版本号放行——
      // 4.5下半开放后，同版本的 4.5上半 已过期，必须让位（否则上半会一直挂在当前卡池里）。
      // 时间解析不出（如缺 start/end）时才用当前版本号兜底，避免本地库缺时间导致当前卡池空白。
      const timeParsed = !Number.isNaN(startAt) && !Number.isNaN(endAt);
      const keepForCurrent = timeActive || (ver.startsWith(currentVersion) && !timeParsed);
      if (isCurrent && !keepForCurrent) continue;
      if (!all && !isCurrent && !versionHit && !nameHit) continue;
      const itemImgs = (item.imgs || []).filter(Boolean);
      const isCollab = /^联动/.test(ver);
      // 联动/普通卡池统一优先使用官方公告图做背景：cover 与公告正文大图均为 690x320 横图，
      // 适合铺满卡片；只有官方图缺失时才退到本地角色 splash，都没有则留空由模板显示纯渐变。
      let officialRoleBg = itemImgs[0] || this.getSrOfficialPoolImage(item, false, officialRecords) || '';
      // 本地库和当前公告列表都没有封面时（旧版本/已过期池），用官方号搜索接口找回，并写回本地库
      if (!officialRoleBg && isCurrent) {
        const found = await this.srSearchPoolImages(ver, item.js_five || [], false);
        if (found) {
          officialRoleBg = found;
          item.imgs = [found, ...itemImgs].slice(0, 2);
          srImgDirty = true;
        }
      }
      // 光锥公告图经常自带大标题文字，和卡片标题重叠；当前卡池统一使用同一期角色公告图做弱化背景。
      const officialWeaponBg = officialRoleBg || itemImgs[1] || this.getSrOfficialPoolImage(item, true, officialRecords);
      const roleBg = officialRoleBg || this.getSrCharacterSplash((item.js_five || [])[0]) || this.getSrCharacterSplash((item.js_five || [])[1]) || '';
      const roleUp = (item.js_five || []).join(' / ');
      cards.push({
        version: ver,
        title: (isCollab ? '联动跃迁' : (isCurrent ? '角色活动跃迁' : `${ver} 角色活动跃迁`)) + (roleUp ? `「${roleUp}」` : ''),
        type: '星穹铁道',
        time: timeRes.time,
        s: roleUp,
        a: (item.js_four || []).join(' / '),
        img: roleBg,
        weapon: false,
        collab: isCollab
      });
      const gzUp = this.clSrNames(item.gz_five || []).join(' / ');
      cards.push({
        version: ver,
        title: (isCollab ? '联动光锥跃迁' : (isCurrent ? '光锥活动跃迁' : `${ver} 光锥活动跃迁`)) + (gzUp ? `「${gzUp}」` : ''),
        type: '星穹铁道',
        time: timeRes.time,
        s: gzUp,
        a: this.clSrNames(item.gz_four || []).join(' / '),
        img: officialWeaponBg || roleBg,
        weapon: true,
        collab: isCollab
      });
      if (!all && (isCurrent || versionHit)) continue;
    }
    // 搜索接口找回的封面写回本地库，避免每次渲染都现拉
    if (srImgDirty) {
      try {
        fs.writeFileSync(SR_POOL_HISTORY_YAML_PATH, YAML.stringify(data), 'utf-8');
      } catch (err) {
        logger.error('[xhh][gacha_pool] sr_logs.yaml 封面写回失败:', err);
      }
    }
    if (isCurrent) {
      // 联动池是长期开放（相当于常驻），排到末尾，避免把常规版本（如 4.5）的当期卡池挤到后面。
      // 比较符方向：a 有 collab 返回正数 → a 排后面；稳定排序，非联动卡保持原有（版本）顺序
      cards.sort((a, b) => Number(!!a.collab) - Number(!!b.collab));
    }
    return cards;
  }

  clSrNames(arr = []) {
    // 「欢愉」是 4.5 新增命途，也必须一并清洗，否则「欢愉/向浪花掷下盛夏」会变成「欢愉向浪花掷下盛夏」
    return arr.map(v => String(v).replace(/\/|欢愉|智识|记忆|虚无|同谐|丰饶|毁灭|巡猎|存护|，|,|!|！|」|「/g, ''));
  }

  // 原神当前卡池封面与「米游社卡池」视图对齐：本地库缺公告图时用立绘/武器合成图兜底，
  // 会和米游社视图（官方公告 banner）不一致。这里用官方公告封面覆盖回来。
  applyGsOfficialCovers(cards = [], records = []) {
    if (!Array.isArray(cards) || !cards.length) return cards;
    const ver = String(cards[0]?.version || '').replace(/^v/i, '');
    const banners = (records || []).filter(r => {
      if (ver && r.version && String(r.version).replace(/^v/i, '') !== ver) return false;
      return /概率UP|祈愿|神铸赋形/.test(r.title || '');
    });
    if (!banners.length) return cards;
    const used = new Set();
    const keyOf = r => r.postId || r.id || `${r.title || ''}|${r.cover || ''}`;
    for (const card of cards) {
      const ups = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
      if (!ups.length) continue;
      let hit = null;
      for (const up of ups) {
        hit = banners.find(r => (r.title || '').includes(up) && !used.has(keyOf(r)));
        if (hit) break;
      }
      const img = hit ? (hit.images?.[0] || hit.cover || '') : '';
      if (!img) continue;
      used.add(keyOf(hit));
      card.img = img;
      card.imgFallback = false;
    }
    return cards;
  }

  // 远程图片宽高比（w/h）：解析 PNG/JPEG 文件头即可，不用整图下载；失败返回 0
  async remoteImgAspect(url = '') {
    if (!url) return 0;
    if (MYS_ASPECT_CACHE.has(url)) return MYS_ASPECT_CACHE.get(url);
    let aspect = 0;
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-4095', Referer: 'https://www.miyoushe.com', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(6000)
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
        // PNG: IHDR 固定在 16~23 字节
        aspect = buf.readUInt32BE(16) / buf.readUInt32BE(20);
      } else if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
        // JPEG: 扫 SOFn 段
        let off = 2;
        while (off + 9 < buf.length) {
          if (buf[off] !== 0xFF) { off++; continue; }
          const marker = buf[off + 1];
          if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
            aspect = buf.readUInt16BE(off + 7) / buf.readUInt16BE(off + 5);
            break;
          }
          off += 2 + buf.readUInt16BE(off + 2);
        }
      }
    } catch (_) {}
    aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 0;
    MYS_ASPECT_CACHE.set(url, aspect);
    return aspect;
  }

  // 米游社公告列表（getNewsList）经常不带封面，官方视图会渲染成纯色卡。
  // 用官方号搜索接口按 UP 名找回公告 banner。公告正文常有多张图（第 1 张往往是竖版角色特写，
  // 直接 cover 填进横卡会被放大裁切），所以按实际宽高比挑最接近卡片比例（460:205 ≈ 2.24）的横图。
  // force=true 时连「立绘/合成图兜底」的封面也一并替换（这些是竖版图，塞进横卡面会被放大裁成特写）
  async attachGsOfficialCovers(cards = [], force = false) {
    if (!Array.isArray(cards) || !cards.length) return cards;
    const used = new Set();
    for (const card of cards) {
      if (card.img && (!force || !card.imgFallback)) continue;
      const names = String(card.s || '').split(/[\/，,、]/).map(v => v.trim()).filter(Boolean);
      const keywords = [...names, String(card.title || '').replace(/的概率UP.*$/, '').trim()].filter(Boolean);
      let picked = '';
      for (const kw of keywords) {
        // 祈愿公告一般 2 张图：索引 0 角色池、索引 1 武器池，武器池优先取 1
        const cands = await this.mysSearchImages('gs', kw, card.weapon ? [1, 0, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7]);
        let best = '', bestScore = Infinity;
        for (const u of cands || []) {
          if (!u || used.has(u)) continue;
          const a = await this.remoteImgAspect(u);
          // 非横图（竖版特写/方形图）大幅降权，避免被放大裁切
          const score = a >= 1.6 ? Math.abs(a - 2.24) : 10 + Math.abs(a - 2.24);
          if (score < bestScore) { bestScore = score; best = u; }
        }
        if (best) { picked = best; break; }
      }
      if (picked) {
        card.img = picked;
        used.add(picked);
      }
    }
    return cards;
  }

  async gsCurrentPool(e) {
    logger.mark('[xhh][gacha_pool] 命中原神当前卡池:', e.msg);
    // 当前卡池优先走本地结构化数据，避免米游社公告缓存/公告顺序导致 #原神卡池 显示过期信息。
    const localCards = await this.loadGsLocalCards('current');
    if (localCards.length) {
      // 本地 yaml 缺失四星时，用公告自动解析兜底补齐（任意版本自动适配）
      await this.patchGsCardsHardcoded(localCards);
      // 封面统一走米游社：本地库缺公告图/武器池用合成图时，用官方公告封面覆盖，
      // 保证与「米游社卡池」视图同池同封面
      try {
        const { records } = await officialPool.fetch('gs');
        if (records?.length) this.applyGsOfficialCovers(localCards, records);
      } catch (_) {}
      // 米游社列表常不含祈愿公告，此时用搜索接口按 UP 名补横版公告图，避免退回竖版立绘
      await this.attachGsOfficialCovers(localCards, true);
      localCards.forEach((card, i) => {
        card.index = i + 1;
        card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
      });
      const markIcon = this.getHeaderSplashFromCards('原神', localCards, GS_MARK_ICON);
      return this.renderPoolImage(e, {
        game: '原神',
        title: '原神当前卡池',
        subtitle: this.formatCurrentPoolSubtitle(localCards[0]?.version, localCards[0]?.time, `本地卡池库 · v${CURRENT_VERSION.gs}`),
        mode: 'gs',
        markIcon,
        markWide: !!markIcon,
        cards: localCards
      });
    }
    const { records, error, cache } = await officialPool.fetch('gs');
    if (!records.length) {
      return e.reply(`原神米游社公告卡池数据获取失败${error ? '：' + error : ''}`);
    }
    const cards = records.slice(0, 4).map((r, i) => {
      const card = this.officialCard(r, '原神');
      card.index = i + 1;
      card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
      return card;
    });
    const gsLocalCurrent = await this.loadGsLocalCards('current');
    // 官方公告若没解析出 4 星，用本地库同池数据兜底补齐
    await this.patchGsOfficialCards(cards, gsLocalCurrent);
    const localCurrentVersion = gsLocalCurrent.find(c => c.version && c.version !== '-')?.version || '';
    const verFromApi = localCurrentVersion || records.find(r => r.version && r.version !== '-')?.version || '';
    this.applyCardVersion(cards, verFromApi);
    let markIcon = GS_MARK_ICON;
    let markWide = false;
    for (const r of records) {
      const names = [];
      if (Array.isArray(r.up?.s)) names.push(...r.up.s);
      const re = /[「『]([^」』]+)[」』]/g;
      let m;
      while ((m = re.exec(r.title || ''))) names.push(m[1]);
      if (r.contentText) {
        re.lastIndex = 0;
        let cm; while ((cm = re.exec(r.contentText))) names.push(cm[1]);
      }
      for (const name of names) {
        const splash = this.getGsCharacterSplash(name);
        if (splash) { markIcon = splash; markWide = true; break; }
      }
      if (markIcon !== GS_MARK_ICON) break;
    }
    return this.renderPoolImage(e, {
      game: '原神',
      title: '原神当前卡池',
      subtitle: this.formatCurrentPoolSubtitle(verFromApi, gsLocalCurrent[0]?.time, `数据来源：米游社公告${cache ? '（缓存）' : ''}`),
      mode: 'gs',
      markIcon,
      markWide,
      cards
    });
  }

  async gsVersionPool(e) {
    logger.mark('[xhh][gacha_pool] 命中原神版本卡池:', e.msg);
    const m = e.msg.match(/原神v?(\d+\.\d+)(上半|下半)?卡池/);
    if (!m) return false;
    const [, version, phase] = m;
    const { records, error, cache } = await officialPool.fetch('gs', { version });
    if (!records.length) {
      const localCards = await this.loadGsLocalCards(`${version}${phase || ''}`);
      if (localCards.length) {
        localCards.forEach((card, i) => {
          card.index = i + 1;
          card.versionTag = `#${card.index}${card.version && card.version !== '-' ? ' ' + card.version : ''}`;
        });
        const markIcon = this.getHeaderSplashFromCards('原神', localCards, GS_MARK_ICON);
        return this.renderPoolImage(e, {
          game: '原神',
          title: `原神 v${version}${phase || ''} 卡池`,
          subtitle: '本地历史卡池库',
          mode: 'gs',
          markIcon,
          markWide: !!markIcon,
          cards: localCards
        });
      }
      return e.reply(`原神 v${version} 未找到米游社官方卡池公告${error ? '：' + error : ''}`);
    }
    const cards = records.map((r, i) => {
      const card = this.officialCard(r, '原神');
      card.index = i + 1;
      const ver = card.version && card.version !== '-' ? ' ' + card.version : '';
      card.versionTag = `#${card.index}${ver}`;
      return card;
    });
    // 官方公告若没解析出 4 星，用本地库同池数据兜底补齐
    await this.patchGsOfficialCards(cards);
    let markIcon = GS_MARK_ICON;
    let markWide = false;
    for (const r of records) {
      const names = [];
      if (Array.isArray(r.up?.s)) names.push(...r.up.s);
      const re = /[「『]([^」』]+)[」』]/g;
      let m;
      while ((m = re.exec(r.title || ''))) names.push(m[1]);
      if (r.contentText) {
        re.lastIndex = 0;
        let cm; while ((cm = re.exec(r.contentText))) names.push(cm[1]);
      }
      for (const name of names) {
        const splash = this.getGsCharacterSplash(name);
        if (splash) { markIcon = splash; markWide = true; break; }
      }
      if (markIcon !== GS_MARK_ICON) break;
    }
    return this.renderPoolImage(e, {
      game: '原神',
      title: `原神 v${version}${phase || ''} 官方卡池`,
      subtitle: `数据来源：米游社公告${cache ? '（缓存）' : ''}`,
      mode: 'gs',
      markIcon,
      markWide,
      cards
    });
  }

  async gsNameHistory(e) {
    logger.mark('[xhh][gacha_pool] 命中原神名称卡池:', e.msg);
    const name = e.msg.replace(/^#*(?:xhh)?(小花火)?原神/, '').replace(/卡池$/, '').trim();
    if (!name) return false;
    return this.replyGsNameHistory(e, name, false);
  }

  async replyGsNameHistory(e, name, silent = false) {
    if (!name) return false;
    const query = this.normalizeGsName(name);
    // 特定角色/武器卡池优先使用本地历史库，渲染成“版本 + 时间 + UP头像行”的时间轴样式。
    const sections = await this.loadGsHistorySections(query);
    if (sections.length) {
      return this.renderGsLogs(e, sections);
    }
    const { records, error, cache } = await officialPool.fetch('gs');
    if (!records.length) return silent ? false : e.reply(`原神米游社公告卡池数据获取失败${error ? '：' + error : ''}`);
    const hit = records.filter(r => {
      const t = r.title || '';
      return t.includes(query) || t.includes(name);
    });
    if (!hit.length) return silent ? false : e.reply(`未找到【${query}】的原神卡池记录。`);
    const cards = hit.map(r => this.officialCard(r, '原神'));
    const markIcon = this.getHeaderSplashFromCards('原神', cards, GS_MARK_ICON);
    return this.renderPoolImage(e, {
      game: '原神',
      title: `${query} 卡池记录`,
      subtitle: `共 ${hit.length} 条记录 · 数据来源：米游社公告${cache ? '（缓存）' : ''}`,
      mode: 'gs',
      markIcon,
      markWide: markIcon !== GS_MARK_ICON,
      cards
    });
  }

  normalizeGsName(name = '') {
    let query = String(name || '').trim();
    try {
      const gsnames = yaml.get('./plugins/xhh/system/default/gs_js_names.yaml') || {};
      for (const [key, aliases] of Object.entries(gsnames)) {
        if (Array.isArray(aliases) && aliases.includes(query)) return key;
      }
      const wqnames = yaml.get('./plugins/xhh/system/default/wqname.yaml') || {};
      for (const [key, aliases] of Object.entries(wqnames)) {
        if (Array.isArray(aliases) && aliases.includes(query)) return key;
      }
    } catch (_) {}
    return query;
  }

  getGsCharacterSplash(name = '', opts = {}) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const candidates = [raw];
    // 去掉 (元素) 后缀
    const noElem = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
    if (noElem !== raw) candidates.push(noElem);
    // 去掉 ·前的称号前缀（如 "镜水析谬·桑多涅" → "桑多涅"）
    const afterDot = noElem.split('·').pop().trim();
    if (afterDot && afterDot !== noElem) candidates.push(afterDot);
    const afterHdot = noElem.split('•').pop().trim();
    if (afterHdot && afterHdot !== noElem && afterHdot !== afterDot) candidates.push(afterHdot);
    const primary = [];
    const custom = [];
    const fallback = [];
    for (const n of candidates) {
      for (const ext of ['.webp', '.png', '.jpg']) {
        const p = `./plugins/xhh/resources/gslogs/imgs/${n}${ext}`;
        if (fs.existsSync(p) && this.isSafeCornerSplashFile(p)) custom.push(fs.realpathSync(p));
      }
      const profile = this.getMiaoProfileImage(n, true);
      const metaBase = `./plugins/miao-plugin/resources/meta-gs/character/${n}/imgs`;
      for (const file of ['gacha.webp', 'splash.webp', 'side.webp']) {
        const path = `${metaBase}/${file}`;
        if (fs.existsSync(path) && this.isSafeCornerSplashFile(path)) primary.push(fs.realpathSync(path));
      }
      if (this.useCustomGachaArt() && profile) custom.push(profile);
      for (const file of ['card.webp', 'face.webp', 'face-q.webp', 'face0.webp']) {
        const path = `${metaBase}/${file}`;
        if (fs.existsSync(path) && this.isSafeCornerSplashFile(path)) fallback.push(fs.realpathSync(path));
      }
    }
    if (!this.useCustomGachaArt()) {
      for (const n of candidates) {
        const profile = this.getMiaoProfileImage(n, true);
        if (profile) custom.push(profile);
      }
    }
    // noFace：整卡背景场景丢弃 face/card 小头像档，避免低清头像被拉伸成背景发糊。
    return this.randomPick(primary) || this.randomPick(custom) || (opts.noFace ? '' : this.randomPick(fallback));
  }

  getGsCharacterIcon(name = '') {
    const profile = this.getMiaoProfileImage(name);
    if (this.useCustomGachaArt('up') && profile) return profile;
    const base = `./plugins/miao-plugin/resources/meta-gs/character/${name}/imgs`;
    for (const file of ['face.webp', 'face-q.webp', 'face0.webp', 'card.webp']) {
      const path = `${base}/${file}`;
      if (fs.existsSync(path)) return fs.realpathSync(path);
    }
    if (profile) return profile;
    return '';
  }

  getGsWeaponIcon(name = '') {
    const base = this.getGsWeaponBase(name);
    if (!base) return '';
    for (const file of ['icon.webp', 'gacha.webp', 'awaken.webp']) {
      const path = `${base}/${file}`;
      if (fs.existsSync(path)) return fs.realpathSync(path);
    }
    return '';
  }

  getGsWeaponBase(name = '') {
    const root = './plugins/miao-plugin/resources/meta-gs/weapon';
    if (!fs.existsSync(root)) return '';
    try {
      for (const type of fs.readdirSync(root)) {
        const base = `${root}/${type}/${name}`;
        if (fs.existsSync(base) && fs.statSync(base).isDirectory()) return base;
      }
    } catch (_) {}
    return '';
  }

  isGsWeaponPool(names = []) {
    const arr = (Array.isArray(names) ? names : []).filter(Boolean);
    return arr.length > 0 && arr.every(n => !!this.getGsWeaponBase(n));
  }

  isGsMixedPool(names = []) {
    const arr = (Array.isArray(names) ? names : []).filter(Boolean);
    return arr.some(n => !!this.getGsWeaponBase(n)) && arr.some(n => !this.getGsWeaponBase(n));
  }

  buildGsHistoryItem(name = '', rarity = 'four', weapon = false, highlight = false) {
    const icon = weapon ? this.getGsWeaponIcon(name) : this.getGsCharacterIcon(name);
    return { name, icon, rarity, weapon, highlight };
  }

  // 按池类型切分本地行：角色池 1五星+3四星；武器池 2五星+5四星；集录祈愿 全五星。
  gsPoolParts(arr = [], weapon = false, mixed = false) {
    if (weapon) return { s: arr.slice(0, 2).join(' / '), a: arr.slice(2).join(' / ') };
    if (mixed) return { s: arr.join(' / '), a: '' };
    return { s: arr[0] || '', a: arr.slice(1).join(' / ') };
  }

  // 武器池背景图：优先取武器本身的卡池图/立绘（gacha.webp > awaken.webp > icon.webp），
  // 避免直接套用角色活动 key visual（米游社武器公告封面往往是当期角色立绘）导致和角色池撞图。
  // 找不到武器本地资源时返回空串，交由调用方保留公告封面兜底。
  gsWeaponPoolImg(arr = []) {
    const list = Array.isArray(arr) ? arr : [];
    const wname = list.find(n => this.getGsWeaponBase(n)) || list[0] || '';
    const base = this.getGsWeaponBase(wname);
    if (!base) return '';
    for (const f of ['gacha.webp', 'awaken.webp', 'icon.webp']) {
      const p = `${base}/${f}`;
      if (fs.existsSync(p)) return fs.realpathSync(p);
    }
    return '';
  }

  async loadGsHistorySections(type = '') {
    const data = this.loadGsPoolHistory();
    if (!data?.date) return [];
    const query = this.normalizeGsName(type);
    const sections = [];
    for (const [dateKey, lines = []] of Object.entries(data.date)) {
      const pools = lines.map(line => String(line || '').split(',').map(v => v.trim()).filter(Boolean));
      if (!pools.some(arr => arr.includes(query))) continue;
      const version = dateKey.match('【(.*)】')?.[1] || '';
      const time = this.formatGsHistoryTime(dateKey);
      const hasCharMatch = pools.some(arr => arr.includes(query) && !this.isGsWeaponPool(arr) && !this.isGsMixedPool(arr));
      const rows = pools.map((arr, idx) => {
        const weapon = this.isGsWeaponPool(arr);
        const mixed = this.isGsMixedPool(arr);
        if (!arr.includes(query) && !(hasCharMatch && weapon)) return null;
        const title = weapon ? '武器活动祈愿' : (mixed || idx === 3 ? '集录祈愿' : '角色活动祈愿');
        return {
          title,
          weapon,
          items: arr.map((n, i) => {
            const itemWeapon = weapon || (mixed && !!this.getGsWeaponBase(n));
            const rarity = mixed ? 'five' : (i === 0 || (weapon && i < 2) ? 'five' : 'four');
            return this.buildGsHistoryItem(n, rarity, itemWeapon, n === query);
          })
        };
      }).filter(row => row?.items?.length);
      sections.push({ version, time, rows });
    }
    return sections;
  }

  async loadGsLocalCards(type = '', all = false) {
    const data = this.loadGsPoolHistory();
    if (!data?.date) return [];
    const query = this.normalizeGsName(type);
    const cards = [];
    const entries = Object.entries(data.date);
    const isCurrent = query === 'current';
    const pushGsCard = (dateKey, names, ver, customTitle = '') => {
      const imgs = (data.imgs || {})[`【${ver}】`] || [];
      const time = this.formatGsHistoryTime(dateKey);
      names.forEach((line, i) => {
        const arr = String(line).split(',').map(v => v.trim()).filter(Boolean);
        if (!arr.length) return;
        const weapon = this.isGsWeaponPool(arr);
        const mixed = this.isGsMixedPool(arr) || i === 3;
        let img = imgs[i] || '';
        // imgFallback：本地库没配公告图、用的是本地资源拼出来的立绘（后续可被官方公告封面覆盖）
        let imgFallback = false;
        if (!img) {
          const firstName = arr.slice(0, 2).find(n => !this.getGsWeaponBase(n));
          img = firstName ? this.getGsCharacterSplash(firstName, { noFace: true }) || this.getGsWeaponIcon(firstName) : '';
          imgFallback = true;
        }
        // 武器池优先用武器本身卡池图，避免套用角色活动 key visual 与角色池撞图
        if (weapon) {
          const wImg = this.gsWeaponPoolImg(arr);
          if (wImg) { img = wImg; imgFallback = true; }
        }
        const parts = this.gsPoolParts(arr, weapon, mixed);
        // 标题带上 UP 名（如 角色活动祈愿「薇斯纳」），避免同版本多条卡片全是同名泛称。
        const baseTitle = weapon ? '武器活动祈愿' : (mixed ? '集录祈愿' : '角色活动祈愿');
        cards.push({
          version: ver,
          title: customTitle || (parts.s ? `${baseTitle}「${parts.s.split(' / ').join('/')}」` : baseTitle),
          type: '原神',
          time,
          s: parts.s,
          a: parts.a,
          img,
          imgFallback,
          weapon
        });
      });
    };
    if (isCurrent) {
      // 当前卡池：按时间区间匹配当前生效的池子；同一版本出现多条记录时，
      // 自动优先保留四星更完整的一条，避免“只有五星没四星”的重复记录顶掉完整数据。
      const now = new Date();
      const parsed = entries
        .map(([dateKey, names]) => {
          const ver = dateKey.match('【(.*)】')?.[1] || '';
          const { start, end } = this.parseGsDateKey(dateKey);
          return { dateKey, names, ver, start, end };
        })
        .filter(v => v.ver);
      const matched = parsed.filter(v => v.start && v.end && now >= v.start && now <= v.end);
      // 兜底时跳过「未上线版本的预录条目」（版本号大于当前版本且无有效开始时间），避免预告期被当成当前卡池
      const pool = matched.length ? matched
        : parsed.filter(v => !(Number(v.ver) > Number(CURRENT_VERSION.gs || 0) && !v.start)).slice(0, 1);
      const best = new Map();
      for (const item of pool) {
        const prev = best.get(item.ver);
        if (!prev) { best.set(item.ver, item); continue; }
        if (this.gsPoolFourStarCount(item.names) > this.gsPoolFourStarCount(prev.names)) best.set(item.ver, item);
      }
      // 排查用：打印 imgs 库内实际键名与查询键，定位「有图但取不到」的键不匹配问题
      logger.mark('[xhh][gacha_pool] 当前卡池 imgs 匹配:',
        [...best.values()].map(v => `【${v.ver}】=> ${(data.imgs?.[`【${v.ver}】`] || []).length} 张`).join(', '),
        '| 库内 imgs 键:', Object.keys(data.imgs || {}).join(', ') || '(空)');
      for (const { dateKey, names, ver } of best.values()) pushGsCard(dateKey, names, ver);
    } else {
      for (const [dateKey, names] of entries) {
        const ver = dateKey.match('【(.*)】')?.[1] || '';
        if (!ver) continue;
        const versionHit = ver === query || ver.startsWith(query) || ver.replace(/上半|下半/g, '') === query;
        if (versionHit || all) {
          pushGsCard(dateKey, names, ver);
          continue;
        }
        names.forEach((line, i) => {
          const arr = String(line).split(',').map(v => v.trim()).filter(Boolean);
          if (!arr.includes(query)) return;
          const weapon = this.isGsWeaponPool(arr);
          const mixed = this.isGsMixedPool(arr) || i === 3;
          const imgs = (data.imgs || {})[`【${ver}】`] || [];
          const time = this.formatGsHistoryTime(dateKey);
          let img = imgs[i] || '';
          if (!img) {
            const firstName = arr.slice(0, 2).find(n => !this.getGsWeaponBase(n));
            img = firstName ? this.getGsCharacterSplash(firstName, { noFace: true }) || this.getGsWeaponIcon(firstName) : '';
          }
          // 武器池优先用武器本身卡池图，避免套用角色活动 key visual 与角色池撞图
          if (weapon) img = this.gsWeaponPoolImg(arr) || img;
          const parts = this.gsPoolParts(arr, weapon, mixed);
          cards.push({
            version: ver,
            title: `${query} 卡池`,
            type: weapon ? '武器祈愿' : (mixed ? '集录祈愿' : '角色祈愿'),
            time,
            s: parts.s,
            a: parts.a,
            img,
            weapon
          });
        });
      }
    }
    // 官方号搜索接口兜底：本地库/本地立绘都没有封面时，按「版本+祈愿」或 UP 名去官方号取图
    // （原神祈愿公告有 2 张图：索引 0 角色池、索引 1 武器池）
    let gsSearched = 0;
    for (const card of cards) {
      if (card.img || gsSearched >= 4) continue;
      const ver = String(card.version || '').replace(/上半|下半/g, '');
      const upName = String(card.s || '').split(/[\/，,、]/)[0]?.trim();
      for (const kw of [ver ? `${ver}版本祈愿` : '', upName].filter(Boolean)) {
        gsSearched++;
        const got = await this.mysSearchImages('gs', kw, card.weapon ? [1, 0] : [0]);
        if (got.length) {
          card.img = got[0];
          card.imgFallback = true;
          break;
        }
      }
    }
    // 武器卡/兜底卡没背景图时，复用同版本第一张非武器卡的公告图，避免纯色空卡。
    let sharedBg = '';
    for (const card of cards) {
      if (!card.weapon && card.img) { sharedBg = card.img; break; }
    }
    if (sharedBg) {
      for (const card of cards) {
        if (card.weapon && !card.img) card.img = sharedBg;
      }
    }
    return cards;
  }

  parseGsDateKey(dateKey = '') {
    const raw = String(dateKey || '').replace(/^【.*?】/, '').trim();
    const [start, end] = raw.split('~').map(v => v?.trim()).filter(Boolean);
    if (!start || !end) return { start: null, end: null };
    const s = new Date(this.ensureFullTime(start, true));
    const e = new Date(this.ensureFullTime(end, false));
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { start: null, end: null };
    return { start: s, end: e };
  }

  // 统计某版本条目里带四星的行数，用于同版本多条记录时选择数据更完整的一条。
  gsPoolFourStarCount(names = []) {
    let cnt = 0;
    for (const line of names) {
      const arr = String(line || '').split(',').map(v => v.trim()).filter(Boolean);
      if (!arr.length) continue;
      const weapon = this.isGsWeaponPool(arr);
      const mixed = this.isGsMixedPool(arr);
      const parts = this.gsPoolParts(arr, weapon, mixed);
      if (parts.a) cnt++;
    }
    return cnt;
  }

  async gsAllPool(e) {
    logger.mark('[xhh][gacha_pool] 命中原神全卡池:', e.msg);
    // 全量历史条目多，长图渲染易超限失败，统一改为文字转发（与绝区零全卡池一致）。
    let cards = await this.loadGsLocalCards('', true);
    let source = '';
    if (!cards.length) {
      const { records, error } = await officialPool.fetch('gs');
      if (!records.length) return e.reply(`原神卡池数据获取失败${error ? '：' + error : ''}`);
      cards = records.map(r => this.officialCard(r, '原神'));
      source = ' · 米游社公告';
    }
    const chunks = this.buildAllPoolTextChunks(cards);
    const title = `原神全版本卡池记录${source}`;
    return this.replyAllPoolForward(e, title, chunks);
  }

  async attachBh3OfficialCovers(cards = []) {
    try {
    const { records } = await officialPool.fetch('bh3');
      if (!records?.length) return cards;
      const coverOf = r => r.cover || r.images?.[0] || '';
      for (const card of cards) {
        if (card.img) continue;
        const names = [card.s, card.title].map(v => this.cleanBh3Name(v)).filter(Boolean);
        const hit = records.find(r => {
          const text = this.cleanBh3Name(`${r.title || ''} ${r.summary || ''} ${r.contentText || ''}`);
          return names.some(n => n && text.includes(n));
        });
        const cover = hit ? coverOf(hit) : '';
        if (cover) card.img = cover;
      }
    } catch (err) {
      logger.warn?.('[xhh][gacha_pool] 崩三官方补给封面匹配失败:', err);
    }
    return cards;
  }

  async bh3CurrentPool(e) {
    logger.mark('[xhh][gacha_pool] 命中崩三补给菜单:', e.msg);
    const local = await this.loadBh3CurrentPools();
    if (local.length) {
      local.forEach((c, i) => { c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; });
      await this.attachBh3OfficialCovers(local);
      const markIcon = await this.getBh3HeaderSplashFromPools(local, BH3_MARK_ICON);
      let markWide = true;
      return this.renderPoolImage(e, {
        game: '崩坏3',
        title: '崩坏3当前卡池',
        subtitle: this.formatCurrentPoolSubtitle(local[0]?.version, local[0]?.time, `v${CURRENT_VERSION.bh3} · 本地补给记录`),
        mode: 'bh3',
        markIcon,
        markWide,
        cards: local
      });
    }
    // 本地无当前数据，走米游社公告接口
    const { records } = await officialPool.fetch('bh3');
    if (!records?.length) return e.reply('崩坏3当前卡池数据暂不可用。');
    const cards = records.map(r => this.officialCard(r, '崩坏3'));
    const markIcon = BH3_MARK_ICON;
    return this.renderPoolImage(e, {
      game: '崩坏3',
      title: '崩坏3当前卡池',
      subtitle: `v${CURRENT_VERSION.bh3} · 米游社公告`,
      mode: 'bh3',
      markIcon,
      markWide: true,
      cards
    });
  }

  async loadBh3PoolHistory() {
    try {
      // 优先读取 YAML，方便后续手动修正；JSON 仅作为兼容兜底。
      let data;
      if (fs.existsSync(BH3_POOL_HISTORY_YAML_PATH)) {
        try { data = yaml.get(BH3_POOL_HISTORY_YAML_PATH); } catch (_) { data = undefined; }
      }
      if (!data && fs.existsSync(BH3_POOL_HISTORY_PATH)) {
        try { data = yaml.get(BH3_POOL_HISTORY_PATH); } catch (_) { data = undefined; }
      }
      // 兜底：yaml.get 解析异常时改用原生 YAML 解析器直接读取，避免整个本地库加载失败（曾导致同步误报 v0）。
      if (!data) {
        try { data = YAML.parse(fs.readFileSync(BH3_POOL_HISTORY_YAML_PATH, 'utf-8')); } catch (_) {}
      }
      return this.sanitizeBh3PoolHistory(data);
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 崩三历史卡池数据加载失败:', err);
      return null;
    }
  }

  sanitizeBh3PoolHistory(data) {
    if (!data?.pools?.length) return data;
    const charNames = new Set();
    try {
      const names = yaml.get('./plugins/xhh/system/default/bh3_js_names.yaml') || {};
      for (const [suit, aliasesRaw] of Object.entries(names)) {
        charNames.add(this.cleanBh3Name(suit));
        for (const alias of (Array.isArray(aliasesRaw) ? aliasesRaw : [])) charNames.add(this.cleanBh3Name(alias));
      }
    } catch (_) {}
    const isInvalidWeapon = pool => {
      if (pool?.type !== 'weapon' || pool?.target) return false;
      const s = this.cleanBh3Name(pool.s);
      // 旧社区整理里有“装备补给主UP写成角色名”的脏数据，例如 s=死生之律者。
      // 这类先过滤掉；如果后续在 YAML 里补 target 或改成真实武器名，就会正常显示。
      return !!s && charNames.has(s);
    };
    return {
      ...data,
      pools: data.pools.map(vp => ({
        ...vp,
        pools: (vp.pools || []).filter(pool => !isInvalidWeapon(pool))
      }))
    };
  }

  async loadBh3CurrentPools() {
    const data = await this.loadBh3PoolHistory();
    if (!data?.pools?.length) return [];
    const now = Date.now();
    let hit = data.pools.find(v => {
      const s = new Date(v.start).getTime();
      const e = new Date(v.end).getTime();
      return !Number.isNaN(s) && !Number.isNaN(e) && now >= s && now <= e;
    });
    // 时间区间未命中（本地库最新版本已过期）时，保证「当前卡池」与「卡池历史」同源，
    // 不再跳到米游社官方接口导致两边对不上。优先取「已开始的最新版本」；
    // 全部都在未来（预告期）时才取最早的一条，避免当前卡池显示成远期的版本。
    if (!hit) {
      const list = [...(data.pools || [])].filter(v => !Number.isNaN(Number(v.version)));
      const started = list
        .filter(v => !Number.isNaN(new Date(v.start).getTime()) && new Date(v.start).getTime() <= now)
        .sort((a, b) => Number(b.version) - Number(a.version));
      const future = list
        .filter(v => !Number.isNaN(new Date(v.start).getTime()) && new Date(v.start).getTime() > now)
        .sort((a, b) => Number(a.version) - Number(b.version));
      hit = started[0] || future[0] || list.sort((a, b) => Number(b.version) - Number(a.version))[0] || null;
    }
    if (!hit) return [];
    const maps = await this.getBh3WikiMaps();
    const displayVersion = hit.version || '-';
    // 崩三补给轮替：各池有自己的时间区间，过滤掉已结束的；全都结束则不过滤（避免开天窗）
    let showPools = (hit.pools || []).filter(p => {
      if (!p.end) return true;
      const pe = new Date(String(p.end).replace(/-/g, '/')).getTime();
      return Number.isNaN(pe) || pe >= now;
    });
    if (!showPools.length) showPools = hit.pools || [];
    return Promise.all(showPools.map(p => this.bh3PoolToCard({ ...p, version: displayVersion, start: p.start || hit.start, end: p.end || hit.end }, maps)));
  }

  // 崩三公告的时间锚点：优先正文里解析出的开放时间，其次公告发布时间
  bh3RecordTs(r = {}) {
    const ranges = this.parseBh3AllTimeRanges(r?.contentText || r?.summary || '');
    if (ranges.length) return ranges[0].start;
    return Number(r?.createdAt) || 0;
  }

  // 按时间戳找到所属版本：落在窗口内优先，否则取「之前最近」的版本
  bh3VersionForTs(history, ts) {
    if (!ts) return null;
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    let best = null;
    for (const vp of history?.pools || []) {
      const s = toTs(vp.start);
      const e = toTs(vp.end);
      if (s === null) continue;
      if (ts >= s && (e === null || ts <= e)) return vp;
      if (s <= ts && (!best || s > toTs(best.start))) best = vp;
    }
    return best;
  }

  // 从公告正文解析出的时间区间里，选该补给所属版本窗口内的那一段：
  // 优先「开放时间落在版本窗口内」的唯一一段；没有就退一步取「与版本窗口有重叠」的唯一一段；
  // 仍无法唯一确定就返回 null（不猜，保持版本窗口）。
  pickBh3Range(times = [], vp = null) {
    if (!Array.isArray(times) || !times.length) return null;
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const vs = toTs(vp?.start), ve = toTs(vp?.end);
    if (vs === null || ve === null) return times.length === 1 ? times[0] : null;
    const inside = times.filter(t => t.start >= vs - 86400000 && t.start <= ve + 86400000);
    if (inside.length) {
      // 轮替公告会同时给出「整体开放时间」和每个协同者/角色的轮替子区间（如
      // 「开放时间 9.1版本更新后~11月6日12:00」+「希娜狄雅：9.1版本更新后~10月5日12:00」），
      // 这些都会落在同一版本窗口内 → 取结束最晚的那段作为该补给的开放区间（即整体窗口）。
      return inside.reduce((a, b) => (b.end > a.end ? b : a));
    }
    // 兜底：区间与版本窗口要有实质重叠（≥5 天）才算对上，
    // 否则「刚好跨过版本切换那一刻 16 小时」的旧补给会被误判成新版本的（如 9.0 的劫烬归虹被判进 9.1）
    const overlap = times.filter(t => Math.min(t.end, ve) - Math.max(t.start, vs) >= 5 * 86400000);
    if (overlap.length === 1) return overlap[0];
    return null;
  }

  // 米游社官方号「瞬间搜索」：按关键词取公告正文。
  // 这条路走 painter/user_instant 接口，不经过「公告详情」接口，因此详情接口被风控(1034)时依然可用。
  async searchBh3PostByKeyword(keyword = '') {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const cacheKey = `xhh:bh3:instant:${kw}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
    try {
      const url = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list?keyword=' +
        encodeURIComponent(kw) + '&uid=73565430&size=20&offset=0&sort_type=2';
      let json = null;
      // 偶发限流/空结果时重试一次（实测同一关键词偶尔会返回空列表）
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
        if (json?.retcode === 0 && (json?.data?.list || []).length) break;
        await new Promise(res => setTimeout(res, 500));
      }
      const out = (json?.data?.list || [])
        .map(it => (it?.post?.post || it?.post || {}))
        .filter(p => p && p.content)
        .map(p => {
          const raw = Number(p.created_at || 0);
          return {
            title: String(p.subject || ''),
            // 注意：这个接口的 content 只返回约 300 字，完整正文在 structured_content（富文本 JSON）里
            content: String(p.content || ''),
            structured: this.mysStructuredToText(p.structured_content),
            postId: String(p.post_id || ''),
            // 公告封面图：这个接口的 cover 常为空串，图在 images 里（images[0] 就是卡池封面，
            // 与官方公告列表给出的封面一致），可作封面兜底来源
            images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
            createdAt: raw > 1e12 ? raw : raw * 1000
          };
        });
      try { await redis.set(cacheKey, JSON.stringify(out), { EX: 12 * 3600 }); } catch (_) {}
      return out;
    } catch (err) {
      logger.warn(`[xhh][gacha_pool] 米游社瞬间搜索失败(${kw}):`, err?.message || err);
      return [];
    }
  }

  // 米游社「structured_content」是富文本 JSON（[{insert:'文字'} / {insert:{image:'id'}}]），
  // 抽出其中的纯文本（图片等非文字节点忽略）。搜索接口的 content 会被截断，正文只能靠它。
  mysStructuredToText(raw = '') {
    const s = String(raw || '');
    if (!s) return '';
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return '';
      return arr.map(seg => {
        const ins = seg?.insert;
        if (typeof ins === 'string') return ins;
        if (ins && typeof ins === 'object' && typeof ins.text === 'string') return ins.text;
        return '';
      }).join(' ');
    } catch (_) {
      return '';
    }
  }

  // 搜索关键词：优先补给 UP 名，其次公告标题「丨」后的一段（去掉「限时开启」之类的套话）
  bh3SearchKeyword(p = {}) {
    const junk = /^(协同者轮替|跃升武装|跃升补给|角色补给|装备补给|精准补给|主题补给|服装补给|神之键)$/;
    const s = String(p.s || '').trim();
    if (s && !junk.test(s)) return s;
    const seg = String(p.name || '').replace(/^【[^】]*】/, '').split(/[丨｜|]/).pop() || '';
    const name = seg.replace(/[「」『』]/g, '').replace(/(?:限时)?开启[!！]*$/, '').replace(/主题补给.*$/, '').trim();
    return name && name.length <= 20 ? name : '';
  }

  // 给「近期/未来版本」的补给补录各自的开放时间：
  // ① 优先用刷新拿到的公告正文；② 没有就用「瞬间搜索」按 UP 名取公告正文（不受详情接口风控影响）；
  // 只有能唯一定位到某段区间时才写入，取不到就保持版本窗口，绝不猜。（历史版本不处理，避免误填）
  async fillBh3PoolTimes(history, records = []) {
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const fmt = t => {
      const d = new Date(t);
      const q = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())} ${q(d.getHours())}:${q(d.getMinutes())}:00`;
    };
    const normTitle = s => String(s || '').trim().replace(/[！!]+$/, '');
    const byTitle = new Map();
    for (const r of records || []) {
      if (r?.title) byTitle.set(normTitle(r.title), r);
    }
    const now = Date.now();
    let times = 0, covers = 0, missing = 0, queried = 0;
    for (const vp of history?.pools || []) {
      const ve = toTs(vp.end);
      // 只处理近期/未来版本（历史版本没有展示需求，也不该用现在的公告去填）
      if (!ve || ve < now - 60 * 86400000) continue;
      for (const p of vp.pools || []) {
        const needTime = !(p.start && p.end);
        const needCover = !(Array.isArray(p.imgs) && p.imgs.filter(Boolean).length);
        if (!needTime && !needCover) continue;
        let ranges = [], cover = '';
        const r = byTitle.get(normTitle(p.name));
        if (r) ranges = this.parseBh3AllTimeRanges(r.contentText || r.summary || '');
        if (!ranges.length || !cover) {
          const kw = this.bh3SearchKeyword(p);
          if (kw && queried < 12) {
            queried++;
            if (queried > 1) await new Promise(res => setTimeout(res, 120));
            const posts = await this.searchBh3PostByKeyword(kw);
            let fallbackCover = '';
            for (const post of posts) {
              if (!String(post.title).includes(kw)) continue;
              if (!/补给|跃升|服装|协同|神之键|精准|扩充/.test(post.title)) continue;
              const candText = post.structured || post.content;
              const cand = this.parseBh3AllTimeRanges(candText);
              const picked = cand.length ? this.pickBh3Range(cand, vp) : null;
              const img = (post.images || [])[0] || '';
              if (picked) {
                // 与版本窗口对得上 → 时间和封面都用这条公告的
                ranges = [picked];
                if (img) cover = img;
                break;
              }
              // 正文里没写日期时无法判定版本，先留作封面兜底（列表按发布时间倒序，取最新一条）
              if (!cand.length && img && !fallbackCover) fallbackCover = img;
            }
            if (!cover) cover = fallbackCover;
          }
        }
        if (needTime) {
          const hit = this.pickBh3Range(ranges, vp);
          if (hit) {
            p.start = fmt(hit.start);
            p.end = fmt(hit.end);
            times++;
          } else {
            missing++;
          }
        }
        if (needCover && cover) {
          p.imgs = [cover];
          covers++;
        }
      }
    }
    if (missing) {
      logger.mark(`[xhh][gacha_pool] 崩三 ${missing} 个补给暂用版本窗口（公告正文里没定位到唯一一段开放时间）`);
    }
    return { times, covers };
  }

  // 风控期间（「公告详情」接口不可用）仍然补录崩三补给的开放时间与封面：
  // 走「瞬间搜索」接口取公告正文与图片，不受详情接口风控影响。有变化才落盘。
  async fillBh3TimesOnRisk(results = []) {
    try {
      const data = await this.loadBh3PoolHistory();
      if (!data?.pools?.length) return '';
      const recs = (results || []).find(r => r.game === 'bh3')?.records || [];
      const r = await this.fillBh3PoolTimes(data, recs);
      const times = r?.times || 0, covers = r?.covers || 0;
      if (!times && !covers) return '';
      fs.writeFileSync(BH3_POOL_HISTORY_YAML_PATH, YAML.stringify({
        ...(data || {}),
        updated: new Date().toISOString().slice(0, 10),
        pools: data.pools
      }), 'utf-8');
      logger.mark(`[xhh][gacha_pool] 风控期间补录崩三补给信息：开放时间 ${times} 条、封面 ${covers} 张`);
      return `\n崩坏3：风控期间仍补录了 ${times} 条开放时间、${covers} 张封面`;
    } catch (err) {
      logger.warn('[xhh][gacha_pool] 风控期间崩三补给信息补录失败:', err?.message || err);
      return '';
    }
  }

  // 把补给 p 并入版本 vp：同名已存在时合并缺失字段（封面/开放时间/target），不再新增重复条目。
  bh3MergePoolInto(vp, p) {
    const pools = vp.pools || (vp.pools = []);
    const same = pools.find(x => String(x.name || '') === String(p.name || ''));
    if (!same) {
      pools.push(p);
      return true;
    }
    for (const k of ['imgs', 'start', 'end', 'target']) {
      const empty = same[k] === undefined || (Array.isArray(same[k]) && !same[k].filter(Boolean).length);
      if (empty && p[k] !== undefined) same[k] = p[k];
    }
    return true;
  }

  // 按各补给自己的开放时间把池子归位到正确的版本窗口：
  // 修复「旧版本的补给被并进最新版本」的错位（如 9.0 末期的补给被并进 v9.1）。
  reassignBh3PoolsByTime(history) {
    if (!history?.pools?.length) return [];
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const windows = history.pools
      .map(vp => ({ vp, s: toTs(vp.start), e: toTs(vp.end) }))
      .filter(w => w.s !== null && w.e !== null);
    const moved = [];
    for (const w of windows) {
      const stay = [];
      for (const p of w.vp.pools || []) {
        const ps = toTs(p.start);
        const target = ps !== null ? windows.find(t => ps >= t.s && ps <= t.e) : null;
        if (!target || target.vp === w.vp) {
          stay.push(p);
          continue;
        }
        this.bh3MergePoolInto(target.vp, p);
        moved.push(`v${w.vp.version}「${p.s || p.name}」→ v${target.vp.version}`);
      }
      w.vp.pools = stay;
    }
    return moved;
  }

  async bh3PoolToCard(pool, maps = null) {
    const weapon = pool.type === 'weapon';
    const outfit = pool.type === 'outfit';
    const partner = !weapon && !outfit && /协同/.test(`${pool.name || ''}${pool.s || ''}`);
    const title = partner
      ? String(pool.name || '').replace(/协同补给丨协同者/, '协同补给丨').replace(/「([^」]+)」/g, '$1')
      : (pool.name || '');
    // 崩三卡池单个 UP 卡片右侧不再放立绘/图标，只保留顶部卡片立绘。
    return {
      gameClass: 'bh3',
      version: pool.version || '-',
      title,
      type: outfit ? '服装补给' : (weapon ? '装备补给' : (partner ? '协同补给' : '角色补给')),
      time: pool.start && pool.end ? `${pool.start.slice(0, 16)} ~ ${pool.end.slice(0, 16)}` : '',
      s: pool.s || '-',
      a: Array.isArray(pool.a) ? pool.a.join(' / ') : (pool.a || '-'),
      // 优先用落盘的公告封面（imgs），没有再留空由官方公告缓存兜底
      img: (Array.isArray(pool.imgs) ? pool.imgs.filter(Boolean)[0] : '') || pool.img || '',
      icon: '',
      weapon,
      partner,
      mainLabel: outfit ? '服装' : (weapon ? '武器' : (partner ? '协同' : 'S')),
      subLabel: outfit ? '角色' : (weapon ? '圣痕' : 'A')
    };
  }

  async bh3VersionPool(e) {
    if (!config().bh3_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中崩三版本卡池:', e.msg);
    const data = await this.loadBh3PoolHistory();
    if (!data?.pools?.length) return e.reply('崩三历史卡池数据暂不可用。');
    const m = e.msg.match(/(?:崩三|崩坏3|崩坏三|BH3)v?(\d+\.\d+)(上半|下半)?(卡池|补给)/);
    if (!m) return false;
    // 崩三没有上下半之分：版本查询只按版本号过滤（命令里带「上半/下半」也按整版本返回）
    const [, version] = m;
    const versionPools = data.pools.filter(p => p.version === version);
    if (!versionPools.length) return e.reply(`未查询到崩坏3 v${version} 卡池数据。`);
    const pools = versionPools.flatMap(v => v.pools.map(p => ({ ...p, version: v.version, start: p.start || v.start, end: p.end || v.end })));
    const maps = await this.getBh3WikiMaps();
    const cards = await Promise.all(pools.map(async (p, i) => { const c = await this.bh3PoolToCard(p, maps); c.index = i + 1; c.versionTag = `#${c.index} ${c.version || '-'}`; return c; }));
    const markIcon = await this.getBh3HeaderSplashFromPools(cards, BH3_MARK_ICON);
    let markWide = true;
    return this.renderPoolImage(e, {
      game: '崩坏3',
      title: `v${version} 补给记录`,
      subtitle: `${pools[0].start?.slice(0, 16)} ~ ${pools[0].end?.slice(0, 16)}`,
      mode: 'bh3',
      markIcon,
      markWide,
      cards
    });
  }

  async bh3NameHistory(e) {
    if (!config().bh3_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中崩三名称卡池:', e.msg);
    const name = e.msg.replace(/^#*(?:xhh)?(小花火)?(崩三|崩坏3|崩坏三|BH3)/, '').replace(/(卡池|补给)$/, '').trim();
    if (!name) return false;
    return this.replyBh3NameHistory(e, name, false);
  }

  async replyBh3NameHistory(e, name, silent = false) {
    const data = await this.loadBh3PoolHistory();
    if (!data?.pools?.length) return silent ? false : e.reply('崩三历史卡池数据暂不可用。');
    if (!name) return false;
    // “希儿/芽衣/琪亚娜”这类本体名会对应多个装甲，不能只映射到第一套装甲。
    // 这里展开为候选集合，查询“崩三希儿卡池”时能同时命中愈生佑翎/死生之律者/魇夜星渊等记录。
    const queryNames = this.getBh3NameCandidates(name);
    const cleanQueries = [...new Set(queryNames.map(v => this.cleanBh3Name(v)).filter(Boolean))];
    const hitName = v => {
      const raw = String(v || '');
      const clean = this.cleanBh3Name(raw);
      if (!clean) return false;
      return queryNames.some(q => raw === q || raw.includes(q) || q.includes(raw))
        || cleanQueries.some(q => clean === q || clean.includes(q) || q.includes(clean));
    };
    const mainRecords = [];
    const subRecords = [];
    for (const vp of data.pools) {
      const mainMatchedPools = [];
      const subMatchedPools = [];
      for (const pool of vp.pools) {
        const aList = Array.isArray(pool.a) ? pool.a : String(pool.a || '').split(/[，,/]/).filter(Boolean);
        const relatedList = Array.isArray(pool.related) ? pool.related : [];
        // 崩三历史数据里 weapon.s 是武器名，不应当作角色主UP匹配；
        // 角色补给才用 s 作为主UP，装备补给用 target/related 关联角色。
        const mainNames = pool.type === 'weapon'
          ? [pool.target, ...relatedList]
          : [pool.s, pool.target, ...relatedList];
        const hitMain = mainNames.some(hitName);
        const hitSub = aList.some(hitName);
        if (hitMain) {
          mainMatchedPools.push({ pool, attachWeapon: pool.type !== 'weapon' });
        } else if (hitSub) {
          subMatchedPools.push({ pool, attachWeapon: false });
        }
      }
      if (mainMatchedPools.length) {
        // 只要全局能命中主UP/专属装备，就不要再混入其它版本的A级陪跑记录。
        const shouldAttachWeapon = mainMatchedPools.some(v => v.attachWeapon);
        const related = vp.pools.filter(pool => {
          if (mainMatchedPools.some(v => v.pool === pool)) return true;
          if (!shouldAttachWeapon || pool.type !== 'weapon') return false;
          const relatedList = Array.isArray(pool.related) ? pool.related : [];
          // 只自动带与查询角色绑定的专属装备，避免同一期别人的装备补给串进来。
          return [pool.target, ...relatedList].some(hitName);
        });
        for (const pool of related) mainRecords.push({ ...pool, version: vp.version, phase: vp.phase, start: vp.start, end: vp.end });
      } else if (subMatchedPools.length) {
        for (const { pool } of subMatchedPools) subRecords.push({ ...pool, version: vp.version, phase: vp.phase, start: vp.start, end: vp.end });
      }
    }
    const records = mainRecords;
    if (!records.length) {
      const msg = subRecords.length
        ? `未找到【${name}】的崩坏3主UP/专属装备补给记录。
本地数据只命中了A级陪跑记录，已过滤避免串池；需要的话可以补充更早版本主UP数据。`
        : `未找到【${name}】的崩坏3补给记录。`;
      return silent && !subRecords.length ? false : e.reply(msg);
    }
    const sections = await this.buildBh3HistorySections(records, name, queryNames);
    if (sections.length) {
      return this.renderBh3Logs(e, sections);
    }
    const first = records[0];
    const type = first.type === 'weapon' ? '装备' : '角色';
    const firstRelated = Array.isArray(first.related) ? first.related : [];
    const hitMain = first.type === 'weapon'
      ? (hitName(first.target) || firstRelated.some(hitName))
      : (hitName(first.s) || hitName(first.target) || firstRelated.some(hitName));
    const rarity = first.type === 'weapon' ? (hitMain ? '专属' : '') : (hitMain ? 'S级' : '副UP');
    let markIcon = BH3_MARK_ICON;
    let markWide = true;
    return this.renderPoolImage(e, {
      game: '崩坏3',
      title: `${name} 补给记录`,
      subtitle: `${rarity}${type} · 共 ${records.length} 次记录`,
      mode: 'gs-history',
      markIcon,
      markWide,
      cards: sections
    });
  }

  cleanBh3Name(name = '') {
    return String(name || '')
      .replace(/[\s「」『』【】［］()（）·・•!！♪♫♥❤☆★△▽▼▲×]/g, '')
      .replace(/^(真我|薪炎|终焉|始源|空之|理之|雷之|识之|死生|人之|天元|月下|戒律|螺旋|黄金|繁星|无限|浮生|鏖灭|旭光|刹那|救世)之律者/g, '$1律者')
      .trim();
  }

  getBh3NameCandidates(name = '') {
    const raw = String(name || '').trim();
    const clean = this.cleanBh3Name(raw);
    const set = new Set([raw].filter(Boolean));
    try {
      const names = yaml.get('./plugins/xhh/system/default/bh3_js_names.yaml');
      if (names) {
        for (const [suit, aliasesRaw] of Object.entries(names)) {
          const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [];
          const all = [suit, ...aliases].filter(Boolean);
          const cleans = all.map(v => this.cleanBh3Name(v)).filter(Boolean);
          const exactHit = all.includes(raw) || cleans.includes(clean);
          const fuzzyHit = clean.length >= 2 && cleans.some(v => v.length >= 2 && (v.includes(clean) || clean.includes(v)));
          if (exactHit || fuzzyHit) {
            for (const v of all) set.add(v);
          }
        }
      }
    } catch (_) {}
    return [...set];
  }


  async getBh3CharacterSplash(name = '') {
    if (!name) return '';
    const candidates = this.getBh3NameCandidates(name);
    const targets = candidates.map(v => this.cleanBh3Name(v)).filter(Boolean);
    if (!targets.length) return '';
    try {
      const listUrl = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki/v1/home/content/list?app_sn=bh3_wiki&channel_id=18';
      const listJson = await fetch(listUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      const list = listJson?.data?.list?.[0]?.list || [];
      const hit = list.find(item => targets.includes(this.cleanBh3Name(item.title)))
        || list.find(item => targets.some(t => this.cleanBh3Name(item.title).includes(t) || t.includes(this.cleanBh3Name(item.title))));
      if (!hit?.content_id) return hit?.icon || '';
      const detailUrl = `https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki/v1/content/info?app_sn=bh3_wiki&content_id=${hit.content_id}`;
      const detail = await fetch(detailUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
      const content = detail?.data?.content || {};
      const imgs = [];
      for (const section of content.contents || []) {
        const text = String(section.text || '');
        const matches = text.matchAll(/data-data="([^"]+)"/g);
        for (const match of matches) {
          try {
            const arr = JSON.parse(decodeURIComponent(match[1]));
            for (const part of Array.isArray(arr) ? arr : []) {
              const data = part?.data || {};
              if (data.avatar) imgs.push(data.avatar);
            }
          } catch (_) {}
        }
      }
      // 只返回角色立绘/头像大图，不把 S/SSS 阶级图标或普通 icon 当成顶部立绘。
      return this.randomPick([
        ...imgs,
        content.avatar_url
      ]);
    } catch (err) {
      logger.warn?.('[xhh][gacha_pool] 崩三角色立绘获取失败:', name, err);
      return '';
    }
  }

  getBh3IconNameCandidates(name = '') {
    const raw = String(name || '').trim();
    const set = new Set([raw].filter(Boolean));
    const aliasMap = {
      '原罪·双生': ['原罪猎人', '彼岸双生'],
      '原罪双生': ['原罪猎人', '彼岸双生'],
      '圣女祈祷·十字星尘': ['圣女祈祷'],
      '圣女祈祷十字星尘': ['圣女祈祷'],
      // 圣痕套装名不是 Wiki 单件条目名，取套装三件中的第一件作为卡池小图代表。
      '花愈朝夕': ['希儿·晨蕊摇光(上)', '希儿·花寄嘱念(中)', '希儿·芳诲传薪(下)'],
      '岁岁如新': ['芽衣·璨光映愿(上)', '芽衣·挚礼盈门(中)', '芽衣·华彩佑夜(下)'],
      // 爱莉希雅/爱愿妖精专属圣痕套装名，对应 Wiki 单件圣痕条目。
      '芳时晏然': ['爱莉希雅·悠然漫话(上)', '爱莉希雅·翩然流光(中)', '爱莉希雅·焕然愿景(下)'],
      // 真我·人之律者旧专属圣痕套装，Wiki 以单件“爱莉希雅·无瑕之人”收录。
      '度法衡诗': ['爱莉希雅 · 无瑕之人(上)', '爱莉希雅 · 无瑕之人(中)', '爱莉希雅 · 无瑕之人(下)']
    };
    const clean = this.cleanBh3Name(raw);
    for (const [k, list] of Object.entries(aliasMap)) {
      if (raw === k || clean === this.cleanBh3Name(k)) {
        for (const v of list) set.add(v);
      }
    }
    // 兼容武器/圣痕别名表里的短名：例如“澄爱挚语”可反查“澄爱挚语·馨愿”。
    for (const file of [
      './plugins/xhh/system/default/bh3_wq_names.yaml',
      './plugins/xhh/system/default/bh3_syw_names.yaml',
      './plugins/xhh/system/default/bh3_js_names.yaml'
    ]) {
      try {
        const data = yaml.get(file);
        if (!data) continue;
        for (const [title, aliasesRaw] of Object.entries(data)) {
          const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [];
          const all = [title, ...aliases].filter(Boolean);
          if (all.some(v => this.cleanBh3Name(v) === clean || (clean.length >= 2 && this.cleanBh3Name(v).includes(clean)))) {
            for (const v of all) set.add(v);
          }
        }
      } catch (_) {}
    }
    return [...set];
  }

  findBh3IconFromDir(dir = '', name = '', prefixes = [], fuzzy = true) {
    if (!fs.existsSync(dir)) return '';
    const target = this.cleanBh3Name(name);
    try {
      const files = fs.readdirSync(dir).filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f));
      const exactNames = [];
      for (const prefix of prefixes) {
        for (const ext of ['png', 'webp', 'jpg', 'jpeg']) exactNames.push(`${prefix}${name}.${ext}`);
      }
      for (const file of exactNames) {
        const path = `${dir}/${file}`;
        if (fs.existsSync(path)) return fs.realpathSync(path);
      }
      if (!fuzzy) return '';
      for (const file of files) {
        const base = file.replace(/\.(png|webp|jpg|jpeg)$/i, '').replace(/^(char_|weapon_|stigmata_|圣痕_|角色_|武器_)/, '');
        const clean = this.cleanBh3Name(base);
        if (clean && target && (clean === target || clean.includes(target) || target.includes(clean))) {
          return fs.realpathSync(`${dir}/${file}`);
        }
      }
    } catch (_) {}
    return '';
  }

  async getBh3WikiMaps() {
    try {
      const helper = Object.create(bh3_gacha.prototype);
      const maps = await helper.getStarMaps();
      // getStarMaps 只取女武神/武器；装备补给还会展示圣痕套装，
      // 这里补圣痕图标映射，避免“花愈朝夕/岁岁如新”只能显示文字占位。
      try {
        const res = await fetch('https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki/v1/home/content/list?app_sn=bh3_wiki&channel_id=19');
        const json = await res.json();
        maps.stigmataIcon = maps.stigmataIcon || {};
        for (const item of json?.data?.list?.[0]?.list || []) {
          if (item?.title && item?.icon) maps.stigmataIcon[item.title] = item.icon;
        }
      } catch (err) {
        logger.warn?.('[xhh][gacha_pool] 崩三圣痕图标映射获取失败:', err);
      }
      return maps;
    } catch (err) {
      logger.warn?.('[xhh][gacha_pool] 崩三Wiki图标映射获取失败:', err);
      return { charIcon: {}, weaponIcon: {}, stigmataIcon: {} };
    }
  }

  findBh3WikiIcon(name = '', weapon = false, maps = {}, kind = '') {
    const dict = kind === 'stigmata' ? (maps.stigmataIcon || {}) : (weapon ? (maps.weaponIcon || {}) : (maps.charIcon || {}));
    const candidates = this.getBh3IconNameCandidates(name);
    const targets = candidates.map(v => this.cleanBh3Name(v)).filter(Boolean);
    if (!targets.length) return { title: name, url: '' };
    for (const [title, url] of Object.entries(dict)) {
      if (candidates.includes(title)) return { title, url };
    }
    for (const [title, url] of Object.entries(dict)) {
      const clean = this.cleanBh3Name(title);
      if (clean && targets.some(target => clean === target || clean.includes(target) || target.includes(clean))) return { title, url };
    }
    return { title: name, url: '' };
  }

  async getBh3HistoryIcon(name = '', weapon = false, maps = null) {
    const prefixes = weapon ? ['weapon_', ''] : ['char_', '角色_', ''];
    const dirs = [
      './plugins/xhh/data/bh3_gacha/icons',
      './plugins/xhh/resources/bh3logs/icons'
    ];
    // 先跨目录精确匹配，避免 data 缓存里的角色头像通过模糊匹配抢在 resources 的圣痕套装图前面。
    for (const dir of dirs) {
      const icon = this.findBh3IconFromDir(dir, name, prefixes, false);
      if (icon) return icon;
    }
    for (const dir of dirs) {
      const icon = this.findBh3IconFromDir(dir, name, prefixes, true);
      if (icon) return icon;
    }

    // 复用崩三抽卡记录的 Wiki 图标来源：本地没缓存时现场拉取并写入 data/bh3_gacha/icons。
    if (maps) {
      // 装备补给数据里既可能是武器，也可能是圣痕套装；有时还会混入 A 级女武神名。
      // 按当前行类型 → 圣痕 → 反向角色/武器的顺序兜底。
      const hit = this.findBh3WikiIcon(name, weapon, maps);
      const stigmataHit = hit.url ? hit : this.findBh3WikiIcon(name, weapon, maps, 'stigmata');
      const fallbackHit = stigmataHit.url ? stigmataHit : this.findBh3WikiIcon(name, !weapon, maps);
      if (fallbackHit.url) {
        try {
          const helper = Object.create(bh3_gacha.prototype);
          const cacheType = hit.url ? (weapon ? 'weapon' : 'char') : (stigmataHit.url ? 'stigmata' : (!weapon ? 'weapon' : 'char'));
          await helper.cacheIcon(fallbackHit.title, fallbackHit.url, cacheType);
          for (const dir of dirs) {
            const icon = this.findBh3IconFromDir(dir, fallbackHit.title, prefixes) || this.findBh3IconFromDir(dir, name, prefixes);
            if (icon) return icon;
          }
          return fallbackHit.url;
        } catch (err) {
          logger.warn?.('[xhh][gacha_pool] 崩三卡池图标缓存失败:', name, err);
          return fallbackHit.url;
        }
      }
    }
    return '';
  }

  async buildBh3HistoryItem(name = '', rarity = 'four', weapon = false, highlightName = '', maps = null) {
    const clean = this.cleanBh3Name(name);
    const hits = (Array.isArray(highlightName) ? highlightName : [highlightName]).map(v => this.cleanBh3Name(v)).filter(Boolean);
    return {
      name,
      icon: await this.getBh3HistoryIcon(name, weapon, maps),
      rarity,
      weapon,
      highlight: !!clean && hits.some(hit => clean === hit || clean.includes(hit) || hit.includes(clean))
    };
  }

  async buildBh3HistorySections(records = [], query = '', queryNames = null) {
    const map = new Map();
    const maps = await this.getBh3WikiMaps();
    const highlights = Array.isArray(queryNames) ? queryNames : [query];
    for (const p of records) {
      const time = p.start && p.end ? `${p.start} ~ ${p.end}` : '';
      const key = `${p.version || '-'}|${time}`;
      if (!map.has(key)) map.set(key, { version: `${p.version || '-'}`, time, rows: [] });
      const weapon = p.type === 'weapon';
      const items = [await this.buildBh3HistoryItem(p.s || '-', 'five', weapon, highlights, maps)];
      for (const a of (Array.isArray(p.a) ? p.a : String(p.a || '').split(/[，,/]/).filter(Boolean))) {
        items.push(await this.buildBh3HistoryItem(a, 'four', weapon, highlights, maps));
      }
      map.get(key).rows.push({ title: weapon ? '装备补给' : '角色补给', weapon, items });
    }
    return [...map.values()];
  }

  async bh3AllPool(e) {
    if (!config().bh3_logs) return false;
    logger.mark('[xhh][gacha_pool] 命中崩三全卡池:', e.msg);
    const data = await this.loadBh3PoolHistory();
    if (!data?.pools?.length) return e.reply('崩三历史卡池数据暂不可用。');
    // 按版本号倒序（最新在前）：库里的条目顺序是历史累积的，不能直接反转文件顺序
    const byVer = new Map();
    for (const vp of data.pools || []) {
      const v = String(vp.version || '-');
      if (!byVer.has(v)) byVer.set(v, []);
      byVer.get(v).push(vp);
    }
    const toTs = s => {
      const t = new Date(String(s || '').replace(/-/g, '/')).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const versions = [...byVer.keys()].sort((a, b) => Number(b) - Number(a));
    const chunks = versions.map(v => {
      // 同一版本可能有多条（不同时间段的补给），全部展开并按开始时间倒序
      const entries = [...(byVer.get(v) || [])].sort((a, b) => toTs(b.start) - toTs(a.start));
      const lines = [`【v${v}】`];
      for (const p of entries.flatMap(e => e.pools || [])) {
        const mainLabel = p.type === 'weapon' ? '武器' : 'S';
        const subLabel = p.type === 'weapon' ? '圣痕' : 'A';
        lines.push(`${v} ${p.type === 'weapon' ? '装备' : '角色'}：${mainLabel}-${p.s} | ${subLabel}-${Array.isArray(p.a) ? p.a.join('，') : p.a}`);
      }
      return lines.join('\n');
    });
    const title = '崩坏3全版本补给记录';
    return this.replyAllPoolForward(e, title, chunks);
  }

  async bh3PoolUnsupported(e) {
    logger.mark('[xhh][gacha_pool] 命中崩三卡池兜底:', e.msg);
    return e.reply(`崩坏3当前版本已标记为 ${CURRENT_VERSION.bh3}。\n支持查询：\n#崩三卡池 / #崩三补给 - 查看当前可用补给菜单\n#崩三v8.9卡池 / #崩三v8.9上半卡池 - 查看指定版本补给\n#德丽莎卡池 / #琪亚娜补给 - 查看角色历史补给\n#崩三卡池历史 / #崩三补给全 - 查看全版本记录`);
  }
}
