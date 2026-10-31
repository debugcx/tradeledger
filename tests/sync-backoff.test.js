import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const { nextSyncDelay } = await import('../src/sync.js');
const store = await import('../src/store.js');

test('连续失败退避：前 4 次快速重试，第 5 次起改为 24 小时', () => {
  assert.equal(nextSyncDelay(1), 15_000);
  assert.equal(nextSyncDelay(2), 30_000);
  assert.equal(nextSyncDelay(3), 45_000);
  assert.equal(nextSyncDelay(4), 60_000);
  assert.equal(nextSyncDelay(5), 24 * 3600_000);
  assert.equal(nextSyncDelay(9), 24 * 3600_000);
});

test('失败状态持久化，重置账户时清零', () => {
  store.setSyncFail(42, { attempts: 5, nextAt: Date.now() + 3600_000 });
  assert.equal(store.getSyncFail(42).attempts, 5);
  store.setSyncFail(42, null);
  assert.equal(store.getSyncFail(42), null);

  const acc = store.createAccount({ exchange: 'fake-sync', name: 'R' });
  store.setSyncFail(acc.id, { attempts: 3, nextAt: Date.now() + 1000 });
  store.resetAccountSync(acc.id);
  assert.equal(store.getSyncFail(acc.id), null, '重置同步应清掉退避状态');
});
