/**
 * 对账：用「开平仓价 × 数量」独立复算毛盈亏，与记录的毛盈亏对比。
 * 目的不是判断谁对谁错，而是把不一致的交易挑出来核对。
 */

import { tradeBreakdown } from './breakdown.js';

/**
 * 可增量喂入交易的对账累加器：路由可以按批查询后 add()，
 * 不必把整张 trades 表留在内存里。输出与一次性 reconcileTrades 完全一致。
 */
export function createReconcileAccumulator({ worstLimit = 50, missingLimit = 20 } = {}) {
  const bySource = new Map();
  const worst = [];
  const missingExamples = [];
  let total = 0;
  let checked = 0;
  let missing = 0;
  let mismatches = 0;

  function bucket(source) {
    const key = source || 'unknown';
    if (!bySource.has(key)) bySource.set(key, { source: key, checked: 0, mismatches: 0, missing: 0 });
    return bySource.get(key);
  }

  function add(trade) {
    total += 1;
    const b = tradeBreakdown(trade);
    if (b.pricePnl === null) {
      missing += 1;
      bucket(trade.source).missing += 1;
      if (missingExamples.length < missingLimit) missingExamples.push(trade);
      return;
    }

    const row = {
      id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      close_time: trade.close_time,
      source: trade.source,
      account_id: trade.account_id,
      account_name: trade.account_name || '',
      notional: trade.notional,
      pnl: trade.pnl,
      gross: b.gross,
      pricePnl: b.pricePnl,
      diff: b.priceDiff,
      match: b.priceMatch,
    };
    checked += 1;
    const source = bucket(row.source);
    source.checked += 1;
    if (!b.priceMatch) {
      mismatches += 1;
      source.mismatches += 1;
      worst.push(row);
      // 只保留最大的 N 条，避免不一致很多时把明细全留在内存。
      if (worst.length > worstLimit * 2) {
        worst.sort((a, b2) => Math.abs(b2.diff) - Math.abs(a.diff));
        worst.length = worstLimit;
      }
    }
  }

  function result() {
    worst.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    return {
      total,
      checked,
      missing,
      mismatches,
      matchRate: checked ? (checked - mismatches) / checked : 0,
      bySource: [...bySource.values()].sort((a, b) => b.checked - a.checked),
      worst: worst.slice(0, worstLimit),
      missingExamples,
    };
  }

  return { add, result };
}

export function reconcileTrades(trades) {
  const acc = createReconcileAccumulator();
  for (const trade of trades || []) acc.add(trade);
  return acc.result();
}
