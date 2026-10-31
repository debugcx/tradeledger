/**
 * 把持仓期的 K 线压缩成给 AI 的行情摘要（纯函数）。
 *
 * 目的：让单笔交易的复盘能结合持仓期间的走势，而不只是开平仓两个价格。
 * 输出包括：区间高低点、方向调整后的最大浮盈 / 最大浮亏、振幅、分段价格路径。
 */

export function summarizeHoldingCandles({ candles, bar = '', side = 'long', entry = 0, exit = 0, openMs = 0, closeMs = 0 } = {}) {
  const list = (candles || []).filter((c) => c
    && Number.isFinite(Number(c.h)) && Number.isFinite(Number(c.l)) && Number.isFinite(Number(c.c)));
  if (list.length < 2 || !(Number(entry) > 0)) return null;

  const dir = side === 'short' ? -1 : 1;
  const entryNum = Number(entry);
  let high = -Infinity;
  let low = Infinity;
  let highAt = 0;
  let lowAt = 0;
  for (const c of list) {
    const h = Number(c.h);
    const l = Number(c.l);
    if (h > high) { high = h; highAt = Number(c.t); }
    if (l < low) { low = l; lowAt = Number(c.t); }
  }

  // 相对开仓价、按持仓方向折算的百分比（正=有利）
  const pct = (v) => ((Number(v) - entryNum) / entryNum) * 100 * dir;
  const favorPct = dir > 0 ? ((high - entryNum) / entryNum) * 100 : ((entryNum - low) / entryNum) * 100;
  const adversePct = dir > 0 ? ((entryNum - low) / entryNum) * 100 : ((high - entryNum) / entryNum) * 100;

  // 最多 8 段价格路径：每段取该段最后一根收盘价
  const segs = Math.min(8, list.length);
  const path = [];
  for (let i = 0; i < segs; i++) {
    const from = Math.floor((i * list.length) / segs);
    const to = Math.max(from + 1, Math.floor(((i + 1) * list.length) / segs));
    const last = list[Math.min(to, list.length) - 1];
    if (!last) continue;
    path.push({ at: Number(last.t), pct: pct(last.c) });
  }

  const lastClose = Number(list[list.length - 1].c);
  return {
    bar: String(bar || ''),
    count: list.length,
    high,
    low,
    highAt,
    lowAt,
    favorPct: Math.max(0, favorPct),
    adversePct: Math.max(0, adversePct),
    rangePct: ((high - low) / entryNum) * 100,
    exitPct: pct(Number(exit) || lastClose),
    path,
    spanMs: Math.max(0, Number(closeMs || list[list.length - 1].t) - Number(openMs || list[0].t)),
  };
}
