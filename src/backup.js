/**
 * 完整备份：SQLite 快照 + 可选加密压缩 + WebDAV 上传 / 恢复。
 *
 * 为什么用 VACUUM INTO：
 *   - WAL 模式下直接复制 .db 可能漏掉尚未 checkpoint 的数据；
 *   - VACUUM INTO 会生成一个一致的、已整理过的数据库副本。
 *
 * 笔记图片存放在 resources.data（BLOB），因此快照天然包含图片，
 * 不需要额外同步 uploads 目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

import { config } from './config.js';
import * as store from './store.js';
import { vacuumInto } from './db.js';
import { fmtBytes } from './http.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { pendingRestoreFile } from './restore.js';
import { chunkBuffer } from './chunker.js';

const LOCAL_RE = /^tradeledger-\d{8}-\d{6}(?:-\d+)?\.db$/;
const REMOTE_RE = /^tradeledger-\d{8}-\d{6}(?:-\d+)?\.db\.gz(?:\.enc)?$/;
// 增量备份：逻辑名沿用快照名，后缀 .db.chunks；分块存在远端 chunks/<sha256> 下
const CHUNKED_RE = /^tradeledger-\d{8}-\d{6}(?:-\d+)?\.db\.chunks$/;
const CHUNK_DIR = 'chunks';
const CHUNK_HASH_RE = /^[a-f0-9]{64}$/;
const MAGIC = Buffer.from('TLBK1');
const WEBDAV_TIMEOUT_MS = 30000;

/* ---------------- 小工具 ---------------- */

const pad = (n) => String(n).padStart(2, '0');

function stampNow(date = new Date()) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// 格式化统一走 http.js（原实现精度与页面展示不一致，已合并）
export { fmtBytes };

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function ensureBackupDir() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  return config.backupDir;
}

function localPath(name) {
  return path.join(config.backupDir, name);
}

/* ---------------- 本地快照 ---------------- */

export function listLocalBackups() {
  ensureBackupDir();
  return fs.readdirSync(config.backupDir)
    .filter((name) => LOCAL_RE.test(name))
    .map((name) => {
      const st = fs.statSync(localPath(name));
      return { name, bytes: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function inspectSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error(`快照完整性校验失败：${integrity || 'unknown'}`);
    const trades = db.prepare('SELECT COUNT(*) AS c FROM trades').get()?.c || 0;
    const resources = db.prepare('SELECT COUNT(*) AS c FROM resources').get()?.c || 0;
    return { integrity, trades, resources };
  } finally {
    db.close();
  }
}

export function createLocalSnapshot(reason = 'manual') {
  ensureBackupDir();
  const base = `tradeledger-${stampNow()}`;
  let name = `${base}.db`;
  for (let i = 2; fs.existsSync(localPath(name)); i++) name = `${base}-${i}.db`;
  const file = localPath(name);
  try {
    vacuumInto(file);
    const info = inspectSnapshot(file);
    const bytes = fs.statSync(file).size;
    const created_at = new Date().toISOString();
    store.setMeta('backup_last_local_at', created_at);
    store.setMeta('backup_last_local_name', name);
    pruneLocalSnapshots();
    return { name, file, bytes, created_at, reason, ...info };
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    throw err;
  }
}

export function resolveLocalSnapshot(name) {
  const n = String(name || '');
  if (!LOCAL_RE.test(n)) throw new Error('备份文件名不合法');
  const file = path.resolve(config.backupDir, n);
  if (path.dirname(file) !== path.resolve(config.backupDir)) throw new Error('备份路径不合法');
  if (!fs.existsSync(file)) throw new Error('本地备份不存在');
  return file;
}

export function deleteLocalSnapshot(name) {
  const file = resolveLocalSnapshot(name);
  fs.unlinkSync(file);
  return true;
}

export function pruneLocalSnapshots(keep = getBackupConfig().localKeep) {
  const files = listLocalBackups();
  const max = clampInt(keep, 1, 100, 14);
  for (const f of files.slice(max)) {
    try { fs.unlinkSync(localPath(f.name)); } catch { /* 忽略 */ }
  }
}

function latestFreshSnapshot(maxAgeMs = 60_000) {
  const files = listLocalBackups();
  if (!files.length) return null;
  const newest = files[0];
  const age = Date.now() - Date.parse(newest.created_at);
  if (!Number.isFinite(age) || age > maxAgeMs) return null;
  return { ...newest, file: localPath(newest.name) };
}

/* ---------------- 加密 / 压缩 ---------------- */

export function encryptBuffer(buffer, passphrase) {
  const pass = String(passphrase || '');
  if (pass.length < 8) throw new Error('备份密码至少 8 位');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(payload, passphrase) {
  const min = MAGIC.length + 16 + 12 + 16;
  if (!Buffer.isBuffer(payload) || payload.length < min || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('备份文件格式不正确');
  }
  let offset = MAGIC.length;
  const salt = payload.subarray(offset, offset + 16); offset += 16;
  const iv = payload.subarray(offset, offset + 12); offset += 12;
  const tag = payload.subarray(offset, offset + 16); offset += 16;
  const body = payload.subarray(offset);
  const key = crypto.scryptSync(String(passphrase || ''), salt, 32);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('备份密码错误或文件已损坏');
  }
}

/* ---------------- 配置 ---------------- */

export function getBackupConfig() {
  const flag = (key, fallback) => store.getMeta(key, fallback ? '1' : '0') === '1';
  return {
    localEnabled: flag('backup_local_enabled', true),
    localIntervalHours: clampInt(store.getMeta('backup_local_interval_hours', '24'), 1, 720, 24),
    localKeep: clampInt(store.getMeta('backup_local_keep', '14'), 1, 100, 14),

    webdavEnabled: flag('backup_webdav_enabled', false),
    webdavUrl: store.getMeta('backup_webdav_url', ''),
    webdavUsername: store.getMeta('backup_webdav_username', ''),
    hasWebdavPassword: Boolean(store.getMeta('backup_webdav_password_enc', '')),
    webdavDir: store.getMeta('backup_webdav_dir', 'TradeLedger'),
    intervalHours: clampInt(store.getMeta('backup_interval_hours', '24'), 1, 720, 24),
    keep: clampInt(store.getMeta('backup_keep', '14'), 1, 100, 14),
    backupMode: store.getMeta('backup_mode', 'incremental') === 'full' ? 'full' : 'incremental',
    hasPassphrase: Boolean(store.getMeta('backup_passphrase_enc', '')),

    lastLocalAt: store.getMeta('backup_last_local_at', ''),
    lastLocalName: store.getMeta('backup_last_local_name', ''),
    lastRemoteAt: store.getMeta('backup_last_remote_at', ''),
    lastRemoteAttemptAt: store.getMeta('backup_last_remote_attempt_at', ''),
    lastRemoteStatus: store.getMeta('backup_last_remote_status', ''),
    lastRemoteMessage: store.getMeta('backup_last_remote_message', ''),

    pending: pendingRestoreInfo(),
  };
}

export function saveBackupConfig(input = {}) {
  const warnings = [];
  const enabled = Boolean(input.webdavEnabled);
  const url = String(input.webdavUrl ?? '').trim().replace(/\/+$/, '');
  const dir = String(input.webdavDir ?? '').trim().replace(/^\/+|\/+$/g, '') || 'TradeLedger';
  const username = String(input.webdavUsername ?? '').trim();

  if (url) {
    if (url.length > 500) throw new Error('WebDAV 地址过长');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('WebDAV 地址格式不正确'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('WebDAV 地址只支持 http / https');
    if (parsed.search || parsed.hash) throw new Error('WebDAV 地址不要带查询参数或 # 片段');
  }
  if (enabled && !url) throw new Error('启用 WebDAV 备份前请填写地址');
  if (dir.length > 200) throw new Error('远端目录过长');
  if (dir.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error('远端目录不能包含 . 或 ..');
  if (username.length > 200) throw new Error('WebDAV 用户名过长');

  const intervalHours = clampInt(input.intervalHours, 1, 720, 24);
  const keep = clampInt(input.keep, 1, 100, 14);
  const localIntervalHours = clampInt(input.localIntervalHours, 1, 720, 24);
  const localKeep = clampInt(input.localKeep, 1, 100, 14);

  store.setMeta('backup_local_enabled', input.localEnabled === false ? '0' : '1');
  store.setMeta('backup_local_interval_hours', String(localIntervalHours));
  store.setMeta('backup_local_keep', String(localKeep));
  store.setMeta('backup_webdav_enabled', enabled ? '1' : '0');
  store.setMeta('backup_webdav_url', url);
  store.setMeta('backup_webdav_username', username);
  store.setMeta('backup_webdav_dir', dir);
  store.setMeta('backup_interval_hours', String(intervalHours));
  store.setMeta('backup_keep', String(keep));
  // 默认增量（分块去重）；显式选 full 才每次上传整包
  store.setMeta('backup_mode', input.backupMode === 'full' ? 'full' : 'incremental');

  if (input.clearWebdavPassword) store.setMeta('backup_webdav_password_enc', '');
  if (input.webdavPassword) {
    store.setMeta('backup_webdav_password_enc', encryptSecret(String(input.webdavPassword)));
  }
  if (input.clearPassphrase) store.setMeta('backup_passphrase_enc', '');
  if (input.passphrase) {
    const pass = String(input.passphrase);
    if (pass.length < 8) throw new Error('备份密码至少 8 位');
    store.setMeta('backup_passphrase_enc', encryptSecret(pass));
  }

  const cfg = getBackupConfig();
  if (cfg.webdavEnabled && !cfg.hasWebdavPassword) warnings.push('未填写 WebDAV 密码（仅适用于匿名或免认证服务）');
  if (cfg.webdavEnabled && !cfg.hasPassphrase) warnings.push('未设置备份密码：上传到 WebDAV 的压缩包未加密');
  return { warnings };
}

function webdavCredentials() {
  const cfg = getBackupConfig();
  let password = '';
  let passphrase = '';
  const passEnc = store.getMeta('backup_webdav_password_enc', '');
  if (passEnc) {
    try { password = decryptSecret(passEnc); } catch { throw new Error('WebDAV 密码无法解密，请在设置页重新填写'); }
  }
  const phraseEnc = store.getMeta('backup_passphrase_enc', '');
  if (phraseEnc) {
    try { passphrase = decryptSecret(phraseEnc); } catch { throw new Error('备份密码无法解密，请在设置页重新填写'); }
  }
  return { ...cfg, username: cfg.webdavUsername, password, passphrase };
}

/* ---------------- WebDAV ---------------- */

function baseUrl(creds) {
  return new URL(creds.webdavUrl);
}

function appendPath(base, ...parts) {
  const u = new URL(base);
  let p = u.pathname.replace(/\/+$/, '');
  for (const part of parts) {
    for (const seg of String(part).split('/').filter(Boolean)) p += '/' + encodeURIComponent(seg);
  }
  u.pathname = p;
  u.search = '';
  u.hash = '';
  return u.toString();
}

function davError(res, action) {
  if (res.status === 401) return new Error('WebDAV 认证失败：请检查用户名/密码（坚果云、Nextcloud 需使用应用密码）');
  if (res.status === 403) return new Error('WebDAV 拒绝访问：请检查目录权限');
  if (res.status === 404) return new Error(`WebDAV 路径不存在：${action}`);
  if (res.status === 409) return new Error('WebDAV 目录不存在或无法创建，请检查地址和远端目录');
  if (res.status === 507) return new Error('WebDAV 空间不足');
  return new Error(`WebDAV ${action}失败：HTTP ${res.status}`);
}

async function davRequest(url, { method = 'GET', body, headers = {} } = {}, creds) {
  const h = { ...headers };
  const username = creds.username || creds.webdavUsername || '';
  if (username) {
    h.authorization = 'Basic ' + Buffer.from(`${username}:${creds.password}`).toString('base64');
  }
  try {
    return await fetch(url, {
      method,
      headers: h,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(WEBDAV_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('连接 WebDAV 超时（30 秒）');
    throw new Error(`无法连接 WebDAV：${err?.message || err}`);
  }
}

async function ensureRemoteDir(creds) {
  if (!creds.webdavUrl) throw new Error('尚未配置 WebDAV 地址');
  let url = baseUrl(creds).toString().replace(/\/+$/, '');
  for (const seg of creds.webdavDir.split('/').filter(Boolean)) {
    url += '/' + encodeURIComponent(seg);
    const res = await davRequest(url, { method: 'MKCOL' }, creds);
    if (![200, 201, 204, 301, 302, 405].includes(res.status)) throw davError(res, '创建目录');
  }
  return url;
}

/** WebDAV 的 PUT 不会自动建父目录：分块上传前先确保 chunks/ 存在 */
async function ensureRemoteSubdir(dir, name, creds) {
  const url = appendPath(dir, name);
  const res = await davRequest(url, { method: 'MKCOL' }, creds);
  if (![200, 201, 204, 301, 302, 405].includes(res.status)) throw davError(res, '创建目录');
  return url;
}

export async function testWebdavConnection() {
  const creds = webdavCredentials();
  if (!creds.webdavUrl) throw new Error('尚未配置 WebDAV 地址');
  const started = Date.now();
  const dir = await ensureRemoteDir(creds);
  const probe = appendPath(dir, `tradeledger-probe-${Date.now()}.txt`);
  const body = Buffer.from(`TradeLedger WebDAV test ${new Date().toISOString()}\n`, 'utf8');

  let res = await davRequest(probe, {
    method: 'PUT',
    body,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  }, creds);
  if (!res.ok) throw davError(res, '写入测试文件');

  res = await davRequest(probe, { method: 'GET' }, creds);
  if (!res.ok) throw davError(res, '读取测试文件');
  const got = Buffer.from(await res.arrayBuffer());
  if (!got.equals(body)) throw new Error('WebDAV 读回内容与写入不一致');

  await davRequest(probe, { method: 'DELETE' }, creds).catch(() => {});
  return { ms: Date.now() - started, dir };
}

function manifestUrl(dir) {
  return appendPath(dir, 'manifest.json');
}

async function readManifest(dir, creds) {
  const res = await davRequest(manifestUrl(dir), { method: 'GET' }, creds);
  if (res.status === 404) return { version: 1, updated_at: null, files: [] };
  if (!res.ok) throw davError(res, '读取备份清单');
  try {
    const data = JSON.parse(await res.text());
    if (!Array.isArray(data.files)) data.files = [];
    return data;
  } catch {
    throw new Error('远端备份清单损坏（manifest.json）');
  }
}

async function writeManifest(dir, manifest, creds) {
  const res = await davRequest(manifestUrl(dir), {
    method: 'PUT',
    body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }, creds);
  if (!res.ok) throw davError(res, '写入备份清单');
}

export async function listRemoteBackups() {
  const creds = webdavCredentials();
  if (!creds.webdavUrl) throw new Error('尚未配置 WebDAV 地址');
  const dir = await ensureRemoteDir(creds);
  const manifest = await readManifest(dir, creds);
  const files = manifest.files
    .filter((f) => {
      const name = String(f?.name || '');
      return f?.format === 'chunked' ? CHUNKED_RE.test(name) : REMOTE_RE.test(name);
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { dir, files };
}

let remoteRunning = false;

/** 完整模式：整包 gzip（可选加密）后 PUT 单个文件 */
async function uploadFull(dir, snap, creds, uploadedAt) {
  const raw = fs.readFileSync(snap.file);
  let payload = zlib.gzipSync(raw, { level: 9 });
  let encrypted = false;
  if (creds.passphrase) {
    payload = encryptBuffer(payload, creds.passphrase);
    encrypted = true;
  }
  const name = snap.name.replace(/\.db$/, encrypted ? '.db.gz.enc' : '.db.gz');
  const res = await davRequest(appendPath(dir, name), {
    method: 'PUT',
    body: payload,
    headers: { 'content-type': 'application/octet-stream' },
  }, creds);
  if (!res.ok) throw davError(res, '上传备份');
  return {
    entry: { name, bytes: payload.length, sha256: sha256Hex(payload), created_at: uploadedAt, encrypted, source: snap.name },
    uploadedBytes: payload.length,
  };
}

/**
 * 增量模式：快照按内容分块，只上传清单里没有的块。
 * 块名 = 明文 SHA-256；块内容 = gzip(明文) [+ AES-GCM]。恢复时逐块校验再拼接。
 */
async function uploadChunked(dir, snap, creds, manifest, uploadedAt) {
  const raw = fs.readFileSync(snap.file);
  const parts = chunkBuffer(raw);
  await ensureRemoteSubdir(dir, CHUNK_DIR, creds);
  const known = new Map(); // 明文 hash → 已存大小
  for (const f of manifest.files) {
    for (const c of f.chunks || []) {
      if (c?.h && CHUNK_HASH_RE.test(String(c.h))) known.set(c.h, Number(c.s) || 0);
    }
  }
  const chunks = [];
  let uploaded = 0;
  let reused = 0;
  let uploadedBytes = 0;
  for (const part of parts) {
    const h = sha256Hex(part);
    if (known.has(h)) {
      chunks.push({ h, n: part.length, s: known.get(h) });
      reused++;
      continue;
    }
    let stored = zlib.gzipSync(part, { level: 9 });
    if (creds.passphrase) stored = encryptBuffer(stored, creds.passphrase);
    const res = await davRequest(appendPath(dir, CHUNK_DIR, h), {
      method: 'PUT',
      body: stored,
      headers: { 'content-type': 'application/octet-stream' },
    }, creds);
    if (!res.ok) throw davError(res, '上传备份分块');
    chunks.push({ h, n: part.length, s: stored.length });
    known.set(h, stored.length);
    uploaded++;
    uploadedBytes += stored.length;
  }
  const entry = {
    name: snap.name.replace(/\.db$/, '.db.chunks'),
    format: 'chunked',
    bytes: raw.length,
    stored_bytes: chunks.reduce((acc, c) => acc + (Number(c.s) || 0), 0),
    sha256: sha256Hex(raw),
    created_at: uploadedAt,
    encrypted: Boolean(creds.passphrase),
    chunks,
    source: snap.name,
  };
  return { entry, uploadedBytes, chunks: { total: chunks.length, uploaded, reused } };
}

/** 按 keep 裁剪远端清单：旧整包直接删文件，旧增量快照删掉不再被引用的分块 */
async function pruneRemoteEntries(dir, manifest, keep, creds) {
  const pruned = [];
  if (manifest.files.length <= keep) return pruned;
  const remaining = manifest.files.slice(0, keep);
  const removed = manifest.files.slice(keep);
  const referenced = new Set();
  for (const f of remaining) {
    for (const c of f.chunks || []) if (c?.h) referenced.add(c.h);
  }
  const dropChunks = new Set();
  for (const old of removed) {
    if (old.format === 'chunked') {
      for (const c of old.chunks || []) {
        if (c?.h && !referenced.has(c.h)) dropChunks.add(c.h);
      }
    } else {
      await davRequest(appendPath(dir, old.name), { method: 'DELETE' }, creds).catch(() => null);
    }
    pruned.push(old.name);
  }
  for (const h of dropChunks) {
    await davRequest(appendPath(dir, CHUNK_DIR, h), { method: 'DELETE' }, creds).catch(() => null);
  }
  manifest.files = remaining;
  return pruned;
}

export async function runRemoteBackup({ reason = 'manual' } = {}) {
  if (remoteRunning) throw new Error('已有备份任务在进行中');
  remoteRunning = true;
  try {
    const creds = webdavCredentials();
    if (!creds.webdavEnabled || !creds.webdavUrl) throw new Error('尚未启用 WebDAV 备份');
    const mode = creds.backupMode === 'full' ? 'full' : 'incremental';

    const snap = (reason === 'auto' ? latestFreshSnapshot() : null) || createLocalSnapshot(reason);
    const dir = await ensureRemoteDir(creds);
    const uploadedAt = new Date().toISOString();
    const manifest = await readManifest(dir, creds);

    const uploaded = mode === 'incremental'
      ? await uploadChunked(dir, snap, creds, manifest, uploadedAt)
      : await uploadFull(dir, snap, creds, uploadedAt);
    const entry = uploaded.entry;

    manifest.version = 2;
    manifest.updated_at = uploadedAt;
    manifest.files = [entry, ...manifest.files.filter((f) => f.name !== entry.name)];
    const pruned = await pruneRemoteEntries(dir, manifest, creds.keep, creds);
    await writeManifest(dir, manifest, creds);

    const sizeText = mode === 'incremental'
      ? `新增 ${uploaded.chunks.uploaded} 块 ${fmtBytes(uploaded.uploadedBytes)}，复用 ${uploaded.chunks.reused} 块（快照 ${fmtBytes(entry.bytes)}）`
      : fmtBytes(entry.bytes);
    store.setMeta('backup_last_remote_at', uploadedAt);
    store.setMeta('backup_last_remote_attempt_at', uploadedAt);
    store.setMeta('backup_last_remote_status', 'ok');
    store.setMeta('backup_last_remote_message', `${entry.name} · ${sizeText}${entry.encrypted ? ' · 已加密' : ''}`);
    return {
      ok: true,
      name: entry.name,
      bytes: entry.bytes,
      uploadedBytes: uploaded.uploadedBytes,
      encrypted: entry.encrypted,
      pruned,
      snapshot: snap,
      mode,
      chunks: uploaded.chunks || null,
    };
  } catch (err) {
    store.setMeta('backup_last_remote_attempt_at', new Date().toISOString());
    store.setMeta('backup_last_remote_status', 'error');
    store.setMeta('backup_last_remote_message', String(err?.message || err).slice(0, 500));
    throw err;
  } finally {
    remoteRunning = false;
  }
}

export async function downloadRemoteBackup(name) {
  const n = String(name || '');
  if (!REMOTE_RE.test(n) && !CHUNKED_RE.test(n)) throw new Error('远端备份文件名不合法');
  const creds = webdavCredentials();
  if (!creds.webdavUrl) throw new Error('尚未配置 WebDAV 地址');
  const dir = await ensureRemoteDir(creds);
  const manifest = await readManifest(dir, creds);
  const entry = manifest.files.find((f) => f.name === n);
  if (!entry) throw new Error('远端备份不存在或已被清理');

  if (entry.format === 'chunked') {
    if (entry.encrypted && !creds.passphrase) throw new Error('该备份已加密，请先在设置页填写备份密码');
    if (!Array.isArray(entry.chunks) || !entry.chunks.length) throw new Error('远端备份清单缺少分块信息');
    const parts = [];
    for (const c of entry.chunks) {
      const h = String(c?.h || '');
      if (!CHUNK_HASH_RE.test(h)) throw new Error('远端备份清单分块信息不合法');
      const res = await davRequest(appendPath(dir, CHUNK_DIR, h), { method: 'GET' }, creds);
      if (!res.ok) throw davError(res, '下载备份分块');
      let buf = Buffer.from(await res.arrayBuffer());
      if (entry.encrypted) buf = decryptBuffer(buf, creds.passphrase);
      try { buf = zlib.gunzipSync(buf); } catch { throw new Error('备份分块解压失败，文件可能已损坏'); }
      if (sha256Hex(buf) !== h) throw new Error('备份分块校验失败：内容与清单不一致');
      parts.push(buf);
    }
    const data = Buffer.concat(parts);
    if (data.length !== Number(entry.bytes) || sha256Hex(data) !== entry.sha256) {
      throw new Error('备份校验失败：分块重组后 SHA-256 不一致');
    }
    return { entry, buffer: data };
  }

  const res = await davRequest(appendPath(dir, n), { method: 'GET' }, creds);
  if (!res.ok) throw davError(res, '下载备份');
  const payload = Buffer.from(await res.arrayBuffer());
  if (entry.sha256 && sha256Hex(payload) !== entry.sha256) throw new Error('备份校验失败：SHA-256 不一致');

  let data = payload;
  if (n.endsWith('.enc')) {
    if (!creds.passphrase) throw new Error('该备份已加密，请先在设置页填写备份密码');
    data = decryptBuffer(data, creds.passphrase);
  }
  if (n.endsWith('.gz') || n.endsWith('.gz.enc')) {
    try { data = zlib.gunzipSync(data); } catch { throw new Error('备份解压失败，文件可能已损坏'); }
  }
  return { entry, buffer: data };
}

/* ---------------- 恢复 ---------------- */

export function stageRestoreBuffer(buffer, info = {}) {
  if (config.dbFile === ':memory:') throw new Error('内存数据库不支持恢复');
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
    throw new Error('不是有效的 SQLite 备份文件');
  }
  const pending = pendingRestoreFile();
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  const tmp = `${pending}.tmp`;
  fs.writeFileSync(tmp, buffer);
  try {
    inspectSnapshot(tmp);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw err;
  }
  fs.renameSync(tmp, pending);
  const meta = {
    ...info,
    at: new Date().toISOString(),
    bytes: buffer.length,
  };
  store.setMeta('backup_pending_restore', JSON.stringify(meta));
  return meta;
}

export function stageRestoreFromLocal(name) {
  const file = resolveLocalSnapshot(name);
  const buffer = fs.readFileSync(file);
  return stageRestoreBuffer(buffer, { name, source: 'local' });
}

export async function stageRestoreFromRemote(name) {
  const { entry, buffer } = await downloadRemoteBackup(name);
  return stageRestoreBuffer(buffer, {
    name,
    source: 'webdav',
    sha256: entry.sha256,
    created_at: entry.created_at,
    encrypted: Boolean(entry.encrypted),
  });
}

export function pendingRestoreInfo() {
  if (config.dbFile === ':memory:') return null;
  const raw = store.getMeta('backup_pending_restore', '');
  if (!raw) return null;
  try {
    const info = JSON.parse(raw);
    if (!info || !fs.existsSync(pendingRestoreFile())) return null;
    return info;
  } catch {
    return null;
  }
}

export function cancelPendingRestore() {
  try { fs.unlinkSync(pendingRestoreFile()); } catch { /* 忽略 */ }
  store.setMeta('backup_pending_restore', '');
}

/** 启动时已经应用完 pending 恢复，清掉恢复标记 */
export function finishPendingRestore() {
  store.setMeta('backup_pending_restore', '');
}
