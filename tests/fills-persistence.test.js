import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const store = await import('../src/store.js');
const { syncAccount: runSync } = await import('../src/sync.js?fills-persistence-test');

// 假适配器：脚本化返回，模拟「回合跨同步批次」——
// 第一次同步只拉到开仓腿，第二次同步才拉到平仓腿。
const calls = [];
const DAY = 86400_000;
const openFills = [
  { id: 'f1', symbol: 'ETH/USDT', side: 'buy', price: 100, qty: 2, fee: -0.02, time: Date.parse('2026-09-01T00:00:00Z'), orderType: 'limit' },
  { id: 'f2', symbol: 'ETH/USDT', side: 'buy', price: 102, qty: 1, fee: -0.01, time: Date.parse('2026-09-02T00:00:00Z'), orderType: 'market' },
];
const closeFills = [
  { id: 'f3', symbol: 'ETH/USDT', side: 'sell', price: 110, qty: 3, fee: -0.03, time: Date.parse('2026-10-01T00:00:00Z'), orderType: 'market' },
];
const fake = {
  id: 'fake',
  name: 'Fake',
  maxLookbackDays: 90,
  returnsFills: true,
  episodeMatching: true,
  async verify() {},
  async fetchTrades({ fromMs }) {
    calls.push(fromMs);
    return {
      trades: [],
      fills: calls.length === 1 ? openFills : closeFills,
      nextCursor: null,
    };
  },
};

test('回合跨批次：持久化成交后全量重算，不再产生幻影', async () => {
  const acc = store.createAccount({ exchange: 'fake', name: 'FP', apiKey: 'k', apiSecret: 's' });
  // 预置一个旧逻辑会生成的幻影（只有平仓腿时被当成开空）
  store.importTrades([{
    external_id: 'fake:ep:phantom', symbol: 'ETH/USDT', side: 'short', order_type: 'market',
    size: 3, notional: 330, entry_price: 110, exit_price: 110,
    open_time: '2026-09-30T00:00:00.000Z', close_time: '2026-10-01T00:00:00.000Z',
    pnl: 0, fee: -0.03, funding: 0, source: 'api',
  }], acc.id, { upsert: true });

  // 第一次同步：回溯窗口内只有开仓腿 → 持久化成交但不导入半截回合；
  // 幻影清理在覆盖检查通过后的下一轮才执行
  await runSync(acc.id, { registry: { fake } });
  const afterFirst = store.listTrades().filter((t) => t.account_id === acc.id && t.symbol === 'ETH/USDT');
  assert.equal(afterFirst.length, 1, '本轮只有开仓腿：不导入半截回合，幻影留到下一轮清理');
  assert.equal(afterFirst[0].external_id, 'fake:ep:phantom');

  // 第二次同步（增量窗口只有平仓腿）→ 全量重算命中完整回合
  await runSync(acc.id, { registry: { fake } });
  const rows = store.listTrades().filter((t) => t.account_id === acc.id && t.symbol === 'ETH/USDT');
  assert.equal(rows.length, 1, '应恰好一个正确回合');
  const ep = rows[0];
  assert.equal(ep.side, 'long');
  assert.equal(Number(ep.size), 3);
  assert.ok(ep.external_id.startsWith('fake:ep:'), '回合 external_id 应为内容指纹');
  assert.ok(Math.abs(Number(ep.entry_price) - (2 * 100 + 1 * 102) / 3) < 1e-9, '开仓均价按成交加权');
  assert.ok(!store.listTrades().some((r) => r.external_id === 'fake:ep:phantom'), '幻影应被清理');

  // 成交覆盖水位已达到回溯起点
  const wm = Number(store.getMeta(`fills_from_${acc.id}`, '0'));
  assert.ok(wm > 0 && wm <= Date.now() - 90 * DAY + DAY, '覆盖下界应达到回溯窗口起点');
});
