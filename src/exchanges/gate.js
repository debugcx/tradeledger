import { hmacHex512, sha512Hex } from '../crypto.js';
import { requestJson } from '../http-client.js';
import { num, matchFills, matchEpisodes, toSymbol, splitPair, quoteFee, SPOT_QUOTES, windowsDescending, marketCache, cacheGet, cachePut } from './common.js';

const ledgerCache = marketCache('gate:monthly-ledger');

/**
 * Gate.io API v4 永续合约只读接入。
 *
 * 用 /api/v4/futures/usdt/my_trades 拉逐笔成交，按净头寸 0→0 还原完整回合
 * （开仓/加仓/减仓/清零归属同一条记录，与 OKX 仓位历史同口径）。
 * 注意：Gate 的 size 单位是「张」，必须乘 quanto_multiplier 换算成币。
 * 签名：HMAC-SHA512(Method\nURL\nQuery\nSHA512(body)\nTimestamp)，输出十六进制。
 */

const BASE = process.env.GATE_API_BASE || 'https://api.gateio.ws';
const EMPTY_SHA512 = sha512Hex('');

// 合约面值缓存（name → quanto_multiplier，不可变）与 K 线/成交缓存
const ctValCache = new Map();
const candleCache = new Map();
const fillCache = new Map();

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

function toFill(row, mult = 1) {
  const size = num(row.size);
  return {
    id: row.id,
    symbol: toSymbol(row.contract),
    side: size > 0 ? 'buy' : 'sell',
    price: num(row.price),
    qty: Math.abs(size) * (mult || 1),
    // Gate 的 fee 返回正数（支出金额）；统一归一化成「负数 = 支出」的应用口径
    fee: -Math.abs(num(row.fee)),
    time: Number(row.create_time || 0) * 1000,
    orderType: 'other',
  };
}

/** 合约面值表（公共接口）：每张合约对应的币数量 */
async function loadCtVals(creds) {
  if (ctValCache.size) return ctValCache;
  const rows = await call('/api/v4/futures/usdt/contracts', {}, creds, { timeout: 20_000, retries: 1 });
  if (Array.isArray(rows)) {
    for (const c of rows) ctValCache.set(c.name, num(c.quanto_multiplier) || 1);
  }
  return ctValCache;
}

/** Gate 现货/合约符号：BTC/USDT → BTC_USDT */
function instOf(symbol) {
  const [base, quote = 'USDT'] = String(symbol || '').split('/');
  return base ? `${base}_${quote}` : '';
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
    const ctVals = await loadCtVals(creds).catch(() => ctValCache);

    for (let page = 0; page < 20; page++) {
      const rows = await call('/api/v4/futures/usdt/my_trades', {
        from: String(Math.floor(fromMs / 1000)),
        to: String(Math.ceil(toMs / 1000)),
        limit: String(pageSize),
        offset: String(offset),
      }, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) fills.push(toFill(row, ctVals.get(row.contract) || 1));
      offset += rows.length;
      if (fills.length >= cap) {
        nextCursor = String(offset);
        break;
      }
      if (rows.length < pageSize) break;
    }

    // 净头寸 0→0 一个回合：开仓/加仓/减仓/清零不再拆成多条
    const trades = matchEpisodes(fills.slice(0, cap), 'gate');
    return { trades, nextCursor };
  },

  async fetchFunding({ creds, fromMs, toMs, cursor, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const events = [];
    // 账本接口限制：单次跨度 ≤ 30 天，且 from 不能早于当前 180 天前
    const minAllowed = Number(toMs) - 179 * 86400_000;
    const start = Math.max(Number(fromMs), minAllowed);
    const windows = windowsDescending(start, Number(toMs), 29 * 86400_000).slice(0, 31);

    for (const w of windows) {
      if (events.length >= cap) break;
      for (let offset = 0; offset < 1000 && events.length < cap; offset += 1000) {
        const rows = await call('/api/v4/futures/usdt/account_book', {
          type: 'fund',
          from: String(Math.floor(w.from / 1000)),
          to: String(Math.ceil(w.to / 1000)),
          limit: '1000',
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
        if (rows.length < 1000) break;
      }
    }
    return { events: events.slice(0, cap), nextCursor: null };
  },

  // 已过期成交明细的降级回填：Gate 的 my_trades 只保留最近约 30 天，
  // 更早的回合从账本（type=pnl / fee）按「合约 × 日」聚合重建——
  // 账本里没有价格、数量和方向，这些字段保持 0 并在备注中说明。
  async fetchLedgerTrades({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(20, Number(limit) || 500);
    // 成交明细覆盖的边界：取现有明细里最老一条的时间
    const recent = await call('/api/v4/futures/usdt/my_trades', { limit: '100' }, creds);
    const boundaryMs = (Array.isArray(recent) && recent.length)
      ? Math.min(...recent.map((r) => Number(r.create_time || 0) * 1000))
      : Number(toMs);
    // 账本 from 不能早于 toMs 的 180 天前
    const minAllowed = Number(toMs) - 179 * 86400_000;
    const until = Math.min(Number(toMs), boundaryMs);
    const start = Math.max(Number(fromMs), minAllowed);
    if (!(until > start)) return { trades: [] };

    const windows = windowsDescending(start, until, 29 * 86400_000).slice(0, 31);
    const byDay = new Map(); // 'YYYY-MM-DD|BTC_USDT' -> { day, contract, pnl, fee, last }
    for (const w of windows) {
      for (const type of ['pnl', 'fee']) {
        for (let offset = 0; offset < 500; offset += 100) {
          const rows = await call('/api/v4/futures/usdt/account_book', {
            type,
            from: String(Math.floor(w.from / 1000)),
            to: String(Math.ceil(w.to / 1000)),
            limit: '100',
            offset: String(offset),
          }, creds);
          if (!Array.isArray(rows) || !rows.length) break;
          for (const r of rows) {
            const t = Number(r.time || 0) * 1000;
            const contract = String(r.text || '');
            if (!t || !contract.includes('_')) continue; // 非合约明细行
            const key = `${new Date(t).toISOString().slice(0, 10)}|${contract}`;
            const cur = byDay.get(key) || { day: key.split('|')[0], contract, pnl: 0, fee: 0, last: 0 };
            if (type === 'pnl') {
              cur.pnl += num(r.change);
              cur.last = Math.max(cur.last, t);
            } else {
              cur.fee += num(r.change); // 账本 fee 为负（支出）
            }
            byDay.set(key, cur);
          }
          if (rows.length < 100) break;
        }
      }
    }
    const trades = [...byDay.values()]
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((v) => ({
        external_id: `gate:ledger:${v.day}:${v.contract}`,
        symbol: toSymbol(v.contract),
        side: 'long', // 方向无法从账本得知，统计多空占比时请注意备注
        order_type: 'other',
        size: 0,
        notional: 0,
        entry_price: 0,
        exit_price: 0,
        open_time: new Date(`${v.day}T00:00:00.000Z`).toISOString(),
        close_time: new Date(v.last || Date.parse(`${v.day}T23:59:59.000Z`)).toISOString(),
        pnl: v.pnl + v.fee,
        fee: v.fee,
        funding: 0,
        source: 'api',
        market: 'futures',
        note: '账本回填：成交明细已超出 Gate 保留期，按合约×日聚合；价格/数量/方向不可得',
      }));
    return { trades: trades.slice(0, cap) };
  },

  async fetchTransfers({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    // 充提记录接口限制单次跨度不得超过 30 天；floor/ceil 取整会让整 30 天的窗口
    // 超出 1-2 秒而被拒（INVALID_PARAM_VALUE），用 29 天窗口留出余量
    const windows = windowsDescending(fromMs, toMs, 29 * 86400_000).slice(0, 31);

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

  // 月度账本汇总（对账用）：近 N 个月的已实现盈亏 / 手续费 / 资金费合计，30 分钟缓存。
  // 按月并发（每月内部串行），避免整页串行等待几十个请求。
  async fetchMonthlyLedger({ creds, months = 6 }) {
    const hit = cacheGet(ledgerCache, `ml|${months}`, 30 * 60_000);
    if (hit) return hit;
    const now = new Date();
    const count = Math.min(6, Math.max(1, Number(months) || 6)); // 账本最早只能查 180 天前
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      if (Date.now() - start.getTime() > 175 * 86400_000) break;
      tasks.push((async () => {
        const row = {
          month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
          pnl: 0, fee: 0, fund: 0,
        };
        for (const type of ['pnl', 'fee', 'fund']) {
          for (const w of windowsDescending(start.getTime(), Math.min(end.getTime(), Date.now()), 29 * 86400_000).slice(0, 4)) {
            let offset = 0;
            for (let page = 0; page < 5; page++) {
              const rows = await call('/api/v4/futures/usdt/account_book', {
                type,
                from: String(Math.floor(w.from / 1000)),
                to: String(Math.ceil(w.to / 1000)),
                limit: '100',
                offset: String(offset),
              }, creds);
              if (!Array.isArray(rows) || !rows.length) break;
              row[type] += rows.reduce((acc, r) => acc + num(r.change), 0);
              offset += rows.length;
              if (rows.length < 100) break;
            }
          }
        }
        return row;
      })());
    }
    const out = (await Promise.all(tasks));
    return cachePut(ledgerCache, `ml|${months}`, { months: out });
  },

  // 行情 K 线。Gate 的 K 线接口也挂在鉴权网关后（需 Timestamp/KEY/SIGN 头）。
  // 粒度不含 3m/2h/6h/12h，取最接近的可用档位；行 = [秒级时间戳, 成交量, 收盘, 最高, 最低, 开盘]。
  async fetchCandles({ creds, symbol, market = 'futures', fromMs, toMs }) {
    const instId = instOf(symbol);
    if (!instId) return { bar: '1h', candles: [], truncated: false };
    const bars = [
      ['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
      ['1h', 3_600_000], ['4h', 14_400_000], ['8h', 28_800_000], ['1d', 86_400_000],
    ];
    const dur = Math.max(0, Number(toMs) - Number(fromMs));
    // Gate 限制：查询起点不得早于 now − 10000×周期（如 1m 只能查最近约 7 天）。
    // 周期必须同时满足「≤90 根覆盖全程」和「年龄在可查范围内」，沿阶梯取第一个都满足的。
    const age = Date.now() - Number(fromMs);
    let bar = '1d', barMs = 86_400_000;
    for (const [name, ms] of bars) {
      if (dur / ms <= 90 && ms * 10000 >= age) { bar = name; barMs = ms; break; }
    }
    const cacheKey = `gc|${instId}|${bar}|${Math.floor(fromMs / barMs)}|${Math.floor(toMs / barMs)}`;
    const hit = candleCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;

    const path = market === 'spot' ? '/api/v4/spot/candlesticks' : '/api/v4/futures/usdt/candlesticks';
    const key = market === 'spot' ? 'currency_pair' : 'contract';
    const out = [];
    let to = Number(toMs);
    // Gate candlesticks 实测返回对象数组 {t,v,c,l,h,o,sum}（文档示例是数组，两种都兼容）
    const rowOf = (r) => Array.isArray(r)
      ? { t: Number(r[0]) * 1000, o: num(r[5]), h: num(r[3]), l: num(r[4]), c: num(r[2]) }
      : { t: Number(r.t) * 1000, o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c) };
    for (let page = 0; page < 3 && out.length < 300; page++) {
      const from = Math.max(Number(fromMs), to - 1000 * barMs);
      const rows = await call(path, {
        [key]: instId, interval: bar,
        from: String(Math.floor(from / 1000)), to: String(Math.ceil(to / 1000)),
      }, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const k = rowOf(r);
        if (k.t >= Number(fromMs) && k.t <= Number(toMs)) out.push(k);
      }
      const oldest = Math.min(...rows.map((r) => Number(Array.isArray(r) ? r[0] : r.t))) * 1000;
      if (!Number.isFinite(oldest) || oldest <= Number(fromMs) || rows.length < 1000) break;
      to = oldest;
    }
    out.sort((a, b) => a.t - b.t);
    const result = { bar, candles: out, truncated: out.length >= 300 };
    if (candleCache.size >= 300) candleCache.delete(candleCache.keys().next().value);
    candleCache.set(cacheKey, { ...result, at: Date.now() });
    return result;
  },

  // 某个回合的逐笔成交（需签名）：合约 size 是「张」，按面值换算成币
  async fetchEpisodeFills({ creds, symbol, market = 'futures', fromMs, toMs, limit }) {
    const instId = instOf(symbol);
    if (!instId) return { fills: [] };
    const cap = Math.max(50, Number(limit) || 300);
    const cacheKey = `gf|${instId}|${fromMs}|${toMs}`;
    const hit = fillCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;

    const from = String(Math.floor(fromMs / 1000));
    const to = String(Math.ceil(toMs / 1000));
    const out = [];
    if (market === 'spot') {
      for (let page = 1; page <= 3; page++) {
        const rows = await call('/api/v4/spot/my_trades', {
          currency_pair: instId, from, to, page: String(page), limit: '100',
        }, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          out.push({
            t: Number(r.create_time || 0) * 1000,
            side: String(r.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
            price: num(r.price), qty: num(r.amount),
            fee: -Math.abs(num(r.fee)), feeCcy: r.fee_currency || '', billId: String(r.id || ''),
          });
        }
        if (rows.length < 100) break;
      }
    } else {
      const mult = (await loadCtVals(creds).catch(() => ctValCache)).get(instId) || 1;
      for (let offset = 0; offset < 1000 && out.length < cap; offset += 1000) {
        const rows = await call('/api/v4/futures/usdt/my_trades', {
          contract: instId, from, to, limit: '1000', offset: String(offset),
        }, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          const size = num(r.size);
          out.push({
            t: Number(r.create_time || 0) * 1000,
            side: size > 0 ? 'buy' : 'sell',
            price: num(r.price), qty: Math.abs(size) * mult,
            fee: -Math.abs(num(r.fee)), feeCcy: 'USDT', billId: String(r.id || ''),
          });
        }
        if (rows.length < 1000) break;
      }
    }
    out.sort((a, b) => a.t - b.t);
    const result = { fills: out.slice(0, cap) };
    if (fillCache.size >= 300) fillCache.delete(fillCache.keys().next().value);
    fillCache.set(cacheKey, { ...result, at: Date.now() });
    return result;
  },
};
