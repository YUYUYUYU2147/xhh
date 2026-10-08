/**
 * 真正的静态检查：解析每个 js，做作用域分析，找出「引用了但没定义」的标识符。
 * 这一类错误 node --check 查不出来（语法合法、运行时 ReferenceError），
 * 之前就是靠它漏掉了 nmKey（跨函数引用）与 srContentId（方法没定义）。
 *   node plugins/xhh/tools/check_refs.cjs
 */
const fs = require('fs')
const path = require('path')
const ACORN = require('/root/TRSS_AllBot/TRSS-Yunzai/node_modules/.pnpm/acorn@8.16.0/node_modules/acorn')
const WALK = require('/root/TRSS_AllBot/TRSS-Yunzai/node_modules/.pnpm/acorn-walk@8.3.5/node_modules/acorn-walk')

const ROOT = path.resolve(__dirname, '..')
const GLOBALS = new Set([
  'console','process','globalThis','global','Buffer','setTimeout','setInterval','clearTimeout','clearInterval',
  'setImmediate','queueMicrotask','fetch','URL','URLSearchParams','TextEncoder','TextDecoder','AbortController',
  'structuredClone','crypto','performance','require','module','exports','__dirname','__filename','import','arguments',
])

function collectFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectFiles(p, out)
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p)
  }
  return out
}

// 收集一个作用域链里可见的名字（声明 + import + 父级）
function scopeNames(node, parentScopes) {
  const names = new Set()
  for (const s of parentScopes) for (const n of s) names.add(n)
  const add = pat => { const m = String(pat || '').match(pat2 => pat2) }
  WALK.simple(node, {
    VariableDeclarator(n) { if (n.id.type === 'Identifier') names.add(n.id.name) },
    FunctionDeclaration(n) { if (n.id) names.add(n.id.name) },
    ClassDeclaration(n) { if (n.id) names.add(n.id.name) },
    FunctionExpression(n) { if (n.id) names.add(n.id.name) },
    AssignmentExpression(n) {
      if (n.left.type === 'Identifier') names.add(n.left.name)
      if (n.left.type === 'MemberExpression' && n.left.object.type === 'Identifier') names.add(n.left.object.name)
      if (n.left.type === 'MemberExpression' && n.left.object.type === 'MemberExpression'
        && n.left.object.object.type === 'Identifier') names.add(n.left.object.object.name)
    },
    MemberExpression(n) {
      // this.foo = ... 也算 foo 已定义
      if (n.object.type === 'ThisExpression' && n.property.type === 'Identifier') names.add(n.property.name)
    },
    ImportDeclaration(n) { for (const sp of n.specifiers || []) names.add(sp.local.name) },
    LabeledStatement() {}, BreakStatement() {}, ContinueStatement() {},
  })
  return names
}

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8')
  let ast
  try {
    ast = ACORN.parse(src, { ecmaVersion: 2024, sourceType: 'module', locations: true })
  } catch (e) {
    return [{ line: e.loc?.line || 0, msg: '语法错误: ' + e.message }]
  }
  const problems = []
  // 模块顶层作用域
  const top = scopeNames(ast, [])
  WALK.fullAncestor(ast, (node, state, ancestors) => {
    if (node.type !== 'Identifier') return
    const parent = ancestors[ancestors.length - 1]
    // 跳过：属性名、非计算成员的对象、对象键、标签、import/导出说明符
    if (parent) {
      const pk = parent.type
      if ((pk === 'MemberExpression' && parent.property === node && !parent.computed)
        || (pk === 'Property' && parent.key === node && !parent.computed)
        || (pk === 'MethodDefinition' && parent.key === node && !parent.computed)
        || pk === 'LabeledStatement' || pk === 'BreakStatement' || pk === 'ContinueStatement'
        || (pk === 'ImportSpecifier') || (pk === 'ExportSpecifier')) return
    }
    const name = node.name
    if (GLOBALS.has(name)) return
    // 局部作用域：函数/块/类
    let fnNode = null
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const t = ancestors[i].type
      if (t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression'
        || t === 'ClassDeclaration' || t === 'ClassExpression' || t === 'BlockStatement'
        || t === 'CatchClause' || t === 'ForStatement' || t === 'ForOfStatement') { fnNode = ancestors[i]; break }
    }
    const visible = fnNode ? scopeNames(fnNode, [top]) : top
    if (!visible.has(name)) {
      problems.push({ line: node.loc?.start.line || 0, msg: `未定义的引用: ${name}` })
    }
  })
  return problems
}

const files = collectFiles(ROOT)
let total = 0
for (const f of files) {
  const probs = checkFile(f)
  if (probs.length) {
    console.log(`\n✗ ${path.relative(ROOT, f)}`)
    for (const p of probs.slice(0, 12)) console.log(`   行 ${p.line}: ${p.msg}`)
    if (probs.length > 12) console.log(`   …还有 ${probs.length - 12} 处`)
    total += probs.length
  }
}
console.log(total ? `\n共 ${total} 处未定义引用（${files.length} 个文件）` : `✓ ${files.length} 个文件无未定义引用`)
process.exit(total ? 1 : 0)
