/**
 * 恢复启动钩子：在数据库连接打开之前替换 SQLite 文件。
 *
 * 恢复流程刻意分成两步：
 *   1. 页面/CLI 只把备份写入 data/restore-pending.db；
 *   2. 服务下次启动时，本模块先把当前库移到 data/backups/pre-restore-*.db，
 *      再用 pending 文件替换，避免在服务运行中替换正在使用的数据库。
 *
 * 这个模块不能 import db.js / store.js，否则数据库会在替换前被打开。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export function pendingRestoreFile() {
  return path.join(path.dirname(config.dbFile), 'restore-pending.db');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * @returns {{ok: boolean, preRestore?: string, error?: string}|null}
 */
export function applyPendingRestore() {
  if (!config.dbFile || config.dbFile === ':memory:') return null;
  const pending = pendingRestoreFile();
  if (!fs.existsSync(pending)) return null;

  const backupDir = config.backupDir;
  fs.mkdirSync(backupDir, { recursive: true });
  let preRestore = path.join(backupDir, `pre-restore-${stamp()}.db`);
  for (let i = 2; fs.existsSync(preRestore); i++) {
    preRestore = path.join(backupDir, `pre-restore-${stamp()}-${i}.db`);
  }
  const suffixes = ['', '-wal', '-shm', '-journal'];
  const moved = [];

  try {
    if (fs.existsSync(config.dbFile)) {
      // 先把 WAL 合并回主库，保证 pre-restore 是自包含的单文件
      try {
        const old = new DatabaseSync(config.dbFile);
        old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        old.close();
      } catch { /* 锁住时保留 db + wal 一起移动 */ }
      fs.renameSync(config.dbFile, preRestore);
      moved.push('');
    }
    for (const suffix of suffixes.slice(1)) {
      const from = config.dbFile + suffix;
      if (fs.existsSync(from)) {
        fs.renameSync(from, preRestore + suffix);
        moved.push(suffix);
      }
    }
    fs.renameSync(pending, config.dbFile);
    return { ok: true, preRestore: fs.existsSync(preRestore) ? preRestore : null };
  } catch (err) {
    // 回滚：把旧库和它的 WAL/SHM 一起放回去，避免丢最近写入
    for (const suffix of moved) {
      const from = preRestore + suffix;
      const to = config.dbFile + suffix;
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
      } catch { /* 尽力恢复 */ }
    }
    return { ok: false, error: err?.message || String(err) };
  }
}
