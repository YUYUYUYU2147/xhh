/**
 * 图鉴卡面自检：改完模板/视图必跑。
 *   node plugins/xhh/tools/check_templates.mjs
 * 做两件事：
 *   1) 所有 html 模板 art.compile() 语法检查（`node --check` 查不到模板语法）
 *   2) 各游戏卡面用样例视图渲染一遍，抓「空标题块」和「undefined」
 * 以后每轮改动后先跑这个，别再拿没验证的东西交付。
 */
import fs from 'fs'
import art from 'art-template'
import path from 'path'

// tools/ 位于 plugins/xhh/tools/，插件根目录即其上一级
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const wikiDir = path.join(root, 'resources/wiki')

let fail = 0
const files = fs.readdirSync(wikiDir).filter(f => f.endsWith('.html'))
for (const f of files) {
  const src = fs.readFileSync(path.join(wikiDir, f), 'utf8')
  try { art.compile(src) } catch (e) { fail++; console.log(`✗ 模板语法失败 ${f}: ${String(e.message).split('\n').pop()}`) }
}
console.log(fail ? `${fail}/${files.length} 个模板语法失败` : `✓ ${files.length} 个模板语法通过`)

// 样例视图（字段来自各游戏真实数据结构，缺字段要在这里补）
globalThis.logger = { info: () => {}, debug: () => {}, warn: () => {} }
const { gsRoleView, srRoleView } = await import(path.join(root, 'system/role_detail.js'))
const cases = [
  ['原神角色', 'gs_role_nk', { name: '测试角色', sys: {}, chara_info: {}, skills: [], constellations: [], passives: [], materials: [], tags: [], info: [], stats: [], badges: [] }],
  ['星铁角色', 'sr_role_nk', { name: '测试角色', sys: {}, chara_info: {}, skills: [], ranks: [], passives: [], materials: [], tags: [], info: [], stats: [], skillGroups: [], relicSets4: [], relicSets2: [], recoLightcones: [] }],
  ['原神武器', 'gs_item_bwiki', { name: '测试武器', sys: {}, stars: 5, starList: [0], panel: [{ lv: '90级', cells: [{ v: '674', span: 0 }] }], agents: [{ name: '甘雨', reason: '理由' }], materialTotal: [{ name: '精锻刀', num: 7 }], skillName: '技能', skillDesc: '效果', intro: '简介', origin: '故事' }],
  ['星铁光锥', 'sr_item_bwiki', { name: '测试光锥', sys: {}, intro: '简介', talent: '效果名', talentDesc: '效果', panel: [{ lv: '80', cells: [{ v: '1058' }] }], panelHead: ['生命值'], agents: [], origin: '故事', storyTitle: '光锥故事', path: '欢愉', damage: '量子' }],
  ['遗器类', 'relic_bwiki', { name: '测试遗器', sys: {}, agents: [], set2: '', set4: '', story: '', storyTitle: '故事', setIcons: [], pieceIcons: [], cornerIcons: [], badges: [], tables: [] }],
  ['绝区零角色', 'zzz_role_nk', { name: '测试代理人', sys: {}, info: [], stats: [], skillGroups: [], avatars: {}, badges: [], materials: [] }],
  ['绝区零邦布', 'zzz_yq_bwiki', { name: '测试邦布', sys: {}, stats: [], talents: [], teams: [], teamReasons: [], panel: [], panelSub: [], panelSubHead: [], materials: [], materialTotal: [] }],
  // 音擎面板改为仅输出最高等级一行，且不再区分突破前 / 突破后，视图字段相应调整为 { lv, atk, sub }
  ['绝区零音擎', 'zzz_wq_bwiki', { name: '测试音擎', sys: {}, baseAtk: '112', randName: '暴击率', randValue: '5%', talent: { name: 'x', desc: 'y' }, agents: [], panel: [{ lv: '60', atk: '713', sub: '24%' }], materials: [], materialTotal: [{ name: '丁尼', num: '40万' }] }],
]
for (const [label, tpl, view] of cases) {
  const src = fs.readFileSync(path.join(wikiDir, tpl + '.html'), 'utf8').replace('{{ppath}}', 'file://' + wikiDir + '/')
  let html
  try { html = art.render(src, { ...view, sys: {} }) } catch (e) { fail++; console.log(`✗ 渲染失败 ${label}: ${e.message}`); continue }
  const empty = [...html.matchAll(/<div class="(?:cell-t|ptitle)">([^<]*)<\/div>\s*<(?:div|table)[^>]*>\s*<\/(?:div|table)>/g)].map(m => m[1])
  const undef = (html.match(/undefined/g) || []).length
  if (empty.length) { fail++; console.log(`✗ ${label} 空区块: ${empty.join(',')}`) }
  if (undef) { fail++; console.log(`✗ ${label} 输出里出现 undefined ×${undef}`) }
  if (!empty.length && !undef) console.log(`✓ ${label}`)
}
console.log(fail ? `\n✗ ${fail} 项未通过` : '\n✓ 全部通过')
process.exit(fail ? 1 : 0)
