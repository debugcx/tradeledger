import { hmacHex } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, windowsDescending, matchFills, toSymbol, splitPair, quoteFee, SPOT_QUOTES, marketCache, cacheGet, cachePut } from './common.js';

const candleCache = marketCache('binance:candles');
const fillCache = marketCache('binance:fills');

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

// 本机时钟与币安服务器的偏差（ms）。币安要求 timestamp 不超过服务器时间 1 秒，
// 本机走快就会报 -1021；用公共接口 /fapi/v1/time 对齐，偏差每 30 分钟刷新一次。
let timeOffsetMs = null;
let timeSyncedAt = 0;

async function syncTimeOffset() {
  const t0 = Date.now();
  const res = await requestJson(`${BASE}/fapi/v1/time`, { method: 'GET', timeout: 10_000, retries: 1 });
  const rtt = Date.now() - t0;
  const server = Number(res.json?.serverTime);
  if (!Number.isFinite(server)) throw new Error('Binance 服务器时间返回异常');
  timeOffsetMs = server - (t0 + rtt / 2);
  timeSyncedAt = Date.now();
  console.error(`[binance] 时钟偏差 ${timeOffsetMs >= 0 ? '+' : ''}${timeOffsetMs}ms，已对齐`);
  return timeOffsetMs;
}

async function call(path, creds, opts = {}) {
  if (timeOffsetMs === null || Date.now() - timeSyncedAt > 30 * 60_000) {
    try { await syncTimeOffset(); } catch { timeOffsetMs = timeOffsetMs ?? 0; timeSyncedAt = Date.now(); }
  }
  const baseUrl = opts.baseUrl || BASE;
  const attempt = async () => {
    const sep = path.includes('?') ? '&' : '?';
    const query = `${path.split('?')[1] ? `${path.split('?')[1]}&` : ''}recvWindow=5000&timestamp=${Date.now() + timeOffsetMs}`;
    const url = `${baseUrl}${path.split('?')[0]}${sep}${query}&signature=${hmacHex(creds.apiSecret, query)}`;
    const res = await requestJson(url, {
      method: 'GET',
      timeout: opts.timeout,
      retries: opts.retries,
      headers: { 'X-MBX-APIKEY': creds.apiKey },
    });
    const data = res.json;
    if (!data) throw new Error(`Binance 返回无法解析（HTTP ${res.status}）`);
    if (data.code && data.code < 0) {
      const err = new Error(`Binance ${data.code}: ${data.msg || ''}`);
      err.code = data.code;
      throw err;
    }
    return data;
  };
  try {
    return await attempt();
  } catch (err) {
    // 时钟偏差导致的 -1021：重新对齐后重试一次
    if (String(err.code) === '-1021') {
      await syncTimeOffset();
      return await attempt();
    }
    // 币安 WAF 对部分数据中心出口 IP 拦截交易历史类接口，返回 HTML 404 错误页
    if (String(err.message).includes('<!DOCTYPE')) {
      throw new Error('Binance 边缘节点拦截了该请求（当前网络出口 IP 被其风控拦截，数据中心 IP 常见）：请更换代理节点后重试，或改用未被拦截的网络出口');
    }
    throw err;
  }
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

  // 行情 K 线（公共接口）。行 = [开盘时间, 开, 高, 低, 收, ...]，升序。
  async fetchCandles({ symbol, market = 'futures', fromMs, toMs }) {
    const instId = String(symbol || '').replace('/', '').toUpperCase();
    if (!instId) return { bar: '1h', candles: [], truncated: false };
    const bars = [
      ['1m', 60_000], ['3m', 180_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
      ['1h', 3_600_000], ['2h', 7_200_000], ['4h', 14_400_000], ['6h', 21_600_000],
      ['12h', 43_200_000], ['1d', 86_400_000],
    ];
    const dur = Math.max(0, Number(toMs) - Number(fromMs));
    let bar = '1d', barMs = 86_400_000;
    for (const [name, ms] of bars) {
      if (dur / ms <= 90) { bar = name; barMs = ms; break; }
    }
    const cacheKey = `bc|${instId}|${market}|${bar}|${Math.floor(fromMs / barMs)}|${Math.floor(toMs / barMs)}`;
    const hit = cacheGet(candleCache, cacheKey);
    if (hit) return hit;

    const base = market === 'spot' ? BASE_SAPI : BASE;
    const path = market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
    const q = new URLSearchParams({
      symbol: instId, interval: bar, limit: '1000',
      startTime: String(Math.max(0, Number(fromMs))), endTime: String(Number(toMs)),
    });
    const res = await requestJson(`${base}${path}?${q}`, { method: 'GET' });
    if (!Array.isArray(res.json)) throw new Error(`Binance K 线返回异常（HTTP ${res.status}）`);
    const out = res.json
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
    const cacheKey = `bf|${instId}|${market}|${fromMs}|${toMs}`;
    const hit = cacheGet(fillCache, cacheKey);
    if (hit) return hit;

    const base = market === 'spot' ? BASE_SAPI : BASE;
    const path = market === 'spot' ? '/api/v3/myTrades' : '/fapi/v1/userTrades';
    const out = [];
    for (let page = 0; page < 3 && out.length < cap; page++) {
      const q = new URLSearchParams({
        symbol: instId, limit: '1000',
        startTime: String(Math.max(0, Number(fromMs))), endTime: String(Number(toMs)),
        ...(page && out.length ? { fromId: String(out[out.length - 1].billId + 1) } : {}),
      });
      const rows = await call(`${path}?${q}`, creds, { baseUrl: base });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const quoteFeeCcy = ['USDT', 'BUSD', 'USDC', 'FDUSD'].includes(String(r.commissionAsset || '').toUpperCase());
        out.push({
          t: Number(r.time || 0),
          side: String(r.side).toUpperCase() === 'BUY' ? 'buy' : 'sell',
          price: num(r.price), qty: num(r.qty),
          fee: quoteFeeCcy ? -Math.abs(num(r.commission)) : 0,
          feeCcy: r.commissionAsset || '', billId: r.id,
        });
      }
      if (rows.length < 1000) break;
    }
    out.sort((a, b) => a.t - b.t);
    const result = { fills: out.slice(0, cap) };
    return cachePut(fillCache, cacheKey, result);
  },
};
