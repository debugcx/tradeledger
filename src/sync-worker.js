/**
 * 后台自动同步 worker。
 *
 * 只要账户的 sync_done=0（例如刚添加 API），worker 就会每隔几秒推一批，
 * 直到历史拉完。页面关掉也会继续；进程重启后从 sync_state 断点续传。
 */

import { config } from './config.js';
import * as store from './store.js';
import { syncAccount, isSyncing } from './sync.js';

let timer = null;
let busy = false;
const backoff = new Map(); // accountId -> { until, attempts }

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const transferDue = (account) => {
      const last = Date.parse(account.last_transfer_sync_at || '') || 0;
      return !last || now - last > config.transferRefreshHours * 3600_000;
    };
    const spotDue = (account) => {
      const last = Date.parse(account.last_spot_sync_at || '') || 0;
      return !last || now - last > config.spotRefreshHours * 3600_000;
    };
    const accounts = store.listAccounts()
      .filter((a) => !a.is_demo && a.exchange !== 'manual')
      .filter((a) => !a.sync_done || a.sync_state || transferDue(a) || spotDue(a));
    for (const account of accounts) {
      if (isSyncing(account.id)) continue;
      const wait = backoff.get(account.id);
      if (wait && wait.until > Date.now()) continue;
      try {
        await syncAccount(account.id, { limit: config.syncBatchLimit });
        backoff.delete(account.id);
      } catch (err) {
        const attempts = (wait?.attempts || 0) + 1;
        const delay = Math.min(300_000, 15_000 * attempts);
        backoff.set(account.id, { until: Date.now() + delay, attempts });
        console.error(`[sync-worker] ${account.name}: ${err?.message || err}`);
      }
    }
  } finally {
    busy = false;
  }
}

export function startSyncWorker() {
  if (!(config.syncWorkerSeconds > 0)) return null;
  if (timer) return timer;
  timer = setInterval(() => { tick().catch((e) => console.error('[sync-worker]', e)); }, config.syncWorkerSeconds * 1000);
  timer.unref();
  const kick = setTimeout(() => { tick().catch((e) => console.error('[sync-worker]', e)); }, 1500);
  kick.unref();
  return timer;
}

export function stopSyncWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
