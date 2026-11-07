import test from 'node:test';
import assert from 'node:assert/strict';

const { createLedgerCache } = await import('../src/ledger-cache.js');

test('月度账本缓存：TTL 内复用、过期重拉、force 刷新、账户隔离', async () => {
  let now = 0;
  const calls = [];
  const cache = createLedgerCache({ ttlMs: 1000, now: () => now });
  const adapter = {
    async fetchMonthlyLedger({ creds }) {
      calls.push(creds.id);
      return { months: [{ month: '2026-10', pnl: 1, fee: 0, fund: 0 }] };
    },
  };
  const accountA = { id: 1, exchange: 'okx' };
  const accountB = { id: 2, exchange: 'okx' };

  await cache.get(accountA, adapter, { id: 'a' });
  await cache.get(accountA, adapter, { id: 'a' });
  assert.deepEqual(calls, ['a'], 'TTL 内第二次应命中缓存');

  now = 1001;
  await cache.get(accountA, adapter, { id: 'a' });
  assert.deepEqual(calls, ['a', 'a'], '过期后应重新拉取');

  await cache.get(accountA, adapter, { id: 'a' }, { force: true });
  assert.equal(calls.length, 3, 'force 应绕过缓存');

  await cache.get(accountB, adapter, { id: 'b' });
  assert.equal(calls.length, 4, '账户之间不能串缓存');
  assert.equal(cache.size(), 2);

  cache.invalidate(1);
  await cache.get(accountA, adapter, { id: 'a' });
  assert.equal(calls.length, 5, 'invalidate 后应重新拉取');
});

test('月度账本缓存：失败不写入缓存', async () => {
  const cache = createLedgerCache({ ttlMs: 1000, now: () => 0 });
  let calls = 0;
  const adapter = {
    async fetchMonthlyLedger() {
      calls += 1;
      throw new Error('exchange down');
    },
  };
  await assert.rejects(() => cache.get({ id: 1, exchange: 'okx' }, adapter, {}), /exchange down/);
  await assert.rejects(() => cache.get({ id: 1, exchange: 'okx' }, adapter, {}), /exchange down/);
  assert.equal(calls, 2);
  assert.equal(cache.size(), 0);
});
