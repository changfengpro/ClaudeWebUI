#!/usr/bin/env bash
# 启动 claude-web。会自动建立隔离 home 与凭据软链。
set -e
cd "$(dirname "$0")"
exec node server.mjs
