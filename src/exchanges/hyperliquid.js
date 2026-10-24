import { requestJson } from '../http-client.js';
import { num, matchFills, isSupportedSpotSymbol, SPOT_QUOTES, marketCache, cacheGet, cachePut } from './common.js';

const candleCache = marketCache('hyperliquid:candles');
const fillCache = marketCache('hyperliquid:fills');

/**
 * Hyperliquid 只读接入。
 *
 * 只需要钱包地址（无需 API Key/签名），从 Info 接口拉成交流水：
 * POST https://api.hyperliquid.xyz/info { type: 'userFillsByTime', user, startTime, endTime }
 * 本地 FIFO 还原 round trip。
 */

const BASE = process.env.HYPERLIQUID_API_BASE || 'https://api.hyperliquid.xyz/info';

async function info(body, opts = {}) {
  const res = await requestJson(BASE, {
    method: 'POST',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = res.json;
  if (!data) throw new Error(`Hyperliquid 返回无法解析（HTTP ${res.status}）`);
  if (data.error) throw new Error(`Hyperliquid: ${data.error}`);
  return data;
}

function toFill(row) {
  return {
    id: row.tid,
    symbol: `${String(row.coin || '').toUpperCase()}/USDC`,
    side: String(row.side).toUpperCase() === 'B' ? 'buy' : 'sell',
    price: num(row.px),
    qty: num(row.sz),
    // HL 的 fee 是正数支出
    fee: -Math.abs(num(row.fee)),
    time: Number(row.time || 0),
    orderType: 'other',
  };
}

export const hyperliquid = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  maxLookbackDays: 3650,
  maxSpotLookbackDays: 3650,
  fields: [
    { key: 'wallet', label: '钱包地址', placeholder: '0x...' },
  ],
  tips: [
    '只需要公开钱包地址，不需要 API Key 或私钥',
    '建议使用专门用于交易的地址，不要把私钥填进任何网站',
  ],

  async verify(creds) {
    const state = await info({ type: 'clearinghouseState', user: creds.wallet }, { timeout: 12000, retries: 0 });
    return { detail: state?.marginSummary?.accountValue || 'OK' };
  },

  async fetchTrades({ creds, fromMs, toMs, cursor, limit }) {
    const cap = Math.max(100, Number(limit) || 1000);
    const endBound = cursor ? Math.min(toMs, Number(cursor)) : toMs;
    const fillsRaw = await info({
      type: 'userFillsByTime',
      user: creds.wallet,
      startTime: fromMs,
      endTime: endBound,
      aggregateByTime: false,
    });
    const rows = Array.isArray(fillsRaw) ? fillsRaw : [];
    if (!rows.length) return { trades: [], nextCursor: null };

    const sorted = rows.map(toFill).sort((a, b) => a.time - b.time);
    const batch = sorted.length > cap ? sorted.slice(-cap) : sorted;
    const nextCursor = sorted.length > cap ? String(batch[0].time - 1) : null;
    return { trades: matchFills(batch, 'hyperliquid'), nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const rows = await info({
      type: 'userFunding',
      user: creds.wallet,
      startTime: fromMs,
      endTime: toMs,
    });
    const events = (Array.isArray(rows) ? rows : []).map((row) => {
      const delta = row.delta || {};
      const time = Number(row.time || 0);
      return {
        external_id: `hl:fund:${row.hash || `${delta.coin}:${time}:${delta.usdc}`}`,
        symbol: `${String(delta.coin || '').toUpperCase()}/USDC`,
        time: new Date(time).toISOString(),
        amount: num(delta.usdc),
      };
    }).filter((e) => e.symbol !== '/USDC');
    return { events: events.slice(0, cap), nextCursor: null };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const rows = await info({
      type: 'userNonFundingLedgerUpdates',
      user: creds.wallet,
      startTime: fromMs,
      endTime: toMs,
    });
    const transfers = (Array.isArray(rows) ? rows : []).slice(0, cap).map((row) => {
      const delta = row.delta || {};
      const rawType = String(delta.type || 'other');
      const time = Number(row.time || 0);
      if (!time) return null;
      const amount = num(delta.usdc ?? delta.amount);
      let type = 'other';
      if (rawType === 'deposit') type = 'deposit';
      else if (rawType === 'withdraw') type = 'withdraw';
      else if (rawType === 'internalTransfer' || rawType === 'subAccountTransfer'
        || rawType === 'accountClassTransfer' || rawType === 'spotTransfer') {
        type = amount >= 0 ? 'internal_in' : 'internal_out';
      }
      const asset = delta.token || (rawType === 'spotTransfer' ? '' : 'USDC');
      return {
        external_id: `hl:ledger:${row.hash || `${time}:${rawType}`}`,
        type,
        asset: asset || 'USDC',
        amount,
        fee: Math.abs(num(delta.fee)),
        tx_time: new Date(time).toISOString(),
        tx_id: row.hash || '',
        chain: 'Hyperliquid',
        counterparty: delta.destination || '',
        note: rawType,
      };
    }).filter(Boolean);
    return { transfers, nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const rows = await info({
      type: 'userFillsByTime',
      user: creds.wallet,
      startTime: fromMs,
      endTime: toMs,
      aggregateByTime: false,
    });
    const fills = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const coin = String(row.coin || '').toUpperCase();
      if (!coin.includes('/') || !isSupportedSpotSymbol(coin)) continue;
      fills.push({
        id: row.tid,
        symbol: coin,
        side: String(row.side).toUpperCase() === 'B' ? 'buy' : 'sell',
        price: num(row.px),
        qty: num(row.sz),
        fee: -Math.abs(num(row.fee)),
        time: Number(row.time || 0),
        orderType: 'other',
      });
    }
    fills.sort((a, b) => a.time - b.time);
    return { fills: fills.slice(0, cap), nextCursor: null };
  },

  async fetchSpotLive(creds) {
    const state = await info({ type: 'spotClearinghouseState', user: creds.wallet });
    const balances = [];
    const holdings = [];
    for (const b of state.balances || []) {
      const total = num(b.total);
      if (total <= 0) continue;
      const hold = num(b.hold);
      balances.push({ asset: b.coin, total, free: Math.max(0, total - hold) });
      if (SPOT_QUOTES.has(b.coin)) continue;
      holdings.push({
        symbol: `${String(b.coin).toUpperCase()}/USDC`,
        asset: String(b.coin).toUpperCase(),
        quote: 'USDC',
        quantity: total,
        price: null,
        value: null,
      });
    }
    return { balances, holdings };
  },

  async fetchLive(creds) {
    const [state, meta] = await Promise.all([
      info({ type: 'clearinghouseState', user: creds.wallet }),
      info({ type: 'metaAndAssetCtxs' }),
    ]);
    const universe = Array.isArray(meta) ? (meta[0]?.universe || []) : [];
    const contexts = Array.isArray(meta) ? (meta[1] || []) : [];
    const ctxByCoin = new Map();
    universe.forEach((u, i) => ctxByCoin.set(u.name, contexts[i] || null));

    const accountValue = num(state?.marginSummary?.accountValue);
    const balances = Math.abs(accountValue) > 0
      ? [{ asset: 'USDC', total: accountValue, free: num(state.withdrawable) }]
      : [];

    const positions = [];
    for (const item of state?.assetPositions || []) {
      const p = item.position || {};
      const szi = num(p.szi);
      if (!szi) continue;
      const ctx = ctxByCoin.get(p.coin);
      positions.push({
        symbol: `${String(p.coin).toUpperCase()}/USDC`,
        side: szi > 0 ? 'long' : 'short',
        size: Math.abs(szi),
        entry_price: num(p.entryPx),
        mark_price: ctx?.markPx !== undefined ? num(ctx.markPx) : (Math.abs(szi) ? Math.abs(num(p.positionValue) / szi) : 0),
        unrealized: num(p.unrealizedPnl),
        funding_rate: ctx?.funding !== undefined ? num(ctx.funding) : null,
        next_funding_time: null,
      });
    }
    return { balances, positions };
  },

  // 行情 K 线（公共接口）。行 = [秒级时间, 开, 收, 高, 低, 成交量, 笔数]，注意 o/c/h/l 顺序。
  async fetchCandles({ symbol, market = 'futures', fromMs, toMs }) {
    const coin = String(symbol || '').split('/')[0].toUpperCase();
    if (!coin) return { bar: '1h', candles: [], truncated: false };
    const bars = [
      ['1m', 60_000], ['3m', 180_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
      ['1h', 3_600_000], ['2h', 7_200_000], ['4h', 14_400_000], ['8h', 28_800_000],
      ['12h', 43_200_000], ['1d', 86_400_000],
    ];
    const dur = Math.max(0, Number(toMs) - Number(fromMs));
    let bar = '1d', barMs = 86_400_000;
    for (const [name, ms] of bars) {
      if (dur / ms <= 90) { bar = name; barMs = ms; break; }
    }
    const cacheKey = `hc|${coin}|${bar}|${Math.floor(fromMs / barMs)}|${Math.floor(toMs / barMs)}`;
    const hit = cacheGet(candleCache, cacheKey);
    if (hit) return hit;

    const rows = await info({
      type: 'candleSnapshot',
      req: { coin, interval: bar, startTime: Number(fromMs), endTime: Number(toMs) },
    });
    const out = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ t: Number(r[0]) * 1000, o: num(r[1]), c: num(r[2]), h: num(r[3]), l: num(r[4]) }))
      .filter((k) => k.t >= Number(fromMs) && k.t <= Number(toMs))
      .sort((a, b) => a.t - b.t);
    const result = { bar, candles: out.slice(0, 300), truncated: out.length >= 300 };
    return cachePut(candleCache, cacheKey, result);
  },

  // 某个回合的逐笔成交（公共接口，只需钱包地址）
  async fetchEpisodeFills({ creds, symbol, market = 'futures', fromMs, toMs, limit }) {
    const coin = String(symbol || '').split('/')[0].toUpperCase();
    if (!coin || !creds?.wallet) return { fills: [] };
    const cap = Math.max(50, Number(limit) || 300);
    const cacheKey = `hf|${creds.wallet}|${coin}|${fromMs}|${toMs}`;
    const hit = cacheGet(fillCache, cacheKey);
    if (hit) return hit;

    const rows = await info({
      type: 'userFillsByTime',
      user: creds.wallet,
      startTime: Math.max(0, Number(fromMs)),
      endTime: Number(toMs),
    });
    const out = (Array.isArray(rows) ? rows : [])
      .filter((r) => String(r.coin || '').toUpperCase() === coin)
      .map((r) => ({
        t: Number(r.time || 0),
        side: String(r.side || '').toUpperCase() === 'B' ? 'buy' : 'sell',
        price: num(r.px), qty: num(r.sz),
        fee: -Math.abs(num(r.fee)), feeCcy: 'USDC', billId: r.tid || '',
      }))
      .filter((f) => f.t >= Number(fromMs) && f.t <= Number(toMs))
      .sort((a, b) => a.t - b.t);
    const result = { fills: out.slice(0, cap) };
    return cachePut(fillCache, cacheKey, result);
  },
};
