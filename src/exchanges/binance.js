import { hmacHex } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, windowsDescending, matchFills, toSymbol, splitPair, quoteFee, SPOT_QUOTES } from './common.js';

/**
 * Binance USDT-M 合约只读接入。
 *
 * /fapi/v1/userTrades 返回逐笔成交；本地用 FIFO 还原成 round trip。
 * 该接口单次最多返回 1000 笔，且 startTime/endTime 跨度不能超过 7 天，
 * 因此按 7 天窗口往回翻。
 */

const BASE = process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com';
const BASE_SAPI = process.env.BINANCE_SAPI_BASE || 'https://api.binance.com';
const WINDOW_MS = 7 * 86400_000;

async function call(path, creds, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const query = `${path.split('?')[1] ? `${path.split('?')[1]}&` : ''}recvWindow=5000&timestamp=${Date.now()}`;
  const signed = `${query}&signature=${hmacHex(creds.apiSecret, query)}`;
  const base = opts.baseUrl || BASE;
  const res = await requestJson(`${base}${path.split('?')[0]}${sep}${signed}`, {
    method: 'GET',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: { 'X-MBX-APIKEY': creds.apiKey },
  });
  const data = res.json;
  if (!data) throw new Error(`Binance 返回无法解析（HTTP ${res.status}）`);
  if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg || ''}`);
  return data;
}

function toFill(row) {
  const fee = ['USDT', 'BUSD', 'USDC', 'FDUSD'].includes(String(row.commissionAsset || '').toUpperCase())
    ? -Math.abs(num(row.commission))
    : 0;
  return {
    id: row.id,
    symbol: toSymbol(row.symbol),
    side: String(row.side).toUpperCase() === 'BUY' ? 'buy' : 'sell',
    price: num(row.price),
    qty: num(row.qty),
    fee,
    time: Number(row.time || 0),
    orderType: 'other',
  };
}

export const binance = {
  id: 'binance',
  name: 'Binance',
  maxLookbackDays: 3650,
  maxSpotLookbackDays: 3650,
  fields: [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'Secret Key' },
  ],
  tips: [
    'Binance → API 管理 → 创建 API',
    '权限只勾「允许读取」',
    '建议绑定服务器出口 IP；本地可先不限制',
  ],

  async verify(creds) {
    const data = await call('/fapi/v2/account', creds, { timeout: 12000, retries: 0 });
    return { detail: data?.totalWalletBalance || 'OK' };
  },

  async fetchTrades({ creds, fromMs, toMs, cursor, limit, windowBudget }) {
    const cap = Math.max(100, Number(limit) || 1000);
    const maxWindows = Math.max(1, Number(windowBudget) || 8);
    const endBound = cursor ? Math.min(toMs, Number(cursor)) : toMs;
    const windows = windowsDescending(fromMs, endBound, WINDOW_MS);
    const fills = [];
    let nextCursor = null;
    let used = 0;

    for (const w of windows) {
      if (used >= maxWindows) { nextCursor = String(w.to); break; }
      used++;
      const q = new URLSearchParams({
        startTime: String(w.from),
        endTime: String(w.to),
        limit: '1000',
      });
      const rows = await call(`/fapi/v1/userTrades?${q}`, creds);
      if (!Array.isArray(rows) || !rows.length) continue;
      for (const row of rows) fills.push(toFill(row));
      if (fills.length >= cap) {
        const oldest = Math.min(...fills.map((f) => f.time));
        nextCursor = String(oldest - 1);
        break;
      }
      if (rows.length >= 1000) {
        const oldest = Math.min(...rows.map((r) => Number(r.time || 0)));
        nextCursor = String(oldest - 1);
        break;
      }
    }

    const trades = matchFills(fills.slice(0, cap), 'binance');
    return { trades, nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, limit }) {    const cap = Math.max(100, Number(limit) || 2000);
    const events = [];
    for (const w of windowsDescending(fromMs, toMs, WINDOW_MS)) {
      const q = new URLSearchParams({
        incomeType: 'FUNDING_FEE',
        startTime: String(w.from),
        endTime: String(w.to),
        limit: '1000',
      });
      const rows = await call(`/fapi/v1/income?${q}`, creds);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row.incomeType !== 'FUNDING_FEE') continue;
        events.push({
          external_id: `binance:fund:${row.tranId || `${row.symbol}:${row.time}`}`,
          symbol: toSymbol(row.symbol),
          time: new Date(Number(row.time)).toISOString(),
          amount: num(row.income),
        });
      }
      if (events.length >= cap) break;
    }
    return { events: events.slice(0, cap), nextCursor: null };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    // Binance 的充提接口对时间跨度有限制，按 90 天窗口拉，最多回看 20 个窗口
    const windows = windowsDescending(fromMs, toMs, 90 * 86400_000).slice(0, 20);

    const pull = async (path, kind) => {
      for (const w of windows) {
        for (let offset = 0; offset < 500 && out.length < cap; offset += 100) {
          const q = new URLSearchParams({
            startTime: String(w.from), endTime: String(w.to), limit: '100', offset: String(offset),
          });
          const rows = await call(`${path}?${q}`, creds, { baseUrl: BASE_SAPI });
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            const time = Number(row.completeTime || row.insertTime || row.applyTime || 0);
            if (!time) continue;
            const id = row.id || `${row.txId}:${time}`;
            out.push({
              external_id: `binance:${kind}:${id}`,
              type: kind === 'dep' ? 'deposit' : 'withdraw',
              asset: row.coin || '',
              amount: Math.abs(num(row.amount)),
              fee: Math.abs(num(row.transactionFee)),
              tx_time: new Date(time).toISOString(),
              tx_id: row.txId || '',
              chain: row.network || '',
              counterparty: row.address || '',
              note: row.status !== undefined ? `status=${row.status}` : '',
            });
          }
          if (rows.length < 100) break;
        }
        if (out.length >= cap) break;
      }
    };

    await pull('/sapi/v1/capital/deposit/hisrec', 'dep');
    await pull('/sapi/v1/capital/withdraw/history', 'wd');
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit, symbols }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const fills = [];
    let pairs = (symbols || []).map((s) => String(s).replace(/[\/_-]/g, '').toUpperCase()).filter(Boolean);

    // 没有显式配置时，从当前现货余额推导常见 USDT/USDC 交易对
    if (!pairs.length) {
      try {
        const account = await call('/api/v3/account', creds, { baseUrl: BASE_SAPI });
        for (const b of account.balances || []) {
          const total = num(b.free) + num(b.locked);
          if (total <= 0 || SPOT_QUOTES.has(b.asset)) continue;
          pairs.push(`${b.asset}USDT`, `${b.asset}USDC`);
        }
      } catch { /* 拿不到余额就不猜交易对 */ }
    }

    for (const pair of [...new Set(pairs)]) {
      if (fills.length >= cap) break;
      try {
        const q = new URLSearchParams({
          symbol: pair,
          startTime: String(Math.max(0, fromMs)),
          endTime: String(toMs),
          limit: '1000',
        });
        const rows = await call(`/api/v3/myTrades?${q}`, creds, { baseUrl: BASE_SAPI });
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const symbol = toSymbol(row.symbol);
          const { base, quote } = splitPair(symbol);
          const price = num(row.price);
          const fee = quoteFee(row.commission, row.commissionAsset, base, quote, price);
          fills.push({
            id: row.id,
            symbol,
            side: String(row.side).toUpperCase() === 'BUY' ? 'buy' : 'sell',
            price,
            qty: num(row.qty),
            fee: -fee,
            time: Number(row.time || 0),
            orderType: 'other',
          });
        }
      } catch { /* 单个交易对失败不影响其他交易对 */ }
    }
    return { fills: fills.slice(0, cap), nextCursor: null };
  },

  async fetchSpotLive(creds) {
    const account = await call('/api/v3/account', creds, { baseUrl: BASE_SAPI });
    const balances = [];
    const holdings = [];
    for (const b of account.balances || []) {
      const total = num(b.free) + num(b.locked);
      if (total <= 0) continue;
      balances.push({ asset: b.asset, total, free: num(b.free) });
      if (SPOT_QUOTES.has(b.asset)) continue;
      let symbol = `${b.asset}/USDT`;
      let price = null;
      for (const quote of ['USDT', 'USDC']) {
        try {
          const res = await requestJson(`${BASE_SAPI}/api/v3/ticker/price?symbol=${encodeURIComponent(`${b.asset}${quote}`)}`);
          if (res.json?.price) {
            symbol = `${b.asset}/${quote}`;
            price = num(res.json.price);
            break;
          }
        } catch { /* 尝试下一个计价币 */ }
      }
      holdings.push({
        symbol,
        asset: b.asset,
        quote: splitPair(symbol).quote,
        quantity: total,
        price,
        value: price === null ? null : price * total,
      });
    }
    return { balances, holdings };
  },

  async fetchLive(creds) {
    const account = await call('/fapi/v2/account', creds);
    const balances = (account.assets || [])
      .filter((a) => Math.abs(num(a.walletBalance)) > 0)
      .map((a) => ({ asset: a.asset, total: num(a.walletBalance), free: num(a.availableBalance) }));

    const positions = [];
    const rates = new Map();
    for (const p of account.positions || []) {
      const amt = num(p.positionAmt);
      if (!amt) continue;
      let rate = null;
      let next = null;
      if (!rates.has(p.symbol)) {
        try {
          const res = await requestJson(`${BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(p.symbol)}`);
          rates.set(p.symbol, res.json || null);
        } catch {
          rates.set(p.symbol, null);
        }
      }
      const info = rates.get(p.symbol);
      if (info) {
        rate = num(info.lastFundingRate);
        next = info.nextFundingTime ? new Date(Number(info.nextFundingTime)).toISOString() : null;
      }
      positions.push({
        symbol: toSymbol(p.symbol),
        side: amt > 0 ? 'long' : 'short',
        size: Math.abs(amt),
        entry_price: num(p.entryPrice),
        mark_price: num(p.markPrice),
        unrealized: num(p.unRealizedProfit),
        funding_rate: rate,
        next_funding_time: next,
      });
    }
    return { balances, positions };
  },
};
