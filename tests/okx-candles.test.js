import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const queries = [];
const now = 1_800_000_000_000; // 固定时钟，与真实时间无关

// 按 after 参数生成「更早的 100 根 K 线」（倒序），步长跟随请求的 bar，客户端按窗口过滤
const BAR_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1H': 3_600_000, '2H': 7_200_000, '4H': 14_400_000, '6H': 21_600_000, '12H': 43_200_000, '1D': 86_400_000,
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push(q);
  const after = Number(q.after) || Number.MAX_SAFE_INTEGER;
  const step = BAR_MS[q.bar] || 180_000;
  const rows = [];
  for (let i = 1; i <= 100; i++) {
    const t = after - i * step;
    if (t < 0) break;
    rows.push([String(t), '100', '110', '90', String(100 + (i % 5)), '1', '1', '1', '1']);
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: '0', data: rows }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-candles-test');

test('OKX fetchCandles：合约 instId、自适应 bar、窗口过滤与升序返回', async () => {
  try {
    const res = await okx.fetchCandles({
      symbol: 'BTC/USDT', market: 'futures', fromMs: now - 3 * 3600_000, toMs: now,
    });
    assert.equal(res.bar, '3m'); // 3h / 3m = 60 根 ≤ 90
    assert.equal(queries[0].instId, 'BTC-USDT-SWAP');
    assert.equal(queries[0].bar, '3m');
    assert.equal(res.candles.length, 60);
    assert.ok(res.candles[0].t >= now - 3 * 3600_000);
    assert.ok(res.candles[res.candles.length - 1].t <= now);
    // 升序排列；收盘价取 K 线数组第 5 列（最旧一根 i=60 → 100+60%5=100）
    for (let i = 1; i < res.candles.length; i++) {
      assert.ok(res.candles[i].t > res.candles[i - 1].t);
    }
    assert.equal(res.candles[0].c, 100);

    // 现货 instId 不带 -SWAP
    await okx.fetchCandles({ symbol: 'BTC/USDT', market: 'spot', fromMs: now - 3 * 3600_000, toMs: now });
    assert.equal(queries[1].instId, 'BTC-USDT');

    // 5 小时窗口 → 3m 需要 100 根超限，自适应升到 5m
    const fiveHour = await okx.fetchCandles({
      symbol: 'BTC/USDT', market: 'futures', fromMs: now - 5 * 3600_000, toMs: now,
    });
    assert.equal(queries[2].bar, '5m');
    assert.equal(fiveHour.candles.length, 60);

    // 相同参数命中进程内缓存，不再发请求
    const again = await okx.fetchCandles({
      symbol: 'BTC/USDT', market: 'futures', fromMs: now - 3 * 3600_000, toMs: now,
    });
    assert.equal(again.candles.length, 60);
    assert.equal(queries.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
