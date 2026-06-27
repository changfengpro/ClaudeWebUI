# claude-web

一个本地网页聊天界面，直接复用本机 `claude` 与 `codex` CLI 的配置，无需登录；会话独立保存，CLI 的 `/resume`、`codex resume` 看不到这里产生的会话。

界面风格接近 Open WebUI：左侧会话列表，主区流式对话，Markdown 与代码高亮渲染。

## 满足的三个需求

1. **复用本地配置、无需登录**：通过软链复用 `~/.claude/.credentials.json` 与 `~/.codex/auth.json`，不重新登录，token 刷新会写回原文件。
2. **会话独立**：每个网页会话是独立的一条记录，存在本项目自己的 JSON 库里，互不干扰。
3. **CLI `/resume` 看不到**：网页会话对应的 CLI 会话文件落在本项目的隔离目录，不进 `~/.claude/projects`、`~/.codex/sessions`，因此正常的 `/resume`、`codex resume` 列不到。

## 工作原理

- 启动时为每个 provider 建独立 home 目录并软链凭据：
  - `homes/claude-home/.credentials.json` → `~/.claude/.credentials.json`
  - `homes/codex-home/auth.json` → `~/.codex/auth.json`、`config.toml` → `~/.codex/config.toml`
- 每轮对话 spawn 一个子进程，环境变量隔离会话存储：
  - Claude：`CLAUDE_CONFIG_DIR=homes/claude-home`，命令 `claude -p <消息> --output-format stream-json --include-partial-messages …`，首轮 `--session-id`、续聊 `--resume`。
  - Codex：`CODEX_HOME=homes/codex-home`，命令 `codex exec <消息> --json …`，续聊 `codex exec resume <thread_id>`。
- 子进程的流式 JSON 输出逐行解析，通过 SSE 推给浏览器实时显示。
- 会话内容另存一份在 `data/conversations/<id>.json`（与 CLI 的会话文件分离），供网页列表、搜索、导出使用。

## 快速开始

需要 Node.js（已用 v20 验证）。

```bash
cd /home/rmer/project/claude-web
node server.mjs      # 或 ./run.sh
```

打开 http://127.0.0.1:8787 。新建对话时可选 provider（claude / codex）、模型与可选的系统提示词，发送即开始。

## 配置 `config.json`

| 键 | 说明 |
|---|---|
| `host` / `port` | 监听地址与端口，默认 `127.0.0.1:8787` |
| `claudeBin` / `codexBin` | CLI 可执行名或路径 |
| `claudePermissionMode` | Claude 权限模式，默认 `plan`（纯聊天、不改文件） |
| `codexSandbox` | Codex 沙箱，默认 `read-only` |
| `claudeModels` / `codexModels` | UI 模型下拉备选 |
| `defaultClaudeModel` / `defaultCodexModel` | 默认模型，codex 留空表示用 `~/.codex/config.toml` 里的默认 |

环境变量可覆盖：`PORT`、`HOST`、`CLAUDE_WEB_CLAUDE_BIN`、`CLAUDE_WEB_CODEX_BIN`。

## 安全提示

- 服务只绑定 `127.0.0.1`，无登录鉴权（按需求设计）。
- 它直接复用你的真实凭据，**不要把端口暴露到公网或反代出去**。

## 当前状态

- Claude 端已完整验证：流式回复、续聊上下文、会话隔离均正常。
- Codex 端代码按真实事件结构实现，但本机 `~/.codex/config.toml` 用的是第三方中转 provider（`anyrouter.top`），当前在 CLI 里直接 `codex exec` 也会报 `stream disconnected … UTF8 error`（relay 侧返回非法流）。等该 provider 在 CLI 里恢复，网页端即可用——本工具只是复用同一套配置。

## 目录结构

```
server.mjs            后端（单文件，无框架）
public/index.html     前端（自包含，内联 CSS/JS）
public/vendor/        marked、highlight.js、DOMPurify 本地副本
config.json           配置
run.sh                启动脚本
data/conversations/   会话 JSON（gitignore）
homes/                隔离 home 与凭据软链（gitignore，不入库）
test/                 测试
docs/design.md        设计文档
```

## 测试

```bash
node test/smoke.mjs   # 桩测试：创建→流式→落库→续聊→停止→删除，不联网、不耗额度
node test/ui.mjs      # 浏览器 UI 测试，需先 npm i playwright-core（用缓存的 chromium）
```

## 已知限制（第二期）

- 附件（文件 / 图片）上传尚未实现：codex 图片可走 `-i`，claude 端为文本内联，待补。
- 切换 provider / 模型仅在会话发出首条消息前可改；之后固定（CLI 会话与 provider 绑定）。
