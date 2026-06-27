# claude-web

一个本地网页聊天界面，直接复用本机 `claude` 与 `codex` CLI 的配置，无需登录；会话独立保存，CLI 的 `/resume`、`codex resume` 看不到这里产生的会话。

界面风格接近 Open WebUI：左侧会话列表（按日期分组），主区流式对话，Markdown 与代码高亮渲染，明暗主题切换，token / 费用显示。采用 Geist 字体与冷色调暗色主题，全部资源本地化、离线可用。

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

## 请求指纹与 claude-cli 一致

claude-web **自身不发任何 API 请求**。每一个到 `api.anthropic.com` 的请求都是被 spawn 的真实 `claude` 二进制发出的，因此云端看到的请求与你直接用 claude CLI 完全一致——不是模仿，是同一个进程。

已用本地 MITM 代理实测对比"原生 `claude -p`"与"claude-web 的实际调用"发往 `/v1/messages` 的请求头，17 项指纹头逐字一致、头名集合相同、OAuth token 相同：

- `user-agent: claude-cli/2.1.195 (external, sdk-cli)`
- `anthropic-beta:` 完整 beta 串一致（`claude-code-…`、`oauth-2025-04-20` 等）
- `x-app: cli`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`
- `x-stainless-*`：arch / lang / os / package-version / runtime / runtime-version / timeout 全一致
  - 其中 `x-stainless-runtime-version` 是 CLI 自带打包的 node 版本（非系统 node），进一步说明指纹完全由该二进制决定。

复现：`node test/mitm-proxy.mjs`（需先用 openssl 生成 `ca.crt`/`leaf.{crt,key}`，再以 `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` 跑两次 claude 对比，步骤见脚本头注释）。

两点说明：
- UA 里的 `sdk-cli` 表示无头（headless）模式，等同于任何人执行 `claude -p` 或用 Claude Agent SDK 时的取值，仍是第一方 claude-cli；交互式 TUI 取值为 `cli`。
- 请求体同样带 Claude Code 自己的系统提示词与工具定义（同一 agent）。唯一有意的差异是默认 `--permission-mode plan`（纯聊天、不改文件）；若想让请求体更接近默认会话，把 `config.json` 的 `claudePermissionMode` 改为 `default`。

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
public/vendor/        marked、highlight.js、DOMPurify、Geist 字体 本地副本
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
