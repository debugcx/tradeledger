/**
 * Agent 接入用的 API Token。
 *
 * - 明文形如 `tl_<base64url>`，只在创建时返回一次；库里只存 SHA-256。
 * - 只对 `/api/v1/*` 生效，不能代替登录 Cookie 访问页面/旧接口。
 * - 每次调用写一条 api_audit（保留 30 天），并做简单的内存限流。
 */

import crypto from 'node:crypto';
import { all, get, run } from './db.js';
import { nowIso } from './http.js';

const TOKEN_PREFIX = 'tl_';
const TOKEN_BYTES = 32;
const VALID_SCOPES = new Set(['read', 'write']);
const AUDIT_RETENTION_DAYS = 30;
const LAST_USED_THROTTLE_MS = 60_000;
// 失败认证按 IP 限流；成功调用按 Token 限流
const FAIL_LIMIT = 20;
const TOKEN_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

export function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** 权限归一化：write 隐式包含 read；未知值忽略，空值回退 read */
export function normalizeApiScopes(input) {
  const raw = Array.isArray(input) ? input : String(input || 'read').split(/[,\s]+/);
  const set = new Set();
  for (const item of raw) {
    const value = String(item || '').trim().toLowerCase();
    if (VALID_SCOPES.has(value)) set.add(value);
  }
  if (!set.size) set.add('read');
  if (set.has('write')) set.add('read');
  return [...set].sort().join(',');
}

export function parseApiScopes(scopes) {
  return String(scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const SAFE_TOKEN_COLUMNS = `id, name, hint, scopes, created_at, last_used_at, expires_at, revoked_at`;

export function listApiTokens() {
  return all(`SELECT ${SAFE_TOKEN_COLUMNS} FROM api_tokens ORDER BY id DESC`);
}

export function getApiToken(id) {
  return get(`SELECT ${SAFE_TOKEN_COLUMNS} FROM api_tokens WHERE id = ?`, Number(id)) || null;
}

/**
 * 创建 Token。返回值里的 `token` 是明文，调用方必须只展示一次。
 * expiresDays: 0/null = 永不过期。
 */
export function createApiToken({ name, scopes = 'read', expiresDays = null } = {}) {
  const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const cleanName = String(name || '').trim().slice(0, 60) || 'Agent Token';
  const scopeStr = normalizeApiScopes(scopes);
  const days = Number(expiresDays) || 0;
  const expiresAt = days > 0
    ? new Date(Date.now() + Math.min(Math.max(days, 1), 3650) * 86400_000).toISOString()
    : null;
  const hint = `${TOKEN_PREFIX}…${token.slice(-4)}`;
  const r = run(
    `INSERT INTO api_tokens (name, token_hash, hint, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    cleanName, hashApiToken(token), hint, scopeStr, nowIso(), expiresAt,
  );
  return { token, row: getApiToken(Number(r.lastInsertRowid)) };
}

export function revokeApiToken(id) {
  const r = run(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    nowIso(), Number(id),
  );
  return Number(r.changes) > 0;
}

export function tokenFromRequest(request) {
  const auth = String(request.headers.get('authorization') || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const headerKey = String(request.headers.get('x-api-key') || '').trim();
  return headerKey;
}

/**
 * 校验请求里的 Token。
 * 返回 { token, error }：token 非空即通过；error ∈ invalid | expired | revoked。
 */
export function verifyApiToken(request) {
  const raw = tokenFromRequest(request);
  if (!raw) return { token: null, error: null };
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length < 20) return { token: null, error: 'invalid' };
  const row = get('SELECT * FROM api_tokens WHERE token_hash = ?', hashApiToken(raw));
  if (!row) return { token: null, error: 'invalid' };
  if (row.revoked_at) return { token: null, error: 'revoked' };
  if (row.expires_at && row.expires_at <= nowIso()) return { token: null, error: 'expired' };
  // last_used_at 不需要每次请求都写，60 秒节流即可
  const last = Date.parse(row.last_used_at || '') || 0;
  if (!last || Date.now() - last > LAST_USED_THROTTLE_MS) {
    try { run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.id); } catch { /* 不影响请求 */ }
  }
  return {
    token: {
      id: Number(row.id),
      name: row.name,
      hint: row.hint,
      scopes: parseApiScopes(row.scopes),
      expires_at: row.expires_at || null,
      // 仅供服务端内部复用（/mcp 转发到 /api/v1）；不要在响应里序列化
      rawToken: raw,
    },
    error: null,
  };
}

export function hasApiScope(token, scope) {
  if (!token) return false;
  const scopes = Array.isArray(token.scopes) ? token.scopes : parseApiScopes(token.scopes);
  if (scopes.includes('write')) return true;
  return scopes.includes(String(scope || 'read'));
}

/* ---------------- 限流（单进程内存，够用且不引入依赖） ---------------- */

const buckets = new Map();

function takeLimit(key, limit) {
  const now = Date.now();
  const hit = buckets.get(key);
  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (buckets.size > 5000) {
      // 丢掉最早插入的一半，避免长期运行无限增长
      const drop = Math.min(1000, Math.floor(buckets.size / 2));
      let i = 0;
      for (const k of buckets.keys()) {
        buckets.delete(k);
        if (++i >= drop) break;
      }
    }
    return { ok: true, remaining: limit - 1 };
  }
  hit.count += 1;
  if (hit.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining: limit - hit.count };
}

export function checkApiAuthFailure(ip) {
  return takeLimit(`fail:${ip || 'unknown'}`, FAIL_LIMIT);
}

export function checkApiTokenRate(tokenId) {
  return takeLimit(`token:${Number(tokenId) || 0}`, TOKEN_LIMIT);
}

/* ---------------- 审计 ---------------- */

export function recordApiAudit({ tokenId = null, method = '', path = '', status = 0, ip = '', ms = 0 }) {
  try {
    run(
      `INSERT INTO api_audit (token_id, method, path, status, ip, ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      tokenId === null || tokenId === undefined ? null : Number(tokenId),
      String(method || '').slice(0, 10),
      String(path || '').slice(0, 300),
      Number(status) || 0,
      String(ip || '').slice(0, 80),
      Math.max(0, Math.round(Number(ms) || 0)),
      nowIso(),
    );
  } catch { /* 审计失败不影响业务 */ }
}

export function listApiAudit(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return all(
    `SELECT a.id, a.token_id, a.method, a.path, a.status, a.ip, a.ms, a.created_at,
            t.name AS token_name
       FROM api_audit a LEFT JOIN api_tokens t ON t.id = a.token_id
      ORDER BY a.id DESC LIMIT ?`,
    n,
  );
}

export function cleanupApiAudit() {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000).toISOString();
  try {
    return Number(run('DELETE FROM api_audit WHERE created_at < ?', cutoff).changes) || 0;
  } catch {
    return 0;
  }
}

let auditTimer = null;

export function startApiAuditCleanup() {
  cleanupApiAudit();
  if (auditTimer) return auditTimer;
  auditTimer = setInterval(cleanupApiAudit, 24 * 3600_000);
  auditTimer.unref();
  return auditTimer;
}
