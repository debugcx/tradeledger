/**
 * 美元估值：稳定币固定 1，其余优先用 OKX / Binance / Gate 公共行情。
 *
 * - 进程内 5 分钟缓存，落库 24 小时内可复用（离线时也能看到上次价格）；
 * - 只做只读公共接口，不依赖第三方 Key；
 * - 拿不到价格的资产保持 null，由页面标「未估值」，不按 0 计入总额。
 */

import { requestJson } from './http-client.js';
import * as store from './store.js';

const OKX_BASE = process.env.OKX_API_BASE || 'https://www.okx.com';
const BINANCE_BASE = process.env.BINANCE_API_BASE || 'https://api.binance.com';
const GATE_BASE = process.env.GATE_API_BASE || 'https://api.gateio.ws';

const MEM_TTL_MS = 5 * 60_000;
const DB_TTL_MS = 24 * 3600_000;

// 常见美元锚定币；链上 bridged 版本（USDC.e / USDT.e）也按 1 处理
const STABLES = new Set([
  'USD', 'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDD', 'USDE', 'USDS',
  'BUSD', 'PYUSD', 'GUSD', 'FRAX', 'LUSD', 'CRVUSD', 'GHO', 'USD1',
  'USDT.E', 'USDC.E', 'USDT0', 'USDBC', 'USDB', 'SUSD',
]);

const mem = new Map(); // asset -> { price, source, at }
const misses = new Map(); // asset -> at：行情源都没有该币种时，15 分钟内不再重试
// 上限淘汰：链上代币种类多且不可枚举，Map 只增不减会慢性吃内存。
const PRICE_CACHE_MAX = 5000;

function evictOldest(map) {
  if (map.size <= PRICE_CACHE_MAX) return;
  let drop = map.size - PRICE_CACHE_MAX;
  for (const key of map.keys()) {
    map.delete(key);
    if (--drop <= 0) break;
  }
}

export function isStable(asset) {
  const a = String(asset || '').trim().toUpperCase();
  return STABLES.has(a) || /^USD[CT]?\.?[E]?$/.test(a);
}

function remember(asset, price, source) {
  const entry = { price: Number(price), source, at: Date.now() };
  if (!Number.isFinite(entry.price) || entry.price <= 0) return null;
  mem.set(asset, entry);
  evictOldest(mem);
  evictOldest(misses);
  store.savePrices([{ asset, price_usd: entry.price, source, fetched_at: new Date(entry.at).toISOString() }]);
  return entry;
}

async function okxPrice(asset) {
  const url = `${OKX_BASE}/api/v5/market/ticker?instId=${encodeURIComponent(`${asset}-USDT`)}`;
  const res = await requestJson(url, { method: 'GET', timeout: 8000, retries: 0 });
  const last = Number(res.json?.data?.[0]?.last);
  return Number.isFinite(last) && last > 0 ? { price: last, source: 'okx:/api/v5/market/ticker' } : null;
}

async function binancePrice(asset) {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(`${asset}USDT`)}`;
  const res = await requestJson(url, { method: 'GET', timeout: 8000, retries: 0 });
  const price = Number(res.json?.price);
  return Number.isFinite(price) && price > 0 ? { price, source: 'binance:/api/v3/ticker/price' } : null;
}

// Gate 自有币种（GT 等）在 OKX/Binance 没有行情时用 Gate 公共 ticker 兜底
async function gatePrice(asset) {
  const url = `${GATE_BASE}/api/v4/spot/tickers?currency_pair=${encodeURIComponent(`${asset}_USDT`)}`;
  const res = await requestJson(url, { method: 'GET', timeout: 8000, retries: 0 });
  const row = Array.isArray(res.json) ? res.json[0] : null;
  const price = Number(row?.last);
  return Number.isFinite(price) && price > 0 ? { price, source: 'gate:/api/v4/spot/tickers' } : null;
}

/**
 * 返回 { price, source, at, stale? }；拿不到返回 null。
 * 不抛错，行情失败不能影响资产同步。
 */
export async function resolvePrice(asset) {
  const symbol = String(asset || '').trim().toUpperCase();
  if (!symbol) return null;
  if (isStable(symbol)) {
    return { price: 1, source: 'stablecoin', at: Date.now() };
  }
  const hit = mem.get(symbol);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return hit;

  const cached = store.getCachedPrice(symbol);
  if (cached) {
    const at = Date.parse(cached.fetched_at || '') || 0;
    if (Date.now() - at < DB_TTL_MS) {
      const entry = { price: Number(cached.price_usd), source: cached.source || 'cache', at };
      mem.set(symbol, entry);
      return entry;
    }
  }

  const missedAt = misses.get(symbol) || 0;
  if (Date.now() - missedAt < 15 * 60_000) {
    if (!cached) return null;
    const entry = { price: Number(cached.price_usd), source: `${cached.source || 'cache'} (stale)`, at: Date.parse(cached.fetched_at || '') || 0, stale: true };
    mem.set(symbol, entry);
    return entry;
  }

  for (const fetcher of [okxPrice, binancePrice, gatePrice]) {
    try {
      const found = await fetcher(symbol);
      if (found) {
        misses.delete(symbol);
        return remember(symbol, found.price, found.source);
      }
    } catch { /* 换下一个行情源 */ }
  }

  misses.set(symbol, Date.now());
  evictOldest(misses);
  if (cached) {
    const entry = { price: Number(cached.price_usd), source: `${cached.source || 'cache'} (stale)`, at: Date.parse(cached.fetched_at || '') || 0, stale: true };
    mem.set(symbol, entry);
    return entry;
  }
  return null;
}

/** 批量估值；同一轮去重后并发 4 个，避免打爆公共接口 */
export async function resolvePrices(assets = []) {
  const unique = [...new Set(assets.map((a) => String(a || '').trim().toUpperCase()).filter(Boolean))];
  const out = new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, unique.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= unique.length) return;
      const asset = unique[i];
      out.set(asset, await resolvePrice(asset));
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 给仓位补齐 price_usd / value_usd（不覆盖索引器已经给出的估值）。
 * lookup=false 时只用仓位自带的 price/value（钱包仓位），避免把同名假币按真币行情估值。
 * 返回新数组；拿不到价格的保持 null。
 */
export async function valuePositions(positions = [], { lookup = true } = {}) {
  const rows = (positions || []).map((p) => ({ ...p }));
  const need = lookup
    ? rows
      .filter((p) => (p.value_usd === null || p.value_usd === undefined) && Number(p.amount))
      .map((p) => p.asset)
    : [];
  const prices = lookup ? await resolvePrices(need) : new Map();
  for (const p of rows) {
    const amount = Number(p.amount) || 0;
    let value = p.value_usd === null || p.value_usd === undefined ? null : Number(p.value_usd);
    let price = p.price_usd === null || p.price_usd === undefined ? null : Number(p.price_usd);
    if (!Number.isFinite(value) || value === null) {
      const found = isStable(p.asset)
        ? { price: 1 }
        : prices.get(String(p.asset || '').toUpperCase());
      if (price === null && found && Number.isFinite(Number(found.price))) price = Number(found.price);
      if (Number.isFinite(price) && price > 0) value = amount * price;
    }
    p.price_usd = Number.isFinite(price) ? price : null;
    p.value_usd = Number.isFinite(value) ? value : null;
  }
  return rows;
}

/** 仅供测试重置缓存 */
export function clearPriceCache() {
  mem.clear();
  misses.clear();
}
