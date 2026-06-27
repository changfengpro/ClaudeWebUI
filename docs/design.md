# ClaudeWebUI 设计文档

日期：2026-06-27

## 目标

把本机 `claude` / `codex` CLI 包成一个 **OpenAI 兼容接口** 的本地后端，供 Open WebUI（或任何 OpenAI 协议客户端）作为模型提供方使用：复用本机 CLI 配置（无需登录），会话独立，且 CLI 的 `/resume` / `codex resume` 看不到这些会话。前端直接用 Open WebUI，不改其代码。

> 说明：早期版本曾自带一个简易网页 UI（`/` 静态页 + `/api/conversations` 系列接口 + 文件式 JSON 会话库），后已整体移除，仅保留 OpenAI 兼容接口。本文档描述移除后的当前设计。

## 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 调用方式 | spawn CLI（`claude -p` / `codex exec`） | Claude 用的是 OAuth 订阅 token（非 API key），直连 API 脆弱；spawn CLI 复用配置并自动处理刷新与计费，且发往云端的请求与真实 CLI 逐字一致 |
| 技术栈 | Node.js 单文件后端 | 复用跑 CLI 的同一 Node 运行时，免 pip/pyenv；低依赖契合手动脚本偏好 |
| 隔离强度 | 独立 home + 软链凭据 | auth 完全复用且会话彻底隔离，正常 `/resume` 完全看不到 |
| 前端 | Open WebUI（不改代码） | 直接获得多会话、RAG、追问建议、标题生成、语音等完整功能，本后端只需冒充一个 OpenAI 连接 |
| 会话状态 | 仅内存映射，不落会话库 | OpenAI 协议无状态、客户端每次发全量历史；会话内容由 Open WebUI 自己保存，后端只需把 chat 映射到一条 CLI 会话 |

## 架构

```
Open WebUI(:3000) --OpenAI /v1--> server.mjs(node:http, :8787)
                                       |
                       +---------------+----------------+
                       v                                v
                 子进程 claude                    子进程 codex exec
                 CLAUDE_CONFIG_DIR=               CODEX_HOME=
                 homes/claude-home                homes/codex-home
                 软链 .credentials                软链 auth.json
```

## 鉴权与隔离

- 为每个 provider 建独立 home，软链凭据：`.credentials.json`、`auth.json`、`config.toml`。
- token 刷新经软链写回真实文件，两边同步、无需重登。
- CLI 的 `projects/`、`sessions/` 落在独立 home 内，不进 `~/.claude/projects`、`~/.codex/sessions`。
- 子进程 cwd 固定为 `homes/workdir/`（空目录），纯聊天不触碰用户文件。

## 进程调用

- Claude：`claude -p <消息> --output-format stream-json --verbose --include-partial-messages --permission-mode plan [--model M] [--append-system-prompt S] (--session-id ID | --resume ID)`
  - 带图片时改用 `--input-format stream-json`，经 stdin 发一条含 `text` + `image`(base64) 块的 user 消息（与交互式发图的内部格式一致），不再用位置参数传文本。
- Codex：`codex exec <消息> --json --sandbox read-only --skip-git-repo-check -C <workdir> [-m M] [-i <图片文件>...]`；续聊 `codex exec resume <thread_id> <消息> …`
- 事件解析：
  - Claude：`system/init` 取 session_id；`stream_event/content_block_delta/text_delta` 为增量；`result` 取最终文本、用量、费用。
  - Codex：`thread.started` 取 thread_id；`item.completed`（`agent_message`）取文本；`turn.completed` 取用量；`error` / `turn.failed` 为错误。

## 后端接口（OpenAI 兼容）

- `GET /v1/models`：暴露 `config.json` 的 `models` 映射（id → provider+model），如 `claude-sonnet`、`codex`。
- `POST /v1/chat/completions`：流式（`chat.completion.chunk` + `[DONE]`）/非流式均支持。按 model id 解析 provider+model，调用 `runClaude`/`runCodex`。
- 其余路径一律 404。每会话同一时刻只允许一个在跑的子进程（`running` Map，键为会话键）。

## 多轮与会话映射

OpenAI 协议无状态、客户端每次发全量历史。后端以「客户端 `chat_id` 或首条 user 消息哈希 + 模型」为会话键，映射一条 CLI 会话（`oaiSessions` 内存 Map：会话键 → `{ cliSessionId, count }`）：

- 历史长度刚好比上次多一条（线性续聊）：只把最新一条 user 消息经 `--resume` / `codex exec resume` 发出，使发往云端的多轮请求结构与真实交互式 CLI 一致。
- 全新会话首轮：直接发首条消息，记录新建的 session-id / thread_id。
- 历史与会话不匹配（编辑 / 重新生成 / 进程重启后接管）：回退为「把全量历史渲染成一段文本重起一段」。

图片：从最新一条 user 消息的 `image_url`（`data:` base64）取出，按上面的 CLI 原生方式转交；codex 的图片先落临时文件 `data/uploads/`，进程结束即清理。

## 错误处理与安全

- CLI 缺失 / 鉴权过期 / 子进程崩溃：错误并入回复内容（`⚠ …`）或流末提示。
- 客户端断开连接：SIGTERM 对应子进程。
- 只绑 `127.0.0.1`，无登录；复用真实凭据，不得暴露公网。

## 测试

- `test/openai-smoke.mjs`：用假 CLI（`test/fake-claude.mjs` / `fake-codex.mjs`）跑通 `/v1/models`、流式/非流式、续聊走 resume、provider 路由、未知模型 400，不联网、不耗额度。
- `test/mitm-proxy.mjs`：指纹验证，对比原生 `claude` 与本服务发往 `/v1/messages` 的请求头逐字一致。
- 隔离验证：真聊后确认会话只在隔离 home，`~/.claude/projects` 无对应文件。

## Open WebUI 前端

不改其代码，仅用环境变量把它的 OpenAI 连接指向本后端（`run-openwebui.sh`），并设 `WEBUI_AUTH=False`（无需登录）、`ENABLE_OLLAMA_API=False`、`WEBUI_NAME=ClaudeWebUI`。其 RAG 嵌入模型 all-MiniLM-L6-v2 预下载进 HF 缓存后以 `HF_HUB_OFFLINE=1` 秒起（`setup-embedding.sh`）。本机用 pyenv 3.11.15 建独立 venv，CPU 版 torch（聊天推理在云端、不经 torch，GPU 无收益）。

## 验证结果（2026-06-27）

- `openai-smoke.mjs` 11/11 通过。
- 指纹：MITM 实测原生 `claude -p` 与本服务发往 `/v1/messages` 的 17 项请求头逐字一致。
- 真实 Claude：流式回复、续聊上下文保持、图片识别、会话隔离均确认通过。
- Codex：受本机第三方中转 provider（anyrouter.top）当前不可用影响，真实联通待该 provider 恢复。
