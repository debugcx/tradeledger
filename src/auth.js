/**
 * 单密码认证与会话。
 *
 * - 密码只存在于环境变量；不落库。
 * - 会话 token 随机 32 字节，数据库只存 SHA-256 哈希。
 * - 同一 IP 连续失败 10 次锁 5 分钟（进程内计数，单用户足够）。
 */

import crypto from 'node:crypto';
import { config } from './config.js';
import { parseCookies, safeEqual, nowIso } from './http.js';
import * as store from './store.js';

const MAX_FAILURES = 10;
const LOCK_MS = 5 * 60 * 1000;
const failures = new Map();

export function isDevPassword() {
  return !config.passwordFromEnv;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function rateLimit(ip) {
  const key = String(ip || 'local');
  const entry = failures.get(key);
  if (!entry) return { blocked: false };
  if (entry.until && entry.until > Date.now()) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.until - Date.now()) / 1000) };
  }
  return { blocked: false };
}

export function recordFailure(ip) {
  const key = String(ip || 'local');
  const entry = failures.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.until = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  failures.set(key, entry);
}

export function clearFailures(ip) {
  failures.delete(String(ip || 'local'));
}

export function verifyPassword(input) {
  return safeEqual(input, config.password);
}

export function login({ remember = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = remember ? config.rememberDays : config.sessionDays;
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  store.purgeExpiredSessions();
  store.createSession(hashToken(token), expiresAt);
  return { token, expiresAt, maxAge: days * 86400, remember };
}

export function cookieFor(token, maxAge, secure = false) {
  const parts = [
    `${config.sessionCookie}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${config.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers.get('cookie') || '');
  return cookies[config.sessionCookie] || '';
}

export function currentUser(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const session = store.getSession(hashToken(token));
  if (!session) return null;
  if (session.expires_at < nowIso()) {
    store.deleteSession(session.token_hash);
    return null;
  }
  return {
    id: 1,
    username: 'owner',
    display_name: store.getMeta('display_name', 'Owner') || 'Owner',
    bio: store.getMeta('bio', '') || '',
  };
}

export function logout(req) {
  const token = tokenFromRequest(req);
  if (token) store.deleteSession(hashToken(token));
}
