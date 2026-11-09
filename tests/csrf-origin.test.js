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

test('Origin: null 或非法 Origin 只在浏览器声明 same-origin 时放行', () => {
  assert.equal(isSameOriginRequest({
    origin: 'null',
    host: '10.0.0.2:8790',
    secFetchSite: 'same-origin',
  }), true);
  assert.equal(isSameOriginRequest({
    origin: 'null',
    host: '10.0.0.2:8790',
    secFetchSite: 'cross-site',
  }), false);
  assert.equal(isSameOriginRequest({
    origin: 'not a url',
    host: '10.0.0.2:8790',
  }), false);
});
