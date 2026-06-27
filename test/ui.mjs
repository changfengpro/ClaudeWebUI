#!/usr/bin/env node
// 浏览器 UI 校验：用缓存的 chromium 真打开页面，跑一轮发送，校验渲染。
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
// chrome 路径优先取环境变量，否则从 playwright 缓存里找一个，不写死
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try { return execSync(`find ${cache} -maxdepth 3 -type f -name chrome 2>/dev/null | head -1`).toString().trim(); }
  catch { return ''; }
}
const CHROME = findChrome();
const BASE = process.env.UI_BASE || `http://127.0.0.1:${process.env.PORT || 8788}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
ok(await page.locator('#newBtn').isVisible(), '页面加载，侧栏可见');
ok(await page.locator('#empty').isVisible(), '初始显示新对话空态');

// 发送一条
await page.locator('#input').fill('你好世界');
await page.locator('#sendBtn').click();
await page.waitForSelector('.msg.assistant .content', { timeout: 8000 });
await page.waitForFunction(() => {
  const el = document.querySelector('.msg.assistant .content');
  return el && el.textContent.includes('假 claude');
}, { timeout: 8000 });
ok(true, '助手回复已流式渲染');
ok((await page.locator('.msg.user .content').textContent()).includes('你好世界'), '用户消息显示正确');
ok(await page.locator('#stopBtn').isHidden(), '完成后停止按钮隐藏');

// 侧栏出现该会话
await page.waitForTimeout(300);
ok(await page.locator('#convList .conv').count() >= 1, '侧栏出现会话条目');
ok((await page.locator('#convList .conv .name').first().textContent()).includes('你好'), '会话标题取自首条消息');

// 新建 + 切换 provider 到 codex
await page.locator('#newBtn').click();
ok(await page.locator('#empty').isVisible(), '新建回到空态');
await page.selectOption('#pProvider', 'codex');
await page.locator('#input').fill('codex 测试');
await page.locator('#sendBtn').click();
await page.waitForFunction(() => {
  const el = document.querySelector('.msg.assistant .content');
  return el && el.textContent.includes('假 codex');
}, { timeout: 8000 });
ok(true, 'codex provider 也能流式回复');
ok((await page.locator('#hBadge').textContent()).includes('codex'), '头部标记显示 codex');

// Markdown 渲染：发一段带代码块的（假 claude 会回显前 40 字）
ok(errors.length === 0, '无 JS 运行时错误' + (errors.length ? ': ' + errors.join(' | ') : ''));

await browser.close();
console.log(`\nUI 结果： ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
