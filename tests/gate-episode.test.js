import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const { matchEpisodes } = await import('../src/fills.js');

test('matchEpisodes：开仓+加仓+分批平仓 = 一个回合，均价与盈亏按移动均价', () => {
  const trades = matchEpisodes([
    { symbol: 'ETH/USDT', side: 'buy', price: 100, qty: 10, fee: -0.1, time: 1000 },
    { symbol: 'ETH/USDT', side: 'buy', price: 110, qty: 20, fee: -0.2, time: 2000 },
    { symbol: 'ETH/USDT', side: 'sell', price: 105, qty: 15, fee: -0.15, time: 3000 },
    { symbol: 'ETH/USDT', side: 'sell', price: 120, qty: 15, fee: -0.15, time: 4000 },
  ], 'gate');
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.side, 'long');
  assert.equal(t.size, 30);
  assert.ok(Math.abs(t.entry_price - 3200 / 30) < 1e-9); // 加权开仓均价 106.667
  assert.equal(t.exit_price, 112.5); // 加权平仓均价
  // 减仓腿按当时移动均价：−25 + 200 = 175 毛利，再减 0.6 手续费
  assert.ok(Math.abs(t.pnl - 174.4) < 1e-9);
  assert.ok(Math.abs(t.fee + 0.6) < 1e-9);
  assert.equal(t.open_time, new Date(1000).toISOString());
  assert.equal(t.close_time, new Date(4000).toISOString());
});

test('matchEpisodes：清零后重开 = 独立回合；空头回合方向与盈亏正确', () => {
  const trades = matchEpisodes([
    { symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 1, fee: 0, time: 1000 },
    { symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: 0, time: 2000 },
    { symbol: 'BTC/USDT', side: 'sell', price: 50, qty: 5, fee: 0, time: 3000 }, // 开空
    { symbol: 'BTC/USDT', side: 'buy', price: 48, qty: 5, fee: 0, time: 4000 }, // 平空
    { symbol: 'BTC/USDT', side: 'buy', price: 60, qty: 2, fee: 0, time: 5000 }, // 新回合
    { symbol: 'BTC/USDT', side: 'sell', price: 61, qty: 2, fee: 0, time: 6000 },
  ], 'gate');
  assert.equal(trades.length, 3);
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].pnl, 10);
  const short = trades[1];
  assert.equal(short.side, 'short');
  assert.equal(short.pnl, 10); // (48 − 50) × 5 × (−1)
  assert.equal(trades[2].pnl, 2);
});

test('matchEpisodes：同腿穿越零轴时拆成两个回合，不丢数量', () => {
  const trades = matchEpisodes([
    { symbol: 'SOL/USDT', side: 'buy', price: 100, qty: 3, fee: 0, time: 1000 },
    { symbol: 'SOL/USDT', side: 'sell', price: 110, qty: 5, fee: 0, time: 2000 }, // 平 3 并反向开空 2
    { symbol: 'SOL/USDT', side: 'buy', price: 105, qty: 2, fee: 0, time: 3000 },
  ], 'gate');
  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, 'long');
  assert.ok(Math.abs(trades[0].pnl - 30) < 1e-9); // (110−100)×3
  assert.equal(trades[1].side, 'short');
  assert.ok(Math.abs(trades[1].pnl - 10) < 1e-9); // (105−110)×2×(−1)
});

test('matchEpisodes：全挂单回合 → limit', () => {
  const trades = matchEpisodes([
    { symbol: 'ETH/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1000, orderType: 'limit' },
    { symbol: 'ETH/USDT', side: 'buy', price: 101, qty: 1, fee: 0, time: 1500, orderType: 'limit' },
    { symbol: 'ETH/USDT', side: 'sell', price: 110, qty: 3, fee: 0, time: 2000, orderType: 'limit' },
  ], 'gate');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].order_type, 'limit');
});

test('matchEpisodes：吃挂混合回合 → mixed', () => {
  const trades = matchEpisodes([
    { symbol: 'SOL/USDT', side: 'buy', price: 100, qty: 3, fee: 0, time: 1000, orderType: 'limit' },
    { symbol: 'SOL/USDT', side: 'buy', price: 102, qty: 2, fee: 0, time: 1500, orderType: 'market' },
    { symbol: 'SOL/USDT', side: 'sell', price: 110, qty: 5, fee: 0, time: 2000, orderType: 'market' },
  ], 'gate');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].order_type, 'mixed');
});

/* ---------------- Gate 适配器：面值换算 + 回合 + K 线 + 成交明细 ---------------- */

const queries = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/v4/futures/usdt/contracts') {
    res.end(JSON.stringify([{ name: 'ETH_USDT', quanto_multiplier: '0.01' }]));
  } else if (url.pathname === '/api/v4/futures/usdt/my_trades') {
    if (q.limit === '100') {
      // fetchLedgerTrades 用来确定成交明细边界的请求：最老一条在 2026-09-01
      res.end(JSON.stringify([
        { id: 'f9', contract: 'ETH_USDT', size: '1', price: '100', fee: '0.01', create_time: String(Math.floor(new Date('2026-09-02T00:00:00Z') / 1000)) },
        { id: 'f8', contract: 'ETH_USDT', size: '1', price: '100', fee: '0.01', create_time: String(Math.floor(new Date('2026-09-01T00:00:00Z') / 1000)) },
      ]));
    } else {
      // 一个回合：买 13 张 + 买 18 张，卖 31 张（张 × 0.01 = 币）；fee 为正数（支出）
      res.end(JSON.stringify([
        { id: 'f1', contract: 'ETH_USDT', size: '13', price: '2690.29', fee: '0.03', create_time: '1000' },
        { id: 'f2', contract: 'ETH_USDT', size: '18', price: '2690.29', fee: '0.04', create_time: '1100' },
        { id: 'f3', contract: 'ETH_USDT', size: '-31', price: '2654.82', fee: '0.06', create_time: '2000' },
      ]));
    }
  } else if (url.pathname === '/api/v4/futures/usdt/account_book') {
    // 账本：pnl 为不含费盈亏；fee 为负数支出；text 带 ":流水ID" 后缀需清洗；按 from/to 过滤
    const inRange = (r) => Number(r.time) >= Number(q.from) && Number(r.time) <= Number(q.to);
    if (q.type === 'pnl') {
      res.end(JSON.stringify([
        { id: 'b1', time: '1782900000', change: '3.5', text: 'BTC_USDT:900001', balance: '0' },
        { id: 'b2', time: '1782900100', change: '2.5', text: 'BTC_USDT:900002', balance: '0' },
        { id: 'b3', time: '1782900200', change: '-1', text: 'LTC_USDT:900003', balance: '0' },
      ].filter(inRange)));
    } else if (q.type === 'fee') {
      res.end(JSON.stringify([
        { id: 'c1', time: '1782899900', change: '-0.3', text: 'BTC_USDT:900001', balance: '0' },
        { id: 'c2', time: '1782900200', change: '-0.2', text: 'LTC_USDT:900003', balance: '0' },
      ].filter(inRange)));
    } else {
      res.end(JSON.stringify([
        { id: 'd1', time: '1782900050', change: '0.01', text: 'BTC_USDT:900001', balance: '0' },
      ].filter(inRange)));
    }
  } else if (url.pathname === '/api/v4/futures/usdt/candlesticks') {
    // 实测返回对象数组（倒序）：{t 秒, c 收盘, h 最高, l 最低, o 开盘}；用当前时间附近的秒
    const nowSec = Math.floor(Date.now() / 1000);
    res.end(JSON.stringify([
      { t: nowSec - 60, v: '1', c: '102', h: '103', l: '99', o: '100' },
      { t: nowSec - 120, v: '1', c: '101', h: '102', l: '98', o: '100' },
    ]));
  } else {
    res.end(JSON.stringify([]));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.GATE_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { gate } = await import('../src/exchanges/gate.js?gate-episode-test');

test('Gate：张数按面值换算、回合合并成一条、K 线与成交明细可用', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's' };
    const { trades } = await gate.fetchTrades({ creds, fromMs: 0, toMs: 10_000, limit: 1000 });
    assert.equal(trades.length, 1); // 三笔成交 = 一个回合
    const t = trades[0];
    assert.equal(t.symbol, 'ETH/USDT');
    assert.equal(t.size, 0.31); // 31 张 × 0.01 ETH
    assert.equal(t.entry_price, 2690.29);
    assert.equal(t.exit_price, 2654.82);
    // (2654.82 − 2690.29) × 0.31 − 0.13 手续费
    assert.ok(Math.abs(t.pnl - ((2654.82 - 2690.29) * 0.31 - 0.13)) < 1e-9);

    const recentFrom = Date.now() - 5 * 60_000;
    const candles = await gate.fetchCandles({ creds, symbol: 'ETH/USDT', fromMs: recentFrom, toMs: Date.now() + 1000 });
    assert.equal(candles.bar, '1m');
    assert.equal(candles.candles.length, 2);
    assert.ok(candles.candles[0].t < candles.candles[1].t); // 升序
    assert.equal(candles.candles[0].c, 101); // 收盘在字段 c

    const fills = await gate.fetchEpisodeFills({ creds, symbol: 'ETH/USDT', fromMs: 0, toMs: 10_000 });
    assert.equal(fills.fills.length, 3);
    assert.equal(fills.fills[0].qty, 0.13); // 面值换算后的逐笔数量
    assert.equal(fills.fills[2].side, 'sell');
    assert.equal(fills.fills[0].fee, -0.03); // 正数支出归一化为负

    // 资金费：按 29 天窗口分窗请求（账本接口 30 天跨度限制），时间按窗口过滤
    const funding = await gate.fetchFunding({
      creds, fromMs: Date.parse('2026-06-01T00:00:00Z'), toMs: Date.parse('2026-08-01T00:00:00Z'),
    });
    assert.equal(funding.events.length, 1);
    assert.equal(funding.events[0].symbol, 'BTC/USDT');

    // 账本回填：成交明细边界(2026-09-01)之前的 pnl/fee 按合约×日聚合
    const ledger = await gate.fetchLedgerTrades({
      creds, fromMs: Date.parse('2026-06-01T00:00:00Z'), toMs: Date.now(),
    });
    assert.equal(ledger.trades.length, 2);
    const btc = ledger.trades.find((t) => t.symbol === 'BTC/USDT');
    assert.ok(btc);
    assert.equal(btc.pnl, 5.7); // 3.5 + 2.5 − 0.3 费
    assert.equal(btc.fee, -0.3);
    assert.ok(btc.external_id.startsWith('gate:ledger:2026-'));
    assert.ok(!btc.external_id.includes(':900001')); // text 的流水ID后缀已剥掉
    assert.equal(btc.symbol, 'BTC/USDT'); // 交易对名不含后缀
    assert.deepEqual(btc.tags, ['账本回填']);
    assert.ok(btc.note.includes('账本回填'));
    // 时间戳用账本真实首末条（fee c1 更早 → open；pnl b2 最后 → close）
    assert.equal(btc.open_time, new Date(1782899900 * 1000).toISOString());
    assert.equal(btc.close_time, new Date(1782900100 * 1000).toISOString());
    const ltc = ledger.trades.find((t) => t.symbol === 'LTC/USDT');
    assert.equal(ltc.pnl, -1.2); // −1 − 0.2
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
