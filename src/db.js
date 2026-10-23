/**
 * SQLite 数据层（Node 内置 node:sqlite，零第三方依赖）。
 *
 * 约定：
 *   - 时间统一存 UTC ISO 8601 字符串；
 *   - 金额单位跟随账户计价币（默认 USD），不做换算；
 *   - 所有写操作用事务，避免半截数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange TEXT NOT NULL DEFAULT 'manual',
  name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  size REAL NOT NULL DEFAULT 0,
  notional REAL NOT NULL DEFAULT 0,
  entry_price REAL NOT NULL DEFAULT 0,
  exit_price REAL NOT NULL DEFAULT 0,
  open_time TEXT NOT NULL,
  close_time TEXT NOT NULL,
  pnl REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  funding REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  market TEXT NOT NULL DEFAULT 'futures',
  note TEXT,
  note_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_trades_external
  ON trades(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_trades_close ON trades(close_time DESC);
CREATE INDEX IF NOT EXISTS ix_trades_account ON trades(account_id);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#4ade80',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_tags (
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, tag_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT '',
  rows INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  message TEXT
);

CREATE TABLE IF NOT EXISTS import_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  mapping TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  time TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);
CREATE INDEX IF NOT EXISTS ix_funding_account_time ON funding_events(account_id, time);

CREATE TABLE IF NOT EXISTS balances (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  free REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, asset)
);

CREATE TABLE IF NOT EXISTS positions (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL DEFAULT 0,
  entry_price REAL NOT NULL DEFAULT 0,
  mark_price REAL NOT NULL DEFAULT 0,
  unrealized REAL NOT NULL DEFAULT 0,
  funding_rate REAL,
  next_funding_time TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, symbol, side)
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spot_balances (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  free REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, asset)
);

CREATE TABLE IF NOT EXISTS spot_holdings (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  asset TEXT NOT NULL,
  quote TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  price REAL,
  value REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS spot_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  time TEXT NOT NULL,
  order_type TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);
CREATE INDEX IF NOT EXISTS ix_spot_fills_time ON spot_fills(time);

CREATE TABLE IF NOT EXISTS spot_cost_basis (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  type TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  tx_time TEXT NOT NULL,
  tx_id TEXT,
  chain TEXT,
  counterparty TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);
CREATE INDEX IF NOT EXISTS ix_transfers_time ON transfers(tx_time);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_kind TEXT NOT NULL,
  period_label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  trades INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_report_generations ON report_generations(period_kind, period_label);
`;

/** 增量迁移：给已有数据库补上交易所同步所需字段 */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
  const add = (name, ddl) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${ddl}`);
  };
  add('api_key_enc', 'TEXT');
  add('api_secret_enc', 'TEXT');
  add('passphrase_enc', 'TEXT');
  add('api_key_hint', 'TEXT');
  add('sync_state', 'TEXT');
  add('sync_done', 'INTEGER NOT NULL DEFAULT 0');
  add('last_sync_at', 'TEXT');
  add('last_sync_status', 'TEXT');
  add('last_sync_message', 'TEXT');
  add('lookback_days', 'INTEGER');
  add('last_transfer_sync_at', 'TEXT');
  add('spot_symbols', 'TEXT');
  add('last_spot_sync_at', 'TEXT');
  const tradeCols = new Set(db.prepare('PRAGMA table_info(trades)').all().map((c) => c.name));
  if (!tradeCols.has('market')) {
    db.exec("ALTER TABLE trades ADD COLUMN market TEXT NOT NULL DEFAULT 'futures'");
  }

  // 笔记分类：周期复盘 / 交易对档案 / 策略手册 / 现货备注 / 自由笔记
  const noteCols = new Set(db.prepare('PRAGMA table_info(notes)').all().map((c) => c.name));
  const addNote = (name, ddl) => {
    if (!noteCols.has(name)) db.exec(`ALTER TABLE notes ADD COLUMN ${name} ${ddl}`);
  };
  addNote('category', "TEXT NOT NULL DEFAULT 'general'");
  addNote('subject', 'TEXT');
  addNote('market', 'TEXT');
  addNote('account_id', 'INTEGER');
  db.exec("CREATE INDEX IF NOT EXISTS ix_notes_category ON notes(category, updated_at DESC)");
  db.exec("DROP INDEX IF EXISTS ux_notes_symbol");
  db.exec("DROP INDEX IF EXISTS ux_notes_spot");
}

let handle = null;

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
  return db;
}

/** 获取（并懒加载）单例连接 */
export function getDb() {
  if (!handle) handle = openDb();
  return handle;
}

/** 仅供测试/重置时替换连接 */
export function setDb(db) {
  if (handle) handle.close();
  handle = db;
}

export function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
  }
}

/** 生成一致性快照；WAL 模式下不能直接复制 .db 文件 */
export function vacuumInto(file) {
  const escaped = String(file).replace(/\\/g, '/').replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
}

export const all = (sql, ...params) => getDb().prepare(sql).all(...params);
export const get = (sql, ...params) => getDb().prepare(sql).get(...params);
export const run = (sql, ...params) => getDb().prepare(sql).run(...params);

/** 事务包装；回调抛错则回滚 */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已经回滚 */ }
    throw err;
  }
}

export function dbSizeBytes() {
  try {
    const st = fs.statSync(config.dbFile);
    return st.size;
  } catch {
    return 0;
  }
}
