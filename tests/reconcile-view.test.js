import test from 'node:test';
import assert from 'node:assert/strict';

const { monthlyPanel } = await import('../src/views/reconcile.js');

test('月度对账面板：空数据返回空串', () => {
  assert.equal(monthlyPanel([]), '');
  assert.equal(monthlyPanel(null), '');
});

test('月度对账面板：账户名与错误信息转义，防止注入', () => {
  const html = monthlyPanel([{
    account: { name: '<script>alert(1)</script>', exchange: 'okx' },
    rows: [{ month: '2026-10', app: 10, exchange: 10, diff: 0 }],
  }]);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('一致'));
});

test('月度对账面板：拉取失败显示错误', () => {
  const html = monthlyPanel([{
    account: { name: 'Gate', exchange: 'gate' },
    rows: [],
    error: 'HTTP 403',
  }]);
  assert.ok(html.includes('账本拉取失败'));
  assert.ok(html.includes('HTTP 403'));
});
