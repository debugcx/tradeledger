/**
 * 面向交易所 API 的 HTTP 客户端。
 *
 * - 优先使用 HTTPS_PROXY / HTTP_PROXY；
 * - 未配置时自动探测本机常见代理端口（7890/7897/10809/1080），
 *   避免国内网络直连交易所超时；可用 TRADELEDGER_AUTO_PROXY=0 关闭；
 * - 本地地址（localhost / 内网）永远直连，不经过代理；
 * - 429 / 5xx 自动重试一次；
 * - 返回 { status, headers, text, json }。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const TIMEOUT_MS = 15_000;
const PROXY_CANDIDATES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080',
];
let proxyCache = { value: undefined, at: 0 };
const PROXY_TTL = 60_000;

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
      console.warn(`[http] 未配置 HTTPS_PROXY，自动使用本地代理 ${candidate}`);
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

function requestViaProxy(proxy, target, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
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
        finish(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }

      // CONNECT 只建立了到目标的 TCP 隧道；HTTPS 必须再套一层 TLS。
      // 这里直接在这条 TLS 流上手写 HTTP/1.1，避免 Agent 重复 connect 导致挂起。
      tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      const chunks = [];
      tlsSocket.on('data', (c) => { if (!settled) chunks.push(c); });
      tlsSocket.on('error', (err) => finish(err));
      tlsSocket.setTimeout(timeout, () => finish(new Error(`请求超时（${timeout}ms）`)));
      tlsSocket.on('end', () => {
        try { finish(null, parseTunnelResponse(Buffer.concat(chunks))); } catch (err) { finish(err); }
      });
      tlsSocket.on('close', () => {
        if (!settled) {
          try { finish(null, parseTunnelResponse(Buffer.concat(chunks))); } catch (err) { finish(err); }
        }
      });
      tlsSocket.on('secureConnect', () => {
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
        tlsSocket.write(lines.join('\r\n') + '\r\n\r\n');
        if (payload) tlsSocket.write(payload);
      });
    });
    connectReq.on('timeout', () => {
      connectReq.destroy();
      finish(new Error(`代理连接超时（${timeout}ms）`));
    });
    connectReq.on('error', (err) => finish(err));
    connectReq.end();
  });
}

export async function requestRaw(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MS, retries = 1 } = {}) {
  const target = new URL(url);
  const payload = body === undefined || body === null ? '' : String(body);
  const finalHeaders = { ...headers };
  if (payload) finalHeaders['content-length'] = Buffer.byteLength(payload);
  else if (method === 'POST') finalHeaders['content-length'] = '0';

  const proxy = target.protocol === 'http:' ? '' : await resolveProxy(target.hostname);
  const run = () => (proxy
    ? requestViaProxy(new URL(proxy), target, { method, headers: finalHeaders, body: payload, timeout })
    : requestDirect(target, { method, headers: finalHeaders, body: payload, timeout }));

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
