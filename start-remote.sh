#!/usr/bin/env bash
# 书声 · 固定网址一键启动（Tailscale Funnel）
#   固定地址：https://<节点名>.<tailnet>.ts.net  （重启后不变）
#   用法：bash start-remote.sh
#
# 安全设计：
#   - 服务只监听 127.0.0.1，公网只能经 Tailscale Funnel（从本机 loopback 转发）访问；
#   - 以低权限用户 shusheng 运行（非 root）；
#   - 公网/局域网请求必须携带口令或 ?k= 令牌（见 server.mjs 鉴权）。
set -uo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"        # 默认只监听本机，避免局域网直连暴露
SERVICE_USER="${SERVICE_USER:-shusheng}"
PIDFILE=".run_server.pid"

# 1) 读取访问口令（凭据文件，权限 600）
if [ -f .share_creds ]; then
  # shellcheck disable=SC1091
  set -a; . ./.share_creds; set +a
fi
: "${ACCESS_USER:=shusheng}"
: "${ACCESS_PASSWORD:=}"

# 2) 确保 tailscaled 在跑（WSL2 无 systemd，重启后不会自动拉起）
if ! tailscale status >/dev/null 2>&1; then
  if command -v tailscaled >/dev/null 2>&1; then
    echo "▸ tailscaled 未运行，正在启动 …"
    mkdir -p /var/run/tailscale /var/lib/tailscale
    nohup tailscaled --state=/var/lib/tailscale/tailscaled.state \
      --socket=/var/run/tailscale/tailscaled.sock \
      >> /tmp/opencode/tailscaled.log 2>&1 &
    for i in $(seq 1 20); do
      tailscale status >/dev/null 2>&1 && break
      sleep 1
    done
  fi
fi

# 2.5) 检查 Tailscale 登录状态
if ! tailscale status >/dev/null 2>&1; then
  echo "✗ Tailscale 未登录，请先执行：sudo tailscale up"
  exit 1
fi

DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null)"
[ -n "$DNS" ] || { echo "✗ 未能获取 Tailscale 节点域名"; exit 1; }

# 3) 开启 Funnel（把本机端口暴露到固定 https 网址；重复执行安全）
echo "▸ 开启 Funnel …"
timeout 60 tailscale funnel --bg "$PORT" >/dev/null 2>&1 \
  || echo "  ⚠️ Funnel 开启失败：请到 https://login.tailscale.com/f/funnel 开启 Funnel 功能"

# 3.5) 验证「公网入口」真的在服务。
#      注意：本机 MagicDNS 把域名解析成自己的 100.x 地址，自己连自己永远是通的，
#      所以必须用公网 DNS 的 IP 强制走外部入口来验，否则故障会被掩盖。
#      已知故障：tailscale funnel status 显示 on，但外部访问 TLS 握手 0 字节 / Broken pipe。
verify_funnel() {
  [ -n "${DNS:-}" ] || return 1
  command -v curl >/dev/null 2>&1 || return 0   # 没 curl 就跳过校验，不阻塞启动
  local ips="" ip code
  if command -v dig >/dev/null 2>&1; then
    ips="$(dig @8.8.8.8 "$DNS" +short +time=4 +tries=1 2>/dev/null \
           | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')"
  elif command -v nslookup >/dev/null 2>&1; then
    ips="$(nslookup "$DNS" 8.8.8.8 2>/dev/null | awk '/^Address: /{print $2}' \
           | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')"
  else
    return 0
  fi
  [ -n "$ips" ] || return 1
  for ip in $ips; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
            --resolve "$DNS:443:$ip" "https://$DNS/" 2>/dev/null || true)"
    case "$code" in 200|401|403) return 0 ;; esac
  done
  return 1
}

# 4) 停止旧服务（优先 pidfile，其次按端口占用）
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "${OLD:-}" ] && kill "$OLD" 2>/dev/null || true
fi
OLD2="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
[ -n "${OLD2:-}" ] && kill "$OLD2" 2>/dev/null || true
sleep 1

# 4.5) 选择运行身份：优先低权限用户；不可用时退回当前用户（并告警）
SUID="$(id -u "$SERVICE_USER" 2>/dev/null || true)"
SGID="$(id -g "$SERVICE_USER" 2>/dev/null || true)"
RUN=(node --no-warnings server.mjs)
if [ -n "$SUID" ] && command -v setpriv >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
  RUN=(setpriv --reuid="$SUID" --regid="${SGID:-$SUID}" --clear-groups node --no-warnings server.mjs)
  echo "▸ 以低权限用户 ${SERVICE_USER}（uid=${SUID}）运行"
else
  echo "  ⚠️ 未能降权运行（需 root + setpriv + 用户 ${SERVICE_USER}），将以当前用户启动"
fi

# 4) 启动服务（固定网址 + 访问口令 + 仅监听本机）
echo "▸ 启动服务 …"
SHARE_PROVIDER=tailscale \
HOST="$HOST" \
PORT="$PORT" \
ACCESS_USER="$ACCESS_USER" \
ACCESS_PASSWORD="$ACCESS_PASSWORD" \
nohup "${RUN[@]}" > /tmp/opencode/novelverse.log 2>&1 &
echo $! > "$PIDFILE"
sleep 4

echo
echo "✅ 已启动"
echo "   固定网址：https://$DNS"
echo "   访问账号：${ACCESS_USER} / ${ACCESS_PASSWORD:-（未设置口令）}"
grep -E "外网访问地址|手机访问|仅监听" /tmp/opencode/novelverse.log | tail -3 || true

# 5) 校验公网入口（放在服务起来之后，否则冷启动会误报）
echo "▸ 校验公网入口 …"
if verify_funnel; then
  echo "  ✓ 公网入口可达（外部可扫码访问）"
else
  echo "  ⚠️ 公网入口未响应（本地 funnel status 看起来是 on），尝试重新注册 …"
  timeout 30 tailscale funnel --https=443 off >/dev/null 2>&1 || true
  sleep 2
  timeout 60 tailscale funnel --bg "$PORT" >/dev/null 2>&1 || true
  sleep 15
  if verify_funnel; then
    echo "  ✓ 重新注册后公网入口已恢复"
  else
    echo "  ✗ 公网入口仍不通。处理：pkill -x tailscaled 后重跑本脚本；"
    echo "     或到 https://login.tailscale.com/f/funnel 确认 Funnel 开关"
  fi
fi
