/**
 * 客户端 IP 解析：
 * - 只有来自回环（本机反代 / smoke）或显式 TRUST_PROXY=1 时才采信代理头；
 * - 采信时取 X-Forwarded-For 的最右值（由可信代理追加），避免客户端伪造最左值；
 * - 其余情况直接用 TCP 对端地址，保证每个客户端有独立限流桶，避免“全员共用一个桶”被锁死。
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function normalizePeer(peer) {
  return String(peer || '').replace(/^::ffff:/i, '');
}

export function isLoopbackPeer(peer) {
  const value = normalizePeer(peer);
  return !value || LOOPBACK.has(value) || /^127\./.test(value);
}

export function resolveClientIp({ headers, peer = '', trustProxy = false } = {}) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);
  const peerIp = normalizePeer(peer);
  if (!trustProxy && !isLoopbackPeer(peerIp)) return peerIp || 'local';

  const cf = String(get('cf-connecting-ip') || '').trim();
  if (cf) return cf;

  const forwarded = String(get('x-forwarded-for') || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // 可信代理会把真实客户端追加在右侧；最左值可能是客户端自己伪造的。
  if (forwarded.length) return forwarded[forwarded.length - 1];
  return peerIp || 'local';
}
