import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DB_FILE = ':memory:';
const { openDb, setDb, closeDb, getDb } = await import('../src/db.js');
setDb(openDb(':memory:'));
const auth = await import('../src/auth.js');

const requestWith = (token) => new Request('http://localhost/', {
  headers: { cookie: `tl_session=${token}` },
});
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

test('登录限流：10 次失败锁定，其他 IP 不受影响，过期后回收', () => {
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 10; i++) auth.recordFailure('1.2.3.4');
    assert.equal(auth.rateLimit('1.2.3.4').blocked, true);
    assert.equal(auth.rateLimit('5.6.7.8').blocked, false);
    now += 5 * 60_000 + 1;
    assert.equal(auth.rateLimit('1.2.3.4').blocked, false);
  } finally {
    Date.now = realNow;
  }
});

test('会话：登录/读取/登出，默认 7 天、记住我 30 天', () => {
  const normal = auth.login({ remember: false });
  assert.equal(normal.maxAge, 7 * 86400);
  assert.equal(auth.currentUser(requestWith(normal.token)).id, 1);
  auth.logout(requestWith(normal.token));
  assert.equal(auth.currentUser(requestWith(normal.token)), null);

  const remember = auth.login({ remember: true });
  assert.equal(remember.maxAge, 30 * 86400);
});

test('会话：过期后被拒绝并删除记录', () => {
  const session = auth.login({ remember: false });
  const hash = hashOf(session.token);
  getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run('2000-01-01T00:00:00.000Z', hash);
  assert.equal(auth.currentUser(requestWith(session.token)), null);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hash).n, 0);
});

test('Cookie 属性：HttpOnly/SameSite/Secure/Max-Age', () => {
  const cookie = auth.cookieFor('tok', 3600, true);
  assert.match(cookie, /tl_session=tok/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(auth.clearCookie(), /Max-Age=0/);
});

test.after(() => closeDb());
