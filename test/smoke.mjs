#!/usr/bin/env node
// 冒烟测试：用假 CLI 跑通 创建→流式→落库→停止→删除，全程不联网、不耗额度。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

async function readSSE(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', deltas = '', done = null;
  while (true) {
    const { done: d, value } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const o = JSON.parse(chunk.slice(6));
      if (o.type === 'delta') deltas += o.text;
      if (o.type === 'done') done = o;
    }
  }
  return { deltas, done };
}

async function testProvider(name, provider) {
  console.log(`\n[${name}]`);
  const c = await (await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model: 'm1' }),
  })).json();
  ok(c.id && c.provider === provider, '创建会话');

  const r1 = await fetch(`${BASE}/api/conversations/${c.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好' }),
  });
  const { deltas, done } = await readSSE(r1);
  ok(done && !done.error, '首轮收到 done 且无错误');
  ok(deltas.includes('你好') || done.text.includes('你好'), '回复包含 prompt 回显');
  ok(done.cliSessionId, '捕获到 cliSessionId（用于续聊）');

  const got = await (await fetch(`${BASE}/api/conversations/${c.id}`)).json();
  ok(got.messages.length === 2, '落库 2 条消息');
  ok(got.messages[1].role === 'assistant' && got.messages[1].content, '助手消息已持久化');
  ok(got.title !== '新对话', '首条消息自动生成标题');
  const sid1 = got.cliSessionId;

  // 第二轮：应走 resume，沿用同一 cliSessionId
  const r2 = await fetch(`${BASE}/api/conversations/${c.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '第二句' }),
  });
  await readSSE(r2);
  const got2 = await (await fetch(`${BASE}/api/conversations/${c.id}`)).json();
  ok(got2.messages.length === 4, '续聊后 4 条消息');
  ok(got2.cliSessionId === sid1, '续聊沿用同一 session id');

  await fetch(`${BASE}/api/conversations/${c.id}`, { method: 'DELETE' });
  const after = await fetch(`${BASE}/api/conversations/${c.id}`);
  ok(after.status === 404, '删除后查不到');
  return c.id;
}

async function testStop() {
  console.log('\n[停止生成]');
  const c = await (await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'claude', model: 'm1' }),
  })).json();
  // 慢速假 claude，发出后立即停止
  const p = fetch(`${BASE}/api/conversations/${c.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '停止测试' }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const st = await (await fetch(`${BASE}/api/conversations/${c.id}/stop`, { method: 'POST' })).json();
  ok(st.stopped, '/stop 命中运行中的子进程');
  const { done } = await readSSE(await p);
  ok(done && done.interrupted, 'done 标记 interrupted');
  await fetch(`${BASE}/api/conversations/${c.id}`, { method: 'DELETE' });
}

async function main() {
  const srv = spawn('node', [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env, PORT: String(PORT),
      CLAUDE_WEB_CLAUDE_BIN: path.join(ROOT, 'test', 'fake-claude.mjs'),
      CLAUDE_WEB_CODEX_BIN: path.join(ROOT, 'test', 'fake-codex.mjs'),
      FAKE_SLEEP_MS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('服务器启动超时')), 5000);
    srv.stdout.on('data', (d) => { if (d.toString().includes('已启动')) { clearTimeout(to); resolve(); } });
    srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  });

  try {
    await testProvider('claude provider', 'claude');
    await testProvider('codex provider', 'codex');
    await testStop();
  } finally {
    srv.kill();
  }
  console.log(`\n结果： ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
