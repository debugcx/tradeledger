import test from 'node:test';
import assert from 'node:assert/strict';

const { isSameOriginRequest } = await import('../src/http.js');

test('没有 Origin 的客户端（curl/部分表单）放行', () => {
  assert.equal(isSameOriginRequest({}), true);
  assert.equal(isSameOriginRequest({ host: '10.0.0.2:8790' }), true);
});

test('Origin 与 Host 完全一致时放行', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: '10.0.0.2:8790',
  }), true);
});

test('反向代理改写 Host（去掉端口）时，浏览器 same-origin 兜底放行', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: '10.0.0.2',
    secFetchSite: 'same-origin',
  }), true);
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: 'tradeledger:8790',
    secFetchSite: 'same-origin',
  }), true);
});

test('Host 不一致且没有 same-origin 声明时拒绝', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: '10.0.0.2',
  }), false);
  assert.equal(isSameOriginRequest({
    origin: 'http://evil.example',
    host: '10.0.0.2:8790',
    secFetchSite: 'cross-site',
  }), false);
});

test('代理同时剥掉 Host 端口和 Sec-Fetch-Site 时，按主机名 + 本服务端口放行', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: '10.0.0.2',
    appPort: 8790,
  }), true);
  assert.equal(isSameOriginRequest({
    origin: 'http://[::1]:8790',
    host: '[::1]',
    appPort: 8790,
  }), true);
  // 反向代理（Caddy）场景：Origin 使用协议默认端口
  assert.equal(isSameOriginRequest({
    origin: 'https://tradeledger.example.com',
    host: 'tradeledger.example.com',
    appPort: 8790,
  }), true);
});

test('主机名相同但 Origin 端口不是本服务端口时拒绝', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:9999',
    host: '10.0.0.2',
    appPort: 8790,
  }), false);
  assert.equal(isSameOriginRequest({
    origin: 'http://evil.example',
    host: '10.0.0.2',
    appPort: 8790,
  }), false);
});

test('Host 自带端口时不做主机名兜底，端口不一致仍拒绝', () => {
  assert.equal(isSameOriginRequest({
    origin: 'http://10.0.0.2:8790',
    host: '10.0.0.2:1234',
    appPort: 8790,
  }), false);
});

test('Origin: null（不透明来源）在未声明 cross-site 时放行，声明 cross-site 仍拒绝', () => {
  // 代理重放 / sandbox iframe：Origin: null 且 Sec-Fetch-Site 被剥掉
  assert.equal(isSameOriginRequest({
    origin: 'null',
    host: '10.0.0.2:8790',
  }), true);
  assert.equal(isSameOriginRequest({
    origin: 'null',
    host: '10.0.0.2',
    secFetchSite: 'same-origin',
  }), true);
  assert.equal(isSameOriginRequest({
    origin: 'null',
    host: '10.0.0.2:8790',
    secFetchSite: 'cross-site',
  }), false);
});

test('其它非法 Origin 串不放行', () => {
  assert.equal(isSameOriginRequest({
    origin: 'not a url',
    host: '10.0.0.2:8790',
  }), false);
  assert.equal(isSameOriginRequest({
    origin: 'http://evil.example',
    host: '10.0.0.2:8790',
    secFetchSite: 'same-site',
  }), false);
});
