/**
 * 备份 worker：按配置自动创建本地快照、上传 WebDAV。
 *
 * 与同步 worker 一样用 setInterval + unref，不阻塞进程退出。
 * 失败后 30 分钟再试，避免每次 tick 都打 WebDAV。
 */

import * as backup from './backup.js';

let timer = null;
let busy = false;

const RETRY_MS = 30 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cfg = backup.getBackupConfig();
    const now = Date.now();

    const lastLocal = Date.parse(cfg.lastLocalAt || '') || 0;
    if (cfg.localEnabled && (!lastLocal || now - lastLocal >= cfg.localIntervalHours * 3600_000)) {
      try {
        const snap = backup.createLocalSnapshot('auto');
        console.log(`[backup] 本地快照 ${snap.name}（${backup.fmtBytes(snap.bytes)}）`);
      } catch (err) {
        console.error('[backup] 本地快照失败：', err?.message || err);
      }
    }

    if (!cfg.webdavEnabled || !cfg.webdavUrl) return;
    const lastAttempt = Date.parse(cfg.lastRemoteAttemptAt || '') || 0;
    const wait = cfg.lastRemoteStatus === 'error' ? RETRY_MS : cfg.intervalHours * 3600_000;
    if (lastAttempt && now - lastAttempt < wait) return;

    try {
      const result = await backup.runRemoteBackup({ reason: 'auto' });
      const size = result.mode === 'incremental'
        ? `新增 ${backup.fmtBytes(result.uploadedBytes)}，复用 ${result.chunks?.reused ?? 0} 块`
        : backup.fmtBytes(result.bytes);
      console.log(`[backup] WebDAV 已上传 ${result.name}（${size}${result.encrypted ? '，已加密' : ''}）`);
    } catch (err) {
      console.error('[backup] WebDAV 备份失败：', err?.message || err);
    }
  } finally {
    busy = false;
  }
}

export function startBackupWorker() {
  if (timer) return timer;
  timer = setInterval(() => { tick().catch((err) => console.error('[backup]', err)); }, TICK_MS);
  timer.unref();
  const kick = setTimeout(() => { tick().catch((err) => console.error('[backup]', err)); }, 90_000);
  kick.unref();
  return timer;
}

export function stopBackupWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
