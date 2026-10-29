/**
 * 面向交易所 API 的 HTTP 客户端。
 *
 * - 优先使用 HTTPS_PROXY / HTTP_PROXY；
 * - 未配置时自动探测本机常见代理端口（7890/7897/10809/1080），
 *   避免国内网络直连交易所超时；可用 TRADELEDGER_AUTO_PROXY=0 关闭；
 * - 按交易所分流：EXCHANGE_PROXY_HOSTS 列出的域名强制走 EXCHANGE_PROXY；
 *   其余域名直连被拒（地区封锁/风控页）时自动改走 EXCHANGE_PROXY 并记住；
 * - 本地地址（localhost / 内网）永远直连，不经过代理；
 * - 429 / 5xx 自动重试一次；
 * - 返回 { status, headers, text, json }。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

const TIMEOUT_MS = 15_000;
const PROXY_CANDIDATES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080',
];
let proxyCache = { value: undefined, at: 0 };
const loggedHints = new Set();

// 交易所专用代理的运行时配置提供器（由 store 注册，读 meta；env 作为兜底）
let exchangeProxyProvider = null;
export function setExchangeProxyProvider(fn) { exchangeProxyProvider = fn; }
function exchangeProxyConfig() {
  if (exchangeProxyProvider) {
    try {
      const cfg = exchangeProxyProvider() || {};
      if (cfg.proxy || cfg.hosts) return { proxy: cfg.proxy || '', hosts: cfg.hosts || '' };
    } catch { /* 配置读取失败时回落 env */ }
  }
  return { proxy: process.env.EXCHANGE_PROXY || '', hosts: process.env.EXCHANGE_PROXY_HOSTS || '' };
}
const PROXY_TTL = 60_000;

// 直连被拒后自动改走 EXCHANGE_PROXY 的域名（进程内记忆）
const adaptiveProxied = new Set();

/** 域名后缀匹配：fapi.binance.com 匹配 binance.com */
export function hostMatchesSuffix(host, suffix) {
  const h = String(host || '').toLowerCase();
  const s = String(suffix || '').toLowerCase().trim();
  if (!s) return false;
  return h === s || h.endsWith('.' + s);
}

/** 识别地区封锁/风控拦截页：HTTP 451/418、HTML 错误页、币安 "restricted location" JSON */
export function wantsFallback(res) {
  if (!res) return true;
  if (res.status === 451 || res.status === 418) return true;
  const text = String(res.text || '');
  if (res.status === 403 && /<html|text\/html/i.test(text + (res.headers?.['content-type'] || ''))) return true;
  if (/<html|<!DOCTYPE/i.test(text.slice(0, 400))) return true;
  if (/restricted location|地区不可用/i.test(text)) return true;
  return false;
}

function explicitProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** 用一次 CONNECT 握手验证代理确实可用，避免把 7890 上的非代理服务当代理 */
function probeProxy(proxyUrl) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: 'www.okx.com:443',
      headers: { host: 'www.okx.com:443' },
      timeout: 1500,
    });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function resolveProxy(targetHost) {
  const explicit = explicitProxy();
  if (explicit) return explicit;
  if (isLocalHost(targetHost)) return '';
  if (process.env.TRADELEDGER_AUTO_PROXY === '0') return '';
  if (proxyCache.value !== undefined && Date.now() - proxyCache.at < PROXY_TTL) return proxyCache.value;
  for (const candidate of PROXY_CANDIDATES) {
    if (await probeProxy(candidate)) {
      proxyCache = { value: candidate, at: Date.now() };
      // 同一条提示只打一次，避免每 60 秒刷屏
      const hint = `[http] 未配置 HTTPS_PROXY，自动使用本地代理 ${candidate}`;
      if (!loggedHints.has(hint)) {
        loggedHints.add(hint);
        console.warn(hint);
      }
      return candidate;
    }
  }
  proxyCache = { value: '', at: Date.now() };
  return '';
}

function requestDirect(target, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'http:' ? http : https;
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method,
      path: target.pathname + target.search,
      headers,
      servername: target.hostname,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function decodeChunked(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const size = parseInt(buf.subarray(i, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2;
    if (i > buf.length) break;
  }
  return Buffer.concat(parts).toString('utf8');
}

function parseTunnelResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('代理响应格式错误');
  const head = buf.subarray(0, sep).toString('latin1');
  const bodyBuf = buf.subarray(sep + 4);
  const lines = head.split('\r\n');
  const status = Number((lines[0].match(/^HTTP\/\d\.\d\s+(\d+)/) || [])[1] || 0);
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
  return { status, headers, text: chunked ? decodeChunked(bodyBuf) : bodyBuf.toString('utf8') };
}

/** HTTP 代理：CONNECT 建立隧道，返回裸 socket */
function connectThroughHttpProxy(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const proxyTransport = proxy.protocol === 'https:' ? https : http;
    const auth = proxy.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
      : '';
    const connectHeaders = { host: `${target.hostname}:${target.port || 443}` };
    if (auth) connectHeaders['proxy-authorization'] = auth;

    const connectReq = proxyTransport.request({
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: connectHeaders,
      timeout,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('timeout', () => {
      connectReq.destroy();
      reject(new Error(`代理连接超时（${timeout}ms）`));
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/** SOCKS5 代理（RFC 1928）：支持无认证与账号密码，域名由代理端解析（socks5h 语义） */
function connectThroughSocks5(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const host = target.hostname;
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 1080) });
    socket.setTimeout(timeout);
    const chunks = [];
    let stage = 'greet';
    const creds = proxy.username
      ? { user: decodeURIComponent(proxy.username), pass: decodeURIComponent(proxy.password || '') }
      : null;
    const fail = (msg) => { socket.destroy(); reject(new Error(msg)); };
    const onTimeout = () => fail(`SOCKS5 连接超时（${timeout}ms）`);
    const sendConnect = () => {
      const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      const addr = isV4
        ? Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))])
        : (() => { const b = Buffer.from(host, 'utf8'); return Buffer.concat([Buffer.from([3, b.length]), b]); })();
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
    };
    const onData = (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail('SOCKS5 握手异常：代理未返回 SOCKS5 响应');
        if (buf[1] === 0) { stage = 'connect'; chunks.length = 0; sendConnect(); }
        else if (buf[1] === 2 && creds) {
          stage = 'auth'; chunks.length = 0;
          const u = Buffer.from(creds.user, 'utf8');
          const p = Buffer.from(creds.pass, 'utf8');
          socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        } else return fail(creds ? 'SOCKS5 代理拒绝了账号密码认证' : 'SOCKS5 代理要求账号密码认证（代理地址请带 user:pass@）');
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail('SOCKS5 账号或密码错误');
        stage = 'connect'; chunks.length = 0; sendConnect();
      } else if (stage === 'connect') {
        if (buf.length < 2) return;
        const rep = buf[1];
        if (rep !== 0) {
          const msgs = { 1: '一般性失败', 2: '规则不允许', 3: '网络不可达', 4: '目标主机不可达', 5: '连接被拒绝', 6: 'TTL 超时', 7: '命令不支持', 8: '目标地址类型不支持' };
          return fail(`SOCKS5 连接目标失败：${msgs[rep] || '错误码 ' + rep}`);
        }
        socket.setTimeout(0);
        socket.off('data', onData);
        socket.off('error', fail);
        socket.off('timeout', onTimeout);
        resolve(socket);
      }
    };
    socket.on('data', onData);
    socket.on('error', (e) => fail(`SOCKS5 连接失败：${e.message}`));
    socket.on('timeout', onTimeout);
    socket.write(creds ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  });
}

function requestViaProxy(proxyStr, target, { method, headers, body, timeout }) {
  const proxy = new URL(proxyStr);
  const scheme = proxy.protocol.replace(':', '');
  const isSocks = scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks';
  const openTunnel = () => (isSocks
    ? connectThroughSocks5(proxy, target, timeout)
    : connectThroughHttpProxy(proxy, target, timeout));

  return openTunnel().then((socket) => new Promise((resolve, reject) => {
    let tlsSocket = null;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { tlsSocket?.destroy(); } catch { /* 忽略 */ }
        reject(err);
      } else {
        resolve(value);
      }
    };

    // https 目标在隧道上套 TLS；http 目标直接在隧道上发明文 HTTP。
    const writeRequest = () => {
      const payload = body ? String(body) : '';
      const lines = [
        `${method} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.hostname}`,
      ];
      for (const [key, value] of Object.entries(headers)) {
        if (/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(key)) continue;
        if (Array.isArray(value)) value.forEach((v) => lines.push(`${key}: ${v}`));
        else lines.push(`${key}: ${value}`);
      }
      if (payload) lines.push(`Content-Length: ${Buffer.byteLength(payload)}`);
      lines.push('Accept-Encoding: identity');
      lines.push('Connection: close');
      active.write(lines.join('\r\n') + '\r\n\r\n');
      if (payload) active.write(payload);
    };
    let active = socket;
    const chunks = [];
    const onData = (c) => {
      if (settled) return;
      chunks.push(c);
      // 响应头完整且 body 达到 Content-Length（或 chunked 终止块到达）即提前完成，
      // 不依赖服务器响应 Connection: close
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = buf.slice(0, sep).toString('latin1');
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        if (buf.slice(sep + 4).toString('latin1').endsWith('0\r\n\r\n')) {
          try { finish(null, parseTunnelResponse(buf)); } catch (err) { finish(err); }
        }
        return;
      }
      const cl = /content-length:\s*(\d+)/i.exec(head);
      if (cl && buf.length >= sep + 4 + Number(cl[1])) {
        try { finish(null, parseTunnelResponse(buf)); } catch (err) { finish(err); }
      }
    };
    const onError = (err) => finish(err);
    const onTimeout = () => finish(new Error(`请求超时（${timeout}ms）`));
    const onEnd = () => {
      try { finish(null, parseTunnelResponse(Buffer.concat(chunks))); } catch (err) { finish(err); }
    };
    const onClose = () => {
      if (!settled) {
        try { finish(null, parseTunnelResponse(Buffer.concat(chunks))); } catch (err) { finish(err); }
      }
    };
    if (target.protocol === 'https:') {
      tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      active = tlsSocket;
      tlsSocket.on('secureConnect', writeRequest);
    } else {
      writeRequest();
    }
    active.on('data', onData);
    active.on('error', onError);
    active.setTimeout(timeout, onTimeout);
    active.on('end', onEnd);
    active.on('close', onClose);
  }));
}

export async function requestRaw(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MS, retries = 1 } = {}) {
  const target = new URL(url);
  const payload = body === undefined || body === null ? '' : String(body);
  const finalHeaders = { ...headers };
  if (payload) finalHeaders['content-length'] = Buffer.byteLength(payload);
  else if (method === 'POST') finalHeaders['content-length'] = '0';

  // 按交易所分流：EXCHANGE_PROXY_HOSTS 列出的域名（后缀匹配）强制走 EXCHANGE_PROXY，
  // 其余域名若直连被拒（地区封锁/风控页），自动改走 EXCHANGE_PROXY 并记住该域名。
  // 配置来源：设置页（meta，经 store 注册的 provider）优先，env 兜底。
  const { proxy: exchangeProxy, hosts: forcedHostsRaw } = exchangeProxyConfig();
  const forcedHosts = (forcedHostsRaw || '').split(/[,\s;]+/).filter(Boolean);
  const isForced = exchangeProxy && forcedHosts.some((s) => hostMatchesSuffix(target.hostname, s));
  const isAdaptive = exchangeProxy && !isForced && adaptiveProxied.has(target.hostname);

  let proxy = '';
  if (isForced || isAdaptive) proxy = exchangeProxy;
  else if (target.protocol === 'https:') proxy = await resolveProxy(target.hostname);
  const attemptWith = (p) => {
    const run = () => (p
      ? requestViaProxy(new URL(p), target, { method, headers: finalHeaders, body: payload, timeout })
      : requestDirect(target, { method, headers: finalHeaders, body: payload, timeout }));
    return (async () => {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await run();
          if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          return res;
        } catch (err) {
          lastErr = err;
          if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      throw lastErr;
    })();
  };

  let res;
  let hadError = false;
  try {
    res = await attemptWith(proxy);
  } catch (err) {
    hadError = true;
    res = err; // 供下方回退判断使用
  }

  // 本机出口无法访问（网络失败或地区封锁/风控页）且有备用代理：切换重试并记住域名。
  // 本地地址不走回退。
  const canFallback = exchangeProxy && proxy !== exchangeProxy && !isForced && !isAdaptive
    && !isLocalHost(target.hostname)
    && (hadError || wantsFallback(res));
  if (canFallback) {
    try {
      const res2 = await attemptWith(exchangeProxy);
      adaptiveProxied.add(target.hostname);
      console.warn(`[http] ${target.hostname} 本机出口无法访问，已自动改走 EXCHANGE_PROXY`);
      if (hadError) return res2;
      if (!wantsFallback(res2)) return res2;
      return res; // 代理出口同样被拒，返回直连原结果
    } catch { if (hadError) throw res; /* 保留直连原结果 */ }
  }
  if (hadError) throw res;
  return res;
}

export async function requestJson(url, options = {}) {
  const res = await requestRaw(url, options);
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* 非 JSON */ }
  if (res.status < 200 || res.status >= 300) {
    const snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 240);
    const err = new Error(`HTTP ${res.status}${snippet ? `：${snippet}` : ''}`);
    err.status = res.status;
    err.body = res.text;
    throw err;
  }
  return { ...res, json };
}
