/**
 * 数据读写层：把 SQL 细节收在这里，路由与视图只看到普通对象。
 */

import { all, get, run, tx } from './db.js';
import { nowIso, uid } from './http.js';
import { encryptSecret, decryptSecret, hintKey } from './crypto.js';
import { remainingLots } from './fills.js';
import { setExchangeProxyProvider } from './http-client.js';

/* ---------------- 账户 ---------------- */

/** 对外只暴露安全字段，加密后的凭据与原文永不进视图 */
const ACCOUNT_COLS = `id, exchange, name, is_demo, created_at, api_key_hint,
  sync_state, sync_done, last_sync_at, last_sync_status, last_sync_message,
  lookback_days, last_transfer_sync_at, spot_symbols, last_spot_sync_at`;

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

export function createAccount({ exchange, name, apiKey = '', apiSecret = '', passphrase = '', isDemo = 0, lookbackDays = null, spotSymbols = '' }) {
  const at = nowIso();
  const key = String(apiKey || '');
  const r = run(
    `INSERT INTO accounts
       (exchange, name, is_demo, created_at, api_key_enc, api_secret_enc, passphrase_enc, api_key_hint, lookback_days, spot_symbols)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
  return getAccount(Number(r.lastInsertRowid));
}

export function updateAccount(id, { name, apiKey, apiSecret, passphrase, lookbackDays, spotSymbols } = {}) {
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
  run(
    `UPDATE accounts
     SET name = ?, api_key_enc = ?, api_secret_enc = ?, passphrase_enc = ?, api_key_hint = ?,
         lookback_days = ?, spot_symbols = ?
     WHERE id = ?`,
    nextName, nextKeyEnc, nextSecretEnc, nextPassEnc, nextHint, nextLookback, nextSpotSymbols, Number(id),
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
  run('DELETE FROM accounts WHERE id = ? AND is_demo = 0', Number(id));
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
       WHERE account_id = ? AND symbol = ? AND open_time <= ? AND close_time >= ?
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
        time, f.order_type || null, nowIso(),
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

/** 策略机器人回合（按「策略机器人」标签识别），供机器人页展示 */
export function listBotTrades(accountId = null) {
  const params = [];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
    FROM trades tr
    JOIN trade_tags tt ON tt.trade_id = tr.id
    JOIN tags g ON g.id = tt.tag_id AND g.name = '策略机器人'
    JOIN accounts a ON a.id = tr.account_id
    WHERE 1=1`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' GROUP BY tr.id ORDER BY tr.close_time DESC LIMIT 500';
  return all(sql, ...params);
}

/* ---------------- 交易详情缓存（K 线 / 逐笔成交，落库持久化） ---------------- */

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
    `SELECT a.id, a.sync_done, a.sync_state, a.last_sync_at, a.last_sync_status, a.last_sync_message,
       (SELECT COUNT(*) FROM trades t WHERE t.account_id = a.id) AS trades,
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
         (account_id, exchange, symbol, external_id, side, price, qty, fee, time, order_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const f of fills) {
      if (!f?.id || !f.symbol || !Number(f.time)) continue;
      const r = stmt.run(
        Number(accountId), String(exchange), String(f.symbol), String(f.id),
        f.side === 'buy' ? 'buy' : 'sell',
        Number(f.price) || 0, Number(f.qty) || 0, Number(f.fee) || 0,
        Math.floor(Number(f.time) || 0), f.orderType ? String(f.orderType) : null, nowIso(),
      );
      inserted += Number(r.changes) || 0;
    }
    return inserted;
  });
}

export function listTradeFillSymbols(accountId) {
  return all('SELECT DISTINCT symbol FROM trade_fills WHERE account_id = ? ORDER BY symbol', Number(accountId))
    .map((r) => r.symbol);
}

/** 每个 symbol 最早的开仓时间（判断成交覆盖是否够做全量重算） */
export function listSymbolEarliestOpen(accountId) {
  return all(
    `SELECT symbol, MIN(open_time) AS min_open FROM trades
     WHERE account_id = ? AND source = 'api' AND market = 'futures' GROUP BY symbol`,
    Number(accountId),
  );
}

export function listTradeFills(accountId, symbol) {
  return all(
    `SELECT external_id, side, price, qty, fee, time, order_type
     FROM trade_fills WHERE account_id = ? AND symbol = ? ORDER BY time ASC, id ASC`,
    Number(accountId), String(symbol),
  );
}

/**
 * 重算后清理幻影回合：删除该 symbol 下 source=api、external_id 以交易所前缀开头
 * 但不在重算集合里的交易。删除前把挂在这些交易上的资金费事件释放为未分配，
 * 下一次同步会重新分配到正确回合。
 */
export function pruneTradesNotIn(accountId, exchange, symbol, keepIds) {
  const keep = new Set((keepIds || []).map(String));
  const rows = all(
    `SELECT id, external_id FROM trades
     WHERE account_id = ? AND source = 'api' AND market = 'futures'
       AND symbol = ? AND external_id LIKE ?`,
    Number(accountId), String(symbol), `${exchange}:%`,
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
  return rows.map((r) => ({ ...r, tags: byTrade.get(r.id) || [] }));
}

export function listTrades({ accountId = null, limit = null } = {}) {
  const params = [];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
             FROM trades tr JOIN accounts a ON a.id = tr.account_id`;
  if (accountId) { sql += ' WHERE tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.close_time DESC, tr.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  return attachTagsToRows(all(sql, ...params));
}

export function countTrades() {
  return Number(get('SELECT COUNT(*) AS n FROM trades').n);
}

/** 只取数量的轻量统计，避免为计数拉全表 */
export function countTradesBySource(source) {
  return Number(get('SELECT COUNT(*) AS n FROM trades WHERE source = ?', String(source)).n);
}

export function countTradesBetween(fromIso, toIso) {
  return Number(get(
    'SELECT COUNT(*) AS n FROM trades WHERE close_time >= ? AND close_time <= ?',
    String(fromIso), String(toIso),
  ).n);
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

/** 批量导入（带事务、去重、标签） */
export function importTrades(trades, accountId, { upsert = false } = {}) {
  const at = nowIso();
  return tx((db) => {
    let inserted = 0;
    let skipped = 0;
    let updated = 0;
    const insert = db.prepare(
      `INSERT INTO trades (account_id, external_id, symbol, side, order_type, size, notional,
         entry_price, exit_price, open_time, close_time, pnl, fee, funding, source, market, note,
         note_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const exists = db.prepare(
      'SELECT id, source, funding, pnl FROM trades WHERE account_id = ? AND external_id = ?',
    );
    // OKX 偶尔补写行的 openTime（如从 cTime 整秒值精化为实际成交时间），同一回合
    // 会带着新外部 ID 再来一次。按 posId + 盈亏/数量指纹做二次匹配：命中则改键并回写，
    // 而不是插入重复记录。时间窗口 180s 内，避免误并同 posId 的相邻独立回合。
    const byFingerprint = db.prepare(
      `SELECT id, funding FROM trades WHERE account_id = ? AND source = 'api' AND external_id LIKE ?
         AND symbol = ? AND ABS(pnl - ?) < 1e-9 AND ABS(size - ?) < 1e-9
         AND ABS(strftime('%s', close_time) * 1000 - ?) < 180000 LIMIT 1`,
    );
    const rekey = db.prepare('UPDATE trades SET external_id = ? WHERE id = ?');
    // upsert 只更新交易所侧字段；复盘笔记、标签、创建时间保留。
    const updateApi = db.prepare(
      `UPDATE trades SET symbol = ?, side = ?, order_type = ?, size = ?, notional = ?,
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
        // OKX 部分平仓会原地更新仓位历史行：api 行允许回写最终状态，其余来源一律跳过
        if (upsert && found.source === 'api' && trade.source === 'api') {
          const mf = mergeFunding(trade.funding, found.funding);
          updateApi.run(
            String(trade.symbol || ''), String(trade.side || 'long'), trade.order_type || 'other',
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
        if (twin) {
          const mf = mergeFunding(trade.funding, twin.funding);
          rekey.run(ext, twin.id);
          updateApi.run(
            String(trade.symbol || ''), String(trade.side || 'long'), trade.order_type || 'other',
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
    WHERE tr.source = 'api' AND tr.order_type = 'other' AND tr.close_time >= ?`;
  if (accountId) { sql += ' AND tr.account_id = ?'; params.push(Number(accountId)); }
  sql += ' ORDER BY tr.close_time DESC LIMIT ?';
  params.push(Math.max(1, Math.min(50, Number(limit) || 1)));
  return all(sql, ...params);
}

/** 优先复盘队列：还没写复盘笔记的大亏交易（按亏损从大到小） */export function listReviewQueue({ threshold = 0, accountId = null, limit = 8 } = {}) {
  const params = [Number(threshold)];
  let sql = `SELECT tr.*, a.name AS account_name, a.exchange AS account_exchange
    FROM trades tr JOIN accounts a ON a.id = tr.account_id
    WHERE tr.pnl <= ? AND (tr.note IS NULL OR tr.note = '')`;
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
      WHERE note IS NOT NULL AND TRIM(note) <> ''
      GROUP BY symbol
      ORDER BY last_time DESC`,
  );
}

export function listTradeNotesBySymbol(symbol, limit = 50) {
  return all(
    `SELECT id, symbol, side, market, close_time, pnl, note
       FROM trades
      WHERE symbol = ? AND note IS NOT NULL AND TRIM(note) <> ''
      ORDER BY close_time DESC
      LIMIT ?`,
    String(symbol), Number(limit),
  );
}

export function listRecentTradeNotes(limit = 20) {
  return all(
    `SELECT id, symbol, side, market, close_time, pnl, note
       FROM trades
      WHERE note IS NOT NULL AND TRIM(note) <> ''
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
      WHERE t.market = 'spot'`;
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
      WHERE t.market = 'spot' AND t.symbol = ?
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

export function saveReportGeneration({ periodKind, periodLabel, prompt, content, model = null, trades = 0 }) {
  const r = run(
    `INSERT INTO report_generations (period_kind, period_label, prompt, content, model, trades, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    String(periodKind), String(periodLabel), String(prompt || ''), String(content || ''),
    model ? String(model).slice(0, 120) : null, Number(trades) || 0, nowIso(),
  );
  return Number(r.lastInsertRowid);
}

export function latestReportGeneration(periodKind, periodLabel) {
  return get(
    `SELECT * FROM report_generations
      WHERE period_kind = ? AND period_label = ?
      ORDER BY id DESC LIMIT 1`,
    String(periodKind), String(periodLabel),
  ) || null;
}

export function listReportGenerations(periodKind = null, limit = 30) {
  const params = [];
  let sql = 'SELECT id, period_kind, period_label, model, trades, created_at, LENGTH(content) AS content_len FROM report_generations';
  if (periodKind) { sql += ' WHERE period_kind = ?'; params.push(String(periodKind)); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit) || 30);
  return all(sql, ...params);
}

export function getReportGeneration(id) {
  return get('SELECT * FROM report_generations WHERE id = ?', Number(id)) || null;
}

export function deleteReportGeneration(id) {
  run('DELETE FROM report_generations WHERE id = ?', Number(id));
}

/* ---------------- AI 报告生成任务（内存态） ---------------- */

const reportJobs = new Map(); // jobId -> { id, status, period, label, startedAt, finishedAt, error, reportId }
let reportJobSeq = 0;

export function createReportJob({ periodKind, periodLabel, promptLen }) {
  reportJobSeq += 1;
  const job = {
    id: `rj-${Date.now()}-${reportJobSeq}`,
    status: 'running',
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
    db.prepare('DELETE FROM accounts WHERE is_demo = 1').run();
    db.prepare('DELETE FROM imports WHERE account_id NOT IN (SELECT id FROM accounts)').run();
    return { trades: Number(before.n) };
  });
}

export function clearAllData() {
  tx((db) => {
    db.exec('DELETE FROM spot_fills; DELETE FROM spot_cost_basis; DELETE FROM spot_balances; DELETE FROM spot_holdings; DELETE FROM transfers; DELETE FROM funding_events; DELETE FROM balances; DELETE FROM positions; DELETE FROM resources; DELETE FROM sync_runs; DELETE FROM import_templates; DELETE FROM trade_tags; DELETE FROM trades; DELETE FROM tags; DELETE FROM notes; DELETE FROM imports; DELETE FROM sessions; DELETE FROM accounts;');
    try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('trades','accounts','tags','notes','imports','sync_runs','import_templates','funding_events','transfers')"); } catch { /* 没有 AUTOINCREMENT 表 */ }
  });
}

export function exportAll() {
  return {
    exported_at: nowIso(),
    accounts: listAccounts(),
    trades: listTrades(),
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

/** 导出为可再次导入的 CSV */
export function exportTradesCsv() {
  const rows = listTrades();
  const headers = [
    'symbol', 'side', 'order_type', 'size', 'notional', 'entry_price', 'exit_price',
    'open_time', 'close_time', 'pnl', 'fee', 'funding', 'external_id', 'tags', 'note',
  ];
  const esc = (v) => {
    let s = String(v ?? '');
    // 防 CSV 公式注入：电子表格会把 =+-@ 开头的单元格当公式执行
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const t of [...rows].reverse()) {
    lines.push([
      t.symbol, t.side, t.order_type, t.size, t.notional, t.entry_price, t.exit_price,
      t.open_time, t.close_time, t.pnl, t.fee, t.funding, t.external_id || '',
      (t.tags || []).join(';'), t.note || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
