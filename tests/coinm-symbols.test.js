import test from 'node:test';
import assert from 'node:assert/strict';

const {
  toCoinSymbol, toSymbol, parseStreamCursor, encodeStreamCursor, cursorWatermark,
} = await import('../src/exchanges/common.js');

test('币本位合约名归一化', () => {
  assert.equal(toCoinSymbol('BTCUSD_PERP'), 'BTC/USD');
  assert.equal(toCoinSymbol('ETHUSD_PERP'), 'ETH/USD');
  assert.equal(toCoinSymbol('BTCUSD_240628'), 'BTC/USD');
  assert.equal(toCoinSymbol('BTC_USD'), 'BTC/USD');
  assert.equal(toCoinSymbol('BTCUSD'), 'BTC/USD');
  // 线性合约不受影响
  assert.equal(toCoinSymbol('BTC_USDT'), 'BTC/USDT');
  assert.equal(toSymbol('BTC_USDT'), 'BTC/USDT');
  assert.equal(toSymbol('BTC-USD-SWAP'), 'BTC/USD');
});

test('组合游标：旧版纯数字游标视为第 0 通道', () => {
  assert.deepEqual(parseStreamCursor(null), { index: 0, inner: null });
  assert.deepEqual(parseStreamCursor('1794296000000'), { index: 0, inner: '1794296000000' });
  assert.deepEqual(parseStreamCursor('1|1794296000000'), { index: 1, inner: '1794296000000' });
});

test('组合游标编解码与水位提取', () => {
  assert.equal(encodeStreamCursor(0, null), null);
  assert.equal(encodeStreamCursor(0, '1000'), '0|1000');
  assert.equal(encodeStreamCursor(1, '2000'), '1|2000');
  assert.equal(cursorWatermark('1|2000'), 2000);
  assert.equal(cursorWatermark('2000'), 2000);
  assert.equal(cursorWatermark(null, 42), 42);
});

test('交易详情：币本位金额按平仓价折回结算币', async () => {
  const { coinMarginedAmounts, inverseFillQty } = await import('../src/views/journal.js');
  const coin = coinMarginedAmounts({
    symbol: 'BTC/USD', market: 'futures', pnl: 0.8089, fee: -0.0693, funding: 0, exit_price: 77227.3,
  });
  assert.equal(coin.base, 'BTC');
  assert.ok(Math.abs(coin.pnl - 0.8089 / 77227.3) < 1e-12);
  assert.ok(Math.abs(coin.fee - (-0.0693 / 77227.3)) < 1e-12);
  assert.equal(coinMarginedAmounts({ symbol: 'BTC/USDT', market: 'futures', pnl: 1, exit_price: 100 }), null);
  assert.equal(coinMarginedAmounts({ symbol: 'BTC/USD', market: 'spot', pnl: 1, exit_price: 100 }), null);
  assert.equal(coinMarginedAmounts({ symbol: 'BTC/USD', market: 'futures', pnl: 1, exit_price: 0 }), null);

  // 成交数量：张数 × 美元面值 ÷ 成交价 = 币数量；线性成交原样返回
  assert.ok(Math.abs(inverseFillQty({ qty: 1, price: 76555, contractValue: 100 }) - 100 / 76555) < 1e-12);
  assert.ok(Math.abs(inverseFillQty({ qty: 4, price: 74176.4, contractValue: 100 }) - 400 / 74176.4) < 1e-12);
  assert.equal(inverseFillQty({ qty: 2, price: 700, contractValue: 0 }), 2);
});
