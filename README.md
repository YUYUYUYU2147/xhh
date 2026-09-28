<h1>小花火插件</h1>

[![License: GPL v2](https://img.shields.io/badge/License-GPL_v2-blue.svg)](LICENSE)

## v2 分支维护说明

本仓库当前 `v2` 分支为 YUYUYUYU2147 维护/适配版本，原作者 README 内容会在下方继续保留，方便追溯项目来源与原始用法。

本分支主要围绕 TRSS-Yunzai / OneBot 环境做功能补充与样式适配，包含但不限于：

- 崩坏3体力、深渊、战场、乐土、主页、水晶手账等查询与图片模板优化；
- 崩坏3抽卡记录、出金记录、历史补给/卡池查询；
- 崩坏3与绝区零 Wiki 图鉴扩展，含角色、武器/音擎、圣痕/驱动盘、人偶/邦布等查询；
- 原神、星铁、绝区零、崩坏3卡池图片化展示与米游社官方公告卡池解析；
- 四游戏体力聚合查询：原神 / 星铁 / 绝区零 / 崩坏3；
- 米游社游戏签到与社区签到、群聊白名单、崩三周期提醒等；
- 角色语音：原神 / 星铁多语言语音列表，以及基于官方 WIKI 配音展示的崩坏3中文语音；
- 锅巴配置适配：常用开关、优先级、提醒群、签到白名单、群名可搜索下拉、卡池立绘来源等；
- 多处字体、罕见字、图片布局和移动端截图显示问题修复。

> 说明：本分支是在原项目基础上的二次维护版本。原作者信息、原 README 与 GPL-2.0 开源协议均会保留。若你基于本分支继续修改或分发，请同样保留来源与协议。

## 快速安装

### GitHub 直连安装

在云崽根目录执行：

```bash
git clone -b v2 https://github.com/YUYUYUYU2147/xhh.git ./plugins/xhh/
cd ./plugins/xhh
pnpm i
```

### 可选：安装 cloudflared（启用「手机可开」的验证码链接）

小花火遇到米游社风控（`retcode 1034`）时会给你一个验证链接。想在**手机/其它设备**上打开，
需要一个公网地址；最省事的办法是装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
用临时隧道。做这一步后不需要改任何配置。

<details>
<summary><b>Linux 安装（点击展开）</b></summary>

```bash
# Debian / Ubuntu
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared

# CentOS / RHEL / Rocky
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "rpm -import /usr/share/keyrings/cloudflare-main.gpg" | sudo tee /etc/yum.repos.d/cloudflare-main.repo

# Alpine
sudo wget -O /usr/share/keyrings/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflare-main.gpg
echo "cloudflare gpgkey file:///usr/share/keyrings/cloudflare-main.gpg" | sudo tee /etc/apk/repositories.d/cloudflared.apk.repository
sudo apk add --no-cache cloudflared

# 任意 Linux：直接下二进制（arm 机器换 cloudflared-linux-arm64）
sudo install -m 755 cloudflared-linux-amd64 /usr/local/bin/cloudflared
```
</details>

<details>
<summary><b>Windows 安装（PowerShell 管理员，点击展开）</b></summary>

```powershell
winget install --id Cloudflare.cloudflared
# 或：choco install cloudflared
# 或手动：https://github.com/cloudflare/cloudflared/releases/latest 下载 cloudflared-windows-amd64.exe，
#    改名 cloudflared.exe 放到任意目录并加入 PATH
```
</details>

验证：`cloudflared --version`。装不上、或你不想要公网隧道，直接跳过即可 —— 不影响其它功能，
只是验证码链接只能在服务器本机浏览器打开。完整说明见下文「手动过码（米游社风控 1034）」。

### 使用 GitHub 加速前缀安装

如果服务器访问 GitHub 慢或超时，可以在仓库地址前加 GitHub 代理/加速前缀。下面以 `<加速前缀>` 作为占位，请替换成你当前可用的加速地址：

```bash
git clone -b v2 <加速前缀>https://github.com/YUYUYUYU2147/xhh.git ./plugins/xhh/
cd ./plugins/xhh
pnpm i
```

示例格式：

```bash
git clone -b v2 https://gh-proxy.com/https://github.com/YUYUYUYU2147/xhh.git ./plugins/xhh/
```

> 加速服务可能会失效或更换域名；如果 clone 失败，请换一个可用前缀，或改用直连。

### 已安装后的换源

如果已经安装过 xhh，可以进入插件目录修改远程仓库地址：

```bash
cd ./plugins/xhh

# 查看当前远程仓库
git remote -v

# 换成 YUYUYUYU2147 维护版 GitHub 源
git remote set-url origin https://github.com/YUYUYUYU2147/xhh.git

# 如果需要使用加速前缀，也可以这样设置
git remote set-url origin <加速前缀>https://github.com/YUYUYUYU2147/xhh.git

# 拉取最新代码
git fetch origin
```

### 切换到 v2 分支

如果本地已经 clone 了仓库，但不在 `v2` 分支，可以执行：

```bash
cd ./plugins/xhh

# 拉取远程分支信息
git fetch origin

# 切换到 v2 分支；如果本地没有 v2，会自动基于 origin/v2 创建
git checkout -B v2 origin/v2

# 更新到远程最新提交
git pull origin v2

# 安装/更新依赖
pnpm i
```

如果你使用原作者仓库，请参考下方“原作者 README（保留）”。

## 命令速查

> 绝大多数命令都支持 `#` 开头；`小花火` / `xhh` 作为可选前缀（如 `#小花火帮助`）。

### 崩坏3

| 命令 | 说明 |
| --- | --- |
| `#崩三体力` / `#崩三便笺` | 崩坏3体力卡片、实时便笺 |
| `#崩三主页` | 角色主页数据 |
| `#崩三深渊` / `#当前深渊` / `#深渊Boss` | 深渊/量子流形当期信息 |
| `#崩三深渊战报` | 超弦空间战报 |
| `#崩三旧深渊` | 原深渊（往期） |
| `#崩三战场` / `#崩三记忆战场` | 战场/超时空挑战记录 |
| `#崩三乐土` / `#崩三往世乐土` | 乐土挑战记录 |
| `#崩三日历` | 崩三日历与活动一览 |
| `#崩三抽卡记录` / `#刷新崩三抽卡记录` | 抽卡记录与本地缓存刷新 |
| `#崩三充值记录` | 充值流水 |
| `#崩三水晶` / `#上月水晶` | 水晶手账；`#删除水晶uid` `#切换水晶uid` |
| `#崩三卡池` / `#崩三xx补给` | 当前/角色历史补给 |
| `#崩三v8.9卡池` / `#崩三8.9上半卡池` | 指定版本补给 |
| `#崩三卡池历史` | 全版本补给记录 |
| `#崩三xx图鉴` | 角色、武器、圣痕、人偶、位面武器等图鉴 |
| `#崩三语音列表` / `#崩三角色名语音` | 崩坏3角色语音（官方 WIKI 配音，中文单语） |
| `#小花火开启崩三提醒` | 开启本群崩三周期提醒 |

### 原神 / 星铁 / 绝区零

| 命令 | 说明 |
| --- | --- |
| `#体力` / `#全体力` / `#四游戏体力` | 四游戏体力聚合（等同 `#小花火体力`） |
| `#原神体力` / `#星铁体力` / `#绝区零体力` | 单游戏体力 |
| `#原神卡池` / `#星铁卡池` / `#绝区零卡池` | 当前卡池 |
| `#卡池时间` | 当前卡池剩余时间 |
| `#原神官方卡池` / `#官方卡池` | 米游社官方公告卡池汇总 |
| `#原神卡池历史` / `#星铁卡池历史` | 历史卡池记录 |
| `#幻想真境剧诗角色` | 剧诗当期可用角色 |
| `#星铁抽卡记录` / `#星铁角色记录` / `#星铁武器记录` | 星铁抽卡统计 |
| `#绝区零母带` / `#绝区零存货` | 绝区零特殊统计 |
| `#原石余额` / `#设置原石余额2000` | 余额估算与校准 |
| `#货币战争` | 星铁货币战争（可选） |
| `#原神xx语音` / `#星铁xx语音` | 角色语音列表，回复图片发数字发送 |

### 通用 / 签到 / 绑定

| 命令 | 说明 |
| --- | --- |
| `#小花火帮助` / `#小花火原神帮助` | 总帮助 / 单游戏帮助 |
| `#小花火更新` / `#小花火更新日志` | 插件更新与日志 |
| `#小花火签到` / `#全部游戏签到` | 米游社游戏签到 |
| `#米游社全部签到` / `#社区签到` | 社区/论坛签到 |
| `#小花火扫码绑定` | 扫码绑定米游社账号 |
| `#删除stoken` / `#刷新ck` / `#解码` | 绑定相关维护 |
| `#设备帮助` / `#绑定设备` | 米游社设备绑定（应对 1034 风控验证码） |
| `#小花火开启设备绑定` | 开启后自动绑定常用设备 |
| `#xx攻略` / `#xx配队` / `#xx一图流` | 攻略图源查询 |
| `#小花火播报群列表` | 米游社视频播报群管理 |
| `#meme` / `#随机表情包` | 表情包 |
| `#原神开启活动到期推送` | 活动到期提醒（支持四游戏 + `#开启全部活动到期推送`） |
| `#小花火塔罗牌` | 塔罗牌（需 `tlp: true`） |
| `#最新视频` | 米游社最新视频播报 |

### 崩坏3语音

- `#崩三语音列表` 或 `#小花火崩三语音列表` 列出全部可查角色；
- `#崩三角色名语音` 出语音列表图，**引用回复该图**发 `1`（或 `1 日语`）发送语音；
- 数据取自崩三官方 WIKI 的配音展示，仅中文单语，音频为 mp3 直链；
- 角色别名见 `system/default/bh3_js_names.yaml`（如「琪亚娜」对应薪炎之律者，「咚」对应咚！炽愿吉星），可自行补充；
- 需 `all_voice: true` 且 `bh3_voice: true`。

> 语音功能依赖 ffmpeg，未安装时无法发送语音但仍能出列表。

## 配置说明

配置目录 `plugins/xhh/config/`，建议优先用锅巴修改。

| 文件 | 作用 |
| --- | --- |
| `config.yaml` | 总开关、优先级、B 站、攻略源、卡池立绘来源等 |
| `sign.yaml` | 游戏/社区自动签到时间、白名单群与白名单成员 |
| `other.yaml` | 米游社视频播报选项与群屏蔽 |
| `bh3_remind.yaml` | 崩三深渊/战场/乐土提醒、四游戏体力推送 |
| `activity_remind.yaml` | 四游戏活动到期提醒 |

`config.yaml` 常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `debug` | `false` | 调试日志（会打印附加小号查询失败等，排查时开，日常关） |
| `img_quality` | `100` | 图片渲染精度（%） |
| `update` | `false` | 凌晨 3:30 强制自动更新（会覆盖本地改动，慎开） |
| `Tl` | `true` | 启用小花火体力组件（关闭则体力指令交给其他插件） |
| `all_voice` / `gs_voice` / `sr_voice` / `bh3_voice` | `true` | 语音总开关与分游戏开关 |
| `tlp` / `tlpcs` | `false` / `3` | 塔罗牌开关与每日次数 |
| `wiki` | `true` | 小花火图鉴优先级（负数越大越优先） |
| `meme` / `meme_reply` | `true` / `false` | 表情包与自动回复 |
| `huobi_num` | `3` | 货币战争参与人数 |
| `bili_ck` | - | B 站 cookie，用于视频/直播解析 |
| `manual_gt_enable` | `true` | 手动过验证码（米游社风控）服务，本插件**唯一**的过码方式 |
| `manual_gt_host` / `manual_gt_port` / `manual_gt_path` | `127.0.0.1` / `3000` / `/xhh-gt` | 手动过码服务的本机监听地址、端口与链接前缀（重启生效） |
| `manual_gt_public_url` | `''` | 浏览器能访问的公网地址；留空则由插件自动拉临时隧道。仓库不内置任何个人域名 |
| `manual_gt_auto_tunnel` | `true` | 无公网地址时是否自动拉 cloudflared 隧道 |
| `manual_gt_timeout` | `120` | 手动验证码链接有效期与等待时间，单位秒 |
| `gacha_art_source` | `official` | 卡池立绘来源（official / custom） |

> 手动过码的完整用法（工作方式、四种部署方式、自测与排错）见下文「手动过码（米游社风控 1034）」。

优先级类配置（`*_priority`）见 `config.yaml` 末尾，默认值见同文件注释。

## 常见问题

### 指令被其他插件抢占

云崽的 `priority` 数字**越小越先执行**（`lib/plugins/handler.js` 按 `a.priority - b.priority` 升序排序）。若指令被别的插件先处理：

1. 调小对应优先级，例如 `tl_priority`（体力）、`voice_priority`（语音）、`help_priority`（帮助）；
2. 或改用带前缀的写法，如 `#小花火体力`、`#小花火德丽莎语音`、`#小花火帮助`；
3. 优先级类配置修改后**需重启**云崽生效。

### 查询报 `param error` / `retcode 1034`

- `retcode -1 param error`：多 UID 聚合查询时，附加小号在 `data/Stoken/<QQ>.yaml` 里存的 `region` 与实际区服不符（例如原神用了 `prod_gf_cn`）。改为正确区服（国服 `cn_gf01` / 星铁 `prod_gf_cn`）或删掉该小号后重新扫码绑定。
- `retcode 1034`：米游社风控验证码。插件只保留手动过码：开启 `manual_gt_enable` 后，签到/查询遇到验证码会给出链接，浏览器完成验证后自动重试；也可让用户发送 `#设备帮助` 绑定常用设备降低风控概率。
- 附加小号查询失败不影响主号，主号卡片照常出图，失败的小号会在末尾以「以下UID获取失败」提示。

### 手动过码（米游社风控 1034）

小花火**只保留手动过码**：米游社返回 `retcode 1034 / 10035` 时，插件会给你一个验证链接，
你在浏览器里过完滑块，插件拿到结果后自动重试被中断的那个请求（签到 / 体力 / 社区签到都走这一条）。

#### 工作方式

```
撞码(1034) → 插件登记一个验证任务 → 给你链接
           → 浏览器打开链接，加载极验官方 gt.js，用米游社下发的 gt/challenge 过滑块
           → 页面把 geetest_validate 回传给插件
           → 插件调用 verifyVerification 清风险 → 自动重试原请求 → 撤回提示消息
```

要点：
- **不依赖任何第三方过码服务**，不外发你的 cookie，验证页由插件自己提供
- 链接有效期 `manual_gt_timeout` 秒（默认 120），超时自动作废
- 同时只会有一条任务在等，重复撞码共用同一个 key
- 链接形如 `<公网地址><manual_gt_path>/<8位随机码>`，例如 `https://xxx.trycloudflare.com/xhh-gt/b1ef510e`
- 验证页默认每 120 秒自动清理一次（每天 4:20 定时），不会堆积

#### 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `manual_gt_enable` | `true` | 总开关，关掉后不再提供验证页 |
| `manual_gt_host` | `127.0.0.1` | 本地监听地址，保持 `127.0.0.1` 即可，不要改成 `0.0.0.0` 对外暴露 |
| `manual_gt_port` | `3000` | 本地监听端口，需与你的反代/隧道端口一致 |
| `manual_gt_path` | `/xhh-gt` | 链接前缀 |
| `manual_gt_public_url` | `''` | 公网访问地址；留空则由插件拉临时隧道自动获取 |
| `manual_gt_auto_tunnel` | `true` | 无公网地址时是否自动拉 cloudflared 隧道 |
| `manual_gt_timeout` | `120` | 链接有效期与等待时间（秒，30~600） |

也可以用环境变量覆盖公网地址（适合容器部署）：
```bash
export XHH_MANUAL_GT_PUBLIC_URL='https://你的域名'
```

#### 四种部署方式

**A. 什么都不配（仅本机浏览器可用）**
所有配置保持默认，链接是 `http://127.0.0.1:<port>/xhh-gt/<码>`。
只在跑云崽的这台机器上用浏览器打开即可；手机、其它人打不开。

**B. 插件自动拉 cloudflared 临时隧道（最省事）**

第 1 步：安装 `cloudflared`（只需一次）

<details>
<summary><b>Linux</b>（云崽一般跑在 Linux 上）</summary>

```bash
# Debian / Ubuntu（会自动配置软件源并安装服务）
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared

# CentOS / RHEL / Rocky / Alma（如需先启用 CodeReady 仓库：sudo dnf config-manager --set-enabled crb）
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "rpm -import /usr/share/keyrings/cloudflare-main.gpg" | sudo tee /etc/yum.repos.d/cloudflare-main.repo

# Alpine
sudo wget -O /usr/share/keyrings/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflare-main.gpg
echo "cloudflare gpgkey file:///usr/share/keyrings/cloudflare-main.gpg" | sudo tee /etc/apk/repositories.d/cloudflared.apk.repository
sudo apk add --no-cache cloudflared

# Arch / Manjaro / 其它：直接下二进制（最通用，任何 Linux 都能用）
#   https://github.com/cloudflare/cloudflared/releases/latest 下载 cloudflared-linux-amd64（或 arm64）
sudo install -m 755 cloudflared-linux-amd64 /usr/local/bin/cloudflared
```

验证：
```bash
cloudflared --version    # 应输出 cloudflared version x.y.z
```
</details>

<details>
<summary><b>Windows</b>（PowerShell，管理员）</summary>

```powershell
winget install --id Cloudflare.cloudflared

# 或用 Chocolatey
choco install cloudflared

# 或手动：到 https://github.com/cloudflare/cloudflared/releases/latest 下载 cloudflared-windows-amd64.exe
# 改名为 cloudflared.exe 放进任意目录，再把该目录加入 PATH，例如：
$env:Path += ";C:\Program Files\cloudflared"
# 永久生效（管理员 PowerShell）：
[Environment]::SetEnvironmentVariable("Path", $env:Path, "Machine")
```

验证（新开一个 PowerShell 窗口）：
```powershell
cloudflared --version
```
</details>

<details>
<summary><b>Docker / 容器里的云崽</b></summary>

在**云崽所在的容器或系统**里装（宿主机装了容器里看不到）。以 Debian/Ubuntu 镜像为例，在 Dockerfile 里加：
```dockerfile
RUN curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list \
 && apt-get update && apt-get install -y cloudflared
```
或者不进容器，改用挂载（把宿主机已装好的二进制挂进去）：
```bash
docker run -v /usr/local/bin/cloudflared:/usr/local/bin/cloudflared:ro ...
```
</details>

第 2 步：确认配置
```yaml
manual_gt_auto_tunnel: true     # 默认就是 true
manual_gt_public_url: ''        # 留空，交给插件自动处理
```

第 3 步：**不用做任何事**。隧道是「真的撞码、要发链接时」才拉，不是启动就拉。

日志会依次出现：
```
[xhh][manual_gt] 使用 cloudflared：/usr/local/bin/cloudflared
[xhh][manual_gt] 已拉起 cloudflared（pid=xxxx，端口 3000）
[xhh][manual_gt] 临时公网地址：https://xxx.trycloudflare.com（重启后地址会变）
```
地址会缓存复用，直到云崽重启。适合个人使用、撞码不频繁的场景。
若日志显示「未找到 cloudflared」，说明插件没在你的 PATH 里看到它：
可以用 `CLOUDFLARED_PATH` 环境变量指定绝对路径，或把二进制放到 `/usr/local/bin/cloudflared`。

**C. 后台常驻隧道（systemd，推荐长期运行 / 无人值守）**
```bash
REPO=/path/to/TRSS-Yunzai                  # 换成你的云崽根目录
sudo cp $REPO/plugins/xhh/tools/manual_gt_tunnel.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/manual_gt_tunnel.sh
sudo cp $REPO/plugins/xhh/tools/xhh-gt-tunnel.service /etc/systemd/system/
# 记得把 service 里 ExecStart 的端口改成你的 manual_gt_port
sudo systemctl daemon-reload
sudo systemctl enable --now xhh-gt-tunnel
```
- 隧道常驻（占用约 24MB 内存），`Restart=always` 掉线自动重连
- 实际地址写入 `<仓库>/plugins/xhh/data/manual_gt_url`（可用 `URL_FILE` 环境变量改路径），插件自动读取
- **不需要把临时域名写进配置**
- 用了这个方案就把 `manual_gt_auto_tunnel` 设成 `false`，避免插件再拉第二条隧道

常用命令：
```bash
systemctl status xhh-gt-tunnel        # 看状态
systemctl restart xhh-gt-tunnel       # 重启（会换新地址）
cat <仓库>/plugins/xhh/data/manual_gt_url
```

**D. 固定地址（最稳定，强烈建议生产用）**
自建 Cloudflare Named Tunnel / frp / Nginx 反代 / VPS，然后把固定域名填进 `manual_gt_public_url`：
```yaml
manual_gt_public_url: 'https://xhh-gt.你的域名'
```
插件会优先用它，且**不会**再自动拉隧道，也没有地址变动问题。

#### 自测

主人可发：
```
#小花火手动验证自测     # 或 #小花火手动验证码测试
```
会造一个假验证码任务并把链接发出来。打开链接点「模拟提交验证」，机器人会收到结果并回复成功，
说明「本地服务 → 页面 → 回传」整条链路是通的（真实验证码只有撞码时才有，自测用的是假数据）。

#### 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 链接打不开（530） | trycloudflare 是临时域名，隧道进程挂了域名就失效。方案 C 用 `systemctl restart xhh-gt-tunnel` 换地址；方案 D 不受影响 |
| 日志「未找到 cloudflared」 | 当前环境没有该二进制（常见于容器/沙箱/精简系统）。装一个，或改用方案 C/D |
| 手机打不开、只有本机能开 | 还没有公网地址。执行方案 B / C / D 任一即可 |
| 容器部署不生效 | `systemctl` 在宿主、云崽在容器，两者不通。`tools/manual_gt_tunnel.sh` 要在**云崽所在环境**里跑，且要能访问到 `manual_gt_host:manual_gt_port` |
| 提示「没有可用公网地址」 | 既没配 `manual_gt_public_url`，也没装 cloudflared，见上文方案 |
| 撞码了但没收到链接 | 检查 `manual_gt_enable` 是否为 true，以及签到群是否在 `bbs_sign_group` 白名单内 |

本机自检（服务是否在监听）：
```bash
curl -s http://127.0.0.1:<manual_gt_port><manual_gt_path>/任意码
# 返回 {"status":1,"message":"验证信息不存在或已失效"} 说明服务正常
```

### 语音列表发出后回复数字没反应

- 需**引用回复**语音列表那张图片；
- 多账号部署下若仍失败，检查 `data/` 与 `temp/yy_pic/` 权限，以及 `voice.js` 的 `fsyy` 是否命中当前 bot；
- 未安装 ffmpeg 时无法发送语音。

### 锅巴里群名显示「群 xxx（名称未知）」

群列表取自 `Bot.gl`（机器人已加载的群信息）。插件启动 30 秒后会把群号+群名写入 `data/GroupName.yaml` 并每 5 分钟刷新。若仍是「名称未知」，说明该 bot 不在这个群，需要先把 bot 拉进群；或在下拉框里手动添加群号。


## 开源与二次分发说明

本项目基于 GNU General Public License v2.0（GPL-2.0）协议开源。

你可以自由使用、学习、修改本项目代码；但如果你对本项目或本分支进行二次修改、打包分发、公开发布或传播修改版，必须：

1. 保留原作者与本分支维护者相关署名和版权声明；
2. 保留 GPL-2.0 开源协议；
3. 公开对应修改版源码；
4. 不得将修改版闭源分发；
5. 不得删除项目来源信息或冒充原创。

如果只是个人本地自用且不分发，GPL-2.0 通常不强制公开修改源码。

---

## 原作者 README（保留）

<img src="resources/help/xhh.gif" alt="小花火" width = "400">

<h2>不懂的，就问Ai吧  ◍⁰ᯅ⁰◍ .ᐟ.ᐟ  </h2>

## cd到云崽的根目录，然后↘↓↙

```
git clone https://gitee.com/this_e/xhh.git ./plugins/xhh/
```

<details>
  <summary>Github</summary>
  
```
git clone https://github.com/thisee/xhh.git ./plugins/xhh/
```

</details>

## 安装依赖

```
pnpm i
```

---

| 命令              | 说明                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| xx语音            | 原神星铁角色四国语音                                                            |
| xx卡池            | 原神星铁历代卡池                                                                |
| 货币战争            | 星铁货币战争战绩                                                                |
| 母带            | 绝区零存货                                                                |
| xx攻略            | 星铁角色攻略                                                                    |
| 塔罗牌            | 占卜                                                                            |
| (自动播报)        | 米家3游戏的最新视频,设置群号后会自动播报                                        |
| (每日npc委托名)   | 查询每日委托是否有成就                                                          |
| (bilibili解析)    | bilibili分享自动解析：卡片，链接(都可)                                          |
| 点赞,投币,拉黑... | 对bilibili视频的一些操作                                                        |
| 扫码绑定          | 扫码绑定米游社stoken                                                            |
| 设备(+设备信息)          | 绑定常用设备                                                           |
| 刷新ck            | 用stoken重新绑定ck                                                              |
| xx图鉴            | 图鉴查询（原神和星铁）                                                          |
| 体力              | 查询树脂、开拓力、电池                                                          |
| 签到              | 米家3游戏每日签到                                                               |
| 小花火设置        | 查看设置,具体文件在xhh/config/config.yaml,大部分功能都是默认关闭的,自己按需开启 |
| 小花火帮助        | 命令列表                                                                        |

<details>
  <summary>QQ群</summary>
  
  [小花火测试群](http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=xu76qObVHhXQDCyMqQlloAWMHlj6r1jo&authKey=XPlThtHq9NXc8i05MKCLrr1swYMERRLoLe645jC0sngAav%2FoIR1dKpE9BbzuXEDI&noverify=0&group_code=975723770)

</details>

# 声明

1. 请勿传播至视频平台，如：bilibili
2. 请尊重Yunzai本体及其他插件作者的努力，勿将Yunzai及其他插件用于以盈利为目的的场景
3. 代码，如有错误的地方，欢迎指正！
4. 我是菜鸟，我什么也不懂(ó﹏ò｡) ,非本插件的问题，我都不知道！

## 星铁攻略图源

|                     星铁攻略图的作者大大                      |
| :-----------------------------------------------------------: |
|  [HoYo青枫](https://m.miyoushe.com/dby/#/collection/1998324)  |
| [紫喵Azunya](https://m.miyoushe.com/dby/#/collection/2145977) |
