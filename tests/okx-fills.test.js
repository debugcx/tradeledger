import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const queries = [];

// BTC-USDT-SWAP：面值 0.01 BTC/张；两笔成交（先买后卖），倒序返回
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/v5/public/instruments') {
    res.end(JSON.stringify({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01' }] }));
    return;
  }
  if (url.pathname === '/api/v5/trade/fills-history') {
    res.end(JSON.stringify({
      code: '0',
      data: [
        { billId: 'b2', ts: '20000', side: 'sell', fillPx: '101', fillSz: '3', fee: '-0.02', feeCcy: 'USDT' },
        { billId: 'b1', ts: '10000', side: 'buy', fillPx: '100', fillSz: '2', fee: '-0.01', feeCcy: 'USDT' },
      ],
    }));
    return;
  }
  res.end(JSON.stringify({ code: '0', data: [] }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-fills-test');

test('OKX fetchEpisodeFills：张数按面值换算成币、升序、缓存复用', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
    const res = await okx.fetchEpisodeFills({
      creds, symbol: 'BTC/USDT', market: 'futures', fromMs: 0, toMs: 30_000,
    });
    assert.equal(queries[0].path, '/api/v5/public/instruments');
    assert.equal(queries[0].instId, 'BTC-USDT-SWAP');
    assert.equal(queries[1].path, '/api/v5/trade/fills-history');
    assert.equal(queries[1].instType, 'SWAP');

    assert.equal(res.fills.length, 2);
    assert.equal(res.fills[0].t, 10_000); // 升序
    assert.equal(res.fills[0].side, 'buy');
    assert.equal(res.fills[0].qty, 0.02); // 2 张 × 0.01 BTC
    assert.equal(res.fills[0].fee, -0.01);
    assert.equal(res.fills[1].qty, 0.03); // 3 张 × 0.01 BTC

    // 相同窗口命中缓存：不再发请求（请求计数不变）
    const again = await okx.fetchEpisodeFills({
      creds, symbol: 'BTC/USDT', market: 'futures', fromMs: 0, toMs: 30_000,
    });
    assert.equal(again.fills.length, 2);
    assert.equal(queries.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
