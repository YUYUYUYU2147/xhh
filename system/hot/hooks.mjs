/* ESM 热重载钩子（供 node:module 的 register 使用）
 *
 * 背景：框架热重载只给插件入口加 cache bust（index.js?v=<时间戳>）。
 * 插件内部的 import 都是裸相对路径，不带版本号 —— ESM 按模块 URL 缓存，
 * 于是 system/、apps/ 子目录在热重载后仍返回旧实例，改动不生效。
 *
 * 做法：在 resolve 阶段给「插件内、且不带版本号」的每个模块 URL 追加版本号，
 * 版本号取该文件自身的 mtime：
 *   文件没改 → URL 不变 → 命中缓存复用同一实例；
 *   文件一改 → URL 随之改变 → ESM 视为新模块重新求值。
 *
 * 为什么版本号取文件 mtime，而不是「入口加载时刷新一个批次版本号」：
 *   批次版本号只在框架重新 import 入口（index.js）时才刷新。
 *   实测框架热重载有时只重导顶层 apps/*.js、并不重导入口，
 *   此时批次版本号不变，嵌套模块仍命中旧缓存 —— 改动不生效，只能 #重启。
 *   mtime 与触发方式无关：只要框架重导了入口或任一层 apps/*.js，
 *   链上所有「内容有变」的文件都会自动换新 URL。
 *
 * ⚠ 不能给「任何由插件外部发起、目标在插件内的加载」都分配一个随机版本号：
 *   锅巴框架会单独加载 plugins/xhh/guoba.support.js，那也是一次外部发起。
 *   若按「外部发起」分配随机版本号，guoba 那条链与 index.js 那条链会各自
 *   加载一份 system/ 模块，配置句柄与缓存立刻分裂。
 *   mtime 是确定值：同一文件无论从哪条链加载都得到同一个 URL，因此不会分裂。
 *
 * ⚠ 入口（index.js）保持不带版本号，交给框架自己的 cache bust，
 *   避免把入口钉死在一个固定 URL 上、反而让框架的再次加载命中缓存。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../../', import.meta.url).href
const ENTRY = new URL('index.js', ROOT).href
// 诊断落盘：hooks 线程里拿不到框架的 logger，console 也未必被 pm2 捕获，
// 所以同时把每次「入口加载」追加写进 plugins/xhh/temp/hot_reload.log（.gitignore 已忽略 temp/）。
const MARK = new URL('temp/hot_reload.log', ROOT)
const mark = line => {
  try { fs.appendFileSync(MARK, `${new Date().toISOString()} ${line}\n`) } catch (_) { }
}

/** 取插件内文件自身的 mtime（毫秒）作版本号；取不到返回空串，表示不追加版本号 */
const verOf = url => {
  try { return String(fs.statSync(fileURLToPath(url)).mtimeMs) } catch (_) { return '' }
}

export async function resolve(specifier, context, nextResolve) {
  const res = await nextResolve(specifier, context)
  const parent = context.parentURL || ''
  const inRoot = url => url.startsWith(ROOT)
  const bare = res.url.split('?')[0]
  // 由插件外部发起、且目标正是插件入口 = 框架的一次（重新）加载，留一条诊断
  if (!inRoot(parent) && bare === ENTRY) {
    // 钩子跑在独立的 hooks 线程里，拿不到框架的 logger，用 console 打到同一份日志
    console.log('[xhh][hot] 检测到插件入口加载')
    mark('入口加载')
  }
  if (!inRoot(res.url)) return res
  const u = new URL(res.url)
  // 已经带版本号的（如 index.js 给 apps 拼的 ?v=、或框架给入口拼的）保持原样，避免二次追加
  if (u.searchParams.has('v')) return res
  // 入口自身交给框架，不追加版本号
  if (bare === ENTRY) return res
  const v = verOf(bare)
  if (!v) return res
  u.searchParams.set('v', v)
  return { ...res, url: u.href, shortCircuit: true }
}
