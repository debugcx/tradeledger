/**
 * 后台自动同步 worker。
 *
 * 只要账户的 sync_done=0（例如刚添加 API），worker 就会每隔几秒推一批，
 * 直到历史拉完。页面关掉也会继续；进程重启后从 sync_state 断点续传。
 */

import { config } from './config.js';
import * as store from './store.js';
import { syncAccount, isSyncing } from './sync.js';
import { classifyOrderType } from './fills.js';

let timer = null;
let busy = false;
const backoff = new Map(); // accountId -> { until, attempts }

/**
 * 空闲回填：给未分类（order_type=other）的回合补吃挂分类。
 * 每次只处理 1 笔（OKX 为一次 fills-history 请求），温和限速；
 * 回填近 85 天内的回合，更早的超出交易所成交保留期、保持 other。
 */
async function enrichIdle() {
  const accounts = store.listAccounts().filter((a) => !a.is_demo && a.exchange !== 'manual');
  for (const account of accounts) {
    if (isSyncing(account.id)) continue;
    const adapter = (await import('./exchanges/index.js')).getExchange(account.exchange);
    if (!adapter || typeof adapter.fetchEpisodeFills !== 'function') continue;
    const pending = store.listUnclassifiedEpisodes(account.id, 1);
    if (!pending.length) continue;
    const episode = pending[0];
    try {
      const creds = store.getAccountCredentials(account.id);
      const res = await adapter.fetchEpisodeFills({
        creds, symbol: episode.symbol, market: episode.market || 'futures',
        fromMs: Date.parse(episode.open_time),
        toMs: Date.parse(episode.close_time) + 60_000,
      });
      if (res?.fills?.length) {
        const orderType = classifyOrderType(res.fills);
        if (orderType !== 'other') {
          store.setTradeOrderType(episode.id, orderType);
          // 指纹与 routes.detailCacheInputs 一致，详情页可直接命中缓存
          const inputs = [episode.entry_price, episode.exit_price, episode.size, episode.side,
            episode.open_time, episode.close_time].join('|');
          store.saveTradeFillsCache(episode.id, inputs, res.fills);
        }
      }
    } catch (err) {
      console.error(`[enrich] ${episode.symbol}#${episode.id}: ${err?.message || err}`);
    }
    return true; // 处理了一笔
  }
  return false;
}

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
    // 逐笔回填吃挂分类（每 tick 最多 1 笔，enrichIdle 内部跳过正在同步的账户）
    await enrichIdle();
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
