import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const store = await import('../src/store.js');
const { analyze } = await import('../src/stats.js');
const { missedRr } = store;

test('错过交易：CRUD + 假想盈亏比 + 状态校验', () => {
  const id = store.createMissedTrade({
    symbol: 'btc/usdt', direction: 'long',
    entryPrice: 100, stopPrice: 95, targetPrice: 115, note: '等回踩没等到',
  });
  const [row] = store.listMissedTrades();
  assert.equal(row.symbol, 'BTC/USDT', '币种应大写归一');
  assert.equal(row.status, 'open');
  assert.equal(row.statusLabel, '观察中');
  assert.ok(Math.abs(row.rr - 3) < 1e-9, '目标 15 / 止损 5 = 3R');

  assert.equal(missedRr({ direction: 'long', entry_price: 100, stop_price: 100, target_price: 120 }), null, '止损距离为 0 时不可算');
  assert.equal(missedRr({ direction: 'long', entry_price: 100, stop_price: 95, target_price: null }), null, '缺目标价不可算');

  store.setMissedTradeStatus(id, 'win');
  assert.equal(store.listMissedTrades()[0].status, 'win');
  assert.throws(() => store.setMissedTradeStatus(id, 'whatever'), /未知状态/);

  store.deleteMissedTrade(id);
  assert.equal(store.listMissedTrades().length, 0);
});

test('纪律聚合：按计划 / 违反计划的笔数、胜率、盈亏', () => {
  const mk = (pnl, plan, closeIso) => ({
    symbol: 'ETH/USDT', side: 'long', order_type: 'limit', size: 1, notional: 1000,
    entry_price: 100, exit_price: 100 + pnl,
    open_time: new Date(Date.parse(closeIso) - 3600_000).toISOString(),
    close_time: closeIso, pnl, fee: 0, funding: 0, followed_plan: plan, tags: [], note: null,
  });
  const trades = [
    mk(50, 1, '2026-09-01T08:00:00Z'),
    mk(30, 1, '2026-09-02T08:00:00Z'),
    mk(-10, 0, '2026-09-03T08:00:00Z'),
    mk(-20, 0, '2026-09-04T08:00:00Z'),
    mk(5, null, '2026-09-05T08:00:00Z'),
  ];
  const s = analyze(trades);
  assert.equal(s.adherence.marked, 4, '未标记的不计入');
  assert.equal(s.adherence.planned.count, 2);
  assert.equal(s.adherence.violated.count, 2);
  assert.ok(Math.abs(s.adherence.planned.pnl - 80) < 1e-9);
  assert.ok(Math.abs(s.adherence.violated.pnl - (-30)) < 1e-9);
  assert.ok(Math.abs(s.adherence.planned.winRate - 1) < 1e-9);
});
