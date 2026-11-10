import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbmod = await import('../src/db.js');

const versionsOf = (db) => db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();

test('全新库：记录 baseline + legacy-repair，schema_version 同步为 5', () => {
  const db = dbmod.openDb(':memory:');
  try {
    const versions = versionsOf(db);
    assert.deepEqual(versions.map((r) => r.version), [1, 2, 3, 4, 5]);
    assert.equal(versions[0].name, 'baseline');
    assert.equal(versions[1].name, 'legacy-repair');
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(meta.value, '5');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
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
      assert.equal(versionsOf(db).length, 5);
      assert.equal(dbmod.schemaVersion(), 5);
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
    assert.deepEqual(versionsOf(db).map((r) => r.version), [1, 2, 3, 4, 5]);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
