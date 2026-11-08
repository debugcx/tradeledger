import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-log-'));
process.env.LOG_DIR = dir;
process.env.LOG_MAX_MB = '0.0005'; // ~524 bytes，方便触发轮转
const logger = await import('../src/logger.js?logger-test');
logger.installFileLogging();

const logFiles = () => fs.readdirSync(dir).filter((name) => name.startsWith('app-'));

// console 已补丁为同时写 stdout；大行会污染测试输出，临时静音 stdout。
function logQuiet(text) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { console.log(text); } finally { process.stdout.write = write; }
}

test('异步写入 + flushLogs 落盘', async () => {
  console.log('logger-test-hello');
  await logger.flushLogs();
  const files = logFiles();
  assert.ok(files.length >= 1);
  const text = files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  assert.match(text, /logger-test-hello/);
});

test('单文件超过上限时轮转为 .log.1', async () => {
  logQuiet('x'.repeat(120_000));
  await logger.flushLogs();
  logQuiet('y'.repeat(120_000));
  await logger.flushLogs();
  assert.ok(logFiles().some((name) => name.endsWith('.log.1')), logFiles().join(','));
});

test('cleanupOldLogs 删除超过保留期的文件', () => {
  const old = path.join(dir, 'app-2000-01-01.log');
  fs.writeFileSync(old, 'old');
  const stamp = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(old, stamp, stamp);
  logger.cleanupOldLogs();
  assert.equal(fs.existsSync(old), false);
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
