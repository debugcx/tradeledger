import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const trade = (overrides = {}) => ({
  symbol: 'BTC/USDT',
  side: 'long',
  order_type: 'market',
  size: 1,
  notional: 100,
  entry_price: 100,
  exit_price: 110,
  open_time: '2026-02-10T00:00:00.000Z',
  close_time: '2026-02-10T02:00:00.000Z',
  pnl: 10,
  fee: 0,
  funding: 0,
  source: 'manual',
  ...overrides,
});

async function freshDb() {
  const { openDb, setDb, closeDb, getDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  return { store, getDb, closeDb };
}

test('清空全部数据：新表、meta 与自增序列一并重置，旧数据不会复活', async () => {
  const { store, getDb, closeDb } = await freshDb();
  const acc = store.createAccount({ exchange: 'fake', name: 'A', apiKey: 'k', apiSecret: 's' });
  store.importTrades([trade({ external_id: 'x:1' })], acc.id, { upsert: true });
  const t = store.listTrades()[0];

  const db = getDb();
  db.prepare(`INSERT INTO trade_fills (account_id, exchange, symbol, external_id, side, price, qty, fee, time, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(acc.id, 'fake', 'BTC/USDT', 'f:1', 'buy', 100, 1, 0, 1, '2026-02-10T00:00:00.000Z');
  db.prepare(`INSERT INTO missed_trades (symbol, direction, status, note, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('ETH/USDT', 'long', 'open', '错过', '2026-02-10T00:00:00.000Z', '2026-02-10T00:00:00.000Z');
  db.prepare(`INSERT INTO spot_log (account_id, symbol, text, created_at)
              VALUES (?, ?, ?, ?)`)
    .run(acc.id, 'BTC/USDT', '持有日志', '2026-02-10T00:00:00.000Z');
  db.prepare(`INSERT INTO trade_curves (trade_id, inputs, bar, candles, fetched_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(t.id, '{}', '1m', '[]', '2026-02-10T00:00:00.000Z');
  db.prepare(`INSERT INTO trade_fills_cache (trade_id, inputs, fills, fetched_at)
              VALUES (?, ?, ?, ?)`)
    .run(t.id, '{}', '[]', '2026-02-10T00:00:00.000Z');
  store.saveReportGeneration({
    accountId: acc.id,
    periodKind: 'month',
    periodLabel: '2026-02',
    prompt: 'p',
    content: 'c',
    trades: 1,
  });
  store.setMeta('display_name', 'Owner');

  store.clearAllData();

  const tables = [
    'accounts', 'trades', 'trade_tags', 'tags', 'notes', 'imports', 'sessions',
    'sync_runs', 'import_templates', 'funding_events', 'balances', 'positions',
    'position_notes', 'resources', 'spot_balances', 'spot_holdings', 'spot_fills',
    'spot_cost_basis', 'spot_log', 'transfers', 'trade_curves', 'trade_fills_cache',
    'trade_fills', 'missed_trades', 'report_generations', 'meta', 'wallets',
    'wallet_providers', 'asset_positions', 'manual_assets', 'asset_snapshots',
    'asset_sync_runs', 'prices',
  ];
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    assert.equal(Number(row.n), 0, `${table} 应被清空`);
  }
  assert.equal(store.getMeta('display_name', null), null);

  // 自增序列重置后，新账户复用 id=1，也不会看到旧的成交/报告。
  const acc2 = store.createAccount({ exchange: 'fake', name: 'B', apiKey: 'k2', apiSecret: 's2' });
  assert.equal(acc2.id, 1);
  assert.equal(store.listTrades().length, 0);
  assert.equal(store.latestReportGeneration('month', '2026-02', null), null);
  closeDb();
});

test('日期筛选：带时间的 ISO 输入换算回本地日，不会多带前一天', async () => {
  process.env.TRADELEDGER_TZ = 'Asia/Shanghai';
  const stats = await import('../src/stats.js?date-iso-cst');
  try {
    const prevDay = { ...trade(), close_time: '2026-05-07T04:00:00.000Z' }; // 上海 5/7 12:00
    const selected = { ...trade(), close_time: '2026-05-07T16:30:00.000Z' }; // 上海 5/8 00:30
    assert.equal(stats.localDayKey(prevDay.close_time), '2026-05-07');
    assert.equal(stats.localDayKey(selected.close_time), '2026-05-08');

    // 旧实现会把 from=2026-05-08 转成 2026-05-07T16:00Z，再截成 5/7，导致前一天被带入。
    const got = stats.filterTrades([prevDay, selected], {
      from: '2026-05-07T16:00:00.000Z',
      to: '2026-05-08T15:59:59.999Z',
    });
    assert.deepEqual(got.map((t) => t.close_time), [selected.close_time]);
  } finally {
    delete process.env.TRADELEDGER_TZ;
  }
});

test('日期筛选：UTC 负时区下结束日不会多带后一天', async () => {
  process.env.TRADELEDGER_TZ = 'America/New_York';
  const stats = await import('../src/stats.js?date-iso-ny');
  try {
    const selected = { ...trade(), close_time: '2026-05-08T20:00:00.000Z' }; // 纽约 5/8 16:00
    const nextDay = { ...trade(), close_time: '2026-05-09T20:00:00.000Z' }; // 纽约 5/9 16:00
    // 旧实现把 to=2026-05-08 的结束时刻转成 2026-05-09T03:59Z，再截成 5/9。
    const got = stats.filterTrades([selected, nextDay], {
      from: '2026-05-08T04:00:00.000Z',
      to: '2026-05-09T03:59:59.999Z',
    });
    assert.deepEqual(got.map((t) => t.close_time), [selected.close_time]);
  } finally {
    delete process.env.TRADELEDGER_TZ;
  }
});

test('AI 报告按账户隔离：同周期多账户互不串读', async () => {
  const { store, closeDb } = await freshDb();
  const a = store.createAccount({ exchange: 'fake', name: '账户A', apiKey: 'k', apiSecret: 's' });
  const b = store.createAccount({ exchange: 'fake', name: '账户B', apiKey: 'k', apiSecret: 's' });

  store.saveReportGeneration({ accountId: a.id, periodKind: 'week', periodLabel: '2026-W42', prompt: 'pa', content: 'A 的报告' });
  store.saveReportGeneration({ accountId: b.id, periodKind: 'week', periodLabel: '2026-W42', prompt: 'pb', content: 'B 的报告' });
  store.saveReportGeneration({ accountId: null, periodKind: 'week', periodLabel: '2026-W42', prompt: 'pall', content: '合计报告' });

  assert.equal(store.latestReportGeneration('week', '2026-W42', a.id).content, 'A 的报告');
  assert.equal(store.latestReportGeneration('week', '2026-W42', b.id).content, 'B 的报告');
  assert.equal(store.latestReportGeneration('week', '2026-W42', null).content, '合计报告');

  const onlyA = store.listReportGenerations('week', 20, a.id);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].account_name, '账户A');
  assert.equal(onlyA[0].account_id, a.id);

  const all = store.listReportGenerations('week', 20);
  assert.equal(all.length, 3);
  assert.ok(all.some((r) => r.account_id === null && r.content_len > 0));
  closeDb();
});

test('周期报告缓存：中间一笔盈亏被修改后必须重算', async () => {
  const { buildPeriodReview } = await import('../src/review.js');
  const month = { kind: 'month', year: 2026, month: 2 };
  const make = (id, pnl, updated = '2026-02-10T03:00:00.000Z') => ({
    ...trade(), id, pnl, updated_at: updated,
  });
  const trades = [make(1, 10), make(2, -30), make(3, 5)];

  const first = buildPeriodReview(trades, month);
  assert.equal(first.stats.totalPnl, -15);

  // 条数、首尾 id 都不变，只有中间一笔的盈亏和更新时间变化。
  const edited = [trades[0], make(2, 0, '2026-02-11T03:00:00.000Z'), trades[2]];
  const second = buildPeriodReview(edited, month);
  assert.equal(second.stats.totalPnl, 15);
});

test('老库迁移：report_generations 自动补 account_id 列', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-migrate-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE report_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_kind TEXT NOT NULL,
    period_label TEXT NOT NULL,
    prompt TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    trades INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  old.close();

  const { openDb } = await import('../src/db.js?legacy-report');
  const db = openDb(file);
  try {
    const cols = db.prepare('PRAGMA table_info(report_generations)').all().map((c) => c.name);
    assert.ok(cols.includes('account_id'));
    const indexes = db.prepare('PRAGMA index_list(report_generations)').all().map((i) => i.name);
    assert.ok(indexes.includes('ix_report_generations_account'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
