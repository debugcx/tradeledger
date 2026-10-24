import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

// 合约网格 + 现货网格各一条已结束记录；窗口外的应被过滤
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  res.setHeader('content-type', 'application/json');
  const rows = q.algoOrdType === 'contract_grid'
    ? [
      { algoId: '1001', instId: 'CL-USDT-SWAP', instType: 'SWAP', direction: 'long',
        gridNum: '10', arbitrageNum: '25', gridProfit: '3.5', floatProfit: '-1.2', totalPnl: '2.3',
        fee: '-0.8', fundingFee: '-0.1', investment: '200',
        cTime: '1792173018475', uTime: '1792400000000', state: '2' },
      { algoId: '999', instId: 'OLD-USDT-SWAP', instType: 'SWAP', direction: 'long',
        gridNum: '5', arbitrageNum: '1', gridProfit: '0', floatProfit: '0', totalPnl: '0',
        fee: '0', fundingFee: '0', investment: '10', cTime: '1', uTime: '2', state: '2' },
    ]
    : q.algoOrdType === 'grid'
      ? [{ algoId: '2001', instId: 'BTC-USDT', instType: 'SPOT', direction: 'neutral',
        gridNum: '20', arbitrageNum: '6', gridProfit: '1.0', floatProfit: '0.1', totalPnl: '1.1',
        fee: '-0.2', fundingFee: '0', investment: '500',
        cTime: '1792100000000', uTime: '1792300000000', state: '2' }]
      : [];
  res.end(JSON.stringify({ code: '0', data: rows }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-bots-test');

test('OKX fetchBots：网格机器人映射为交易记录，窗口外过滤', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
    const res = await okx.fetchBots({ creds, fromMs: 1_790_000_000_000, toMs: 1_793_000_000_000, limit: 100 });
    assert.equal(res.trades.length, 2); // 窗口外的 algoId 999 被过滤

    const contract = res.trades.find((t) => t.external_id === 'okx:grid:1001');
    assert.ok(contract);
    assert.equal(contract.symbol, 'CL/USDT');
    assert.equal(contract.market, 'futures');
    assert.equal(contract.side, 'long');
    assert.equal(contract.pnl, 2.3);
    assert.equal(contract.fee, -0.8);
    assert.equal(contract.funding, -0.1);
    assert.equal(contract.notional, 200);
    assert.equal(contract.open_time, new Date(1792173018475).toISOString());
    assert.deepEqual(contract.tags, ['策略机器人']);
    assert.ok(contract.note.includes('套利 25 次'));
    assert.ok(contract.note.includes('合约网格'));

    const spot = res.trades.find((t) => t.external_id === 'okx:grid:2001');
    assert.ok(spot);
    assert.equal(spot.symbol, 'BTC/USDT');
    assert.equal(spot.market, 'spot');
    assert.equal(spot.side, 'long'); // 中性网格按 long 记
    assert.equal(spot.pnl, 1.1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
