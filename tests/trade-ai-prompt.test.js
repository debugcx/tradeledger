import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { buildTradeReviewPrompt } = await import('../src/llm.js');

const trade = {
  id: 1, symbol: 'BTC/USDT', side: 'long', market: 'futures', order_type: 'mixed',
  size: 0.5, notional: 30000, entry_price: 60000, exit_price: 61000,
  open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-01T06:00:00.000Z',
  pnl: 480, fee: -20, funding: -2, account_name: 'OKX 主账户', account_exchange: 'okx',
  source: 'api', tags: ['突破', '计划内'], note: '按计划执行',
};

test('单笔交易 AI 复盘提示词：包含关键数据与输出约束', () => {
  const p = buildTradeReviewPrompt(trade, {
    breakdown: { gross: 500, pricePnl: 500, priceMatch: true },
    fills: [{ orderType: 'limit' }, { orderType: 'market', execType: 'T' }, { execType: 'M' }],
  });
  for (const needle of [
    'BTC/USDT', '做多', '60000.000000', '净盈亏 480.00', '混合（吃挂均有）',
    '挂单 2 笔 / 吃单 1 笔', '突破、计划内', '按计划执行', '一句话结论', '400 字以内',
  ]) {
    assert.ok(p.includes(needle), `缺少「${needle}」`);
  }
  assert.ok(!p.includes('undefined') && !p.includes('NaN'));
});

test('缺字段时不产生 undefined/NaN，方向标签正确', () => {
  const p = buildTradeReviewPrompt({ symbol: 'ETH/USDT', side: 'short' }, {});
  assert.ok(!p.includes('undefined') && !p.includes('NaN'));
  assert.ok(p.includes('做空'));
});

test('附带持有期行情时：提示词包含走势摘要与离场时机要求', () => {
  const market = {
    bar: '15m', count: 24, high: 110, low: 95, rangePct: 15,
    favorPct: 10, adversePct: 5, exitPct: -2, spanMs: 6 * 3600_000,
    path: [{ pct: 1 }, { pct: 5 }, { pct: -2 }],
  };
  const p = buildTradeReviewPrompt(trade, { market });
  assert.ok(p.includes('持有期行情'));
  assert.ok(p.includes('最大浮盈 +10.00%'));
  assert.ok(p.includes('最大浮亏 -5.00%'));
  assert.ok(p.includes('+1.00% → +5.00% → -2.00%'));
  assert.ok(p.includes('离场时机'));
});

test('没有行情数据时不出现该段', () => {
  const p = buildTradeReviewPrompt(trade, {});
  assert.ok(!p.includes('持有期行情'));
  assert.ok(!p.includes('离场时机'));
});
