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

test('CSV 流式导出与整体导出内容/顺序一致', async () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'STREAM' });
  store.importTrades([
    trade({ external_id: 's1', close_time: '2026-11-01T01:00:00.000Z', pnl: 5, tags: ['甲'], note: '第一笔' }),
    trade({ external_id: 's2', close_time: '2026-11-02T01:00:00.000Z', pnl: -3, tags: ['乙'], note: '含,逗号' }),
    trade({ external_id: 's3', close_time: '2026-11-03T01:00:00.000Z', pnl: 8, tags: [], note: '' }),
  ], acc.id);
  const query = { account_id: String(acc.id) };
  const whole = store.exportTradesCsv(query);
  const chunks = [];
  for await (const line of store.exportTradesCsvChunks(query)) chunks.push(line);
  assert.equal(chunks.join('\n'), whole);

  // 非时间排序走旧实现回退，顺序也必须一致。
  const pnlWhole = store.exportTradesCsv({ ...query, sort: 'pnl' });
  const pnlChunks = [];
  for await (const line of store.exportTradesCsvChunks({ ...query, sort: 'pnl' })) pnlChunks.push(line);
  assert.equal(pnlChunks.join('\n'), pnlWhole);
});

test('JSON 流式导出可解析，交易数量/顺序与整体导出一致', async () => {
  const whole = store.exportAll();
  const chunks = [];
  for await (const chunk of store.exportAllJsonChunks()) chunks.push(chunk);
  const parsed = JSON.parse(chunks.join(''));
  assert.equal(parsed.trades.length, whole.trades.length);
  assert.deepEqual(parsed.trades.map((t) => t.id), whole.trades.map((t) => t.id));
  assert.equal(parsed.accounts.length, whole.accounts.length);
  assert.ok(Array.isArray(parsed.tags));
  assert.ok(Array.isArray(parsed.transfers));
});
