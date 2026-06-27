#!/usr/bin/env node
// OpenAI 兼容接口桩测试：/v1/models、非流式、流式、多轮续聊、codex 路由。不联网、不耗额度。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8791, BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

async function post(body) {
  return fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function readSSE(resp) {
  const reader = resp.body.getReader(); const dec = new TextDecoder();
  let buf = '', deltas = '', sawDone = false, roleFirst = false, first = true;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const c = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!c.startsWith('data: ')) continue;
      const payload = c.slice(6);
      if (payload === '[DONE]') { sawDone = true; continue; }
      const o = JSON.parse(payload);
      const d = o.choices?.[0]?.delta || {};
      if (first) { roleFirst = d.role === 'assistant'; first = false; }
      if (d.content) deltas += d.content;
    }
  }
  return { deltas, sawDone, roleFirst };
}

async function main() {
  const srv = spawn('node', [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT),
      CLAUDE_WEB_CLAUDE_BIN: path.join(ROOT, 'test', 'fake-claude.mjs'),
      CLAUDE_WEB_CODEX_BIN: path.join(ROOT, 'test', 'fake-codex.mjs'), FAKE_SLEEP_MS: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('启动超时')), 5000);
    srv.stdout.on('data', d => { if (d.toString().includes('已启动')) { clearTimeout(to); resolve(); } });
    srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  });

  try {
    // /v1/models
    const models = await (await fetch(`${BASE}/v1/models`)).json();
    ok(models.object === 'list' && models.data.some(m => m.id === 'claude-sonnet'), '/v1/models 列出 claude-sonnet');
    ok(models.data.some(m => m.id === 'codex'), '/v1/models 列出 codex');

    // 非流式
    const c1 = await (await post({ model: 'claude-sonnet', stream: false, messages: [{ role: 'user', content: '你好' }] })).json();
    ok(c1.object === 'chat.completion' && c1.choices[0].message.role === 'assistant', '非流式返回 chat.completion');
    ok(c1.choices[0].message.content.includes('你好'), '非流式内容含回显');
    ok(c1.usage && c1.usage.total_tokens > 0, '非流式带 usage');

    // 流式
    const s = await readSSE(await post({ model: 'claude-sonnet', stream: true, messages: [{ role: 'user', content: '流式' }] }));
    ok(s.roleFirst, '流式首块带 role=assistant');
    ok(s.deltas.includes('流式'), '流式增量拼出回显');
    ok(s.sawDone, '流式以 [DONE] 结束');

    // 多轮线性续聊：轮2 只应把最新一句交给 CLI
    await (await post({ model: 'claude-sonnet', stream: false, messages: [{ role: 'user', content: 'AAA' }] })).json();
    const t2 = await (await post({ model: 'claude-sonnet', stream: false, messages: [
      { role: 'user', content: 'AAA' }, { role: 'assistant', content: '收到：AAA — 这是来自假 claude 的回复。' }, { role: 'user', content: 'BBB' },
    ] })).json();
    const c2 = t2.choices[0].message.content;
    ok(c2.includes('BBB') && !c2.includes('AAA'), '线性续聊只发最新一句（走 resume）');

    // codex 路由
    const cx = await (await post({ model: 'codex', stream: false, messages: [{ role: 'user', content: 'codex' }] })).json();
    ok(cx.choices[0].message.content.includes('假 codex'), 'codex 模型路由到 codex CLI');

    // 未知模型
    const bad = await post({ model: 'nope', stream: false, messages: [{ role: 'user', content: 'x' }] });
    ok(bad.status === 400, '未知模型返回 400');
  } finally { srv.kill(); }
  console.log(`\n结果： ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
