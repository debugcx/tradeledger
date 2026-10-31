import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const H = 3600_000;

test('matchSpotRounds：反T（先卖后买回）闭环记为一条 t_shot', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 0.5, fee: -0.2, time: 2 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 0.5, fee: -0.1, time: 4 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.kind, 't_shot');
  assert.equal(t.side, 'short');
  assert.equal(t.size, 0.5);
  assert.equal(t.entry_price, 110);
  assert.equal(t.exit_price, 105);
  // pnl = (105 - 110) × 0.5 × (-1) + (-0.2) + (-0.1) = 2.2
  assert.ok(Math.abs(t.pnl - 2.2) < 1e-9);
  assert.ok(t.external_id.startsWith('spot:test:t:'));
});

test('matchSpotRounds：正T（先买后卖出）闭环，且不消耗底仓', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'ETH/USDT', side: 'buy', price: 100, qty: 1, fee: 0, time: 1 * H },
    { id: 'b1', symbol: 'ETH/USDT', side: 'buy', price: 200, qty: 0.3, fee: -0.1, time: 2 * H },
    { id: 's1', symbol: 'ETH/USDT', side: 'sell', price: 210, qty: 0.3, fee: -0.1, time: 3 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.kind, 't_shot');
  assert.equal(t.side, 'long');
  assert.equal(t.entry_price, 200);
  assert.equal(t.exit_price, 210);
  // pnl = (210 - 200) × 0.3 - 0.2 = 2.8；底仓 b0 只剩开仓批次，不产生交易
  assert.ok(Math.abs(t.pnl - 2.8) < 1e-9);
});

test('matchSpotRounds：多腿买回聚合为一条 T 记录（加权平仓价）', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: 0, time: 2 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 108, qty: 0.4, fee: 0, time: 3 * H },
    { id: 'b2', symbol: 'BTC/USDT', side: 'buy', price: 106, qty: 0.6, fee: 0, time: 4 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, 't_shot');
  assert.equal(trades[0].size, 1);
  // exit = 0.4×108 + 0.6×106 = 106.8
  assert.ok(Math.abs(trades[0].exit_price - 106.8) < 1e-9);
});

test('matchSpotRounds：超过窗口不记 T，回退 FIFO 配对', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 0.5, fee: 0, time: 1 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 0.5, fee: 0, time: 27 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, undefined);
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].entry_price, 100);
  assert.equal(trades[0].exit_price, 110);
  assert.equal(trades[0].size, 0.5);
});

test('matchSpotRounds：部分买回不算 T（视为加仓），整腿回 FIFO', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: 0, time: 1 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 108, qty: 0.4, fee: 0, time: 3 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, undefined);
  assert.equal(trades[0].size, 1);
  assert.equal(trades[0].entry_price, 100);
});

test('matchSpotRounds：清仓后重新买入不算做T', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 1, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: 0, time: 2 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 1, fee: 0, time: 3 * H },
  ];
  const trades = matchSpotRounds(fills, 'spot:test');
  // s1 平掉 b0 的批次（清仓，posAfter=0），b1 开新批次无交易
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, undefined);
  assert.equal(trades[0].entry_price, 100);
  assert.equal(trades[0].exit_price, 110);
});

test('matchSpotRounds：同一批数据重复配对得到相同 external_id', async () => {
  const { matchSpotRounds } = await import('../src/fills.js');
  const fills = [
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1 * H },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 0.5, fee: 0, time: 1 * H },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 0.5, fee: 0, time: 2 * H },
  ];
  const a = matchSpotRounds(fills, 'spot:test');
  const b = matchSpotRounds([...fills], 'spot:test');
  assert.deepEqual(a.map((t) => t.external_id).sort(), b.map((t) => t.external_id).sort());
});

test('现货 T 回合：重算幂等、旧记录清理、笔记归档与自动日志', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');

  const account = store.createAccount({ exchange: 'fake', name: 'S', apiKey: 'k', apiSecret: 's' });
  const day = (h) => Date.parse('2026-10-01T00:00:00Z') + h * H;

  // 第一步：只有底仓 + 卖出（旧口径下产生一条逐手配对记录）
  store.insertSpotFills([
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: day(0) },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 0.5, fee: 0, time: day(1) },
  ], account.id);
  store.recomputeSpotCostBasis(account.id);
  let r = store.recomputeSpotTrades(account.id, 'fake');
  assert.equal(r.trades, 1);
  let trades = store.listTrades();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].market, 'spot');
  assert.equal(trades[0].kind, null);

  // 给旧记录写复盘笔记
  store.setTradeNote(trades[0].id, '这次卖飞了');

  // 第二步：补上买回 → 卖出与买回闭环成 T 回合，旧逐手记录被取代
  store.insertSpotFills([
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 0.5, fee: 0, time: day(3) },
  ], account.id);
  store.recomputeSpotCostBasis(account.id);
  r = store.recomputeSpotTrades(account.id, 'fake');
  assert.equal(r.pruned, 1);

  trades = store.listTrades();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].kind, 't_shot');
  assert.equal(trades[0].side, 'short');
  assert.equal(trades[0].entry_price, 110);
  assert.equal(trades[0].exit_price, 105);

  // 旧笔记归档到交易对档案，不丢内容
  const archive = store.getNoteByCategory('symbol', 'BTC/USDT');
  assert.ok(archive, '应自动建立交易对档案');
  assert.ok(archive.content.includes('卖飞了'));

  // 新 T 回合自动写一条持仓日志
  let log = store.listSpotLogBySymbol('BTC/USDT');
  assert.equal(log.length, 1);
  assert.equal(log[0].source, 'auto');
  assert.equal(log[0].trade_id, trades[0].id);
  assert.ok(log[0].text.includes('做T'));

  // 手动日志增删
  const logId = store.addSpotLog({ accountId: account.id, symbol: 'BTC/USDT', text: '回补在支撑位' });
  assert.equal(store.listSpotLogBySymbol('BTC/USDT').length, 2);
  store.deleteSpotLog(logId);
  assert.equal(store.listSpotLogBySymbol('BTC/USDT').length, 1);

  // 幂等：再跑一次，交易集合与日志都不变
  const beforeIds = store.listTrades().map((t) => t.external_id).sort();
  store.recomputeSpotTrades(account.id, 'fake');
  assert.deepEqual(store.listTrades().map((t) => t.external_id).sort(), beforeIds);
  assert.equal(store.listSpotLogBySymbol('BTC/USDT').length, 1);

  store.clearAllData();
  closeDb();
});
