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
let forceRiskUnavailable = false;
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
  // 统一账户的 account 接口持仓没有 markPrice/unRealizedProfit（与线上一致）
  if (url.pathname === '/fapi/v2/account') {
    res.end(JSON.stringify({
      assets: [{ asset: 'USDT', walletBalance: '100', unrealizedProfit: '0', marginBalance: '100', availableBalance: '90' }],
      positions: [{ symbol: 'BTCUSDT', positionAmt: '0.5', entryPrice: '100', markPrice: '0', unRealizedProfit: '0' }],
      totalWalletBalance: '100',
      totalUnrealizedProfit: '0',
      totalMarginBalance: '100',
    }));
    return;
  }
  if (url.pathname === '/fapi/v2/positionRisk') {
    if (forceRiskUnavailable) {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: -1000, msg: 'mock unavailable' }));
      return;
    }
    res.end(JSON.stringify([
      { symbol: 'BTCUSDT', positionAmt: '0.5', entryPrice: '100', markPrice: '110', unRealizedProfit: '5' },
    ]));
    return;
  }
  if (url.pathname === '/dapi/v1/positionRisk') {
    res.end(JSON.stringify([]));
    return;
  }
  if (url.pathname === '/fapi/v1/premiumIndex') {
    res.end(JSON.stringify({ lastFundingRate: '0.0001', nextFundingTime: Date.now() + 3600_000 }));
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
process.env.BINANCE_DAPI_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.BINANCE_SAPI_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，隔离模块级 timeOffset 缓存
const { binance } = await import('../src/exchanges/binance.js?binance-time-test');

test('Binance：自动对齐服务器时钟、缓存偏移、-1021 自动重对齐重试', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };

  // 阶段 1：本机快 2.5s，首次调用自动对齐后成功
  const live1 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live1.balances));
  // 统一账户 account 接口拿不到实时盈亏，必须从 positionRisk 取
  assert.equal(live1.positions.length, 1);
  assert.equal(live1.positions[0].mark_price, 110);
  assert.equal(live1.positions[0].unrealized, 5);
  // 负载高导致签名延迟超过容差时会多对齐一次，允许 <=2；核心是不缓存时必须同步
  assert.ok(timeRequests >= 1 && timeRequests <= 2, '首次调用应同步服务器时间');
  const calls1 = signedCalls;
  const timeReq1 = timeRequests;

  // 阶段 2：偏移已缓存，30 分钟内不再请求 /time；每次 fetchLive 固定 4 个请求
  const live2 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live2.balances));
  assert.equal(timeRequests, timeReq1, '偏移缓存生效，不再请求 /time');
  assert.equal(signedCalls, calls1 + 4, 'account + U 本位 positionRisk + 资金费率 + 币本位 positionRisk');

  // 阶段 3：强制下一次签名请求返回 -1021 → 重新对齐 + 重试成功
  forceNext1021 = true;
  const timeReq2 = timeRequests;
  const live3 = await binance.fetchLive(creds);
  assert.ok(Array.isArray(live3.balances), '-1021 后应重试成功');
  assert.equal(timeRequests, timeReq2 + 1, '重试前应重新对齐服务器时间');
  assert.ok(signedCalls >= calls1 + 3, '失败请求 + 重试至少各一次');
});

test('Binance：positionRisk 不可用时回退到 account.positions，不报错', async () => {
  forceRiskUnavailable = true;
  try {
    const live = await binance.fetchLive({ apiKey: 'k', apiSecret: 's' });
    assert.equal(live.positions.length, 1);
    assert.equal(live.positions[0].symbol, 'BTC/USDT');
    assert.equal(live.positions[0].unrealized, 0); // account 接口没有该字段时按 0 处理
  } finally {
    forceRiskUnavailable = false;
    await new Promise((resolve) => server.close(resolve));
  }
});
