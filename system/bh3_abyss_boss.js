import fs from 'fs';
import fetch from 'node-fetch';
import moment from 'moment';
import NoteUser from '../../genshin/model/mys/NoteUser.js';
import { yaml, mhy, api, config } from '#xhh';

const STOKEN_DIR = './plugins/xhh/data/Stoken';
const BH3_REGIONS = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02', 'cn_gf01', 'cn_qd01'];
const CACHE_KEY = 'xhh:bh3:current_abyss_info';
const BATTLEFIELD_CACHE_KEY = 'xhh:bh3:current_battlefield_info';
const SEARCH_API = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list';
const GLOBAL_SEARCH_API = 'https://bbs-api.miyoushe.com/post/wapi/searchPosts';

const serverMap = {
  cn_gf01: '官服', cn_qd01: 'B服', os_usa: '美服', os_euro: '欧服',
  os_asia: '亚服', os_cht: '港澳台服', android01: '安卓官服', ios01: 'iOS服',
  bb01: '哔哩哔哩', pc01: '桌面服', yyb01: '应用宝服', hun01: '渠道1服', hun02: '渠道2服',
};

const abyssLevelMap = {
  1: '禁忌', 2: '原罪Ⅰ', 3: '原罪Ⅱ', 4: '原罪Ⅲ',
  5: '苦痛Ⅰ', 6: '苦痛Ⅱ', 7: '苦痛Ⅲ',
  8: '红莲', 9: '寂灭',
};

const oldAbyssLevelMap = { 1: '禁忌', 2: '原罪', 3: '苦痛', 4: '红莲', 5: '寂灭' };
const oldAbyssLetterMap = { S: '寂灭', A: '红莲', B: '苦痛', C: '原罪', D: '禁忌' };
const battlefieldAreaMap = { 4: '终极组' };

function fmtTs(ts) {
  if (!ts) return '未知';
  const sec = Number(ts);
  if (!sec) return '未知';
  const ms = sec > 1e12 ? sec : sec * 1000;
  return moment(ms).format('MM-DD HH:mm');
}

function getSettleTs(r = {}) {
  return r.schedule_end || r.settled_time_second || r.settle_time_second || r.settle_time || r.end_time || r.finish_time || r.time_second || r.updated_time_second;
}

function getReportEndTs(r = {}) {
  // 注意：time_second/updated_time_second 通常是战报生成/更新时间，不是本期深渊结束时间，不能拿来判断是否过期。
  return r.schedule_end || r.settled_time_second || r.settle_time_second || r.settle_time || r.end_time || r.finish_time || 0;
}

function getReportSortTs(r = {}) {
  return getReportEndTs(r) || r.time_second || r.updated_time_second || 0;
}

function tsMs(ts) {
  const n = Number(ts || 0);
  if (!n) return 0;
  return n > 1e12 ? n : n * 1000;
}

function isCurrentReport(r = {}, now = Date.now()) {
  const end = tsMs(getReportEndTs(r));
  if (end) return end > now;
  // 没有明确结束时间时，用战报/更新时间做兜底新鲜度判断，避免把上期深渊当本期。
  const reportTime = tsMs(r.time_second || r.updated_time_second || r.created_at || 0);
  if (!reportTime) return true;
  return now - reportTime <= 30 * 60 * 60 * 1000;
}


function isCachedAbyssInfoValid(info = {}) {
  if (!info) return false;
  if (info.settleTs) return tsMs(info.settleTs) > Date.now();
  const text = String(info.settle || '');
  const m = text.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
  if (!m) return true;
  const d = moment({
    year: moment().year(),
    month: Number(m[1]) - 1,
    day: Number(m[2]),
    hour: Number(m[3]),
    minute: Number(m[4]),
    second: 0,
  });
  return d.valueOf() > Date.now();
}

function fmtLevel(level, isOld = false) {
  if (level === undefined || level === null) return '未知';
  if (typeof level === 'string') {
    const clean = level.replace(/^LV\.?/i, '').toUpperCase();
    if (isOld && oldAbyssLetterMap[clean]) return oldAbyssLetterMap[clean];
  }
  if (isOld && oldAbyssLevelMap[level]) return oldAbyssLevelMap[level];
  return abyssLevelMap[level] || `Lv.${level}`;
}

function fmtBattlefieldArea(area) {
  if (area === undefined || area === null || area === '') return '未知';
  return battlefieldAreaMap[area] || `第${area}组`;
}

async function getAuthByQQ(qq, preferredUid = '') {
  let uid = preferredUid || await redis.get(`xhh:bh3_uid:${qq}`);
  let region = uid ? await redis.get(`xhh:bh3_region:${qq}`) : null;
  let ck = null;

  const stokenPath = `${STOKEN_DIR}/${qq}.yaml`;
  if (fs.existsSync(stokenPath)) {
    const stokenData = yaml.get(stokenPath) || {};
    if (!uid) {
      for (const key of Object.keys(stokenData)) {
        const entry = stokenData[key];
        if (BH3_REGIONS.includes(entry?.region || '')) {
          uid = key;
          region = entry.region || region;
          break;
        }
      }
    }
    const entry = stokenData[uid];
    if (entry) {
      region = entry.region || region;
      if (entry.stuid) {
        try {
          const nu = await NoteUser.create(qq);
          for (const ltuid in nu.mysUsers || {}) {
            if (String(ltuid) === String(entry.stuid)) {
              ck = nu.mysUsers[ltuid].ck;
              break;
            }
          }
        } catch (_) {}
      }
    }
  }

  if (!uid) {
    try { uid = (await NoteUser.create(qq)).getUid('bh3'); } catch (_) {}
  }
  if (!region) region = 'cn_gf01';
  if (!ck) {
    try {
      const nu = await NoteUser.create(qq);
      for (const ltuid in nu.mysUsers || {}) {
        if (nu.mysUsers[ltuid]?.ck) {
          ck = nu.mysUsers[ltuid].ck;
          break;
        }
      }
    } catch (_) {}
  }
  return { qq, uid, region, ck };
}

async function findAnyBh3Auth() {
  if (!fs.existsSync(STOKEN_DIR)) return null;
  const files = fs.readdirSync(STOKEN_DIR).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    const qq = file.replace(/\.yaml$/, '');
    const data = yaml.get(`${STOKEN_DIR}/${file}`) || {};
    for (const [uid, entry] of Object.entries(data)) {
      if (!BH3_REGIONS.includes(entry?.region || '')) continue;
      const auth = await getAuthByQQ(qq, uid);
      if (auth.uid && auth.ck) return auth;
    }
  }
  return null;
}


function parseGuideSources(value = '') {
  const fallback = [
    ['红莲', 30269990, '朔守'],
    ['寂灭', 30269990, '朔守'],
    ['红莲', 11956740, '残月'],
    ['寂灭', 11956740, '残月'],
    ['红莲', 15491760, '墨之羽'],
  ];
  const rows = String(value || '').split(/\n+/).map(v => v.trim()).filter(Boolean);
  const result = [];
  for (const row of rows) {
    const [keyword, uidText, , author = ''] = row.split('|').map(v => v.trim());
    const uid = Number(uidText);
    if (keyword && Number.isSafeInteger(uid) && uid > 0) result.push([keyword, uid, author || `UID${uid}`]);
  }
  return result.length ? result : fallback;
}

function cleanBossName(text = '') {
  let boss = String(text || '')
    .replace(/^[：:，,。\s]*(BOSS|boss|Boss)?[：:，,。\s]*/g, '')
    .replace(/(的)?(流程|攻略|作业|阵容|配队|打法|视频|配置).*$/i, '')
    .replace(/[【】\[\]（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  boss = boss.replace(/^(本期|这期|此次|本次|天|量子|机械|生物|异能|虚数|量子)/, '').trim();
  if (/怎么|咋|求|没有|没带|无武器|武器|圣痕|阵容|配队|推荐|可以|能不能|吗|？|\?/.test(boss)) return '';
  return boss.slice(0, 32);
}

function extractBossFromPost(post = {}) {
  const subject = String(post.subject || '');
  const titleBossRules = [
    [/量子泥鳅|泥鳅/, '量子泥鳅'],
    [/神骸[-—·\s]*虚无主义|虚无主义/, '神骸-虚无主义'],
    [/摩录多/, '摩录多'],
  ];
  for (const [reg, name] of titleBossRules) {
    if (reg.test(subject)) return name;
  }
  const text = [post.subject, post.content, post.structured_content]
    .filter(Boolean)
    .join('\n')
    .replace(/\\n/g, '\n');
  const patterns = [
    /BOSS\s*[：:]?\s*([^\n，。,.；;]{2,40})/i,
    /boss\s*[：:]?\s*([^\n，。,.；;]{2,40})/i,
    /(?:超弦|深渊).*?(?:Boss|BOSS|boss)\s*[：:]?\s*([^\n，。,.；;]{2,40})/i,
  ];
  for (const reg of patterns) {
    const m = text.match(reg);
    const boss = cleanBossName(m?.[1] || '');
    if (boss && !/红莲|寂灭|苦痛|扰动|官服|渠道|服/.test(boss)) return boss;
    if (boss && boss.length >= 4) return boss;
  }
  return '';
}


function isBattlefieldGuidePost(post = {}) {
  const text = [post.subject, post.content, post.structured_content].filter(Boolean).join('\n');
  // 防止用战场作业误推断当前深渊 Boss。战场帖常包含“战场/记忆战场/lzx/分数”。
  return /记忆战场|战场|lzx|ss\d*.*分|\d{5,6}分/i.test(text);
}

function isRecentPost(post = {}, maxDays = 4) {
  const publish = Number(post.created_at || post.publish_at || 0);
  if (!publish) return true;
  return Math.floor(Date.now() / 1000) - publish <= maxDays * 24 * 3600;
}

function getCurrentAbyssStartSec(now = moment()) {
  // 崩三国服超弦空间通常周一/周五 15:00 开启。用于过滤旧作业帖。
  const candidates = [];
  for (let back = 0; back < 8; back++) {
    const d = now.clone().subtract(back, 'days');
    const day = d.day(); // 1=周一, 5=周五
    if (day === 1 || day === 5) {
      const start = d.clone().hour(15).minute(0).second(0).millisecond(0);
      if (start.isSameOrBefore(now)) candidates.push(start);
    }
  }
  return (candidates[0] || now.clone().subtract(4, 'days')).unix();
}

function isCurrentAbyssGuidePost(post = {}) {
  const publish = Number(post.created_at || post.publish_at || 0);
  if (!publish) return true;
  // 允许少量提前预发，但不接受上一期/上周旧作业。
  return publish >= getCurrentAbyssStartSec() - 30 * 60;
}

async function searchMysPosts(keyword, uid, size = 8) {
  const url = `${SEARCH_API}?keyword=${encodeURIComponent(keyword)}&uid=${encodeURIComponent(uid)}&size=${size}&offset=0&sort_type=2`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 xhh' } }).then(r => r.json());
  return (res?.data?.list || []).map(v => v?.post?.post).filter(Boolean);
}

async function searchMysGlobalPosts(keyword, size = 10) {
  const url = `${GLOBAL_SEARCH_API}?gids=1&size=${size}&keyword=${encodeURIComponent(keyword)}&sort_type=2`;
  const res = await fetch(url, {
    headers: {
      Referer: 'https://www.miyoushe.com',
      'User-Agent': 'Mozilla/5.0 xhh',
    },
  }).then(r => r.json());
  return (res?.data?.posts || []).map(v => v?.post).filter(Boolean);
}

function buildInferredAbyssInfo(post = {}, word = '', role = {}, region = '', source = '米游社攻略搜索') {
  const boss = extractBossFromPost(post);
  if (!boss) return null;
  return {
    label: '超弦空间',
    boss,
    level: /寂灭/.test(word) ? '寂灭' : /苦痛/.test(word) ? '苦痛' : '红莲',
    score: 0,
    rank: 0,
    settle: '米游社攻略推断',
    settleTs: 0,
    lineup: [],
    elf: '',
    uid: role?.role_id || '',
    nickname: role?.nickname || '',
    region: serverMap[region] || region,
    dataTime: moment().format('MM-DD HH:mm'),
    inferred: true,
    source: `${source}《${post.subject || word}》`,
  };
}

async function inferCurrentAbyssInfoFromMys(role = {}, region = '') {
  const sources = parseGuideSources(config().bh3_guide_abyss_sources);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [keyword, uid, author] of sources) {
    const searchWords = [`${keyword} 超弦`, `${keyword} 深渊`, `${keyword} 共鸣`, `${keyword} 量子`, `${keyword} 泥鳅`, '希鸭花', keyword];
    for (const word of searchWords) {
      try {
        const posts = await searchMysPosts(word, uid, 8);
        for (const post of posts) {
          if (!isRecentPost(post, 4)) continue;
          if (!isCurrentAbyssGuidePost(post)) continue;
          if (isBattlefieldGuidePost(post)) continue;
          const boss = extractBossFromPost(post);
          if (!boss) continue;
          const info = buildInferredAbyssInfo(post, keyword, role, region, author);
          await redis.set(CACHE_KEY, JSON.stringify(info), { EX: 30 * 60 });
          return info;
        }
      } catch (err) {
        if (config().debug) logger.mark(`[xhh][bh3_abyss_boss] 米游社搜索 ${word}/${uid} 失败: ${err.message}`);
      }
    }
  }
  // 全站搜索噪声太高，容易把提问帖/战场帖误判为深渊 Boss，这里不再用于“当前深渊”自动推断。
  // 兜底：朔守本期红莲作业常用短标题，不一定含“Boss:”字段，单独按当前期开期过滤一次。
  try {
    for (const q of ['红莲', '希鸭花', '共鸣量子泥鳅', '量子泥鳅']) {
      const posts = await searchMysPosts(q, 30269990, 8);
      for (const post of posts) {
        if (!isCurrentAbyssGuidePost(post)) continue;
        if (isBattlefieldGuidePost(post)) continue;
        if (!/(泥鳅|共鸣|超弦|深渊)/.test(String(post.subject || ''))) continue;
        const info = buildInferredAbyssInfo(post, '红莲', role, region, '朔守');
        if (!info) continue;
        await redis.set(CACHE_KEY, JSON.stringify(info), { EX: 30 * 60 });
        return info;
      }
    }
  } catch (err) {
    logger.warn(`[xhh][bh3_abyss_boss] 朔守本期深渊兜底失败: ${err.message}`);
  }
  return null;
}

function buildInfo(label, report, role, region) {
  const isOld = label === '量子流形';
  const chars = (report.lineup || []).map(c => c.name).filter(Boolean);
  return {
    label,
    boss: report.boss?.name || '未知',
    level: fmtLevel(report.level, isOld),
    score: report.score || 0,
    rank: report.rank || 0,
    settle: fmtTs(getSettleTs(report)),
    settleTs: getSettleTs(report) || 0,
    lineup: chars,
    elf: report.elf?.name || '',
    uid: role?.role_id || '',
    nickname: role?.nickname || '',
    region: serverMap[region] || region,
    dataTime: moment().format('MM-DD HH:mm'),
  };
}

export function formatCurrentAbyssInfo(info, compact = false) {
  if (!info) return '';
  const lineup = info.lineup?.length ? info.lineup.join(' / ') : '暂无阵容数据';
  const elf = info.elf ? `\n助战/人偶：${info.elf}` : '';
  const prefix = compact ? '本期深渊速查' : '崩坏3当前深渊';
  return [
    `${prefix}`,
    `类型：${info.label}${info.inferred ? '（米游社推断）' : ''}`,
    `分组：${info.level}`,
    `Boss：${info.boss}`,
    info.inferred ? `来源：${info.source || '米游社攻略搜索'}` : `结算：${info.settle}`,
    info.inferred ? '' : `参考阵容：${lineup}${elf}`,
    `数据源：${info.nickname || '已绑定账号'} ${info.region || ''} ${info.dataTime || ''}`,
  ].filter(Boolean).join('\n');
}

export function formatCurrentBattlefieldInfo(info, compact = false) {
  if (!info) return '';
  const prefix = compact ? '本期战场速查' : '崩坏3当前战场';
  const bosses = info.bosses?.length ? info.bosses.join(' / ') : '未知';
  return [
    `${prefix}`,
    `分组：${info.area || '未知'}`,
    `Boss：${bosses}`,
    `总分：${info.score || 0}`,
    `排名：#${info.rank || 0}`,
    `数据源：${info.nickname || '已绑定账号'} ${info.region || ''} ${info.dataTime || ''}`,
  ].filter(Boolean).join('\n');
}


async function getManualAbyssInfo() {
  try {
    const raw = await redis.get('xhh:bh3:current_abyss_manual');
    if (!raw) return null;
    const info = JSON.parse(raw);
    if (info.expiresAt && Date.now() > Number(info.expiresAt)) {
      await redis.del('xhh:bh3:current_abyss_manual');
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export async function fetchCurrentAbyssInfo(auth) {
  if (!auth?.uid || !auth?.ck) return inferCurrentAbyssInfoFromMys({}, auth?.region || 'cn_gf01');
  const e = { user_id: auth.qq || 0 };
  const headers = mhy.getHeaders(e, auth.ck);
  const indexRes = await api(e, { type: 'bh3_index', uid: auth.uid, headers, game: 'bh3', server: auth.region, silent: true });
  if (indexRes?.retcode !== 0) return inferCurrentAbyssInfoFromMys({}, auth.region || 'cn_gf01');
  const role = indexRes.data?.role || {};
  const level = Number(role.level || 0);
  const queryList = level > 0 && level <= 80
    ? [{ type: 'bh3_old_abyss', label: '量子流形' }, { type: 'bh3_new_abyss', label: '超弦空间' }]
    : [{ type: 'bh3_new_abyss', label: '超弦空间' }, { type: 'bh3_old_abyss', label: '量子流形' }];
  const serverValues = [...new Set([auth.region, mhy.getServer(auth.uid, 'bh3'), 'cn_gf01', 'cn_qd01'].filter(Boolean))];

  for (const server of serverValues) {
    for (const item of queryList) {
      try {
        const res = await api(e, { type: item.type, uid: auth.uid, headers, game: 'bh3', server, silent: true });
        const reports = (res?.data?.reports || [])
          .filter(r => isCurrentReport(r))
          .sort((a, b) => Number(getReportSortTs(b) || 0) - Number(getReportSortTs(a) || 0));
        if (res?.retcode === 0 && reports.length) {
          const info = buildInfo(item.label, reports[0], role, server);
          await redis.set(CACHE_KEY, JSON.stringify(info), { EX: 2 * 3600 });
          return info;
        }
      } catch (err) {
        if (config().debug) logger.mark(`[xhh][bh3_abyss_boss] ${item.label} ${server} failed: ${err.message}`);
      }
    }
  }
  return inferCurrentAbyssInfoFromMys(role, serverValues[0] || auth.region);
}

export async function fetchCurrentBattlefieldInfo(auth) {
  if (!auth?.uid || !auth?.ck) return null;
  const e = { user_id: auth.qq || 0 };
  const headers = mhy.getHeaders(e, auth.ck);
  const serverValues = [...new Set([auth.region, mhy.getServer(auth.uid, 'bh3'), 'cn_gf01', 'cn_qd01'].filter(Boolean))];
  const battlefieldStart = (() => {
    const now = moment();
    const start = now.clone().day(2).startOf('day');
    if (start.isAfter(now)) start.subtract(7, 'days');
    return start.unix();
  })();

  for (const server of serverValues) {
    try {
      const [indexRes, bfRes] = await Promise.all([
        api(e, { type: 'bh3_index', uid: auth.uid, headers, game: 'bh3', server, silent: true }),
        api(e, { type: 'bh3_battle_field', uid: auth.uid, headers, game: 'bh3', server, silent: true }),
      ]);
      if (bfRes?.retcode !== 0) continue;
      const reports = (bfRes?.data?.reports || [])
        .filter(r => !r.time_second || Number(r.time_second) >= battlefieldStart)
        .sort(
        (a, b) => Number(b.time_second || 0) - Number(a.time_second || 0)
      );
      if (!reports.length) continue;
      const latest = reports[0];
      const bosses = (latest.battle_infos || [])
        .map(v => v?.boss?.name)
        .filter(Boolean);
      if (!bosses.length) continue;
      const role = indexRes?.data?.role || {};
      const info = {
        bosses,
        area: fmtBattlefieldArea(latest.area),
        score: latest.score || 0,
        rank: latest.rank || 0,
        uid: role.role_id || auth.uid,
        nickname: role.nickname || '',
        region: serverMap[server] || server,
        dataTime: moment().format('MM-DD HH:mm'),
      };
      await redis.set(BATTLEFIELD_CACHE_KEY, JSON.stringify(info), { EX: 2 * 3600 });
      return info;
    } catch (err) {
      if (config().debug) logger.mark(`[xhh][bh3_battlefield_boss] ${server} failed: ${err.message}`);
    }
  }
  return null;
}

export async function getCurrentAbyssInfoByEvent(e) {
  const qq = e?.at || e?.user_id;
  const auth = await getAuthByQQ(qq);
  return fetchCurrentAbyssInfo(auth);
}

export async function getCurrentBattlefieldInfoByEvent(e) {
  const qq = e?.at || e?.user_id;
  const auth = await getAuthByQQ(qq);
  return fetchCurrentBattlefieldInfo(auth);
}

export async function getAnyCurrentAbyssText(compact = true) {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      const info = JSON.parse(cached);
      if (isCachedAbyssInfoValid(info)) return formatCurrentAbyssInfo(info, compact);
      await redis.del(CACHE_KEY);
    }
  } catch (_) {}
  const auth = await findAnyBh3Auth();
  const info = auth ? await fetchCurrentAbyssInfo(auth) : null;
  return info ? formatCurrentAbyssInfo(info, compact) : '';
}
