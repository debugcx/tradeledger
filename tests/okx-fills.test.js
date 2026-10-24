import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const queries = [];

// fills-history：近 3 个月窗口返回两笔成交；更早窗口返回空（超出保留期）
// fills-archive：返回两笔成交（倒序）。时间戳按请求窗口生成，落在过滤范围内
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const q = Object.fromEntries(url.searchParams);
  queries.push({ path: url.pathname, ...q });
  res.setHeader('content-type', 'application/json');

  if (url.pathname === '/api/v5/public/instruments') {
    res.end(JSON.stringify({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01' }] }));
    return;
  }
  const begin = Number(q.begin || 0);
  const mkRow = (billId, offsetMs, side, sz, fee) => ({
    billId,
    ts: String(begin + offsetMs),
    side, fillPx: '100', fillSz: sz, fee, feeCcy: 'USDT',
  });
  const rows = [
    mkRow('b2', 20_000, 'sell', '3', '-0.02'),
    mkRow('b1', 10_000, 'buy', '2', '-0.01'),
  ];
  if (url.pathname === '/api/v5/trade/fills-history') {
    // 3 个月前的窗口为空（超出保留期）
    if (begin < Date.now() - 90 * 86400_000) {
      res.end(JSON.stringify({ code: '0', data: [] }));
      return;
    }
    res.end(JSON.stringify({ code: '0', data: rows }));
    return;
  }
  if (url.pathname === '/api/v5/trade/fills-archive') {
    res.end(JSON.stringify({ code: '0', data: rows.map((r) => ({ ...r, billId: 'a' + r.billId.slice(1) })) }));
    return;
  }
  res.end(JSON.stringify({ code: '0', data: [] }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-fills-test');

test('OKX fetchEpisodeFills：面值换算、升序、缓存复用、超龄自动回退 archive', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
    const recentFrom = Date.now() - 60_000;
    const recentTo = recentFrom + 50_000; // 固定值，保证两次调用命中同一缓存 key
    const res = await okx.fetchEpisodeFills({
      creds, symbol: 'BTC/USDT', market: 'futures', fromMs: recentFrom, toMs: recentTo,
    });
    assert.equal(queries[0].path, '/api/v5/public/instruments');
    assert.equal(queries[0].instId, 'BTC-USDT-SWAP');
    assert.equal(queries[1].path, '/api/v5/trade/fills-history');
    assert.equal(queries[1].instType, 'SWAP');

    assert.equal(res.fills.length, 2);
    assert.ok(res.fills[0].t < res.fills[1].t); // 升序
    assert.equal(res.fills[0].side, 'buy');
    assert.equal(res.fills[0].qty, 0.02); // 2 张 × 0.01 BTC
    assert.equal(res.fills[0].fee, -0.01);
    assert.equal(res.fills[1].qty, 0.03); // 3 张 × 0.01 BTC

    // 相同窗口命中缓存：不再发请求（请求计数不变）
    const again = await okx.fetchEpisodeFills({
      creds, symbol: 'BTC/USDT', market: 'futures', fromMs: recentFrom, toMs: recentTo,
    });
    assert.equal(again.fills.length, 2);
    assert.equal(queries.length, 2);

    // 超过 3 个月的窗口：fills-history 空 → 返回原因说明（archive 是异步导出接口，不做无效请求）
    const oldFrom = Date.now() - 400 * 86400_000;
    const old = await okx.fetchEpisodeFills({
      creds, symbol: 'BTC/USDT', market: 'futures', fromMs: oldFrom, toMs: oldFrom + 86_400_000,
    });
    const paths = queries.slice(2).map((x) => x.path);
    assert.ok(paths.includes('/api/v5/trade/fills-history'), '尝试 fills-history');
    assert.ok(!paths.includes('/api/v5/trade/fills-archive'), '不做无效的 archive 请求');
    assert.equal(old.fills.length, 0);
    assert.ok(old.reason.includes('仅保留约 3 个月'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
