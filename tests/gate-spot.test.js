import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;
const queries = [];
let failNext = false;

function trade(id, offsetSec) {
  return {
    id: String(id),
    currency_pair: 'GT_USDT',
    side: id % 2 ? 'buy' : 'sell',
    price: '5.0',
    amount: '1',
    fee: '0.01',
    fee_currency: 'USDT',
    create_time: Math.floor((NOW - 10 * DAY) / 1000) + offsetSec,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/v4/spot/my_trades') {
    if (failNext || q.currency_pair === 'ERR_USDT') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ label: 'INVALID_PARAM_VALUE', message: 'boom' }));
    }
    if (q.page === '1') {
      return res.end(JSON.stringify(Array.from({ length: 1000 }, (_, i) => trade(i + 1, i))));
    }
    if (q.page === '2') {
      return res.end(JSON.stringify([trade(1001, 1000), trade(1002, 1001)]));
    }
    return res.end('[]');
  }
  if (url.pathname === '/api/v4/spot/accounts') {
    return res.end(JSON.stringify([{ currency: 'GT', available: '1', locked: '0' }]));
  }
  res.statusCode = 404;
  res.end('[]');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.GATE_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { gate } = await import('../src/exchanges/gate.js?gate-spot-test');
const creds = { apiKey: 'k', apiSecret: 's' };

test('Gate 现货分页：使用 page 而不是 offset，翻页不丢数据', async () => {
  queries.length = 0;
  const res = await gate.fetchSpotTrades({
    creds,
    fromMs: NOW - 20 * DAY,
    toMs: NOW,
    limit: 5000,
    symbols: ['GT_USDT'],
  });
  assert.equal(res.fills.length, 1002);
  const pages = queries.filter((q) => q.path === '/api/v4/spot/my_trades');
  assert.deepEqual(pages.map((q) => q.page), ['1', '2']);
  assert.ok(pages.every((q) => q.offset === undefined));
  assert.equal(new Set(res.fills.map((f) => f.id)).size, 1002);
  assert.equal(res.fills[0].side, 'buy');
});

test('Gate 现货窗口：单次请求跨度不超过 30 天', async () => {
  queries.length = 0;
  await gate.fetchSpotTrades({
    creds,
    fromMs: NOW - 95 * DAY,
    toMs: NOW,
    limit: 5000,
    symbols: ['GT_USDT'],
  });
  const windows = queries.filter((q) => q.path === '/api/v4/spot/my_trades');
  assert.ok(windows.length >= 4);
  for (const q of windows) {
    assert.ok(Number(q.to) - Number(q.from) <= 30 * 86400);
  }
});

test('Gate 现货错误不再静默：无数据且请求失败时抛出', async () => {
  failNext = true;
  await assert.rejects(
    () => gate.fetchSpotTrades({ creds, fromMs: NOW - 2 * DAY, toMs: NOW, limit: 100, symbols: ['GT_USDT'] }),
    /boom|INVALID_PARAM_VALUE/,
  );
  failNext = false;
});

test.after(() => new Promise((resolve) => server.close(resolve)));
