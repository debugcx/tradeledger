import test from 'node:test';
import assert from 'node:assert/strict';

const { toTrade } = await import('../src/exchanges/okx.js');

const base = {
  posId: 'p1',
  openTime: String(Date.UTC(2026, 4, 1, 0, 0, 0)),
  closeTime: String(Date.UTC(2026, 4, 2, 0, 0, 0)),
  posSide: 'long',
  openMaxPos: '200',
  liqPenalty: '0',
};

test('OKX 币本位：以币计价的盈亏/手续费/资金费按平仓价折算成 USD', () => {
  const t = toTrade({
    ...base,
    instId: 'BTC-USD-SWAP',
    openAvgPx: '100000',
    closeAvgPx: '110000',
    realizedPnl: '0.0018',
    fee: '-0.0002',
    fundingFee: '-0.00001',
  });
  assert.equal(t.symbol, 'BTC/USD');
  assert.equal(t.side, 'long');
  // 0.0018 BTC × 110000 = 198 USD
  assert.ok(Math.abs(t.pnl - 198) < 1e-9, `pnl=${t.pnl}`);
  // -0.0002 BTC × 110000 = -22 USD
  assert.ok(Math.abs(t.fee + 22) < 1e-9, `fee=${t.fee}`);
  assert.ok(Math.abs(t.funding + 1.1) < 1e-9, `funding=${t.funding}`);
  // 毛盈亏 221.1 USD ÷ 价差 10000 = 0.02211 BTC 仓位
  assert.ok(Math.abs(t.size - 0.02211) < 1e-9, `size=${t.size}`);
  assert.ok(Math.abs(t.notional - 2211) < 1e-6, `notional=${t.notional}`);
});

test('OKX U 本位：金额保持原样（不再二次换算）', () => {
  const t = toTrade({
    ...base,
    instId: 'BTC-USDT-SWAP',
    openAvgPx: '100000',
    closeAvgPx: '110000',
    realizedPnl: '100',
    fee: '-2',
    fundingFee: '-0.5',
  });
  assert.equal(t.symbol, 'BTC/USDT');
  assert.equal(t.pnl, 100);
  assert.equal(t.fee, -2);
  assert.equal(t.funding, -0.5);
});
