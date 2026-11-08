/**
 * 日志落盘与清理。
 *
 * - console 输出同时写入 data/logs/app-YYYY-MM-DD.log（按天分文件）；
 * - 单文件超过上限（默认 10MB，LOG_MAX_MB 可调）时轮转为 .log.1 重新开始；
 * - 启动时和每 6 小时清理一次：删除超过保留期（默认 10 天，LOG_RETENTION_DAYS 可调）的日志；
 * - 兼容清理旧版 data/server.out.log / server.err.log 及其 .prev / .N 轮转文件；
 * - stdout 输出保持不变，docker logs / 终端不受影响。
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 10) || 10);
const CLEAN_INTERVAL_MS = 6 * 3600_000;
const MAX_FILE_BYTES = Math.max(0.1, Number(process.env.LOG_MAX_MB || 10) || 10) * 1024 * 1024;
const DAY_MS = 86400_000;

let installed = false;
const sizeCache = { file: '', size: 0 };

// 异步写队列：console 调用只入队，避免每条日志都 appendFileSync 阻塞事件循环。
const queue = [];
const MAX_QUEUE = 5000;
let flushingPromise = null;

function logDir() {
  // LOG_DIR 仅用于测试/特殊部署时重定向日志目录
  return process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(config.dataDir, 'logs');
}

function safeStr(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function rotateIfNeeded(file, bytes) {
  if (sizeCache.file !== file) {
    sizeCache.file = file;
    try { sizeCache.size = fs.statSync(file).size; } catch { sizeCache.size = 0; }
  }
  if (sizeCache.size > 0 && sizeCache.size + bytes > MAX_FILE_BYTES) {
    try { fs.renameSync(file, file + '.1'); } catch { /* 目标被占用时继续追加 */ }
    sizeCache.size = 0;
  }
}

function flushQueue() {
  if (flushingPromise) return flushingPromise;
  flushingPromise = (async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        if (sizeCache.file !== item.file) {
          sizeCache.file = item.file;
          try { sizeCache.size = (await fs.promises.stat(item.file)).size; } catch { sizeCache.size = 0; }
        }
        if (sizeCache.size > 0 && sizeCache.size + item.bytes > MAX_FILE_BYTES) {
          try { await fs.promises.rename(item.file, item.file + '.1'); } catch { /* 继续追加 */ }
          sizeCache.size = 0;
        }
        await fs.promises.appendFile(item.file, item.line);
        sizeCache.size += item.bytes;
      } catch { /* 写日志失败不影响业务 */ }
    }
  })().finally(() => {
    flushingPromise = null;
    if (queue.length) void flushQueue();
  });
  return flushingPromise;
}

/** 异步等待所有排队日志写完（优雅关闭用）。 */
export async function flushLogs() {
  while (queue.length || flushingPromise) {
    if (flushingPromise) await flushingPromise;
    else await flushQueue();
  }
}

function writeLine(file, line) {
  queue.push({ file, line, bytes: Buffer.byteLength(line) });
  // 磁盘极慢时丢弃最早日志，避免队列无限增长。
  if (queue.length > MAX_QUEUE) queue.shift();
  void flushQueue();
}

/** 进程退出前同步刷盘，避免最后几条日志丢失。 */
export function flushLogsSync() {
  while (queue.length) {
    const item = queue.shift();
    try {
      rotateIfNeeded(item.file, item.bytes);
      fs.appendFileSync(item.file, item.line);
      sizeCache.size += item.bytes;
    } catch { /* 忽略 */ }
  }
}

export function installFileLogging() {
  if (installed) return;
  installed = true;
  try { fs.mkdirSync(logDir(), { recursive: true }); } catch { /* 目录不可写时只保留 stdout */ }
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(orig)) {
    console[level] = (...args) => {
      orig[level](...args);
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const line = `[${now.toISOString()}] ${level.toUpperCase()} ${args.map(safeStr).join(' ')}\n`;
      writeLine(path.join(logDir(), `app-${day}.log`), line);
    };
  }
}

export function cleanupOldLogs() {
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  const removeIfOld = (file) => {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch { /* 占用或不存在都忽略 */ }
  };

  try {
    for (const name of fs.readdirSync(logDir())) {
      if (/^app-\d{4}-\d{2}-\d{2}\.log(\.1)?$/.test(name)) removeIfOld(path.join(logDir(), name));
    }
  } catch { /* 目录不存在 */ }

  // 旧版由启动脚本重定向产生的日志文件
  try {
    for (const name of fs.readdirSync(config.dataDir)) {
      if (/^server\.(out|err)\.log(\.\d+|\.prev)?$/.test(name)) removeIfOld(path.join(config.dataDir, name));
    }
  } catch { /* 忽略 */ }
}

export function startLogCleanup() {
  cleanupOldLogs();
  const timer = setInterval(cleanupOldLogs, CLEAN_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export const LOG_RETENTION = { days: RETENTION_DAYS, intervalMs: CLEAN_INTERVAL_MS, maxFileBytes: MAX_FILE_BYTES };
