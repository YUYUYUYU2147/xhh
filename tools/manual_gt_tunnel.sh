#!/bin/bash
# 小花火手动过码 —— cloudflared 快速隧道（可选的公网访问方案）
#
# 用途：米游社风控（retcode 1034）时，小花火会给你一个 http://127.0.0.1:端口/路径/随机码
#       的验证链接，本机浏览器能开，但你在手机上/别人设备上打不开。
#       这个脚本用 cloudflared 快速隧道把本地端口映射成一个临时公网地址。
#
# 前提：已安装 cloudflared
#   Debian/Ubuntu: curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list && sudo apt update && sudo apt install cloudflared
#   或直接下载二进制：https://github.com/cloudflare/cloudflared/releases
#
# 用法：
#   ./manual_gt_tunnel.sh 8080            # 前台运行，端口与 config.yaml 的 manual_gt_port 一致
#   URL_FILE=/tmp/xhh_url ./manual_gt_tunnel.sh 8080
#
# 默认把地址写到 plugins/xhh/data/manual_gt_url，小花火会自动读取；
#
# 实际公网地址会写入 URL_FILE（默认 plugins/xhh/data/manual_gt_url），小花火会自动读取，
# 所以你不需要把临时域名写进 config.yaml。
#
# 重要：快速隧道地址每次重启都会变。要固定地址请自建 Cloudflare Named Tunnel / frp / 反代，
#       然后把固定域名填到 config.yaml 的 manual_gt_public_url。

set -euo pipefail

PORT="${1:-8080}"
# 端口化默认路径：优先放插件自己的 data 目录（随仓库、跨用户通用）
DEFAULT_URL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/manual_gt_url"
URL_FILE="${URL_FILE:-$DEFAULT_URL_FILE}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "未找到 cloudflared，请先安装：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
}

if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:${PORT}"; then
  echo "提示：本地 ${PORT} 端口目前没有服务在监听，隧道建立后也可能 502。" >&2
  echo "请确认 config.yaml 里 manual_gt_enable=true 且端口与本脚本参数一致。" >&2
fi

mkdir -p "$(dirname "$URL_FILE")"
: > "$URL_FILE"

echo "[xhh-gt] 正在为 http://127.0.0.1:${PORT} 建立临时隧道，地址将写入 ${URL_FILE}"

exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "$line"
  url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)
  if [ -n "$url" ]; then
    echo "$url" > "$URL_FILE"
    echo "[xhh-gt] 公网地址：$url"
  fi
done
