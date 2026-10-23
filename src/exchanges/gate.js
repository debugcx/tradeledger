import { hmacHex512, sha512Hex } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, matchFills, toSymbol, splitPair, quoteFee, SPOT_QUOTES, windowsDescending } from './common.js';

/**
 * Gate.io API v4 永续合约只读接入。
 *
 * 用 /api/v4/futures/usdt/my_trades 拉逐笔成交，本地 FIFO 还原 round trip。
 * 签名：HMAC-SHA512(Method\nURL\nQuery\nSHA512(body)\nTimestamp)，输出十六进制。
 */

const BASE = process.env.GATE_API_BASE || 'https://api.gateio.ws';
const EMPTY_SHA512 = sha512Hex('');

function buildQuery(params) {
  return Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

async function call(path, params, creds, opts = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const query = buildQuery(params);
  const signText = ['GET', path, query, EMPTY_SHA512, ts].join('\n');
  const res = await requestJson(`${BASE}${path}${query ? `?${query}` : ''}`, {
    method: 'GET',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: {
      KEY: creds.apiKey,
      Timestamp: ts,
      SIGN: hmacHex512(creds.apiSecret, signText),
    },
  });
  const data = res.json;
  if (!data) throw new Error(`Gate.io 返回无法解析（HTTP ${res.status}）`);
  if (Array.isArray(data) && data[0]?.label) throw new Error(`Gate.io ${data[0].label}: ${data[0].message || ''}`);
  if (!Array.isArray(data) && data.label) throw new Error(`Gate.io ${data.label}: ${data.message || ''}`);
  return data;
}

function toFill(row) {
  const size = num(row.size);
  return {
    id: row.id,
    symbol: toSymbol(row.contract),
    side: size > 0 ? 'buy' : 'sell',
    price: num(row.price),
    qty: Math.abs(size),
    fee: num(row.fee),
    time: Number(row.create_time || 0) * 1000,
    orderType: 'other',
  };
}

export const gate = {
  id: 'gate',
  name: 'Gate.io',
  maxLookbackDays: 180,
  maxSpotLookbackDays: 180,
  fields: [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'API Secret' },
  ],
  tips: [
    'Gate.io → API → APIv4，新建 Key',
    '权限只勾「只读」',
    '建议把服务器出口 IP 加入白名单',
  ],

  async verify(creds) {
    const account = await call('/api/v4/futures/usdt/accounts', {}, creds, { timeout: 12000, retries: 0 });
    return { detail: account?.total || 'OK' };
  },

  async fetchTrades({ creds, fromMs, toMs, cursor, limit }) {
    const cap = Math.max(100, Number(limit) || 1000);
    const pageSize = 1000;
    const fills = [];
    let offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    let nextCursor = null;

    for (let page = 0; page < 20; page++) {
      const rows = await call('/api/v4/futures/usdt/my_trades', {
        from: String(Math.floor(fromMs / 1000)),
        to: String(Math.ceil(toMs / 1000)),
        limit: String(pageSize),
        offset: String(offset),
      }, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) fills.push(toFill(row));
      offset += rows.length;
      if (fills.length >= cap) {
        nextCursor = String(offset);
        break;
      }
      if (rows.length < pageSize) break;
    }

    const trades = matchFills(fills.slice(0, cap), 'gate');
    return { trades, nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, cursor, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const pageSize = 1000;
    const events = [];
    let offset = cursor ? Math.max(0, Number(cursor) || 0) : 0;

    for (let page = 0; page < 20; page++) {
      const rows = await call('/api/v4/futures/usdt/account_book', {
        type: 'fund',
        from: String(Math.floor(fromMs / 1000)),
        to: String(Math.ceil(toMs / 1000)),
        limit: String(pageSize),
        offset: String(offset),
      }, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        const time = Number(row.time || 0) * 1000;
        const amount = num(row.change);
        events.push({
          external_id: `gate:fund:${row.time}:${row.text}:${row.change}:${row.balance}`,
          symbol: toSymbol(row.text),
          time: new Date(time).toISOString(),
          amount,
        });
      }
      offset += rows.length;
      if (events.length >= cap || rows.length < pageSize) break;
    }
    return { events: events.slice(0, cap), nextCursor: null };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    const windows = windowsDescending(fromMs, toMs, 30 * 86400_000).slice(0, 30);

    const pull = async (path, kind) => {
      for (const w of windows) {
        for (let offset = 0; offset < 500 && out.length < cap; offset += 100) {
          const rows = await call(path, {
            from: String(Math.floor(w.from / 1000)),
            to: String(Math.ceil(w.to / 1000)),
            limit: '100',
            offset: String(offset),
          }, creds);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            const time = Number(row.timestamp || 0) * 1000;
            if (!time) continue;
            out.push({
              external_id: `gate:${kind}:${row.id || row.withdraw_id || `${row.txid}:${row.timestamp}`}`,
              type: kind === 'dep' ? 'deposit' : 'withdraw',
              asset: row.currency || '',
              amount: Math.abs(num(row.amount)),
              fee: Math.abs(num(row.fee)),
              tx_time: new Date(time).toISOString(),
              tx_id: row.txid || '',
              chain: row.chain || '',
              counterparty: row.address || '',
              note: row.status !== undefined ? `status=${row.status}` : '',
            });
          }
          if (rows.length < 100) break;
        }
        if (out.length >= cap) break;
      }
    };

    await pull('/api/v4/wallet/deposits', 'dep');
    await pull('/api/v4/wallet/withdrawals', 'wd');
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit, symbols }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const fills = [];
    let pairs = (symbols || []).map((s) => String(s).replace(/[\/-]/g, '_').toUpperCase()).filter(Boolean);
    if (!pairs.length) {
      try {
        const accounts = await call('/api/v4/spot/accounts', {}, creds);
        for (const a of accounts || []) {
          const total = num(a.available) + num(a.locked);
          if (total <= 0 || SPOT_QUOTES.has(a.currency)) continue;
          pairs.push(`${a.currency}_USDT`);
        }
      } catch { /* 拿不到余额就不猜交易对 */ }
    }

    for (const pair of [...new Set(pairs)]) {
      if (fills.length >= cap) break;
      for (const w of windowsDescending(fromMs, toMs, 30 * 86400_000)) {
        for (let offset = 0; offset < 5000 && fills.length < cap; offset += 1000) {
          try {
            const rows = await call('/api/v4/spot/my_trades', {
              currency_pair: pair,
              from: String(Math.floor(w.from / 1000)),
              to: String(Math.ceil(w.to / 1000)),
              limit: '1000',
              offset: String(offset),
            }, creds);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            const symbol = toSymbol(row.currency_pair);
            const { base, quote } = splitPair(symbol);
            const price = num(row.price);
            const fee = quoteFee(row.fee, row.fee_currency, base, quote, price);
            fills.push({
              id: row.id,
              symbol,
              side: String(row.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
              price,
              qty: num(row.amount),
              fee: -fee,
              time: Number(row.create_time || 0) * 1000,
              orderType: 'other',
            });
          }
          if (rows.length < 1000) break;
        } catch {
          break;
        }
        }
        if (fills.length >= cap) break;
      }
    }
    return { fills: fills.slice(0, cap), nextCursor: null };
  },

  async fetchSpotLive(creds) {
    const accounts = await call('/api/v4/spot/accounts', {}, creds);
    const balances = [];
    const holdings = [];
    for (const a of accounts || []) {
      const total = num(a.available) + num(a.locked);
      if (total <= 0) continue;
      balances.push({ asset: a.currency, total, free: num(a.available) });
      if (SPOT_QUOTES.has(a.currency)) continue;
      let symbol = `${a.currency}/USDT`;
      let price = null;
      for (const quote of ['USDT', 'USDC']) {
        try {
          const res = await requestJson(`${BASE}/api/v4/spot/tickers?currency_pair=${encodeURIComponent(`${a.currency}_${quote}`)}`);
          const ticker = Array.isArray(res.json) ? res.json[0] : res.json;
          if (ticker?.last) {
            symbol = `${a.currency}/${quote}`;
            price = num(ticker.last);
            break;
          }
        } catch { /* 尝试下一个计价币 */ }
      }
      holdings.push({
        symbol,
        asset: a.currency,
        quote: splitPair(symbol).quote,
        quantity: total,
        price,
        value: price === null ? null : price * total,
      });
    }
    return { balances, holdings };
  },

  async fetchLive(creds) {
    const [account, positions] = await Promise.all([
      call('/api/v4/futures/usdt/accounts', {}, creds),
      call('/api/v4/futures/usdt/positions', {}, creds),
    ]);

    const balances = [];
    const total = num(account?.total);
    if (Math.abs(total) > 0) {
      balances.push({ asset: account.currency || 'USDT', total, free: num(account.available) });
    }

    const outPositions = [];
    const rates = new Map();
    for (const p of positions || []) {
      const size = num(p.size);
      if (!size) continue;
      if (!rates.has(p.contract)) {
        try {
          const res = await requestJson(`${BASE}/api/v4/futures/usdt/funding_rate?contract=${encodeURIComponent(p.contract)}`);
          rates.set(p.contract, res.json || null);
        } catch {
          rates.set(p.contract, null);
        }
      }
      const rate = rates.get(p.contract);
      outPositions.push({
        symbol: toSymbol(p.contract),
        side: size > 0 ? 'long' : 'short',
        size: Math.abs(size),
        entry_price: num(p.entry_price),
        mark_price: num(p.mark_price),
        unrealized: num(p.unrealised_pnl),
        funding_rate: rate?.r !== undefined ? num(rate.r) : null,
        next_funding_time: rate?.t ? new Date(Number(rate.t) * 1000).toISOString() : null,
      });
    }
    return { balances, positions: outPositions };
  },
};
