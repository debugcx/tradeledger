import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../src/db.js');

const versionsOf = (db) => db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();

test('全新库：记录 baseline + legacy-repair，schema_version 同步为 7', () => {
  const db = dbmod.openDb(':memory:');
  try {
    const versions = versionsOf(db);
    assert.deepEqual(versions.map((r) => r.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(versions[0].name, 'baseline');
    assert.equal(versions[1].name, 'legacy-repair');
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(meta.value, '7');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 7);
  } finally {
    db.close();
  }
});

test('文件库重复打开：迁移记录不重复，schemaVersion() 可读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-migrate-'));
  const file = path.join(dir, 'test.db');
  try {
    dbmod.openDb(file).close();
    const db = dbmod.openDb(file);
    dbmod.setDb(db);
    try {
      assert.equal(versionsOf(db).length, 7);
      assert.equal(dbmod.schemaVersion(), 7);
    } finally {
      dbmod.closeDb();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('老库（只有 meta + 旧 accounts 表）自动补列并补齐迁移记录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-legacy-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT, name TEXT, is_demo INTEGER, created_at TEXT,
      api_key_enc TEXT, api_secret_enc TEXT, passphrase_enc TEXT, api_key_hint TEXT
    );`);
  old.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  old.close();

  const db = dbmod.openDb(file);
  try {
    const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
    assert.ok(cols.includes('assets_only'));
    assert.ok(cols.includes('sync_done'));
    assert.deepEqual(versionsOf(db).map((r) => r.version), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '7');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v6：清理 v5 之后重新漏进 U 本位通道的币本位成交（BTCUSD/PERP）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-migrate6-'));
  const file = path.join(dir, 'test.db');
  try {
    // 先建到 v6，再模拟「v5 已跑过、脏成交又落库」的现场：删掉 v6 记录后重开
    const db1 = dbmod.openDb(file);
    db1.prepare(`INSERT INTO trade_fills
      (account_id, exchange, symbol, external_id, side, price, qty, fee, time, created_at)
      VALUES (1, 'binance', 'BTCUSD/PERP', '1162263459', 'buy', 76555, 1, 0, 1793664469784, '2026-11-24T15:36:57.000Z')`).run();
    db1.prepare(`INSERT INTO trade_fills
      (account_id, exchange, symbol, external_id, side, price, qty, fee, time, created_at)
      VALUES (1, 'binance', 'BTC/USD', 'dapi:BTCUSD_PERP:1162263459', 'buy', 76555, 1, -0.02, 1793664469784, '2026-11-10T09:38:22.000Z')`).run();
    db1.prepare('DELETE FROM schema_migrations WHERE version = 6').run();
    db1.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    db1.close();

    const db = dbmod.openDb(file);
    try {
      const symbols = db.prepare('SELECT symbol FROM trade_fills ORDER BY symbol').all().map((r) => r.symbol);
      // 正确的 dapi 成交（BTC/USD）保留，幽灵成交（BTCUSD/PERP）被清掉
      assert.deepEqual(symbols, ['BTC/USD']);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '7');
      assert.ok(versionsOf(db).some((r) => r.version === 6 && r.name === 'cleanup-usdm-coinm-leak'));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
