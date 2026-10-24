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

// K 线缓存：key = instId|bar|起止桶，值 6 小时内复用（历史 K 线不可变）
const candleCache = new Map();
// 逐笔成交缓存 + 合约面值缓存（instId → 每张合约对应的币数量，不可变）
const fillCache = new Map();
const ctValCache = new Map();

function instIdOf(symbol, market) {
  const [base, quote = 'USDT'] = String(symbol || '').split('/');
  if (!base) return '';
  return market === 'spot' ? `${base}-${quote}` : `${base}-${quote}-SWAP`;
}

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
    // OKX 的 posId 会被跨回合复用（同一合约同方向的多个独立持仓共用一个 posId，
    // 用户实测一个 posId 下有多达上百条记录），部分平仓还会原地更新同一行。
    // 因此行身份 = posId + 开仓毫秒；同步侧对已存在行做 upsert 拿到最终状态。
    external_id: row.posId ? `okx:${row.posId}:${openMs}` : `okx:${row.instId}:${openMs}:${closeMs}`,
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
  // positions-history 实测可返回约 2 年数据（文档口径 3 个月偏保守）；
  // posId 跨回合复用 + 行原地更新，短窗口会让历史回合永久缺失，故放宽到 730 天
  maxLookbackDays: 730,
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

  // 策略机器人（网格）已结束回合：合约网格 + 现货网格各拉历史，
  // 每个机器人一条交易记录。盈亏用 totalPnl（网格利润 + 浮动盈亏），
  // 投资额记入名义价值使「收益率」有意义；价格/数量对网格无意义，保持 0。
  async fetchBots({ creds, fromMs, toMs, limit }) {
    const cap = Math.max(20, Number(limit) || 200);
    const out = [];
    const pull = async (algoOrdType, market) => {
      let after = null;
      for (let page = 0; page < 3 && out.length < cap; page++) {
        const q = new URLSearchParams({ algoOrdType, limit: '100' });
        if (after) q.set('after', after);
        const rows = await call(`/api/v5/tradingBot/grid/orders-algo-history?${q}`, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const row of rows) {
          const start = Number(row.cTime || 0);
          const end = Number(row.uTime || 0);
          if (!start || !end || end < Number(fromMs) || end > Number(toMs)) continue;
          const gridProfit = num(row.gridProfit);
          const floatProfit = num(row.floatProfit);
          const total = row.totalPnl !== undefined && row.totalPnl !== null
            ? num(row.totalPnl) : gridProfit + floatProfit;
          out.push({
            external_id: `okx:grid:${row.algoId}`,
            symbol: toSymbol(row.instId, 'USDT'),
            side: String(row.direction || '').toLowerCase() === 'short' ? 'short' : 'long',
            order_type: 'other',
            size: 0,
            notional: num(row.investment),
            entry_price: 0,
            exit_price: 0,
            open_time: msToIso(start),
            close_time: msToIso(end),
            pnl: total,
            fee: num(row.fee),
            funding: num(row.fundingFee),
            source: 'api',
            market,
            note: `策略机器人·${market === 'spot' ? '现货网格' : '合约网格'}`
              + ` ${num(row.gridNum)} 格 · 套利 ${num(row.arbitrageNum)} 次`
              + ` · 网格利润 ${gridProfit} · 浮动盈亏 ${floatProfit}`,
            tags: ['策略机器人'],
          });
        }
        const last = rows[rows.length - 1]?.algoId;
        if (!last || last === after || rows.length < 100) break;
        after = last;
      }
    };
    try { await pull('contract_grid', 'futures'); } catch { /* 无合约网格数据或权限 */ }
    try { await pull('grid', 'spot'); } catch { /* 无现货网格数据或权限 */ }
    return { trades: out.slice(0, cap) };
  },
  // 资金账户账单中的返佣类账单（邀请返佣、返佣卡、Broker 奖励等）。
  // type 代码来自 /api/v5/asset/bills 的账单类型表；只在客户端按白名单过滤，
  // 避免依赖服务端 type 过滤参数的可用性。
  async fetchRebates({ creds, fromMs, toMs, limit }) {
    const labels = {
      68: '手续费返佣（返佣卡）',
      150: '邀请返佣',
      151: '推荐奖励',
      152: 'Broker 奖励',
      172: '子合伙人返佣',
      173: '邀请返佣（交易手续费）',
      223: '带单分润（合约）',
      226: '带单分润（现货）',
      233: 'Broker 返佣补偿',
      263: '策略机器人分红',
      265: '信号收益',
      299: '邀请推荐返佣',
      300: '手续费折扣返还',
      354: '跟单/网格收益',
    };
    const cap = Math.max(100, Number(limit) || 2000);
    const out = [];
    const seen = new Set();
    const pull = async (path) => {
      let after = String(Number(toMs) + 1);
      for (let page = 0; page < 10 && out.length < cap; page++) {
        const q = new URLSearchParams({ limit: '100', after });
        const rows = await call(`${path}?${q}`, creds);
        if (!Array.isArray(rows) || !rows.length) break;
        for (const row of rows) {
          const time = Number(row.ts || 0);
          const amt = num(row.balChg ?? row.amt);
          if (!time || !labels[Number(row.type)] || !(amt > 0)) continue;
          const id = row.billId || `${row.type}:${time}:${amt}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({
            external_id: `okx:rebate:${id}`,
            type: 'rebate',
            asset: row.ccy || '',
            amount: amt,
            fee: 0,
            tx_time: new Date(time).toISOString(),
            tx_id: '',
            chain: '',
            counterparty: '',
            note: row.notes || labels[Number(row.type)],
          });
        }
        const oldest = Math.min(...rows.map((r) => Number(r.ts || 0)).filter(Boolean));
        if (!oldest || oldest <= fromMs) break;
        after = String(oldest);
      }
    };
    await pull('/api/v5/asset/bills');
    // asset/bills 只覆盖近一个月；窗口更早时补充拉取 bills-history（2021 年起）
    if (Number(fromMs) < Date.now() - 31 * 24 * 3600_000) {
      try { await pull('/api/v5/asset/bills-history'); } catch { /* 历史账单接口不可用时保留近月数据 */ }
    }
    return { transfers: out.slice(0, cap), nextCursor: null };
  },

  // 行情 K 线（公共接口，无需鉴权）。用于交易详情页的「开仓 → 平仓」浮盈亏曲线。
  // bar 按持仓时长自适应，目标一页（100 根）内覆盖；K 线不可变，进程内缓存 6 小时。
  async fetchCandles({ symbol, market = 'futures', fromMs, toMs }) {
    const instId = instIdOf(symbol, market);
    if (!instId) return { bar: '1H', candles: [], truncated: false };
    const bars = [
      ['1m', 60_000], ['3m', 180_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000],
      ['1H', 3_600_000], ['2H', 7_200_000], ['4H', 14_400_000], ['6H', 21_600_000],
      ['12H', 43_200_000], ['1D', 86_400_000],
    ];
    const dur = Math.max(0, Number(toMs) - Number(fromMs));
    let bar = '1D', barMs = 86_400_000;
    for (const [name, ms] of bars) {
      if (dur / ms <= 90) { bar = name; barMs = ms; break; }
    }
    const cacheKey = `${instId}|${bar}|${Math.floor(fromMs / barMs)}|${Math.floor(toMs / barMs)}`;
    const hit = candleCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;

    const out = [];
    let after = String(Number(toMs) + 1);
    for (let page = 0; page < 3 && out.length < 300; page++) {
      const q = new URLSearchParams({ instId, bar, after, limit: '100' });
      const rows = await publicGet(`/api/v5/market/history-candles?${q}`);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const t = Number(r[0]);
        if (Number.isFinite(t) && t >= Number(fromMs)) {
          out.push({ t, o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]) });
        }
      }
      const oldest = Number(rows[rows.length - 1][0]);
      if (!Number.isFinite(oldest) || oldest <= Number(fromMs) || rows.length < 100) break;
      after = String(oldest);
    }
    out.sort((a, b) => a.t - b.t);
    const result = { bar, candles: out, truncated: out.length >= 300 };
    if (candleCache.size >= 300) candleCache.delete(candleCache.keys().next().value);
    candleCache.set(cacheKey, { ...result, at: Date.now() });
    return result;
  },

  // 某个持仓回合的逐笔成交（需签名的私有接口）。用于交易详情页「操作明细」：
  // 同一回合的开仓、加仓、减仓、做T 全部归属这条记录。成交不可变，缓存 6 小时。
  async fetchEpisodeFills({ creds, symbol, market = 'futures', fromMs, toMs, limit }) {
    const instId = instIdOf(symbol, market);
    if (!instId) return { fills: [] };
    const cap = Math.max(50, Number(limit) || 300);
    const cacheKey = `fills|${instId}|${fromMs}|${toMs}`;
    const hit = fillCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;

    // SWAP 的 fillSz 单位是「张」，按合约面值换算成币；现货本身就是币
    let ctVal = 1;
    if (market !== 'spot') {
      if (!ctValCache.has(instId)) {
        const q = new URLSearchParams({ instType: 'SWAP', instId });
        const rows = await publicGet(`/api/v5/public/instruments?${q}`);
        ctValCache.set(instId, num(rows?.[0]?.ctVal) || 1);
      }
      ctVal = ctValCache.get(instId);
    }

    const out = [];
    let after = null;
    for (let page = 0; page < 3 && out.length < cap; page++) {
      const q = new URLSearchParams({
        instType: market === 'spot' ? 'SPOT' : 'SWAP',
        instId,
        limit: '100',
        begin: String(Math.max(0, Number(fromMs) - 1)),
        end: String(Number(toMs)),
      });
      if (after) q.set('after', after);
      const rows = await call(`/api/v5/trade/fills-history?${q}`, creds);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        const t = Number(row.ts || 0);
        if (!t || t < Number(fromMs) || t > Number(toMs)) continue;
        out.push({
          t,
          side: String(row.side).toLowerCase() === 'buy' ? 'buy' : 'sell',
          price: num(row.fillPx),
          qty: num(row.fillSz) * ctVal,
          fee: num(row.fee),
          feeCcy: row.feeCcy || '',
          billId: row.billId || '',
        });
      }
      const next = rows[rows.length - 1]?.billId;
      if (!next || next === after || rows.length < 100) break;
      after = next;
    }
    // fills-history 只保留约 3 个月。更早的成交 OKX 只提供「两年归档」异步导出
    // （POST 申请文件、生成约需 30 小时），无法用于页面实时查询，如实返回原因。
    if (!out.length && Number(fromMs) < Date.now() - 90 * 86400_000) {
      return {
        fills: [],
        reason: 'OKX 逐笔成交仅保留约 3 个月，该回合超出保留期；更早记录需在 OKX 官网「两年归档」申请导出（生成约需 30 小时），无法实时拉取',
      };
    }
    out.sort((a, b) => a.t - b.t);
    const result = { fills: out.slice(0, cap) };
    if (fillCache.size >= 300) fillCache.delete(fillCache.keys().next().value);
    fillCache.set(cacheKey, { ...result, at: Date.now() });
    return result;
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
