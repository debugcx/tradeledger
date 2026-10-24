import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

// 模拟本机时钟比币安服务器快 2500ms（超过币安 1 秒容忍度）
const SKEW_MS = 2500;
const serverNow = () => Date.now() - SKEW_MS;
let signedCalls = 0;
let timeRequests = 0;
let forceNext1021 = false;
const seenPaths = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  seenPaths.push(url.pathname);
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/fapi/v1/time') {
    timeRequests++;
    res.end(JSON.stringify({ serverTime: Date.now() - SKEW_MS }));
    return;
  }
  const ts = Number(url.searchParams.get('timestamp'));
  signedCalls++;
  if (forceNext1021 || Math.abs(ts - serverNow()) > 1500) {
    forceNext1021 = false;
    res.end(JSON.stringify({ code: -1021, msg: "Timestamp for this request was 1000ms ahead of the server's time." }));
    return;
  }
  res.end(JSON.stringify({
    assets: [{ asset: 'USDT', walletBalance: '100', unrealizedProfit: '0', marginBalance: '100', availableBalance: '90' }],
    positions: [],
    totalWalletBalance: '100',
    totalUnrealizedProfit: '0',
    totalMarginBalance: '100',
  }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.BINANCE_FAPI_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.BINANCE_SAPI_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，隔离模块级 timeOffset 缓存
const { binance } = await import('../src/exchanges/binance.js?binance-time-test');

test('Binance：自动对齐服务器时钟、缓存偏移、-1021 自动重对齐重试', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };

  // 阶段 1：本机快 2.5s，首次调用自动对齐后成功
  const live1 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live1.balances));
  assert.equal(timeRequests, 1, '首次调用应同步一次服务器时间');
  const calls1 = signedCalls;

  // 阶段 2：偏移已缓存，30 分钟内不再请求 /time
  const live2 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live2.balances));
  assert.equal(timeRequests, 1, '偏移缓存生效，不再请求 /time');
  assert.equal(signedCalls, calls1 + 1);

  // 阶段 3：强制下一次签名请求返回 -1021 → 重新对齐 + 重试成功
  forceNext1021 = true;
  const live3 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live3.balances), '-1021 后应重试成功');
  assert.equal(timeRequests, 2, '重试前应重新对齐服务器时间');
  assert.ok(signedCalls >= calls1 + 3, '失败请求 + 重试至少各一次');
  await new Promise((resolve) => server.close(resolve));
});
