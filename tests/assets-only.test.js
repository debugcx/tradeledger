import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

test('仅资产模式：不拉交易/现货/资金费，资金流水照常，同步立即完成', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { syncAccount } = await import('../src/sync.js');

  const account = store.createAccount({
    exchange: 'fake', name: '网格子账户', apiKey: 'k', apiSecret: 's', assetsOnly: 1,
  });
  assert.equal(store.getAccount(account.id).assets_only, 1);

  const calls = [];
  const fake = {
    async fetchTrades() { calls.push('trades'); return { trades: [{ external_id: 'x:1', symbol: 'BTC/USDT', side: 'long', size: 1, notional: 1, entry_price: 1, exit_price: 1, open_time: '2026-10-01T00:00:00Z', close_time: '2026-10-01T01:00:00Z', pnl: 0, fee: 0, funding: 0, source: 'api' }], nextCursor: null }; },
    async fetchSpotTrades() { calls.push('spot'); return { fills: [], nextCursor: null }; },
    async fetchTransfers() { calls.push('transfers'); return { transfers: [] }; },
    async fetchFunding() { calls.push('funding'); return { events: [] }; },
  };

  const r = await syncAccount(account.id, { registry: { fake } });
  assert.deepEqual(calls, ['transfers']);
  assert.equal(r.mode, 'assets_only');
  assert.equal(r.done, true);
  assert.equal(store.listTrades({ accountId: account.id }).length, 0);
  assert.ok(store.getAccount(account.id).last_transfer_sync_at, '资金流水同步时间应更新');

  // 编辑切换回普通模式后，交易拉取恢复
  store.updateAccount(account.id, { assetsOnly: 0 });
  assert.equal(store.getAccount(account.id).assets_only, 0);
  calls.length = 0;
  const r2 = await syncAccount(account.id, { registry: { fake } });
  assert.equal(calls.includes('trades'), true);
  assert.equal(r2.mode, 'incremental'); // 首次同步已置 sync_done，恢复后走增量
  assert.equal(store.listTrades({ accountId: account.id }).length, 1);

  // 再切回仅资产：undefined 之外的三态语义（编辑表单总是显式提交 0/1）
  store.updateAccount(account.id, { assetsOnly: 1 });
  assert.equal(store.getAccount(account.id).assets_only, 1);

  store.clearAllData();
  closeDb();
});
