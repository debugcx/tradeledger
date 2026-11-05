/**
 * 统计引擎（纯函数，不碰数据库）
 *
 * 统一口径：
 *   胜率       = 盈利笔数 / 总已平仓笔数（pnl=0 记为亏损）
 *   交易预期   = 胜率 × 平均盈利 − 败率 × 平均亏损
 *   毛盈亏     = 净盈亏 − 手续费 − 资金费（见 breakdown.js）
 *   时段统计   = 按 close_time、TRADELEDGER_TZ 时区（未设置则用服务器本地时区）
 */

export const sum = (arr, f = (x) => x) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);
export const mean = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : 0);

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DURATIONS = new WeakMap();
export function durationOf(trade) {
  let v = DURATIONS.get(trade);
  if (v === undefined) {
    v = new Date(trade.close_time).getTime() - new Date(trade.open_time).getTime();
    DURATIONS.set(trade, v);
  }
  return v;
}

/* ---------------- 时区口径 ----------------
 * 默认用服务器本地时区。部署到 UTC 服务器（如 Docker/VPS）时，
 * 设置 TRADELEDGER_TZ=Asia/Shanghai 即可让热力图、日历、周界都按北京时间计算。
 */
const TZ = (() => {
  const tz = String(process.env.TRADELEDGER_TZ || '').trim();
  if (!tz) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return ''; }
})();
const pad2 = (n) => String(n).padStart(2, '0');
const OFFSET_FMT = TZ
  ? new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
  : null;

/** 指定时刻在业务时区相对 UTC 的偏移（毫秒） */
function zoneOffsetMs(date) {
  if (!OFFSET_FMT) return -date.getTimezoneOffset() * 60000;
  const name = OFFSET_FMT.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
}

// Intl.formatToParts 单次约 10µs；10 万笔交易逐笔调用会占掉 analyze 大半时间。
// 时区偏移按 UTC 小时缓存（一年约 8760 个桶），常规情况下偏移在整点内不变。
const OFFSET_CACHE = new Map();
function zoneOffsetCached(date) {
  const bucket = Math.floor(date.getTime() / 3600_000);
  let offset = OFFSET_CACHE.get(bucket);
  if (offset === undefined) {
    offset = zoneOffsetMs(date);
    if (OFFSET_CACHE.size > 20_000) OFFSET_CACHE.clear();
    OFFSET_CACHE.set(bucket, offset);
  }
  return offset;
}

/** 返回 {dayKey, monthKey, hour, weekday}；无效日期返回 null */
function zonedOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!TZ) {
    return {
      dayKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      monthKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
      hour: d.getHours(),
      weekday: d.getDay(),
    };
  }
  const local = new Date(d.getTime() + zoneOffsetCached(d));
  return {
    dayKey: `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`,
    monthKey: `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}`,
    hour: local.getUTCHours(),
    weekday: local.getUTCDay(),
  };
}

/** 本地日期键：与日历、日期筛选保持同一口径 */
export function localDayKey(iso) {
  const z = zonedOf(iso);
  return z ? z.dayKey : String(iso).slice(0, 10);
}

/** 日期入参归一化：允许 YYYY-MM-DD 或带时间的 ISO，统一返回本地日键。 */
export function dayKeyOf(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.length > 10 ? localDayKey(s) : s.slice(0, 10);
}

/** 本地日 00:00 对应的 UTC 时刻（无 TRADELEDGER_TZ 时按服务器本地时区）。 */
export function localDayStartUtc(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 拒绝 2026-02-31 这类会被 Date 自动进位的日期。
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  if (!TZ) return new Date(y, mo - 1, d);
  const base = Date.UTC(y, mo - 1, d);
  let ts = base;
  // 用两次迭代收敛 DST 边界：偏移量本身取决于估算出的 UTC 时刻。
  for (let i = 0; i < 3; i++) {
    const next = base - zoneOffsetMs(new Date(ts));
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** 本地日次日 00:00 对应的 UTC 时刻（SQL 用半开区间）。 */
export function localDayEndExclusiveUtc(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return localDayStartUtc(
    `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`,
  );
}

/** 本地月份键：YYYY-MM */
export function localMonthKey(iso) {
  const z = zonedOf(iso);
  return z ? z.monthKey : String(iso).slice(0, 7);
}

function winRateOf(list) {
  if (!list.length) return 0;
  return list.filter((t) => t.pnl > 0).length / list.length;
}

function streaks(sortedAsc) {
  let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  let curLossList = [], maxLossList = [];
  for (const t of sortedAsc) {
    if (t.pnl > 0) {
      curWin += 1; curLoss = 0; curLossList = []; maxWin = Math.max(maxWin, curWin);
    } else {
      curLoss += 1; curWin = 0; curLossList.push(t);
      if (curLoss > maxLoss) { maxLoss = curLoss; maxLossList = curLossList; }
    }
  }
  // 并列的最长连亏取先出现的那段
  return { maxConsecutiveWin: maxWin, maxConsecutiveLoss: maxLoss, maxLossStreakTrades: maxLossList };
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

/** 平仓时间/持仓时长的毫秒缓存：排序与分桶逐笔 new Date 很贵。
 *  用 WeakMap 而不是给行对象加下划线字段，避免缓存字段泄漏到导出/响应里。 */
const CLOSE_TS = new WeakMap();
function closeTs(t) {
  let v = CLOSE_TS.get(t);
  if (v === undefined) {
    v = new Date(t.close_time).getTime();
    CLOSE_TS.set(t, v);
  }
  return v;
}

export function analyze(trades) {
  const all = trades || [];
  const sorted = [...all].sort((a, b) => closeTs(a) - closeTs(b));
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
    bigLossTrades: [],
    lossDurationMs: losses.length ? mean(losses, durationOf) : 0,
    winDurationMs: wins.length ? mean(wins, durationOf) : 0,
  };
  {
    const worst = [...losses].sort((a, b) => a.pnl - b.pnl).slice(0, behavior.bigLossCount);
    behavior.bigLossSum = Math.abs(sum(worst, (t) => t.pnl));
    behavior.bigLossTrades = worst;
    if (grossWin > 0) behavior.bigLossVsProfit = behavior.bigLossSum / grossWin;
  }

  const totalPnl = sum(sorted, (t) => t.pnl);
  const totalVolume = sum(sorted, (t) => t.notional);
  const avgDuration = mean(sorted, durationOf);

  // 每笔交易的时区口径只算一次（Intl 较慢），天/小时/星期/月共用
  const zone = sorted.map((t) => zonedOf(t.close_time)
    || { dayKey: String(t.close_time).slice(0, 10), monthKey: String(t.close_time).slice(0, 7), hour: 0, weekday: 0 });
  const days = [...new Set(zone.map((z) => z.dayKey))].sort();
  const activeDays = days.length || 1;

  /* ---------- 按天 ---------- */
  const dailyMap = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const key = zone[i].dayKey;
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

  // 盈利集中度：最大的盈利日占总盈利日的比例（1 = 全部利润来自一天，
  // 是「优势靠运气」的信号；供 Edge Score 的一致性分量使用）
  const winningDays = daily.filter((d) => d.pnl > 0);
  const winningDaysPnl = winningDays.reduce((a, d) => a + d.pnl, 0);
  const profitConcentration = winningDays.length
    ? Math.max(...winningDays.map((d) => d.pnl)) / winningDaysPnl
    : 0;

  /* ---------- 累计盈亏与回撤 ---------- */
  let cum = 0, peak = 0, maxDd = 0, maxDdPct = 0;
  let peakDay = null, troughDay = null, ddPeakDay = null;
  const cumulative = [];
  const drawdown = [];
  for (const d of daily) {
    cum += d.pnl;
    // >=：peak 停留在最后一次触及峰值的交易日
    if (cum >= peak) { peak = cum; peakDay = d.date; }
    const dd = peak - cum;
    const ddPct = peak !== 0 ? dd / Math.abs(peak) : 0;
    // 快照当时（谷底之前）的峰值日：之后创新高会覆盖 peakDay，不能直接用
    if (dd > maxDd) { maxDd = dd; troughDay = d.date; ddPeakDay = peakDay; }
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    cumulative.push({ date: d.date, value: cum });
    drawdown.push({ date: d.date, value: dd, peak });
  }
  // 最大回撤窗口：峰值日 → 谷底日（按本地日），以及窗口内平仓的全部交易
  const ddFrom = ddPeakDay || days[0] || null;
  const ddWindow = maxDd > 0 && ddFrom && troughDay
    ? {
        from: ddFrom,
        to: troughDay,
        trades: sorted.filter((t, i) => {
          const k = zone[i].dayKey;
          return k >= ddFrom && k <= troughDay;
        }),
      }
    : null;

  /* ---------- 按小时 / 星期 ---------- */
  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({
    hour, pnl: 0, trades: 0, wins: 0, volume: 0, winRate: 0,
  }));
  const weekdayBuckets = WEEKDAYS.map((label) => ({
    label, pnl: 0, trades: 0, wins: 0, volume: 0, winRate: 0,
  }));
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const h = hourBuckets[zone[i].hour];
    h.pnl += t.pnl; h.trades += 1; h.volume += t.notional;
    if (t.pnl > 0) h.wins += 1;
    const w = weekdayBuckets[zone[i].weekday];
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
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const cell = hourWeekday[zone[i].weekday][zone[i].hour];
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

  /* ---------- 纪律对比（按计划执行标记） ---------- */
  // 注意 Number(null) === 0：必须先把 null 归一成 null，否则未标记会被算进违反计划
  const planOf = (t) => (t.followed_plan == null ? null : Number(t.followed_plan));
  const planBlock = (list) => ({
    count: list.length,
    winRate: winRateOf(list),
    pnl: sum(list, (t) => t.pnl),
    avgPnl: list.length ? sum(list, (t) => t.pnl) / list.length : 0,
  });
  const adherence = {
    marked: sorted.filter((t) => planOf(t) === 1 || planOf(t) === 0).length,
    planned: planBlock(sorted.filter((t) => planOf(t) === 1)),
    violated: planBlock(sorted.filter((t) => planOf(t) === 0)),
  };

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
    drawdown: { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, series: drawdown, window: ddWindow },
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
    profitConcentration,
    adherence,
  };
}

/* ---------------- 结果缓存 ----------------
 * analyze 是一次排序 + 多趟 O(n)，但仪表盘 / 标签 / 汇总每个请求各算一遍
 * 纯属浪费。单槽缓存 + 调用方提供的失效键：键 = 数据版本（store.tradesVersion()，
 * 行数/盈亏和/更新时间的聚合指纹）+ 过滤口径（账户/市场等），数据未变且口径
 * 相同就直接复用上一次结果。个人日志场景页面访问是串行的，单槽足够；
 * 返回对象按只读约定使用（视图/报告不改动 stats 字段）。
 */
/**
 * 把「取全量交易」推迟到缓存未命中时：仪表盘/标签/汇总页命中缓存后
 * 只做一次版本指纹查询 + 少量最近交易查询，不再加载整张 trades 表。
 */
let lazyAnalyzeMemo = { key: null, value: null };

export function analyzeCachedLazy(versionKey, scopeKey, loader) {
  const key = `${versionKey}#${scopeKey}`;
  if (lazyAnalyzeMemo.key === key) return lazyAnalyzeMemo.value;
  const value = analyze(loader());
  lazyAnalyzeMemo = { key, value };
  return value;
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
  // 日期筛选按「本地日」粒度，且包含结束日整天。
  // 入参既可能是 YYYY-MM-DD，也可能是带时间的 ISO；后者必须先换算回本地日，
  // 否则在 Asia/Shanghai 等时区会整体偏移一天。
  if (q.from) { const from = dayKeyOf(q.from); list = list.filter((t) => localDayKey(t.close_time) >= from); }
  if (q.to) { const to = dayKeyOf(q.to); list = list.filter((t) => localDayKey(t.close_time) <= to); }
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
