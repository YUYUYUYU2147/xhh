# 原神 Bwiki 图鉴数据抓取（原型）

把 `wiki.biligame.com/ys` 的角色页渲染成图鉴卡片，数据全部来自 Bwiki，
不依赖 nanoka。

## 用法

```bash
cd /root/TRSS_AllBot/TRSS-Yunzai

# 1) 抓数据：拉渲染 HTML → 16 张表 → 结构化 JSON + HTML 落盘
node plugins/xhh/tools/bwiki-gs/parse.mjs 菲林斯

# 2) 渲染出图：JSON → gsRoleView → 模板 → PNG
node plugins/xhh/tools/bwiki-gs/render.mjs 菲林斯
```

产物在 `plugins/xhh/temp/` 与 `/tmp/opencode/out/`。

## 接口

| 用途 | 接口 |
|---|---|
| 渲染 HTML（主数据源） | `api.php?action=parse&page=<角色>&prop=text&format=json` |
| 角色列表 | `api.php?action=ask&query=[[分类:角色]]&limit=500&format=json`（SMW，实测 133 名） |

REST API 不可用（`501 无法抓取 Parsoid HTML`）。
`action=parse` 会偶发返回 `HTTP 567`（腾讯 EdgeOne 拦截页，body 是 HTML），
两个脚本都做了 content-type 校验 + 重试。

## 数据来源分布

页面共 16 张表：

| 表 | 内容 | 用在哪 |
|---|---|---|
| 1 | 基础信息 17 项 | 角色档案 |
| 2 | 属性成长 1→90 级，含突破前/突破后 | 基础属性（取 90 级） |
| 3 | 突破材料总计 | 参考 |
| 4 | 突破各档材料 + 数量 + 解锁天赋 | 突破材料区块 |
| 5 | 其他信息 19 项（CV/生日/卡池UP次数…） | 角色档案 |
| 6 | 角色故事（标题行+内容行交替） | 角色故事区块 |
| 7 | 命座 6 条 | 命座区块 |
| 8-14 | 7 个技能的详细属性 LV1..LV15 | 技能区块（8-10 主技能，11-14 突破天赋） |
| 15-16 | 技能升级材料 1→2 … 9→10 | 暂未上模板 |
| — | 技能块描述（r-skill-title-1 + 描述段） | 技能描述 + 天赋 |

## 已知问题

- **页名映射**：现在直接把用户输入当维基页名。`娜可露露` 会 `missingtitle`
  （维基上可能是别的名字/形态页）。`薇斯纶` 实际叫 `薇斯纳`。
  `[[分类:角色]]` 那 133 条可作映射表。
- **图片过长**：全图 6000+ px / 5MB，QQ 发不出去。角色故事需折叠或分页。
- **技能升级材料已解析但未上模板**。
- 四星角色与早期角色的页面结构未验证。

## 模板改动（已在仓库，未提交）

`resources/wiki/gs_role_nk.html` 新增 4 个区块，全部用 `{{if xxx}}` 包裹，
数据源没有对应字段就不渲染，**nanoka 路径零影响**：

- `{{if profile}}` 角色档案
- `{{if passives}}` 天赋
- `{{if characterStory}}` 角色故事

页脚由写死的 `数据来源 nanoka.cc` 改为 `{{source}}`。

`resources/wiki/gs_role_nk.css` 追加对应样式。

原模板备份在 `/tmp/opencode/tpl-backup.html`。
