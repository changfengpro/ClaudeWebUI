// 极简 MITM 代理：只解密 api.anthropic.com，其余直通。把请求头(脱敏)写到 CAPTURE 文件。
// 用途：验证 claude-web 的请求指纹与原生 claude CLI 完全一致。
//
// 复现步骤（在项目根目录下）：
//   1) 生成自签 CA 与叶子证书：
//        openssl genrsa -out ca.key 2048
//        openssl req -x509 -new -nodes -key ca.key -sha256 -days 3 -subj "/CN=local-mitm-ca" -out ca.crt
//        openssl genrsa -out leaf.key 2048
//        openssl req -new -key leaf.key -subj "/CN=api.anthropic.com" -out leaf.csr
//        printf "subjectAltName=DNS:api.anthropic.com\n" > san.ext
//        openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3 -sha256 -extfile san.ext -out leaf.crt
//      （把 ca.crt/leaf.* 放在本脚本同目录 test/ 下）
//   2) 场景A(原生)：CAPTURE=capA.jsonl node test/mitm-proxy.mjs &
//        HTTPS_PROXY=http://127.0.0.1:8890 NODE_EXTRA_CA_CERTS=test/ca.crt claude -p "say hi" --model sonnet </dev/null
//   3) 场景B(claude-web 实际参数)：CAPTURE=capB.jsonl node test/mitm-proxy.mjs &
//        HTTPS_PROXY=… NODE_EXTRA_CA_CERTS=test/ca.crt CLAUDE_CONFIG_DIR=homes/claude-home \
//          claude -p "say hi" --output-format stream-json --verbose --include-partial-messages \
//          --permission-mode plan --model sonnet --session-id <uuid> </dev/null
//   4) diff capA.jsonl 与 capB.jsonl 中 POST /v1/messages 的 headers（应逐字一致）。
// 证书与抓包文件不入库（仅本地生成）。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const leaf = { key: fs.readFileSync(path.join(DIR, 'leaf.key')), cert: fs.readFileSync(path.join(DIR, 'leaf.crt')) };
const CAPTURE = process.env.CAPTURE || path.join(DIR, 'capture.jsonl');
const PORT = Number(process.env.MITM_PORT || 8890);
fs.writeFileSync(CAPTURE, '');

const SENSITIVE = new Set(['authorization', 'cookie', 'x-api-key']);
function redact(headers) {
  const o = {};
  for (const [k, v] of Object.entries(headers)) {
    o[k] = SENSITIVE.has(k.toLowerCase())
      ? `<present:${String(v).split(' ')[0]}…len=${String(v).length}>`
      : v;
  }
  return o;
}

// 解密后的 HTTPS 服务：记录请求头并转发到真实 api.anthropic.com
const mitm = https.createServer(leaf, (req, res) => {
  if (req.method === 'POST' || req.url.includes('messages') || req.url.includes('token')) {
    fs.appendFileSync(CAPTURE, JSON.stringify({ method: req.method, url: req.url, headers: redact(req.headers) }) + '\n');
  }
  const up = https.request({ host: 'api.anthropic.com', port: 443, method: req.method, path: req.url,
    headers: { ...req.headers, host: 'api.anthropic.com' } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});

const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxy.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  if (host === 'api.anthropic.com') {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    mitm.emit('connection', clientSocket);     // 让 https 服务做 TLS 握手 + HTTP 解析
  } else {
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.end());
    clientSocket.on('error', () => upstream.end());
  }
});
proxy.listen(PORT, '127.0.0.1', () => console.log(`mitm listening ${PORT}, capture=${CAPTURE}`));
