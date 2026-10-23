/**
 * 实时余额 / 持仓 / 资金费率刷新。
 *
 * - 页面不直接打交易所：后台定时刷新写库，前端读本地快照；
 * - force=true 时立即向所有真实账户拉一次；
 * - 单账户失败不影响其他账户，错误收集到 errors。
 */

import * as store from './store.js';
import { getExchange } from './exchanges/index.js';

let cache = null;
let cacheAt = 0;
let inFlight = null;
const CACHE_MS = 15_000;

export async function refreshLive({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) {
    return { ...cache, cached: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const accounts = store.listAccounts().filter((a) => !a.is_demo && a.exchange !== 'manual');
    const errors = [];
    for (const account of accounts) {
      const adapter = getExchange(account.exchange);
      if (!adapter) {
        errors.push(`${account.name}: 不支持的交易所`);
        continue;
      }
      let creds;
      try {
        creds = store.getAccountCredentials(account.id);
      } catch (err) {
        errors.push(`${account.name}: ${err?.message || err}`);
        continue;
      }

      if (adapter.fetchLive) {
        try {
          const data = await adapter.fetchLive(creds);
          store.replaceBalances(account.id, data.balances || []);
          store.replacePositions(account.id, data.positions || []);
        } catch (err) {
          errors.push(`${account.name} 合约：${err?.message || err}`);
        }
      }

      if (adapter.fetchSpotLive) {
        try {
          const data = await adapter.fetchSpotLive(creds);
          store.replaceSpotBalances(account.id, data.balances || []);
          store.replaceSpotHoldings(account.id, data.holdings || []);
        } catch (err) {
          errors.push(`${account.name} 现货：${err?.message || err}`);
        }
      }
    }
    const updatedAt = new Date().toISOString();
    const snapshot = {
      updatedAt,
      hasRealAccounts: accounts.length > 0,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, exchange: a.exchange })),
      balances: store.listBalances(),
      positions: store.listPositions(),
      spotBalances: store.listSpotBalances(),
      spotHoldings: store.listSpotHoldings(),
      errors,
    };
    cache = snapshot;
    cacheAt = Date.now();
    inFlight = null;
    return snapshot;
  })().catch((err) => {
    inFlight = null;
    throw err;
  });

  return inFlight;
}

/** 读取本地快照，不触发交易所请求 */
export function liveSnapshot() {
  const balances = store.listBalances();
  const positions = store.listPositions();
  const spotBalances = store.listSpotBalances();
  const spotHoldings = store.listSpotHoldings();
  const updatedAt = [...balances, ...positions, ...spotBalances, ...spotHoldings]
    .map((x) => x.updated_at)
    .sort()
    .at(-1) || null;
  const accounts = store.listAccounts().filter((a) => !a.is_demo && a.exchange !== 'manual');
  return {
    updatedAt: updatedAt || cache?.updatedAt || null,
    hasRealAccounts: accounts.length > 0,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, exchange: a.exchange })),
    balances,
    positions,
    spotBalances,
    spotHoldings,
    errors: [],
    cached: true,
  };
}
