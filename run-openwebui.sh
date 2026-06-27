#!/usr/bin/env bash
# 启动 Open WebUI，并把它的「OpenAI 连接」指向本项目的后端（spawn 真实 claude/codex CLI）。
# 前提：先在另一个终端跑 ./run.sh 启动后端（默认 127.0.0.1:8787）。
set -e
cd "$(dirname "$0")"

# 后端地址（本项目的 OpenAI 兼容接口）
BACKEND="${BACKEND:-http://127.0.0.1:8787/v1}"
OWUI_PORT="${OWUI_PORT:-8080}"

export OPENAI_API_BASE_URL="$BACKEND"
export OPENAI_API_KEY="local"            # 后端不校验，占位即可
export ENABLE_OLLAMA_API=False           # 不连 Ollama
export WEBUI_AUTH=False                   # 无需登录（单用户）
export DATA_DIR="$PWD/.owui-data"         # 数据放项目内，便于隔离/清理
export WEBUI_NAME="claude-web"

echo "Open WebUI -> 后端 $BACKEND ，端口 $OWUI_PORT"
exec .owui-venv/bin/open-webui serve --host 127.0.0.1 --port "$OWUI_PORT"
