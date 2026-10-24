/**
 * 统计引擎（纯函数，不碰数据库）
 *
 * 统一口径：
 *   胜率       = 盈利笔数 / 总已平仓笔数
 *   交易预期   = 胜率 × 平均盈利 − 败率 × 平均亏损
 *   毛盈亏     = 净盈亏 − 手续费 − 资金费（见 breakdown.js）
 *   时段统计   = 按 close_time、服务端本地时区
 */

export const sum = (arr, f = (x) => x) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);
export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function durationOf(trade) {
  return new Date(trade.close_time).getTime() - new Date(trade.open_time).getTime();
}

/** 本地日期键：与日历、日期筛选保持同一口径 */
export function localDayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function winRateOf(list) {
  if (!list.length) return 0;
  return list.filter((t) => t.pnl > 0).length / list.length;
}

function streaks(sortedAsc) {
  let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  for (const t of sortedAsc) {
    if (t.pnl > 0) {
      curWin += 1; curLoss = 0; maxWin = Math.max(maxWin, curWin);
    } else {
      curLoss += 1; curWin = 0; maxLoss = Math.max(maxLoss, curLoss);
    }
  }
  return { maxConsecutiveWin: maxWin, maxConsecutiveLoss: maxLoss };
}

function sideBlock(list, total) {
  const count = list.length;
  const wins = list.filter((t) => t.pnl > 0).length;
  const losses = count - wins;
  const avgDuration = mean(list, durationOf);
  const above = list.filter((t) => durationOf(t) >= avgDuration);
  const below = list.filter((t) => durationOf(t) < avgDuration);
  const avgWin = wins ? sum(list.filter((t) => t.pnl > 0), (t) => t.pnl) / wins : 0;
  const avgLoss = losses ? Math.abs(sum(list.filter((t) => t.pnl <= 0), (t) => t.pnl)) / losses : 0;
  return {
    count,
    ratio: total ? count / total : 0,
    wins,
    losses,
    winRate: count ? wins / count : 0,
    avgDuration,
    pnl: sum(list, (t) => t.pnl),
    avgWin,
    avgLoss,
    winAboveAvgRate: winRateOf(above),
    winBelowAvgRate: winRateOf(below),
    aboveCount: above.length,
    belowCount: below.length,
    volume: sum(list, (t) => t.notional),
  };
}

export const DURATION_BUCKETS = [
  { label: '< 5 分钟', min: 0, max: 5 * 60000 },
  { label: '5–15 分钟', min: 5 * 60000, max: 15 * 60000 },
  { label: '15 分钟 – 1 小时', min: 15 * 60000, max: 60 * 60000 },
  { label: '1–4 小时', min: 60 * 60000, max: 4 * 3600000 },
  { label: '4–12 小时', min: 4 * 3600000, max: 12 * 3600000 },
  { label: '12–24 小时', min: 12 * 3600000, max: 24 * 3600000 },
  { label: '> 1 天', min: 24 * 3600000, max: Infinity },
];

export const SIZE_BUCKETS = [
  { label: '< $100', min: 0, max: 100 },
  { label: '$100 – $500', min: 100, max: 500 },
  { label: '$500 – $1k', min: 500, max: 1000 },
  { label: '$1k – $5k', min: 1000, max: 5000 },
  { label: '$5k – $20k', min: 5000, max: 20000 },
  { label: '$20k – $100k', min: 20000, max: 100000 },
  { label: '> $100k', min: 100000, max: Infinity },
];

export function analyze(trades) {
  const all = trades || [];
  const sorted = [...all].sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  const total = sorted.length;

  const wins = sorted.filter((t) => t.pnl > 0);
  const losses = sorted.filter((t) => t.pnl <= 0);
  const winRate = total ? wins.length / total : 0;

  const avgWin = wins.length ? sum(wins, (t) => t.pnl) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(sum(losses, (t) => t.pnl)) / losses.length : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  /* ---------- 行为诊断 ---------- */
  const grossWin = sum(wins, (t) => t.pnl);
  const grossLoss = Math.abs(sum(losses, (t) => t.pnl));
  const behavior = {
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    // 该胜率下保本所需的盈亏比：(1-胜率)/胜率
    breakevenRatio: winRate > 0 && winRate < 1 ? (1 - winRate) / winRate : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    // 最差 5% 的亏损集中度
    bigLossCount: losses.length ? Math.max(1, Math.ceil(losses.length * 0.05)) : 0,
    bigLossSum: 0,
    bigLossVsProfit: grossWin > 0 ? 0 : null,
    lossDurationMs: losses.length ? mean(losses, durationOf) : 0,
    winDurationMs: wins.length ? mean(wins, durationOf) : 0,
  };
  {
    const worst = [...losses].sort((a, b) => a.pnl - b.pnl).slice(0, behavior.bigLossCount);
    behavior.bigLossSum = Math.abs(sum(worst, (t) => t.pnl));
    if (grossWin > 0) behavior.bigLossVsProfit = behavior.bigLossSum / grossWin;
  }

  const totalPnl = sum(sorted, (t) => t.pnl);
  const totalVolume = sum(sorted, (t) => t.notional);
  const avgDuration = mean(sorted, durationOf);

  const days = [...new Set(sorted.map((t) => localDayKey(t.close_time)))].sort();
  const activeDays = days.length || 1;

  /* ---------- 按天 ---------- */
  const dailyMap = new Map();
  for (const t of sorted) {
    const key = localDayKey(t.close_time);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, pnl: 0, volume: 0, trades: 0, wins: 0, longs: 0, shorts: 0 });
    }
    const d = dailyMap.get(key);
    d.pnl += t.pnl;
    d.volume += t.notional;
    d.trades += 1;
    if (t.pnl > 0) d.wins += 1;
    if (t.side === 'long') d.longs += 1; else d.shorts += 1;
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of daily) d.winRate = d.trades ? d.wins / d.trades : 0;

  /* ---------- 累计盈亏与回撤 ---------- */
  let cum = 0, peak = 0, maxDd = 0, maxDdPct = 0;
  const cumulative = [];
  const drawdown = [];
  for (const d of daily) {
    cum += d.pnl;
    peak = Math.max(peak, cum);
    const dd = peak - cum;
    const ddPct = peak !== 0 ? dd / Math.abs(peak) : 0;
    if (dd > maxDd) maxDd = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    cumulative.push({ date: d.date, value: cum });
    drawdown.push({ date: d.date, value: dd, peak });
  }

  /* ---------- 按小时 / 星期 ---------- */
  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({
    hour, pnl: 0, trades: 0, wins: 0, volume: 0, winRate: 0,
  }));
  const weekdayBuckets = WEEKDAYS.map((label) => ({
    label, pnl: 0, trades: 0, wins: 0, volume: 0, winRate: 0,
  }));
  for (const t of sorted) {
    const d = new Date(t.close_time);
    const h = hourBuckets[d.getHours()];
    h.pnl += t.pnl; h.trades += 1; h.volume += t.notional;
    if (t.pnl > 0) h.wins += 1;
    const w = weekdayBuckets[d.getDay()];
    w.pnl += t.pnl; w.trades += 1; w.volume += t.notional;
    if (t.pnl > 0) w.wins += 1;
  }
  for (const b of hourBuckets) b.winRate = b.trades ? b.wins / b.trades : 0;
  for (const b of weekdayBuckets) b.winRate = b.trades ? b.wins / b.trades : 0;

  /* ---------- 周 × 小时矩阵 ---------- */
  const hourWeekday = Array.from({ length: 7 }, (_, wd) =>
    Array.from({ length: 24 }, (_, hour) => ({
      weekday: wd, weekdayLabel: WEEKDAYS[wd], hour,
      trades: 0, wins: 0, pnl: 0, volume: 0, winRate: 0,
    })));
  for (const t of sorted) {
    const d = new Date(t.close_time);
    const cell = hourWeekday[d.getDay()][d.getHours()];
    cell.trades += 1;
    cell.pnl += t.pnl;
    cell.volume += t.notional;
    if (t.pnl > 0) cell.wins += 1;
  }
  for (const row of hourWeekday) for (const cell of row) cell.winRate = cell.trades ? cell.wins / cell.trades : 0;

  const filledSlots = hourWeekday.flat().filter((c) => c.trades > 0);
  const bestSlot = filledSlots.length ? [...filledSlots].sort((a, b) => b.pnl - a.pnl)[0] : null;
  const worstSlot = filledSlots.length ? [...filledSlots].sort((a, b) => a.pnl - b.pnl)[0] : null;
  // 至少 3 笔才参与胜率榜，避免单笔 100% 噪声
  const bestWinRateSlot = filledSlots.filter((c) => c.trades >= 3)
    .sort((a, b) => b.winRate - a.winRate || b.trades - a.trades)[0] || null;

  /* ---------- 持仓时长 / 仓位分桶 ---------- */
  const durationBuckets = DURATION_BUCKETS.map((b) => ({ ...b, count: 0, wins: 0, pnl: 0, avgDuration: 0 }));
  for (const t of sorted) {
    const d = durationOf(t);
    const b = durationBuckets.find((x) => d >= x.min && d < x.max);
    if (!b) continue;
    b.count += 1;
    b.pnl += t.pnl;
    b.avgDuration += d;
    if (t.pnl > 0) b.wins += 1;
  }
  for (const b of durationBuckets) {
    b.winRate = b.count ? b.wins / b.count : 0;
    b.avgDuration = b.count ? b.avgDuration / b.count : 0;
  }

  const sizeBuckets = SIZE_BUCKETS.map((b) => ({ ...b, count: 0, wins: 0, pnl: 0, avgPnl: 0 }));
  for (const t of sorted) {
    const b = sizeBuckets.find((x) => t.notional >= x.min && t.notional < x.max);
    if (!b) continue;
    b.count += 1;
    b.pnl += t.pnl;
    if (t.pnl > 0) b.wins += 1;
  }
  for (const b of sizeBuckets) {
    b.winRate = b.count ? b.wins / b.count : 0;
    b.avgPnl = b.count ? b.pnl / b.count : 0;
  }

  /* ---------- 订单类型 ---------- */
  const orderTypes = ['market', 'limit', 'other'].map((key) => {
    const list = sorted.filter((t) => (t.order_type || 'other') === key);
    const w = list.filter((t) => t.pnl > 0).length;
    const l = list.length - w;
    return {
      key,
      count: list.length,
      ratio: total ? list.length / total : 0,
      pnl: sum(list, (t) => t.pnl),
      winRate: list.length ? w / list.length : 0,
      avgWin: w ? sum(list.filter((t) => t.pnl > 0), (t) => t.pnl) / w : 0,
      avgLoss: l ? Math.abs(sum(list.filter((t) => t.pnl <= 0), (t) => t.pnl)) / l : 0,
      volume: sum(list, (t) => t.notional),
    };
  });

  /* ---------- 资金费 / 手续费 ---------- */
  let fundingReceived = 0, fundingPaid = 0, makerRebate = 0, marketFee = 0, feeNet = 0;
  for (const t of sorted) {
    if (t.funding > 0) fundingReceived += t.funding; else fundingPaid += Math.abs(t.funding);
    feeNet += t.fee;
    if (t.fee > 0) makerRebate += t.fee;
    else if ((t.order_type || '') === 'market') marketFee += Math.abs(t.fee);
  }

  /* ---------- 币种 ---------- */
  const symbolMap = new Map();
  for (const t of sorted) {
    if (!symbolMap.has(t.symbol)) symbolMap.set(t.symbol, []);
    symbolMap.get(t.symbol).push(t);
  }
  const symbols = [...symbolMap.entries()].map(([symbol, list]) => ({
    symbol,
    count: list.length,
    pnl: sum(list, (t) => t.pnl),
    winRate: winRateOf(list),
    volume: sum(list, (t) => t.notional),
  })).sort((a, b) => b.pnl - a.pnl);

  /* ---------- 标签 ---------- */
  const tagMap = new Map();
  for (const t of sorted) {
    for (const tag of t.tags || []) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(t);
    }
  }
  const tagStats = [...tagMap.entries()].map(([tag, list]) => {
    const w = list.filter((t) => t.pnl > 0).length;
    const l = list.length - w;
    const aw = w ? sum(list.filter((t) => t.pnl > 0), (t) => t.pnl) / w : 0;
    const al = l ? Math.abs(sum(list.filter((t) => t.pnl <= 0), (t) => t.pnl)) / l : 0;
    const wr = list.length ? w / list.length : 0;
    return {
      tag,
      count: list.length,
      pnl: sum(list, (t) => t.pnl),
      winRate: wr,
      avgWin: aw,
      avgLoss: al,
      expectancy: wr * aw - (1 - wr) * al,
      avgDuration: mean(list, durationOf),
    };
  }).sort((a, b) => b.expectancy - a.expectancy || b.count - a.count);

  /* ---------- 复盘覆盖率 ---------- */
  const noted = sorted.filter((t) => t.note && String(t.note).trim());
  const noteCoverage = {
    total,
    noted: noted.length,
    ratio: total ? noted.length / total : 0,
    recent: [...noted]
      .sort((a, b) => String(b.note_updated_at || b.close_time).localeCompare(String(a.note_updated_at || a.close_time)))
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        symbol: t.symbol,
        note: String(t.note).slice(0, 80),
        at: t.note_updated_at || t.close_time,
      })),
  };

  // 账本回填等降级记录没有方向（size=0），不计入多空统计
  const sided = sorted.filter((t) => Number(t.size) > 0 || Number(t.notional) > 0);
  const longs = sided.filter((t) => t.side === 'long');
  const shorts = sided.filter((t) => t.side === 'short');

  return {
    total,
    wins: wins.length,
    losses: losses.length,
    winRate,
    expectancy,
    avgWin,
    avgLoss,
    behavior,
    totalPnl,
    totalVolume,
    avgDuration,
    maxGain: total ? Math.max(...sorted.map((t) => t.pnl)) : 0,
    maxLoss: total ? Math.min(...sorted.map((t) => t.pnl)) : 0,
    activeDays,
    dayList: days,
    dailyAvgPnl: totalPnl / activeDays,
    dailyAvgVolume: totalVolume / activeDays,
    dailyAvgTrades: total / activeDays,
    ...streaks(sorted),
    longs: sideBlock(longs, total),
    shorts: sideBlock(shorts, total),
    daily,
    cumulative,
    drawdown: { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, series: drawdown },
    hourBuckets,
    weekdayBuckets,
    hourWeekday,
    bestSlot,
    worstSlot,
    bestWinRateSlot,
    durationBuckets,
    sizeBuckets,
    orderTypes,
    funding: { received: fundingReceived, paid: fundingPaid, net: fundingReceived - fundingPaid },
    fees: { makerRebate, marketFee, net: feeNet },
    symbols,
    tagStats,
    noteCoverage,
  };
}

/** 列表页的筛选与排序（纯函数） */
export function filterTrades(trades, q = {}) {
  let list = trades || [];
  if (q.account_id && q.account_id !== 'all') list = list.filter((t) => String(t.account_id) === String(q.account_id));
  if (q.market && q.market !== 'all') list = list.filter((t) => (t.market || 'futures') === q.market);
  if (q.side && q.side !== 'all') list = list.filter((t) => t.side === q.side);
  if (q.result && q.result !== 'all') {
    list = q.result === 'win' ? list.filter((t) => t.pnl > 0) : list.filter((t) => t.pnl <= 0);
  }
  if (q.symbol && q.symbol !== 'all') list = list.filter((t) => t.symbol === q.symbol);
  if (q.orderType && q.orderType !== 'all') list = list.filter((t) => (t.order_type || 'other') === q.orderType);
  if (q.tag) list = list.filter((t) => (t.tags || []).includes(q.tag));
  if (q.note === 'yes') list = list.filter((t) => t.note && String(t.note).trim());
  else if (q.note === 'no') list = list.filter((t) => !t.note || !String(t.note).trim());
  if (q.from) list = list.filter((t) => t.close_time >= q.from);
  if (q.to) list = list.filter((t) => t.close_time <= q.to);
  if (q.q) {
    const kw = String(q.q).toLowerCase();
    list = list.filter((t) =>
      String(t.symbol).toLowerCase().includes(kw)
      || String(t.note || '').toLowerCase().includes(kw)
      || (t.tags || []).some((x) => String(x).toLowerCase().includes(kw)));
  }
  const cmp = {
    time: (a, b) => new Date(b.close_time) - new Date(a.close_time),
    pnl: (a, b) => b.pnl - a.pnl,
    duration: (a, b) => durationOf(b) - durationOf(a),
    size: (a, b) => b.notional - a.notional,
  }[q.sort || 'time'] || ((a, b) => 0);
  return [...list].sort(cmp);
}

/** 按天聚合（日历页用） */
export function dailyMap(trades) {
  const map = new Map();
  for (const t of trades || []) {
    const key = localDayKey(t.close_time);
    if (!map.has(key)) map.set(key, { date: key, pnl: 0, trades: 0, wins: 0, days: 0 });
    const d = map.get(key);
    d.pnl += Number(t.pnl) || 0;
    d.trades += 1;
    if (t.pnl > 0) d.wins += 1;
  }
  for (const d of map.values()) d.winRate = d.trades ? d.wins / d.trades : 0;
  return map;
}
