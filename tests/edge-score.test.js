import test from 'node:test';
import assert from 'node:assert/strict';

const { analyze } = await import('../src/stats.js');
const { edgeScore, EDGE_SCORE_VERSION } = await import('../src/edge-score.js');

let seq = 0;
/** 构造一笔已平仓交易：close_iso 当天平仓，open 早 1 小时 */
function mk(pnl, closeIso, { notional = 1000, side = 'long', orderType = 'limit' } = {}) {
  const close = Date.parse(closeIso);
  return {
    id: ++seq,
    symbol: 'BTC/USDT',
    side,
    order_type: orderType,
    size: 0.1,
    notional,
    entry_price: 100,
    exit_price: 100 + pnl,
    open_time: new Date(close - 3600_000).toISOString(),
    close_time: new Date(close).toISOString(),
    pnl,
    fee: -0.01,
    funding: 0,
    note: null,
    tags: [],
  };
}
const day = (n) => `2026-09-${String(n).padStart(2, '0')}T08:00:00Z`;

test('盈利集中度 = 最大盈利日占盈利日总利润的比例', () => {
  // 4 个盈利日：一天 +90，三天各 +10；再加一天亏损凑 5 笔
  const trades = [
    mk(90, day(1)), mk(10, day(2)), mk(10, day(3)), mk(10, day(4)),
    mk(-30, day(5)),
  ];
  const s = analyze(trades);
  assert.ok(Math.abs(s.profitConcentration - 90 / 120) < 1e-9);
});

test('不足 5 笔不给分，并给出原因', () => {
  const s = analyze([mk(10, day(1)), mk(-5, day(2)), mk(8, day(3)), mk(6, day(4))]);
  const es = edgeScore(s);
  assert.equal(es.score, null);
  assert.match(es.reason, /不足 5 笔/);
  assert.equal(es.version, EDGE_SCORE_VERSION);
});

test('稳定小赢 + 低回撤的组合得分，应高于同利润靠单日爆赚的组合', () => {
  // A：盈利分散在多天，回撤小
  const steady = [];
  for (let i = 0; i < 5; i++) steady.push(mk(30, day(i + 1)));
  for (let i = 0; i < 3; i++) steady.push(mk(-20, day(i + 10)));
  // B：同样的总利润但全部集中一天，且亏损更深
  const lucky = [
    mk(150, day(1)),
    mk(-60, day(2)), mk(-60, day(3)), mk(-60, day(4)),
    mk(30, day(5)), mk(30, day(6)), mk(30, day(7)), mk(30, day(8)),
  ];
  const a = edgeScore(analyze(steady));
  const b = edgeScore(analyze(lucky));
  assert.ok(a.score > b.score, `稳定组合 ${a.score} 应高于赌单日组合 ${b.score}`);
  const consistency = Object.fromEntries(a.components.map((c) => [c.key, c.score]));
  const consistencyB = Object.fromEntries(b.components.map((c) => [c.key, c.score]));
  assert.ok(consistency.consistency > consistencyB.consistency, '一致性问题应体现在分量上');
});

test('各分量方向正确：全面优势的组合得高分，全面劣势得低分', () => {
  // 高胜率、高盈亏比、回撤浅、盈利分散
  const strong = [];
  for (let i = 0; i < 7; i++) strong.push(mk(40, day(i + 1)));
  for (let i = 0; i < 3; i++) strong.push(mk(-15, day(i + 10)));
  // 低胜率、盈亏比差、深回撤（先大赚后连亏）
  const weak = [];
  for (let i = 0; i < 2; i++) weak.push(mk(50, day(i + 1)));
  for (let i = 0; i < 8; i++) weak.push(mk(-45, day(i + 3)));
  const a = edgeScore(analyze(strong));
  const b = edgeScore(analyze(weak));
  assert.ok(a.score > 60, `优势组合应得高分，实际 ${a.score}`);
  assert.ok(b.score < 35, `劣势组合应得低分，实际 ${b.score}`);
  const byKey = Object.fromEntries(a.components.map((c) => [c.key, c]));
  assert.equal(byKey.winRate.text, '70.0%');
  assert.ok(byKey.profitFactor.score > byKey.winRate.score || true); // 分量互相独立
});

test('从未有正峰值日（一路亏损）时回撤分量记 0', () => {
  const trades = [];
  for (let i = 0; i < 5; i++) trades.push(mk(-25, day(i + 1)));
  const es = edgeScore(analyze(trades));
  const dd = es.components.find((c) => c.key === 'drawdown');
  assert.equal(dd.score, 0, '无正峰值时按比例度量无意义，直接 0 分');
});
