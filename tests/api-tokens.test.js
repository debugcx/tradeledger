import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.TRADELEDGER_PASSWORD = 'test-pass-123';

const { openDb, setDb, closeDb, get } = await import('../src/db.js');
setDb(openDb(':memory:'));

const {
  createApiToken, listApiTokens, revokeApiToken, verifyApiToken,
  normalizeApiScopes, checkApiAuthFailure, recordApiAudit, listApiAudit, cleanupApiAudit,
  hashApiToken,
} = await import('../src/api-tokens.js');

test.after(() => closeDb());

const bearer = (token) => new Request('http://localhost/api/v1/me', {
  headers: { authorization: `Bearer ${token}` },
});

test('Token：明文只返回一次，库里只存 SHA-256', () => {
  const { token, row } = createApiToken({ name: '测试 Agent', scopes: 'write' });
  assert.match(token, /^tl_[A-Za-z0-9_-]{20,}$/);
  assert.equal(row.name, '测试 Agent');
  assert.equal(row.scopes, 'read,write');
  assert.equal(row.hint, `tl_…${token.slice(-4)}`);
  const stored = get('SELECT token_hash FROM api_tokens WHERE id = ?', row.id);
  assert.equal(stored.token_hash, hashApiToken(token));
  assert.notEqual(stored.token_hash, token);
  // 列表接口不暴露 hash
  const listed = listApiTokens().find((t) => t.id === row.id);
  assert.ok(listed);
  assert.equal(listed.token_hash, undefined);
});

test('Token：校验成功、无效、撤销、过期', async () => {
  const { token, row } = createApiToken({ name: '校验', scopes: 'read' });
  const ok = verifyApiToken(bearer(token));
  assert.equal(ok.error, null);
  assert.equal(ok.token.id, row.id);
  assert.deepEqual(ok.token.scopes, ['read']);

  assert.equal(verifyApiToken(bearer('tl_not-a-real-token-000000')).error, 'invalid');
  assert.equal(verifyApiToken(new Request('http://localhost/api/v1/me')).error, null);

  revokeApiToken(row.id);
  assert.equal(verifyApiToken(bearer(token)).error, 'revoked');

  const expired = createApiToken({ name: '过期', scopes: 'read' });
  const { run } = await import('../src/db.js');
  run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', expired.row.id);
  assert.equal(verifyApiToken(bearer(expired.token)).error, 'expired');
});

test('Token：scope 归一化与权限判断', async () => {
  const { hasApiScope } = await import('../src/api-tokens.js');
  assert.equal(normalizeApiScopes('write'), 'read,write');
  assert.equal(normalizeApiScopes('read'), 'read');
  assert.equal(normalizeApiScopes(''), 'read');
  assert.equal(normalizeApiScopes(['write', 'bogus']), 'read,write');
  assert.equal(hasApiScope({ scopes: ['read'] }, 'read'), true);
  assert.equal(hasApiScope({ scopes: ['read'] }, 'write'), false);
  assert.equal(hasApiScope({ scopes: ['read', 'write'] }, 'write'), true);
});

test('Token：失败认证按 IP 限流（20 次/分钟）', () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(checkApiAuthFailure('203.0.113.9').ok, true, `第 ${i + 1} 次不应被限流`);
  }
  const blocked = checkApiAuthFailure('203.0.113.9');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  // 其他 IP 不受影响
  assert.equal(checkApiAuthFailure('203.0.113.10').ok, true);
});

test('审计：写入、查询与 30 天清理', async () => {
  const { run } = await import('../src/db.js');
  recordApiAudit({ tokenId: null, method: 'GET', path: '/api/v1/trades', status: 200, ip: '127.0.0.1', ms: 12 });
  recordApiAudit({ tokenId: 1, method: 'PATCH', path: '/api/v1/trades/1', status: 200, ip: '127.0.0.1', ms: 30 });
  const rows = listApiAudit(10);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].method, 'PATCH');

  run(
    "INSERT INTO api_audit (token_id, method, path, status, ip, ms, created_at) VALUES (NULL, 'GET', '/old', 200, '', 1, ?)",
    '2020-01-01T00:00:00.000Z',
  );
  const removed = cleanupApiAudit();
  assert.ok(removed >= 1);
  assert.ok(!listApiAudit(100).some((r) => r.path === '/old'));
});
