import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

// 同一 posId 的两个独立回合 + 一条无 posId 的回退行
const rows = [
  {
    instId: 'BTC-USDT-SWAP', posId: '111', posSide: 'long', type: '2',
    openTime: '5000', closeTime: '6000', uTime: '6000',
    openAvgPx: '100', closeAvgPx: '110', openMaxPos: '1', closeTotalPos: '1',
    realizedPnl: '10', fee: '-0.1', fundingFee: '0', liqPenalty: '0',
  },
  {
    instId: 'BTC-USDT-SWAP', posId: '111', posSide: 'long', type: '2',
    openTime: '2000', closeTime: '3000', uTime: '3000',
    openAvgPx: '90', closeAvgPx: '95', openMaxPos: '2', closeTotalPos: '2',
    realizedPnl: '9', fee: '-0.2', fundingFee: '0', liqPenalty: '0',
  },
  {
    instId: 'ETH-USDT-SWAP', posSide: 'long', type: '2',
    openTime: '1500', closeTime: '1600', uTime: '1600',
    openAvgPx: '50', closeAvgPx: '55', openMaxPos: '3', closeTotalPos: '3',
    realizedPnl: '15', fee: '-0.3', fundingFee: '0', liqPenalty: '0',
  },
];

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: '0', data: rows }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-trade-id-test');

test('OKX 交易外部 ID：posId+开仓毫秒，同 posId 的兄弟回合不再撞车', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
    const result = await okx.fetchTrades({ creds, fromMs: 0, toMs: 9999, cursor: null, limit: 100 });
    assert.equal(result.trades.length, 3);
    const ids = result.trades.map((t) => t.external_id).sort();
    assert.deepEqual(ids, [
      'okx:111:2000',
      'okx:111:5000',
      'okx:ETH-USDT-SWAP:1500:1600', // 无 posId 时保持回退格式
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
