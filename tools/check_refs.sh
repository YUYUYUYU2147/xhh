#!/bin/bash
# 图鉴代码静态检查（抓 node --check 抓不到的那类错）：
#   1) eslint no-undef —— 跨函数引用、方法没定义（nmKey / srContentId 就是这么崩的）
#   2) node --check      —— 语法
#   3) check_templates.mjs —— 模板语法 + 8 类卡面渲染
# 改完代码请跑这个，全绿再提交/重启。
cd "$(dirname "$0")/../../.." || exit 1
ESL=".pnpm/eslint@8.57.1_supports-color@5.5.0/node_modules/eslint/bin/eslint.js"
ESL="node_modules/$ESL"
fail=0

echo "── 1/3 eslint no-undef ──"
if [ -f "$ESL" ]; then
  node "$ESL" --no-eslintrc -c plugins/xhh/tools/.eslintrc.check.json \
    "plugins/xhh/apps/**/*.js" "plugins/xhh/system/**/*.js" plugins/xhh/guoba.support.js || fail=1
else
  echo "⚠ 找不到 eslint，跳过（无法保证运行时引用正确）"; fail=1
fi

echo "── 2/3 node --check ──"
for f in $(git -C plugins/xhh ls-files '*.js' 2>/dev/null); do
  node --check "plugins/xhh/$f" || fail=1
done
echo "（无输出=全部通过）"

echo "── 3/3 模板与卡面 ──"
node plugins/xhh/tools/check_templates.mjs 2>&1 | grep -vE "^anonymous:|Template upgrade" | tail -14 || fail=1

[ $fail -eq 0 ] && echo "✅ 三项全过" || echo "❌ 有未通过项，别重启"
exit $fail
