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

test('交易列表：币本位行渲染币口径且不报错', async () => {
  const { journalPage } = await import('../src/views/journal.js');
  const html = journalPage({
    user: { username: 'u' },
    trades: [{
      id: 1, symbol: 'BTC/USD', market: 'futures', side: 'long',
      pnl: 0.8089, exit_price: 77227.3, entry_price: 76555, size: 0.001306, notional: 100,
      open_time: '2026-11-03T00:07:00.000Z', close_time: '2026-11-03T14:39:00.000Z',
      order_type: 'other', tags: [], account_name: 'Binance', source: 'api', kind: null,
    }],
    filters: {
      account_id: 'all', market: 'all', side: 'all', result: 'all', symbol: 'BTC/USD',
      orderType: 'all', tag: '', note: 'all', from: '', to: '', q: '', sort: 'time',
    },
    tags: [], symbols: ['BTC/USD'],
    pagination: { page: 1, totalPages: 1, total: 1, pageSize: 50 },
    noteCoverage: null,
    accounts: [],
  });
  assert.match(html, /BTC\/USD/);
  assert.match(html, /币本位/);
  assert.match(html, /pnl-cell/);
  assert.match(html, /journal-table/);
  // 响应式：低优先级列带可隐藏类名
  for (const cls of ['col-type', 'col-duration', 'col-tags', 'col-review', 'col-notional']) {
    assert.match(html, new RegExp(`class="[^"]*${cls}`));
  }
  assert.match(html, /BTC/);
});

test('列表紧凑金额：宽度有界，极小值用科学计数法', async () => {
  const { fmtCoinShort } = await import('../src/views/journal.js');
  assert.equal(fmtCoinShort(0), '0');
  assert.equal(fmtCoinShort(0.00012369), '+0.00012369');
  assert.equal(fmtCoinShort(-0.00012369), '-0.00012369');
  assert.equal(fmtCoinShort(0.00003524), '+0.00003524');
  assert.equal(fmtCoinShort(1.2345), '+1.2345');
  assert.equal(fmtCoinShort(12345.678), '+12,345.68');
  assert.equal(fmtCoinShort(1.2345e-9), '+1.23e-9');
  assert.equal(fmtCoinShort(-1.2345e-9), '-1.23e-9');
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
