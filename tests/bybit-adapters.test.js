import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
let failEarn = false;
let includeInverse = false;

const send = (res, result, retCode = 0, retMsg = 'OK') => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ retCode, retMsg, result }));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/v5/account/wallet-balance') {
    return send(res, { list: [{ totalEquity: '1000', coin: [
      { coin: 'BTC', equity: '1.5', walletBalance: '1.5' },
      { coin: 'USDT', equity: '1000', walletBalance: '1000' },
    ] }] });
  }

  if (p === '/v5/execution/list') {
    const category = url.searchParams.get('category');
    const cursor = url.searchParams.get('cursor') || '';
    if (category === 'linear') {
      const buy = {
        execId: 'b1', symbol: 'BTCUSDT', side: 'Buy', execPrice: '100', execQty: '1',
        execFee: '0', execTime: String(T0), orderType: 'Limit',
      };
      const sell = {
        execId: 's1', symbol: 'BTCUSDT', side: 'Sell', execPrice: '110', execQty: '1',
        execFee: '0', execTime: String(T0 + 60_000), orderType: 'Market',
      };
      return cursor
        ? send(res, { list: [sell], nextPageCursor: '' })
        : send(res, { list: [buy], nextPageCursor: 'page2' });
    }
    if (category === 'inverse') {
      if (!includeInverse) return send(res, { list: [], nextPageCursor: '' });
      return send(res, { list: [
        { execId: 'i1', symbol: 'BTCUSD', side: 'Buy', execPrice: '100', execQty: '100', execFee: '0', execTime: String(T0) },
        { execId: 'i2', symbol: 'BTCUSD', side: 'Sell', execPrice: '110', execQty: '100', execFee: '0', execTime: String(T0 + 60_000) },
      ], nextPageCursor: '' });
    }
    return send(res, { list: [
      { execId: 'sp1', symbol: 'ETHUSDT', side: 'Buy', execPrice: '2000', execQty: '0.5', execFee: '1', feeCurrency: 'USDT', execTime: String(T0) },
      { execId: 'sp2', symbol: 'ETHUSDT', side: 'Sell', execPrice: '2100', execQty: '0.5', execFee: '1', feeCurrency: 'USDT', execTime: String(T0 + 60_000) },
    ], nextPageCursor: '' });
  }

  if (p === '/v5/asset/transfer/query-account-coins-balance') {
    return send(res, { balance: [{ coin: 'USDT', walletBalance: '500' }] });
  }

  if (p === '/v5/earn/position') {
    if (failEarn) return send(res, {}, 10001, 'earn unavailable');
    return send(res, { list: [
      { coin: 'ETH', amount: '2', category: 'FlexibleSaving' },
      { coin: 'SOL', amount: '3', category: 'OnChain' },
    ] });
  }

  if (p === '/v5/asset/deposit/query-record') {
    return send(res, { rows: [{
      id: 'd1', coin: 'USDT', amount: '100', fee: '0', updatedTime: String(T0),
      txID: 'tx1', chain: 'ETH', toAddress: '0xabc', status: 'success',
    }], nextPageCursor: '' });
  }

  if (p === '/v5/asset/withdraw/query-record') {
    return send(res, { rows: [{
      withdrawId: 'w1', coin: 'USDT', amount: '50', fee: '1', updatedTime: String(T0),
      txID: 'tx2', chain: 'ETH', status: 'success',
    }], nextPageCursor: '' });
  }

  return send(res, {}, 10000, `unexpected ${p}`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.BYBIT_API_BASE = `http://127.0.0.1:${port}`;
const { bybit } = await import('../src/exchanges/bybit.js?bybit-test');

const creds = { apiKey: 'test-key', apiSecret: 'test-secret' };
const fromMs = T0 - 3600_000;
const toMs = T0 + 3600_000;

test('verify：返回统一账户权益', async () => {
  const out = await bybit.verify(creds);
  assert.equal(out.detail, '1000');
});

test('fetchTrades：cursor 翻页 + 多空配对 + 字段归一', async () => {
  const out = await bybit.fetchTrades({ creds, fromMs, toMs, limit: 1000, windowBudget: 8 });
  assert.equal(out.fills.length, 2);
  assert.deepEqual(out.fills.map((f) => f.id), ['b1', 's1']);
  assert.equal(out.fills[0].symbol, 'BTC/USDT');
  assert.equal(out.fills[0].side, 'buy');
  assert.equal(out.fills[1].side, 'sell');
  assert.equal(out.nextCursor, null);
  assert.equal(out.trades.length, 1);
  assert.equal(out.trades[0].side, 'long');
  assert.equal(out.trades[0].entry_price, 100);
  assert.equal(out.trades[0].exit_price, 110);
  assert.equal(out.trades[0].pnl, 10);
});

test('fetchTrades：币本位 inverse 按张配对，盈亏按美元名义额折算', async () => {
  includeInverse = true;
  try {
    const out = await bybit.fetchTrades({ creds, fromMs, toMs, limit: 1000, windowBudget: 8 });
    const invFills = out.fills.filter((f) => f.symbol === 'BTC/USD');
    assert.equal(invFills.length, 2);
    assert.ok(invFills.every((f) => f.contractValue === 1));
    assert.deepEqual(invFills.map((f) => f.id), ['inverse:i1', 'inverse:i2']);
    const t = out.trades.find((x) => x.symbol === 'BTC/USD');
    assert.ok(t, '应产出 BTC/USD 回合');
    assert.equal(t.side, 'long');
    assert.equal(t.entry_price, 100);
    assert.equal(t.exit_price, 110);
    // 100 张 × 1 USD 面值 × (110−100)/100 = 10 USD
    assert.equal(t.pnl, 10);
    // 展示口径：币数量 = 100 张 × 1 USD ÷ 100 = 1 BTC；名义额 100 USD
    assert.equal(t.size, 1);
    assert.equal(t.notional, 100);
  } finally {
    includeInverse = false;
  }
});

test('fetchSpotTrades：手续费符号归一', async () => {
  const out = await bybit.fetchSpotTrades({ creds, fromMs, toMs, limit: 1000 });
  assert.equal(out.fills.length, 2);
  assert.equal(out.fills[0].symbol, 'ETH/USDT');
  assert.equal(out.fills[0].fee, -1);
  assert.equal(out.fills[1].fee, -1);
});

test('fetchTransfers：充提映射', async () => {
  const out = await bybit.fetchTransfers({ creds, fromMs, toMs, limit: 100 });
  assert.equal(out.transfers.length, 2);
  const dep = out.transfers.find((t) => t.type === 'deposit');
  const wd = out.transfers.find((t) => t.type === 'withdraw');
  assert.equal(dep.external_id, 'bybit:dep:d1');
  assert.equal(dep.asset, 'USDT');
  assert.equal(dep.amount, 100);
  assert.equal(wd.external_id, 'bybit:wd:w1');
  assert.equal(wd.fee, 1);
});

test('fetchAssetPositions：交易/资金/Earn 分桶', async () => {
  failEarn = false;
  const out = await bybit.fetchAssetPositions(creds);
  assert.equal(out.errors.length, 0);
  assert.deepEqual(out.buckets.sort(), ['earn_flexible', 'earn_locked', 'funding', 'staking', 'trading']);
  assert.equal(out.positions.find((p) => p.asset === 'BTC').bucket, 'trading');
  assert.equal(out.positions.find((p) => p.asset === 'USDT' && p.bucket === 'funding').amount, 500);
  assert.equal(out.positions.find((p) => p.asset === 'ETH').bucket, 'earn_flexible');
  assert.equal(out.positions.find((p) => p.asset === 'SOL').bucket, 'staking');
});

test('fetchAssetPositions：Earn 失败不影响交易/资金桶', async () => {
  failEarn = true;
  try {
    const out = await bybit.fetchAssetPositions(creds);
    assert.ok(out.errors.some((e) => e.includes('Bybit Earn')), out.errors.join(' | '));
    assert.ok(out.positions.some((p) => p.bucket === 'trading'));
    assert.ok(out.positions.some((p) => p.bucket === 'funding'));
  } finally {
    failEarn = false;
  }
});

test.after(() => {
  server.close();
});
