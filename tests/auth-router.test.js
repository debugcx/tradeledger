import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.TRADELEDGER_PASSWORD = 'test-pass-123';

const { openDb, setDb, closeDb } = await import('../src/db.js');
setDb(openDb(':memory:'));
const { handle } = await import('../src/routes.js');
const auth = await import('../src/auth.js');

const req = (path, init = {}) => new Request(`http://localhost${path}`, init);

test('默认拒绝：未登录页面 302 到 /login，API 401，媒体 401', async () => {
  const page = await handle(req('/dashboard'));
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location') || '', /^\/login\?next=/);

  const api = await handle(req('/api/summary'));
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, 'unauthorized');

  const media = await handle(req('/media/abc'));
  assert.equal(media.status, 401);
});

test('公开路由：health 带数据库探活，login/docs 可匿名访问', async () => {
  const health = await handle(req('/api/health'));
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);

  const login = await handle(req('/login'));
  assert.equal(login.status, 200);

  const docs = await handle(req('/api/docs'));
  assert.equal(docs.status, 200);
});

test('登录后可访问受保护 API', async () => {
  const session = auth.login({ remember: false });
  const res = await handle(req('/api/me', {
    headers: { cookie: `tl_session=${session.token}` },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 1);
});

test('对账页与月度片段：页面不等待交易所，片段默认拒绝匿名', async () => {
  const anon = await handle(req('/dashboard/reconcile/monthly'));
  assert.equal(anon.status, 302);

  const session = auth.login({ remember: false });
  const cookie = { cookie: `tl_session=${session.token}` };
  const page = await handle(req('/dashboard/reconcile', { headers: cookie }));
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /id="monthly-panels"/);
  assert.match(pageHtml, /dashboard\/reconcile\/monthly/);

  const fragment = await handle(req('/dashboard/reconcile/monthly', { headers: cookie }));
  assert.equal(fragment.status, 200);
  assert.equal(fragment.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await fragment.text(), ''); // 空库里没有可对账账户
});

test('登录 next 参数阻止开放重定向', async () => {
  const body = new URLSearchParams({ password: 'test-pass-123', next: '//evil.example' }).toString();
  const res = await handle(req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard');
});

test('清理内存库', () => {
  closeDb();
});
