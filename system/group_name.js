import fs from 'node:fs'
import yaml from './yaml.js'

const CACHE_PATH = './plugins/xhh/data/GroupName.yaml'

const getCache = () => {
  try {
    if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, '{}\n')
    return yaml.get(CACHE_PATH) || {}
  } catch (_) {
    return {}
  }
}

const saveCache = (data) => {
  try {
    yaml.set(CACHE_PATH, data)
  } catch (_) {}
}

const pickId = (item = {}) =>
  Number(item.group_id ?? item.groupId ?? item.id ?? item.gid ?? item.group ?? 0) || 0

const pickName = (item = {}) =>
  String(item.group_name ?? item.groupName ?? item.name ?? '').trim()

const toArray = (groups) => {
  if (!groups) return []
  if (typeof groups.values === 'function') return Array.from(groups.values())
  if (Array.isArray(groups)) return groups
  if (typeof groups === 'object') return Object.values(groups)
  return []
}

// 同步取当前已知群名：Bot 内存中的群信息 + 本地缓存
function getGroupNameMap() {
  const map = new Map()
  for (const [key, value] of Object.entries(getCache())) map.set(String(key), String(value))

  const bot = globalThis.Bot || {}
  const lists = [bot.gl, ...Object.values(bot.bots || {}).map(item => item?.gl)]
  for (const list of lists) {
    for (const item of toArray(list)) {
      const id = pickId(item)
      const name = pickName(item)
      if (id && name) map.set(String(id), name)
    }
  }
  return map
}

// 把当前所有群（群号 + 群名）落盘，供锅巴启动时读取
function cacheGroupList() {
  const bot = globalThis.Bot || {}
  const lists = [bot.gl, ...Object.values(bot.bots || {}).map(item => item?.gl)]
  const names = getGroupNameMap()
  let changed = false
  for (const list of lists) {
    for (const item of toArray(list)) {
      const id = pickId(item)
      const name = pickName(item)
      if (id && name && names.get(String(id)) !== name) {
        names.set(String(id), name)
        changed = true
      }
    }
  }
  if (changed) saveCache(Object.fromEntries(names))
  return names
}

// 对缺失群名的群号调用适配器接口补齐，结果落盘缓存
async function refreshGroupNames(groupIds = []) {
  const map = getGroupNameMap()
  const bot = globalThis.Bot || {}
  const clients = Object.values(bot.bots || {}).filter(item => item && typeof item.getGroupInfo === 'function')
  const changed = {}
  for (const raw of groupIds) {
    const id = Number(raw)
    if (!id || map.get(String(id))) continue
    for (const client of clients) {
      try {
        const info = await client.getGroupInfo(id, true)
        const name = pickName(info || {})
        if (name) {
          changed[String(id)] = name
          map.set(String(id), name)
          break
        }
      } catch (_) {}
    }
  }
  if (Object.keys(changed).length) saveCache({ ...getCache(), ...changed })
  return map
}

export { getGroupNameMap, refreshGroupNames, cacheGroupList }
