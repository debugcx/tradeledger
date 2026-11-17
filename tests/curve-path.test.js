import test from 'node:test';
import assert from 'node:assert/strict';

const { buildCurvePoints } = await import('../src/views/journal.js');

const T0 = Date.UTC(2026, 10, 4, 14, 44);   // 开仓 22:44 本地
const BAR = 30 * 60_000;                    // 30m K 线

// 工具：生成一段收盘价序列，从 t0 开始每根 bar 一个价
const candles = (t0, prices) => prices.map((c, i) => ({ t: t0 + i * BAR, c }));

test('曲线：分批建仓按真实仓位路径计算（0.1→0.2→0.4→1.0），不是全程满仓', () => {  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'short',
    entry_price: 2355, exit_price: 2342.53, size: 1.0,
    open_time: new Date(T0).toISOString(),
    close_time: new Date(T0 + BAR * 30).toISOString(),
  };
  // 成交路径：0.1@2355 → 0.2@2365 → 0.4@2375 → 1.0@2390（最后一根 k 线在 2390 之后）
  const fills = [
    { t: T0 + 10_000, side: 'sell', price: 2355, qty: 0.1 },
    { t: T0 + 180_000, side: 'sell', price: 2365, qty: 0.1 },
    { t: T0 + 240_000, side: 'sell', price: 2375, qty: 0.2 },
    { t: T0 + 1_020_000, side: 'sell', price: 2390, qty: 0.6 },
  ];
  // 1 分钟 K 线铺满建仓过程（10s→180s→240s→1020s），保证有 K 线落在每个仓位段内
  // 每根带 low/high：多单取 low、空单取 high 作为对持仓最不利的取样价
  const mk = (c, l, h) => ({ c, l, h });
  const ks = [
    { t: T0 + 60_000, ...mk(2356, 2350, 2357) },
    { t: T0 + 120_000, ...mk(2460, 2440, 2465) },   // 空单最不利 = high 2465
    { t: T0 + 180_000, ...mk(2460, 2450, 2470) },   // 成交 180s ≤ 180s → 仓位 0.2
    { t: T0 + 240_000, ...mk(2380, 2370, 2385) },
    { t: T0 + 300_000, ...mk(2380, 2360, 2385) },
    { t: T0 + 360_000, ...mk(2300, 2290, 2310) },
    { t: T0 + 420_000, ...mk(2300, 2280, 2310) },
  ];
  // 时间轴：60s(0.1仓) / 120s(0.1) / 180s(0.2) / 240s(0.4) / 300s(1.0) / 360s(1.0) / 420s(1.0)
  const { points, peak, trough, final } = buildCurvePoints({ trade, candles: ks, fills });

  // p1=k0@60s：仓位 0.1，空单取 high 2357 → -(2357-2355)*0.1 = -0.2
  assert.ok(Math.abs(points[1].value + 0.2) < 0.01, `p1 应为 -0.2（0.1 空仓，取 high），实际 ${points[1].value}`);

  // p2=k1@120s：仍只有首笔成交 → 仓位 0.1，空单取 high 2465 → -(2465-2355)*0.1 = -11
  //   （满仓误算会是 -110）
  assert.ok(Math.abs(points[2].value + 11) < 0.6, `p2 应为 -11（0.1 空仓取 high），实际 ${points[2].value}`);

  // p3=k2@180s：第二笔成交（≤180s 含边界）已发生 → 仓位 0.2，均价 2360
  //   空单取 high 2470 → -(2470-2360)*0.2 = -22
  assert.ok(Math.abs(points[3].value + 22) < 0.6, `p3 应为 -22（0.2 空仓取 high），实际 ${points[3].value}`);

  // p5=k4@300s：三笔成交已发生（240s）→ 仓位 0.4，均价 2367.5，取 high 2385 → -7
  assert.ok(Math.abs(points[5].value + 7) < 0.6, `p5 应为 -7（0.4 空仓取 high），实际 ${points[5].value}`);

  // p6=k5@360s：0.4 仓位，空单取 high 2310 → (2367.5-2310)*0.4 = +23
  assert.ok(Math.abs(points[6].value - 23) < 0.8, `p6 应为 +23（0.4 空仓取 high），实际 ${points[6].value}`);

  // 终点：close_time 在第四笔成交（1020s）之后 → 平仓时已满仓 1.0
  //   加权开仓均价 = (2355*0.1 + 2365*0.1 + 2375*0.2 + 2390*0.6)/1.0 = 2381
  //   毛盈亏 = (2381-2342.53)*1.0 ≈ +38.47（交易所 pnl 37.33 含手续费/资金费）
  assert.ok(Math.abs(final - 38.47) < 1, `终值应为约 +38.47（满仓均价 2381），实际 ${final}`);

  // 峰谷：最大浮亏 -22（0.2 仓位段取 high 2470），不是收盘价的 -20，也绝非满仓误算的 -105
  assert.ok(Math.abs(trough + 22) < 0.8, `trough 应为 -22（极值取样），实际 ${trough}`);
  assert.ok(trough > -30, `trough 不应达到满仓误算的 -105，实际 ${trough}`);
});

test('曲线：单腿一次性开仓时与旧算法一致（回归保护）', () => {
  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'long',
    entry_price: 100, exit_price: 110, size: 2,
    open_time: new Date(T0).toISOString(),
    close_time: new Date(T0 + BAR * 5).toISOString(),
  };
  const fills = [{ t: T0 + 10_000, side: 'buy', price: 100, qty: 2 }];
  const ks = candles(T0 + 60_000, [100, 105, 110, 110, 110]);
  const { points, final } = buildCurvePoints({ trade, candles: ks, fills });
  // points[2] = 第 1 根 K 线（c=105）→ 浮盈 = 5*2 = 10
  assert.ok(Math.abs(points[2].value - 10) < 0.01, `105 时浮盈 = 5*2 = 10，实际 ${points[2].value}`);
  assert.ok(Math.abs(final - 20) < 0.01, 'exit 110 → 10*2 = 20');
});

test('曲线：没有成交数据时退回旧的满仓算法（不报错）', () => {
  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'short',
    entry_price: 100, exit_price: 90, size: 0.5,
    open_time: new Date(T0).toISOString(),
    close_time: new Date(T0 + BAR * 4).toISOString(),
  };
  const ks = candles(T0 + 60_000, [100, 105, 95, 90, 90]);
  const { points } = buildCurvePoints({ trade, candles: ks, fills: [] });
  // points[2] = 第 1 根 K 线（c=105）→ 按满仓 0.5：浮亏 = -2.5
  assert.ok(Math.abs(points[2].value + 2.5) < 0.01, `无成交时退回满仓算法，实际 ${points[2].value}`);
});

test('曲线：减仓/做T后均价不被放大（#5581 回归：曾出现 -946 浮亏）', () => {
  // 复刻 #5581：分批买入 0.3→0.5→0.7→0.8→0.9→1.0，随后做T减仓再加回
  const t0 = Date.UTC(2026, 10, 16, 14, 37);
  const H = 3600_000;
  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'long',
    entry_price: 1823.17, exit_price: 1796.07, size: 1.5,
    open_time: new Date(t0).toISOString(),
    close_time: new Date(t0 + 20 * H).toISOString(),
  };
  const fills = [
    { t: t0 + 60_000, side: 'buy', price: 1855.4, qty: 0.3 },
    { t: t0 + 12 * 60_000, side: 'buy', price: 1847.88, qty: 0.2 },
    { t: t0 + 27 * 60_000, side: 'buy', price: 1827.09, qty: 0.2 },
    { t: t0 + 28 * 60_000, side: 'buy', price: 1822.75, qty: 0.1 },
    { t: t0 + 29 * 60_000, side: 'buy', price: 1815.57, qty: 0.1 },
    { t: t0 + 50 * 60_000, side: 'buy', price: 1803.05, qty: 0.1 },
    // 做T：卖出 0.7 减仓，随后买回 0.7
    { t: t0 + 11 * H, side: 'sell', price: 1790, qty: 0.7 },
    { t: t0 + 12 * H, side: 'buy', price: 1795, qty: 0.7 },
  ];
  // K 线：覆盖全程，价格从 1856 跌到 1796
  const ks = Array.from({ length: 20 }, (_, i) => ({
    t: t0 + 60_000 + i * H,
    c: i < 11 ? 1856 - i * 3 : 1790 - (i - 11) * 2,
  }));
  const { points, peak, trough, final } = buildCurvePoints({ trade, candles: ks, fills });

  // 减仓后（t0+11H）仓位 0.8，均价仍是分批加仓的加权均价（约 1836.9）
  // 后续 K 线 c≈1790：浮亏 = (1790-1836.9)*0.8 ≈ -37.5（绝不该出现 -900 量级）
  const afterReduce = points.find((p) => p.value < -30);
  assert.ok(!afterReduce || afterReduce.value > -60,
    `减仓后浮亏不应被放大的 avgPx 拉爆，实际最深 ${trough}`);
  // 全程最深浮亏有界：1.5 满仓、均价 ≤1856、最低价 1788 → 最深约 -102
  assert.ok(trough > -120, `最深浮亏应有界（约 -100 量级），实际 ${trough}`);
  // 终点（权益曲线语义）：已实现（做T卖0.7@1790 的落袋盈亏）+ 剩余 1.0 仓位浮亏
  //   做T已实现 = (1790 - 1835.751) * 0.7 = -32.03（多单亏损）
  //   剩余仓位均价 = (1835.751*0.3 + 1795*0.7)/1.0 ≈ 1807.23 → 浮亏 = 1796.07 - 1807.23 = -11.16
  //   合计 ≈ -43.19（与交易所口径一致：中途落袋的亏损不会消失）
  const tLegRealized = (1790 - 1835.751) * 0.7;
  const remainingAvg = (1835.751 * 0.3 + 1795 * 0.7) / 1.0;
  const expected = tLegRealized + (1796.07 - remainingAvg);
  assert.ok(Math.abs(final - expected) < 1.5, `终值应约 ${expected.toFixed(2)}（含做T已实现），实际 ${final}`);
});

test('曲线：止损插针的极值应被捕获（多单取 low，最大浮亏 ≈ 止损亏损）', () => {
  // 复刻 #5581 的止损场景：多单均价 1816.88、仓位 1.0，1784.36 止损成交
  // K 线收盘价 1787.7 高于止损价 → 收盘价取样会低估浮亏（-29），极值取样应 ≈ -32.5
  const t0 = Date.UTC(2026, 11, 16, 6, 37); // 14:37 本地
  const H = 3600_000;
  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'long',
    entry_price: 1816.88, exit_price: 1784.36, size: 1.0,
    open_time: new Date(t0).toISOString(),
    close_time: new Date(t0 + 21 * H).toISOString(),
  };
  const fills = [{ t: t0 + 60_000, side: 'buy', price: 1816.88, qty: 1.0 }];
  // K 线序列：一路阴跌，最后一根插针 low=1784.36（止损成交价）、收盘 1787.7
  const ks = [
    { t: t0 + 60_000, c: 1815, l: 1812, h: 1818 },
    { t: t0 + H, c: 1810, l: 1808, h: 1816 },
    { t: t0 + 2 * H, c: 1805, l: 1802, h: 1808 },
    { t: t0 + 3 * H, c: 1800, l: 1798, h: 1806 },
    { t: t0 + 4 * H, c: 1795, l: 1793, h: 1801 },
    { t: t0 + 5 * H, c: 1790, l: 1788, h: 1796 },
    { t: t0 + 6 * H, c: 1787.7, l: 1784.36, h: 1792 },  // 止损插针在这根
  ];
  const { points, trough, final } = buildCurvePoints({ trade, candles: ks, fills });
  // 收盘价取样最深 = (1787.7-1816.88)*1 = -29.18；极值取样应 ≈ (1784.36-1816.88)*1 = -32.52
  assert.ok(Math.abs(trough + 32.52) < 0.1, `最大浮亏应 ≈ 止损亏损 -32.52，实际 ${trough}`);
  assert.ok(Math.abs(trough + 29.18) > 1, `不应再被收盘价低估（-29.18），实际 ${trough}`);
  // 终点 = 止损成交价 1784.36 × 1.0 = -32.52
  assert.ok(Math.abs(final + 32.52) < 0.1, `final 应为 -32.52，实际 ${final}`);
});

test('曲线：权益语义——中途减仓落袋的亏损必须计入曲线，终点对齐交易所净盈亏', () => {
  // 复刻 #5581：均价 1816.88、仓位 1.0；中途卖出 0.5@1819.48 落袋，随后买回 0.5@1798
  // 最后 1.0@1784.36 止损。用户期望最大浮亏 ≈ 43（含落袋部分）
  const t0 = Date.UTC(2026, 10, 16, 14, 37);
  const H = 3600_000;
  const trade = {
    symbol: 'ETH/USDT', market: 'futures', side: 'long',
    entry_price: 1823.17, exit_price: 1784.36, size: 1.5,
    pnl: -43.01, fee: -2.44, funding: 0.09,
    open_time: new Date(t0).toISOString(),
    close_time: new Date(t0 + 20 * H).toISOString(),
  };
  const fills = [
    { t: t0 + 60_000, side: 'buy', price: 1835.75, qty: 1.0, fee: -1.2 },
    // 做T/减仓 0.5 @1819.48 → 已实现 (1819.48-1835.75)*0.5 = -8.135
    { t: t0 + 11 * H, side: 'sell', price: 1819.48, qty: 0.5, fee: -0.4 },
    // 加仓买回 0.5 @1798 → 仓位 1.0，均价 (1835.75*0.5+1798*0.5)=1816.88
    { t: t0 + 12 * H, side: 'buy', price: 1798, qty: 0.5, fee: -0.18 },
    // 止损平仓 1.0 @1784.36 → 浮亏 (1784.36-1816.88)*1.0 = -32.52
    { t: t0 + 19 * H, side: 'sell', price: 1784.36, qty: 1.0, fee: -0.89 },
  ];
  const ks = [
    { t: t0 + 60_000, c: 1830, l: 1828, h: 1836 },
    { t: t0 + H, c: 1825, l: 1820, h: 1830 },
    { t: t0 + 5 * H, c: 1815, l: 1810, h: 1820 },
    { t: t0 + 11 * H, c: 1819.48, l: 1815, h: 1822 },
    { t: t0 + 12 * H, c: 1798, l: 1795, h: 1802 },
    { t: t0 + 19 * H, c: 1786, l: 1784.36, h: 1790 },
  ];
  const { points, trough, final } = buildCurvePoints({ trade, candles: ks, fills });

  // 止损那根 K 线（low=1784.36）的权益 = 已实现 + 浮亏
  //   已实现 = 手续费(-1.2-0.4-0.18) + 做T(-8.135) = -9.915
  //   浮亏 = (1784.36-1816.88)*1.0 = -32.52
  //   合计 ≈ -42.44（含手续费）—— 用户说的「43 左右」正是这个口径
  const stopPoint = points[points.length - 2]; // 最后一根 K 线
  assert.ok(stopPoint.value < -40, `止损时刻权益应含已实现部分（约 -42），实际 ${stopPoint.value}`);
  assert.ok(stopPoint.value > -46, `止损时刻权益不应超出含费总额（约 -43），实际 ${stopPoint.value}`);
  // 终点用交易所净盈亏
  assert.equal(final, -43.01);
  // 中途减仓落袋后，曲线不能回到 0 附近（旧实现会丢掉落袋部分）
  const afterReduce = points[3];
  assert.ok(afterReduce.value < -5, `减仓后曲线应包含已实现亏损，实际 ${afterReduce.value}`);
});
