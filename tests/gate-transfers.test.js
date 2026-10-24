import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

// 记录每个请求的 from/to，验证窗口跨度都 < 30 天（Gate 充提接口硬限制）
const spans = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  if (q.from && q.to) spans.push(Number(q.to) - Number(q.from));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([
    { id: 'd1', currency: 'USDT', amount: '10', fee: '0', timestamp: String(Math.floor(Date.now() / 1000) - 60), txid: '0x1' },
  ]));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.GATE_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 gate 模块 BASE
const { gate } = await import('../src/exchanges/gate.js?gate-transfers-test');

test('Gate 流水：180 天窗口按 <30 天切片，不再触发 Time span 400', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's' };
    const now = Date.now();
    const res = await gate.fetchTransfers({ creds, fromMs: now - 180 * 86400_000, toMs: now, limit: 500 });
    assert.ok(spans.length >= 6, `应发出多个分窗请求，实际 ${spans.length}`);
    for (const s of spans) {
      assert.ok(s > 0 && s < 30 * 86400, `窗口跨度 ${s}s 必须小于 30 天`);
    }
    // 适配器不去重（入库时按 external_id 去重）：180 天 → 7 窗 × 2 端点 = 14 行，唯一 ID 2 个
    const unique = new Set(res.transfers.map((t) => t.external_id));
    assert.equal(unique.size, 2);
    assert.equal(res.transfers[0].type, 'deposit');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
