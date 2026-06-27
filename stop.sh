#!/usr/bin/env bash
# 停止后端(server.mjs) 与 Open WebUI。可重复运行。
cd "$(dirname "$0")"

stop_port() {
  local port="$1" name="$2"
  local pids
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    echo "已停止 $name (端口 $port, pid: $(echo $pids | tr '\n' ' '))"
  else
    echo "$name (端口 $port) 未在运行"
  fi
}

BACKEND_PORT="${PORT:-8787}"
OWUI_PORT="${OWUI_PORT:-3000}"
stop_port "$BACKEND_PORT" "后端"
stop_port "$OWUI_PORT" "Open WebUI"
# 兜底：Open WebUI 的 uvicorn 子进程（脚本自身 cmdline 不含该串，pkill 安全）
pkill -f 'open-webui serve' 2>/dev/null
echo "完成。"
