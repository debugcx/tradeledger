import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveClientIp, isLoopbackPeer } = await import('../src/client-ip.js');

test('直连（非回环对端）不采信 XFF/CF，直接用 TCP 对端', () => {
  const headers = { get: (k) => (k === 'x-forwarded-for' ? '1.1.1.1' : k === 'cf-connecting-ip' ? '2.2.2.2' : '') };
  assert.equal(resolveClientIp({ headers, peer: '192.168.1.50', trustProxy: false }), '192.168.1.50');
});

test('回环对端（本机反代/smoke）采信 XFF 最右值而非最左值', () => {
  const headers = { get: (k) => (k === 'x-forwarded-for' ? '6.6.6.6, 203.0.113.9' : '') };
  assert.equal(resolveClientIp({ headers, peer: '127.0.0.1', trustProxy: false }), '203.0.113.9');
});

test('TRUST_PROXY=1 时采信 CF 头，其次 XFF 最右值', () => {
  const cf = { get: (k) => (k === 'cf-connecting-ip' ? '8.8.8.8' : k === 'x-forwarded-for' ? '1.1.1.1' : '') };
  assert.equal(resolveClientIp({ headers: cf, peer: '10.0.0.2', trustProxy: true }), '8.8.8.8');
  const xff = { get: (k) => (k === 'x-forwarded-for' ? '1.1.1.1, 9.9.9.9' : '') };
  assert.equal(resolveClientIp({ headers: xff, peer: '10.0.0.2', trustProxy: true }), '9.9.9.9');
});

test('没有对端信息时回退 local；IPv4-mapped 回环可识别', () => {
  const empty = { get: () => '' };
  assert.equal(resolveClientIp({ headers: empty, peer: '' }), 'local');
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackPeer('192.168.1.1'), false);
});
