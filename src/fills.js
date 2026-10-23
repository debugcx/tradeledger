/**
 * 逐笔成交 → round trip 配对（FIFO），以及交易指纹。
 * 独立模块，避免 csv.js ↔ exchanges/common.js 循环依赖。
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function normalizeOrderType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('market') || s.includes('市价')) return 'market';
  if (s.includes('limit') || s.includes('限价')) return 'limit';
  return 'other';
}

/** 64 位 FNV 风格指纹（两个 32 位哈希拼接），用于无外部 ID 时去重 */
export function hash64(input) {
  const str = String(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c;
    h2 = Math.imul(h2, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function fingerprintTrade(trade) {
  return hash64([
    trade.symbol,
    trade.side,
    trade.open_time,
    trade.close_time,
    Number(trade.entry_price || 0).toFixed(8),
    Number(trade.exit_price || 0).toFixed(8),
    Number(trade.size || 0).toFixed(8),
    Number(trade.pnl || 0).toFixed(8),
  ].join('|'));
}

/**
 * 现货剩余持仓（long-only FIFO）：返回每个交易对剩余数量与平均成本。
 * 用于现货持仓的成本基础展示；没有买入记录的卖出会被忽略。
 */
export function remainingLots(fills) {
  const sorted = [...fills].filter((f) => f && f.time && f.symbol && Number(f.qty) > 0)
    .sort((a, b) => a.time - b.time);
  const lots = new Map();

  for (const fill of sorted) {
    const symbol = fill.symbol;
    const qty = Math.abs(num(fill.qty));
    const price = num(fill.price);
    const side = fill.side === 'buy' ? 'buy' : 'sell';
    const book = lots.get(symbol) || [];
    if (side === 'buy') {
      book.push({ qty, price });
    } else {
      let remain = qty;
      while (remain > 1e-12 && book.length) {
        const take = Math.min(remain, book[0].qty);
        book[0].qty -= take;
        remain -= take;
        if (book[0].qty <= 1e-12) book.shift();
      }
    }
    lots.set(symbol, book);
  }

  const out = [];
  for (const [symbol, book] of lots) {
    const qty = book.reduce((a, b) => a + b.qty, 0);
    if (qty <= 1e-12) continue;
    const cost = book.reduce((a, b) => a + b.qty * b.price, 0);
    out.push({ symbol, quantity: qty, avgCost: cost / qty });
  }
  return out;
}
export function matchFills(fills, source, { longOnly = false } = {}) {
  const sorted = [...fills].filter((f) => f && f.time && f.symbol && f.qty > 0 && f.price > 0)
    .sort((a, b) => a.time - b.time);
  const lots = new Map();
  const out = [];
  const seen = new Map();

  for (const fill of sorted) {
    const qty = Math.abs(num(fill.qty));
    const price = num(fill.price);
    const fee = num(fill.fee);
    const time = Number(fill.time);
    const side = fill.side === 'buy' ? 'buy' : 'sell';
    const closeSide = side === 'buy' ? 'short' : 'long';
    const bookKey = `${fill.symbol}|${closeSide}`;
    const book = lots.get(bookKey) || [];
    let remain = qty;

    while (remain > 1e-12 && book.length) {
      const lot = book[0];
      const take = Math.min(remain, lot.qty);
      const dir = closeSide === 'long' ? 1 : -1;
      const openFee = lot.fee * (take / lot.qty);
      const closeFee = fee * (take / qty);
      const trade = {
        symbol: fill.symbol,
        side: closeSide,
        order_type: normalizeOrderType(fill.orderType),
        size: take,
        notional: lot.price * take,
        entry_price: lot.price,
        exit_price: price,
        open_time: new Date(lot.time).toISOString(),
        close_time: new Date(time).toISOString(),
        pnl: (price - lot.price) * take * dir + openFee + closeFee,
        fee: openFee + closeFee,
        funding: 0,
        source: 'api',
      };
      let externalId = `${source}:${fingerprintTrade(trade)}`;
      if (seen.has(externalId)) {
        const n = seen.get(externalId) + 1;
        seen.set(externalId, n);
        externalId = `${externalId}:${n}`;
      } else {
        seen.set(externalId, 1);
      }
      out.push({ ...trade, external_id: externalId });

      lot.fee -= openFee;
      lot.qty -= take;
      remain -= take;
      if (lot.qty <= 1e-12) book.shift();
    }
    if (book.length === 0) lots.delete(bookKey);

    if (remain > 1e-12) {
      // 现货不能开空：没有持仓的卖出（提现/转入前买入未覆盖）直接忽略
      if (longOnly && side === 'sell') continue;
      const openSide = side === 'buy' ? 'long' : 'short';
      const key = `${fill.symbol}|${openSide}`;
      const arr = lots.get(key) || [];
      arr.push({ qty: remain, price, time, fee: fee * (remain / qty) });
      lots.set(key, arr);
    }
  }

  return out;
}
