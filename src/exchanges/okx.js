import { hmacBase64 } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, msToIso, toSymbol, splitPair, quoteFee, isSupportedSpotSymbol, SPOT_QUOTES } from './common.js';

/**
 * OKX 只读接入（USDT 本位 / 币本位永续）
 * 文档：https://www.okx.com/docs-v5/en/
 *
 * 用 /api/v5/account/positions-history 拉取已平仓仓位：
 * 每个仓位天然是一笔 round trip，包含开/平仓均价、已实现盈亏、手续费与资金费。
 */

const BASE = process.env.OKX_API_BASE || 'https://www.okx.com';

async function call(path, { apiKey, apiSecret, passphrase }, opts = {}) {
  const ts = new Date().toISOString();
  const res = await requestJson(BASE + path, {
    method: 'GET',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: {
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': hmacBase64(apiSecret, ts + 'GET' + path),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': passphrase || '',
      'content-type': 'application/json',
    },
  });
  const data = res.json;
  if (!data) throw new Error(`OKX 返回无法解析（HTTP ${res.status}）`);
  if (data.code !== '0') {
    if (String(data.code) === '50011') throw new Error('OKX 限流（50011）：请求过于频繁，请稍后再试');
    throw new Error(`OKX ${data.code}: ${data.msg || ''}`);
  }
  return data.data || [];
}

async function publicGet(path) {
  const res = await requestJson(BASE + path);
  const data = res.json;
  if (!data || data.code !== '0') throw new Error(`OKX 公共接口错误（HTTP ${res.status}）`);
  return data.data || [];
}

function inferSide(row) {
  const direct = String(row.posSide || row.direction || '').toLowerCase();
  if (direct === 'long' || direct === 'short') return direct;
  const pnl = num(row.realizedPnl ?? row.pnl);
  const open = num(row.openAvgPx);
  const close = num(row.closeAvgPx);
  if (!open || !close) return 'long';
  return pnl >= 0 ? (close >= open ? 'long' : 'short') : (close < open ? 'long' : 'short');
}

function msOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(value);
  return Number.isFinite(d) ? d : 0;
}

/**
 * OKX positions-history 的 after 是「时间戳」，不是 posId。
 * 用本页最后一行的 uTime + 1 作为下一页游标（同一毫秒可能有多行，+1 防止漏行）。
 */
export function nextCursorOf(rows, pageSize) {
  if (!Array.isArray(rows) || rows.length < pageSize) return null;
  const last = rows[rows.length - 1] || {};
  const t = msOf(last.uTime) || msOf(last.cTime) || msOf(last.closeTime) || msOf(last.openTime);
  return t > 0 ? String(t + 1) : null;
}

function toTrade(row) {  const openMs = Number(row.openTime || row.cTime || 0);
  const closeMs = Number(row.closeTime || row.uTime || openMs);
  if (!openMs || !closeMs) return null;
  const entry = num(row.openAvgPx);
  const exit = num(row.closeAvgPx);
  if (!entry && !exit) return null;
  const side = inferSide(row);
  const fee = num(row.fee) + num(row.liqPenalty);
  const funding = num(row.fundingFee);
  const pnl = row.realizedPnl !== undefined && row.realizedPnl !== null ? num(row.realizedPnl) : num(row.pnl);

  // 仓位大小统一换算成「币」：OKX 的 openMaxPos 是张数，直接拿去做价格复算会差合约面值。
  // 用毛盈亏 ÷ 价差反推币数量，使 notional 与复算口径一致；价差为 0 时退回张数。
  const dir = side === 'long' ? 1 : -1;
  const priceDiff = (exit - entry) * dir;
  const gross = pnl - fee - funding;
  let size = Math.abs(num(row.openMaxPos || row.closeTotalPos));
  if (Math.abs(priceDiff) > 1e-12) {
    const implied = Math.abs(gross / priceDiff);
    if (Number.isFinite(implied) && implied > 0) size = implied;
  }

  return {
    external_id: `okx:${row.posId || `${row.instId}:${openMs}:${closeMs}`}`,
    symbol: toSymbol(row.instId, 'USDT'),
    side,
    order_type: 'other',
    size,
    notional: size * entry,
    entry_price: entry,
    exit_price: exit,
    open_time: msToIso(openMs),
    close_time: msToIso(closeMs),
    pnl,
    fee,
    funding,
    source: 'api',
  };
}

export const okx = {
  id: 'okx',
  name: 'OKX',
  maxLookbackDays: 90,
  maxSpotLookbackDays: 90,
  fields: [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'Secret Key' },
    { key: 'passphrase', label: 'Passphrase' },
  ],
  tips: [
    'OKX → 账户 → API → 创建 API',
    '权限只勾「读取」，不要开启交易/提现',
    'Passphrase 是创建 API 时单独设置的，不是登录密码；区分大小写',
  ],

  async verify(creds) {
    const rows = await call('/api/v5/account/balance?ccy=USDT', creds, { timeout: 12000, retries: 0 });
    return { detail: rows[0]?.totalEq || 'OK' };
  },

  async fetchTrades({ creds, fromMs, toMs, cursor, limit }) {
    const pageSize = Math.min(100, Math.max(10, Number(limit) || 100));
    const query = new URLSearchParams({
      instType: 'SWAP',
      limit: String(pageSize),
      begin: String(Math.max(0, fromMs - 1)),
    });
    // after 已经是时间上界，避免和 end 同时出现导致参数冲突
    if (cursor) query.set('after', cursor);
    else query.set('end', String(toMs));
    const rawRows = await call(`/api/v5/account/positions-history?${query}`, creds);
    // OKX 在带 after 时不保证遵守 begin，可能继续返回早于窗口的数据；
    // 这里按回溯起点再过滤一次，避免无限往更早翻。
    const rows = (Array.isArray(rawRows) ? rawRows : []).filter((row) => {
      const t = msOf(row.uTime) || msOf(row.closeTime) || msOf(row.openTime);
      return !t || t >= fromMs;
    });
    const trades = rows.map(toTrade).filter(Boolean);
    const nextCursor = nextCursorOf(rows, pageSize);
    return { trades, nextCursor };
  },

  async fetchFunding() {
    // OKX 的 fundingFee 已经包含在 positions-history 里，不需要单独拉
    return { events: [], nextCursor: null };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    const pull = async (path, idField, type) => {
      let after = String(Number(toMs) + 1);
      for (let page = 0; page < 10 && out.length < cap; page++) {
        const q = new URLSearchParams({ limit: '100', after });
        const rows = await call(`${path}?${q}`, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const row of rows) {
          const time = Number(row.ts || 0);
          if (!time) continue;
          out.push({
            external_id: `okx:${type}:${row[idField] || `${row.txId || ''}:${time}`}`,
            type: type === 'dep' ? 'deposit' : 'withdraw',
            asset: row.ccy || '',
            amount: Math.abs(num(row.amt)),
            fee: Math.abs(num(row.fee)),
            tx_time: new Date(time).toISOString(),
            tx_id: row.txId || '',
            chain: row.chain || '',
            counterparty: type === 'dep' ? (row.from || '') : (row.to || ''),
            note: row.state !== undefined ? `state=${row.state}` : '',
          });
        }
        const oldest = Math.min(...rows.map((r) => Number(r.ts || 0)).filter(Boolean));
        if (!oldest || oldest <= fromMs) break;
        after = String(oldest);
      }
    };
    await pull('/api/v5/asset/deposit-history', 'depId', 'dep');
    await pull('/api/v5/asset/withdrawal-history', 'wdId', 'wd');
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const fills = [];
    let cursor = null;
    for (let page = 0; page < 20 && fills.length < cap; page++) {
      const q = new URLSearchParams({
        instType: 'SPOT',
        limit: '100',
        begin: String(Math.max(0, fromMs)),
        end: String(toMs),
      });
      if (cursor) q.set('after', cursor);
      const rows = await call(`/api/v5/trade/fills-history?${q}`, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        const symbol = toSymbol(row.instId);
        if (!isSupportedSpotSymbol(symbol)) continue;
        const { base, quote } = splitPair(symbol);
        const price = num(row.fillPx);
        const fee = quoteFee(row.fee, row.feeCcy, base, quote, price);
        fills.push({
          id: row.billId || row.tradeId,
          symbol,
          side: String(row.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
          price,
          qty: num(row.fillSz),
          fee: -fee,
          time: Number(row.fillTime || row.ts || 0),
          orderType: row.ordType,
        });
      }
      const last = rows[rows.length - 1];
      const next = last.billId || last.tradeId;
      if (!next || next === cursor || rows.length < 100) break;
      cursor = next;
    }
    return { fills: fills.slice(0, cap), nextCursor: null };
  },

  async fetchSpotLive(creds) {
    const trading = await call('/api/v5/account/balance', creds);
    let funding = [];
    try {
      funding = await call('/api/v5/asset/balances', creds);
    } catch { /* 没有资金账户权限时只展示交易账户 */ }

    const map = new Map();
    for (const d of trading[0]?.details || []) {
      const total = num(d.eq ?? d.cashBal);
      if (!d.ccy || total <= 0) continue;
      map.set(d.ccy, { asset: d.ccy, total, free: num(d.availBal ?? d.availEq) });
    }
    for (const b of Array.isArray(funding) ? funding : []) {
      const total = num(b.bal);
      if (!b.ccy || total <= 0) continue;
      const current = map.get(b.ccy);
      if (current) {
        current.total += total;
        current.free += num(b.availBal);
      } else {
        map.set(b.ccy, { asset: b.ccy, total, free: num(b.availBal) });
      }
    }
    const outBalances = [...map.values()].filter((b) => b.total > 0);

    const holdings = [];
    for (const b of outBalances) {
      if (!b.asset || SPOT_QUOTES.has(b.asset) || b.total <= 0) continue;
      let symbol = `${b.asset}/USDT`;
      let price = null;
      for (const quote of ['USDT', 'USDC']) {
        try {
          const ticker = await publicGet(`/api/v5/market/ticker?instId=${encodeURIComponent(`${b.asset}-${quote}`)}`);
          if (ticker[0]?.last) {
            symbol = `${b.asset}/${quote}`;
            price = num(ticker[0].last);
            break;
          }
        } catch { /* 尝试下一个计价币 */ }
      }
      holdings.push({
        symbol,
        asset: b.asset,
        quote: splitPair(symbol).quote,
        quantity: b.total,
        price,
        value: price === null ? null : price * b.total,
      });
    }
    return { balances: outBalances, holdings };
  },

  async fetchLive(creds) {    const [balances, positions] = await Promise.all([
      call('/api/v5/account/balance', creds),
      call('/api/v5/account/positions?instType=SWAP', creds),
    ]);
    const details = balances[0]?.details || [];
    const outBalances = details
      .filter((d) => Math.abs(num(d.eq ?? d.cashBal)) > 0)
      .map((d) => ({ asset: d.ccy, total: num(d.eq ?? d.cashBal), free: num(d.availBal ?? d.availEq) }));

    const outPositions = [];
    for (const row of (positions || []).slice(0, 20)) {
      const signed = num(row.pos);
      if (!signed) continue;
      const side = row.posSide === 'short' || (row.posSide === 'net' && signed < 0) ? 'short' : 'long';
      let fundingRate = null;
      let nextFundingTime = null;
      try {
        const fr = await publicGet(`/api/v5/public/funding-rate?instId=${encodeURIComponent(row.instId)}`);
        fundingRate = fr[0]?.fundingRate !== undefined ? num(fr[0].fundingRate) : null;
        nextFundingTime = fr[0]?.nextFundingTime ? new Date(Number(fr[0].nextFundingTime)).toISOString() : null;
      } catch { /* 费率失败不影响持仓 */ }
      outPositions.push({
        symbol: toSymbol(row.instId, 'USDT'),
        side,
        size: Math.abs(signed),
        entry_price: num(row.avgPx),
        mark_price: num(row.markPx),
        unrealized: num(row.upl),
        funding_rate: fundingRate,
        next_funding_time: nextFundingTime,
      });
    }
    return { balances: outBalances, positions: outPositions };
  },
};
