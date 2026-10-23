import { hmacHex } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, windowsDescending, matchFills, toSymbol, splitPair, quoteFee, isSupportedSpotSymbol, SPOT_QUOTES } from './common.js';

/**
 * Bybit V5 只读接入。
 *
 * 用 /v5/execution/list 拉逐笔成交，本地 FIFO 还原 round trip。
 * 该接口单次最多 100 条，startTime/endTime 跨度不能超过 7 天，用 cursor 翻页。
 */

const BASE = process.env.BYBIT_API_BASE || 'https://api.bybit.com';
const WINDOW_MS = 7 * 86400_000;
const RECV_WINDOW = '5000';

async function call(path, params, creds, opts = {}) {
  const qs = new URLSearchParams(params || {}).toString();
  const ts = String(Date.now());
  const sign = hmacHex(creds.apiSecret, ts + creds.apiKey + RECV_WINDOW + qs);
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  const res = await requestJson(url, {
    method: 'GET',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
  });
  const data = res.json;
  if (!data) throw new Error(`Bybit 返回无法解析（HTTP ${res.status}）`);
  if (data.retCode !== 0) throw new Error(`Bybit ${data.retCode}: ${data.retMsg || ''}`);
  return data.result || {};
}

function toFill(row) {
  return {
    id: row.execId,
    symbol: toSymbol(row.symbol),
    side: String(row.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
    price: num(row.execPrice),
    qty: num(row.execQty),
    fee: num(row.execFee),
    time: Number(row.execTime || 0),
    orderType: row.orderType,
  };
}

export const bybit = {
  id: 'bybit',
  name: 'Bybit',
  maxLookbackDays: 730,
  maxSpotLookbackDays: 730,
  fields: [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'API Secret' },
  ],
  tips: [
    'Bybit → 账户 → API → 创建新 Key',
    '权限只勾「读取」',
    '建议绑定服务器出口 IP',
  ],

  async verify(creds) {
    const result = await call('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, creds, { timeout: 12000, retries: 0 });
    return { detail: result.list?.[0]?.totalEquity || 'OK' };
  },

  async fetchTrades({ creds, fromMs, toMs, cursor, limit, windowBudget }) {
    const cap = Math.max(100, Number(limit) || 1000);
    const maxWindows = Math.max(1, Number(windowBudget) || 8);
    const endBound = cursor ? Math.min(toMs, Number(cursor)) : toMs;
    const windows = windowsDescending(fromMs, endBound, WINDOW_MS);
    const fills = [];
    let nextCursor = null;
    let used = 0;

    outer:
    for (const w of windows) {
      if (used >= maxWindows) { nextCursor = String(w.to); break; }
      used++;
      let pageCursor = '';
      const maxPages = Math.min(60, Math.ceil(cap / 100) + 2);
      for (let page = 0; page < maxPages; page++) {
        const result = await call('/v5/execution/list', {
          category: 'linear',
          startTime: String(w.from),
          endTime: String(w.to),
          limit: '100',
          ...(pageCursor ? { cursor: pageCursor } : {}),
        }, creds);
        const rows = result.list || [];
        for (const row of rows) fills.push(toFill(row));
        if (fills.length >= cap) {
          const oldest = Math.min(...fills.map((f) => f.time));
          nextCursor = String(oldest - 1);
          break outer;
        }
        pageCursor = result.nextPageCursor || '';
        if (!pageCursor || !rows.length) break;
      }
    }

    const trades = matchFills(fills.slice(0, cap), 'bybit');
    return { trades, nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const events = [];
    outer:
    for (const w of windowsDescending(fromMs, toMs, WINDOW_MS)) {
      let cursor = '';
      for (let page = 0; page < 40; page++) {
        const result = await call('/v5/account/transaction-log', {
          accountType: 'UNIFIED',
          category: 'linear',
          type: 'FUNDING',
          startTime: String(w.from),
          endTime: String(w.to),
          limit: '50',
          ...(cursor ? { cursor } : {}),
        }, creds);
        const rows = result.list || [];
        for (const row of rows) {
          const time = Number(row.transactionTime || 0);
          const amount = num(row.funding ?? row.cashFlow ?? row.change);
          events.push({
            external_id: `bybit:fund:${row.id || `${row.symbol}:${time}`}`,
            symbol: toSymbol(row.symbol),
            time: new Date(time).toISOString(),
            amount,
          });
        }
        if (events.length >= cap) break outer;
        cursor = result.nextPageCursor || '';
        if (!cursor || !rows.length) break;
      }
    }
    return { events: events.slice(0, cap), nextCursor: null };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    const windows = windowsDescending(fromMs, toMs, 30 * 86400_000).slice(0, 30);

    const pull = async (path, kind) => {
      for (const w of windows) {
        let cursor = '';
        for (let page = 0; page < 20 && out.length < cap; page++) {
          const result = await call(path, {
            startTime: String(w.from),
            endTime: String(w.to),
            limit: '50',
            ...(cursor ? { cursor } : {}),
          }, creds);
          const rows = result.rows || result.list || [];
          for (const row of rows) {
            const time = Number(row.updatedTime || row.createdTime || row.createTime || 0);
            if (!time) continue;
            const id = kind === 'dep' ? row.id : row.withdrawId;
            out.push({
              external_id: `bybit:${kind}:${id || `${row.txID}:${time}`}`,
              type: kind === 'dep' ? 'deposit' : 'withdraw',
              asset: row.coin || '',
              amount: Math.abs(num(row.amount)),
              fee: Math.abs(num(row.fee)),
              tx_time: new Date(time).toISOString(),
              tx_id: row.txID || '',
              chain: row.chain || '',
              counterparty: row.toAddress || '',
              note: row.status !== undefined ? `status=${row.status}` : '',
            });
          }
          cursor = result.nextPageCursor || '';
          if (!cursor || !rows.length) break;
        }
        if (out.length >= cap) break;
      }
    };

    await pull('/v5/asset/deposit/query-record', 'dep');
    await pull('/v5/asset/withdraw/query-record', 'wd');
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const fills = [];
    for (const w of windowsDescending(fromMs, toMs, 7 * 86400_000)) {
      let cursor = '';
      for (let page = 0; page < 10 && fills.length < cap; page++) {
        const result = await call('/v5/execution/list', {
          category: 'spot',
          startTime: String(w.from),
          endTime: String(w.to),
          limit: '100',
          ...(cursor ? { cursor } : {}),
        }, creds);
        const rows = result.list || [];
        for (const row of rows) {
          const symbol = toSymbol(row.symbol);
          if (!isSupportedSpotSymbol(symbol)) continue;
          const { base, quote } = splitPair(symbol);
          const price = num(row.execPrice);
          const fee = quoteFee(row.execFee, row.feeCurrency || quote, base, quote, price);
          fills.push({
            id: row.execId,
            symbol,
            side: String(row.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
            price,
            qty: num(row.execQty),
            fee: -fee,
            time: Number(row.execTime || 0),
            orderType: row.orderType,
          });
        }
        cursor = result.nextPageCursor || '';
        if (!cursor || !rows.length) break;
      }
      if (fills.length >= cap) break;
    }
    return { fills: fills.slice(0, cap), nextCursor: null };
  },

  async fetchSpotLive(creds) {
    const wallet = await call('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, creds);
    const balances = [];
    const holdings = [];
    for (const account of wallet.list || []) {
      for (const coin of account.coin || []) {
        const total = num(coin.equity ?? coin.walletBalance);
        if (total <= 0) continue;
        balances.push({ asset: coin.coin, total, free: num(coin.availableToWithdraw ?? coin.walletBalance) });
        if (SPOT_QUOTES.has(coin.coin)) continue;
        let symbol = `${coin.coin}/USDT`;
        let price = null;
        for (const quote of ['USDT', 'USDC']) {
          try {
            const res = await requestJson(`${BASE}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(`${coin.coin}${quote}`)}`);
            const ticker = res.json?.result?.list?.[0];
            if (ticker?.lastPrice) {
              symbol = `${coin.coin}/${quote}`;
              price = num(ticker.lastPrice);
              break;
            }
          } catch { /* 尝试下一个计价币 */ }
        }
        holdings.push({
          symbol,
          asset: coin.coin,
          quote: splitPair(symbol).quote,
          quantity: total,
          price,
          value: price === null ? null : price * total,
        });
      }
    }
    return { balances, holdings };
  },

  async fetchLive(creds) {
    const [wallet, pos] = await Promise.all([
      call('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, creds),
      call('/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: '200' }, creds),
    ]);

    const balances = [];
    for (const account of wallet.list || []) {
      for (const coin of account.coin || []) {
        const total = num(coin.equity ?? coin.walletBalance);
        if (Math.abs(total) <= 0) continue;
        balances.push({
          asset: coin.coin,
          total,
          free: num(coin.availableToWithdraw ?? coin.walletBalance),
        });
      }
    }

    const positions = [];
    const rates = new Map();
    for (const p of pos.list || []) {
      const size = Math.abs(num(p.size));
      if (!size) continue;
      if (!rates.has(p.symbol)) {
        try {
          const res = await requestJson(`${BASE}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(p.symbol)}`);
          rates.set(p.symbol, res.json?.result?.list?.[0] || null);
        } catch {
          rates.set(p.symbol, null);
        }
      }
      const ticker = rates.get(p.symbol);
      positions.push({
        symbol: toSymbol(p.symbol),
        side: String(p.side).toLowerCase() === 'sell' ? 'short' : 'long',
        size,
        entry_price: num(p.avgPrice),
        mark_price: num(p.markPrice),
        unrealized: num(p.unrealisedPnl),
        funding_rate: ticker?.fundingRate !== undefined ? num(ticker.fundingRate) : null,
        next_funding_time: ticker?.nextFundingTime ? new Date(Number(ticker.nextFundingTime)).toISOString() : null,
      });
    }
    return { balances, positions };
  },
};
