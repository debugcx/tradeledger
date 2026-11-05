import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TRADELEDGER_TZ = 'Asia/Shanghai';
process.env.DB_FILE = ':memory:';

const { openDb, setDb, closeDb } = await import('../src/db.js');
setDb(openDb(':memory:'));
const store = await import('../src/store.js');
const { analyzeCachedLazy, localDayStartUtc } = await import('../src/stats.js');

const account = store.createAccount({ exchange: 'fake', name: 'A', apiKey: 'k', apiSecret: 's' });
const other = store.createAccount({ exchange: 'fake', name: 'B', apiKey: 'k', apiSecret: 's' });
const mk = (ext, close) => ({
  external_id: ext,
  symbol: 'BTC/USDT',
  side: 'long',
  order_type: 'market',
  size: 1,
  notional: 100,
  entry_price: 100,
  exit_price: 110,
  open_time: new Date(new Date(close).getTime() - 3600_000).toISOString(),
  close_time: close,
  pnl: 10,
  fee: 0,
  funding: 0,
  source: 'manual',
});
store.importTrades([
  mk('r:1', '2026-05-15T04:00:00.000Z'), // 上海 5/15
  mk('r:2', '2026-05-31T15:59:00.000Z'), // 上海 5/31 23:59
  mk('r:3', '2026-05-31T16:00:00.000Z'), // 上海 6/1 00:00
], account.id, { upsert: true });
store.importTrades([mk('r:4', '2026-05-20T04:00:00.000Z')], other.id, { upsert: true });

test('listTradesBetween：按业务时区取月区间，UTC 日界不会把 6/1 算进 5 月', () => {
  const start = localDayStartUtc('2026-05-01');
  const end = localDayStartUtc('2026-06-01');
  const rows = store.listTradesBetween(
    start.toISOString(),
    new Date(end.getTime() - 1).toISOString(),
    { accountId: account.id },
  );
  assert.deepEqual(rows.map((r) => r.external_id).sort(), ['r:1', 'r:2']);
  assert.equal(store.countTradesBetween(
    start.toISOString(),
    new Date(end.getTime() - 1).toISOString(),
    { accountId: account.id },
  ), 2);
});

test('listTradesBetween：账户过滤不会串账户', () => {
  const rows = store.listTradesBetween(
    '2026-05-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
    { accountId: other.id },
  );
  assert.deepEqual(rows.map((r) => r.external_id), ['r:4']);
});

test('analyzeCachedLazy：缓存命中时不执行全量加载', () => {
  let loads = 0;
  const loader = () => { loads += 1; return store.listTrades(); };
  const first = analyzeCachedLazy('test-version', 'lazy-test', loader);
  const second = analyzeCachedLazy('test-version', 'lazy-test', loader);
  assert.equal(loads, 1);
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
  analyzeCachedLazy('test-version-2', 'lazy-test', loader);
  assert.equal(loads, 2);
});

test('清理内存库', () => {
  closeDb();
});
