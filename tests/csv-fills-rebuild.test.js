import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const store = await import('../src/store.js');
const { rebuildFromFills } = await import('../src/rebuild.js');

const T = (iso) => Date.parse(iso);
const fill = (id, symbol, side, price, qty, time, fee = -0.01, orderType = 'limit') => ({
  id, symbol, side, price, qty, fee, time: T(time), orderType,
});

test('CSV fills 跨文件配对：平仓文件后到也能补齐回合', () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'R1' });
  // 文件 A：开仓 + 部分平仓
  const fileA = [
    fill('a1', 'BTC/USDT', 'buy', 100, 2, '2026-09-01T00:00:00Z'),
    fill('a2', 'BTC/USDT', 'sell', 110, 1, '2026-09-02T00:00:00Z'),
  ];
  const r1 = rebuildFromFills(acc.id, fileA);
  assert.equal(r1.fills.inserted, 2);
  assert.equal(r1.trades.inserted, 1, '文件 A 自身配出一个部分平仓回合');
  let rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].size), 1);
  const partialId = rows[0].external_id;

  // 文件 B：剩余平仓腿（跨文件）
  const r2 = rebuildFromFills(acc.id, [fill('b1', 'BTC/USDT', 'sell', 120, 1, '2026-10-01T00:00:00Z')]);
  assert.equal(r2.fills.inserted, 1);
  assert.equal(r2.trades.inserted, 1, '新成交补齐出第二个回合');
  rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 2, '部分回合不因重算而消失（FIFO 配对单调）');
  assert.ok(rows.some((t) => t.external_id === partialId), '已配对回合的指纹保持稳定');

  // 重复导入文件 A：成交与回合全部幂等
  const r3 = rebuildFromFills(acc.id, fileA);
  assert.equal(r3.fills.inserted, 0, '成交按内容指纹去重');
  assert.equal(r3.trades.inserted, 0);
  assert.equal(r3.pruned, 0);
  assert.equal(store.listTrades({ accountId: acc.id }).length, 2);
});

test('乱序导入：后导入更早的开仓，FIFO 重排替换旧行且笔记迁移', () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'R2' });
  // 先导入：Sep2 开 1.0、Sep3 平 1.0 → 回合 A
  rebuildFromFills(acc.id, [
    fill('c1', 'ETH/USDT', 'buy', 40, 1, '2026-09-02T00:00:00Z'),
    fill('c2', 'ETH/USDT', 'sell', 50, 1, '2026-09-03T00:00:00Z'),
  ]);
  let rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 1);
  store.setTradeNote(rows[0].id, '需要复盘');

  // 再导入更早的开仓 2.0 @Sep1：FIFO 重排 → 旧回合指纹失效被清理，
  // 新回合 (Sep1→Sep3) 继承笔记
  const r2 = rebuildFromFills(acc.id, [fill('c0', 'ETH/USDT', 'buy', 40, 2, '2026-09-01T00:00:00Z')]);
  assert.ok(r2.pruned >= 1, '指纹失效的旧回合应被清理');
  rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'long');
  assert.ok(rows[0].open_time.startsWith('2026-09-01'), '新回合开仓时间对齐更早的成交');
  assert.equal(rows[0].note, '需要复盘', '笔记应迁移到新回合');

  // 重复导入后最终状态稳定
  rebuildFromFills(acc.id, [fill('c0', 'ETH/USDT', 'buy', 40, 2, '2026-09-01T00:00:00Z')]);
  assert.equal(store.listTrades({ accountId: acc.id }).length, 1);
});

test('与 API 同步通道隔离：CSV 成交不掺入同步重算，重叠回合按指纹去重', async () => {
  const acc = store.createAccount({ exchange: 'fake', name: 'R3', apiKey: 'k', apiSecret: 's' });
  const calls = [];
  const DAY = 86400_000;
  const { syncAccount: runSync } = await import('../src/sync.js?csv-fills-rebuild-test');
  const fake = {
    id: 'fake', name: 'Fake', maxLookbackDays: 90, returnsFills: true,
    async verify() {},
    async fetchTrades({ fromMs }) {
      calls.push(fromMs);
      return {
        trades: [],
        fills: [fill('f1', 'BTC/USDT', 'buy', 100, 1, '2026-10-01T00:00:00Z'), fill('f2', 'BTC/USDT', 'sell', 110, 1, '2026-10-02T00:00:00Z')],
        nextCursor: null,
      };
    },
  };

  // CSV 通道先导入同一时段的相同成交（内容与 API fills 完全一致）；
  // 前缀与同步通道对齐（exchange:'fake'），同指纹 → 同 external_id → 去重
  rebuildFromFills(acc.id, [
    fill('', 'BTC/USDT', 'buy', 100, 1, '2026-10-01T00:00:00Z'),
    fill('', 'BTC/USDT', 'sell', 110, 1, '2026-10-02T00:00:00Z'),
  ], { exchange: 'fake' });
  assert.equal(store.listTrades({ accountId: acc.id }).length, 1, 'CSV 通道配出一个回合');

  // 同步通道重算只配对自己的成交池：不因 CSV 池的存在而重复计数
  await runSync(acc.id, { registry: { fake } });
  await runSync(acc.id, { registry: { fake } });
  const rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 1, '同一回合只有一行（指纹一致去重），不会双倍');
  assert.equal(Number(rows[0].size), 1, '数量不被两路成交池放大');
  assert.ok(store.listTradeFillSymbols(acc.id, { exchange: 'fake' }).includes('BTC/USDT'), '同步通道池已建立');
});

test('同批内完全相同的成交按 :n 编号共存，不会丢量', () => {
  const acc = store.createAccount({ exchange: 'manual', name: 'R4' });
  // 同一毫秒同价同量的两笔拆单成交 + 一笔平仓
  const same = fill('d1', 'SOL/USDT', 'buy', 10, 1, '2026-09-01T00:00:00Z');
  const r = rebuildFromFills(acc.id, [same, { ...same, id: '' }, fill('d2', 'SOL/USDT', 'sell', 12, 2, '2026-09-02T00:00:00Z')]);
  assert.equal(r.fills.inserted, 3, '两笔相同成交都应落库');
  const rows = store.listTrades({ accountId: acc.id });
  // matchFills 语义：每个手数批次一条回合 → 两条 size=1 的回合（指纹相同按 :n 编号）
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((a, t) => a + Number(t.size), 0), 2, '配对总数量不被去重吞掉');
  assert.ok(new Set(rows.map((t) => t.external_id)).size === 2, '相同回合按编号共存而非互相覆盖');
});
