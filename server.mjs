// ClaudeWebUI —— 本地复用 claude / codex CLI 配置的网页聊天服务
// 单文件后端，无第三方框架。只监听 127.0.0.1。
//
// 设计要点见 docs/design.md：
//  - 复用本地凭据：为每个 provider 建独立 home 目录，软链 .credentials.json / auth.json
//  - 会话隔离：CLI 的 projects/sessions 落在独立 home 里，正常的 /resume、codex resume 看不到
//  - 流式：spawn claude / codex 子进程的 stream-json 输出，逐行解析后用 SSE 推给浏览器

import http from 'node:http';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// ---------- 配置 ----------
const defaultConfig = {
  host: '127.0.0.1',
  port: 8787,
  claudeBin: 'claude',
  codexBin: 'codex',
  // 纯聊天默认不让模型动文件/执行命令：claude 用 plan 模式，codex 用 read-only 沙箱
  claudePermissionMode: 'plan',
  codexSandbox: 'read-only',
  defaultProvider: 'claude',
  claudeModels: ['sonnet', 'opus', 'haiku'],
  defaultClaudeModel: 'sonnet',
  // codex 模型留空表示用 ~/.codex/config.toml 里的默认；下面只是 UI 备选
  codexModels: ['', 'gpt-5.5', 'gpt-5-codex', 'o3'],
  defaultCodexModel: '',
  // OpenAI 兼容接口暴露的模型（供 Open WebUI 的模型下拉选择 provider+model）
  models: [
    { id: 'claude-sonnet', provider: 'claude', model: 'sonnet' },
    { id: 'claude-opus', provider: 'claude', model: 'opus' },
    { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
    { id: 'codex', provider: 'codex', model: '' },
    { id: 'codex-gpt-5.5', provider: 'codex', model: 'gpt-5.5' },
  ],
};
function loadConfig() {
  let fileConfig = {};
  const p = path.join(ROOT, 'config.json');
  if (existsSync(p)) {
    try { fileConfig = JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { console.error('config.json 解析失败，使用默认值：', e.message); }
  }
  // 环境变量覆盖（主要给测试用）
  const env = {};
  if (process.env.PORT) env.port = Number(process.env.PORT);
  if (process.env.HOST) env.host = process.env.HOST;
  if (process.env.CLAUDE_WEB_CLAUDE_BIN) env.claudeBin = process.env.CLAUDE_WEB_CLAUDE_BIN;
  if (process.env.CLAUDE_WEB_CODEX_BIN) env.codexBin = process.env.CLAUDE_WEB_CODEX_BIN;
  return { ...defaultConfig, ...fileConfig, ...env };
}
const CONFIG = loadConfig();

// ---------- 路径 ----------
const DIRS = {
  data: path.join(ROOT, 'data'),
  conversations: path.join(ROOT, 'data', 'conversations'),
  uploads: path.join(ROOT, 'data', 'uploads'),
  homes: path.join(ROOT, 'homes'),
  claudeHome: path.join(ROOT, 'homes', 'claude-home'),
  codexHome: path.join(ROOT, 'homes', 'codex-home'),
  workdir: path.join(ROOT, 'homes', 'workdir'),
  public: path.join(ROOT, 'public'),
};

// ---------- 启动引导：建目录 + 软链凭据（幂等）----------
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

async function ensureSymlink(target, linkPath) {
  // 让 linkPath 指向 target；已存在且指向正确则跳过，否则重建
  if (!existsSync(target)) {
    console.warn(`[warn] 软链源不存在：${target}（对应功能不可用）`);
    return false;
  }
  try {
    const cur = await fs.readlink(linkPath).catch(() => null);
    if (cur === target) return true;
    await fs.rm(linkPath, { force: true });
  } catch { /* ignore */ }
  await fs.symlink(target, linkPath);
  return true;
}

async function bootstrap() {
  for (const d of [DIRS.conversations, DIRS.uploads, DIRS.claudeHome, DIRS.codexHome, DIRS.workdir]) {
    await ensureDir(d);
  }
  // Claude：软链凭据与 settings，写最小 .claude.json 避免首次引导
  const claudeOk = await ensureSymlink(path.join(HOME, '.claude', '.credentials.json'),
    path.join(DIRS.claudeHome, '.credentials.json'));
  await ensureSymlink(path.join(HOME, '.claude', 'settings.json'),
    path.join(DIRS.claudeHome, 'settings.json'));
  const dotClaude = path.join(DIRS.claudeHome, '.claude.json');
  if (!existsSync(dotClaude)) {
    await fs.writeFile(dotClaude, JSON.stringify({ hasCompletedOnboarding: true }) + '\n');
  }
  // Codex：软链 auth 与 config
  const codexOk = await ensureSymlink(path.join(HOME, '.codex', 'auth.json'),
    path.join(DIRS.codexHome, 'auth.json'));
  await ensureSymlink(path.join(HOME, '.codex', 'config.toml'),
    path.join(DIRS.codexHome, 'config.toml'));
  return { claudeOk, codexOk };
}

// ---------- 会话存储（每个会话一个 JSON 文件）----------
function convPath(id) { return path.join(DIRS.conversations, `${id}.json`); }

function nowIso() { return new Date().toISOString(); }

async function listConversations() {
  const files = await fs.readdir(DIRS.conversations).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(DIRS.conversations, f), 'utf8'));
      out.push({
        id: c.id, provider: c.provider, model: c.model, title: c.title,
        createdAt: c.createdAt, updatedAt: c.updatedAt,
        messageCount: (c.messages || []).length,
        lastText: (c.messages || []).slice(-1)[0]?.content?.slice(0, 120) || '',
      });
    } catch { /* 跳过坏文件 */ }
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

async function getConversation(id) {
  try { return JSON.parse(await fs.readFile(convPath(id), 'utf8')); }
  catch { return null; }
}

async function saveConversation(c) {
  c.updatedAt = nowIso();
  const tmp = convPath(c.id) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, convPath(c.id)); // 原子写
}

async function createConversation({ provider, model, title, systemPrompt }) {
  const id = randomUUID();
  const c = {
    id,
    provider: provider === 'codex' ? 'codex' : 'claude',
    model: model ?? (provider === 'codex' ? CONFIG.defaultCodexModel : CONFIG.defaultClaudeModel),
    title: title || '新对话',
    systemPrompt: systemPrompt || '',
    cliSessionId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [],
  };
  await saveConversation(c);
  return c;
}

async function deleteConversation(id) {
  await fs.rm(convPath(id), { force: true });
}

// ---------- 子进程：流式调用 CLI ----------
// 每个会话同一时刻只允许一个在跑的子进程
const running = new Map(); // id -> child process

function splitLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf); });
}

// 运行 claude，返回 {text, sessionId, usage, cost, error, interrupted}
function runClaude(conv, userText, { onDelta, images = [] }) {
  return new Promise((resolve) => {
    let sessionId = conv.cliSessionId;
    // 带图片时改用 stream-json 输入：经 stdin 发一条含 image 块的 user 消息，
    // 这与 Claude Code 交互式发图的内部格式一致，发往云端的请求体不变。
    const useStdin = images.length > 0;
    const args = ['-p'];
    if (!useStdin) args.push(userText);
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', CONFIG.claudePermissionMode);
    if (useStdin) args.push('--input-format', 'stream-json');
    if (conv.model) args.push('--model', conv.model);
    if (conv.systemPrompt) args.push('--append-system-prompt', conv.systemPrompt);
    if (sessionId) args.push('--resume', sessionId);
    else { sessionId = randomUUID(); args.push('--session-id', sessionId); }

    const child = spawn(CONFIG.claudeBin, args, {
      cwd: DIRS.workdir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: DIRS.claudeHome },
      stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    running.set(conv.id, child);

    if (useStdin) {
      const content = [];
      if (userText) content.push({ type: 'text', text: userText });
      for (const img of images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      child.stdin.end();
    }

    let acc = '', resultText = null, usage = null, cost = null, errMsg = null;
    let stderr = '';

    splitLines(child.stdout, (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'system' && o.subtype === 'init') {
        if (o.session_id) sessionId = o.session_id;
      } else if (o.type === 'stream_event') {
        const ev = o.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          acc += ev.delta.text;
          onDelta(ev.delta.text);
        }
      } else if (o.type === 'result') {
        if (typeof o.result === 'string') resultText = o.result;
        usage = o.usage || null;
        cost = o.total_cost_usd ?? null;
        if (o.is_error || o.subtype === 'error_during_execution') errMsg = o.result || '执行出错';
        if (o.session_id) sessionId = o.session_id;
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      running.delete(conv.id);
      resolve({ text: acc, sessionId, error: `无法启动 claude：${e.message}` });
    });
    child.on('close', (code, signal) => {
      running.delete(conv.id);
      const interrupted = signal === 'SIGTERM' || signal === 'SIGKILL';
      const text = (resultText ?? acc) || '';
      let error = errMsg;
      if (!text && !interrupted && code !== 0) {
        error = stderr.trim().split('\n').slice(-3).join('\n') || `claude 退出码 ${code}`;
      }
      resolve({ text, sessionId, usage, cost, error, interrupted });
    });
  });
}

// 运行 codex exec，返回同样结构。会话续聊用 codex exec resume <thread_id>
function runCodex(conv, userText, { onDelta, images = [] }) {
  return new Promise((resolve) => {
    let threadId = conv.cliSessionId;
    // codex 原生支持图片：落临时文件后用 -i 附加，结束时清理。
    const imgPaths = [];
    for (const img of images) {
      const fp = path.join(DIRS.uploads, `oai-${randomUUID()}${mediaExt(img.media_type)}`);
      try { writeFileSync(fp, Buffer.from(img.data, 'base64')); imgPaths.push(fp); } catch { /* ignore */ }
    }
    const imgArgs = imgPaths.flatMap((fp) => ['-i', fp]);
    const cleanupImages = () => { for (const fp of imgPaths) fs.unlink(fp).catch(() => {}); };
    let args;
    if (threadId) {
      args = ['exec', 'resume', threadId, userText, '--json', ...imgArgs,
        '--sandbox', CONFIG.codexSandbox, '--skip-git-repo-check', '-C', DIRS.workdir];
    } else {
      args = ['exec', userText, '--json', ...imgArgs,
        '--sandbox', CONFIG.codexSandbox, '--skip-git-repo-check', '-C', DIRS.workdir];
      if (conv.model) args.push('-m', conv.model);
    }

    const child = spawn(CONFIG.codexBin, args, {
      cwd: DIRS.workdir,
      env: { ...process.env, CODEX_HOME: DIRS.codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.set(conv.id, child);

    let acc = '', lastMsg = '', usage = null, errMsg = null, stderr = '';

    splitLines(child.stdout, (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      switch (o.type) {
        case 'thread.started':
          if (o.thread_id) threadId = o.thread_id;
          break;
        case 'item.updated':
        case 'item.completed': {
          const it = o.item || {};
          if (it.type === 'agent_message' && typeof it.text === 'string') {
            // codex 可能给增量也可能给全量；按“相对上次的增量”推送
            if (it.text.startsWith(lastMsg)) {
              const delta = it.text.slice(lastMsg.length);
              if (delta) onDelta(delta);
            } else {
              onDelta(it.text);
            }
            lastMsg = it.text;
            acc = it.text;
          }
          break;
        }
        case 'turn.completed':
          usage = o.usage || null;
          break;
        case 'error':
          errMsg = o.message || '出错';
          break;
        case 'turn.failed':
          errMsg = o.error?.message || errMsg || 'turn failed';
          break;
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (e) => {
      running.delete(conv.id);
      cleanupImages();
      resolve({ text: acc, sessionId: threadId, error: `无法启动 codex：${e.message}` });
    });
    child.on('close', (code, signal) => {
      running.delete(conv.id);
      cleanupImages();
      const interrupted = signal === 'SIGTERM' || signal === 'SIGKILL';
      let error = errMsg;
      if (!acc && !interrupted && code !== 0 && !error) {
        error = stderr.trim().split('\n').slice(-3).join('\n') || `codex 退出码 ${code}`;
      }
      resolve({ text: acc, sessionId: threadId, usage, error, interrupted });
    });
  });
}

// ---------- HTTP 辅助 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};
async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(DIRS.public, rel));
  if (!full.startsWith(DIRS.public)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const buf = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method;

    // favicon：用内联图标避免 404
    if (p === '/favicon.ico') {
      res.writeHead(204); return res.end();
    }

    // OpenAI 兼容接口（Open WebUI 把它当作一个 OpenAI 连接）
    if (p.startsWith('/v1/')) {
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
        return res.end();
      }
      if (p === '/v1/models' && method === 'GET') {
        const data = (CONFIG.models || []).map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ object: 'list', data }));
      }
      if (p === '/v1/chat/completions' && method === 'POST') return handleChatCompletions(req, res);
      return sendJson(res, 404, { error: { message: 'not found' } });
    }
    // 静态资源
    if (method === 'GET' && (p === '/' || p.startsWith('/vendor/') || p === '/index.html')) {
      return serveStatic(res, p);
    }

    // 列表 / 新建
    if (p === '/api/conversations' && method === 'GET') {
      return sendJson(res, 200, await listConversations());
    }
    if (p === '/api/conversations' && method === 'POST') {
      const b = await readJsonBody(req);
      const c = await createConversation(b);
      return sendJson(res, 201, c);
    }
    // 配置（前端用来填模型下拉）
    if (p === '/api/config' && method === 'GET') {
      return sendJson(res, 200, {
        defaultProvider: CONFIG.defaultProvider,
        claudeModels: CONFIG.claudeModels, defaultClaudeModel: CONFIG.defaultClaudeModel,
        codexModels: CONFIG.codexModels, defaultCodexModel: CONFIG.defaultCodexModel,
        providers: { claude: SETUP.claudeOk, codex: SETUP.codexOk },
      });
    }

    // 单会话相关 /api/conversations/:id ...
    const m = p.match(/^\/api\/conversations\/([^/]+)(\/[a-z]+)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2];

      if (!sub && method === 'GET') {
        const c = await getConversation(id);
        return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: 'not found' });
      }
      if (!sub && method === 'PATCH') {
        const c = await getConversation(id);
        if (!c) return sendJson(res, 404, { error: 'not found' });
        const b = await readJsonBody(req);
        if (typeof b.title === 'string') c.title = b.title;
        if (typeof b.systemPrompt === 'string') c.systemPrompt = b.systemPrompt;
        if (typeof b.model === 'string' && c.messages.length === 0) c.model = b.model;
        if (typeof b.provider === 'string' && c.messages.length === 0) c.provider = b.provider === 'codex' ? 'codex' : 'claude';
        await saveConversation(c);
        return sendJson(res, 200, c);
      }
      if (!sub && method === 'DELETE') {
        await deleteConversation(id);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === '/stop' && method === 'POST') {
        const child = running.get(id);
        if (child) child.kill('SIGTERM');
        return sendJson(res, 200, { stopped: !!child });
      }
      if (sub === '/messages' && method === 'POST') {
        return handleMessage(req, res, id);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

// 发消息 + SSE 流式返回
async function handleMessage(req, res, id) {
  const conv = await getConversation(id);
  if (!conv) return sendJson(res, 404, { error: 'not found' });
  if (running.has(id)) return sendJson(res, 409, { error: '该会话正在生成中' });

  const body = await readJsonBody(req);
  const text = (body.text || '').toString();
  if (!text.trim()) return sendJson(res, 400, { error: 'empty message' });

  // 记录用户消息
  conv.messages.push({ role: 'user', content: text, ts: nowIso() });
  if (conv.title === '新对话') conv.title = text.slice(0, 30).replace(/\n/g, ' ');
  await saveConversation(conv);

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  sse({ type: 'start' });

  const onDelta = (t) => sse({ type: 'delta', text: t });
  const runner = conv.provider === 'codex' ? runCodex : runClaude;

  let result;
  try {
    result = await runner(conv, text, { onDelta });
  } catch (e) {
    result = { text: '', error: e.message };
  }

  // 记录助手消息
  conv.messages.push({
    role: 'assistant', content: result.text || '', ts: nowIso(),
    usage: result.usage || null, cost: result.cost ?? null,
    error: result.error || null, interrupted: !!result.interrupted,
  });
  if (result.sessionId) conv.cliSessionId = result.sessionId;
  await saveConversation(conv);

  sse({
    type: 'done', text: result.text || '', error: result.error || null,
    interrupted: !!result.interrupted, usage: result.usage || null, cost: result.cost ?? null,
    cliSessionId: conv.cliSessionId,
  });
  res.end();
}

// ===== OpenAI 兼容接口（供 Open WebUI 等客户端使用，内部 spawn 真实 CLI，指纹不变）=====
// 多轮：OpenAI 协议无状态，客户端每次发全量 history。这里把会话映射到一条 CLI 会话，
// 线性续聊时只把最新一条 user 消息经 --resume / codex exec resume 发出去——这样发往
// api.anthropic.com 的请求与真实交互式 CLI 的多轮请求结构一致。
const oaiSessions = new Map(); // key: "provider:chatKey" -> { cliSessionId, count }

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : (p?.text || '')).join('');
  return '';
}
function mediaExt(mediaType) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mediaType] || '.png';
}
// 从 OpenAI 多模态 content 里取出 base64 图片（Open WebUI 上传的图片为 data: URL）
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (!p || p.type !== 'image_url') continue;
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
    const m = typeof url === 'string' && /^data:([^;,]+)?;base64,(.*)$/s.exec(url);
    if (m) out.push({ media_type: m[1] || 'image/png', data: m[2] });
  }
  return out;
}
function resolveModel(id) { return (CONFIG.models || []).find(m => m.id === id) || null; }
function renderTranscript(msgs) {
  return msgs.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m.content)}`).join('\n\n');
}
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'k' + (h >>> 0).toString(36);
}

async function handleChatCompletions(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: { message: 'invalid json' } }); }
  const route = resolveModel(body.model);
  if (!route) return sendJson(res, 400, { error: { message: `unknown model: ${body.model}` } });

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = body.stream !== false;
  const sys = messages.filter(m => m.role === 'system').map(m => contentText(m.content)).join('\n\n');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const lastUser = [...nonSystem].reverse().find(m => m.role === 'user');
  const firstUser = nonSystem.find(m => m.role === 'user');
  // 会话键：优先用客户端带的 chat_id，否则用「首条 user 消息 + 模型」哈希（同一会话稳定）
  const chatId = body.metadata?.chat_id || body.chat_id || hashKey(contentText(firstUser?.content) + '|' + body.model);
  const sk = route.provider + ':' + chatId;
  const sess = oaiSessions.get(sk);
  const L = nonSystem.length;

  let userText, cliSessionId = null;
  const images = extractImages(lastUser?.content);   // 最新一条 user 携带的图片
  if (sess && (L - 1) === sess.count) {           // 线性续聊：只发最新一条 user
    userText = contentText(lastUser?.content); cliSessionId = sess.cliSessionId;
  } else if (!sess && L <= 1) {                    // 全新会话首轮
    userText = contentText(lastUser?.content) || '';
  } else {                                         // 接管已有历史 / 编辑 / 重新生成：用全量历史重起一段
    userText = renderTranscript(nonSystem);
  }

  const conv = { id: sk, provider: route.provider, model: route.model, systemPrompt: sys, cliSessionId };
  const runner = route.provider === 'codex' ? runCodex : runClaude;
  req.on('close', () => { const c = running.get(sk); if (c) c.kill('SIGTERM'); });

  const cid = 'chatcmpl-' + randomUUID();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    let any = false;
    const result = await runner(conv, userText, { images, onDelta: (t) => { any = true; chunk({ content: t }); } });
    if (result.error && !any) chunk({ content: `⚠ ${result.error}` });
    chunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    oaiSessions.set(sk, { cliSessionId: result.sessionId || cliSessionId, count: L + 1 });
  } else {
    const result = await runner(conv, userText, { images, onDelta: () => {} });
    oaiSessions.set(sk, { cliSessionId: result.sessionId || cliSessionId, count: L + 1 });
    const u = result.usage || {};
    let content = result.text || '';
    if (result.error && !content) content = `⚠ ${result.error}`;
    sendJson(res, 200, {
      id: cid, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) },
    });
  }
}

// ---------- 启动 ----------
let SETUP = { claudeOk: false, codexOk: false };
bootstrap().then((setup) => {
  SETUP = setup;
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`ClaudeWebUI 已启动： http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`  claude 凭据软链：${SETUP.claudeOk ? 'OK' : '缺失'}    codex 凭据软链：${SETUP.codexOk ? 'OK' : '缺失'}`);
    console.log(`  会话隔离在： ${DIRS.claudeHome}/projects、${DIRS.codexHome}/sessions（正常 /resume 看不到）`);
  });
}).catch((e) => { console.error('启动失败：', e); process.exit(1); });
