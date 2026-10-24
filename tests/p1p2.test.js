import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DB_FILE = ':memory:';

const { encryptSecret, decryptSecret, hintKey, hmacHex, hmacBase64, hmacHex512 } = await import('../src/crypto.js');
const { matchFills, toSymbol, windowsDescending } = await import('../src/exchanges/common.js');
const { reconcileTrades } = await import('../src/reconcile.js');
const {
  buildWeeklyReview, buildPeriodReview, reviewMarkdown, reportPrompt, parsePeriod,
  isoWeekOf, weekRange, parseWeek, formatWeek, shiftWeek,
} = await import('../src/review.js');

/* ---------------- 加密与签名 ---------------- */

test('AES-256-GCM：凭据加密后可解密，密文每次不同', () => {
  const a = encryptSecret('my-secret-key');
  const b = encryptSecret('my-secret-key');
  assert.match(a, /^v1:/);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'my-secret-key');
  assert.equal(decryptSecret(b), 'my-secret-key');
  assert.equal(decryptSecret(''), '');
  assert.equal(hintKey('abcdef1234'), '1234');
});

test('HMAC 签名与 node:crypto 一致', () => {
  assert.equal(hmacHex('secret', 'data'), crypto.createHmac('sha256', 'secret').update('data').digest('hex'));
  assert.equal(hmacBase64('secret', 'data'), crypto.createHmac('sha256', 'secret').update('data').digest('base64'));
  assert.equal(hmacHex512('secret', 'data'), crypto.createHmac('sha512', 'secret').update('data').digest('hex'));
});

/* ---------------- 成交配对 ---------------- */

test('matchFills：开多 → 平多，手续费计入净盈亏', () => {
  const trades = matchFills([
    { id: 1, symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 2, fee: -1, time: 1000 },
    { id: 2, symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: -0.5, time: 2000 },
    { id: 3, symbol: 'BTC/USDT', side: 'sell', price: 120, qty: 1, fee: -0.5, time: 3000 },
  ], 'test');
  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].size, 1);
  assert.equal(trades[0].entry_price, 100);
  assert.equal(trades[0].exit_price, 110);
  assert.equal(trades[0].fee, -1);
  assert.equal(trades[0].pnl, 9); // 10 - 0.5 - 0.5
  assert.equal(trades[1].exit_price, 120);
  assert.equal(trades[1].pnl, 19);
  assert.ok(trades[0].external_id.startsWith('test:'));
});

test('matchFills：开空 → 平空，方向正确', () => {
  const trades = matchFills([
    { id: 1, symbol: 'ETH/USDT', side: 'sell', price: 100, qty: 1, fee: 0, time: 1000 },
    { id: 2, symbol: 'ETH/USDT', side: 'buy', price: 90, qty: 1, fee: 0, time: 2000 },
  ], 'test');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, 'short');
  assert.equal(trades[0].pnl, 10);
});

test('matchFills：反手成交先平后开', () => {
  const trades = matchFills([
    { id: 1, symbol: 'SOL/USDT', side: 'buy', price: 100, qty: 1, fee: 0, time: 1000 },
    { id: 2, symbol: 'SOL/USDT', side: 'sell', price: 110, qty: 2, fee: 0, time: 2000 },
    { id: 3, symbol: 'SOL/USDT', side: 'buy', price: 105, qty: 1, fee: 0, time: 3000 },
  ], 'test');
  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].pnl, 10);
  assert.equal(trades[1].side, 'short');
  assert.equal(trades[1].pnl, 5);
});

test('matchFills：同一批数据重复配对得到相同 external_id', () => {
  const fills = [
    { id: 1, symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 1, fee: -1, time: 1000 },
    { id: 2, symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: -1, time: 2000 },
  ];
  const a = matchFills(fills, 'x');
  const b = matchFills(fills, 'x');
  assert.equal(a[0].external_id, b[0].external_id);
});

test('符号与时间窗工具', () => {
  assert.equal(toSymbol('BTC-USDT-SWAP'), 'BTC/USDT');
  assert.equal(toSymbol('BTC_USDT'), 'BTC/USDT');
  assert.equal(toSymbol('BTCUSDT'), 'BTC/USDT');
  const windows = windowsDescending(0, 20 * 86400_000, 7 * 86400_000);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].to, 20 * 86400_000);
  assert.ok(windows[1].to < windows[0].from);
  assert.equal(windows[windows.length - 1].from, 0);
});

/* ---------------- 对账 ---------------- */

test('reconcileTrades：一致、不一致、缺字段分类正确', () => {
  const base = {
    id: 1, symbol: 'BTC/USDT', side: 'long', source: 'csv', account_name: 'A',
    notional: 100, pnl: 10, fee: 0, funding: 0,
    entry_price: 100, exit_price: 110, size: 1,
    open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-01T01:00:00.000Z',
  };
  const report = reconcileTrades([
    { ...base, id: 1 },
    { ...base, id: 2, pnl: 30, entry_price: 100, exit_price: 110 }, // 毛盈亏 30 vs 复算 10
    { ...base, id: 3, entry_price: 0, exit_price: 0 },             // 缺价格
  ]);
  assert.equal(report.total, 3);
  assert.equal(report.checked, 2);
  assert.equal(report.missing, 1);
  assert.equal(report.mismatches, 1);
  assert.equal(report.worst[0].id, 2);
  assert.equal(report.bySource.length, 1);
});

/* ---------------- 周报 ---------------- */

function tradeInWeek(week, overrides = {}) {
  const { from } = weekRange(week);
  const at = new Date(from.getTime() + 3600_000);
  return {
    id: overrides.id || 1,
    symbol: 'BTC/USDT',
    side: 'long',
    order_type: 'market',
    size: 1,
    notional: 1000,
    entry_price: 1000,
    exit_price: 1010,
    open_time: new Date(at.getTime() - 3600_000).toISOString(),
    close_time: at.toISOString(),
    pnl: 10,
    fee: -1,
    funding: 0,
    tags: ['趋势'],
    note: '按计划执行',
    source: 'manual',
    ...overrides,
  };
}

test('周报：区间、统计、最差时段与 Markdown', () => {
  const wk = { year: 2026, week: 42 };
  assert.equal(formatWeek(wk), '2026-W42');
  assert.deepEqual(parseWeek('2026-W42'), wk);
  assert.equal(parseWeek('bad'), null);

  const base = weekRange(wk).from.getTime();
  const trades = [
    tradeInWeek(wk, { id: 1, pnl: 10 }),
    tradeInWeek(wk, { id: 2, pnl: -30, close_time: new Date(base + 3600_000 + 600_000).toISOString() }),
    tradeInWeek(wk, { id: 3, pnl: -20, tags: ['逆势'], close_time: new Date(base + 3600_000 + 1200_000).toISOString() }),
    // 区间外的交易不能计入
    tradeInWeek({ year: 2026, week: 41 }, { id: 4, pnl: 999 }),
  ];
  const review = buildWeeklyReview(trades, wk);
  assert.equal(review.stats.total, 3);
  assert.equal(review.stats.totalPnl, -40);
  assert.ok(review.worstSlots.length >= 1);
  assert.ok(review.notes.length >= 1);
  assert.ok(review.questions.length >= 1);
  const md = reviewMarkdown(review);
  assert.match(md, /TradeLedger 周报 2026-W42/);
  assert.match(md, /给 AI 的复盘提示词/);
  assert.match(md, /净盈亏/);
});

test('周报：空周不抛错', () => {
  const wk = { year: 2026, week: 1 };
  const review = buildWeeklyReview([], wk);
  assert.equal(review.stats.total, 0);
  assert.match(review.headline, /没有已平仓交易/);
  assert.ok(reviewMarkdown(review).includes('样本不足'));
  assert.equal(review.period.kind, 'week');
  const shifted = shiftWeek(wk, 1);
  assert.equal(shifted.week, 2);
  assert.equal(isoWeekOf(new Date()).week >= 1, true);
});

test('周期报告：月报与年报区间、标签与提示词', () => {
  const month = { kind: 'month', year: 2026, month: 2 };
  const review = buildPeriodReview([
    tradeInWeek({ year: 2026, week: 6 }, { id: 1, pnl: 5 }),
  ], month);
  assert.equal(review.period.kind, 'month');
  assert.equal(review.period.kindLabel, '月报');
  assert.match(review.period.label, /^2026-02$/);
  assert.equal(review.stats.total, 1);
  const md = reviewMarkdown(review);
  assert.match(md, /TradeLedger 月报 2026-02/);

  const year = { kind: 'year', year: 2026 };
  const yReview = buildPeriodReview([
    tradeInWeek({ year: 2026, week: 6 }, { id: 1, pnl: 5 }),
  ], year);
  assert.equal(yReview.period.kindLabel, '年报');
  assert.equal(yReview.period.label, '2026');
  assert.match(reviewMarkdown(yReview), /TradeLedger 年报 2026/);
  assert.match(reportPrompt(yReview), /年报（2026）/);

  const parsed = parsePeriod({ kind: 'month', month: '2026-03' });
  assert.deepEqual({ kind: parsed.kind, year: parsed.year, month: parsed.month }, { kind: 'month', year: 2026, month: 3 });
});

/* ---------------- 同步引擎 ---------------- */

test('同步引擎：分批游标、断点续传、去重与审计', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { syncAccount } = await import('../src/sync.js');

  const account = store.createAccount({ exchange: 'fake', name: 'Fake', apiKey: 'key-1234', apiSecret: 'secret' });
  assert.equal(account.api_key_hint, '1234');
  const creds = store.getAccountCredentials(account.id);
  assert.equal(creds.apiKey, 'key-1234');
  assert.equal(creds.apiSecret, 'secret');

  const tradeA = tradeInWeek({ year: 2026, week: 42 }, { id: 101, pnl: 10, source: 'api' });
  const tradeB = tradeInWeek({ year: 2026, week: 42 }, { id: 102, pnl: -5, source: 'api' });
  delete tradeA.id;
  delete tradeB.id;
  tradeA.external_id = 'fake:1';
  tradeB.external_id = 'fake:2';

  let calls = 0;
  const fake = {
    id: 'fake',
    async fetchTrades() {
      calls++;
      if (calls === 1) return { trades: [tradeA], nextCursor: '2' };
      return { trades: [tradeB, tradeA], nextCursor: null };
    },
  };

  const r1 = await syncAccount(account.id, { registry: { fake } });
  assert.equal(r1.inserted, 1);
  assert.equal(r1.done, false);
  let row = store.getAccount(account.id);
  assert.equal(row.sync_done, 0);
  assert.ok(row.sync_state.includes('2'));

  const r2 = await syncAccount(account.id, { registry: { fake } });
  assert.equal(r2.inserted, 1);
  assert.equal(r2.updated, 1); // tradeA 重现：api 行回写（upsert），不再计 skipped
  assert.equal(r2.done, true);
  row = store.getAccount(account.id);
  assert.equal(row.sync_done, 1);
  assert.equal(row.sync_state, null);

  // 完成后再次同步：走增量，重复 api 行全部走 upsert 回写
  const r3 = await syncAccount(account.id, { registry: { fake } });
  assert.equal(r3.inserted, 0);
  assert.equal(r3.updated, 2);
  assert.equal(store.listTrades().length, 2);
  assert.equal(store.listSyncRuns().length, 3);
  assert.ok(store.listSyncRuns()[0].fetched > 0);

  store.clearAllData();
  assert.equal(store.countTrades(), 0);
  assert.equal(store.listAccounts().length, 0);
  assert.equal(store.listSyncRuns().length, 0);
  closeDb();
});
