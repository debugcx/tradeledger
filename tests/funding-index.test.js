import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const dbmod = await import('../src/db.js');

test('资金费匹配索引存在且列顺序正确', () => {
  const db = dbmod.openDb(':memory:');
  try {
    const names = db.prepare('PRAGMA index_list(trades)').all().map((r) => r.name);
    assert.ok(names.includes('ix_trades_funding_match'), names.join(','));
    const cols = db.prepare('PRAGMA index_info(ix_trades_funding_match)').all().map((r) => r.name);
    assert.deepEqual(cols, ['account_id', 'symbol', 'open_time', 'close_time']);
    const partial = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_trades_funding_match'").get().sql;
    assert.match(partial, /WHERE trashed_at IS NULL/i);
  } finally {
    db.close();
  }
});
