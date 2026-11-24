import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;

// 模拟线上事故：不带 symbol 的 userTrades 恰好返回 1000 笔（BTC 552 + SOL 448），
// 同一时间窗内其实还有 ETHUSDC 448 笔，被整块挤掉。
const COUNTS = { BTCUSDT: 552, SOLUSDC: 448, ETHUSDC: 448 };
const ID_BASE = { BTCUSDT: 1_000_000, SOLUSDC: 2_000_000, ETHUSDC: 3_000_000 };

function rowsFor(symbol) {
  const n = COUNTS[symbol] || 0;
  return Array.from({ length: n }, (_, i) => ({
    id: ID_BASE[symbol] + i,
    symbol,
    side: i % 2 === 0 ? 'BUY' : 'SELL',
    price: '100',
    qty: '1',
    quoteQty: '100',
    commission: '0.01',
    commissionAsset: 'USDT',
    maker: i % 3 === 0,
    time: NOW - 6 * 3600_000 + i * 1000,
  }));
}

let mode = 'truncated'; // truncated：不带 symbol 返回 1000 笔；small：只返回 2 笔
let seen = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  seen.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/fapi/v1/time') return res.end(JSON.stringify({ serverTime: Date.now() }));
  if (url.pathname === '/fapi/v1/income') {
    return res.end(JSON.stringify([
      { symbol: 'BTCUSDT', incomeType: q.incomeType, income: '-0.1', time: NOW - 1000, tranId: 1 },
      { symbol: 'ETHUSDC', incomeType: q.incomeType, income: '-0.1', time: NOW - 2000, tranId: 2 },
      { symbol: 'SOLUSDC', incomeType: q.incomeType, income: '-0.1', time: NOW - 3000, tranId: 3 },
    ]));
  }
  if (url.pathname === '/fapi/v1/userTrades') {
    if (q.symbol) return res.end(JSON.stringify(rowsFor(q.symbol)));
    if (mode === 'truncated') return res.end(JSON.stringify([...rowsFor('BTCUSDT'), ...rowsFor('SOLUSDC')]));
    return res.end(JSON.stringify(rowsFor('BTCUSDT').slice(0, 2)));
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.BINANCE_FAPI_BASE = base;
process.env.BINANCE_DAPI_BASE = base;
process.env.BINANCE_SAPI_BASE = base;

const { binance } = await import('../src/exchanges/binance.js?binance-usdm-symbols-test');

const creds = { apiKey: 'k', apiSecret: 's' };
const range = () => ({ fromMs: NOW - 2 * DAY, toMs: NOW });

test('U 本位：不带 symbol 恰好 1000 笔时，改为逐标的拉取，ETHUSDC 不再丢失', async () => {
  mode = 'truncated';
  seen = [];
  const r = await binance.fetchTrades({ creds, ...range(), cursor: null, limit: 5000 });
  const count = (sym) => r.fills.filter((f) => f.symbol === sym).length;
  assert.equal(count('BTC/USDT'), 552);
  assert.equal(count('SOL/USDC'), 448);
  // 回归点：整块标的曾被 1000 笔上限挤掉
  assert.equal(count('ETH/USDC'), 448);
  // 先发现标的（income）再逐标的拉成交
  assert.ok(seen.some((s) => s.path === '/fapi/v1/income' && s.incomeType === 'COMMISSION'));
  assert.ok(seen.some((s) => s.path === '/fapi/v1/userTrades' && s.symbol === 'ETHUSDC'));
});

test('U 本位：未拿满 1000 笔时保持单次查询，不额外消耗 income', async () => {
  mode = 'small';
  seen = [];
  const r = await binance.fetchTrades({ creds, ...range(), cursor: null, limit: 5000 });
  assert.equal(r.fills.length, 2);
  assert.ok(!seen.some((s) => s.path === '/fapi/v1/income'));
  assert.ok(!seen.some((s) => s.path === '/fapi/v1/userTrades' && s.symbol));
});

test('U 本位：超出批次上限时保留最新成交，游标之前的更老成交留待下一批', async () => {
  mode = 'truncated';
  seen = [];
  const r = await binance.fetchTrades({ creds, ...range(), cursor: null, limit: 300 });
  assert.equal(r.fills.length, 300);
  assert.ok(r.nextCursor, '被截断时必须给出续拉游标');
  const cursorMs = Number(String(r.nextCursor).split('|').pop());
  assert.ok(Number.isFinite(cursorMs) && cursorMs > 0);
  for (const f of r.fills) assert.ok(f.time > cursorMs, `成交 ${f.time} 应晚于游标 ${cursorMs}`);
  // 保留的是最新 300 笔：最早保留项应晚于整体最早成交
  const allOldest = Math.min(...['BTCUSDT', 'SOLUSDC', 'ETHUSDC'].map((s) => rowsFor(s)[0].time));
  assert.ok(cursorMs >= allOldest, `游标应指向被截掉的旧成交区段，实际 ${cursorMs} < ${allOldest}`);
});

test.after(() => new Promise((r) => server.close(r)));
