/**
 * 启动期安全校验：弱密码 + 监听地址。
 * 回环地址保留 demo1234 的开发便利；一旦监听非回环地址，必须设置强密码。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WEAK_PASSWORDS = new Set(['demo1234', 'change-me', 'change-me-to-a-long-random-password']);

export function passwordStartupError({ host, password, passwordFromEnv }) {
  const loopback = LOOPBACK_HOSTS.has(String(host || '').toLowerCase());
  const weak = WEAK_PASSWORDS.has(String(password)) || String(password || '').length < 8;

  if (!loopback) {
    if (!passwordFromEnv) {
      return `HOST=${host} 监听非回环地址，但未设置 TRADELEDGER_PASSWORD（当前是开发回退密码），已拒绝启动`;
    }
    if (weak) {
      return 'TRADELEDGER_PASSWORD 至少 8 位且不能是示例值，已拒绝启动';
    }
    return '';
  }

  if (passwordFromEnv && weak) {
    return 'TRADELEDGER_PASSWORD 至少 8 位且不能是示例值，已拒绝启动';
  }
  return '';
}
