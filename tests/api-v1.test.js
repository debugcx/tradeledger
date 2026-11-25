import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.TRADELEDGER_PASSWORD = 'test-pass-123';

const db = await import('../src/db.js');
db.setDb(db.openDb(':memory:'));

const store = await import('../src/store.js');
const auth = await import('../src/auth.js');
const { createApiToken, revokeApiToken, listApiAudit } = await import('../src/api-tokens.js');

const account = store.createAccount({ exchange: 'manual', name: '测试账户' });
const tradeId = store.createTrade({
  symbol: 'BTC/USDT', side: 'long', size: 1, notional: 100,
  entry_price: 100, exit_price: 110, pnl: 10,
  open_time: '2026-11-01T10:00:00.000Z',
  close_time: '2026-11-01T11:00:00.000Z',
}, { accountId: account.id });

const { handle } = await import('../src/routes.js');

test.after(() => db.closeDb());

const req = (path, init = {}) => new Request(`http://localhost${path}`, init);
const withToken = (token, path, init = {}) => req(path, {
  ...init,
  headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
});
const readToken = createApiToken({ name: '只读', scopes: 'read' }).token;
const writeToken = createApiToken({ name: '读写', scopes: 'write' }).token;

test('设置页：创建 Token 只展示一次，并可通过 Bearer 访问 /api/v1/me', async () => {
  const session = auth.login({ remember: false });
  const res = await handle(req('/dashboard/settings/api-tokens', {
    method: 'POST',
    headers: {
      cookie: `tl_session=${session.token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ name: '设置页创建', scopes: 'read', expiresDays: '30' }).toString(),
  }));
  assert.equal(res.status, 200);
  const html = await res.text();
  const match = html.match(/tl_[A-Za-z0-9_-]{20,}/);
  assert.ok(match, '页面应展示一次明文 Token');
  const me = await handle(withToken(match[0], '/api/v1/me'));
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.ok, true);
  assert.equal(body.auth, 'token');
  assert.equal(body.token.name, '设置页创建');
  assert.deepEqual(body.token.scopes, ['read']);
});

test('只读 Token：可查询交易、详情、统计、持仓、标签、笔记', async () => {
  const list = await handle(withToken(readToken, '/api/v1/trades?symbol=BTC%2FUSDT&limit=10'));
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.count, 1);
  assert.equal(listBody.trades[0].id, tradeId);

  const detail = await handle(withToken(readToken, `/api/v1/trades/${tradeId}`));
  const detailBody = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(detailBody.trade.id, tradeId);
  assert.equal(detailBody.fills_total, 0);

  const summary = await handle(withToken(readToken, '/api/v1/summary'));
  const summaryBody = await summary.json();
  assert.equal(summaryBody.ok, true);
  assert.equal(summaryBody.totals.trades, 1);
  assert.equal(summaryBody.totals.pnl, 10);
  assert.ok(summaryBody.edge);

  const positions = await handle(withToken(readToken, '/api/v1/positions'));
  assert.equal((await positions.json()).ok, true);

  const tags = await handle(withToken(readToken, '/api/v1/tags'));
  assert.equal((await tags.json()).ok, true);

  const notes = await handle(withToken(readToken, '/api/v1/notes?limit=5'));
  assert.equal((await notes.json()).ok, true);

  const accounts = await handle(withToken(readToken, '/api/v1/accounts'));
  const accountsBody = await accounts.json();
  assert.equal(accountsBody.accounts[0].api_key_enc, undefined);
});

test('只读 Token：写接口返回 403', async () => {
  const res = await handle(withToken(readToken, `/api/v1/trades/${tradeId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '不该写入' }),
  }));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'forbidden');
  assert.equal(store.getTrade(tradeId).note, null);
});

test('读写 Token：写备注、替换标签、切换标签；Bearer 请求不受 Origin 限制', async () => {
  const res = await handle(withToken(writeToken, `/api/v1/trades/${tradeId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ note: '计划内交易', tags: ['计划内', '突破'] }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.trade.note, '计划内交易');
  assert.deepEqual([...body.trade.tags].sort(), ['突破', '计划内'].sort());
  assert.equal(store.getTrade(tradeId).note, '计划内交易');

  const toggle = await handle(withToken(writeToken, `/api/v1/trades/${tradeId}/tags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: '突破' }),
  }));
  const toggleBody = await toggle.json();
  assert.equal(toggleBody.ok, true);
  assert.equal(toggleBody.attached, false);
  assert.deepEqual(store.getTrade(tradeId).tags, ['计划内']);

  const back = await handle(withToken(writeToken, `/api/v1/trades/${tradeId}/tags/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag: '突破' }),
  }));
  assert.equal((await back.json()).attached, true);
});

test('读写 Token：持仓笔记可写可清空', async () => {
  const res = await handle(withToken(writeToken, '/api/v1/positions/note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: account.id, symbol: 'BTC/USDT', side: 'long', note: '等回踩' }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note.content, '等回踩');

  const cleared = await handle(withToken(writeToken, '/api/v1/positions/note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: account.id, symbol: 'BTC/USDT', side: 'long', note: '' }),
  }));
  assert.equal((await cleared.json()).note, null);
});

test('错误形状：无 Token 401、未知交易 404、非法 JSON 400、未知接口 404', async () => {
  const noToken = await handle(req('/api/v1/trades'));
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).error.code, 'unauthorized');

  const missing = await handle(withToken(writeToken, '/api/v1/trades/999999'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');

  const badJson = await handle(withToken(writeToken, `/api/v1/trades/${tradeId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  }));
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_json');

  const unknown = await handle(withToken(readToken, '/api/v1/nope'));
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.ok, false);
  assert.equal(unknownBody.error.code, 'not_found');
});

test('撤销后 401；Bearer 不能访问旧接口', async () => {
  const temp = createApiToken({ name: '临时', scopes: 'read' });
  const before = await handle(withToken(temp.token, '/api/v1/me'));
  assert.equal(before.status, 200);
  revokeApiToken(temp.row.id);
  const after = await handle(withToken(temp.token, '/api/v1/me'));
  assert.equal(after.status, 401);

  const legacy = await handle(withToken(writeToken, '/api/trades?limit=1'));
  assert.equal(legacy.status, 401);
});

test('审计：v1 调用被记录', () => {
  const rows = listApiAudit(100);
  assert.ok(rows.some((r) => r.path === '/api/v1/trades' && r.method === 'GET'));
  assert.ok(rows.some((r) => r.path === `/api/v1/trades/${tradeId}` && r.method === 'PATCH'));
  assert.ok(rows.every((r) => Number(r.status) > 0));
});
