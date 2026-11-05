import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADELEDGER_TZ = 'Asia/Shanghai';
process.env.DB_FILE = ':memory:';

const { openDb, setDb, closeDb } = await import('../src/db.js');
setDb(openDb(':memory:'));
const store = await import('../src/store.js');
const { filterTrades } = await import('../src/stats.js');

const at = (iso) => new Date(iso).toISOString();
const openOf = (closeIso) => at(new Date(new Date(closeIso).getTime() - 2 * 3600_000));

const rows = [
  // 上海 5/7 12:00
  { external_id: 'p:1', symbol: 'BTC/USDT', side: 'long', market: 'futures', order_type: 'limit', close_time: at('2026-05-07T04:00:00Z'), pnl: 10, notional: 100 },
  // 上海 5/8 00:30（跨 UTC 日界，必须算 5/8）
  { external_id: 'p:2', symbol: 'ETH/USDT', side: 'short', market: 'futures', order_type: 'market', close_time: at('2026-05-07T16:30:00Z'), pnl: -20, notional: 300 },
  // 上海 5/8 18:00
  { external_id: 'p:3', symbol: 'SOL/USDT', side: 'long', market: 'spot', order_type: 'market', close_time: at('2026-05-08T10:00:00Z'), pnl: 5, notional: 50 },
  // 上海 5/9 23:59
  { external_id: 'p:4', symbol: 'BTC/USDT', side: 'long', market: 'futures', order_type: 'limit', close_time: at('2026-05-09T15:59:00Z'), pnl: 7, notional: 200 },
  // 上海 5/10 00:00（不能算进 5/9）
  { external_id: 'p:5', symbol: 'ETH/USDT', side: 'short', market: 'spot', order_type: 'other', close_time: at('2026-05-09T16:00:00Z'), pnl: 0, notional: 80 },
  { external_id: 'p:6', symbol: 'DOGE/USDT', side: 'long', market: 'futures', order_type: 'limit', close_time: at('2026-05-08T12:00:00Z'), pnl: 3, notional: 40 },
  { external_id: 'p:7', symbol: 'BTC/USDT', side: 'short', market: 'futures', order_type: 'limit', close_time: at('2026-05-08T13:00:00Z'), pnl: -4, notional: 120 },
  { external_id: 'p:8', symbol: 'SOL/USDT', side: 'long', market: 'futures', order_type: 'market', close_time: at('2026-05-08T14:00:00Z'), pnl: 2, notional: 60 },
].map((r) => ({
  ...r,
  size: 1,
  entry_price: 100,
  exit_price: 100 + r.pnl,
  fee: 0,
  funding: 0,
  source: 'manual',
  open_time: openOf(r.close_time),
}));

const accountA = store.createAccount({ exchange: 'fake', name: 'A', apiKey: 'k', apiSecret: 's' });
const accountB = store.createAccount({ exchange: 'fake', name: 'B', apiKey: 'k', apiSecret: 's' });
store.importTrades(rows.slice(0, 6), accountA.id, { upsert: true });
store.importTrades(rows.slice(6), accountB.id, { upsert: true });

// 给不同行挂标签/笔记，覆盖 tag、note、q 三类筛选。
const all = store.listTrades();
const byExt = new Map(all.map((t) => [t.external_id, t]));
store.setTradeTags(byExt.get('p:1').id, ['alpha']);
store.setTradeTags(byExt.get('p:2').id, ['beta']);
store.setTradeTags(byExt.get('p:3').id, ['alpha', 'beta']);
store.setTradeTags(byExt.get('p:5').id, ['gamma']);
store.setTradeNote(byExt.get('p:1').id, '按计划执行');
store.setTradeNote(byExt.get('p:3').id, '收益 100% 达成');
store.setTradeNote(byExt.get('p:5').id, '观察中');

const legacyIds = (q) => filterTrades(store.listTrades(), q).map((t) => t.id);
const pagedIds = (q, limit = 1000, offset = 0) =>
  store.listTradesPage(q, { limit, offset }).map((t) => t.id);

const cases = [
  ['无条件', {}],
  ['账户过滤', { account_id: String(accountA.id) }],
  ['市场过滤', { market: 'spot' }],
  ['方向过滤', { side: 'short' }],
  ['盈利', { result: 'win' }],
  ['亏损', { result: 'loss' }],
  ['币种', { symbol: 'BTC/USDT' }],
  ['订单类型 limit', { orderType: 'limit' }],
  ['订单类型 other', { orderType: 'other' }],
  ['标签 alpha', { tag: 'alpha' }],
  ['有笔记', { note: 'yes' }],
  ['无笔记', { note: 'no' }],
  ['上海日 5/8', { from: '2026-05-08', to: '2026-05-08' }],
  ['ISO 输入换算本地日', { from: '2026-05-07T16:00:00.000Z', to: '2026-05-08T15:59:59.999Z' }],
  ['关键词命中币种', { q: 'eth' }],
  ['关键词命中笔记', { q: '计划' }],
  ['关键词命中标签', { q: 'bet' }],
  ['百分号按字面匹配', { q: '100%' }],
  ['排序 pnl', { sort: 'pnl' }],
  ['排序 duration', { sort: 'duration' }],
  ['排序 size', { sort: 'size' }],
  ['组合筛选', { account_id: String(accountA.id), market: 'futures', result: 'win', note: 'yes', sort: 'pnl' }],
];

test('SQL 分页与 stats.filterTrades 的筛选/排序结果逐项一致', () => {
  for (const [name, q] of cases) {
    const expected = legacyIds(q);
    assert.equal(store.countTradesFiltered(q), expected.length, `count 不一致：${name}`);
    assert.deepEqual(pagedIds(q), expected, `结果不一致：${name}`);
  }
});

test('分页边界：limit/offset 与内存切片的顺序一致', () => {
  const q = { sort: 'time' };
  const expected = legacyIds(q);
  assert.deepEqual(pagedIds(q, 3, 0), expected.slice(0, 3));
  assert.deepEqual(pagedIds(q, 3, 3), expected.slice(3, 6));
  assert.deepEqual(pagedIds(q, 3, 20), []);
});

test('列表页 symbol 下拉与复盘覆盖率走聚合查询', () => {
  assert.deepEqual(store.listTradeSymbols(accountA.id), ['BTC/USDT', 'DOGE/USDT', 'ETH/USDT', 'SOL/USDT']);
  const coverage = store.tradeNoteCoverage(accountA.id);
  assert.equal(coverage.total, 6);
  assert.equal(coverage.noted, 3);
  assert.equal(coverage.ratio, 3 / 6);
});

test('清理内存库', () => {
  closeDb();
});
