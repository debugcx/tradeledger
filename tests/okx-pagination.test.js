import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const queries = [];
let calls = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  queries.push(Object.fromEntries(url.searchParams));
  calls++;
  res.setHeader('content-type', 'application/json');
  if (calls === 1) {
    // 100 行触发分页；最后一行的 uTime 是 2010，下一页游标应为 2011
    const rows = Array.from({ length: 100 }, (_, i) => ({
      instId: 'BTC-USDT-SWAP',
      posId: `p${i}`,
      posSide: 'long',
      openTime: String(2000 - i * 10),
      closeTime: String(3000 - i * 10),
      uTime: String(3000 - i * 10),
      openAvgPx: '100',
      closeAvgPx: '101',
      openMaxPos: '1',
      realizedPnl: '1',
      fee: '-0.1',
      fundingFee: '0',
    }));
    res.end(JSON.stringify({ code: '0', data: rows }));
  } else {
    res.end(JSON.stringify({ code: '0', data: [] }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 用查询串导入，避免与其他测试文件里已缓存的 okx 模块共享 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-pagination-test');

test('OKX 分页：after 使用时间戳，且不和 end 同时发送', async () => {
  try {
    const first = await okx.fetchTrades({
      creds: { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
      fromMs: 0,
      toMs: 5000,
      cursor: null,
      limit: 100,
    });
    assert.equal(first.trades.length, 100);
    assert.equal(first.nextCursor, '2011');
    assert.equal(queries[0].after, undefined);
    assert.equal(queries[0].end, '5000');

    const second = await okx.fetchTrades({
      creds: { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
      fromMs: 0,
      toMs: 5000,
      cursor: first.nextCursor,
      limit: 100,
    });
    assert.equal(second.trades.length, 0);
    assert.equal(second.nextCursor, null);
    assert.equal(queries[1].after, '2011');
    assert.equal(queries[1].end, undefined);
    assert.equal(queries[1].begin, '0');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
