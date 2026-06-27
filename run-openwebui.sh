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
# RAG 嵌入模型 all-MiniLM-L6-v2 已预下载进 HF 缓存（见 setup-embedding.sh）。
# 用离线模式避免启动时去抓全量 30 个变体文件（会很慢），直接用本地缓存秒起。
# 若以后要换嵌入模型/启用需联网下载的功能：先 unset HF_HUB_OFFLINE 并预下载，再启动。
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"

echo "Open WebUI -> 后端 $BACKEND ，端口 $OWUI_PORT"
exec .owui-venv/bin/open-webui serve --host 127.0.0.1 --port "$OWUI_PORT"
