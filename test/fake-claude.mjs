#!/usr/bin/env node
// 假 claude：按真实 stream-json 结构输出固定回复，用于离线测试。
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const prompt = get('-p') || '';
const sessionId = get('--session-id') || get('--resume') || randomUUID();
const reply = `收到：${prompt.slice(0, 40)} — 这是来自假 claude 的回复。`;
const SLEEP = Number(process.env.FAKE_SLEEP_MS || 0);

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-sonnet' });

let i = 0;
const parts = reply.match(/.{1,6}/gu) || [reply];
function step() {
  if (i === 0) out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
  if (i < parts.length) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: parts[i] } } });
    i++;
    setTimeout(step, SLEEP);
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] }, session_id: sessionId });
    out({ type: 'result', subtype: 'success', result: reply, session_id: sessionId,
      usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.0001 });
    process.exit(0);
  }
}
step();
