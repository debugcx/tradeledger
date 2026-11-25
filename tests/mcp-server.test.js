import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, path: url.pathname, query: url.search, body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/v1/positions') {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Token 无效' } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/trades') {
      res.end(JSON.stringify({ ok: true, count: 1, trades: [{ id: 7, symbol: 'BTC/USDT' }] }));
      return;
    }
    if (req.method === 'PATCH' && url.pathname === '/api/v1/trades/7') {
      const parsed = JSON.parse(body || '{}');
      res.end(JSON.stringify({ ok: true, trade: { id: 7, note: parsed.note } }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function runMcp(messages) {
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
      const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const parsed = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { /* 忽略非协议输出 */ }
      }
      resolve({ code, parsed, stderr });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

test('MCP：initialize / tools/list / tools/call 与错误处理', async () => {
  const { code, parsed, stderr } = await runMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
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
  assert.equal(byId.get(1).result.capabilities.tools.listChanged, false);

  const tools = byId.get(2).result.tools;
  const names = tools.map((t) => t.name);
  for (const name of [
    'trades_search', 'trade_get', 'ledger_summary', 'positions_list', 'accounts_list',
    'tags_list', 'notes_search', 'missed_trades_list', 'trade_note_set', 'trade_tags_set',
    'trade_tag_toggle', 'position_note_set',
  ]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`);
  }

  const search = JSON.parse(byId.get(3).result.content[0].text);
  assert.equal(search.ok, true);
  assert.equal(search.count, 1);
  const searchReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/trades');
  assert.ok(searchReq);
  assert.match(searchReq.query, /symbol=BTC%2FUSDT/);
  assert.match(searchReq.query, /limit=5/);

  const write = JSON.parse(byId.get(4).result.content[0].text);
  assert.equal(write.trade.note, '复盘内容');
  const writeReq = requests.find((r) => r.method === 'PATCH' && r.path === '/api/v1/trades/7');
  assert.ok(writeReq);
  assert.equal(JSON.parse(writeReq.body).note, '复盘内容');

  assert.equal(byId.get(5).result.isError, true);
  assert.match(byId.get(5).result.content[0].text, /Token 无效/);

  assert.equal(byId.get(6).error.code, -32602);
  assert.match(byId.get(6).error.message, /未知工具/);
});

test.after(() => new Promise((resolve) => server.close(resolve)));
