import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/fapi/v1/time')) return res.end(JSON.stringify({ serverTime: Date.now() }));
  if (req.url.startsWith('/fapi/v1/userTrades')) {
    return res.end(JSON.stringify([
      { id: 1, symbol: 'BTCUSDT', side: 'BUY', price: '100', qty: '1', commission: '0.01', commissionAsset: 'USDT', maker: true, time: NOW - 3600_000 },
      { id: 2, symbol: 'BTCUSDT', side: 'SELL', price: '110', qty: '1', commission: '0.01', commissionAsset: 'USDT', maker: false, time: NOW - 1800_000 },
    ]));
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.BINANCE_FAPI_BASE = `http://127.0.0.1:${server.address().port}`;

const { binance } = await import('../src/exchanges/binance.js?binance-ot-test');

test('币安合约回合 order_type：maker 字段生效，挂吃混合 → mixed', async () => {
  const r = await binance.fetchTrades({
    creds: { apiKey: 'k', apiSecret: 's' },
    fromMs: NOW - 2 * DAY,
    toMs: NOW,
    cursor: null,
    limit: 100,
  });
  assert.equal(r.trades.length, 1);
  // 回归：toFill 里曾有两个 orderType 键，后者覆盖前者导致全部变成 other
  assert.equal(r.trades[0].order_type, 'mixed');
});

test.after(() => new Promise((r) => server.close(r)));
