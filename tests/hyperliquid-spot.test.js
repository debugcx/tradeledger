import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const NOW = Date.now();
const DAY = 86400_000;
const calls = [];

// 覆盖 30 天窗口时返回 2000 笔（触发二分），子区间只返回少量
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    calls.push(payload);
    res.setHeader('content-type', 'application/json');
    if (payload.type !== 'userFillsByTime') {
      res.statusCode = 400;
      return res.end('{"error":"unexpected"}');
    }
    const span = Number(payload.endTime) - Number(payload.startTime);
    const mid = Math.floor((Number(payload.startTime) + Number(payload.endTime)) / 2);
    const n = span > 29 * DAY ? 2000 : 50;
    const rows = Array.from({ length: n }, (_, i) => ({
      tid: span > 29 * DAY ? 1_000_000 + i : (i < 50 ? mid + i : 0),
      coin: 'PURR/USDC',
      side: i % 2 ? 'B' : 'A',
      px: '0.2',
      sz: '10',
      fee: '0.01',
      time: payload.startTime + i,
      hash: '0x' + i,
    })).filter((r) => r.tid);
    res.end(JSON.stringify(rows));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.HYPERLIQUID_API_BASE = `http://127.0.0.1:${server.address().port}/info`;

const { hyperliquid } = await import('../src/exchanges/hyperliquid.js?hl-spot-test');

test('Hyperliquid 现货：30 天窗口，打满 2000 笔时二分继续拉', async () => {
  calls.length = 0;
  const res = await hyperliquid.fetchSpotTrades({
    creds: { wallet: '0xabc' },
    fromMs: NOW - 40 * DAY,
    toMs: NOW,
    limit: 5000,
  });
  // 第一个 30 天窗口打满后二分出 2 个子请求；第二个窗口直接返回 50 笔
  assert.equal(calls.length, 4);
  assert.equal(res.fills.length, 2000 + 50 * 3);
  assert.equal(new Set(res.fills.map((f) => f.id)).size, res.fills.length);
  assert.ok(res.fills.every((f) => f.symbol === 'PURR/USDC'));
  for (const c of calls) {
    assert.ok(Number(c.endTime) - Number(c.startTime) <= 30 * DAY);
  }
});

test.after(() => new Promise((resolve) => server.close(resolve)));
