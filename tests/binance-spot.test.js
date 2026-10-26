import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;
const queries = [];

function row(id, { time, isBuyer = false, isMaker = false } = {}) {
  return {
    symbol: 'BNBUSDT',
    id,
    price: '600',
    qty: '1',
    quoteQty: '600',
    commission: '0.001',
    commissionAsset: 'BNB',
    time,
    isBuyer,
    isMaker,
  };
}

// 深回溯分页：第一页 1000 笔，第二页 2 笔
const deepPage1 = Array.from({ length: 1000 }, (_, i) => row(i + 1, { time: NOW - 400 * DAY + i }));
const deepPage2 = [row(1001, { time: NOW - 300 * DAY, isBuyer: true, isMaker: true }), row(1002, { time: NOW - 299 * DAY, isBuyer: true })];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/fapi/v1/time') return res.end(JSON.stringify({ serverTime: Date.now() }));
  if (url.pathname === '/api/v3/account') {
    return res.end(JSON.stringify({ balances: [{ asset: 'BNB', free: '1', locked: '0' }] }));
  }
  if (url.pathname === '/api/v3/myTrades') {
    if (q.fromId !== undefined) {
      return res.end(JSON.stringify(Number(q.fromId) === 0 ? deepPage1 : deepPage2));
    }
    // 最近窗口：返回一笔 maker 买入
    return res.end(JSON.stringify([row(2001, { time: NOW - 3600_000, isBuyer: true, isMaker: true })]));
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.BINANCE_FAPI_BASE = base;
process.env.BINANCE_SAPI_BASE = base;

let mod;
test.before(async () => {
  mod = await import('../src/exchanges/binance.js?binance-spot-test');
});

test('现货深回溯：fromId=0 升序翻页，并按时间范围过滤', async () => {
  queries.length = 0;
  const res = await mod.binance.fetchSpotTrades({
    creds: { apiKey: 'k', apiSecret: 's' },
    fromMs: NOW - 500 * DAY,
    toMs: NOW,
    limit: 5000,
    symbols: ['BNBUSDT'],
  });
  assert.equal(res.fills.length, 1002);
  assert.deepEqual(res.errors, []);
  const pages = queries.filter((q) => q.path === '/api/v3/myTrades');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].fromId, '0');
  assert.equal(pages[1].fromId, '1000');
  assert.equal(pages[0].startTime, undefined);
});

test('现货方向与挂单类型：isBuyer/isMaker 映射正确', async () => {
  queries.length = 0;
  const res = await mod.binance.fetchSpotTrades({
    creds: { apiKey: 'k', apiSecret: 's' },
    fromMs: NOW - 2 * DAY,
    toMs: NOW,
    limit: 100,
    symbols: ['BNBUSDT'],
  });
  const [fill] = res.fills;
  assert.equal(fill.side, 'buy');
  assert.equal(fill.orderType, 'limit');
  const [page] = queries.filter((q) => q.path === '/api/v3/myTrades');
  assert.equal(page.fromId, undefined);
  assert.equal(page.symbol, 'BNBUSDT');
  assert.ok(Number(page.endTime) - Number(page.startTime) <= 24 * 3600_000);
});

test('时间范围过滤：窗口外的成交被丢弃', async () => {
  const res = await mod.binance.fetchSpotTrades({
    creds: { apiKey: 'k', apiSecret: 's' },
    fromMs: NOW - 1000 * DAY,
    toMs: NOW - 350 * DAY,
    limit: 5000,
    symbols: ['BNBUSDT'],
  });
  // 第一页 1000 笔全部早于窗口上界（NOW-400d 起），第二页在新窗口内 → 时间过滤只保留早期部分
  assert.ok(res.fills.every((f) => f.time <= NOW - 350 * DAY));
  assert.equal(res.fills.length, 1000);
});

test.after(() => new Promise((resolve) => server.close(resolve)));
