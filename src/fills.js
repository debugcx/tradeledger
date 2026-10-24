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

/**
 * 净头寸回合配对：同一品种从净持仓 0 → 0 记为一个回合（与 OKX 仓位历史同口径），
 * 回合内的开仓、加仓、减仓、清零都归属同一条记录。
 * 开/平价 = 各腿加权均价；盈亏按「减仓腿 × 当时移动开仓均价」累计（含手续费）。
 * 与 matchFills 的区别：不会把一次持仓拆成多条手数记录。
 */
export function matchEpisodes(fills, source) {
  const sorted = [...fills].filter((f) => f && f.time && f.symbol && f.qty > 0 && f.price > 0)
    .sort((a, b) => a.time - b.time);
  const books = new Map(); // symbol -> { pos, avgPx, legs: [...] }
  const out = [];
  const seen = new Map();

  const emit = (symbol, legs) => {
    if (legs.length < 2) return;
    let pos = 0;
    let avg = 0;
    let openQty = 0, closeQty = 0, openFee = 0, closeFee = 0;
    let openNotional = 0, closeNotional = 0, pnl = 0;
    let openTime = Infinity, closeTime = 0;
    for (const f of legs) {
      const dir = f.side === 'buy' ? 1 : -1;
      const before = pos;
      pos += dir * f.qty;
      const reducing = Math.abs(pos) < Math.abs(before) - 1e-12;
      if (reducing) {
        const legQty = Math.min(f.qty, Math.abs(before));
        pnl += (f.price - avg) * legQty * (before > 0 ? 1 : -1);
        closeQty += legQty;
        closeNotional += f.price * legQty;
        closeFee += f.fee;
      } else {
        avg = (avg * Math.abs(before) + f.price * f.qty) / Math.abs(pos);
        openQty += f.qty;
        openNotional += f.price * f.qty;
        openFee += f.fee;
      }
      openTime = Math.min(openTime, f.time);
      closeTime = Math.max(closeTime, f.time);
    }
    if (openQty <= 1e-12 || closeQty <= 1e-12) return;
    const side = legs[0].side === 'buy' ? 'long' : 'short';
    const trade = {
      symbol,
      side,
      order_type: normalizeOrderType(legs[0].orderType),
      size: openQty,
      notional: openNotional,
      entry_price: openNotional / openQty,
      exit_price: closeNotional / closeQty,
      open_time: new Date(openTime).toISOString(),
      close_time: new Date(closeTime).toISOString(),
      pnl: pnl + openFee + closeFee, // 减仓腿已计入平仓费，这里补开仓费
      fee: openFee + closeFee,
      funding: 0,
      source: 'api',
    };
    let externalId = `${source}:ep:${fingerprintTrade(trade)}`;
    if (seen.has(externalId)) {
      const n = seen.get(externalId) + 1;
      seen.set(externalId, n);
      externalId = `${externalId}:${n}`;
    } else {
      seen.set(externalId, 1);
    }
    out.push({ ...trade, external_id: externalId });
  };

  for (const fill of sorted) {
    const qty = Math.abs(num(fill.qty));
    const dir = fill.side === 'buy' ? 1 : -1;
    let book = books.get(fill.symbol) || { pos: 0, avgPx: 0, legs: [] };
    const before = book.pos;
    book.pos += dir * qty;
    book.legs.push({ ...fill, qty });
    // 一腿直接穿越零轴：减仓部分结束当前回合，剩余反向开新回合
    if (Math.abs(before) > 1e-12 && Math.sign(book.pos) !== Math.sign(before) && Math.abs(book.pos) > 1e-12) {
      const carried = Math.abs(book.pos);
      emit(fill.symbol, book.legs);
      books.set(fill.symbol, { pos: book.pos, avgPx: 0, legs: [{ ...fill, qty: carried }] });
      continue;
    }
    if (Math.abs(book.pos) <= 1e-12) {
      emit(fill.symbol, book.legs);
      books.delete(fill.symbol);
    } else {
      books.set(fill.symbol, book);
    }
  }
  // 窗口结束时仍未清零的持仓不产出回合（等清零后的批次补齐）
  return out;
}
