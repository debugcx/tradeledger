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
