#!/usr/bin/env node
/**
 * TradeLedger MCP stdio 转发器（可选）。
 *
 * MCP 工具已经实现在服务端 `POST /mcp`（Streamable HTTP），Agent 可以直接
 * 用 HTTP 连接，不需要本脚本。只有当客户端只支持 stdio 时，才用这个薄转发器：
 *
 *   TRADELEDGER_BASE_URL=http://10.126.126.50:8790 \
 *   TRADELEDGER_API_TOKEN=tl_xxx \
 *   node scripts/mcp-server.mjs
 *
 * stdout 只输出 MCP 协议消息；诊断信息走 stderr。
 */

import readline from 'node:readline';

const BASE = String(process.env.TRADELEDGER_BASE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = String(process.env.TRADELEDGER_API_TOKEN || '').trim();
const TIMEOUT_MS = Math.max(1000, Number(process.env.TRADELEDGER_MCP_TIMEOUT_MS) || 60_000);

const log = (...args) => console.error('[tradeledger-mcp]', ...args);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function forward(message) {
  if (!BASE) throw new Error('缺少环境变量 TRADELEDGER_BASE_URL');
  if (!TOKEN) throw new Error('缺少环境变量 TRADELEDGER_API_TOKEN（在 TradeLedger 设置页创建）');
  let res;
  try {
    res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`无法连接 ${BASE}（${err?.cause?.code || err?.name || err?.message || '网络错误'}）`);
  }
  // 通知（initialized 等）服务端返回 202，没有响应体
  if (res.status === 202) return null;
  const text = await res.text();
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = JSON.parse(text);
      detail = data?.error?.message || data?.error || detail;
    } catch { /* 非 JSON */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('服务端返回的不是 JSON');
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    rpcError(null, -32700, 'JSON 解析失败');
    return;
  }
  const id = message && message.id !== undefined ? message.id : null;
  chain = chain
    .then(async () => {
      const response = await forward(message);
      if (response) send(response);
    })
    .catch((err) => {
      log('forward failed', err?.message || err);
      // 通知没有 id，不回包；请求才返回 JSON-RPC 错误
      if (id !== null) rpcError(id, -32603, err?.message || '转发失败');
    });
});

rl.on('close', () => {
  // Windows 下不要用 process.exit：与尚未关闭的 stdio 句柄竞争会触发 libuv 断言
  chain.finally(() => { process.exitCode = 0; });
});

log(`ready · ${BASE || '(未设置)'} · token=${TOKEN ? '已设置' : '(未设置)'} · timeout=${TIMEOUT_MS}ms`);
