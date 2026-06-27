#!/usr/bin/env node
// 假 codex：按真实 --json thread 事件结构输出固定回复，用于离线测试。
import { randomUUID } from 'node:crypto';
const argv = process.argv.slice(2);
// codex exec [resume <id>] "<prompt>" ...
let threadId = randomUUID();
let prompt = '';
if (argv[1] === 'resume') { threadId = argv[2]; prompt = argv[3] || ''; }
else { prompt = argv[1] || ''; }
const reply = `收到：${prompt.slice(0, 40)} — 这是来自假 codex 的回复。`;

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'thread.started', thread_id: threadId });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
out({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 16 } });
process.exit(0);
