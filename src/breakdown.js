/**
 * 单笔交易的盈亏推导（纯函数）
 *
 * 口径：pnl 是已扣费的净盈亏；fee / funding 正数 = 收入，负数 = 支出。
 *   毛盈亏 = 净盈亏 − 手续费 − 资金费
 * 再用开平仓价 × 数量独立复算一次，供用户核对。
 */

export function tradeBreakdown(trade) {
  if (!trade) return null;
  const n = (v) => Number(v) || 0;
  const pnl = n(trade.pnl);
  const fee = n(trade.fee);
  const funding = n(trade.funding);
  const gross = pnl - fee - funding;

  const sideDir = trade.side === 'short' ? -1 : 1;
  const size = n(trade.size);
  const entry = n(trade.entry_price);
  const exit = n(trade.exit_price);
  const hasPrices = size !== 0 && entry !== 0 && exit !== 0;
  const pricePnl = hasPrices ? (exit - entry) * size * sideDir : null;
  const priceDiff = pricePnl === null ? null : gross - pricePnl;
  // 容差取「1% 或 1 美分」的较大者：合约面值 / 币本位会让复算值天然对不上
  const priceMatch = pricePnl === null
    ? null
    : Math.abs(priceDiff) <= Math.max(0.01, Math.abs(gross) * 0.01);

  const notional = n(trade.notional) || (entry && size ? entry * Math.abs(size) : 0);
  const durationMs = trade.open_time && trade.close_time
    ? new Date(trade.close_time).getTime() - new Date(trade.open_time).getTime()
    : 0;

  return {
    pnl, fee, funding, gross,
    costs: fee + funding,
    side: trade.side,
    sideDir,
    size, entry, exit, notional,
    hasPrices,
    pricePnl,
    priceDiff,
    priceMatch,
    returnPct: notional ? pnl / notional : null,
    durationMs,
  };
}
