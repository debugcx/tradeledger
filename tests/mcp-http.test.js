import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.TRADELEDGER_PASSWORD = 'test-pass-123';

const db = await import('../src/db.js');
db.setDb(db.openDb(':memory:'));

const store = await import('../src/store.js');
const { createApiToken } = await import('../src/api-tokens.js');
const { handle } = await import('../src/routes.js');

const account = store.createAccount({ exchange: 'manual', name: 'MCP 账户' });
const tradeId = store.createTrade({
  symbol: 'ETH/USDT', side: 'short', size: 2, notional: 200,
  entry_price: 100, exit_price: 95, pnl: 10,
  open_time: '2026-11-02T10:00:00.000Z',
  close_time: '2026-11-02T12:00:00.000Z',
}, { accountId: account.id });

test.after(() => db.closeDb());

const readToken = createApiToken({ name: 'MCP 只读', scopes: 'read' }).token;
const writeToken = createApiToken({ name: 'MCP 读写', scopes: 'write' }).token;

function mcp(token, payload, init = {}) {
  return handle(new Request('http://localhost/mcp', {
    method: 'POST',
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  }));
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('HTTP MCP：无 Token 401，GET 返回 405', async () => {
  const noToken = await mcp(null, rpc(1, 'initialize', {}));
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).error.code, 'unauthorized');

  const get = await handle(new Request('http://localhost/mcp', {
    headers: { authorization: `Bearer ${readToken}` },
  }));
  assert.equal(get.status, 405);
});

test('HTTP MCP：initialize / tools/list / tools/call（无状态，无需会话）', async () => {
  const init = await mcp(readToken, rpc(1, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  }));
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'tradeledger');
  assert.equal(initBody.result.protocolVersion, '2025-03-26');
  assert.ok(initBody.result.capabilities.tools);

  const list = await mcp(readToken, rpc(2, 'tools/list', {}));
  const listBody = await list.json();
  assert.equal(listBody.result.tools.length, 12);

  const call = await mcp(readToken, rpc(3, 'tools/call', {
    name: 'trades_search', arguments: { symbol: 'ETH/USDT', limit: 5 },
  }));
  const callBody = await call.json();
  const payload = JSON.parse(callBody.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.trades[0].id, tradeId);

  const summary = await mcp(readToken, rpc(4, 'tools/call', { name: 'ledger_summary', arguments: {} }));
  const summaryBody = await summary.json();
  const summaryData = JSON.parse(summaryBody.result.content[0].text);
  assert.equal(summaryData.totals.trades, 1);
});

test('HTTP MCP：通知返回 202；只读 Token 写工具返回 isError', async () => {
  const notice = await mcp(readToken, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notice.status, 202);

  const write = await mcp(readToken, rpc(5, 'tools/call', {
    name: 'trade_note_set', arguments: { id: tradeId, note: '不该写入' },
  }));
  const writeBody = await write.json();
  assert.equal(writeBody.result.isError, true);
  assert.match(writeBody.result.content[0].text, /只有读取权限/);
  assert.equal(store.getTrade(tradeId).note, null);

  const okWrite = await mcp(writeToken, rpc(6, 'tools/call', {
    name: 'trade_note_set', arguments: { id: tradeId, note: '通过 MCP 写入' },
  }));
  const okBody = await okWrite.json();
  assert.equal(okBody.result.isError, undefined);
  assert.equal(store.getTrade(tradeId).note, '通过 MCP 写入');
});

test('HTTP MCP：未知工具 / 非法 JSON / 批量请求 / 跨站 Origin', async () => {
  const unknown = await mcp(readToken, rpc(7, 'tools/call', { name: 'nope', arguments: {} }));
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error.code, -32602);

  const bad = await mcp(readToken, '{oops');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);

  const batch = await mcp(readToken, [rpc(8, 'ping'), rpc(9, 'tools/list', {})]);
  const batchBody = await batch.json();
  assert.equal(batchBody.length, 2);
  assert.deepEqual(batchBody[0].result, {});

  const cross = await mcp(readToken, rpc(10, 'ping'), { headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});
