# ClaudeWebUI

一个本地后端，把 `claude` / `codex` CLI 包成 **OpenAI 兼容接口**：任何 OpenAI 协议的客户端（Open WebUI、Cursor、curl…）都能用，在模型下拉里选 claude 或 codex，后端内部 spawn 真实 CLI——云端看到的请求就是 claude-cli / codex-cli 本尊。会话独立、无需登录，CLI 的 `/resume`、`codex resume` 看不到这里产生的会话。

两种前端任选：

- **Open WebUI（推荐）**：完整保留 Open WebUI 的全部功能，只把它的「OpenAI 连接」指向本后端。见下方「用 Open WebUI 作为前端」。
- **内置简易 UI**：本项目自带的轻量网页(`/`)，左侧会话列表、流式、Markdown/高亮、明暗主题，零额外依赖、离线可用。

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

ClaudeWebUI **自身不发任何 API 请求**。每一个到 `api.anthropic.com` 的请求都是被 spawn 的真实 `claude` 二进制发出的，因此云端看到的请求与你直接用 claude CLI 完全一致——不是模仿，是同一个进程。

已用本地 MITM 代理实测对比"原生 `claude -p`"与"ClaudeWebUI 的实际调用"发往 `/v1/messages` 的请求头，17 项指纹头逐字一致、头名集合相同、OAuth token 相同：

- `user-agent: claude-cli/2.1.195 (external, sdk-cli)`
- `anthropic-beta:` 完整 beta 串一致（`claude-code-…`、`oauth-2025-04-20` 等）
- `x-app: cli`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`
- `x-stainless-*`：arch / lang / os / package-version / runtime / runtime-version / timeout 全一致
  - 其中 `x-stainless-runtime-version` 是 CLI 自带打包的 node 版本（非系统 node），进一步说明指纹完全由该二进制决定。

复现：`node test/mitm-proxy.mjs`（需先用 openssl 生成 `ca.crt`/`leaf.{crt,key}`，再以 `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` 跑两次 claude 对比，步骤见脚本头注释）。

两点说明：
- UA 里的 `sdk-cli` 表示无头（headless）模式，等同于任何人执行 `claude -p` 或用 Claude Agent SDK 时的取值，仍是第一方 claude-cli；交互式 TUI 取值为 `cli`。
- 请求体同样带 Claude Code 自己的系统提示词与工具定义（同一 agent）。唯一有意的差异是默认 `--permission-mode plan`（纯聊天、不改文件）；若想让请求体更接近默认会话，把 `config.json` 的 `claudePermissionMode` 改为 `default`。

## 用 Open WebUI 作为前端（推荐）

思路：Open WebUI 本身**一行不改**，只把它的「OpenAI 连接」指向本后端的 `/v1`。在 Open WebUI 的模型下拉里选 `claude-sonnet` / `claude-opus` / `claude-haiku` / `codex` 等，就等于选 provider + 模型；它的所有功能（多会话、知识库/RAG、追问建议、标题生成、语音等）照常工作。

一次性准备（本机无 docker，用 pyenv 装独立 Python，不动全局 3.8）：

```bash
pyenv install 3.11.15
cd ~/project/ClaudeWebUI
~/.pyenv/versions/3.11.15/bin/python -m venv .owui-venv
.owui-venv/bin/pip install -U pip
# CPU 版 torch（仅 RAG 嵌入用，CPU 足够；GPU 版对聊天无提升）
.owui-venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.owui-venv/bin/pip install open-webui
./setup-embedding.sh        # 预下载 RAG 嵌入模型(约 90MB，走 hf-mirror 镜像)
```

启动（一条命令同时拉起后端 + Open WebUI）：

```bash
./start.sh
# 打开 http://127.0.0.1:3000 ，模型下拉选 claude-sonnet 即可对话
```

也可分开跑：终端 1 `./run.sh`（后端，8787），终端 2 `./run-openwebui.sh`（Open WebUI，3000）。

**停止**：前台运行的按 `Ctrl-C`；后台运行的执行 `./stop.sh`（按端口停掉后端与 Open WebUI）。

要点：
- `run-openwebui.sh` 已设 `WEBUI_AUTH=False`（无需登录）、`ENABLE_OLLAMA_API=False`、把 OpenAI 连接指向 `127.0.0.1:8787/v1`、`HF_HUB_OFFLINE=1`（嵌入模型已预缓存，秒起）。
- Open WebUI 的「追问建议」「标题自动生成」会额外调用模型（即额外 spawn 几次 CLI）。不想要可在 Open WebUI 设置里关掉，省额度。
- torch 用 CPU 版即可：聊天推理在云端、不经过 torch；GPU 仅对重度本地 RAG/本地语音转写有意义。

## 快速开始（内置简易 UI）

需要 Node.js（已用 v20 验证）。

```bash
cd /home/rmer/project/ClaudeWebUI
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
