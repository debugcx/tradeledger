import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const trade = (overrides = {}) => ({
  symbol: 'BTC/USDT',
  side: 'long',
  order_type: 'market',
  size: 1,
  notional: 100,
  entry_price: 100,
  exit_price: 110,
  open_time: '2026-10-01T00:00:00.000Z',
  close_time: '2026-10-01T02:00:00.000Z',
  pnl: 10,
  fee: 0,
  funding: 0,
  source: 'api',
  ...overrides,
});

test('垃圾箱：软删除后不参与统计、同步不导回、可恢复', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');

  const account = store.createAccount({ exchange: 'fake', name: 'T', apiKey: 'k', apiSecret: 's' });
  const accId = account.id;
  const res = store.importTrades([
    trade({ external_id: 'x:1', symbol: 'BTC/USDT', pnl: 10 }),
    trade({ external_id: 'x:2', symbol: 'ETH/USDT', pnl: -50, close_time: '2026-10-02T00:00:00.000Z' }),
    trade({ external_id: 'x:3', symbol: 'SOL/USDT', pnl: 5 }),
  ], accId, { upsert: true });
  assert.equal(res.inserted, 3);

  // 给 ETH 那条挂标签和笔记，验证恢复时一起回来
  const eth = store.listTrades().find((t) => t.external_id === 'x:2');
  store.setTradeTags(eth.id, ['误操作']);
  store.setTradeNote(eth.id, '手滑多开的');

  // 移入垃圾箱：立即从统计与列表消失
  store.trashTrade(eth.id);
  assert.equal(store.listTrades().length, 2);
  assert.equal(store.countTrades(), 2);
  assert.equal(store.countTrashedTrades(), 1);
  assert.ok(!store.listTrades().some((t) => t.external_id === 'x:2'));
  assert.ok(!store.listReviewQueue({ threshold: 0 }).some((t) => t.external_id === 'x:2'));

  // 同步再次带回同 external_id：按「已存在」跳过，不会复活
  const again = store.importTrades([trade({ external_id: 'x:2', pnl: -50 })], accId, { upsert: true });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 1);
  assert.equal(store.listTrades().length, 2);

  // 幻影清理不碰垃圾箱行
  assert.equal(store.pruneTradesNotIn(accId, 'x', 'BTC/USDT', ['x:1']), 0);

  // 垃圾箱列表里能看到
  const trashed = store.listTrashedTrades();
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].external_id, 'x:2');
  assert.ok(trashed[0].trashed_at);

  // 恢复：标签、笔记原样回来
  store.restoreTrade(eth.id);
  const restored = store.getTrade(eth.id);
  assert.equal(restored.trashed_at, null);
  assert.deepEqual(restored.tags, ['误操作']);
  assert.equal(restored.note, '手滑多开的');
  assert.equal(store.listTrades().length, 3);
  assert.equal(store.countTrashedTrades(), 0);

  // 恢复后再同步：正常 upsert 回写
  const upd = store.importTrades([trade({ external_id: 'x:2', pnl: -50 })], accId, { upsert: true });
  assert.equal(upd.updated, 1);

  // 彻底删除：真的移除；同 external_id 再来会作为新记录导入（硬删除的固有行为）
  store.deleteTrade(eth.id);
  assert.equal(store.listTrades().length, 2);
  const rein = store.importTrades([trade({ external_id: 'x:2', pnl: -50 })], accId, { upsert: true });
  assert.equal(rein.inserted, 1);

  store.clearAllData();
  closeDb();
});

test('垃圾箱：现货重算不清理垃圾箱行，同步跳过被扔掉的 T 回合', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { remainingLots } = await import('../src/fills.js');

  const account = store.createAccount({ exchange: 'fake', name: 'S', apiKey: 'k', apiSecret: 's' });
  const accId = account.id;
  const H = 3600_000;
  const day = (h) => Date.parse('2026-10-01T00:00:00Z') + h * H;

  // 底仓 + 反T 闭环 → 一条 t_shot
  store.insertSpotFills([
    { id: 'b0', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: day(1) },
    { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 0.5, fee: 0, time: day(2) },
    { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 105, qty: 0.5, fee: 0, time: day(4) },
  ], accId);
  store.recomputeSpotCostBasis(accId);
  const r = store.recomputeSpotTrades(accId, 'fake');
  assert.equal(r.trades, 1);

  const tshot = store.listTrades().find((t) => t.kind === 't_shot');
  assert.ok(tshot, '应产生 T 回合记录');

  // 用户把这条 T 回合扔进垃圾箱
  store.trashTrade(tshot.id);
  assert.equal(store.listTrades().length, 0);

  // 再次重算（幂等场景）：垃圾箱行不参与清理，也不会被复活
  const r2 = store.recomputeSpotTrades(accId, 'fake');
  assert.equal(r2.pruned, 0);
  assert.equal(store.listTrades().length, 0);
  assert.equal(store.listTrashedTrades().length, 1);
  assert.ok(store.getTrade(tshot.id).trashed_at, '垃圾箱行应原样保留');

  // 恢复后重算仍然幂等
  store.restoreTrade(tshot.id);
  store.recomputeSpotTrades(accId, 'fake');
  assert.equal(store.listTrades().length, 1);

  // 现货持仓不受垃圾箱影响：底仓批次仍在
  const rows = store.listAllSpotFills(accId).map((x) => ({
    symbol: x.symbol, side: x.side, price: x.price, qty: x.qty, time: Date.parse(x.time),
  }));
  const lots = remainingLots(rows);
  assert.equal(lots[0].quantity, 2);

  store.clearAllData();
  closeDb();
});

test('垃圾箱：关键词搜索覆盖币种/备注/账户名，通配符按字面匹配', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');

  const account = store.createAccount({ exchange: 'fake', name: '搜索专用账户', apiKey: 'k', apiSecret: 's' });
  store.importTrades([
    trade({ external_id: 's:1', symbol: 'BTC/USDT' }),
    trade({ external_id: 's:2', symbol: 'ETH/USDT' }),
    trade({ external_id: 's:3', symbol: 'SOL/USDT' }),
  ], account.id, { upsert: true });
  const eth = store.listTrades().find((t) => t.external_id === 's:2');
  store.setTradeNote(eth.id, '手滑多开的');
  for (const t of store.listTrades()) store.trashTrade(t.id);
  assert.equal(store.countTrashedTrades(), 3);

  // 无关键词：行为不变（受展示上限约束）
  assert.equal(store.listTrashedTrades().length, 3);
  // 按币种，大小写不敏感
  const bySymbol = store.listTrashedTrades({ q: 'eth' });
  assert.equal(bySymbol.length, 1);
  assert.equal(bySymbol[0].external_id, 's:2');
  // 按备注
  assert.equal(store.listTrashedTrades({ q: '手滑' }).length, 1);
  // 按账户名
  assert.equal(store.listTrashedTrades({ q: '搜索专用账户' }).length, 3);
  // 无匹配
  assert.equal(store.listTrashedTrades({ q: '不存在' }).length, 0);
  // LIKE 通配符按字面处理：% 不应变成「匹配一切」
  assert.equal(store.listTrashedTrades({ q: '%' }).length, 0);

  store.clearAllData();
  closeDb();
});
