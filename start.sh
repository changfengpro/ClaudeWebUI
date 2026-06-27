#!/usr/bin/env bash
# 一键启动：后端(OpenAI 兼容接口, spawn 真实 CLI) + Open WebUI 前端。
# 后端在后台，Open WebUI 在前台；Ctrl-C 退出时一并关掉后端。
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8787}" node server.mjs &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null' EXIT INT TERM

# 等后端起来
for i in $(seq 1 20); do
  curl -sS -o /dev/null "http://127.0.0.1:${PORT:-8787}/v1/models" && break || sleep 0.5
done
echo "后端就绪(127.0.0.1:${PORT:-8787})，启动 Open WebUI…"
BACKEND="http://127.0.0.1:${PORT:-8787}/v1" ./run-openwebui.sh
