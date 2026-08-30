import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { render, mhy, pluginPriority } from '#xhh'
import GachaLog from '../../genshin/model/gachaLog/gachaLog.js'
import { SrGachaSummary, readSummary, getSrGachaCookieFile, readSrGachaCookie, saveSrGachaCookie, extractSrGachaCookie, formatSrGachaFailure } from '../../genshin/model/gachaLog/srGachaSummary.js'
import { Character, Weapon } from '../../miao-plugin/models/index.js'
import MysInfo from '../../genshin/model/mys/mysInfo.js'

const API_URL = 'https://act-api-takumi.mihoyo.com/event/rpg_gacha_record/five_star_list'
const BADGE_API_URL = 'https://api-takumi.mihoyo.com/common/badge/v1/login/account'
const POOLS = [
  { type: 'GachaType_AvatarUp', key: 'char', name: '角色活动跃迁', hint: '角色' },
  { type: 'GachaType_EquipmentUp', key: 'weapon', name: '光锥活动跃迁', hint: '光锥' },
  { type: 'GachaType_CollabAvatarUp', key: 'collabChar', name: '联动角色跃迁', hint: '联动角色' },
  { type: 'GachaType_CollabEquipmentUp', key: 'collabWeapon', name: '联动光锥跃迁', hint: '联动光锥' },
  { type: 'GachaType_Newbie', key: 'newbie', name: '新手跃迁', hint: '新手' },
]

// 渲染排列顺序：角色类一组、光锥类一组，方便左右对齐
const POOL_ORDER = [
  'GachaType_AvatarUp',
  'GachaType_CollabAvatarUp',
  'GachaType_EquipmentUp',
  'GachaType_CollabEquipmentUp',
  'GachaType_Newbie',
  'common',
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function setCookieValue(headers, name) {
  const raw = headers?.getSetCookie?.() || headers?.raw?.()?.['set-cookie'] || []
  for (const item of raw) {
    const match = String(item).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`))
    if (match?.[1]) return match[1]
  }
  const one = headers?.get?.('set-cookie') || ''
  const match = String(one).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`))
  return match?.[1] || ''
}

function sum(arr, field) {
  return arr.reduce((n, v) => n + Number(v?.[field] || 0), 0)
}

function buildGroupStats(pools, keys, title) {
  const list = pools.filter(pool => keys.includes(pool.key))
  const totalFive = sum(list, 'fiveNum')
  const totalPulls = sum(list, 'totalPulls')
  const totalUp = sum(list, 'upNum')
  const avgPity = totalFive ? (totalPulls / totalFive).toFixed(1) : '0.0'
  const upAvg = totalUp ? (totalPulls / totalUp).toFixed(1) : '0.0'
  const upYs = Number(upAvg) ? (Number(upAvg) * 160).toFixed(0) : '0'
  const maxPity = list.length ? Math.max(...list.map(v => Number(v.maxPity || 0))) : 0
  const minPity = list.length ? Math.min(...list.map(v => Number(v.minPity || 0)).filter(v => v > 0)) || 0 : 0
  return {
    title,
    totalFive,
    totalPulls,
    avgPity,
    upAvg,
    upYs: Number(upYs) >= 10000 ? `${(Number(upYs) / 10000).toFixed(2)}w` : upYs,
    maxPity,
    minPity,
    totalUp,
    upRate: totalFive ? pct(totalUp, totalFive) + '%' : '0.0%',
  }
}

function buildPoolStats(pool) {
  return {
    title: pool?.name || '',
    fiveNum: Number(pool?.fiveNum || 0),
    avgPity: pool?.avgPity || '0.0',
    maxPity: Number(pool?.maxPity || 0),
    minPity: Number(pool?.minPity || 0),
  }
}

function pct(a, b) {
  if (!b) return '0.0'
  return ((a / b) * 100).toFixed(1)
}

function formatNow() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeFromId(id) {
  const ms = Number(String(id || '').slice(0, 13))
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function buildSummaryView(data, uid, e, layout = 'grid') {
  const pools = Object.entries(data?.pools || {}).map(([key, pool]) => {
    const recent = Array.isArray(pool.records) ? pool.records : (Array.isArray(pool.recent) ? pool.recent : [])
    const fiveNum = recent.length
    const upNum = recent.filter(v => v.is_up).length
    const pity = Number(typeof pool.pity === 'object' ? pool.pity?.gacha_count : pool.pity || 0) || 0
    const totalPulls = (sum(recent, 'gacha_count') + pity) || 0
    const pullValues = recent.map(v => Number(v.gacha_count || 0)).filter(v => v > 0)
    const upValues = recent.filter(v => v.is_up).map(v => Number(v.gacha_count || 0)).filter(v => v > 0)
    const fiveAvg = fiveNum ? (sum(recent, 'gacha_count') / fiveNum).toFixed(1) : '--'
    const upAvg = upValues.length ? (sum(recent.filter(v => v.is_up), 'gacha_count') / upValues.length).toFixed(1) : '--'
    let upYs = upValues.length ? String(Math.round(Number(upAvg) * 160)) : '--'
    if (upValues.length && Number(upYs) >= 10000) upYs = `${(Number(upYs) / 10000).toFixed(2)}w`
    const maxPity = pullValues.length ? Math.max(...pullValues) : 0
    const minPity = pullValues.length ? Math.min(...pullValues) : 0
    const upRate = fiveNum ? pct(upNum, fiveNum) : '--'
    const makeIcon = item => {
      try {
        if (item.item_type === '角色') {
          const char = Character.get(item.name, 'sr')
          const face = char?.imgs?.face || char?.face || ''
          return face ? `../../../../../plugins/miao-plugin/resources${face}` : ''
        }
        if (item.item_type === '光锥') {
          const weapon = Weapon.get(item.name, 'sr')
          const img = weapon?.getData?.('img')?.img || weapon?.img || ''
          return img ? `../../../../../plugins/miao-plugin/resources/${String(img).replace(/^\//, '')}` : ''
        }
      } catch {}
      return ''
    }
    // 五星历史：按时间倒序，供卡片网格使用
    const fiveLog = recent.map(item => {
      const pulls = Number(item.gacha_count || 0)
      const time = item.time || timeFromId(item.id)
      const full = String(time || '').slice(0, 10)
      return {
        name: item.name || '未知',
        icon: makeIcon(item),
        num: pulls,
        isUp: item.is_up === true,
        isNull: false,
        year: full.slice(0, 4) || '----',
        fullDate: full || '--',
        monthDay: full.slice(5) || '--',
      }
    }).sort((a, b) => String(b.year + b.monthDay).localeCompare(String(a.year + a.monthDay)))
    // 按年份分组（年份倒序，组内保持时间倒序）
    const yearGroups = []
    for (const item of fiveLog) {
      let group = yearGroups.find(g => g.year === item.year)
      if (!group) {
        group = { year: item.year, list: [] }
        yearGroups.push(group)
      }
      group.list.push(item)
    }
    // 数据总览：两行 x 四列
    const line = [
      [
        { num: fiveNum ? pity : '--', unit: '', lable: '未出五星' },
        { num: fiveAvg, unit: '', lable: '五星平均' },
        { num: upRate, unit: '%', lable: '小保底不歪率' },
        { num: maxPity || '--', unit: '', lable: '最非' },
      ],
      [
        { num: '--', unit: '', lable: '未出四星' },
        { num: upAvg, unit: '', lable: 'UP平均' },
        { num: upYs, unit: '', lable: 'UP花费星琼' },
        { num: minPity || '--', unit: '', lable: '最欧' },
      ],
    ]
    const typeMap = {
      GachaType_AvatarUp: '301',
      GachaType_EquipmentUp: '302',
      GachaType_CollabAvatarUp: '303',
      GachaType_CollabEquipmentUp: '304',
      GachaType_Newbie: '1001',
      common: '200',
    }
    const labelClassMap = {
      GachaType_AvatarUp: 'char',
      GachaType_EquipmentUp: 'weapon',
      GachaType_CollabAvatarUp: 'collabChar',
      GachaType_CollabEquipmentUp: 'collabWeapon',
      GachaType_Newbie: 'newbie',
      common: 'common',
    }
    return {
      ...pool,
      key,
      type: typeMap[key] || pool.type || '301',
      labelClass: labelClassMap[key] || 'char',
      name: pool.name || '未知',
      allNum: totalPulls,
      fiveNum,
      upNum,
      pity,
      maxPity,
      minPity,
      upRate: `${upRate}%`,
      fiveLog,
      yearGroups,
      line,
      fiveAvg,
      firstTime: fiveLog.length ? fiveLog[fiveLog.length - 1].fullDate : '--',
      lastTime: fiveLog.length ? fiveLog[0].fullDate : '--',
    }
  }).sort((a, b) => {
    const ia = POOL_ORDER.indexOf(a.key)
    const ib = POOL_ORDER.indexOf(b.key)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  // progress 进度条布局：每个卡池生成一个进度区块
  if (layout === 'progress') {
    const nickname = data?.nickname || e?.nickname || e?.user?.nickname || '开拓者'
    const sections = []
    for (const pool of pools) {
      if (!pool.fiveNum && !pool.pity) continue
      const maxBar = Math.max(pool.maxPity || 0, pool.pity || 0, 80)
      const list = []
      if (pool.pity > 0) {
        list.push({
          isCurrent: true,
          date: formatNow().slice(5),
          name: '已抽',
          icon: '',
          num: pool.pity,
          isUp: false,
          pct: Math.min(100, Math.round((pool.pity / maxBar) * 100)),
          barClass: 'current',
        })
      }
      for (const item of pool.fiveLog || []) {
        const cls = item.num <= 10 ? 'gold' : (item.num < maxBar * 0.5 ? 'good' : (item.num < maxBar * 0.83 ? 'normal' : 'bad'))
        list.push({
          isCurrent: false,
          date: item.monthDay,
          name: item.name,
          icon: item.icon,
          num: item.num,
          isUp: item.isUp,
          pct: Math.min(100, Math.round((item.num / maxBar) * 100)),
          barClass: cls,
        })
      }
      sections.push({
        title: pool.name,
        labelClass: pool.labelClass,
        allNum: pool.allNum,
        fiveNum: pool.fiveNum,
        avgPity: pool.fiveAvg,
        upAvg: pool.line?.[1]?.[1]?.num || '--',
        upYs: pool.line?.[1]?.[2]?.num || '--',
        list,
      })
    }
    return {
      uid,
      nickname,
      avatar: e?.user?.avatar || '',
      sections,
    }
  }
  if (!pools.some(pool => pool.key === 'common')) {
    pools.push({
      key: 'common',
      type: '200',
      labelClass: 'common',
      name: '常驻跃迁',
      allNum: 0,
      fiveNum: 0,
      upNum: 0,
      pity: 0,
      maxPity: 0,
      minPity: 0,
      upRate: '--',
      fiveLog: [],
      yearGroups: [],
      line: [
        [{ num: '--', unit: '', lable: '未出五星' }, { num: '--', unit: '', lable: '五星平均' }, { num: '--', unit: '%', lable: '小保底不歪率' }, { num: '--', unit: '', lable: '最非' }],
        [{ num: '--', unit: '', lable: '未出四星' }, { num: '--', unit: '', lable: 'UP平均' }, { num: '--', unit: '', lable: 'UP花费星琼' }, { num: '--', unit: '', lable: '最欧' }],
      ],
      firstTime: '--',
      lastTime: '--',
    })
  }
  return {
    uid,
    update_time: data?.update_time || '未知',
    pools,
  }
}

function filterPools(data, keys = []) {
  if (!data?.pools) return data
  if (!keys.length) return data
  const pools = {}
  for (const [key, value] of Object.entries(data.pools)) {
    if (keys.includes(key)) pools[key] = value
  }
  return { ...data, pools }
}

async function requestJson(url, options = {}, retry = 3) {
  let last
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, options)
      const data = await res.json()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { res, data }
    } catch (e) {
      last = e
      if (i < retry - 1) await sleep(600 * (i + 1))
    }
  }
  throw last
}

function normalizeRecordsByPool(list = []) {
  const pools = {}
  for (const pool of POOLS) {
    pools[pool.key] = { ...pool, records: [], pity: 0, totalPulls: 0, fiveNum: 0, upNum: 0, avgPity: 0 }
  }
  for (const row of list) {
    if (row?.got_item !== true || row?.item?.rarity !== 5) continue
    const pool = POOLS.find(v => v.type === row.gacha_type || row?.gacha_type === v.type)
    if (!pool) continue
    const itemType = row.item.item_type === 'ItemType_Avatar' ? '角色' : '光锥'
    const rec = {
      id: String(row.id || row.uuid || ''),
      name: row.item.name || '未知',
      item_type: itemType,
      is_up: row.is_up === true,
      gacha_count: Number(row.gacha_count) >= 0 ? Number(row.gacha_count) : null,
      time: row.time || '',
      icon: row.item.icon || row.item.image || '',
    }
    pools[pool.key].records.push(rec)
  }

  for (const pool of Object.values(pools)) {
    pool.records.sort((a, b) => String(b.time).localeCompare(String(a.time)))
    pool.fiveNum = pool.records.length
    pool.upNum = pool.records.filter(v => v.is_up).length
    pool.totalPulls = sum(pool.records, 'gacha_count') + (pool.pity || 0)
    pool.avgPity = pool.fiveNum ? (sum(pool.records, 'gacha_count') / pool.fiveNum).toFixed(1) : '0.0'
    pool.latest = pool.records[0]?.time || ''
    pool.records = pool.records.slice(0, 8)
  }

  return { pools }
}

async function getUserAuth(e) {
  const qq = e.user_id
  const uid = e.user?.getUid?.('sr')
  if (!uid) return { error: '请先用 genshin 侧绑定星铁账号，再更新抽卡记录' }

  const cookieFile = getSrGachaCookieFile(qq)
  const candidates = [
    readSrGachaCookie(cookieFile),
    e.cookie,
  ]
  try {
    const mysInfo = new MysInfo(e)
    mysInfo.uid = uid
    candidates.push(await mysInfo.getCookie('sr'))
  } catch {}
  try {
    candidates.push(e.user?.getMysUser?.('sr')?.ck)
  } catch {}

  const cookies = [...new Set(candidates.map(v => String(v || '').trim()).filter(Boolean))]
  if (!cookies.length) return { error: '请先用 genshin 侧绑定星铁账号，再更新抽卡记录' }
  return { qq, uid, cookies, cookieFile }
}

async function refreshBadgeCookie(uid, ck, region) {
  const { res, data } = await requestJson(BADGE_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: 'https://act.mihoyo.com',
      referer: 'https://act.mihoyo.com/',
      Cookie: ck,
    },
    body: JSON.stringify({ uid, region, game_biz: 'hkrpg_cn', lang: 'zh-cn' }),
  })
  if (data?.retcode !== 0) throw new Error(data?.message || '换取徽章会话失败')
  const token = setCookieValue(res.headers, 'e_hkrpg_token')
  if (!token) throw new Error('未获取到 e_hkrpg_token')
  return `${ck};e_hkrpg_token=${token}`
}

async function fetchPool(uid, region, ck, gachaType) {
  let versionId = ''
  let maxId = ''
  const rows = []
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      game_biz: 'hkrpg_cn',
      region,
      uid: String(uid),
      badge_region: region,
      badge_uid: String(uid),
      gacha_type: gachaType,
    })
    if (versionId) params.set('version_id', versionId)
    if (maxId) params.set('max_id', maxId)
    const { data } = await requestJson(`${API_URL}?${params}`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://act.mihoyo.com',
        referer: 'https://act.mihoyo.com/',
        'x-rpc-platform': 'android',
        'x-rpc-jump_source': '2',
        Cookie: ck,
      },
    })
    if (data?.retcode !== 0) throw new Error(data?.message || '获取跃迁记录失败')
    const list = data?.data?.list || []
    rows.push(...list)
    if (!data?.data?.has_more) break
    versionId = data?.data?.version_id || ''
    maxId = data?.data?.next_max_id || ''
    if (!versionId || !maxId) break
  }
  return rows
}

function getDataFile(uid, qq) {
  return `./plugins/xhh/data/sr_gacha/${qq}/${uid}/summary.json`
}

function buildCommonPoolView(data) {
  const recent = Array.isArray(data?.fiveLog) ? data.fiveLog : []
  return {
    key: 'common',
    type: '1',
    name: '常驻跃迁',
    recent: recent.map(item => ({
      id: String(item.id || `${item.time}-${item.name}`),
      name: item.name || '未知',
      item_type: item.item_type || '角色',
      is_up: !!item.isUp,
      gacha_count: Number(item.num || 0),
      time: item.time || '',
      icon: item.icon || '',
    })),
    pity: Number(data?.noFiveNum || 0),
    totalPulls: Number(data?.allNum || 0),
    fiveNum: Number(data?.fiveNum || 0),
    upNum: 0,
    upRate: '0.0',
    avgPity: Number(data?.fiveAvg || 0).toFixed?.(1) || String(data?.fiveAvg || 0),
    maxPity: Math.max(...recent.map(v => Number(v.num || 0)).filter(Boolean), 0),
    minPity: Math.min(...recent.map(v => Number(v.num || 0)).filter(Boolean), 0) || 0,
    upAvg: '0.0',
    upYs: '0',
  }
}

async function fetchCommonPool(e, uid) {
  const fakeEvent = {
    ...e,
    isSr: true,
    msg: '#星铁常驻',
    raw_message: '#星铁常驻',
    original_msg: '#星铁常驻',
    isAll: false,
    reply: async () => {},
  }
  const data = await new GachaLog(fakeEvent).getGcLogData()
  if (!data?.fiveLog) return null
  return buildCommonPoolView(data)
}

function getSrRegion(uid) {
  return /^5/.test(String(uid || '')) ? 'prod_qd_cn' : 'prod_gf_cn'
}

function md5Hex(str) {
  return createHash('md5').update(str, 'utf8').digest('hex')
}

// 米游社 DS 签名，算法与 genshin 插件一致（国服 salt）
function getDs(query = '', body = '') {
  const salt = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const ds = md5Hex(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`)
  return `${t},${r},${ds}`
}

// 通过 genshin 绑定的崩铁 ck 获取游戏内昵称/头像
// 崩铁 index 接口要求 DS 签名（裸请求会被拒绝），故改用与 genshin 插件相同的 record 域名 + DS 头
async function fetchSrUserInfo(uid, ck) {
  const query = `role_id=${String(uid)}&server=${getSrRegion(uid)}`
  const { data } = await requestJson(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/index?${query}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://act.mihoyo.com',
        referer: 'https://act.mihoyo.com/',
        'x-rpc-app_version': '2.40.1',
        'x-rpc-client_type': '5',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Mobile Safari/537.36',
        DS: getDs(query),
        Cookie: ck,
      },
    }
  )
  if (data?.retcode !== 0) throw new Error(data?.message || '获取角色信息失败')
  return data?.data || {}
}

// 米游社名片接口：免 DS，直接返回昵称/米游社头像
async function fetchGameRecordCard(uid, ck) {
  const { data } = await requestJson(
    `https://api-takumi.mihoyo.com/game_record/card/wapi/getGameRecordCard?uid=${String(uid)}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://api-takumi.mihoyo.com',
        referer: 'https://webstatic.mihoyo.com/',
        'x-rpc-client_type': '5',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Mobile Safari/537.36',
        Cookie: ck,
      },
    }
  )
  if (data?.retcode !== 0) throw new Error(data?.message || '获取用户信息失败')
  const list = data?.data?.list || []
  const mine = list.find(item => String(item.uid) === String(uid)) || list[0]
  return {
    nickname: mine?.nickname || '',
    avatar: mine?.avatar_url || '',
  }
}

function readData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function saveData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

export class sr_gacha extends plugin {
  constructor() {
    super({
      name: '[小花火]星铁抽卡记录',
      dsc: '星铁抽卡记录查询与更新',
      event: 'message',
      priority: pluginPriority('sr_gacha', 100),
      rule: [
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?抽卡帮助$', fnc: 'help' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(刷新|更新)抽卡记录$', fnc: 'refresh' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(抽卡记录|抽卡统计)$', fnc: 'summary' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?角色记录$', fnc: 'roleRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?武器记录$', fnc: 'weaponRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?联动角色记录$', fnc: 'collabRoleRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?联动武器记录$', fnc: 'collabWeaponRecord' },
        { reg: '^#*(xhh|小花火)?(星铁|崩铁)?常驻(记录|统计)?$', fnc: 'common' },
      ],
    })
  }

  async refresh(e) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply('正在获取星铁抽卡记录，请稍候……')
    let lastError
    try {
      let result
      for (const cookie of auth.cookies) {
        try {
          const summary = new SrGachaSummary({ uid: auth.uid, cookie, file: `./data/srGachaSummary/${auth.uid}.json` })
          result = await summary.update()
          saveSrGachaCookie(auth.cookieFile, cookie)
          break
        } catch (err) {
          lastError = err
          logger.mark(`[xhh][sr_gacha] Cookie 候选失败：${err?.message || err}`)
        }
      }
      if (!result) throw lastError || new Error('没有可用的崩铁 Cookie')
      try {
        const common = await fetchCommonPool(e, auth.uid)
        if (common?.recent?.length) {
          result.pools.common = common
        }
      } catch (error) {
        logger.mark(`[xhh][sr_gacha] 常驻同步失败：${error?.message || error}`)
      }
      result.update_time = formatNow()
      saveData(getDataFile(auth.qq, auth.uid), result)
      const text = POOLS.map(pool => {
        const updated = result.addedByPool?.[pool.type] || 0
        return `【${pool.name}】记录获取成功，更新${updated}条`
      }).join('\n')
      const commonText = result.pools?.common?.recent?.length ? `\n【常驻跃迁】记录获取成功，更新${result.pools.common.recent.length}条` : ''
      await e.reply(`${text}${commonText}\n抽卡记录更新完成`)
      // 更新完成后自动输出抽卡记录总览图
      await this.renderSummary(e, [], 'grid')
      return e.reply('发送【#xhh星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[xhh][sr_gacha] refresh failed:', err)
      if (String(err?.message || err).includes('请从游戏内打开参与活动')) {
        return e.reply('当前账号还没在游戏内打开过跃迁活动页。\n请先进《星穹铁道》里点开一次活动跃迁页面，再发送【#xhh星铁更新抽卡记录】重试。')
      }
      return e.reply(formatSrGachaFailure(err))
    }
  }

  async renderSummary(e, keys = [], layout = 'grid') {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const data = readData(getDataFile(auth.qq, auth.uid)) || readSummary(`./data/srGachaSummary/${auth.uid}.json`)
    if (!data?.pools) return e.reply('暂无星铁抽卡记录，请先发送【#xhh星铁更新抽卡记录】')
    const view = buildSummaryView(filterPools(data, keys), auth.uid, e, layout)
    if (layout === 'progress') {
      let avatar = ''
      try {
        // 头像优先读取 genshin 插件 [*uid][用户绑定(showUid)] 缓存的头像，与 *uid 卡片保持一致
        try {
          avatar = await redis.get(`Yz:genshin:uidFaceUrl:sr:${auth.uid}`)
        } catch (err) {
          logger.mark(`[xhh][sr_gacha] 读取绑定头像缓存失败：${err?.message || err}`)
        }
        const info = await fetchSrUserInfo(auth.uid, auth.cookies[0])
        // 昵称在 role 字段中
        if (info?.role?.nickname) view.nickname = info.role.nickname
        if (!avatar) {
          // 缓存为空：从 index API 取头像 URL（role.AvatarUrl 为游戏内头像），并写入绑定缓存
          avatar = info?.role?.AvatarUrl || info?.avatar?.icon || ''
          if (avatar) {
            try {
              await redis.set(`Yz:genshin:uidFaceUrl:sr:${auth.uid}`, avatar, 'EX', 12 * 60 * 60)
            } catch (err) {
              logger.mark(`[xhh][sr_gacha] 写入绑定头像缓存失败：${err?.message || err}`)
            }
          }
        }
        if (avatar) view.avatar = avatar
      } catch (error) {
        logger.mark(`[xhh][sr_gacha] 获取星铁角色信息失败：${error?.message || error}`)
        // 兜底：先试免 DS 的米游社名片接口；仍失败则头像用小花火、昵称保持 QQ 昵称
        try {
          const card = await fetchGameRecordCard(auth.uid, auth.cookies[0])
          if (card?.nickname) view.nickname = card.nickname
          if (!view.avatar && card?.avatar) view.avatar = card.avatar
        } catch (err) {
          logger.mark(`[xhh][sr_gacha] 名片接口兜底获取用户信息失败：${err?.message || err}`)
          logger.mark(`[xhh][sr_gacha] 头像改用小花火，昵称使用 QQ 昵称`)
        }
      }
    }
    const template = layout === 'progress' ? 'sr_gacha/progress' : 'sr_gacha/summary'
    const buf = await render(template, view, { e })
    if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
    return e.reply(buf)
  }

  async summary(e) {
    return this.renderSummary(e, [], 'grid')
  }

  async roleRecord(e) {
    return this.renderSummary(e, ['GachaType_AvatarUp', 'GachaType_CollabAvatarUp', 'common'], 'progress')
  }

  async weaponRecord(e) {
    return this.renderSummary(e, ['GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp'], 'progress')
  }

  async collabRoleRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabAvatarUp'], 'progress')
  }

  async collabWeaponRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabEquipmentUp'], 'progress')
  }

  async common(e) {
    return this.summary(e)
  }

  async help(e) {
    return e.reply([
      '【#xhh星铁抽卡帮助】',
      '— 更新数据 —',
      '#xhh星铁更新抽卡记录　刷新抽卡数据',
      '— 查询指令 —',
      '#xhh星铁抽卡记录　　　抽卡总览统计',
      '#xhh星铁角色记录　　　角色卡池进度',
      '#xhh星铁武器记录　　　武器卡池进度',
      '#xhh星铁联动角色记录　联动角色卡池进度',
      '#xhh星铁联动武器记录　联动武器卡池进度',
      '#xhh星铁常驻记录　　　常驻卡池统计',
    ].join('\n'))
  }
}
