import test from 'node:test';
import assert from 'node:assert/strict';

const { hostMatchesSuffix, wantsFallback, requestJson } = await import('../src/http-client.js?proxy-fallback-test');

test('hostMatchesSuffix：域名后缀匹配', () => {
  assert.equal(hostMatchesSuffix('fapi.binance.com', 'binance.com'), true);
  assert.equal(hostMatchesSuffix('api.binance.com', 'binance.com'), true);
  assert.equal(hostMatchesSuffix('binance.com', 'binance.com'), true);
  assert.equal(hostMatchesSuffix('notbinance.com', 'binance.com'), false);
  assert.equal(hostMatchesSuffix('www.okx.com', 'binance.com'), false);
  assert.equal(hostMatchesSuffix('fapi.binance.com', ''), false);
});

test('wantsFallback：识别地区封锁/风控页', () => {
  assert.equal(wantsFallback({ status: 200, headers: {}, text: '{"code":0,"msg":"Service unavailable from a restricted location"}' }), true);
  assert.equal(wantsFallback({ status: 451, headers: {}, text: '' }), true);
  assert.equal(wantsFallback({ status: 418, headers: {}, text: 'ban' }), true);
  assert.equal(wantsFallback({ status: 403, headers: { 'content-type': 'text/html' }, text: '<html>blocked</html>' }), true);
  assert.equal(wantsFallback({ status: 200, headers: {}, text: '{"serverTime":123}' }), false);
  assert.equal(wantsFallback({ status: 200, headers: {}, text: '{"code":"0","data":[]}' }), false);
});

// 端到端回退：需要本机真实代理（7890）。CI/无代理环境自动跳过。
test('EXCHANGE_PROXY 端到端：直连超时 → 自动走代理', { timeout: 60_000 }, async () => {
  const net = await import('node:net');
  const listening = await new Promise((resolve) => {
    const s = net.connect(7890, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
  if (!listening) {
    console.log('本机 7890 无代理，跳过端到端测试');
    return;
  }
  // 直连 fapi.binance.com 在当前网络会超时（被墙）；EXCHANGE_PROXY 指向本机 Clash → 应自动回退成功
  process.env.EXCHANGE_PROXY = 'http://127.0.0.1:7890';
  process.env.TRADELEDGER_AUTO_PROXY = '0'; // 关闭自动探测，验证纯回退路径
  try {
    const res = await requestJson('https://fapi.binance.com/fapi/v1/time', { timeout: 8000, retries: 0 });
    assert.ok(res.json.serverTime > 0);
  } finally {
    delete process.env.EXCHANGE_PROXY;
    delete process.env.TRADELEDGER_AUTO_PROXY;
  }
});
