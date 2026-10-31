import test from 'node:test';
import assert from 'node:assert/strict';

const { summarizeHoldingCandles } = await import('../src/trade-context.js');

const candles = [
  { t: 1, o: 100, h: 102, l: 99, c: 101 },
  { t: 2, o: 101, h: 110, l: 100, c: 108 },
  { t: 3, o: 108, h: 109, l: 95, c: 97 },
  { t: 4, o: 97, h: 99, l: 96, c: 98 },
];
const base = { candles, bar: '15m', entry: 100, exit: 98, openMs: 0, closeMs: 4 };

test('做多：最大浮盈/浮亏与振幅按开仓价折算', () => {
  const s = summarizeHoldingCandles({ ...base, side: 'long' });
  assert.equal(s.count, 4);
  assert.equal(s.high, 110);
  assert.equal(s.low, 95);
  assert.ok(Math.abs(s.favorPct - 10) < 1e-9);
  assert.ok(Math.abs(s.adversePct - 5) < 1e-9);
  assert.ok(Math.abs(s.rangePct - 15) < 1e-9);
  assert.ok(Math.abs(s.exitPct - -2) < 1e-9);
  assert.equal(s.path.length, 4);
  assert.ok(Math.abs(s.path[s.path.length - 1].pct - -2) < 1e-9);
});

test('做空：有利/不利方向相反', () => {
  const s = summarizeHoldingCandles({ ...base, side: 'short' });
  assert.ok(Math.abs(s.favorPct - 5) < 1e-9);   // 最低 95，空单浮盈 5%
  assert.ok(Math.abs(s.adversePct - 10) < 1e-9); // 最高 110，空单浮亏 10%
  assert.equal(s.path[s.path.length - 1].pct, 2); // 平仓 98，空单 +2%
});

test('数据不足时返回 null', () => {
  assert.equal(summarizeHoldingCandles({ candles: [], entry: 100 }), null);
  assert.equal(summarizeHoldingCandles({ candles: candles.slice(0, 1), entry: 100 }), null);
  assert.equal(summarizeHoldingCandles({ candles, entry: 0 }), null);
});
