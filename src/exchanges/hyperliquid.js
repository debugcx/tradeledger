import { requestJson } from '../http-client.js';
import { num, matchFills, isSupportedSpotSymbol, SPOT_QUOTES } from './common.js';

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
};
