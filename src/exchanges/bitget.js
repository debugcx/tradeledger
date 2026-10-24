import { hmacBase64 } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, windowsDescending, matchFills, toSymbol, splitPair, quoteFee, isSupportedSpotSymbol, SPOT_QUOTES, marketCache, cacheGet, cachePut } from './common.js';

const candleCache = marketCache('bitget:candles');
const fillCache = marketCache('bitget:fills');

/**
 * Bitget V2 只读接入（USDT 本位合约）。
 *
 * /api/v2/mix/order/fill-history 返回逐笔成交；本地 FIFO 还原 round trip。
 * 手续费在 feeDetail[] 里，按成交分摊。
 */

const BASE = process.env.BITGET_API_BASE || 'https://api.bitget.com';
const WINDOW_MS = 7 * 86400_000;

async function call(path, params, creds, opts = {}) {
  const qs = new URLSearchParams(params || {}).toString();
  const requestPath = qs ? `${path}?${qs}` : path;
  const ts = String(Date.now());
  const sign = hmacBase64(creds.apiSecret, ts + 'GET' + requestPath);
  const res = await requestJson(BASE + requestPath, {
    method: 'GET',
    timeout: opts.timeout,
    retries: opts.retries,
    headers: {
      'ACCESS-KEY': creds.apiKey,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': creds.passphrase || '',
      'Content-Type': 'application/json',
      locale: 'en-US',
    },
  });
  const data = res.json;
  if (!data) throw new Error(`Bitget 返回无法解析（HTTP ${res.status}）`);
  if (data.code !== '00000') throw new Error(`Bitget ${data.code}: ${data.msg || ''}`);
  return data.data || [];
}

function fillFee(row) {
  const details = Array.isArray(row.feeDetail) ? row.feeDetail : [];
  const total = details.reduce((acc, d) => acc + num(d.totalFee ?? d.fee), 0);
  return total === 0 ? 0 : -Math.abs(total);
}

function toFill(row) {
  return {
    id: row.tradeId,
    symbol: toSymbol(row.symbol),
    side: String(row.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
    price: num(row.price),
    qty: num(row.baseVolume ?? row.size ?? row.qty),
    fee: fillFee(row),
    time: Number(row.cTime || 0),
    orderType: row.orderType,
  };
}

export const bitget = {
  id: 'bitget',
  name: 'Bitget',
  maxLookbackDays: 90,
  maxSpotLookbackDays: 90,
  fields: [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'Secret Key' },
    { key: 'passphrase', label: 'Passphrase' },
  ],
  tips: [
    'Bitget → API 管理 → 创建 API',
    '权限只勾「只读」',
    'Passphrase 是创建 API 时单独设置的，不是登录密码；区分大小写',
  ],

  async verify(creds) {
    const rows = await call('/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' }, creds, { timeout: 12000, retries: 0 });
    return { detail: rows?.[0]?.accountEquity || 'OK' };
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
      let idLessThan = '';
      const maxPages = Math.min(60, Math.ceil(cap / 100) + 2);
      for (let page = 0; page < maxPages; page++) {
        const rows = await call('/api/v2/mix/order/fill-history', {
          productType: 'USDT-FUTURES',
          startTime: String(w.from),
          endTime: String(w.to),
          limit: '100',
          ...(idLessThan ? { idLessThan: String(idLessThan) } : {}),
        }, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const row of rows) fills.push(toFill(row));
        if (fills.length >= cap) {
          const oldest = Math.min(...fills.map((f) => f.time));
          nextCursor = String(oldest - 1);
          break outer;
        }
        const lastId = rows[rows.length - 1]?.tradeId;
        if (rows.length < 100 || !lastId) break;
        idLessThan = Number(lastId);
      }
    }

    const trades = matchFills(fills.slice(0, cap), 'bitget');
    return { trades, nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const events = [];
    outer:
    for (const w of windowsDescending(fromMs, toMs, WINDOW_MS)) {
      let idLessThan = '';
      for (let page = 0; page < 40; page++) {
        const payload = await call('/api/v2/mix/account/bill', {
          productType: 'USDT-FUTURES',
          businessType: 'contract_funding',
          startTime: String(w.from),
          endTime: String(w.to),
          limit: '100',
          ...(idLessThan ? { idLessThan: String(idLessThan) } : {}),
        }, creds);
        const rows = Array.isArray(payload) ? payload : (payload?.list || []);
        if (!rows.length) break;
        for (const row of rows) {
          const time = Number(row.cTime || 0);
          events.push({
            external_id: `bitget:fund:${row.billId || `${row.symbol}:${time}`}`,
            symbol: toSymbol(row.symbol),
            time: new Date(time).toISOString(),
            amount: num(row.amount),
          });
        }
        if (events.length >= cap) break outer;
        const lastId = rows[rows.length - 1]?.billId;
        if (rows.length < 100 || !lastId) break;
        idLessThan = Number(lastId);
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
        let idLessThan = '';
        for (let page = 0; page < 20 && out.length < cap; page++) {
          const payload = await call(path, {
            startTime: String(w.from),
            endTime: String(w.to),
            limit: '100',
            ...(idLessThan ? { idLessThan: String(idLessThan) } : {}),
          }, creds);
          const rows = Array.isArray(payload) ? payload : (payload?.list || []);
          if (!rows.length) break;
          for (const row of rows) {
            const time = Number(row.cTime || row.uTime || 0);
            if (!time) continue;
            const id = row.orderId || row.billId || `${row.txId}:${time}`;
            out.push({
              external_id: `bitget:${kind}:${id}`,
              type: kind === 'dep' ? 'deposit' : 'withdraw',
              asset: row.coin || row.asset || '',
              amount: Math.abs(num(row.amount || row.size)),
              fee: Math.abs(num(row.fee)),
              tx_time: new Date(time).toISOString(),
              tx_id: row.txId || row.txID || '',
              chain: row.chain || row.network || '',
              counterparty: row.toAddress || row.address || '',
              note: row.status !== undefined ? `status=${row.status}` : '',
            });
          }
          const lastId = rows[rows.length - 1]?.orderId || rows[rows.length - 1]?.billId;
          if (rows.length < 100 || !lastId) break;
          idLessThan = Number(lastId);
        }
        if (out.length >= cap) break;
      }
    };

    await pull('/api/v2/spot/wallet/deposit-records', 'dep');
    await pull('/api/v2/spot/wallet/withdrawal-records', 'wd');
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  async fetchSpotTrades({ creds, fromMs, toMs, limit, symbols }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const fills = [];
    let pairs = (symbols || []).map((s) => String(s).replace(/[\/_-]/g, '').toUpperCase()).filter(Boolean);
    if (!pairs.length) {
      try {
        const assets = await call('/api/v2/spot/account/assets', {}, creds);
        for (const a of assets || []) {
          const total = num(a.available) + num(a.frozen);
          if (total <= 0 || SPOT_QUOTES.has(a.coin)) continue;
          pairs.push(`${a.coin}USDT`);
        }
      } catch { /* 拿不到余额就不猜交易对 */ }
    }

    for (const pair of [...new Set(pairs)]) {
      if (fills.length >= cap) break;
      for (const w of windowsDescending(fromMs, toMs, 30 * 86400_000)) {
        let idLessThan = '';
        for (let page = 0; page < 20 && fills.length < cap; page++) {
          try {
            const payload = await call('/api/v2/spot/trade/fills', {
              symbol: pair,
              startTime: String(w.from),
              endTime: String(w.to),
              limit: '100',
              ...(idLessThan ? { idLessThan: String(idLessThan) } : {}),
            }, creds);
          const rows = Array.isArray(payload) ? payload : (payload?.list || []);
          if (!rows.length) break;
          for (const row of rows) {
            const symbol = toSymbol(pair);
            if (!isSupportedSpotSymbol(symbol)) continue;
            const { base, quote } = splitPair(symbol);
            const price = num(row.price);
            const details = Array.isArray(row.feeDetail) ? row.feeDetail : [];
            const feeCost = details.reduce((acc, d) => acc + quoteFee(d.totalFee ?? d.fee, d.feeCoin, base, quote, price), 0);
            fills.push({
              id: row.tradeId,
              symbol,
              side: String(row.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
              price,
              qty: num(row.size ?? row.baseVolume),
              fee: -feeCost,
              time: Number(row.cTime || 0),
              orderType: row.orderType,
            });
          }
          const lastId = rows[rows.length - 1]?.tradeId;
          if (rows.length < 100 || !lastId) break;
          idLessThan = Number(lastId);
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
    const assets = await call('/api/v2/spot/account/assets', {}, creds);
    const balances = [];
    const holdings = [];
    for (const a of assets || []) {
      const total = num(a.available) + num(a.frozen);
      if (total <= 0) continue;
      balances.push({ asset: a.coin, total, free: num(a.available) });
      if (SPOT_QUOTES.has(a.coin)) continue;
      let symbol = `${a.coin}/USDT`;
      let price = null;
      for (const quote of ['USDT', 'USDC']) {
        try {
          const res = await requestJson(`${BASE}/api/v2/spot/market/tickers?symbol=${encodeURIComponent(`${a.coin}${quote}`)}`);
          const data = res.json?.data;
          const ticker = Array.isArray(data) ? data[0] : data;
          const last = ticker?.lastPr ?? ticker?.close;
          if (last) {
            symbol = `${a.coin}/${quote}`;
            price = num(last);
            break;
          }
        } catch { /* 尝试下一个计价币 */ }
      }
      holdings.push({
        symbol,
        asset: a.coin,
        quote: splitPair(symbol).quote,
        quantity: total,
        price,
        value: price === null ? null : price * total,
      });
    }
    return { balances, holdings };
  },

  async fetchLive(creds) {
    const [accounts, positions] = await Promise.all([
      call('/api/v2/mix/account/accounts', { productType: 'USDT-FUTURES' }, creds),
      call('/api/v2/mix/position/all-position', { productType: 'USDT-FUTURES', marginCoin: 'USDT' }, creds),
    ]);

    const balances = [];
    for (const a of accounts || []) {
      const total = num(a.accountEquity);
      if (Math.abs(total) <= 0) continue;
      balances.push({ asset: a.marginCoin || 'USDT', total, free: num(a.available) });
    }

    const outPositions = [];
    const rates = new Map();
    for (const p of positions || []) {
      const size = Math.abs(num(p.total));
      if (!size) continue;
      if (!rates.has(p.symbol)) {
        try {
          const res = await requestJson(`${BASE}/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=${encodeURIComponent(p.symbol)}`);
          const data = res.json?.data;
          rates.set(p.symbol, Array.isArray(data) ? data[0] : data);
        } catch {
          rates.set(p.symbol, null);
        }
      }
      const rate = rates.get(p.symbol);
      outPositions.push({
        symbol: toSymbol(p.symbol),
        side: String(p.holdSide).toLowerCase() === 'short' ? 'short' : 'long',
        size,
        entry_price: num(p.openPriceAvg),
        mark_price: num(p.markPrice),
        unrealized: num(p.unrealizedPL),
        funding_rate: rate?.fundingRate !== undefined ? num(rate.fundingRate) : null,
        next_funding_time: rate?.nextFundingTime ? new Date(Number(rate.nextFundingTime)).toISOString() : null,
      });
    }
    return { balances, positions: outPositions };
  },

  // 行情 K 线（公共接口）。合约/现货的粒度字符串不同；行 = [时间, 开, 高, 低, 收, ...]。
  async fetchCandles({ symbol, market = 'futures', fromMs, toMs }) {
    const instId = String(symbol || '').replace('/', '').toUpperCase();
    if (!instId) return { bar: '1H', candles: [], truncated: false };
    const bars = market === 'spot'
      ? [['1min', 60_000], ['5min', 300_000], ['15min', 900_000], ['30min', 1_800_000],
        ['1h', 3_600_000], ['4h', 14_400_000], ['6h', 21_600_000], ['12h', 43_200_000], ['1day', 86_400_000]]
      : [['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
        ['1H', 3_600_000], ['4H', 14_400_000], ['6H', 21_600_000], ['12H', 43_200_000], ['1D', 86_400_000]];
    const dur = Math.max(0, Number(toMs) - Number(fromMs));
    let bar = bars[bars.length - 1][0], barMs = bars[bars.length - 1][1];
    for (const [name, ms] of bars) {
      if (dur / ms <= 90) { bar = name; barMs = ms; break; }
    }
    const cacheKey = `zc|${instId}|${market}|${bar}|${Math.floor(fromMs / barMs)}|${Math.floor(toMs / barMs)}`;
    const hit = cacheGet(candleCache, cacheKey);
    if (hit) return hit;

    const path = market === 'spot' ? '/api/v2/spot/market/candles' : '/api/v2/mix/market/candles';
    const params = {
      symbol: instId, granularity: bar, limit: '1000',
      startTime: String(Math.max(0, Number(fromMs))), endTime: String(Number(toMs)),
    };
    if (market !== 'spot') params.productType = 'USDT-FUTURES';
    const res = await requestJson(`${BASE}${path}?${new URLSearchParams(params)}`, { method: 'GET' });
    if (!Array.isArray(res.json?.data)) throw new Error(`Bitget K 线返回异常（HTTP ${res.status}）`);
    const out = res.json.data
      .map((r) => ({ t: Number(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) }))
      .filter((k) => k.t >= Number(fromMs) && k.t <= Number(toMs))
      .sort((a, b) => a.t - b.t);
    const result = { bar, candles: out.slice(0, 300), truncated: out.length >= 300 };
    return cachePut(candleCache, cacheKey, result);
  },

  // 某个回合的逐笔成交（需签名）
  async fetchEpisodeFills({ creds, symbol, market = 'futures', fromMs, toMs, limit }) {
    const instId = String(symbol || '').replace('/', '').toUpperCase();
    if (!instId) return { fills: [] };
    const cap = Math.max(50, Number(limit) || 300);
    const cacheKey = `zf|${instId}|${market}|${fromMs}|${toMs}`;
    const hit = cacheGet(fillCache, cacheKey);
    if (hit) return hit;

    const out = [];
    if (market === 'spot') {
      for (let page = 1; page <= 3 && out.length < cap; page++) {
        const rows = await call('/api/v2/spot/trade/fills', {
          symbol: instId, startTime: String(fromMs), endTime: String(toMs),
          limit: '100', page: String(page),
        }, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          out.push({
            t: Number(r.ts ?? r.cTime ?? 0),
            side: String(r.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
            price: num(r.price), qty: num(r.size ?? r.baseVolume),
            fee: fillFee(r), feeCcy: r.feeCoin || '', billId: r.tradeId || '',
          });
        }
        if (rows.length < 100) break;
      }
    } else {
      for (let page = 0; page < 3 && out.length < cap; page++) {
        const rows = await call('/api/v2/mix/trade/fills', {
          symbol: instId, productType: 'USDT-FUTURES',
          startTime: String(fromMs), endTime: String(toMs), limit: '100',
        }, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          out.push({
            t: Number(r.fillTime ?? r.ts ?? r.cTime ?? 0),
            side: String(r.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
            price: num(r.price), qty: num(r.size ?? r.baseVolume),
            fee: fillFee(r), feeCcy: r.feeCoin || 'USDT', billId: r.tradeId || '',
          });
        }
        if (rows.length < 100) break;
      }
    }
    out.sort((a, b) => a.t - b.t);
    const result = { fills: out.slice(0, cap) };
    return cachePut(fillCache, cacheKey, result);
  },
};
