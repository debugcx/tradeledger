/**
 * 数据读写层：把 SQL 细节收在这里，路由与视图只看到普通对象。
 */

import { all, get, run, tx } from './db.js';
import { nowIso, uid } from './http.js';
import { encryptSecret, decryptSecret, hintKey } from './crypto.js';
import { remainingLots, matchSpotRounds, hash64 } from './fills.js';
import { filterTrades, dayKeyOf, localDayStartUtc, localDayEndExclusiveUtc } from './stats.js';
import { setExchangeProxyProvider } from './http-client.js';
import { assertSafeOutboundUrl } from './url-guard.js';

/* ---------------- 账户 ---------------- */

/** 对外只暴露安全字段，加密后的凭据与原文永不进视图 */
const ACCOUNT_COLS = `id, exchange, name, is_demo, created_at, api_key_hint,
  sync_state, sync_done, last_sync_at, last_sync_status, last_sync_message,
  lookback_days, last_transfer_sync_at, spot_symbols, last_spot_sync_at,
  assets_only`;

export function listAccounts() {
  return all(`SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY is_demo ASC, id ASC`);
}

export function getAccount(id) {
  return get(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`, Number(id)) || null;
}

export function ensureDefaultAccount() {
  const existing = get("SELECT * FROM accounts WHERE exchange = 'manual' ORDER BY id ASC LIMIT 1");
  if (existing) return getAccount(existing.id);
  const at = nowIso();
  const r = run("INSERT INTO accounts (exchange, name, is_demo, created_at) VALUES ('manual', '手动记录', 0, ?)", at);
  return getAccount(Number(r.lastInsertRowid));
}

export function createAccount({ exchange, name, apiKey = '', apiSecret = '', passphrase = '', isDemo = 0, lookbackDays = null, spotSymbols = '', assetsOnly = 0 }) {
  const at = nowIso();
  const key = String(apiKey || '');
  const r = run(
    `INSERT INTO accounts
       (exchange, name, is_demo, created_at, api_key_enc, api_secret_enc, passphrase_enc, api_key_hint, lookback_days, spot_symbols, assets_only)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(exchange || '').trim(),
    String(name || exchange || '未命名').trim().slice(0, 60),
    isDemo ? 1 : 0,
    at,
    encryptSecret(key),
    encryptSecret(apiSecret),
    encryptSecret(passphrase),
    hintKey(key),
    lookbackDays === null || lookbackDays === undefined || lookbackDays === '' ? null : Number(lookbackDays),
    String(spotSymbols || '').slice(0, 1000),
    assetsOnly ? 1 : 0,
  );
  return getAccount(Number(r.lastInsertRowid));
}

export function updateAccount(id, { name, apiKey, apiSecret, passphrase, lookbackDays, spotSymbols, assetsOnly } = {}) {
  const current = get('SELECT * FROM accounts WHERE id = ?', Number(id));
  if (!current) throw new Error('账户不存在');
  const nextName = name !== undefined ? String(name).trim().slice(0, 60) : current.name;
  const nextKeyEnc = apiKey !== undefined && apiKey !== '' ? encryptSecret(apiKey) : current.api_key_enc;
  const nextSecretEnc = apiSecret !== undefined && apiSecret !== '' ? encryptSecret(apiSecret) : current.api_secret_enc;
  const nextPassEnc = passphrase !== undefined && passphrase !== '' ? encryptSecret(passphrase) : current.passphrase_enc;
  const nextHint = apiKey !== undefined && apiKey !== '' ? hintKey(apiKey) : current.api_key_hint;
  const nextLookback = lookbackDays === undefined || lookbackDays === ''
    ? current.lookback_days
    : Number(lookbackDays);
  const nextSpotSymbols = spotSymbols === undefined
    ? current.spot_symbols
    : String(spotSymbols || '').slice(0, 1000);
  // assetsOnly 三态：undefined = 保持原值，否则按布尔写 0/1
  const nextAssetsOnly = assetsOnly === undefined
    ? Number(current.assets_only) || 0
    : (assetsOnly ? 1 : 0);
  run(
    `UPDATE accounts
     SET name = ?, api_key_enc = ?, api_secret_enc = ?, passphrase_enc = ?, api_key_hint = ?,
         lookback_days = ?, spot_symbols = ?, assets_only = ?
     WHERE id = ?`,
    nextName, nextKeyEnc, nextSecretEnc, nextPassEnc, nextHint, nextLookback, nextSpotSymbols, nextAssetsOnly, Number(id),
  );
  return getAccount(id);
}

/** 重置回溯状态：下次 worker 会按当前 lookback_days 重新扫一遍（交易去重） */
export function resetAccountSync(id) {
  run(
    `UPDATE accounts
     SET sync_done = 0, sync_state = NULL, last_sync_status = NULL, last_sync_message = NULL,
         last_transfer_sync_at = NULL
     WHERE id = ?`,
    Number(id),
  );
  setSyncFail(Number(id), null);
}

/** 连续同步失败的退避状态（同步层维护，供 worker 与账户页读取） */
export function getSyncFail(accountId) {
  try {
    const raw = getMeta(`sync_fail_${Number(accountId)}`, '');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSyncFail(accountId, state) {
  setMeta(`sync_fail_${Number(accountId)}`, state ? JSON.stringify(state) : '');
}

export function updateAccountTransferSync(id) {
  run('UPDATE accounts SET last_transfer_sync_at = ? WHERE id = ?', nowIso(), Number(id));
}

export function updateAccountSpotSync(id) {
  run('UPDATE accounts SET last_spot_sync_at = ? WHERE id = ?', nowIso(), Number(id));
}

export function resetAccountSpotSync(id) {
  run('UPDATE accounts SET last_spot_sync_at = NULL WHERE id = ?', Number(id));
}

export function deleteAccount(id) {
  const accountId = Number(id);
  tx((db) => {
    db.prepare("DELETE FROM asset_positions WHERE venue_kind = 'exchange' AND venue_id = ?").run(accountId);
    db.prepare("DELETE FROM asset_sync_runs WHERE venue_kind = 'exchange' AND venue_id = ?").run(accountId);
    db.prepare('DELETE FROM accounts WHERE id = ? AND is_demo = 0').run(accountId);
  });
}

/** 解密后的凭据；wallet 与 apiKey 同源（Hyperliquid 只填地址） */
export function getAccountCredentials(id) {
  const row = get('SELECT * FROM accounts WHERE id = ?', Number(id));
  if (!row) throw new Error('账户不存在');
  const apiKey = row.api_key_enc ? decryptSecret(row.api_key_enc) : '';
  return {
    apiKey,
    apiSecret: row.api_secret_enc ? decryptSecret(row.api_secret_enc) : '',
    passphrase: row.passphrase_enc ? decryptSecret(row.passphrase_enc) : '',
    wallet: apiKey,
  };
}

export function updateAccountSyncState(id, { state = null, done = 0, status = 'ok', message = '' } = {}) {
  run(
    `UPDATE accounts SET sync_state = ?, sync_done = ?, last_sync_at = ?, last_sync_status = ?, last_sync_message = ?
     WHERE id = ?`,
    state ? JSON.stringify(state) : null,
    done ? 1 : 0,
    nowIso(),
    String(status || 'ok').slice(0, 30),
    String(message || '').slice(0, 500),
    Number(id),
  );
}

/* ---------------- 导入模板 ---------------- */

export function listImportTemplates() {
  return all('SELECT * FROM import_templates ORDER BY name ASC');
}

export function getImportTemplate(id) {
  return get('SELECT * FROM import_templates WHERE id = ?', Number(id)) || null;
}

export function saveImportTemplate(name, mapping) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('模板名不能为空');
  const json = JSON.stringify(mapping || {});
  run(
    `INSERT INTO import_templates (name, mapping, created_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET mapping = excluded.mapping`,
    clean, json, nowIso(),
  );
  return get('SELECT * FROM import_templates WHERE name = ?', clean);
}

export function deleteImportTemplate(id) {
  run('DELETE FROM import_templates WHERE id = ?', Number(id));
}

/* ---------------- 资金费事件 ---------------- */

export function insertFundingEvents(events, accountId) {
  if (!Array.isArray(events) || !events.length) return 0;
  return tx((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO funding_events (account_id, external_id, symbol, time, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const e of events) {
      if (!e.external_id || !e.symbol || !e.time) continue;
      const r = stmt.run(
        Number(accountId), String(e.external_id).slice(0, 200), String(e.symbol),
        e.time, Number(e.amount) || 0, nowIso(),
      );
      inserted += Number(r.changes) || 0;
    }
    return inserted;
  });
}

/**
 * 把尚未匹配的资金费事件分配到对应的已平仓交易：
 * 同账户 + 同币种 + 事件时间落在持仓区间内，取平仓时间最近的一笔。
 * 分配时同时增加 trades.funding 与 trades.pnl，保证「毛盈亏 = 净盈亏 − 手续费 − 资金费」不变。
 */
export function applyFundingEvents(accountId = null) {
  return tx((db) => {
    const rows = accountId
      ? db.prepare('SELECT * FROM funding_events WHERE trade_id IS NULL AND account_id = ? ORDER BY time').all(Number(accountId))
      : db.prepare('SELECT * FROM funding_events WHERE trade_id IS NULL ORDER BY time').all();
    const find = db.prepare(
      `SELECT id FROM trades
       WHERE account_id = ? AND symbol = ? AND trashed_at IS NULL
         AND open_time <= ? AND close_time >= ?
       ORDER BY close_time ASC LIMIT 1`,
    );
    const add = db.prepare('UPDATE trades SET funding = funding + ?, pnl = pnl + ?, updated_at = ? WHERE id = ?');
    const mark = db.prepare('UPDATE funding_events SET trade_id = ? WHERE id = ?');
    let applied = 0;
    for (const ev of rows) {
      const trade = find.get(ev.account_id, ev.symbol, ev.time, ev.time);
      if (!trade) continue;
      add.run(ev.amount, ev.amount, nowIso(), trade.id);
      mark.run(trade.id, ev.id);
      applied++;
    }
    return applied;
  });
}

export function fundingSummary(accountId = null) {
  const where = accountId ? ' WHERE account_id = ?' : '';
  const params = accountId ? [Number(accountId)] : [];
  const row = get(
    `SELECT COUNT(*) AS events,
       COALESCE(SUM(amount), 0) AS net,
       SUM(CASE WHEN trade_id IS NULL THEN 1 ELSE 0 END) AS unallocated,
       COALESCE(SUM(CASE WHEN trade_id IS NULL THEN amount ELSE 0 END), 0) AS unallocated_amount
     FROM funding_events${where}`,
    ...params,
  ) || {};
  const bySymbol = all(
    `SELECT symbol, COUNT(*) AS events, COALESCE(SUM(amount),0) AS amount
     FROM funding_events${where} GROUP BY symbol ORDER BY ABS(amount) DESC LIMIT 12`,
    ...params,
  );
  return {
    events: Number(row.events) || 0,
    net: Number(row.net) || 0,
    unallocated: Number(row.unallocated) || 0,
    unallocatedAmount: Number(row.unallocated_amount) || 0,
    bySymbol,
  };
}

/* ---------------- 实时余额 / 持仓 ---------------- */

export function replaceBalances(accountId, list) {
  const at = nowIso();
  tx((db) => {
    db.prepare('DELETE FROM balances WHERE account_id = ?').run(Number(accountId));
    const stmt = db.prepare(
      'INSERT INTO balances (account_id, asset, total, free, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const b of list || []) {
      if (!b.asset) continue;
      stmt.run(Number(accountId), String(b.asset), Number(b.total) || 0, Number(b.free) || 0, at);
    }
  });
}

export function listBalances(accountId = null) {
  const params = [];
  let sql = `SELECT b.*, a.name AS account_name, a.exchange
             FROM balances b JOIN accounts a ON a.id = b.account_id`;
  if (accountId) { sql += ' WHERE b.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY a.id, b.total DESC';
  return all(sql, ...params);
}

export function replacePositions(accountId, list) {
  const at = nowIso();
  tx((db) => {
    db.prepare('DELETE FROM positions WHERE account_id = ?').run(Number(accountId));
    const stmt = db.prepare(
      `INSERT INTO positions
         (account_id, symbol, side, size, entry_price, mark_price, unrealized, funding_rate, next_funding_time, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of list || []) {
      if (!p.symbol) continue;
      stmt.run(
        Number(accountId), String(p.symbol), p.side === 'short' ? 'short' : 'long',
        Number(p.size) || 0, Number(p.entry_price) || 0, Number(p.mark_price) || 0,
        Number(p.unrealized) || 0,
        p.funding_rate === undefined || p.funding_rate === null ? null : Number(p.funding_rate),
        p.next_funding_time || null, at,
      );
    }
  });
}

export function listPositions(accountId = null) {
  const params = [];
  let sql = `SELECT p.*, a.name AS account_name, a.exchange
             FROM positions p JOIN accounts a ON a.id = p.account_id`;
  if (accountId) { sql += ' WHERE p.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY a.id, ABS(p.unrealized) DESC';
  return all(sql, ...params);
}

/* ---------------- 持仓笔记（挂起 → 平仓归档进交易记录） ---------------- */

const POSITION_NOTE_MAX = 2000;
// 平仓交易的时间可能落在写下笔记之前的几分钟内（刚平仓才写的笔记），
// 归档匹配向前放宽这个余量，避免笔记变成永远匹配不上交易的僵尸
const POSITION_NOTE_GRACE_MS = 10 * 60_000;

export function setPositionNote(accountId, symbol, side, note) {
  const acc = Number(accountId);
  const sym = String(symbol || '').trim();
  const dir = side === 'short' ? 'short' : 'long';
  if (!acc || !sym) throw new Error('账户和交易对不能为空');
  const text = String(note || '').trim().slice(0, POSITION_NOTE_MAX);
  const at = nowIso();
  if (!text) {
    run('DELETE FROM position_notes WHERE account_id = ? AND symbol = ? AND side = ?', acc, sym, dir);
    return null;
  }
  // 覆盖更新保留首次写入时间：归档按 created_at 判定笔记属于哪个回合
  run(
    `INSERT INTO position_notes (account_id, symbol, side, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, symbol, side) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    acc, sym, dir, text, at, at,
  );
  return { account_id: acc, symbol: sym, side: dir, content: text };
}

export function listPositionNotes(accountId = null) {
  return accountId
    ? all('SELECT * FROM position_notes WHERE account_id = ?', Number(accountId))
    : all('SELECT * FROM position_notes');
}

/**
 * 挂起笔记归档：持仓已平（快照表查无此行）时，把笔记写进本回合平仓产生的
 * 交易记录（close_time 晚于笔记首次写入），随后消费掉挂起笔记。
 * 平仓交易尚未同步进来时保持挂起，等下一次同步/刷新再归档。
 * 在 refreshLive（发现平仓）和 importTrades（交易落库）两处触发。
 */
export function archivePositionNotes(accountId = null) {
  const pending = accountId === null
    ? all('SELECT * FROM position_notes')
    : all('SELECT * FROM position_notes WHERE account_id = ?', Number(accountId));
  let attached = 0;
  for (const pn of pending) {
    const holding = get(
      'SELECT 1 AS x FROM positions WHERE account_id = ? AND symbol = ? AND side = ?',
      pn.account_id, pn.symbol, pn.side,
    );
    if (holding) continue;
    const since = new Date(Date.parse(pn.created_at) - POSITION_NOTE_GRACE_MS).toISOString();
    const targets = all(
      `SELECT id FROM trades
        WHERE account_id = ? AND symbol = ? AND side = ? AND close_time >= ?
          AND (note IS NULL OR note = '')
        ORDER BY close_time ASC`,
      pn.account_id, pn.symbol, pn.side, since,
    );
    if (!targets.length) continue;
    const at = nowIso();
    tx((db) => {
      const upd = db.prepare('UPDATE trades SET note = ?, note_updated_at = ?, updated_at = ? WHERE id = ?');
      for (const t of targets) upd.run(pn.content, at, at, t.id);
      db.prepare('DELETE FROM position_notes WHERE account_id = ? AND symbol = ? AND side = ?')
        .run(pn.account_id, pn.symbol, pn.side);
    });
    attached += targets.length;
  }
  return attached;
}

/* ---------------- 现货余额 / 持仓 ---------------- */

export function replaceSpotBalances(accountId, list) {
  const at = nowIso();
  tx((db) => {
    db.prepare('DELETE FROM spot_balances WHERE account_id = ?').run(Number(accountId));
    const stmt = db.prepare(
      'INSERT INTO spot_balances (account_id, asset, total, free, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const b of list || []) {
      if (!b.asset) continue;
      stmt.run(Number(accountId), String(b.asset), Number(b.total) || 0, Number(b.free) || 0, at);
    }
  });
}

export function listSpotBalances(accountId = null) {
  const params = [];
  let sql = `SELECT b.*, a.name AS account_name, a.exchange
             FROM spot_balances b JOIN accounts a ON a.id = b.account_id`;
  if (accountId) { sql += ' WHERE b.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY a.id, b.total DESC';
  return all(sql, ...params);
}

export function replaceSpotHoldings(accountId, list) {
  const at = nowIso();
  tx((db) => {
    db.prepare('DELETE FROM spot_holdings WHERE account_id = ?').run(Number(accountId));
    const stmt = db.prepare(
      `INSERT INTO spot_holdings
         (account_id, symbol, asset, quote, quantity, price, value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of list || []) {
      if (!h.symbol || !h.asset) continue;
      stmt.run(
        Number(accountId), String(h.symbol), String(h.asset), String(h.quote || 'USDT'),
        Number(h.quantity) || 0,
        h.price === null || h.price === undefined ? null : Number(h.price),
        h.value === null || h.value === undefined ? null : Number(h.value),
        at,
      );
    }
  });
}

export function listSpotHoldings(accountId = null, symbol = null) {
  const params = [];
  const where = [];
  // 只取每个持仓最新的一段备注（分段后同账户同交易对可能有多篇）
  let sql = `SELECT h.*, a.name AS account_name, a.exchange,
               c.quantity AS cost_quantity, c.avg_cost,
               n.id AS note_id, n.content AS note
             FROM spot_holdings h
             JOIN accounts a ON a.id = h.account_id
             LEFT JOIN spot_cost_basis c ON c.account_id = h.account_id AND c.symbol = h.symbol
             LEFT JOIN notes n ON n.id = (
               SELECT n2.id FROM notes n2
                WHERE n2.category = 'spot' AND n2.account_id = h.account_id AND n2.subject = h.symbol
                ORDER BY n2.updated_at DESC, n2.id DESC LIMIT 1
             )`;
  if (accountId) { where.push('h.account_id = ?'); params.push(Number(accountId)); }
  if (symbol) { where.push('h.symbol = ?'); params.push(String(symbol)); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY a.id, COALESCE(h.value, 0) DESC';
  return all(sql, ...params);
}

/* ---------------- 现货逐笔成交 / 成本基础 ---------------- */

export function insertSpotFills(fills, accountId) {
  if (!Array.isArray(fills) || !fills.length) return 0;
  return tx((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO spot_fills
         (account_id, external_id, symbol, side, price, qty, fee, time, order_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const f of fills) {
      const ext = f.external_id || f.id;
      const time = typeof f.time === 'number' ? new Date(f.time).toISOString() : f.time;
      if (!ext || !f.symbol || !time) continue;
      const r = stmt.run(
        Number(accountId), String(ext).slice(0, 200), String(f.symbol),
        f.side === 'sell' ? 'sell' : 'buy',
        Number(f.price) || 0, Number(f.qty) || 0, Number(f.fee) || 0,
        time, f.order_type ?? f.orderType ?? null, nowIso(),
      );
      inserted += Number(r.changes) || 0;
    }
    return inserted;
  });
}

export function listSpotFills({ accountId = null, symbol = 'all', limit = 200 } = {}) {
  const params = [];
  let sql = `SELECT f.*, a.name AS account_name, a.exchange
             FROM spot_fills f JOIN accounts a ON a.id = f.account_id WHERE 1=1`;
  if (accountId) { sql += ' AND f.account_id = ?'; params.push(Number(accountId)); }
  if (symbol && symbol !== 'all') { sql += ' AND f.symbol = ?'; params.push(symbol); }
  sql += ' ORDER BY f.time DESC, f.id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 200, 1), 2000));
  return all(sql, ...params);
}

export function listSpotCostBasis(accountId = null) {
  const params = [];
  let sql = `SELECT c.*, a.name AS account_name, a.exchange
             FROM spot_cost_basis c JOIN accounts a ON a.id = c.account_id`;
  if (accountId) { sql += ' WHERE c.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY c.account_id, c.symbol';
  return all(sql, ...params);
}

/** 用账户全部现货成交重算剩余持仓成本（long-only FIFO） */
export function recomputeSpotCostBasis(accountId) {
  const rows = all(
    'SELECT symbol, side, price, qty, time FROM spot_fills WHERE account_id = ? ORDER BY time ASC',
    Number(accountId),
  );
  const lots = remainingLots(rows.map((r) => ({
    symbol: r.symbol, side: r.side, price: r.price, qty: r.qty, time: Date.parse(r.time),
  })));
  const at = nowIso();
  tx((db) => {
    db.prepare('DELETE FROM spot_cost_basis WHERE account_id = ?').run(Number(accountId));
    const stmt = db.prepare(
      'INSERT INTO spot_cost_basis (account_id, symbol, quantity, avg_cost, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const lot of lots) {
      stmt.run(Number(accountId), lot.symbol, lot.quantity, lot.avgCost, at);
    }
  });
  return lots.length;
}

/* ---------------- 现货回合重算（T 回合 + FIFO） ---------------- */

/** 全量原始现货成交（升序、无 LIMIT），供回合重算使用 */
export function listAllSpotFills(accountId, symbol = null) {
  const params = [Number(accountId)];
  let sql = 'SELECT symbol, side, price, qty, fee, time, order_type FROM spot_fills WHERE account_id = ?';
  if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol)); }
  sql += ' ORDER BY time ASC, id ASC';
  return all(sql, ...params);
}

const trimNum = (v) => String(Number(Number(v).toPrecision(8)));

/**
 * 清理被新配对口径取代的现货 API 记录；写过复盘笔记的先搬进交易对档案，避免内容丢失。
 */
export function pruneSpotTradesNotIn(accountId, exchange, symbol, keepIds) {
  const keep = new Set((keepIds || []).map(String));
  const rows = all(
    `SELECT id, external_id, side, pnl, close_time, note FROM trades
     WHERE account_id = ? AND source = 'api' AND market = 'spot'
       AND symbol = ? AND trashed_at IS NULL AND external_id LIKE ?`,
    Number(accountId), String(symbol), `spot:${exchange}:%`,
  );
  const dead = rows.filter((r) => !keep.has(String(r.external_id)));
  if (!dead.length) return 0;
  const withNote = dead.filter((r) => r.note && String(r.note).trim());
  if (withNote.length) salvageSpotTradeNotes(accountId, symbol, withNote);
  return tx((db) => {
    const release = db.prepare('UPDATE funding_events SET trade_id = NULL WHERE trade_id = ?');
    const del = db.prepare('DELETE FROM trades WHERE id = ?');
    let n = 0;
    for (const r of dead) {
      release.run(r.id);
      n += Number(del.run(r.id).changes) || 0;
    }
    return n;
  });
}

/** 旧逐手配对记录被 T 回合取代时，把用户写的复盘原文归档到交易对档案 */
function salvageSpotTradeNotes(accountId, symbol, rows) {
  const lines = rows.map((r) => {
    const day = String(r.close_time || '').slice(0, 10);
    const pnl = Number(r.pnl) || 0;
    const sideLabel = r.side === 'short' ? '做空' : '做多';
    return `- **${day} ${sideLabel} ${pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}**：${String(r.note).trim().slice(0, 500)}`;
  });
  const block = `\n\n### 迁移的逐笔复盘\n\n> 以下复盘写于旧版逐手配对的现货记录；该记录已被 T 回合 / 新配对取代，原文搬到这里。\n\n${lines.join('\n')}\n`;
  const existing = getNoteByCategory('symbol', symbol);
  if (existing) {
    run('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?',
      `${String(existing.content || '')}${block}`, nowIso(), existing.id);
  } else {
    saveNote({
      title: `${symbol} 交易对档案`,
      content: block.trim(),
      category: 'symbol',
      subject: symbol,
    });
  }
}

/**
 * 用现货成交全量重算回合（T 回合优先 + FIFO 兜底），幂等 upsert 并清理旧口径记录。
 * 新产生的 T 回合会自动写入一条持仓日志。symbols 限定重算范围；不传则覆盖该账户全部现货品种。
 */
export function recomputeSpotTrades(accountId, exchange, { symbols = null } = {}) {
  const syms = symbols && symbols.length
    ? symbols.map(String)
    : all('SELECT DISTINCT symbol FROM spot_fills WHERE account_id = ?', Number(accountId))
      .map((r) => r.symbol);
  if (!syms.length) return { inserted: 0, updated: 0, pruned: 0, trades: 0 };

  const recomputed = [];
  for (const sym of syms) {
    const fills = listAllSpotFills(accountId, sym).map((r) => ({
      symbol: r.symbol, side: r.side, price: r.price, qty: r.qty,
      fee: r.fee, time: Date.parse(r.time), orderType: r.order_type || 'other',
    }));
    if (fills.length) recomputed.push(...matchSpotRounds(fills, `spot:${exchange}`));
  }

  // 只给「本次真正新增」的 T 回合写日志：先记录库里已存在的外部 ID
  const existingIds = new Set(all(
    `SELECT external_id FROM trades WHERE account_id = ? AND market = 'spot' AND external_id IS NOT NULL`,
    Number(accountId),
  ).map((r) => r.external_id));
  const newTShots = recomputed.filter((t) => t.kind === 't_shot' && !existingIds.has(t.external_id));

  const withMarket = recomputed.map((t) => ({ ...t, market: 'spot', source: 'api' }));
  const res = withMarket.length
    ? importTrades(withMarket, accountId, { upsert: true })
    : { inserted: 0, updated: 0, skipped: 0 };

  for (const t of newTShots) {
    const tradeRow = get(
      'SELECT id, account_id, symbol, side, size, entry_price, exit_price, pnl FROM trades WHERE account_id = ? AND external_id = ?',
      Number(accountId), t.external_id,
    );
    if (!tradeRow) continue;
    const action = tradeRow.side === 'long'
      ? `做T：买入 ${trimNum(tradeRow.size)} @ ${trimNum(tradeRow.entry_price)} → 卖出 @ ${trimNum(tradeRow.exit_price)}`
      : `做T：卖出 ${trimNum(tradeRow.size)} @ ${trimNum(tradeRow.entry_price)} → 买回 @ ${trimNum(tradeRow.exit_price)}`;
    const pnl = Number(tradeRow.pnl) || 0;
    addSpotLog({
      accountId,
      symbol: tradeRow.symbol,
      tradeId: tradeRow.id,
      text: `${action}，盈亏 ${pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}`,
      source: 'auto',
    });
  }

  let pruned = 0;
  for (const sym of syms) {
    pruned += pruneSpotTradesNotIn(
      accountId, exchange, sym,
      recomputed.filter((t) => t.symbol === sym).map((t) => t.external_id),
    );
  }
  return { inserted: res.inserted, updated: res.updated || 0, pruned, trades: recomputed.length };
}

/** 一次性迁移：把所有账户的现货记录从旧逐手配对重算为 T 回合 + FIFO（meta 标记防重跑） */
export function migrateSpotRoundsOnce() {
  if (getMeta('spot_t_rounds_v1', '')) return null;
  let accounts = 0;
  let inserted = 0;
  let pruned = 0;
  for (const acc of listAccounts()) {
    const hasFills = get('SELECT 1 AS x FROM spot_fills WHERE account_id = ? LIMIT 1', Number(acc.id));
    if (!hasFills) continue;
    const r = recomputeSpotTrades(acc.id, acc.exchange);
    accounts++;
    inserted += r.inserted;
    pruned += r.pruned;
  }
  setMeta('spot_t_rounds_v1', `accounts:${accounts},inserted:${inserted},pruned:${pruned}`);
  return { accounts, inserted, pruned };
}

/* ---------------- 现货持仓日志 ---------------- */

export function addSpotLog({ accountId, symbol, tradeId = null, text, source = 'manual' }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) throw new Error('日志内容不能为空');
  const r = run(
    `INSERT INTO spot_log (account_id, symbol, trade_id, text, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    Number(accountId), String(symbol), tradeId ? Number(tradeId) : null,
    clean, source === 'auto' ? 'auto' : 'manual', nowIso(),
  );
  return Number(r.lastInsertRowid);
}

/** 一个交易对的日志时间线（跨账户，最新的在最前） */
export function listSpotLogBySymbol(symbol, limit = 80) {
  return all(
    `SELECT l.*, a.name AS account_name
       FROM spot_log l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.symbol = ?
      ORDER BY l.id DESC
      LIMIT ?`,
    String(symbol), Math.min(Math.max(Number(limit) || 80, 1), 200),
  );
}

export function deleteSpotLog(id) {
  run('DELETE FROM spot_log WHERE id = ?', Number(id));
}

/* ---------------- 资金流水（充提 / 划转） ---------------- */

export function insertTransfers(list, accountId) {
  if (!Array.isArray(list) || !list.length) return 0;
  return tx((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO transfers
         (account_id, external_id, type, asset, amount, fee, tx_time, tx_id, chain, counterparty, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const t of list) {
      if (!t.external_id || !t.tx_time) continue;
      const r = stmt.run(
        Number(accountId),
        String(t.external_id).slice(0, 200),
        String(t.type || 'other').slice(0, 30),
        String(t.asset || '').slice(0, 30),
        Number(t.amount) || 0,
        Number(t.fee) || 0,
        t.tx_time,
        t.tx_id ? String(t.tx_id).slice(0, 200) : null,
        t.chain ? String(t.chain).slice(0, 50) : null,
        t.counterparty ? String(t.counterparty).slice(0, 200) : null,
        t.note ? String(t.note).slice(0, 300) : null,
        nowIso(),
      );
      inserted += Number(r.changes) || 0;
    }
    return inserted;
  });
}

export function listTransfers({ accountId = null, type = 'all', asset = 'all', from = '', to = '', limit = 500 } = {}) {
  const params = [];
  let sql = `SELECT t.*, a.name AS account_name, a.exchange
             FROM transfers t JOIN accounts a ON a.id = t.account_id WHERE 1=1`;
  if (accountId) { sql += ' AND t.account_id = ?'; params.push(Number(accountId)); }
  if (type && type !== 'all') { sql += ' AND t.type = ?'; params.push(type); }
  if (asset && asset !== 'all') { sql += ' AND t.asset = ?'; params.push(asset); }
  // 日期按「天」粒度匹配且包含结束日（tx_time 是带时间的 ISO 串，直接 <= 会丢掉结束日）
  if (from) { sql += ' AND substr(t.tx_time, 1, 10) >= ?'; params.push(String(from).slice(0, 10)); }
  if (to) { sql += ' AND substr(t.tx_time, 1, 10) <= ?'; params.push(String(to).slice(0, 10)); }
  sql += ' ORDER BY t.tx_time DESC, t.id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 5000));
  return all(sql, ...params);
}

export function transferSummary() {
  const byType = all(
    `SELECT type, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(fee),0) AS fee
     FROM transfers GROUP BY type ORDER BY type`,
  );
  const byAsset = all(
    `SELECT asset, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
     FROM transfers GROUP BY asset ORDER BY amount DESC LIMIT 20`,
  );
  const byAssetNet = all(
    `SELECT asset,
       COALESCE(SUM(CASE WHEN type IN ('deposit', 'internal_in', 'rebate') THEN amount ELSE 0 END), 0) AS inflow,
       COALESCE(SUM(CASE WHEN type NOT IN ('deposit', 'internal_in', 'rebate') THEN amount ELSE 0 END), 0) AS outflow
     FROM transfers GROUP BY asset ORDER BY inflow + outflow DESC LIMIT 20`,
  );
  const get = (type) => byType.find((x) => x.type === type) || { count: 0, amount: 0, fee: 0 };
  const deposits = get('deposit');
  const withdrawals = get('withdraw');
  return {
    count: byType.reduce((a, b) => a + Number(b.count || 0), 0),
    deposits: Number(deposits.amount) || 0,
    withdrawals: Number(withdrawals.amount) || 0,
    net: (Number(deposits.amount) || 0) - (Number(withdrawals.amount) || 0),
    byType,
    byAsset,
    byAssetNet,
  };
}

export function getTradeCurveCache(tradeId) {
  const row = get('SELECT inputs, bar, candles, truncated FROM trade_curves WHERE trade_id = ?', Number(tradeId));
  if (!row) return null;
  try {
    return { inputs: row.inputs, bar: row.bar, candles: JSON.parse(row.candles), truncated: Boolean(row.truncated) };
  } catch {
    return null;
  }
}

export function saveTradeCurveCache(tradeId, inputs, { bar, candles, truncated }) {
  run(
    `INSERT INTO trade_curves (trade_id, inputs, bar, candles, truncated, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_id) DO UPDATE SET
       inputs = excluded.inputs, bar = excluded.bar, candles = excluded.candles,
       truncated = excluded.truncated, fetched_at = excluded.fetched_at`,
    Number(tradeId), String(inputs || ''), String(bar || ''), JSON.stringify(candles || []),
    truncated ? 1 : 0, nowIso(),
  );
}

export function getTradeFillsCache(tradeId) {
  const row = get('SELECT inputs, fills FROM trade_fills_cache WHERE trade_id = ?', Number(tradeId));
  if (!row) return null;
  try {
    return { inputs: row.inputs, fills: JSON.parse(row.fills) };
  } catch {
    return null;
  }
}

export function saveTradeFillsCache(tradeId, inputs, fills) {
  run(
    `INSERT INTO trade_fills_cache (trade_id, inputs, fills, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(trade_id) DO UPDATE SET
       inputs = excluded.inputs, fills = excluded.fills, fetched_at = excluded.fetched_at`,
    Number(tradeId), String(inputs || ''), JSON.stringify(fills || []), nowIso(),
  );
}

/** 邀请/经纪人返佣账单汇总：count 为全部笔数，usdt 仅统计 USDT 计价部分 */
export function rebateSummary(accountId = null) {
  const where = accountId ? ' AND account_id = ?' : '';
  const params = accountId ? [Number(accountId)] : [];
  const row = get(
    `SELECT COUNT(*) AS count,
       COALESCE(SUM(CASE WHEN asset = 'USDT' THEN amount ELSE 0 END), 0) AS usdt,
       COALESCE(SUM(CASE WHEN asset != 'USDT' THEN 1 ELSE 0 END), 0) AS others
     FROM transfers WHERE type = 'rebate'${where}`,
    ...params,
  ) || {};
  return {
    count: Number(row.count) || 0,
    usdt: Number(row.usdt) || 0,
    others: Number(row.others) || 0,
  };
}

/* ---------------- 图片 / 附件资源 ---------------- */

export function saveResource({ id, name, mime, size, data }) {
  run(
    'INSERT INTO resources (id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    String(id), String(name || '').slice(0, 200), String(mime || 'application/octet-stream'),
    Number(size) || 0, data, nowIso(),
  );
  return id;
}

export function getResource(id) {
  return get('SELECT * FROM resources WHERE id = ?', String(id)) || null;
}

/* ---------------- 同步审计 ---------------- */

export function startSyncRun(accountId) {
  const r = run(
    'INSERT INTO sync_runs (account_id, started_at, status) VALUES (?, ?, ?)',
    Number(accountId), nowIso(), 'running',
  );
  return Number(r.lastInsertRowid);
}

export function finishSyncRun(id, { fetched = 0, inserted = 0, skipped = 0, status = 'ok', message = '' } = {}) {
  run(
    `UPDATE sync_runs SET finished_at = ?, fetched = ?, inserted = ?, skipped = ?, status = ?, message = ?
     WHERE id = ?`,
    nowIso(), Number(fetched) || 0, Number(inserted) || 0, Number(skipped) || 0,
    String(status || 'ok'), String(message || '').slice(0, 500), Number(id),
  );
}

export function listSyncRuns(accountId = null, limit = 20) {
  const params = [];
  let sql = `SELECT r.*, a.name AS account_name, a.exchange FROM sync_runs r
             JOIN accounts a ON a.id = r.account_id`;
  if (accountId) { sql += ' WHERE r.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY r.id DESC LIMIT ?';
  params.push(Number(limit));
  return all(sql, ...params);
}

/** 给同步进度条用的账户统计 */
export function accountTradeStats() {
  return all(
    `SELECT a.id, a.sync_done, a.sync_state, a.last_sync_at, a.last_sync_status, a.last_sync_message, a.assets_only,
       (SELECT COUNT(*) FROM trades t WHERE t.account_id = a.id AND t.trashed_at IS NULL) AS trades,
       (SELECT MIN(t.close_time) FROM trades t WHERE t.account_id = a.id) AS oldest_close
     FROM accounts a
     WHERE a.is_demo = 0 AND a.exchange != 'manual'`,
  );
}

/* ---------------- 原始成交（客户端配对交易所） ---------------- */

/** 持久化适配器返回的原始成交；external_id 按 (账户, symbol) 唯一 */
export function insertTradeFills(accountId, exchange, fills) {
  if (!Array.isArray(fills) || !fills.length) return 0;
  return tx((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO trade_fills
         (account_id, exchange, symbol, external_id, side, price, qty, fee, time, order_type, contract_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const f of fills) {
      if (!f?.id || !f.symbol || !Number(f.time)) continue;
      const r = stmt.run(
        Number(accountId), String(exchange), String(f.symbol), String(f.id),
        f.side === 'buy' ? 'buy' : 'sell',
        Number(f.price) || 0, Number(f.qty) || 0, Number(f.fee) || 0,
        Math.floor(Number(f.time) || 0), f.orderType ? String(f.orderType) : null,
        Number(f.contractValue) || 0, nowIso(),
      );
      inserted += Number(r.changes) || 0;
    }
    return inserted;
  });
}

export function listTradeFillSymbols(accountId, { exchange = null } = {}) {
  const rows = exchange
    ? all('SELECT DISTINCT symbol FROM trade_fills WHERE account_id = ? AND exchange = ? ORDER BY symbol', Number(accountId), String(exchange))
    : all('SELECT DISTINCT symbol FROM trade_fills WHERE account_id = ? ORDER BY symbol', Number(accountId));
  return rows.map((r) => r.symbol);
}

/** 每个 symbol 最早的开仓时间（判断成交覆盖是否够做全量重算） */
export function listSymbolEarliestOpen(accountId) {
  return all(
    `SELECT symbol, MIN(open_time) AS min_open FROM trades
     WHERE account_id = ? AND source = 'api' AND market = 'futures' GROUP BY symbol`,
    Number(accountId),
  );
}

export function listTradeFills(accountId, symbol, { exchange = null } = {}) {
  const rows = exchange
    ? all(
      `SELECT external_id, side, price, qty, fee, time, order_type, contract_value
       FROM trade_fills WHERE account_id = ? AND symbol = ? AND exchange = ? ORDER BY time ASC, id ASC`,
      Number(accountId), String(symbol), String(exchange),
    )
    : all(
      `SELECT external_id, side, price, qty, fee, time, order_type, contract_value
       FROM trade_fills WHERE account_id = ? AND symbol = ? ORDER BY time ASC, id ASC`,
      Number(accountId), String(symbol),
    );
  return rows;
}

/**
 * 持久化 CSV 导入的逐笔成交（exchange='csv' 标记来源通道）。
 * CSV 通常没有逐笔 ID：用内容指纹 csvf:<hash> 做唯一键，同批内的完全相同成交
 * （拆单等）按 :n 编号共存。重复导入同一文件时指纹一致 → INSERT OR IGNORE 幂等，
 * 与回合层 fingerprintTrade 的去重口径一致（跨文件的真·同毫秒同价同量成交视为同笔）。
 */
export function insertCsvFills(accountId, fills) {
  if (!Array.isArray(fills) || !fills.length) return { inserted: 0, skipped: 0 };
  return tx((db) => {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO trade_fills
         (account_id, exchange, symbol, external_id, side, price, qty, fee, time, order_type, created_at)
       VALUES (?, 'csv', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const counts = new Map();
    let inserted = 0;
    let skipped = 0;
    for (const f of fills) {
      if (!f?.symbol || !Number(f.time) || !(Number(f.qty) > 0) || !(Number(f.price) > 0)) { skipped++; continue; }
      const side = f.side === 'buy' ? 'buy' : 'sell';
      const base = f.id
        ? `csvf:raw:${f.id}`
        : `csvf:${hash64([f.symbol, side, Number(f.price), Number(f.qty), Number(f.fee) || 0, Math.floor(Number(f.time))].join('|'))}`;
      const seen = counts.get(base) || 0;
      counts.set(base, seen + 1);
      const r = stmt.run(
        Number(accountId), String(f.symbol), seen ? `${base}:${seen}` : base,
        side,
        Number(f.price) || 0, Number(f.qty) || 0, Number(f.fee) || 0,
        Math.floor(Number(f.time) || 0), f.orderType ? String(f.orderType) : null, nowIso(),
      );
      if (Number(r.changes) > 0) inserted++; else skipped++;
    }
    return { inserted, skipped };
  });
}

/**
 * 重算后清理幻影回合：删除该 symbol 下指定来源、external_id 以指定前缀开头
 * 但不在重算集合里的交易。删除前把挂在这些交易上的资金费事件释放为未分配，
 * 下一次同步会重新分配到正确回合。
 * source 默认 'api'（同步管道）；CSV 重建通道传 'csv'，两条通道互不误伤。
 */
export function pruneTradesNotIn(accountId, exchange, symbol, keepIds, { source = 'api' } = {}) {
  const keep = new Set((keepIds || []).map(String));
  const rows = all(
    `SELECT id, external_id FROM trades
     WHERE account_id = ? AND source = ? AND market = 'futures'
       AND symbol = ? AND trashed_at IS NULL AND external_id LIKE ?`,
    Number(accountId), String(source), String(symbol), `${exchange}:%`,
  );
  const dead = rows.filter((r) => !keep.has(String(r.external_id))).map((r) => Number(r.id));
  if (!dead.length) return 0;
  return tx((db) => {
    const release = db.prepare('UPDATE funding_events SET trade_id = NULL WHERE trade_id = ?');
    const del = db.prepare('DELETE FROM trades WHERE id = ?');
    let n = 0;
    for (const id of dead) {
      release.run(id);
      n += Number(del.run(id).changes) || 0;
    }
    return n;
  });
}

/**
 * CSV 重建通道（source='csv'、指定 external_id 前缀）下某 symbol 的现存回合。
 * source 传 null 时不限来源（跨通道去重时回合可能落在 api 行上）。
 */
export function listFillLaneTrades(accountId, symbol, prefix, { source = 'csv' } = {}) {
  const params = [Number(accountId), String(symbol), `${prefix}:%`];
  const sourceClause = source ? 'AND tr.source = ?' : '';
  if (source) params.push(String(source));
  return all(
    `SELECT tr.id, tr.external_id, tr.side, tr.open_time, tr.close_time, tr.note,
       (SELECT COUNT(*) FROM trade_tags tt WHERE tt.trade_id = tr.id) AS tag_count
     FROM trades tr
     WHERE tr.account_id = ? AND tr.symbol = ? AND tr.market = 'futures'
       AND tr.trashed_at IS NULL AND tr.external_id LIKE ? ${sourceClause}`,
    ...params,
  );
}

/**
 * 把将被清理的旧回合上的复盘内容迁移到重算出的新回合（同方向、开/平时间
 * 至少一端相差 < 3 分钟，取更近者）。重算改变配对时回合的行 ID 会变，
 * 没有这一步用户的笔记和标签会跟着旧行一起被删。
 */
export function mergeTradeAnnotations(fromId, toId) {
  const from = Number(fromId);
  const to = Number(toId);
  if (!from || !to || from === to) return 0;
  return tx((db) => {
    const src = db.prepare('SELECT note FROM trades WHERE id = ?').get(from);
    const dst = db.prepare('SELECT note FROM trades WHERE id = ?').get(to);
    if (!src || !dst) return 0;
    let n = 0;
    if (src.note && String(src.note).trim() && !(dst.note && String(dst.note).trim())) {
      db.prepare('UPDATE trades SET note = ?, note_updated_at = ? WHERE id = ?')
        .run(src.note, nowIso(), to);
      n++;
    }
    const dstHasTags = db.prepare('SELECT COUNT(*) AS c FROM trade_tags WHERE trade_id = ?').get(to).c > 0;
    if (!dstHasTags) {
      n += Number(db.prepare(
        'INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) SELECT ?, tag_id FROM trade_tags WHERE trade_id = ?',
      ).run(to, from).changes) || 0;
    }
    return n > 0 ? 1 : 0;
  });
}

/* ---------------- 交易 ---------------- */

function attachTagsToRows(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  // IN 占位符有上限（3.2 万），交易数增长后分批查询
  const links = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    links.push(...all(
      `SELECT tt.trade_id, t.name FROM trade_tags tt
       JOIN tags t ON t.id = tt.tag_id
       WHERE tt.trade_id IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name`,
      ...chunk,
    ));
  }
  const byTrade = new Map();
  for (const link of links) {
    if (!byTrade.has(link.trade_id)) byTrade.set(link.trade_id, []);
    byTrade.get(link.trade_id).push(link.name);
  }
  // 行对象刚从查询构造出来，直接原地挂 tags，避免 10 万行级别的对象展开开销。
  for (const r of rows) r.tags = byTrade.get(r.id) || [];
  return rows;
}

export function listTrades({ accountId = null, limit = null, withTags = true } = {}) {
  const params = [];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
             FROM trades tr JOIN accounts a ON a.id = tr.account_id
             WHERE tr.trashed_at IS NULL`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.close_time DESC, tr.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  const rows = all(sql, ...params);
  return withTags ? attachTagsToRows(rows) : rows;
}

export function countTrades() {
  return Number(get('SELECT COUNT(*) AS n FROM trades WHERE trashed_at IS NULL').n);
}

/** 只取数量的轻量统计，避免为计数拉全表 */
export function countTradesBySource(source) {
  return Number(get('SELECT COUNT(*) AS n FROM trades WHERE trashed_at IS NULL AND source = ?', String(source)).n);
}

/** 区间查询：复盘/日历只需要一个周期或一个月的交易，不应加载全部历史。 */
export function listTradesBetween(fromIso, toIso, { accountId = null } = {}) {
  const params = [String(fromIso), String(toIso)];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
             FROM trades tr JOIN accounts a ON a.id = tr.account_id
             WHERE tr.trashed_at IS NULL AND tr.close_time >= ? AND tr.close_time <= ?`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.close_time DESC, tr.id DESC';
  return attachTagsToRows(all(sql, ...params));
}

export function countTradesBetween(fromIso, toIso, { accountId = null } = {}) {
  const params = [String(fromIso), String(toIso)];
  let sql = 'SELECT COUNT(*) AS n FROM trades WHERE trashed_at IS NULL AND close_time >= ? AND close_time <= ?';
  if (accountId) { sql += ' AND account_id = ?'; params.push(Number(accountId)); }
  return Number(get(sql, ...params).n);
}

/**
 * 列表页筛选条件下沉到 SQL：与 stats.filterTrades 保持同一口径，
 * 但只返回当前页（最多 1000 行），避免把整张 trades 表物化进 JS。
 * 统计类页面走 analyzeCachedLazy；这里服务交易记录、API 列表与导出分批读取。
 */
function tradeFilterSql(filters = {}) {
  const where = ['tr.trashed_at IS NULL'];
  const params = [];
  const accountId = filters.accountId ?? filters.account_id;
  if (accountId && accountId !== 'all') {
    const id = Number(accountId);
    if (Number.isFinite(id)) {
      where.push('tr.account_id = ?');
      params.push(id);
    } else {
      where.push('0'); // 非法 account_id 与旧逻辑一致：返回空集
    }
  }
  if (filters.market && filters.market !== 'all') {
    where.push("COALESCE(NULLIF(tr.market, ''), 'futures') = ?");
    params.push(String(filters.market));
  }
  if (filters.side && filters.side !== 'all') {
    where.push('tr.side = ?');
    params.push(String(filters.side));
  }
  if (filters.result === 'win') where.push('tr.pnl > 0');
  else if (filters.result && filters.result !== 'all') where.push('tr.pnl <= 0');
  if (filters.symbol && filters.symbol !== 'all') {
    where.push('tr.symbol = ?');
    params.push(String(filters.symbol));
  }
  if (filters.orderType && filters.orderType !== 'all') {
    where.push("COALESCE(NULLIF(tr.order_type, ''), 'other') = ?");
    params.push(String(filters.orderType));
  }
  if (filters.tag) {
    where.push(`EXISTS (
      SELECT 1 FROM trade_tags tt JOIN tags tg ON tg.id = tt.tag_id
      WHERE tt.trade_id = tr.id AND tg.name = ?
    )`);
    params.push(String(filters.tag));
  }
  if (filters.note === 'yes') where.push("TRIM(COALESCE(tr.note, '')) <> ''");
  else if (filters.note === 'no') where.push("TRIM(COALESCE(tr.note, '')) = ''");
  if (filters.from) {
    const start = localDayStartUtc(dayKeyOf(filters.from));
    if (start) { where.push('tr.close_time >= ?'); params.push(start.toISOString()); }
  }
  if (filters.to) {
    const end = localDayEndExclusiveUtc(dayKeyOf(filters.to));
    if (end) { where.push('tr.close_time < ?'); params.push(end.toISOString()); }
  }
  if (filters.q) {
    const kw = String(filters.q).trim().toLowerCase();
    if (kw) {
      // LIKE 的通配符必须转义，否则用户输入 % / _ 会变成模式匹配。
      const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(
        LOWER(tr.symbol) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(tr.note, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM trade_tags tt JOIN tags tg ON tg.id = tt.tag_id
          WHERE tt.trade_id = tr.id AND LOWER(tg.name) LIKE ? ESCAPE '\\'
        )
      )`);
      params.push(like, like, like);
    }
  }
  return { whereSql: where.join(' AND '), params };
}

const TRADE_SORTS = {
  time: 'tr.close_time DESC, tr.id DESC',
  timeAsc: 'tr.close_time ASC, tr.id ASC',
  pnl: 'tr.pnl DESC, tr.close_time DESC, tr.id DESC',
  // julianday 的浮点尾差会让“同为 2 小时”的交易日排序漂移，统一取整到毫秒。
  duration: 'CAST(ROUND((julianday(tr.close_time) - julianday(tr.open_time)) * 86400000) AS INTEGER) DESC, tr.close_time DESC, tr.id DESC',
  size: 'tr.notional DESC, tr.close_time DESC, tr.id DESC',
};

export function countTradesFiltered(filters = {}) {
  const { whereSql, params } = tradeFilterSql(filters);
  return Number(get(`SELECT COUNT(*) AS n FROM trades tr WHERE ${whereSql}`, ...params).n);
}

export function listTradesPage(filters = {}, { limit = 50, offset = 0, withTags = true } = {}) {
  const { whereSql, params } = tradeFilterSql(filters);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const order = TRADE_SORTS[filters.sort] || TRADE_SORTS.time;
  const rows = all(
    `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
     FROM trades tr JOIN accounts a ON a.id = tr.account_id
     WHERE ${whereSql}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    ...params, lim, off,
  );
  return withTags ? attachTagsToRows(rows) : rows;
}

/** 列表页 symbol 下拉：只取去重后的符号，不拉交易明细。 */
export function listTradeSymbols(accountId = null) {
  const params = [];
  let sql = 'SELECT DISTINCT symbol FROM trades WHERE trashed_at IS NULL';
  if (accountId && accountId !== 'all') {
    const id = Number(accountId);
    if (!Number.isFinite(id)) return [];
    sql += ' AND account_id = ?';
    params.push(id);
  }
  sql += ' ORDER BY symbol';
  return all(sql, ...params).map((r) => r.symbol);
}

/** 列表页复盘覆盖率：聚合查询，避免为两个数字加载全表。 */
export function tradeNoteCoverage(accountId = null) {
  const params = [];
  let sql = `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN TRIM(COALESCE(note, '')) <> '' THEN 1 ELSE 0 END), 0) AS noted
             FROM trades WHERE trashed_at IS NULL`;
  if (accountId && accountId !== 'all') {
    const id = Number(accountId);
    if (!Number.isFinite(id)) return { total: 0, noted: 0, ratio: 0 };
    sql += ' AND account_id = ?';
    params.push(id);
  }
  const row = get(sql, ...params);
  const total = Number(row?.total) || 0;
  const noted = Number(row?.noted) || 0;
  return { total, noted, ratio: total ? noted / total : 0 };
}

/**
 * 数据版本指纹：analyze 等重计算结果的缓存失效键。
 * 单次聚合查询，代价远低于全量统计；覆盖行数、盈亏总和、最近更新时间、
 * 垃圾箱数量与标签挂载数。标签改名不产生新行（盲区仅限标签分组显示名），
 * 属可接受的取舍。
 */
export function tradesVersion() {
  const row = get(`
    SELECT COUNT(*) AS n,
           COALESCE(MAX(id), 0) AS max_id,
           COALESCE(SUM(ROUND(pnl * 100)), 0) AS pnl_sum,
           COALESCE(MAX(updated_at), '') AS last_update,
           COALESCE(MAX(note_updated_at), '') AS last_note,
           (SELECT COUNT(*) FROM trades WHERE trashed_at IS NOT NULL) AS trashed,
           (SELECT COUNT(*) FROM trade_tags) AS tag_links
     FROM trades`);
  return `${row.n}|${row.max_id}|${row.pnl_sum}|${row.last_update}|${row.last_note}|${row.trashed}|${row.tag_links}`;
}

export function getTrade(id) {
  const row = get(
    `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange, a.is_demo AS account_is_demo
     FROM trades tr JOIN accounts a ON a.id = tr.account_id WHERE tr.id = ?`,
    Number(id),
  );
  if (!row) return null;
  return attachTagsToRows([row])[0];
}

function tradeColumns() {
  return [
    'account_id', 'external_id', 'symbol', 'side', 'order_type', 'size', 'notional',
    'entry_price', 'exit_price', 'open_time', 'close_time', 'pnl', 'fee', 'funding',
    'source', 'market', 'note', 'note_updated_at',
  ];
}

/** 纪律标记：仅接受 1（按计划）/ 0（违反）/ null（未标记） */
function followedPlanOf(input) {
  if (input.followed_plan === undefined) return undefined;
  if (input.followed_plan === null || input.followed_plan === '') return null;
  return Number(input.followed_plan) === 1 ? 1 : 0;
}

export function createTrade(input, { accountId } = {}) {
  const at = nowIso();
  const account = Number(accountId) || Number(input.account_id) || ensureDefaultAccount().id;
  const row = {
    account_id: account,
    external_id: input.external_id ?? null,
    symbol: String(input.symbol || '').trim().toUpperCase(),
    side: input.side === 'short' ? 'short' : 'long',
    order_type: input.order_type || 'market',
    size: Number(input.size) || 0,
    notional: Number(input.notional) || 0,
    entry_price: Number(input.entry_price) || 0,
    exit_price: Number(input.exit_price) || 0,
    open_time: input.open_time,
    close_time: input.close_time,
    pnl: Number(input.pnl) || 0,
    fee: Number(input.fee) || 0,
    funding: Number(input.funding) || 0,
    source: input.source || 'manual',
    market: input.market === 'spot' ? 'spot' : 'futures',
    note: input.note || null,
    note_updated_at: input.note ? at : null,
  };
  if (!row.symbol) throw new Error('币种不能为空');
  if (!row.open_time || !row.close_time) throw new Error('开仓/平仓时间不能为空');
  if (new Date(row.open_time) > new Date(row.close_time)) throw new Error('开仓时间不能晚于平仓时间');

  const cols = [...tradeColumns(), 'created_at', 'updated_at'];
  const values = [...tradeColumns().map((key) => row[key]), at, at];
  const r = run(
    `INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...values,
  );
  const id = Number(r.lastInsertRowid);
  const plan = followedPlanOf(input);
  if (plan !== undefined) run('UPDATE trades SET followed_plan = ? WHERE id = ?', plan, id);
  if (Array.isArray(input.tags) && input.tags.length) setTradeTags(id, input.tags);
  return id;
}

export function updateTrade(id, input) {
  const current = getTrade(id);
  if (!current) throw new Error('交易记录不存在');
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  };
  const at = nowIso();
  const noteChanged = input.note !== undefined && String(input.note || '') !== String(current.note || '');
  const plan = followedPlanOf(input);
  run(
    `UPDATE trades SET account_id = ?, symbol = ?, side = ?, order_type = ?, size = ?, notional = ?,
       entry_price = ?, exit_price = ?, open_time = ?, close_time = ?, pnl = ?, fee = ?, funding = ?,
       note = ?, note_updated_at = ?, updated_at = ? WHERE id = ?`,
    Number(next.account_id),
    String(next.symbol || '').trim().toUpperCase(),
    next.side === 'short' ? 'short' : 'long',
    next.order_type || 'market',
    Number(next.size) || 0,
    Number(next.notional) || 0,
    Number(next.entry_price) || 0,
    Number(next.exit_price) || 0,
    next.open_time,
    next.close_time,
    Number(next.pnl) || 0,
    Number(next.fee) || 0,
    Number(next.funding) || 0,
    next.note || null,
    noteChanged ? at : (next.note_updated_at || null),
    at,
    Number(id),
  );
  if (plan !== undefined) run('UPDATE trades SET followed_plan = ? WHERE id = ?', plan, Number(id));
  if (Array.isArray(input.tags)) setTradeTags(id, input.tags);
  return getTrade(id);
}

export function setTradeNote(id, note) {
  const text = String(note || '');
  const at = nowIso();
  run(
    'UPDATE trades SET note = ?, note_updated_at = ?, updated_at = ? WHERE id = ?',
    text.trim() ? text : null,
    text.trim() ? at : null,
    at,
    Number(id),
  );
}

export function deleteTrade(id) {
  run('DELETE FROM trades WHERE id = ?', Number(id));
}

/* ---------------- 垃圾箱（软删除） ---------------- */
//
// 交易所同步按 external_id 去重：硬删除的记录下次同步会被原样导回。
// 移入垃圾箱的行保留在 trades 表里（trashed_at 非空），同步按「已存在」跳过，
// 因此不会再出现；所有统计/列表查询都会排除它，恢复即回到原状态（标签、笔记一起保留）。

export function trashTrade(id) {
  run('UPDATE trades SET trashed_at = ?, updated_at = ? WHERE id = ? AND trashed_at IS NULL',
    nowIso(), nowIso(), Number(id));
}

export function restoreTrade(id) {
  run('UPDATE trades SET trashed_at = NULL, updated_at = ? WHERE id = ?', nowIso(), Number(id));
}

export function listTrashedTrades({ limit = 200, q = '' } = {}) {
  const base = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
       FROM trades tr JOIN accounts a ON a.id = tr.account_id
      WHERE tr.trashed_at IS NOT NULL`;
  const kw = String(q || '').trim();
  if (!kw) {
    return all(
      `${base} ORDER BY tr.trashed_at DESC, tr.id DESC LIMIT ?`,
      Math.min(Math.max(Number(limit) || 200, 1), 500),
    );
  }
  // 搜索覆盖整个垃圾箱，不套用无关键词时的展示上限；通配符按字面匹配
  const like = `%${kw.replace(/[\\%_]/g, '\\$&')}%`;
  return all(
    `${base} AND (tr.symbol LIKE ? ESCAPE '\\'
        OR IFNULL(tr.note, '') LIKE ? ESCAPE '\\'
        OR IFNULL(a.name, '') LIKE ? ESCAPE '\\')
      ORDER BY tr.trashed_at DESC, tr.id DESC`,
    like, like, like,
  );
}

export function countTrashedTrades() {
  return Number(get('SELECT COUNT(*) AS n FROM trades WHERE trashed_at IS NOT NULL').n) || 0;
}

/* ---------------- 错过交易记录 ---------------- */

export const MISSED_STATUSES = ['open', 'win', 'lose', 'expired'];
const MISSED_STATUS_LABEL = { open: '观察中', win: '方向对', lose: '方向错', expired: '过期' };

/** 假想盈亏比：按方向计算 目标距离 ÷ 止损距离；分母为 0 或价格缺失时返回 null */
export function missedRr(row) {
  const entry = Number(row.entry_price);
  const stop = Number(row.stop_price);
  const target = Number(row.target_price);
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return null;
  const denom = row.direction === 'short' ? stop - entry : entry - stop;
  const reward = row.direction === 'short' ? entry - target : target - entry;
  if (!(denom > 0)) return null;
  return reward / denom;
}

export function listMissedTrades({ limit = 200 } = {}) {
  return all(`SELECT * FROM missed_trades ORDER BY id DESC LIMIT ?`, Number(limit) || 200)
    .map((r) => ({ ...r, statusLabel: MISSED_STATUS_LABEL[r.status] || r.status, rr: missedRr(r) }));
}

export function createMissedTrade({ symbol, direction, entryPrice, stopPrice, targetPrice, note }) {
  const row = {
    symbol: String(symbol || '').trim().toUpperCase(),
    direction: direction === 'short' ? 'short' : 'long',
    entry_price: Number(entryPrice) || null,
    stop_price: Number(stopPrice) || null,
    target_price: Number(targetPrice) || null,
    note: String(note || '').slice(0, 2000),
  };
  if (!row.symbol) throw new Error('币种不能为空');
  const at = nowIso();
  const r = run(
    `INSERT INTO missed_trades (symbol, direction, entry_price, stop_price, target_price, note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    row.symbol, row.direction, row.entry_price, row.stop_price, row.target_price, row.note, at, at,
  );
  return Number(r.lastInsertRowid);
}

export function setMissedTradeStatus(id, status) {
  if (!MISSED_STATUSES.includes(String(status))) throw new Error(`未知状态：${status}`);
  run('UPDATE missed_trades SET status = ?, updated_at = ? WHERE id = ?', String(status), nowIso(), Number(id));
}

export function deleteMissedTrade(id) {
  run('DELETE FROM missed_trades WHERE id = ?', Number(id));
}

/** 批量导入（带事务、去重、标签） */
export function importTrades(trades, accountId, { upsert = false } = {}) {
  const at = nowIso();
  const result = tx((db) => {
    let inserted = 0;
    let skipped = 0;
    let updated = 0;
    const insert = db.prepare(
      `INSERT INTO trades (account_id, external_id, symbol, side, order_type, size, notional,
         entry_price, exit_price, open_time, close_time, pnl, fee, funding, source, market, kind, note,
         note_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const exists = db.prepare(
      'SELECT id, source, funding, pnl, trashed_at FROM trades WHERE account_id = ? AND external_id = ?',
    );
    // OKX 偶尔补写行的 openTime（如从 cTime 整秒值精化为实际成交时间），同一回合
    // 会带着新外部 ID 再来一次。按 posId + 盈亏/数量指纹做二次匹配：命中则改键并回写，
    // 而不是插入重复记录。时间窗口 180s 内，避免误并同 posId 的相邻独立回合。
    const byFingerprint = db.prepare(
      `SELECT id, funding, trashed_at FROM trades WHERE account_id = ? AND source = 'api' AND external_id LIKE ?
         AND symbol = ? AND ABS(pnl - ?) < 1e-9 AND ABS(size - ?) < 1e-9
         AND ABS(strftime('%s', close_time) * 1000 - ?) < 180000 LIMIT 1`,
    );
    const rekey = db.prepare('UPDATE trades SET external_id = ? WHERE id = ?');
    // upsert 只更新交易所侧字段；复盘笔记、标签、创建时间保留。
    // order_type 入参为 'other'（未知）时保留库值：OKX 的 positions-history 恒给 'other'，
    // 直接覆盖会把 enrichIdle 刚补好的吃挂分类冲掉，造成反复重分类。
    const updateApi = db.prepare(
      `UPDATE trades SET symbol = ?, side = ?,
         order_type = CASE WHEN ? = 'other' THEN order_type ELSE ? END,
         size = ?, notional = ?,
         entry_price = ?, exit_price = ?, open_time = ?, close_time = ?, pnl = ?, fee = ?, funding = ?,
         updated_at = ? WHERE id = ?`,
    );
    const seen = new Set();
    // gate/binance 的逐笔接口不带资金费字段：直接回写会把 applyFundingEvents
    // 已分配的资金费（连同等额的 pnl 调整）抹掉。入参 funding=0 且库里已有
    // 非零资金费时，沿用库值并把等额加回 pnl，保持「毛盈亏 = 净盈亏 − 手续费 − 资金费」。
    const mergeFunding = (incoming, existing) => {
      const funding = Number(incoming) || 0;
      const prior = Number(existing) || 0;
      return funding === 0 && prior !== 0
        ? { funding: prior, pnlShift: prior }
        : { funding, pnlShift: 0 };
    };
    for (const trade of trades) {
      const ext = trade.external_id || `csv:${uid()}`;
      if (seen.has(ext)) { skipped++; continue; }
      const found = exists.get(Number(accountId), ext);
      if (found) {
        // 垃圾箱记录：用户明确不要这条数据，同步不再导回/回写（恢复后才会重新参与）
        if (found.trashed_at) { skipped++; seen.add(ext); continue; }
        // OKX 部分平仓会原地更新仓位历史行：api 行允许回写最终状态，其余来源一律跳过
        if (upsert && found.source === 'api' && trade.source === 'api') {
          const mf = mergeFunding(trade.funding, found.funding);
          const ot = trade.order_type || 'other';
          updateApi.run(
            String(trade.symbol || ''), String(trade.side || 'long'), ot, ot,
            Number(trade.size) || 0, Number(trade.notional) || 0,
            Number(trade.entry_price) || 0, Number(trade.exit_price) || 0,
            trade.open_time, trade.close_time,
            (Number(trade.pnl) || 0) + mf.pnlShift, Number(trade.fee) || 0, mf.funding,
            at, found.id,
          );
          updated++;
        } else {
          skipped++;
        }
        seen.add(ext);
        continue;
      }
      // openTime 漂移的同一回合：按指纹找到旧行，改键到新 ID 并回写最终状态
      const okxId = /^okx:(\d+):\d+$/.exec(ext);
      if (upsert && okxId && trade.source === 'api') {
        const closeMs = Date.parse(trade.close_time || '');
        const twin = Number.isFinite(closeMs)
          ? byFingerprint.get(
              Number(accountId), `okx:${okxId[1]}:%`, String(trade.symbol || ''),
              Number(trade.pnl) || 0, Number(trade.size) || 0, closeMs,
            )
          : null;
        if (twin && twin.trashed_at) {
          skipped++;
          seen.add(ext);
          continue;
        }
        if (twin) {
          const mf = mergeFunding(trade.funding, twin.funding);
          rekey.run(ext, twin.id);
          const ot = trade.order_type || 'other';
          updateApi.run(
            String(trade.symbol || ''), String(trade.side || 'long'), ot, ot,
            Number(trade.size) || 0, Number(trade.notional) || 0,
            Number(trade.entry_price) || 0, Number(trade.exit_price) || 0,
            trade.open_time, trade.close_time,
            (Number(trade.pnl) || 0) + mf.pnlShift, Number(trade.fee) || 0, mf.funding,
            at, twin.id,
          );
          updated++;
          seen.add(ext);
          continue;
        }
      }
      const r = insert.run(
        Number(accountId), ext, trade.symbol, trade.side, trade.order_type || 'other',
        Number(trade.size) || 0, Number(trade.notional) || 0,
        Number(trade.entry_price) || 0, Number(trade.exit_price) || 0,
        trade.open_time, trade.close_time,
        Number(trade.pnl) || 0, Number(trade.fee) || 0, Number(trade.funding) || 0,
        trade.source || 'csv', trade.market === 'spot' ? 'spot' : 'futures',
        trade.kind === 't_shot' ? 't_shot' : null,
        trade.note || null, trade.note ? at : null, at, at,
      );
      const tradeId = Number(r.lastInsertRowid);
      if (Array.isArray(trade.tags) && trade.tags.length) {
        for (const name of trade.tags) {
          const tag = getOrCreateTag(String(name));
          db.prepare('INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) VALUES (?, ?)')
            .run(tradeId, tag.id);
        }
      }
      seen.add(ext);
      inserted++;
    }
    return { inserted, skipped, updated };
  });
  // 交易落库后尝试归档挂起的持仓笔记（本函数在 sync/csv/重建三条管道都被调用）。
  // 必须在事务外执行：archivePositionNotes 内部自开事务。
  archivePositionNotes(accountId);
  return result;
}

/* ---------------- 标签 ---------------- */

export function listTags() {
  return all('SELECT * FROM tags ORDER BY name ASC');
}

export function listTagsWithCounts() {
  return all(
    `SELECT t.id, t.name, t.color, COUNT(tt.trade_id) AS count
     FROM tags t LEFT JOIN trade_tags tt ON tt.tag_id = t.id
     GROUP BY t.id ORDER BY count DESC, t.name ASC`,
  );
}

/** 仪表盘「优先复盘」的快捷标签；null 表示未配置，按最常用自动挑 */
export function getQuickTags() {
  const raw = getMeta('quick_tags', '');
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const clean = arr.map((x) => String(x).trim()).filter(Boolean);
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

export function setQuickTags(names) {
  const clean = [...new Set((names || []).map((x) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
  setMeta('quick_tags', clean.length ? JSON.stringify(clean) : '');
  return clean;
}

export function getOrCreateTag(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('标签名不能为空');
  const existing = get('SELECT * FROM tags WHERE name = ?', clean);
  if (existing) return existing;
  run('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)', clean, '#4ade80', nowIso());
  return get('SELECT * FROM tags WHERE name = ?', clean);
}

export function createTag(name, color = '#4ade80') {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('标签名不能为空');
  const existing = get('SELECT * FROM tags WHERE name = ?', clean);
  if (existing) return existing;
  run('INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)', clean, color, nowIso());
  return get('SELECT * FROM tags WHERE name = ?', clean);
}

export function deleteTag(id) {
  run('DELETE FROM tags WHERE id = ?', Number(id));
}

export function setTradeTags(tradeId, names) {
  tx((db) => {
    db.prepare('DELETE FROM trade_tags WHERE trade_id = ?').run(Number(tradeId));
    for (const name of [...new Set((names || []).map((x) => String(x).trim()).filter(Boolean))]) {
      const tag = getOrCreateTag(name);
      db.prepare('INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) VALUES (?, ?)')
        .run(Number(tradeId), tag.id);
    }
  });
}

/** 切换一笔交易的某个标签（有则移除、无则加上），不改其他标签 */
export function toggleTradeTag(tradeId, name) {
  const tag = getOrCreateTag(String(name || '').trim());
  if (!tag) return null;
  const has = get(
    'SELECT 1 AS x FROM trade_tags WHERE trade_id = ? AND tag_id = ?',
    Number(tradeId), tag.id,
  );
  if (has) {
    run('DELETE FROM trade_tags WHERE trade_id = ? AND tag_id = ?', Number(tradeId), tag.id);
    return { tag: tag.name, attached: false };
  }
  run('INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) VALUES (?, ?)', Number(tradeId), tag.id);
  return { tag: tag.name, attached: true };
}

/** 更新一笔交易的委托类型（limit=纯挂单 market=纯吃单 mixed=吃挂均有 other=未知） */
export function setTradeOrderType(tradeId, orderType) {
  const allowed = ['limit', 'market', 'mixed', 'other'];
  if (!allowed.includes(orderType)) return;
  run('UPDATE trades SET order_type = ?, updated_at = ? WHERE id = ?', orderType, nowIso(), Number(tradeId));
}

/** 未分类（other）的 API 回合，最新优先——供后台逐笔补充吃挂分类。
 *  只取近 85 天：交易所逐笔成交保留期最长约 3 个月，更早的已无法分类 */
export function listUnclassifiedEpisodes(accountId = null, limit = 1) {
  const params = [new Date(Date.now() - 85 * 86400_000).toISOString()];
  let sql = `SELECT tr.id, tr.symbol, tr.market, tr.side, tr.entry_price, tr.exit_price, tr.size,
      tr.open_time, tr.close_time, a.exchange
    FROM trades tr JOIN accounts a ON a.id = tr.account_id
    WHERE tr.source = 'api' AND tr.trashed_at IS NULL AND tr.order_type = 'other' AND tr.close_time >= ?`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.close_time DESC LIMIT ?';
  params.push(Math.max(1, Math.min(50, Number(limit) || 1)));
  return all(sql, ...params);
}

/** 优先复盘队列：还没写复盘笔记的大亏交易（按亏损从大到小） */export function listReviewQueue({ threshold = 0, accountId = null, limit = 8 } = {}) {
  const params = [Number(threshold)];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
    FROM trades tr JOIN accounts a ON a.id = tr.account_id
    WHERE tr.trashed_at IS NULL AND tr.pnl <= ? AND (tr.note IS NULL OR tr.note = '')`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.pnl ASC LIMIT ?';
  params.push(Math.max(1, Math.min(20, Number(limit) || 8)));
  return attachTagsToRows(all(sql, ...params));
}

/* ---------------- 网络代理配置（设置页可改，15s 生效） ---------------- */

let netCfgCache = { at: 0, proxy: '', hosts: '' };
/** 保存代理设置后立即失效缓存，下次请求即用新值 */
export function resetNetProxyCache() {
  netCfgCache = { at: 0, proxy: '', hosts: '' };
}
setExchangeProxyProvider(() => {
  if (Date.now() - netCfgCache.at > 15000) {
    netCfgCache = {
      at: Date.now(),
      proxy: getMeta('net_exchange_proxy', ''),
      hosts: getMeta('net_exchange_proxy_hosts', ''),
    };
  }
  return netCfgCache;
});

/* ---------------- 笔记 ---------------- */

const NOTE_CATEGORIES = new Set(['general', 'periodic', 'symbol', 'strategy', 'spot', 'ai-report']);

export function listNotes({ category = null, subject = null, accountId = null, q = null } = {}) {
  const where = [];
  const params = [];
  if (category) { where.push('n.category = ?'); params.push(String(category)); }
  if (subject !== null && subject !== undefined && subject !== '') { where.push('n.subject = ?'); params.push(String(subject)); }
  if (accountId !== null && accountId !== undefined && accountId !== '') { where.push('n.account_id = ?'); params.push(Number(accountId)); }
  if (q && String(q).trim()) {
    // 转义 LIKE 通配符，用户输入的 % _ \ 按字面匹配
    const like = `%${String(q).trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push(`(n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' OR n.subject LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  return all(
    `SELECT n.*, a.name AS account_name
       FROM notes n
       LEFT JOIN accounts a ON a.id = n.account_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY n.updated_at DESC, n.id DESC`,
    ...params,
  );
}

export function getNote(id) {
  return get(
    `SELECT n.*, a.name AS account_name
       FROM notes n
       LEFT JOIN accounts a ON a.id = n.account_id
      WHERE n.id = ?`,
    Number(id),
  ) || null;
}

export function getNoteByCategory(category, subject, accountId = null) {
  if (accountId !== null && accountId !== undefined && accountId !== '') {
    // spot 可能有多段（清仓重买），最新的在最前；id 兜底打破同一毫秒的平局
    return get(
      `SELECT * FROM notes
        WHERE category = ? AND account_id = ? AND subject = ?
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
      String(category), Number(accountId), String(subject || ''),
    ) || null;
  }
  if (!subject) return null;
  return get(
    'SELECT * FROM notes WHERE category = ? AND subject = ? ORDER BY updated_at DESC LIMIT 1',
    String(category), String(subject),
  ) || null;
}

export function noteCountsByCategory() {
  const out = { all: 0, periodic: 0, symbol: 0, strategy: 0, spot: 0, 'ai-report': 0, general: 0 };
  for (const row of all('SELECT category, COUNT(*) AS count FROM notes GROUP BY category')) {
    const key = NOTE_CATEGORIES.has(row.category) ? row.category : 'general';
    out[key] += Number(row.count) || 0;
    out.all += Number(row.count) || 0;
  }
  return out;
}

export function saveNote({
  id = null, title, content, category = 'general', subject = null, market = null, accountId = null,
}) {
  const at = nowIso();
  const cleanCategory = NOTE_CATEGORIES.has(String(category)) ? String(category) : 'general';
  const cleanSubject = subject === null || subject === undefined || String(subject).trim() === ''
    ? null
    : String(subject).trim().slice(0, 120);
  const cleanAccountId = accountId === null || accountId === undefined || accountId === ''
    ? null
    : Number(accountId);
  const cleanMarket = market === 'spot' || market === 'futures' ? market : null;

  let cleanTitle = String(title || '').trim().slice(0, 200);
  if (!cleanTitle) {
    if (cleanCategory === 'symbol' && cleanSubject) cleanTitle = `${cleanSubject} 交易对档案`;
    else if (cleanCategory === 'strategy' && cleanSubject) cleanTitle = `${cleanSubject} 策略`;
    else if (cleanCategory === 'periodic' && cleanSubject) cleanTitle = `${cleanSubject} 周期复盘`;
    else if (cleanCategory === 'spot' && cleanSubject) cleanTitle = `${cleanSubject} 现货备注`;
    else cleanTitle = '未命名笔记';
  }
  if (cleanCategory === 'spot' && (!cleanAccountId || !cleanSubject)) {
    throw new Error('现货备注需要账户和交易对');
  }
  if (cleanCategory === 'symbol' && !cleanSubject) {
    throw new Error('交易对档案需要填写交易对');
  }

  let targetId = id ? Number(id) : null;
  if (!targetId && cleanCategory === 'symbol' && cleanSubject) {
    const existing = getNoteByCategory('symbol', cleanSubject);
    if (existing) targetId = Number(existing.id);
  }

  if (targetId) {
    if (cleanCategory === 'symbol' && cleanSubject) {
      const existing = getNoteByCategory('symbol', cleanSubject);
      if (existing && Number(existing.id) !== targetId) throw new Error('这个交易对已经有档案笔记了');
    }
    run(
      `UPDATE notes
          SET title = ?, content = ?, category = ?, subject = ?, market = ?, account_id = ?, updated_at = ?
        WHERE id = ?`,
      cleanTitle, String(content || ''), cleanCategory, cleanSubject, cleanMarket, cleanAccountId, at, targetId,
    );
    return targetId;
  }

  const r = run(
    `INSERT INTO notes (title, content, category, subject, market, account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cleanTitle, String(content || ''), cleanCategory, cleanSubject, cleanMarket, cleanAccountId, at, at,
  );
  return Number(r.lastInsertRowid);
}

export function saveSpotNote(accountId, symbol, note) {
  const acc = Number(accountId);
  const sym = String(symbol || '').trim();
  if (!acc || !sym) throw new Error('账户和交易对不能为空');
  // 普通保存总是更新最新一段（"编辑当前备注"的直觉）
  const existing = getNoteByCategory('spot', sym, acc);
  return saveNote({
    id: existing?.id || null,
    title: existing ? existing.title : `${sym} 现货备注`,
    content: String(note || ''),
    category: 'spot',
    subject: sym,
    market: 'spot',
    accountId: acc,
  });
}

/** 清仓后再买入时开一条新的现货备注；旧备注保留为历史 */
export function openNewSpotNote(accountId, symbol) {
  const acc = Number(accountId);
  const sym = String(symbol || '').trim();
  if (!acc || !sym) throw new Error('账户和交易对不能为空');
  const holding = listSpotHoldings(acc, sym)[0];
  if (!holding || !(Number(holding.quantity) > 0)) {
    throw new Error('当前没有持仓，无法开新备注');
  }
  const previous = get(
    `SELECT n.*, a.name AS account_name
       FROM notes n LEFT JOIN accounts a ON a.id = n.account_id
      WHERE n.category = 'spot' AND n.account_id = ? AND n.subject = ?
      ORDER BY n.updated_at DESC LIMIT 1`,
    acc, sym,
  );
  const seq = previous ? String(previous.title).match(/第\s*(\d+)\s*段$/) : null;
  const round = seq ? Number(seq[1]) + 1 : 2;
  return saveNote({
    title: `${sym} 现货备注 第${round}段`,
    content: '',
    category: 'spot',
    subject: sym,
    market: 'spot',
    accountId: acc,
  });
}

export function listSymbolsWithTradeNotes() {
  return all(
    `SELECT symbol, COUNT(*) AS count, MAX(close_time) AS last_time
       FROM trades
      WHERE trashed_at IS NULL AND note IS NOT NULL AND TRIM(note) <> ''
      GROUP BY symbol
      ORDER BY last_time DESC`,
  );
}

export function listTradeNotesBySymbol(symbol, limit = 50) {
  return all(
    `SELECT id, symbol, side, market, close_time, pnl, note
       FROM trades
      WHERE trashed_at IS NULL AND symbol = ? AND note IS NOT NULL AND TRIM(note) <> ''
      ORDER BY close_time DESC
      LIMIT ?`,
    String(symbol), Number(limit),
  );
}

export function listRecentTradeNotes(limit = 20) {
  return all(
    `SELECT id, symbol, side, market, close_time, pnl, note
       FROM trades
      WHERE trashed_at IS NULL AND note IS NOT NULL AND TRIM(note) <> ''
      ORDER BY COALESCE(note_updated_at, close_time) DESC
      LIMIT ?`,
    Number(limit),
  );
}

export function listSymbols() {
  return all(
    `SELECT symbol FROM trades GROUP BY symbol
     UNION
     SELECT symbol FROM spot_holdings GROUP BY symbol
     ORDER BY symbol`,
  ).map((r) => r.symbol);
}

export function listSpotTrades(limit = 50, accountId = null) {
  const params = [];
  let sql = `SELECT t.*, a.name AS account_name
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.market = 'spot' AND t.trashed_at IS NULL`;
  if (accountId) { sql += ' AND t.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY t.close_time DESC LIMIT ?';
  params.push(Number(limit));
  return all(sql, ...params);
}

export function listSpotTradesBySymbol(symbol, limit = 200) {
  return all(
    `SELECT t.*, a.name AS account_name
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.market = 'spot' AND t.trashed_at IS NULL AND t.symbol = ?
      ORDER BY t.close_time DESC
      LIMIT ?`,
    String(symbol), Number(limit),
  );
}

export function deleteNote(id) {
  run('DELETE FROM notes WHERE id = ?', Number(id));
}

/* ---------------- 会话 ---------------- */

export function createSession(tokenHash, expiresAt) {
  run('INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)', tokenHash, nowIso(), expiresAt);
}

export function getSession(tokenHash) {
  return get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash) || null;
}

export function deleteSession(tokenHash) {
  run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

/* ---------------- 导入审计 ---------------- */

export function recordImport({ accountId, filename, rows, inserted, skipped, failed }) {
  run(
    'INSERT INTO imports (account_id, filename, rows, inserted, skipped, failed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    Number(accountId), String(filename || '').slice(0, 300), Number(rows) || 0,
    Number(inserted) || 0, Number(skipped) || 0, Number(failed) || 0, nowIso(),
  );
}

export function listImports(limit = 20) {
  return all(
    `SELECT i.*, a.name AS account_name FROM imports i
     JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC LIMIT ?`,
    Number(limit),
  );
}

/* ---------------- meta / 维护 ---------------- */

/* ---------------- 周期报告 AI 生成记录 ---------------- */

export function saveReportGeneration({ accountId = null, periodKind, periodLabel, prompt, content, model = null, trades = 0 }) {
  const r = run(
    `INSERT INTO report_generations (account_id, period_kind, period_label, prompt, content, model, trades, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    accountId === null || accountId === undefined ? null : Number(accountId),
    String(periodKind), String(periodLabel), String(prompt || ''), String(content || ''),
    model ? String(model).slice(0, 120) : null, Number(trades) || 0, nowIso(),
  );
  return Number(r.lastInsertRowid);
}

export function latestReportGeneration(periodKind, periodLabel, accountId = null) {
  return get(
    `SELECT * FROM report_generations
      WHERE period_kind = ? AND period_label = ? AND account_id IS ?
      ORDER BY id DESC LIMIT 1`,
    String(periodKind), String(periodLabel),
    accountId === null || accountId === undefined ? null : Number(accountId),
  ) || null;
}

export function listReportGenerations(periodKind = null, limit = 30, accountId = undefined) {
  const params = [];
  let sql = `SELECT rg.id, rg.account_id, a.name AS account_name,
                    rg.period_kind, rg.period_label, rg.model, rg.trades, rg.created_at,
                    LENGTH(rg.content) AS content_len
             FROM report_generations rg LEFT JOIN accounts a ON a.id = rg.account_id`;
  const where = [];
  if (periodKind) { where.push('rg.period_kind = ?'); params.push(String(periodKind)); }
  if (accountId !== undefined) {
    where.push('rg.account_id IS ?');
    params.push(accountId === null ? null : Number(accountId));
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY rg.id DESC LIMIT ?';
  params.push(Number(limit) || 30);
  return all(sql, ...params);
}

export function getReportGeneration(id) {
  return get(
    `SELECT rg.*, a.name AS account_name FROM report_generations rg
     LEFT JOIN accounts a ON a.id = rg.account_id WHERE rg.id = ?`,
    Number(id),
  ) || null;
}

export function deleteReportGeneration(id) {
  run('DELETE FROM report_generations WHERE id = ?', Number(id));
}

/* ---------------- AI 报告生成任务（内存态） ---------------- */

const reportJobs = new Map(); // jobId -> { id, status, period, label, startedAt, finishedAt, error, reportId }
let reportJobSeq = 0;

export function createReportJob({ accountId = null, periodKind, periodLabel, promptLen }) {
  reportJobSeq += 1;
  const job = {
    id: `rj-${Date.now()}-${reportJobSeq}`,
    status: 'running',
    accountId: accountId === null || accountId === undefined ? null : Number(accountId),
    periodKind: String(periodKind),
    periodLabel: String(periodLabel),
    promptLen: Number(promptLen) || 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    reportId: null,
  };
  reportJobs.set(job.id, job);
  // 只保留最近 20 个任务，防内存膨胀
  const ids = [...reportJobs.keys()];
  while (ids.length > 20) reportJobs.delete(ids.shift());
  return job;
}

export function getReportJob(id) {
  return reportJobs.get(String(id)) || null;
}

export function updateReportJob(id, patch) {
  const job = reportJobs.get(String(id));
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function getMeta(key, fallback = null) {
  const row = get('SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

export function demoStatus() {
  const row = get(
    `SELECT COUNT(*) AS n FROM trades
     WHERE account_id IN (SELECT id FROM accounts WHERE is_demo = 1)`,
  );
  const accounts = Number(get('SELECT COUNT(*) AS n FROM accounts WHERE is_demo = 1').n);
  const trades = Number(row.n);
  return { active: trades > 0 || accounts > 0, trades, accounts };
}

export function statsOverview() {  return {
    trades: Number(get('SELECT COUNT(*) AS n FROM trades').n),
    accounts: Number(get('SELECT COUNT(*) AS n FROM accounts').n),
    tags: Number(get('SELECT COUNT(*) AS n FROM tags').n),
    notes: Number(get('SELECT COUNT(*) AS n FROM notes').n),
    demoAccounts: Number(get('SELECT COUNT(*) AS n FROM accounts WHERE is_demo = 1').n),
    imports: Number(get('SELECT COUNT(*) AS n FROM imports').n),
    syncRuns: Number(get('SELECT COUNT(*) AS n FROM sync_runs').n),
  };
}

export function clearDemoData() {
  return tx((db) => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM trades WHERE account_id IN (SELECT id FROM accounts WHERE is_demo = 1)').get();
    db.prepare("DELETE FROM asset_positions WHERE venue_kind = 'exchange' AND venue_id IN (SELECT id FROM accounts WHERE is_demo = 1)").run();
    db.prepare("DELETE FROM asset_sync_runs WHERE venue_kind = 'exchange' AND venue_id IN (SELECT id FROM accounts WHERE is_demo = 1)").run();
    db.prepare('DELETE FROM accounts WHERE is_demo = 1').run();
    db.prepare('DELETE FROM imports WHERE account_id NOT IN (SELECT id FROM accounts)').run();
    return { trades: Number(before.n) };
  });
}

export function clearAllData() {
  tx((db) => {
    // 先删子表再删父表；成交缓存、错失记录、AI 报告、现货日志与 meta（含密钥/设置）
    // 也必须清掉，否则“清空全部数据”后旧记录仍会通过 id 复用或统计缓存复活。
    db.exec(`DELETE FROM spot_log;
      DELETE FROM spot_fills; DELETE FROM spot_cost_basis; DELETE FROM spot_balances; DELETE FROM spot_holdings;
      DELETE FROM transfers; DELETE FROM funding_events; DELETE FROM balances; DELETE FROM positions;
      DELETE FROM position_notes; DELETE FROM resources; DELETE FROM sync_runs; DELETE FROM import_templates;
      DELETE FROM trade_tags; DELETE FROM trade_curves; DELETE FROM trade_fills_cache; DELETE FROM trade_fills;
      DELETE FROM missed_trades; DELETE FROM report_generations;
      DELETE FROM trades; DELETE FROM tags; DELETE FROM notes; DELETE FROM imports; DELETE FROM sessions;
      DELETE FROM asset_positions; DELETE FROM manual_assets; DELETE FROM asset_snapshots; DELETE FROM asset_sync_runs;
      DELETE FROM prices; DELETE FROM wallets; DELETE FROM wallet_providers; DELETE FROM accounts;
      DELETE FROM meta;`);
    try { db.exec('DELETE FROM sqlite_sequence'); } catch { /* 没有 AUTOINCREMENT 表 */ }
  });
}

/* ---------------- 资产总览 / 钱包 / 手动台账 ---------------- */

const WALLET_COLS = `id, name, address, chains, provider, enabled, last_sync_at,
  last_sync_status, last_sync_message, created_at`;

export function listWallets() {
  return all(`SELECT ${WALLET_COLS} FROM wallets ORDER BY id ASC`);
}

export function getWallet(id) {
  return get(`SELECT ${WALLET_COLS} FROM wallets WHERE id = ?`, Number(id)) || null;
}

export function createWallet({ name = '', address = '', chains = [], provider = 'debank', enabled = 1 } = {}) {
  const at = nowIso();
  const addr = String(address || '').trim();
  if (!addr) throw new Error('钱包地址不能为空');
  const chainList = Array.isArray(chains) ? chains : String(chains || '').split(',');
  const r = run(
    `INSERT INTO wallets (name, address, chains, provider, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    String(name || '').trim().slice(0, 60) || addr.slice(0, 12),
    addr,
    JSON.stringify([...new Set(chainList.map((x) => String(x).trim()).filter(Boolean))]),
    String(provider || 'debank').trim().toLowerCase(),
    enabled ? 1 : 0,
    at,
  );
  return getWallet(Number(r.lastInsertRowid));
}

export function updateWallet(id, { name, address, chains, provider, enabled } = {}) {
  const current = get('SELECT * FROM wallets WHERE id = ?', Number(id));
  if (!current) throw new Error('钱包不存在');
  const chainList = chains === undefined
    ? null
    : (Array.isArray(chains) ? chains : String(chains || '').split(','));
  run(
    `UPDATE wallets SET name = ?, address = ?, chains = ?, provider = ?, enabled = ? WHERE id = ?`,
    name === undefined ? current.name : (String(name).trim().slice(0, 60) || current.name),
    address === undefined ? current.address : String(address).trim(),
    chainList === null ? current.chains : JSON.stringify([...new Set(chainList.map((x) => String(x).trim()).filter(Boolean))]),
    provider === undefined ? current.provider : String(provider).trim().toLowerCase(),
    enabled === undefined ? current.enabled : (enabled ? 1 : 0),
    Number(id),
  );
  return getWallet(id);
}

export function deleteWallet(id) {
  return tx((db) => {
    db.prepare("DELETE FROM asset_positions WHERE venue_kind = 'wallet' AND venue_id = ?").run(Number(id));
    db.prepare('DELETE FROM wallets WHERE id = ?').run(Number(id));
  });
}

export function updateWalletSync(id, { status = 'ok', message = '', at = nowIso() } = {}) {
  run(
    'UPDATE wallets SET last_sync_at = ?, last_sync_status = ?, last_sync_message = ? WHERE id = ?',
    at, String(status || 'ok').slice(0, 30), String(message || '').slice(0, 500), Number(id),
  );
}

/** 钱包索引服务配置；密钥加密存储，对外只给 hint */
export function listWalletProviders() {
  return all('SELECT id, api_key_hint, base_url, updated_at FROM wallet_providers ORDER BY id ASC');
}

export function getWalletProviderConfig(id) {
  const row = get('SELECT * FROM wallet_providers WHERE id = ?', String(id || '').toLowerCase());
  if (!row) return null;
  return {
    id: row.id,
    hasKey: Boolean(row.api_key_enc),
    apiKeyHint: row.api_key_hint || '',
    baseUrl: row.base_url || '',
    updatedAt: row.updated_at,
  };
}

export function getWalletProviderCredentials(id) {
  const row = get('SELECT * FROM wallet_providers WHERE id = ?', String(id || '').toLowerCase());
  if (!row) return { apiKey: '', baseUrl: '' };
  return {
    apiKey: row.api_key_enc ? decryptSecret(row.api_key_enc) : '',
    baseUrl: row.base_url || '',
  };
}

export function saveWalletProvider(id, { apiKey, baseUrl, clearKey = false } = {}) {
  const providerId = String(id || '').trim().toLowerCase();
  if (!providerId) throw new Error('缺少索引服务');
  const current = get('SELECT * FROM wallet_providers WHERE id = ?', providerId);
  const nextKeyEnc = clearKey
    ? null
    : (apiKey !== undefined && apiKey !== '' ? encryptSecret(String(apiKey).trim()) : current?.api_key_enc || null);
  const nextHint = clearKey
    ? null
    : (apiKey !== undefined && apiKey !== '' ? hintKey(String(apiKey).trim()) : current?.api_key_hint || null);
  const nextBase = baseUrl === undefined ? (current?.base_url || null) : (String(baseUrl).trim() || null);
  if (nextBase) assertSafeOutboundUrl(nextBase, { label: '钱包索引服务地址' });
  run(
    `INSERT INTO wallet_providers (id, api_key_enc, api_key_hint, base_url, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       api_key_enc = excluded.api_key_enc,
       api_key_hint = excluded.api_key_hint,
       base_url = excluded.base_url,
       updated_at = excluded.updated_at`,
    providerId, nextKeyEnc, nextHint, nextBase, nowIso(),
  );
  return getWalletProviderConfig(providerId);
}

/* 钱包自动同步周期（分钟）：页面可改，env 只作初始默认 */
const WALLET_REFRESH_MIN = 5;
const WALLET_REFRESH_MAX = 20160; // 14 天

export function getWalletRefreshSetting() {
  const n = Number(getMeta('wallet_refresh_minutes', ''));
  if (Number.isFinite(n) && n >= WALLET_REFRESH_MIN) return Math.min(WALLET_REFRESH_MAX, Math.round(n));
  return null;
}

export function setWalletRefreshSetting(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < WALLET_REFRESH_MIN) {
    throw new Error(`刷新周期不能小于 ${WALLET_REFRESH_MIN} 分钟`);
  }
  setMeta('wallet_refresh_minutes', String(Math.min(WALLET_REFRESH_MAX, Math.round(n))));
  return getWalletRefreshSetting();
}

/* ---------------- 统一资产仓位 ---------------- */

function assetPositionRow(p) {
  const amount = Number(p.amount);
  const price = p.price_usd === null || p.price_usd === undefined || p.price_usd === ''
    ? null : Number(p.price_usd);
  const value = p.value_usd === null || p.value_usd === undefined || p.value_usd === ''
    ? null : Number(p.value_usd);
  return {
    venue_kind: String(p.venue_kind || '').trim(),
    venue_id: Number(p.venue_id),
    bucket: String(p.bucket || 'other').trim().toLowerCase(),
    asset: String(p.asset || '').trim().toUpperCase(),
    chain: String(p.chain || '').trim().toLowerCase(),
    protocol: String(p.protocol || '').trim(),
    product: String(p.product || '').trim(),
    amount: Number.isFinite(amount) ? amount : 0,
    price_usd: Number.isFinite(price) ? price : null,
    value_usd: Number.isFinite(value) ? value : null,
    source: String(p.source || 'unknown').slice(0, 300),
    source_ref: String(p.source_ref || '').slice(0, 300),
    fetched_at: p.fetched_at || nowIso(),
  };
}

/**
 * 替换某场所的资产仓位。
 * buckets 非空时只替换这些桶（单个桶拉取失败不会抹掉其他桶的旧数据）。
 */
export function replaceAssetPositions(venueKind, venueId, positions = [], buckets = null) {
  const kind = String(venueKind || '').trim();
  const id = Number(venueId);
  if (!kind || !id) throw new Error('资产仓位缺少场所');
  const bucketList = Array.isArray(buckets)
    ? [...new Set(buckets.map((b) => String(b || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  return tx((db) => {
    if (bucketList.length) {
      const placeholders = bucketList.map(() => '?').join(',');
      db.prepare(`DELETE FROM asset_positions WHERE venue_kind = ? AND venue_id = ? AND bucket IN (${placeholders})`)
        .run(kind, id, ...bucketList);
    } else {
      db.prepare('DELETE FROM asset_positions WHERE venue_kind = ? AND venue_id = ?').run(kind, id);
    }
    const stmt = db.prepare(
      `INSERT INTO asset_positions
         (venue_kind, venue_id, bucket, asset, chain, protocol, product,
          amount, price_usd, value_usd, source, source_ref, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(venue_kind, venue_id, bucket, asset, chain, protocol, product) DO UPDATE SET
         amount = excluded.amount,
         price_usd = excluded.price_usd,
         value_usd = excluded.value_usd,
         source = excluded.source,
         source_ref = excluded.source_ref,
         fetched_at = excluded.fetched_at`,
    );
    let inserted = 0;
    const allowedBuckets = bucketList.length ? new Set(bucketList) : null;
    // 同一个 (桶, 币种, 链, 协议, 产品) 可能来自多条原始仓位（同一池子的多个 token 明细、
    // 或钱包里同名代币）。先合并再写，避免 UNIQUE 冲突导致“写入 5 条只剩 1 条”。
    const merged = new Map();
    for (const raw of positions || []) {
      const row = assetPositionRow({ ...raw, venue_kind: kind, venue_id: id });
      if (!row.asset || !Number.isFinite(row.amount) || row.amount === 0) continue;
      if (allowedBuckets && !allowedBuckets.has(row.bucket)) continue;
      const key = [row.bucket, row.asset, row.chain, row.protocol, row.product].join('\u0001');
      const current = merged.get(key);
      if (!current) {
        merged.set(key, row);
        continue;
      }
      current.amount += row.amount;
      if (row.price_usd !== null) current.price_usd = row.price_usd;
      // 任一明细拿不到估值时整个合并行保持未估值，避免把不完整的金额当成总额
      current.value_usd = (current.value_usd === null || row.value_usd === null)
        ? null
        : current.value_usd + row.value_usd;
      if (!current.source_ref && row.source_ref) current.source_ref = row.source_ref;
      if (row.fetched_at > current.fetched_at) current.fetched_at = row.fetched_at;
    }
    for (const row of merged.values()) {
      stmt.run(
        row.venue_kind, row.venue_id, row.bucket, row.asset, row.chain, row.protocol, row.product,
        row.amount, row.price_usd, row.value_usd, row.source, row.source_ref, row.fetched_at,
      );
      inserted++;
    }
    return inserted;
  });
}

export function deleteAssetPositions(venueKind, venueId) {
  run('DELETE FROM asset_positions WHERE venue_kind = ? AND venue_id = ?', String(venueKind), Number(venueId));
}

export function listAssetPositions({ venueKind = null, venueId = null, bucket = null } = {}) {
  const where = [];
  const params = [];
  if (venueKind) { where.push('p.venue_kind = ?'); params.push(String(venueKind)); }
  if (venueId) { where.push('p.venue_id = ?'); params.push(Number(venueId)); }
  if (bucket) { where.push('p.bucket = ?'); params.push(String(bucket)); }
  const sql = `SELECT p.*,
      COALESCE(a.name, w.name, '') AS venue_name,
      COALESCE(a.exchange, w.provider, '') AS venue_meta,
      w.address AS wallet_address,
      a.is_demo AS account_is_demo
    FROM asset_positions p
    LEFT JOIN accounts a ON p.venue_kind = 'exchange' AND a.id = p.venue_id
    LEFT JOIN wallets w ON p.venue_kind = 'wallet' AND w.id = p.venue_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.venue_kind, p.venue_id, p.value_usd DESC, p.asset ASC`;
  return all(sql, ...params);
}

/* ---------------- 手动资产（打新 / 锁仓理财） ---------------- */

export function listManualAssets({ status = null } = {}) {
  const where = status ? 'WHERE status = ?' : '';
  return all(`SELECT * FROM manual_assets ${where} ORDER BY status ASC, locked_until ASC, id DESC`,
    ...(status ? [String(status)] : []));
}

export function getManualAsset(id) {
  return get('SELECT * FROM manual_assets WHERE id = ?', Number(id)) || null;
}

function manualAssetInput(input = {}) {
  const amount = Number(input.amount);
  const price = input.price_usd === null || input.price_usd === undefined || input.price_usd === ''
    ? null : Number(input.price_usd);
  const value = input.value_usd === null || input.value_usd === undefined || input.value_usd === ''
    ? null : Number(input.value_usd);
  return {
    venue_name: String(input.venue_name || '').trim().slice(0, 80),
    bucket: String(input.bucket || 'launchpool').trim().toLowerCase().slice(0, 40) || 'launchpool',
    product: String(input.product || '').trim().slice(0, 120),
    asset: String(input.asset || '').trim().toUpperCase().slice(0, 40),
    amount: Number.isFinite(amount) ? amount : 0,
    price_usd: Number.isFinite(price) ? price : null,
    value_usd: Number.isFinite(value) ? value : null,
    locked_until: input.locked_until || null,
    status: input.status === 'redeemed' ? 'redeemed' : 'active',
    note: String(input.note || '').slice(0, 1000),
  };
}

export function createManualAsset(input) {
  const row = manualAssetInput(input);
  if (!row.venue_name) throw new Error('请填写场所/产品来源');
  if (!row.asset) throw new Error('请填写币种');
  const at = nowIso();
  const r = run(
    `INSERT INTO manual_assets
       (venue_name, bucket, product, asset, amount, price_usd, value_usd, locked_until, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.venue_name, row.bucket, row.product, row.asset, row.amount, row.price_usd, row.value_usd,
    row.locked_until, row.status, row.note, at, at,
  );
  return getManualAsset(Number(r.lastInsertRowid));
}

export function updateManualAsset(id, input) {
  const current = getManualAsset(id);
  if (!current) throw new Error('手动资产不存在');
  const row = manualAssetInput({ ...current, ...input });
  if (!row.venue_name) throw new Error('请填写场所/产品来源');
  if (!row.asset) throw new Error('请填写币种');
  run(
    `UPDATE manual_assets SET venue_name = ?, bucket = ?, product = ?, asset = ?, amount = ?,
       price_usd = ?, value_usd = ?, locked_until = ?, status = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    row.venue_name, row.bucket, row.product, row.asset, row.amount, row.price_usd, row.value_usd,
    row.locked_until, row.status, row.note, nowIso(), Number(id),
  );
  return getManualAsset(id);
}

export function deleteManualAsset(id) {
  run('DELETE FROM manual_assets WHERE id = ?', Number(id));
}

/* ---------------- 资产同步记录 / 快照 / 价格缓存 ---------------- */

export function startAssetSyncRun(venueKind, venueId, source = '') {
  const at = nowIso();
  const r = run(
    'INSERT INTO asset_sync_runs (venue_kind, venue_id, started_at, status, source) VALUES (?, ?, ?, ?, ?)',
    String(venueKind), Number(venueId), at, 'running', String(source || '').slice(0, 200),
  );
  return Number(r.lastInsertRowid);
}

export function finishAssetSyncRun(id, { status = 'ok', message = '', positions = 0 } = {}) {
  run(
    'UPDATE asset_sync_runs SET finished_at = ?, status = ?, message = ?, positions = ? WHERE id = ?',
    nowIso(), String(status || 'ok').slice(0, 30), String(message || '').slice(0, 800), Number(positions) || 0, Number(id),
  );
}

export function listAssetSyncRuns(limit = 50) {
  return all(
    `SELECT r.*,
       COALESCE(a.name, w.name, '') AS venue_name,
       r.venue_kind AS kind
     FROM asset_sync_runs r
     LEFT JOIN accounts a ON r.venue_kind = 'exchange' AND a.id = r.venue_id
     LEFT JOIN wallets w ON r.venue_kind = 'wallet' AND w.id = r.venue_id
     ORDER BY r.id DESC LIMIT ?`,
    Math.max(1, Math.min(500, Number(limit) || 50)),
  );
}

/** 进程被杀时同步记录会停在 running；启动后把超时未完成的标记为失败 */
export function failStaleAssetSyncRuns(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const r = run(
    `UPDATE asset_sync_runs SET finished_at = ?, status = 'error', message = '进程中断，未完成'
     WHERE finished_at IS NULL AND started_at < ?`,
    nowIso(), cutoff,
  );
  return Number(r.changes) || 0;
}

export function saveAssetSnapshot({ date, total_usd = 0, net_usd = 0, liabilities_usd = 0, unpriced = 0, by_bucket = {}, by_venue = {} }) {
  run(
    `INSERT INTO asset_snapshots
       (snapshot_date, total_usd, net_usd, liabilities_usd, unpriced, by_bucket, by_venue, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_date) DO UPDATE SET
       total_usd = excluded.total_usd,
       net_usd = excluded.net_usd,
       liabilities_usd = excluded.liabilities_usd,
       unpriced = excluded.unpriced,
       by_bucket = excluded.by_bucket,
       by_venue = excluded.by_venue,
       created_at = excluded.created_at`,
    String(date), Number(total_usd) || 0, Number(net_usd) || 0, Number(liabilities_usd) || 0,
    Number(unpriced) || 0, JSON.stringify(by_bucket || {}), JSON.stringify(by_venue || {}), nowIso(),
  );
}

export function listAssetSnapshots(limit = 365) {
  return all(
    'SELECT * FROM asset_snapshots ORDER BY snapshot_date DESC LIMIT ?',
    Math.max(1, Math.min(2000, Number(limit) || 365)),
  ).reverse();
}

export function savePrices(entries = []) {
  if (!entries.length) return;
  const at = nowIso();
  tx((db) => {
    const stmt = db.prepare(
      `INSERT INTO prices (asset, price_usd, source, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(asset) DO UPDATE SET price_usd = excluded.price_usd, source = excluded.source, fetched_at = excluded.fetched_at`,
    );
    for (const p of entries) {
      const asset = String(p.asset || '').toUpperCase();
      const price = Number(p.price_usd);
      if (!asset || !Number.isFinite(price)) continue;
      stmt.run(asset, price, String(p.source || '').slice(0, 200), p.fetched_at || at);
    }
  });
}

export function getCachedPrice(asset) {
  const row = get('SELECT * FROM prices WHERE asset = ?', String(asset || '').toUpperCase());
  return row || null;
}

export function listPrices(limit = 500) {
  return all('SELECT * FROM prices ORDER BY asset ASC LIMIT ?', Math.max(1, Number(limit) || 500));
}

/** 全量导出中 trades 之前/之后的表；trades 单独流式输出。 */
function exportAllHead() {
  return {
    exported_at: nowIso(),
    accounts: listAccounts(),
    wallets: listWallets(),
    wallet_providers: listWalletProviders(),
    manual_assets: listManualAssets(),
    asset_positions: listAssetPositions(),
    asset_snapshots: listAssetSnapshots(2000),
    asset_sync_runs: listAssetSyncRuns(1000),
    prices: listPrices(2000),
  };
}

function exportAllTail() {
  return {
    tags: listTags(),
    notes: listNotes(),
    imports: listImports(1000),
    sync_runs: listSyncRuns(null, 1000),
    funding_events: all('SELECT * FROM funding_events ORDER BY time'),
    balances: listBalances(),
    positions: listPositions(),
    spot_balances: listSpotBalances(),
    spot_holdings: listSpotHoldings(),
    spot_fills: listSpotFills({ limit: 5000 }),
    transfers: listTransfers({ limit: 5000 }),
  };
}

export function exportAll() {
  return {
    ...exportAllHead(),
    trades: listTrades(),
    ...exportAllTail(),
  };
}

function jsonIndented(value, spaces) {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${' '.repeat(spaces)}`);
}

/**
 * JSON 全量导出流：trades 按 1000 行分批查询，其余表逐表输出。
 * 输出仍是合法 JSON，可直接导入；避免 JSON.stringify(exportAll()) 的峰值内存翻倍。
 */
export async function* exportAllJsonChunks() {
  yield '{\n';
  let first = true;
  for (const [key, value] of Object.entries(exportAllHead())) {
    yield `${first ? '' : ',\n'}  ${JSON.stringify(key)}: ${jsonIndented(value, 2)}`;
    first = false;
  }

  yield `${first ? '' : ',\n'}  "trades": [`;
  const total = countTrades();
  const batch = 1000;
  let emitted = 0;
  for (let offset = 0; offset < total; offset += batch) {
    const rows = listTradesPage({}, { limit: batch, offset });
    for (const row of rows) {
      yield `${emitted === 0 ? '' : ','}\n    ${jsonIndented(row, 4)}`;
      emitted += 1;
    }
  }
  yield '\n  ]';

  for (const [key, value] of Object.entries(exportAllTail())) {
    yield `,\n  ${JSON.stringify(key)}: ${jsonIndented(value, 2)}`;
  }
  yield '\n}\n';
}

/** 导出为可再次导入的 CSV */
const CSV_HEADERS = [
  'symbol', 'side', 'order_type', 'size', 'notional', 'entry_price', 'exit_price',
  'open_time', 'close_time', 'pnl', 'fee', 'funding', 'external_id', 'tags', 'note',
];

function csvCell(v) {
  let s = String(v ?? '');
  // 防 CSV 公式注入：电子表格会把 =+-@ 开头的单元格当公式执行
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tradeCsvLine(t) {
  return [
    t.symbol, t.side, t.order_type, t.size, t.notional, t.entry_price, t.exit_price,
    t.open_time, t.close_time, t.pnl, t.fee, t.funding, t.external_id || '',
    (t.tags || []).join(';'), t.note || '',
  ].map(csvCell).join(',');
}

/**
 * 导出交易 CSV。query 传入 URL 过滤参数（account_id/market/side/result/symbol/
 * order_type/tag/note/from/to/q，与列表页同口径）；缺省导出全部。
 * JSON 全量备份不走这里——备份必须完整，不做过滤。
 */
export function exportTradesCsv(query = null) {
  const rows = query ? filterTrades(listTrades(), query) : listTrades();
  const lines = [CSV_HEADERS.join(',')];
  for (const t of [...rows].reverse()) lines.push(tradeCsvLine(t));
  return lines.join('\n');
}

/**
 * CSV 流式导出：按 1000 行分批查询，避免一次性物化全表 + 拼接大字符串。
 * 时间排序走 SQL 升序（等价于旧实现的反转）；其他排序保留旧路径以保证顺序一致。
 */
export async function* exportTradesCsvChunks(query = {}) {
  const q = query || {};
  if (q.sort && q.sort !== 'time') {
    for (const line of exportTradesCsv(q).split('\n')) yield line;
    return;
  }
  yield CSV_HEADERS.join(',');
  const total = countTradesFiltered(q);
  const batch = 1000;
  for (let offset = 0; offset < total; offset += batch) {
    const rows = listTradesPage({ ...q, sort: 'timeAsc' }, { limit: batch, offset });
    for (const t of rows) yield tradeCsvLine(t);
  }
}
