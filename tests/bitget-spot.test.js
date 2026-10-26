import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;
const queries = [];
let failNext = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname !== '/api/v2/spot/trade/fills') {
    res.statusCode = 404;
    return res.end('{}');
  }
  if (failNext) {
    return res.end(JSON.stringify({ code: '40001', msg: 'boom' }));
  }
  const idStart = q.idLessThan ? Number(q.idLessThan) - 100 : 1000;
  const n = q.idLessThan ? 1 : 100;
  const rows = Array.from({ length: n }, (_, i) => ({
    tradeId: String(idStart - i),
    symbol: 'BTCUSDT',
    price: '60000',
    size: '0.01',
    side: i % 2 ? 'buy' : 'sell',
    cTime: String(NOW - 5 * DAY),
    feeDetail: [{ totalFee: '0.1', feeCoin: 'USDT' }],
  }));
  res.end(JSON.stringify({ code: '00000', data: rows }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.BITGET_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { bitget } = await import('../src/exchanges/bitget.js?bitget-spot-test');
const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };

test('Bitget 现货：7 天窗口 + idLessThan 翻页', async () => {
  queries.length = 0;
  const res = await bitget.fetchSpotTrades({
    creds,
    fromMs: NOW - 10 * DAY,
    toMs: NOW,
    limit: 5000,
    symbols: ['BTCUSDT'],
  });
  assert.equal(res.fills.length, 101);
  assert.deepEqual(res.errors, []);
  const calls = queries.filter((q) => q.path === '/api/v2/spot/trade/fills');
  assert.ok(calls.length >= 3);
  for (const q of calls) {
    assert.ok(Number(q.endTime) - Number(q.startTime) <= 7 * DAY);
  }
  assert.ok(calls.some((q) => q.idLessThan));
});

test('Bitget 现货：错误不再被静默吞掉', async () => {
  failNext = true;
  await assert.rejects(
    () => bitget.fetchSpotTrades({ creds, fromMs: NOW - DAY, toMs: NOW, limit: 100, symbols: ['BTCUSDT'] }),
    /boom|40001/,
  );
  failNext = false;
});

test.after(() => new Promise((resolve) => server.close(resolve)));
