import test from 'node:test';
import assert from 'node:assert/strict';

const { readBodyLimited, readFormDataLimited, readJsonLimited } = await import('../src/http.js');

const request = (body, headers = {}) => new Request('http://localhost/test', {
  method: 'POST',
  headers,
  body,
});

test('readBodyLimited：小请求原样读出', async () => {
  const buf = await readBodyLimited(request('hello'), 1024, '测试');
  assert.equal(Buffer.from(buf).toString('utf8'), 'hello');
});

test('readBodyLimited：超过上限立即拒绝（流式，不依赖 Content-Length）', async () => {
  const big = 'x'.repeat(4096);
  await assert.rejects(
    () => readBodyLimited(request(big), 1024, '测试'),
    /测试超过大小限制/,
  );
});

test('readBodyLimited：声明长度超限时提前拒绝', async () => {
  await assert.rejects(
    () => readBodyLimited(request('x', { 'content-length': '999999' }), 1024, '测试'),
    /测试超过大小限制/,
  );
});

test('readFormDataLimited：解析 urlencoded 表单', async () => {
  const fd = await readFormDataLimited(request(new URLSearchParams({ a: '1', b: '2' })), 1024);
  assert.equal(fd.get('a'), '1');
  assert.equal(fd.get('b'), '2');
});

test('readJsonLimited：解析合法 JSON，拒绝非法/超限 JSON', async () => {
  assert.deepEqual(await readJsonLimited(request('{"ok":true}'), 1024), { ok: true });
  await assert.rejects(() => readJsonLimited(request('{broken'), 1024), /JSON 格式不正确/);
  await assert.rejects(
    () => readJsonLimited(request('{"x":"' + 'y'.repeat(4096) + '"}'), 1024),
    /超过大小限制/,
  );
});
