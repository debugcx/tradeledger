import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const TOOL_NAMES = [
  'trades_search', 'trade_get', 'ledger_summary', 'positions_list', 'accounts_list',
  'tags_list', 'notes_search', 'missed_trades_list', 'trade_note_set', 'trade_tags_set',
  'trade_tag_toggle', 'position_note_set',
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, path: url.pathname, body });
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    let msg;
    try { msg = JSON.parse(body); } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad json' } }));
      return;
    }
    const send = (obj) => res.end(JSON.stringify(obj));
    if (msg.method === 'notifications/initialized') {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (msg.method === 'initialize') {
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tradeledger', version: 'test' },
        },
      });
    }
    if (msg.method === 'tools/list') {
      return send({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: TOOL_NAMES.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })) },
      });
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      if (name === 'trades_search') {
        return send({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: 1, trades: [{ id: 7, symbol: args.symbol || 'BTC/USDT' }] }) }] },
        });
      }
      if (name === 'trade_note_set') {
        return send({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, trade: { id: args.id, note: args.note } }) }] },
        });
      }
      if (name === 'positions_list') {
        return send({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: '调用失败：Token 无效' }], isError: true },
        });
      }
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: '未知工具' } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function runStdio(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mcp-server.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        TRADELEDGER_BASE_URL: base,
        TRADELEDGER_API_TOKEN: 'tl_test_token_1234567890',
        TRADELEDGER_MCP_TIMEOUT_MS: '5000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP 子进程超时；stderr=${stderr.slice(0, 500)}`));
    }, 10_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = stdout.split('\n').map((s) => s.trim()).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      resolve({ code, parsed, stderr });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

test('stdio 转发器：initialize / tools/call / 错误都透传到 /mcp', async () => {
  const { code, parsed, stderr } = await runStdio([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'trades_search', arguments: { symbol: 'BTC/USDT', limit: 5 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'trade_note_set', arguments: { id: 7, note: '复盘内容' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'positions_list', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
  ]);
  assert.equal(code, 0, `子进程应正常退出；stderr=${stderr}`);
  const byId = new Map(parsed.map((m) => [m.id, m]));

  assert.equal(byId.get(1).result.serverInfo.name, 'tradeledger');
  assert.equal(byId.get(2).result.tools.length, 12);

  const search = JSON.parse(byId.get(3).result.content[0].text);
  assert.equal(search.ok, true);
  assert.equal(search.count, 1);

  const forwarded = requests.find((r) => {
    try { return JSON.parse(r.body).params?.name === 'trades_search'; } catch { return false; }
  });
  assert.ok(forwarded);
  assert.equal(forwarded.path, '/mcp');
  assert.equal(JSON.parse(forwarded.body).params.arguments.limit, 5);

  const write = JSON.parse(byId.get(4).result.content[0].text);
  assert.equal(write.trade.note, '复盘内容');

  assert.equal(byId.get(5).result.isError, true);
  assert.match(byId.get(5).result.content[0].text, /Token 无效/);

  assert.equal(byId.get(6).error.code, -32602);
  assert.match(byId.get(6).error.message, /未知工具/);
});

test.after(() => new Promise((resolve) => server.close(resolve)));
