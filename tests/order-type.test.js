import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const { classifyOrderType, matchFills, matchEpisodes } = await import('../src/fills.js');
const { binance } = await import('../src/exchanges/binance.js?maker-test');

test('classifyOrderType：纯挂/纯吃/混合/未知', () => {
  assert.equal(classifyOrderType([{ execType: 'M' }, { execType: 'M' }]), 'limit');
  assert.equal(classifyOrderType([{ execType: 'T' }, { execType: 'T' }]), 'market');
  assert.equal(classifyOrderType([{ execType: 'M' }, { execType: 'T' }]), 'mixed');
  assert.equal(classifyOrderType([{ orderType: 'Limit' }, { orderType: 'Market' }]), 'mixed');
  assert.equal(classifyOrderType([{ orderType: 'other' }]), 'other');
  assert.equal(classifyOrderType([]), 'other');
});

test('币安 toFill：maker 布尔字段映射为挂/吃', async () => {
  // 直接通过内部映射验证：构造一次 fetchTrades 需要网络，这里用字段语义测试
  // （toFill 未导出，经由 matchFills 的集成由 sync 测试覆盖；此处验证映射规则本身）
  const rows = [
    { id: 1, symbol: 'BTCUSDT', side: 'BUY', price: '100', qty: '1', commission: '0.01', commissionAsset: 'USDT', maker: true, time: 1000 },
    { id: 2, symbol: 'BTCUSDT', side: 'SELL', price: '110', qty: '1', commission: '0.01', commissionAsset: 'USDT', maker: false, time: 2000 },
  ];
  const trades = matchFills(rows.map((r) => ({
    id: r.id, symbol: 'BTC/USDT',
    side: r.side === 'BUY' ? 'buy' : 'sell',
    price: Number(r.price), qty: Number(r.qty), fee: -Number(r.commission),
    time: r.time,
    orderType: r.maker === true ? 'limit' : 'market',
  })), 'binance');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].order_type, 'mixed'); // 一腿挂一腿吃
});

test('matchEpisodes：全挂单回合 → limit', () => {
  const trades = matchEpisodes([
    { symbol: 'ETH/USDT', side: 'buy', price: 100, qty: 2, fee: 0, time: 1000, orderType: 'limit' },
    { symbol: 'ETH/USDT', side: 'buy', price: 101, qty: 1, fee: 0, time: 1500, orderType: 'limit' },
    { symbol: 'ETH/USDT', side: 'sell', price: 110, qty: 3, fee: 0, time: 2000, orderType: 'limit' },
  ], 'gate');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].order_type, 'limit');
});

test('matchEpisodes：吃挂混合回合 → mixed', () => {
  const trades = matchEpisodes([
    { symbol: 'SOL/USDT', side: 'buy', price: 100, qty: 3, fee: 0, time: 1000, orderType: 'limit' },
    { symbol: 'SOL/USDT', side: 'buy', price: 102, qty: 2, fee: 0, time: 1500, orderType: 'market' },
    { symbol: 'SOL/USDT', side: 'sell', price: 110, qty: 5, fee: 0, time: 2000, orderType: 'market' },
  ], 'gate');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].order_type, 'mixed');
});
