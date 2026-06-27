# claude-web 设计文档

日期：2026-06-27

## 目标

本地网页聊天界面，复用本机 `claude` / `codex` CLI 的配置（无需登录），会话独立保存，且 CLI 的 `/resume` / `codex resume` 看不到这些会话。界面风格参考 Open WebUI。

## 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 调用方式 | spawn CLI（`claude -p` / `codex exec`） | Claude 用的是 OAuth 订阅 token（非 API key），直连 API 脆弱；spawn CLI 复用配置并自动处理刷新与计费 |
| 技术栈 | Node.js 单文件后端 + 自包含前端 | 复用跑 CLI 的同一 Node 运行时，免 pip/pyenv；低依赖契合手动脚本偏好 |
| 隔离强度 | 独立 home + 软链凭据 | auth 完全复用且会话彻底隔离，正常 `/resume` 完全看不到 |
| 存储 | 文件式 JSON | Node 20 无内置 sqlite；JSON 零依赖、可直接查看 |
| 功能范围 | Open WebUI 风格 | 第一期：会话 CRUD、双 provider 流式、Markdown/高亮、停止、系统提示词、搜索、导出。第二期：附件上传 |

## 架构

```
浏览器(localhost) --HTTP/SSE--> server.mjs(node:http)
                                    |
                  +-----------------+------------------+
                  v                 v                  v
            会话存储(JSON)     子进程 claude        子进程 codex exec
                              CLAUDE_CONFIG_DIR=   CODEX_HOME=
                              homes/claude-home    homes/codex-home
                              软链 .credentials    软链 auth.json
```

## 鉴权与隔离

- 为每个 provider 建独立 home，软链凭据：`.credentials.json`、`auth.json`、`config.toml`。
- token 刷新经软链写回真实文件，两边同步、无需重登。
- CLI 的 `projects/`、`sessions/` 落在独立 home 内，不进 `~/.claude/projects`、`~/.codex/sessions`。
- 子进程 cwd 固定为 `homes/workdir/`（空目录），纯聊天不触碰用户文件。

## 进程调用

- Claude：`claude -p <消息> --output-format stream-json --verbose --include-partial-messages --permission-mode plan [--model M] [--append-system-prompt S] (--session-id ID | --resume ID)`
- Codex：`codex exec <消息> --json --sandbox read-only --skip-git-repo-check -C <workdir> [-m M]`；续聊 `codex exec resume <thread_id> <消息> …`
- 事件解析：
  - Claude：`system/init` 取 session_id；`stream_event/content_block_delta/text_delta` 为增量；`result` 取最终文本、用量、费用。
  - Codex：`thread.started` 取 thread_id；`item.completed`（`agent_message`）取文本；`turn.completed` 取用量；`error` / `turn.failed` 为错误。

## 后端接口

`GET /`、`/vendor/*` 静态；`GET/POST /api/conversations`；`GET/PATCH/DELETE /api/conversations/:id`；`POST /api/conversations/:id/messages`（SSE 流式）；`POST /api/conversations/:id/stop`；`GET /api/config`。每会话同一时刻只允许一个在跑的子进程。

## 数据结构

```
conversations/<id>.json = {
  id, provider, model, title, systemPrompt,
  cliSessionId,             // claude session-id 或 codex thread_id，用于续聊
  createdAt, updatedAt,
  messages: [{ role, content, ts, usage?, cost?, error?, interrupted? }]
}
```

## 错误处理与安全

- CLI 缺失 / 鉴权过期 / 子进程崩溃：转为 SSE `error` 事件，前端红条提示并持久化。
- 停止：SIGTERM 子进程，落盘已生成部分并标记 `interrupted`。
- 只绑 `127.0.0.1`，无登录；复用真实凭据，不得暴露公网。

## 测试

- `test/smoke.mjs`：用假 CLI 跑通全链路，不联网、不耗额度。
- `test/ui.mjs`：浏览器校验渲染与发送流程。
- 隔离验证：真聊后确认会话只在隔离 home，`~/.claude/projects` 无对应文件。

## 验证结果（2026-06-27）

- 桩测试 22/22 通过；UI 测试 11/11 通过、无 JS 错误。
- 真实 Claude：流式回复、续聊上下文保持、会话隔离均确认通过。
- Codex：受本机第三方中转 provider（anyrouter.top）当前不可用影响，真实联通待该 provider 恢复。
