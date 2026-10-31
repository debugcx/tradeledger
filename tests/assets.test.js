import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-assets-'));
process.env.DB_FILE = path.join(root, 'test.db');
process.env.TRADELEDGER_MASTER_KEY = 'cd'.repeat(32);

const store = await import('../src/store.js');
const assets = await import('../src/assets.js');
const prices = await import('../src/prices.js');
const { closeDb } = await import('../src/db.js');

after(() => closeDb());

test('buildSummary：正资产、负债、未估值分开统计', () => {
  const summary = assets.buildSummary([
    { venue_kind: 'exchange', venue_id: 1, venue_name: 'OKX', bucket: 'trading', asset: 'USDT', amount: 1000, value_usd: 1000 },
    { venue_kind: 'exchange', venue_id: 1, venue_name: 'OKX', bucket: 'spot', asset: 'BTC', amount: 0.1, value_usd: 6000 },
    { venue_kind: 'wallet', venue_id: 1, venue_name: '主钱包', bucket: 'defi_supply', asset: 'USDC', amount: 500, value_usd: 500 },
    { venue_kind: 'wallet', venue_id: 1, venue_name: '主钱包', bucket: 'defi_debt', asset: 'USDT', amount: -200, value_usd: -200 },
    { venue_kind: 'manual', venue_id: 1, venue_name: '币安 Launchpool', bucket: 'launchpool', asset: 'BNB', amount: 2, value_usd: null },
  ]);
  assert.equal(summary.total, 7500);
  assert.equal(summary.liabilities, 200);
  assert.equal(summary.net, 7300);
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.counts.manual, 1);
  const debt = summary.byBucket.find((b) => b.bucket === 'defi_debt');
  assert.equal(debt.debt, 200);
  assert.equal(debt.net, -200);
  const trading = summary.byBucket.find((b) => b.bucket === 'trading');
  assert.equal(trading.net, 1000);
});

test('资产仓位：按桶替换，失败桶保留旧数据', () => {
  const account = store.ensureDefaultAccount();
  store.replaceAssetPositions('exchange', account.id, [
    { bucket: 'futures', asset: 'USDT', amount: 1000, value_usd: 1000, source: 'test:futures' },
    { bucket: 'spot', asset: 'BTC', amount: 0.1, price_usd: 60000, value_usd: 6000, source: 'test:spot' },
  ], ['futures', 'spot']);

  let rows = store.listAssetPositions({ venueKind: 'exchange', venueId: account.id });
  assert.equal(rows.length, 2);

  // 只刷新 spot：futures 桶不应被删掉
  store.replaceAssetPositions('exchange', account.id, [
    { bucket: 'spot', asset: 'ETH', amount: 1, price_usd: 3000, value_usd: 3000, source: 'test:spot' },
  ], ['spot']);
  rows = store.listAssetPositions({ venueKind: 'exchange', venueId: account.id });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.bucket === 'futures' && r.asset === 'USDT'));
  assert.ok(rows.some((r) => r.bucket === 'spot' && r.asset === 'ETH'));
  assert.ok(!rows.some((r) => r.asset === 'BTC'));

  // 整场所替换：旧行全部清掉
  store.replaceAssetPositions('exchange', account.id, [
    { bucket: 'trading', asset: 'USDT', amount: 500, value_usd: 500, source: 'test:trading' },
  ]);
  rows = store.listAssetPositions({ venueKind: 'exchange', venueId: account.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, 'trading');
});

test('资产仓位：相同键合并金额，不再互相覆盖', () => {
  const account = store.ensureDefaultAccount();
  store.replaceAssetPositions('exchange', account.id, [
    {
      bucket: 'defi_lp', asset: 'ASTER', amount: 1, price_usd: 10, value_usd: 10,
      chain: 'bsc', protocol: 'PancakeSwap V3', product: 'ASTER/WBNB Pool', source: 'test:lp',
    },
    {
      bucket: 'defi_lp', asset: 'ASTER', amount: 2, price_usd: 10, value_usd: 20,
      chain: 'bsc', protocol: 'PancakeSwap V3', product: 'ASTER/WBNB Pool', source: 'test:lp',
    },
  ], ['defi_lp']);
  const rows = store.listAssetPositions({ venueKind: 'exchange', venueId: account.id, bucket: 'defi_lp' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 3);
  assert.equal(rows[0].value_usd, 30);
});

test('手动资产：持有计入、已赎回不计入、可删除', () => {
  const active = store.createManualAsset({
    venue_name: 'Binance Launchpool', bucket: 'launchpool', product: '第 68 期',
    asset: 'BNB', amount: 2, price_usd: 600, status: 'active', note: '认购 1200U',
  });
  store.createManualAsset({
    venue_name: 'OKX Jumpstart', bucket: 'launchpool', product: '已结束项目',
    asset: 'OKB', amount: 1, price_usd: 50, status: 'redeemed',
  });

  let summary = assets.assetSummary();
  assert.equal(summary.rows.filter((r) => r.venue_kind === 'manual').length, 1);
  assert.equal(summary.rows.find((r) => r.venue_kind === 'manual').value_usd, 1200);

  const updated = store.updateManualAsset(active.id, { amount: 3, price_usd: 600 });
  assert.equal(updated.amount, 3);
  summary = assets.assetSummary();
  assert.equal(summary.rows.find((r) => r.venue_kind === 'manual').value_usd, 1800);

  store.deleteManualAsset(active.id);
  summary = assets.assetSummary();
  assert.equal(summary.rows.filter((r) => r.venue_kind === 'manual').length, 0);
});

test('refreshExchangeAssets：按桶写入，部分失败记录原因且不影响其他桶', async () => {
  const { getExchange } = await import('../src/exchanges/index.js');
  const adapter = getExchange('okx');
  const original = adapter.fetchAssetPositions;
  adapter.fetchAssetPositions = async () => ({
    positions: [
      { bucket: 'trading', asset: 'USDT', amount: 1000, value_usd: 1000, source: 'mock:/trading' },
      { bucket: 'earn_flexible', asset: 'USDC', amount: 500, value_usd: 500, source: 'mock:/earn' },
    ],
    buckets: ['trading', 'earn_flexible'],
    errors: ['链上质押：权限不足'],
  });
  try {
    const account = store.createAccount({
      exchange: 'okx', name: 'OKX Test', apiKey: 'key', apiSecret: 'secret', passphrase: 'pass',
    });
    const result = await assets.refreshExchangeAssets(account);
    assert.equal(result.inserted, 2);
    assert.deepEqual(result.errors, ['链上质押：权限不足']);

    const rows = store.listAssetPositions({ venueKind: 'exchange', venueId: account.id });
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.bucket === 'trading' && r.asset === 'USDT'));
    assert.ok(rows.some((r) => r.bucket === 'earn_flexible' && r.asset === 'USDC'));

    const run = store.listAssetSyncRuns(20)
      .find((r) => r.venue_kind === 'exchange' && r.venue_id === account.id);
    assert.equal(run.status, 'partial');
    assert.match(run.message, /权限不足/);
  } finally {
    adapter.fetchAssetPositions = original;
  }
});

test('钱包仓位估值：lookup=false 时不按同名币行情给未定价代币赋值', async () => {
  const rows = await prices.valuePositions([
    { asset: 'USDG', amount: 100, price_usd: null, value_usd: null, source: 'zerion:/positions' },
    { asset: 'USDG', amount: 0.000029, price_usd: 1, value_usd: null, source: 'zerion:/positions' },
  ], { lookup: false });
  assert.equal(rows[0].value_usd, null);
  assert.equal(rows[1].value_usd, 0.000029);
});

test('钱包同步周期：页面设置可保存、校验范围，未设置时回落默认', () => {
  assert.equal(store.getWalletRefreshSetting(), null); // 测试库未设置过
  assert.equal(store.setWalletRefreshSetting(240), 240);
  assert.equal(store.getWalletRefreshSetting(), 240);
  assert.equal(store.setWalletRefreshSetting(10080), 10080);
  assert.throws(() => store.setWalletRefreshSetting(1), /不能小于/);
  assert.throws(() => store.setWalletRefreshSetting('abc'), /不能小于/);
});

test('每日快照：写入当日净资产并可读取', () => {
  const summary = assets.assetSummary();
  assets.captureAssetSnapshot(summary);
  assets.captureAssetSnapshot(summary); // 同日重复写入按 UPSERT 只有一行
  const snapshots = store.listAssetSnapshots(10);
  assert.equal(snapshots.length, 1);
  assert.equal(Number(snapshots[0].net_usd), summary.net);
  assert.equal(Number(snapshots[0].total_usd), summary.total);
});
