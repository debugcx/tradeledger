/**
 * Node HTTP 入口：node:http ⇄ Web Request/Response，静态资源 + 路由。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { config } from './config.js';
import { passwordStartupError } from './startup.js';
import { isLoopbackPeer } from './client-ip.js';
import { applyPendingRestore } from './restore.js';
import { installFileLogging, startLogCleanup } from './logger.js';

// 日志：同时落盘 data/logs（按天分文件，默认保留 10 天，启动时与每 6 小时清理）
installFileLogging();
startLogCleanup();

// 必须在 db.js 打开数据库之前替换 pending 恢复文件
const restoreResult = applyPendingRestore();

const { handle } = await import('./routes.js');
const { seed } = await import('./seed.js');
const { closeDb } = await import('./db.js');
const { startSyncWorker, stopSyncWorker, isSyncBusy } = await import('./sync-worker.js');
const { refreshLive } = await import('./live.js');
const { startAssetWorker, stopAssetWorker, isAssetBusy } = await import('./asset-worker.js');
const { startBackupWorker, stopBackupWorker, isBackupBusy } = await import('./backup-worker.js');
const { finishPendingRestore } = await import('./backup.js');

if (restoreResult?.ok) {
  finishPendingRestore();
  console.log(`[restore] 已应用待恢复备份${restoreResult.preRestore ? `；恢复前数据库保存在 ${restoreResult.preRestore}` : ''}`);
} else if (restoreResult && !restoreResult.ok) {
  console.error(`[restore] 恢复失败，继续使用当前数据库：${restoreResult.error}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 页面没有外部脚本/样式/字体；内联 script/style 仍需 unsafe-inline（对账面板等）。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function isHttpsRequest(req) {
  if (req.socket?.encrypted) return true;
  const trusted = process.env.TRUST_PROXY === '1' || isLoopbackPeer(req.socket?.remoteAddress);
  if (!trusted) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function applySecurityHeaders(req, res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), camera=(), microphone=()');
  if (isHttpsRequest(req)) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return false;
  const file = path.join(config.publicDir, rel);
  if (!file.startsWith(config.publicDir)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  applySecurityHeaders(req, res);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  // stat 与 open 之间文件可能被删/改权限（如备份恢复操作 data 目录），不能让流错误炸掉进程
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

function toWebRequest(req) {
  const host = req.headers.host || `${config.host}:${config.port}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  // 覆盖同名入站头，路由层用真实 TCP 对端判断是否采信代理头。
  headers.set('x-tl-remote-ip', req.socket?.remoteAddress || '');
  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? Readable.toWeb(req) : undefined;
  return new Request(url, { method, headers, body, duplex: 'half' });
}

async function writeWebResponse(req, res, response) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  applySecurityHeaders(req, res);
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
    const response = await handle(toWebRequest(req));
    await writeWebResponse(req, res, response);
  } catch (err) {
    console.error('[server]', req.method, pathname, err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('服务器内部错误');
  }
});

const passwordError = passwordStartupError(config);
if (passwordError) {
  console.error(`[config] ${passwordError}`);
  process.exit(1);
}

const masterFromEnv = process.env.TRADELEDGER_MASTER_KEY;
if (masterFromEnv === 'replace-with-64-hex-chars' || masterFromEnv === 'change-me') {
  console.error('[config] TRADELEDGER_MASTER_KEY 仍是示例值，请设置真实密钥（openssl rand -hex 32）后再启动');
  process.exit(1);
}

if (config.seedDemo && !fs.existsSync(config.dbFile)) {
  try {
    seed({ quiet: true });
  } catch (err) {
    console.error('[seed] 初始化失败：', err?.message || err);
  }
}

// 一次性迁移：现货记录从旧逐手 FIFO 配对重算为「T 回合 + FIFO」（幂等，meta 标记防重跑）
try {
  const { migrateSpotRoundsOnce } = await import('./store.js');
  const migrated = migrateSpotRoundsOnce();
  if (migrated) {
    console.log(`[migrate] 现货 T 回合重算：${migrated.accounts} 个账户，新增 ${migrated.inserted} 条，清理 ${migrated.pruned} 条旧记录`);
  }
} catch (err) {
  console.error('[migrate] 现货 T 回合重算失败：', err?.message || err);
}

let liveTimer = null;
let liveKick = null;

server.listen(config.port, config.host, () => {
  console.log('\n  TradeLedger 已启动');
  console.log(`  ➜ http://${config.host}:${config.port}`);
  console.log(`  ➜ 访问密码：${config.passwordFromEnv ? '（来自环境变量）' : 'demo1234（开发回退，请配置 TRADELEDGER_PASSWORD）'}`);
  console.log(`  ➜ 数据库：${config.dbFile}`);

  // 账户加进来就自动回溯历史；关掉页面也会继续
  startSyncWorker();
  // 本地快照 + WebDAV 自动备份
  startBackupWorker();
  // 资产总览：交易所账内资产 + 链上钱包（按各自 TTL 刷新）
  startAssetWorker();
  // 定时刷新余额 / 持仓 / 资金费率
  if (config.liveRefreshSeconds > 0) {
    liveTimer = setInterval(() => {
      refreshLive({ force: true }).catch((err) => console.error('[live]', err?.message || err));
    }, config.liveRefreshSeconds * 1000);
    liveTimer.unref();
    liveKick = setTimeout(() => {
      refreshLive({ force: true }).catch((err) => console.error('[live]', err?.message || err));
    }, 2500);
    liveKick.unref();
  }
  console.log(`  ➜ 后台同步：每 ${config.syncWorkerSeconds}s · 实时持仓：每 ${config.liveRefreshSeconds}s · 资产：交易所 ${config.assetRefreshMinutes}min / 钱包 ${config.walletRefreshMinutes}min\n`);
});

let shuttingDown = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭…`);

  // 先停定时器，避免关闭过程中再发起新的同步/刷新。
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (liveKick) { clearTimeout(liveKick); liveKick = null; }
  try { stopSyncWorker(); stopBackupWorker(); stopAssetWorker(); } catch { /* 尚未启动时忽略 */ }

  const closed = new Promise((resolve) => {
    server.close(resolve);
    // 不无限等待 keep-alive 空闲连接。
    setTimeout(() => { try { server.closeAllConnections?.(); } catch { /* 忽略 */ } }, 1500).unref();
  });
  await Promise.race([closed, sleep(4000)]);

  // 给在途同步/资产/备份任务最多 3 秒收尾，避免在事务中途关闭 SQLite。
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (isSyncBusy() || isAssetBusy() || isBackupBusy())) {
    await sleep(100);
  }

  try { closeDb(); } catch { /* 已关闭 */ }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
