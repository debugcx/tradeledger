import test from 'node:test';
import assert from 'node:assert/strict';

const { passwordStartupError } = await import('../src/startup.js');

test('回环地址允许开发回退密码', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.equal(passwordStartupError({ host, password: 'demo1234', passwordFromEnv: false }), '', host);
  }
});

test('非回环地址未设置密码时拒绝启动', () => {
  const err = passwordStartupError({ host: '0.0.0.0', password: 'demo1234', passwordFromEnv: false });
  assert.match(err, /未设置 TRADELEDGER_PASSWORD/);
  assert.match(passwordStartupError({ host: '192.168.1.10', password: 'demo1234', passwordFromEnv: false }), /拒绝启动/);
});

test('非回环地址 + 弱环境密码拒绝启动', () => {
  assert.match(
    passwordStartupError({ host: '0.0.0.0', password: 'short', passwordFromEnv: true }),
    /至少 8 位/,
  );
  assert.match(
    passwordStartupError({ host: '0.0.0.0', password: 'change-me', passwordFromEnv: true }),
    /示例值/,
  );
});

test('非回环地址 + 强密码允许启动', () => {
  assert.equal(
    passwordStartupError({ host: '0.0.0.0', password: 'a-strong-password-2026', passwordFromEnv: true }),
    '',
  );
});

test('回环地址但显式设置了弱密码也拒绝', () => {
  assert.match(
    passwordStartupError({ host: '127.0.0.1', password: 'demo1234', passwordFromEnv: true }),
    /示例值/,
  );
});
