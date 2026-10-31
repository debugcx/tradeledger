/**
 * 资产聚合引擎。
 *
 * 统一口径：场所（交易所 / 链上钱包 / 手动）× 资产桶 × 币种。
 * 交易所走只读 API，链上走索引服务，API 覆盖不到的打新/锁仓走手动台账。
 * 每次刷新后按当日汇总写入 asset_snapshots，供资产曲线使用。
 */

import { config } from './config.js';
import * as store from './store.js';
import { getExchange } from './exchanges/index.js';
import { getWalletProvider } from './wallets/index.js';
import { valuePositions, resolvePrice } from './prices.js';

export const BUCKET_LABELS = {
  trading: '交易账户',
  futures: '合约账户',
  spot: '现货',
  funding: '资金账户',
  earn_flexible: '活期理财',
  earn_locked: '定期理财',
  staking: '链上质押',
  launchpool: '打新 / Launchpool',
  wallet: '链上钱包',
  defi_supply: 'DeFi 存款',
  defi_debt: 'DeFi 借款',
  defi_lp: 'DeFi LP',
  defi_staking: 'DeFi 质押',
  defi_reward: 'DeFi 奖励',
  other: '其他',
};

export const BUCKET_ORDER = [
  'trading', 'futures', 'spot', 'funding', 'earn_flexible', 'earn_locked',
  'staking', 'launchpool', 'wallet', 'defi_supply', 'defi_lp', 'defi_staking',
  'defi_reward', 'defi_debt', 'other',
];

export const LIABILITY_BUCKETS = new Set(['defi_debt']);

export const bucketLabel = (bucket) => BUCKET_LABELS[String(bucket || '').toLowerCase()] || String(bucket || '其他');

const EXCHANGE_TTL_MS = config.assetRefreshMinutes * 60_000;

/** 钱包刷新周期：页面设置优先，env/默认值兜底（索引器按次计费，最小 5 分钟） */
export function walletTtlMs() {
  const minutes = store.getWalletRefreshSetting() ?? config.walletRefreshMinutes;
  return Math.max(5, Number(minutes) || config.walletRefreshMinutes) * 60_000;
}

/** 仓位超过两个刷新周期没更新时，页面上标「旧」 */
export function staleMs() {
  return Math.max(EXCHANGE_TTL_MS, walletTtlMs()) * 2;
}

let inflight = null;
const lastAttempt = new Map(); // `exchange:1` / `wallet:2` -> { at, ok }

function parseChains(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function manualAssetRows() {
  return store.listManualAssets()
    .filter((a) => a.status !== 'redeemed')
    .map((a) => {
      const amount = Number(a.amount) || 0;
      const price = a.price_usd === null || a.price_usd === undefined ? null : Number(a.price_usd);
      const value = a.value_usd === null || a.value_usd === undefined
        ? (price === null ? null : amount * price)
        : Number(a.value_usd);
      return {
        venue_kind: 'manual',
        venue_id: a.id,
        venue_name: a.venue_name,
        venue_meta: 'manual',
        bucket: a.bucket || 'launchpool',
        asset: a.asset,
        chain: '',
        protocol: '',
        product: a.product || '',
        amount,
        price_usd: price,
        value_usd: Number.isFinite(value) ? value : null,
        source: 'manual',
        source_ref: a.note || '',
        fetched_at: a.updated_at,
        locked_until: a.locked_until,
        status: a.status,
        manual_id: a.id,
        note: a.note || '',
      };
    })
    .filter((r) => r.asset && r.amount !== 0);
}

/** 纯函数：把仓位聚合成总额、桶、场所、币种与来源统计 */
export function buildSummary(rows = []) {
  const list = (rows || []).filter((r) => r && r.asset && Number(r.amount) !== 0);
  const byBucket = new Map();
  const byVenue = new Map();
  const byAsset = new Map();
  let total = 0;
  let liabilities = 0;
  let unpriced = 0;
  let updatedAt = null;
  const sourceCounts = { exchange: 0, wallet: 0, manual: 0 };

  const bucketOf = (key) => {
    if (!byBucket.has(key)) {
      byBucket.set(key, { bucket: key, label: bucketLabel(key), gross: 0, debt: 0, net: 0, count: 0, unpriced: 0 });
    }
    return byBucket.get(key);
  };
  const venueOf = (row) => {
    const key = row.venue_kind === 'manual'
      ? `manual:${row.venue_name || ''}`
      : `${row.venue_kind}:${row.venue_id}`;
    if (!byVenue.has(key)) {
      byVenue.set(key, {
        key, kind: row.venue_kind, id: row.venue_id, name: row.venue_name || '',
        meta: row.venue_meta || '', gross: 0, debt: 0, net: 0, count: 0, unpriced: 0,
      });
    }
    return byVenue.get(key);
  };

  for (const row of list) {
    const value = row.value_usd === null || row.value_usd === undefined ? null : Number(row.value_usd);
    const bucket = bucketOf(row.bucket);
    const venue = venueOf(row);
    bucket.count++;
    venue.count++;
    if (row.fetched_at && (!updatedAt || row.fetched_at > updatedAt)) updatedAt = row.fetched_at;
    if (sourceCounts[row.venue_kind] !== undefined) sourceCounts[row.venue_kind]++;

    if (!Number.isFinite(value)) {
      unpriced++;
      bucket.unpriced++;
      venue.unpriced++;
      continue;
    }
    if (value >= 0) {
      total += value;
      bucket.gross += value;
      venue.gross += value;
    } else {
      const debt = -value;
      liabilities += debt;
      bucket.debt += debt;
      venue.debt += debt;
    }
    const assetKey = row.asset;
    if (!byAsset.has(assetKey)) byAsset.set(assetKey, { asset: assetKey, gross: 0, debt: 0, net: 0, count: 0 });
    const asset = byAsset.get(assetKey);
    asset.count++;
    if (value >= 0) asset.gross += value;
    else asset.debt += -value;
  }

  for (const b of byBucket.values()) b.net = b.gross - b.debt;
  for (const v of byVenue.values()) v.net = v.gross - v.debt;
  for (const a of byAsset.values()) a.net = a.gross - a.debt;

  const bucketRows = [...byBucket.values()].sort((a, b) => {
    const ia = BUCKET_ORDER.indexOf(a.bucket);
    const ib = BUCKET_ORDER.indexOf(b.bucket);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const venueRows = [...byVenue.values()].sort((a, b) => b.net - a.net);
  const assetRows = [...byAsset.values()].sort((a, b) => b.net - a.net);

  return {
    total,
    liabilities,
    net: total - liabilities,
    unpriced,
    rows: list,
    byBucket: bucketRows,
    byVenue: venueRows,
    byAsset: assetRows,
    updatedAt,
    sourceCounts,
    counts: {
      exchange: list.filter((r) => r.venue_kind === 'exchange').length,
      wallet: list.filter((r) => r.venue_kind === 'wallet').length,
      manual: list.filter((r) => r.venue_kind === 'manual').length,
    },
  };
}

export function assetSummary() {
  return buildSummary([...store.listAssetPositions(), ...manualAssetRows()]);
}

function localDateKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function captureAssetSnapshot(summary = assetSummary()) {
  const byBucket = {};
  for (const b of summary.byBucket) byBucket[b.bucket] = b.net;
  const byVenue = {};
  for (const v of summary.byVenue) byVenue[`${v.kind}:${v.id}:${v.name}`] = v.net;
  store.saveAssetSnapshot({
    date: localDateKey(),
    total_usd: summary.total,
    net_usd: summary.net,
    liabilities_usd: summary.liabilities,
    unpriced: summary.unpriced,
    by_bucket: byBucket,
    by_venue: byVenue,
  });
}

async function fillManualValues() {
  const assets = store.listManualAssets({ status: 'active' });
  for (const a of assets) {
    if (a.value_usd !== null && a.value_usd !== undefined) continue;
    let price = a.price_usd === null || a.price_usd === undefined ? null : Number(a.price_usd);
    if (price === null) {
      const found = await resolvePrice(a.asset);
      if (found) price = found.price;
    }
    if (price === null) continue;
    store.updateManualAsset(a.id, {
      price_usd: price,
      value_usd: (Number(a.amount) || 0) * price,
    });
  }
}

async function fallbackExchangePositions(adapter, creds) {
  const positions = [];
  const buckets = [];
  const errors = [];
  if (adapter.fetchLive) {
    try {
      const live = await adapter.fetchLive(creds);
      buckets.push('futures');
      for (const b of live.balances || []) {
        positions.push({
          bucket: 'futures', asset: b.asset, amount: Number(b.total) || 0,
          source: `${adapter.id}:/fetchLive`, source_ref: '合约账户',
        });
      }
    } catch (err) {
      errors.push(`合约：${err?.message || err}`);
    }
  }
  if (adapter.fetchSpotLive) {
    try {
      const spot = await adapter.fetchSpotLive(creds);
      buckets.push('spot');
      for (const b of spot.balances || []) {
        positions.push({
          bucket: 'spot', asset: b.asset, amount: Number(b.total) || 0,
          source: `${adapter.id}:/fetchSpotLive`, source_ref: '现货账户',
        });
      }
    } catch (err) {
      errors.push(`现货：${err?.message || err}`);
    }
  }
  if (!buckets.length) throw new Error(errors.join('；') || '适配器没有可用的资产接口');
  return { positions, buckets, errors };
}

export async function refreshExchangeAssets(account) {
  const adapter = getExchange(account.exchange);
  if (!adapter) throw new Error(`不支持的交易所：${account.exchange || '未知'}`);
  const creds = store.getAccountCredentials(account.id);
  const runId = store.startAssetSyncRun('exchange', account.id, adapter.id);
  try {
    const result = adapter.fetchAssetPositions
      ? await adapter.fetchAssetPositions(creds)
      : await fallbackExchangePositions(adapter, creds);
    const buckets = Array.isArray(result.buckets) ? result.buckets : [];
    if (!buckets.length) throw new Error((result.errors || []).join('；') || '没有拉到任何资产');
    const valued = await valuePositions(result.positions || []);
    const inserted = store.replaceAssetPositions('exchange', account.id, valued, buckets);
    const errors = result.errors || [];
    lastAttempt.set(`exchange:${account.id}`, { at: Date.now(), ok: errors.length === 0 });
    store.finishAssetSyncRun(runId, {
      status: errors.length ? 'partial' : 'ok',
      message: errors.join('；'),
      positions: inserted,
    });
    return { ok: true, inserted, errors };
  } catch (err) {
    lastAttempt.set(`exchange:${account.id}`, { at: Date.now(), ok: false });
    store.finishAssetSyncRun(runId, { status: 'error', message: err?.message || String(err), positions: 0 });
    throw err;
  }
}

export async function refreshWalletAssets(wallet) {
  const provider = getWalletProvider(wallet.provider);
  if (!provider) throw new Error(`不支持的索引服务：${wallet.provider}`);
  const runId = store.startAssetSyncRun('wallet', wallet.id, provider.id);
  try {
    const creds = store.getWalletProviderCredentials(provider.id);
    const result = await provider.fetchPositions({
      address: wallet.address,
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      chains: parseChains(wallet.chains),
    });
    // 钱包仓位只信任索引器给出的价格/市值；不要用同名币行情二次估值
    const valued = await valuePositions(result.positions || [], { lookup: false });
    const inserted = store.replaceAssetPositions('wallet', wallet.id, valued);
    const errors = result.errors || [];
    const notes = result.notes || [];
    const message = [...errors, ...notes].join('；');
    lastAttempt.set(`wallet:${wallet.id}`, { at: Date.now(), ok: errors.length === 0 });
    store.updateWalletSync(wallet.id, {
      status: errors.length ? 'partial' : 'ok',
      message,
    });
    store.finishAssetSyncRun(runId, {
      status: errors.length ? 'partial' : 'ok',
      message,
      positions: inserted,
    });
    return { ok: true, inserted, errors, notes };
  } catch (err) {
    lastAttempt.set(`wallet:${wallet.id}`, { at: Date.now(), ok: false });
    store.updateWalletSync(wallet.id, { status: 'error', message: err?.message || String(err) });
    store.finishAssetSyncRun(runId, { status: 'error', message: err?.message || String(err), positions: 0 });
    throw err;
  }
}

function due(key, ttl) {
  const last = lastAttempt.get(key);
  if (!last) return true;
  return Date.now() - last.at >= ttl;
}

/**
 * 刷新资产。force=true 忽略 TTL；kind 可只刷新 exchange 或 wallet。
 * 单个场所失败不影响其他场所，错误会写进 sync run 与返回值。
 */
export async function refreshAssets({ force = false, kind = 'all' } = {}) {
  if (inflight) {
    // 后台刷新进行中时，非强制请求直接复用；强制请求等它结束后再跑一轮
    if (!force) return inflight;
    await inflight.catch(() => {});
  }
  inflight = (async () => {
    const result = { at: new Date().toISOString(), exchange: [], wallet: [], errors: [] };
    const accounts = store.listAccounts().filter((a) => !a.is_demo && a.exchange !== 'manual');
    const wallets = store.listWallets().filter((w) => w.enabled);

    if (kind === 'all' || kind === 'exchange') {
      for (const account of accounts) {
        const key = `exchange:${account.id}`;
        if (!force && !due(key, EXCHANGE_TTL_MS)) continue;
        try {
          const r = await refreshExchangeAssets(account);
          lastAttempt.set(key, { at: Date.now(), ok: true });
          result.exchange.push({ id: account.id, name: account.name, ...r });
          if (r.errors?.length) result.errors.push(`${account.name}: ${r.errors.join('；')}`);
        } catch (err) {
          lastAttempt.set(key, { at: Date.now(), ok: false });
          result.errors.push(`${account.name}: ${err?.message || err}`);
        }
      }
    }

    if (kind === 'all' || kind === 'wallet') {
      for (const wallet of wallets) {
        const key = `wallet:${wallet.id}`;
        if (!force && !due(key, walletTtlMs())) continue;
        try {
          const r = await refreshWalletAssets(wallet);
          lastAttempt.set(key, { at: Date.now(), ok: true });
          result.wallet.push({ id: wallet.id, name: wallet.name, ...r });
          if (r.errors?.length) result.errors.push(`${wallet.name}: ${r.errors.join('；')}`);
        } catch (err) {
          lastAttempt.set(key, { at: Date.now(), ok: false });
          result.errors.push(`${wallet.name}: ${err?.message || err}`);
        }
      }
    }

    try {
      await fillManualValues();
    } catch (err) {
      result.errors.push(`手动资产估值：${err?.message || err}`);
    }
    captureAssetSnapshot();
    return result;
  })().finally(() => { inflight = null; });

  return inflight;
}

/** 测试用：清掉 TTL 记忆 */
export function resetAssetRefreshState() {
  lastAttempt.clear();
}
