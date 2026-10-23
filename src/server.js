/**
 * Node HTTP 入口：node:http ⇄ Web Request/Response，静态资源 + 路由。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { config } from './config.js';
import { applyPendingRestore } from './restore.js';

// 必须在 db.js 打开数据库之前替换 pending 恢复文件
const restoreResult = applyPendingRestore();

const { handle } = await import('./routes.js');
const { seed } = await import('./seed.js');
const { closeDb } = await import('./db.js');
const { startSyncWorker } = await import('./sync-worker.js');
const { refreshLive } = await import('./live.js');
const { startBackupWorker } = await import('./backup-worker.js');
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

function serveStatic(res, pathname) {
  const rel = pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return false;
  const file = path.join(config.publicDir, rel);
  if (!file.startsWith(config.publicDir)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
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
  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? Readable.toWeb(req) : undefined;
  return new Request(url, { method, headers, body, duplex: 'half' });
}

async function writeWebResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
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
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, pathname)) return;
    const response = await handle(toWebRequest(req));
    await writeWebResponse(res, response);
  } catch (err) {
    console.error('[server]', req.method, pathname, err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('服务器内部错误');
  }
});

const WEAK_PASSWORDS = new Set(['demo1234', 'change-me', 'change-me-to-a-long-random-password']);
if (config.passwordFromEnv && (WEAK_PASSWORDS.has(config.password) || config.password.length < 8)) {
  console.error('[config] TRADELEDGER_PASSWORD 仍是示例值或少于 8 位，请改成强密码后再启动');
  process.exit(1);
}

if (config.seedDemo && !fs.existsSync(config.dbFile)) {
  try {
    seed({ quiet: true });
  } catch (err) {
    console.error('[seed] 初始化失败：', err?.message || err);
  }
}

server.listen(config.port, config.host, () => {
  console.log('\n  TradeLedger 已启动');
  console.log(`  ➜ http://${config.host}:${config.port}`);
  console.log(`  ➜ 访问密码：${config.passwordFromEnv ? '（来自环境变量）' : 'demo1234（开发回退，请配置 TRADELEDGER_PASSWORD）'}`);
  console.log(`  ➜ 数据库：${config.dbFile}`);

  // 账户加进来就自动回溯历史；关掉页面也会继续
  startSyncWorker();
  // 本地快照 + WebDAV 自动备份
  startBackupWorker();
  // 定时刷新余额 / 持仓 / 资金费率
  if (config.liveRefreshSeconds > 0) {
    const timer = setInterval(() => {
      refreshLive({ force: true }).catch((err) => console.error('[live]', err?.message || err));
    }, config.liveRefreshSeconds * 1000);
    timer.unref();
    const kick = setTimeout(() => {
      refreshLive({ force: true }).catch((err) => console.error('[live]', err?.message || err));
    }, 2500);
    kick.unref();
  }
  console.log(`  ➜ 后台同步：每 ${config.syncWorkerSeconds}s · 实时持仓：每 ${config.liveRefreshSeconds}s\n`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
