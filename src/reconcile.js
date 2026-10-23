/**
 * 对账：用「开平仓价 × 数量」独立复算毛盈亏，与记录的毛盈亏对比。
 * 目的不是判断谁对谁错，而是把不一致的交易挑出来核对。
 */

import { tradeBreakdown } from './breakdown.js';

export function reconcileTrades(trades) {
  const checked = [];
  const missing = [];
  const mismatches = [];

  for (const trade of trades || []) {
    const b = tradeBreakdown(trade);
    if (b.pricePnl === null) {
      missing.push(trade);
      continue;
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
    checked.push(row);
    if (!b.priceMatch) mismatches.push(row);
  }

  const bySource = {};
  for (const row of checked) {
    const key = row.source || 'unknown';
    if (!bySource[key]) bySource[key] = { source: key, checked: 0, mismatches: 0, missing: 0 };
    bySource[key].checked += 1;
    if (!row.match) bySource[key].mismatches += 1;
  }
  for (const trade of missing) {
    const key = trade.source || 'unknown';
    if (!bySource[key]) bySource[key] = { source: key, checked: 0, mismatches: 0, missing: 0 };
    bySource[key].missing += 1;
  }

  mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    total: (trades || []).length,
    checked: checked.length,
    missing: missing.length,
    mismatches: mismatches.length,
    matchRate: checked.length ? (checked.length - mismatches.length) / checked.length : 0,
    bySource: Object.values(bySource).sort((a, b) => b.checked - a.checked),
    worst: mismatches.slice(0, 50),
    missingExamples: missing.slice(0, 20),
  };
}
