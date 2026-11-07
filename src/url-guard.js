/**
 * 出站 URL 安全校验：所有可由用户配置的 baseUrl（LLM / ASR / WebDAV /
 * 钱包索引服务）在保存和使用前都过这里。
 *
 * 规则：
 * - 只允许 http/https；
 * - 拒绝云元数据地址（169.254.169.254 等）；
 * - http 明文只允许回环 / 私有网段（本机 Ollama、局域网 NAS 等）；
 *   公网 http 需显式 TRADELEDGER_ALLOW_INSECURE_EGRESS=1；
 * - 私网 https 不拦（单用户本地部署可能连 NAS / 局域网服务），这里防的是
 *   被当作跳板访问云元数据，而不是禁止一切内网访问。
 */

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  '100.100.100.200',
  'fd00:ec2::254',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isPrivateHost(host) {
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // IPv6 ULA
  return false;
}

export function assertSafeOutboundUrl(raw, { label = '地址' } = {}) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(`请填写${label}`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}不是合法的 URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 http/https`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.internal')) {
    throw new Error(`${label}指向云元数据/内部服务，已拒绝`);
  }
  const loopback = LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
  const local = loopback || isPrivateHost(host);
  if (url.protocol === 'http:' && !local && process.env.TRADELEDGER_ALLOW_INSECURE_EGRESS !== '1') {
    throw new Error(`${label}使用 http 明文；请改用 https，或设置 TRADELEDGER_ALLOW_INSECURE_EGRESS=1`);
  }
  return url;
}
