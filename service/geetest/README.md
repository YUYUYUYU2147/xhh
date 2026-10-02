# 米游社全自动过码服务

给本插件用的**本机过码服务**：社区签到撞上米游社风控（`retcode 1034 / 10035 / 10041`）
时，它自己把极验滑块解开，用户不用手划。

> ⚠️ 本服务只监听 `127.0.0.1`，不对外暴露。

在群里发一次 `#过码部署` 即可装好（需主人权限），之后撞码会自动调用。

## 它在做什么

米游社用的是极验 v3 私有部署的滑块。整套流程走纯 HTTP，不需要浏览器、不需要桌面环境、
不需要模拟鼠标：

```
① 米游社 createVerification        → gt / challenge
② 极验 get.php                     → c、s（位置混淆参数）与三张图的地址
③ 下载图片 → 还原乱序背景 → 模板匹配出缺口距离
④ 生成 w（轨迹 + 混淆，见 wsolver.py）
⑤ 极验返回 validate
⑥ 米游社 verifyVerification        → 换到 x-rpc-challenge
⑦ 调用方带 x-rpc-challenge 重发被拦的那个请求（签到接口必须这样才放行）
```

## 代码构成

| 部分 | 说明 |
| --- | --- |
| `server.py` | HTTP 服务、米游社接口调用（DS 签名、createVerification / verifyVerification）、编排与统计 |
| `wsolver.py` | 极验 `w` 参数生成：人类化轨迹、两层编码（差分→分通道→`c`/`s` 混淆）、AES + RSA 封装、私有 base64 |
| 第 ②③ 步 | 极验的 `c`/`s` 计算与乱序图像还原由 `bili-ticket-gt-python` 提供（见下） |

### 实现时踩到的两个坑（都很难查）

- **AES 的 IV 是 16 个 ASCII 字符 `'0'`（0x30），不是 16 个零字节。**
  写成 `b'\x00' * 16` 会让服务端解出完全不同的轨迹，验证永远不通过。
- **轨迹编码的位移缩写表必须完整。** 9 组常见位移（`(1,0) (2,0) (1,-1) (1,1) (0,1) (0,-1) (3,0) (2,-1) (2,1)`）
  各对应一个字符，漏掉任何一组，该组合就会被拆成独立的 x/y 值，编码结果和极验预期不一致。

## 依赖

Python 3.9+ 与三个 pip 包：

```
bili-ticket-gt-python==0.2.5    # 极验 c/s 与乱序图像处理（Rust 扩展，需要 glibc >= 2.31）
pycryptodome>=3.19              # w 里的 AES / RSA
httpx>=0.27                     # HTTP 请求
```

> `bili-ticket-gt-python` 的 0.3.x 要求 glibc >= 2.38，Debian 12（glibc 2.36）装不上。
> 0.2.5 是 manylinux_2_31 的，兼容性最好 —— **别升级这个包**。

## 部署

群里发（需主人权限）：

```
#过码部署
```

它会自动建 venv、装依赖（自动挑最快的 pip 源）、用 pm2 托管、然后验活。
装完发 `#过码服务状态` 看累计成功率。本机没有 pm2 时会退回后台运行（重启后需重新部署）。

前置：Linux 需要 `python3` 与 venv 模块（Debian/Ubuntu 装 `python3-venv`）；
Windows 需要 Python，安装时勾选「Add to PATH」和 venv 组件。
`#过码部署` 会自己找可用的解释器（`python3` → `python`，Windows 再加 `py -3`）。

手动装（在 TRSS-Yunzai 根目录执行）：

```bash
cd plugins/xhh/service/geetest
python3 -m venv .venv                              # Windows 用 python -m venv .venv
.venv/bin/python -m pip install -r requirements.txt  # Windows 用 .venv\Scripts\python -m pip
pm2 start .venv/bin/python --name xhh-geetest-solver -- server.py
```

> 如果已经在 `plugins/xhh` 目录里，则第一行改成 `cd service/geetest`。其余内容不变。

> glibc 低于 2.31 装不上 `bili-ticket-gt-python`（它只有 manylinux_2_31 的 wheel）。
> `#过码部署` 会提前检查并说清原因，不会让你对着一堆 pip 报错发懵。
> Windows 没有这个问题。

## 日常查看与管理（pm2）

服务进程名固定是 `xhh-geetest-solver`，下面命令里的 `<名字>` 都替换成它。

```bash
pm2 list                              # 看全部进程列表，带状态/内存/CPU
pm2 status                            # 同上，是 pm2 list 的别名
pm2 describe xhh-geetest-solver       # 看这个进程的详情：脚本路径、启动参数、重启次数、报错
pm2 logs xhh-geetest-solver           # 跟踪日志（实时跟输出）
pm2 logs xhh-geetest-solver --lines 50        # 只看最后 50 行
pm2 logs xhh-geetest-solver --nostream        # 看历史日志然后退出
pm2 monit                             # 实时面板：CPU/内存曲线
pm2 restart xhh-geetest-solver --update-env   # 改完配置重启（--update-env 会带上新的环境变量）
pm2 stop xhh-geetest-solver           # 停止
pm2 delete xhh-geetest-solver         # 停止并从列表移除（再 start 就是全新一个）
```

想只看过码这一个进程：

```bash
pm2 list | grep xhh-geetest-solver
pm2 jlist | python3 -c "import sys,json; [print(p['name'], p['pm2_env']['status']) for p in json.load(sys.stdin) if 'geetest' in p['name']]"
```

不用 pm2 时的排查命令：

```bash
ss -tlnp | grep 2149                  # 看 2149 端口有没有人监听、是谁
curl -s http://127.0.0.1:2149/health  # 探活，能返回 {ok:true,...} 就是好的
tail -n 100 service/geetest/server.log    # nohup 模式下的日志
```

### 「服务在跑但不在本插件进程表里」

`#过码服务状态` 和 `#过码部署` 会检查 pm2 里有没有这个进程。**端口能通但列表里没有**，通常是从旧版本部署下来的、或者手工 nohup 起的进程。这时插件不会去抢占它 —— 端口被占着，新进程也起不来，硬抢只会「看起来部署成功、实际还是旧进程在答」。

先停掉旧的，再重新部署：

```bash
pm2 delete xhh-geetest-solver
```

然后群里发 `#过码部署`。或者直接重启一次机器（过码服务不会自启）。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GT_PORT` | `2149` | 监听端口 |
| `GT_MAX_ROUNDS` | `8` | 单次请求最多重试几轮 |
| `GT_CONCURRENCY` | `4` | 批量请求时的并发数 |
| `GT_CLIENT_TYPE` | `2` | 客户端形态。签到是 App 端接口，过码也必须按 App 端走，不成套米游社不认回执里的 challenge |
| `GT_CHALLENGE_GAME` | `2` | `x-rpc-challenge_game`。**不能省**，缺了重签会报「参数错误」 |
| `GT_APP_VERSION` | `2.40.1` | 过码接口是独立的一套老版本形态，与 bbs-api 常规请求不同 |
| `GT_SALT` | 见 `server.py` | 过码接口的 DS2 盐（salt 4） |
| `GT_DEBUG` | 关 | 打开后打印异常堆栈 |

插件侧的地址在 `config.yaml` 的 `auto_verify_addr`，显式配成空字符串表示不启用自动过码。

## 接口

- `GET /health` → `{ok, stats}`，`stats` 里有累计成功/失败、成功率、平均轮次与耗时
- `POST /solve`（路径其实不校验，`/` 也行）
  - 单个：`{cookie, deviceId?, deviceFp?, clientType?}` → `{data:{result:'ok', round, challenge}}`
  - 批量：`{cookies:[...], deviceId?, deviceFp?}` → `{data:{results:[{ok, round}]}}`（并发跑）

`deviceId` / `deviceFp` 传调用方那一套 —— **过码必须和后续重发是同一个身份**，否则米游社不认。

## 已知限制

- **只处理滑块题。** 极验在更高风险等级下会下发点选/九宫格，遇到时本服务跳过该轮（日志会写「题型是 …」）。实测米游社目前只下发滑块。
- **每个 challenge 只能用一次**，所以一轮失败就得整轮重来，不能只重试后半段。
- 极验偶尔会拒收某条轨迹（日志里表现为 `MissingParam("validate")`），换个 challenge 重来即可。实测 8 次连打 8 次成功，平均 1.9 轮。
- **但有时是成批拒收**：2026-10-01 14:54:58 起连续 8 轮全是 `MissingParam("validate")`、9 秒后放弃，
  两分钟后立刻恢复成首轮必过。这种窗口里让每个版块各自死磕满 8 轮就是纯浪费 ——
  7 个版块各等 9 秒还把风控打上去，所以加了熔断：
  - 连续失败 `GT_BREAKER_FAILS`（默认 2）次 → 熔断 `GT_BREAKER_COOLDOWN`（默认 30）秒
  - 熔断期内请求直接秒回 `503 {"error":"breaker open","retryAfter":N}`，不解滑块，交给调用方走手动兜底
  - 冷却结束进入半开，只放**一个**探针；探针成功则完全恢复，失败则重新熔断
  - 探针在途超过 `GT_BREAKER_PROBE_TIMEOUT`（默认 90）秒视为挂了，重新放一个，避免服务永久卡死
  - `#过码服务状态` / `/health` 会显示 `breakerOpen` 与 `breakerFail`
- 过码成功率依赖本机出口 IP 的风控评分；IP 被重点关注时成功率会明显下降。

## 致谢

- [cchanlan/xhh-TL](https://github.com/cchanlan/xhh-TL)（MIT）—— 纯协议过码的整体思路，
  以及第 ②③ 步所依赖的 `bili-ticket-gt-python` 的用法，均参考自该项目
- [Amorter/biliTicker_gt](https://github.com/Amorter/biliTicker_gt)（**AGPL-3.0**）——
  `bili-ticket-gt-python` 是它发布的包，**本服务在运行时 import 它，但不分发它**
- [Hobr/python-geetest3](https://github.com/Hobr/python-geetest3)（GPL-3.0）——
  `w` 参数生成算法的公开描述来源

> `bili-ticket-gt-python` 是 AGPL-3.0。它是**运行时依赖**，由 `pip` 装在本机上、不进仓库，
> 因此不构成分发。AGPL 要求把网络服务提供给他人使用时须开放源码 —— 本服务只监听
> `127.0.0.1` 自用，请勿作为对外服务部署。

## 声明

**本服务仅供学习交流与技术研究，请勿用于任何商业用途。**

- 使用本服务产生的**一切账号风险由使用者自负**
- 本服务绕过了验证码这一安全机制，**请仅在自己的账号上使用**，
  不要用于批量注册、爬取、代练等违反服务条款的场景
- 请遵守米游社 / 极验的服务条款与当地法律法规；因使用不当造成的后果与作者无关
