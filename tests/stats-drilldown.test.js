import test from 'node:test';
import assert from 'node:assert/strict';

const stats = await import('../src/stats.js');

const mk = (close, pnl) => ({
  symbol: 'BTC/USDT', side: 'long', market: 'futures', notional: 100,
  open_time: close, close_time: close, pnl, fee: 0, funding: 0,
});

test('analyze：最大回撤窗口 = 峰值日 → 谷底日，窗口含期间平仓的交易', () => {
  const trades = [
    mk('2026-05-01T10:00:00Z', 100),  // 峰值日 05-01（累计 100）
    mk('2026-05-02T10:00:00Z', -40),
    mk('2026-05-02T11:00:00Z', -30),  // 05-02 合计 -70
    mk('2026-05-03T10:00:00Z', -40),  // 谷底日 05-03（累计 -10，回撤 110）
    mk('2026-05-04T10:00:00Z', 200),  // 创新高，不属于窗口
  ];
  const s = stats.analyze(trades);
  assert.equal(s.drawdown.maxDrawdown, 110);
  assert.ok(s.drawdown.window, '应记录回撤窗口');
  assert.equal(s.drawdown.window.from, '2026-05-01');
  assert.equal(s.drawdown.window.to, '2026-05-03');
  assert.equal(s.drawdown.window.trades.length, 4);
  // 窗口外的交易不在其中
  assert.ok(!s.drawdown.window.trades.some((t) => t.close_time.startsWith('2026-05-04')));
});

test('analyze：峰值日取最后一次触及峰值的那天；开局即亏损时窗口从第一天起算', () => {
  const trades = [
    mk('2026-06-01T10:00:00Z', 50),
    mk('2026-06-02T10:00:00Z', 50),  // 累计回到 100，峰值日应为 06-02
    mk('2026-06-03T10:00:00Z', -60),
    mk('2026-06-04T10:00:00Z', -30), // 谷底（回撤 90）
  ];
  const s = stats.analyze(trades);
  assert.equal(s.drawdown.maxDrawdown, 90);
  assert.equal(s.drawdown.window.from, '2026-06-02');

  const allLoss = [mk('2026-06-01T10:00:00Z', -10), mk('2026-06-02T10:00:00Z', -20)];
  const s2 = stats.analyze(allLoss);
  assert.equal(s2.drawdown.maxDrawdown, 30);
  assert.equal(s2.drawdown.window.from, '2026-06-01', '从第一个交易日（0 基准峰值）起算');
  assert.equal(s2.drawdown.window.to, '2026-06-02');
  assert.equal(s2.drawdown.window.trades.length, 2);
});

test('analyze：没有回撤（一路盈利）时 window 为 null', () => {
  const s = stats.analyze([mk('2026-06-01T10:00:00Z', 10), mk('2026-06-02T10:00:00Z', 20)]);
  assert.equal(s.drawdown.maxDrawdown, 0);
  assert.equal(s.drawdown.window, null);
});

test('analyze：最差 5% 明细 = 亏损最重的 ceil(5%) 笔，从重到轻', () => {
  const trades = [];
  for (let i = 0; i < 21; i++) trades.push(mk(`2026-07-01T00:${String(i).padStart(2, '0')}:00Z`, -(i + 1)));
  trades.push(mk('2026-07-02T00:00:00Z', 50));
  const s = stats.analyze(trades);
  assert.equal(s.behavior.bigLossCount, 2); // ceil(21 × 0.05)
  assert.deepEqual(s.behavior.bigLossTrades.map((t) => t.pnl), [-21, -20]);
  // 盈利单不进最差名单
  assert.ok(!s.behavior.bigLossTrades.some((t) => t.pnl > 0));
});

test('analyze：最大连亏的交易明细，并列时取先出现的一段', () => {
  const trades = [
    mk('2026-08-01T00:00:00Z', -5),
    mk('2026-08-02T00:00:00Z', 10),
    mk('2026-08-03T00:00:00Z', -1),  // 最长连亏从这三笔开始
    mk('2026-08-04T00:00:00Z', -2),
    mk('2026-08-05T00:00:00Z', -3),
    mk('2026-08-06T00:00:00Z', 20),
    mk('2026-08-07T00:00:00Z', -9),
  ];
  const s = stats.analyze(trades);
  assert.equal(s.maxConsecutiveLoss, 3);
  assert.deepEqual(s.maxLossStreakTrades.map((t) => t.pnl), [-1, -2, -3]);

  const tied = [
    mk('2026-08-01T00:00:00Z', -1), mk('2026-08-02T00:00:00Z', -2), mk('2026-08-03T00:00:00Z', 10),
    mk('2026-08-04T00:00:00Z', -7), mk('2026-08-05T00:00:00Z', -8), mk('2026-08-06T00:00:00Z', 10),
  ];
  const s2 = stats.analyze(tied);
  assert.equal(s2.maxConsecutiveLoss, 2);
  assert.deepEqual(s2.maxLossStreakTrades.map((t) => t.pnl), [-1, -2], '并列时取先出现的那段');
});
