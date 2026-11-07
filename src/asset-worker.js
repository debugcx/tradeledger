/**
 * 资产后台刷新 worker。
 *
 * 每分钟检查一次：交易所超过 ASSET_REFRESH_MINUTES、钱包超过
 * WALLET_REFRESH_MINUTES 才真正请求，避免无意义地打交易所和付费索引器。
 */

import { refreshAssets } from './assets.js';
import { failStaleAssetSyncRuns } from './store.js';

let timer = null;
let busy = false;

const TICK_MS = 60_000;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const result = await refreshAssets({ force: false });
    if (result.errors?.length) {
      const msg = result.errors.join(' | ');
      console.warn(`[assets] 同步提示：${msg.slice(0, 300)}${msg.length > 300 ? '…' : ''}`);
    }
  } catch (err) {
    console.error('[assets]', err?.message || err);
  } finally {
    busy = false;
  }
}

export function startAssetWorker() {
  if (timer) return timer;
  try {
    const fixed = failStaleAssetSyncRuns(30);
    if (fixed) console.warn(`[assets] 已把 ${fixed} 条中断的同步记录标记为失败`);
  } catch { /* 首次启动表可能刚建，忽略 */ }
  timer = setInterval(() => { tick().catch((err) => console.error('[assets]', err)); }, TICK_MS);
  timer.unref();
  const kick = setTimeout(() => { tick().catch((err) => console.error('[assets]', err)); }, 8000);
  kick.unref();
  return timer;
}

export function stopAssetWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isAssetBusy() {
  return busy;
}
