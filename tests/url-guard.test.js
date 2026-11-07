import test from 'node:test';
import assert from 'node:assert/strict';

const { assertSafeOutboundUrl } = await import('../src/url-guard.js');

test('允许 https 公网与私网地址', () => {
  assert.equal(assertSafeOutboundUrl('https://api.openai.com/v1').hostname, 'api.openai.com');
  assert.equal(assertSafeOutboundUrl('https://192.168.1.10/dav').hostname, '192.168.1.10');
});

test('http 只允许回环与私有网段', () => {
  assert.equal(assertSafeOutboundUrl('http://127.0.0.1:11434').hostname, '127.0.0.1');
  assert.equal(assertSafeOutboundUrl('http://localhost:8080').hostname, 'localhost');
  assert.equal(assertSafeOutboundUrl('http://192.168.1.20:5005').hostname, '192.168.1.20');
  assert.equal(assertSafeOutboundUrl('http://10.0.0.5:8080').hostname, '10.0.0.5');
  assert.throws(() => assertSafeOutboundUrl('http://example.com/api'), /http 明文/);
});

test('拒绝云元数据地址、.internal 与非 http(s) 协议', () => {
  assert.throws(() => assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data'), /云元数据/);
  assert.throws(() => assertSafeOutboundUrl('https://metadata.google.internal/'), /云元数据|内部服务/);
  assert.throws(() => assertSafeOutboundUrl('ftp://example.com'), /只支持 http\/https/);
  assert.throws(() => assertSafeOutboundUrl('not a url'), /不是合法的 URL/);
});

test('TRADELEDGER_ALLOW_INSECURE_EGRESS=1 可显式放行公网 http', () => {
  const prev = process.env.TRADELEDGER_ALLOW_INSECURE_EGRESS;
  process.env.TRADELEDGER_ALLOW_INSECURE_EGRESS = '1';
  try {
    assert.equal(assertSafeOutboundUrl('http://example.com/api').hostname, 'example.com');
  } finally {
    if (prev === undefined) delete process.env.TRADELEDGER_ALLOW_INSECURE_EGRESS;
    else process.env.TRADELEDGER_ALLOW_INSECURE_EGRESS = prev;
  }
});
