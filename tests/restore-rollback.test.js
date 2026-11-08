import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-restore-'));
process.env.DB_FILE = path.join(root, 'tradeledger.db');
process.env.BACKUP_DIR = path.join(root, 'backups');

const restore = await import('../src/restore.js?restore-test');
const configMod = await import('../src/config.js?restore-test');
const config = configMod.config;

const snapshotMeta = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'probe'").get()?.value ?? null;
  } finally {
    db.close();
  }
};

const makeDb = (file, probe) => {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('probe', probe);
  db.close();
};

test('restore 钩子：无 pending 文件时不动数据库', () => {
  assert.equal(restore.applyPendingRestore(), null);
});

test('正常恢复：pending 替换数据库，pre-restore 保留旧数据', () => {
  makeDb(config.dbFile, 'before');
  makeDb(path.join(root, 'pending.db'), 'after');
  fs.copyFileSync(path.join(root, 'pending.db'), restore.pendingRestoreFile());

  const result = restore.applyPendingRestore();
  assert.equal(result.ok, true);
  assert.equal(snapshotMeta(config.dbFile), 'after');
  assert.ok(result.preRestore);
  assert.equal(snapshotMeta(result.preRestore), 'before');
  assert.equal(fs.existsSync(restore.pendingRestoreFile()), false);
});

test('回滚：替换失败时旧库（含 WAL）放回原位', () => {
  makeDb(config.dbFile, 'original');
  // WAL 里还有未 checkpoint 的新写入
  const wal = new DatabaseSync(config.dbFile);
  wal.exec('PRAGMA journal_mode = WAL');
  wal.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('probe', 'from-wal')").run();
  wal.close();

  // pending 是个非法 SQLite 文件：rename 成功，但替换后的库打不开
  const bad = path.join(root, 'bad-pending.db');
  fs.writeFileSync(bad, 'this is not a sqlite database at all');
  fs.copyFileSync(bad, restore.pendingRestoreFile());

  const result = restore.applyPendingRestore();
  assert.equal(result.ok, false);
  assert.match(result.error, /not a sqlite database|file is not a database|无法/i);
  // 旧库回到原位且数据仍在（WAL 保留，能读出最新值）
  assert.equal(fs.existsSync(config.dbFile), true);
  const db = new DatabaseSync(config.dbFile, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'probe'").get().value, 'from-wal');
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(restore.pendingRestoreFile()), false);
});

test.after(() => {
  // Windows 上残留句柄可能延迟释放，重试删除
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return; } catch { /* 重试 */ }
  }
});
