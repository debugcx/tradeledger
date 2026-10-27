import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const store = await import('../src/store.js');

const trade = (over = {}) => ({
  external_id: 'e1',
  symbol: 'BTC/USDT',
  side: 'long',
  order_type: 'market',
  size: 1,
  notional: 100,
  entry_price: 100,
  exit_price: 110,
  open_time: '2026-10-01T00:00:00.000Z',
  close_time: '2026-10-01T08:00:00.000Z',
  pnl: 10,
  fee: -1,
  funding: 0,
  source: 'api',
  ...over,
});

test('CSV 导出：公式前缀被中和，标签与备注保留原值', () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'CSV' });
  store.importTrades([trade({ note: '=cmd|calc', tags: ['=tag', '正常'] })], acc.id);
  const csv = store.exportTradesCsv();
  assert.ok(csv.includes("'=cmd|calc"), '备注的公式前缀应加单引号');
  assert.ok(csv.includes("'=tag"), '标签的公式前缀应加单引号');
  assert.ok(csv.includes('正常'));
  assert.ok(!/,=cmd/.test(csv), '不应出现未中和的公式单元格');
});

test('轻量计数：按来源/时间区间统计', () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'CNT' });
  store.importTrades([
    trade({ external_id: 'c1', source: 'api', close_time: '2026-09-30T00:00:00.000Z' }),
    trade({ external_id: 'c2', source: 'csv', close_time: '2026-10-02T00:00:00.000Z' }),
  ], acc.id);
  assert.equal(store.countTradesBySource('csv'), 1);
  assert.equal(store.countTradesBySource('api'), 2); // 本文件前一用例的 1 笔 + c1
  assert.equal(store.countTradesBetween('2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'), 1);
  assert.equal(store.countTradesBetween('2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z'), 2);
});
