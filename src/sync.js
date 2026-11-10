/**
 * 交易所同步引擎。
 *
 * 分批模型：
 *   - 首次同步从 now - SYNC_LOOKBACK_DAYS 开始往回拉；
 *   - 每批调用适配器一次，游标 / 时间窗写进 accounts.sync_state；
 *   - 有 nextCursor 就继续下一批，没有则标记 sync_done=1；
 *   - 完成后的同步只回溯 2 天做增量，并依靠 external_id 去重。
 */

import { config } from './config.js';
import * as store from './store.js';
import { getExchange, exchangeList } from './exchanges/index.js';
import { matchFills, matchEpisodes } from './fills.js';
import { cursorWatermark } from './exchanges/common.js';

const DAY = 86400_000;

function stateOf(account) {
  try {
    const parsed = JSON.parse(account.sync_state || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function registryFrom(list) {
  const out = {};
  for (const item of list) out[item.id] = item;
  return out;
}

const running = new Set();
export const isSyncing = (accountId) => running.has(Number(accountId));

export async function syncAccount(accountId, options = {}) {
  const id = Number(accountId);
  if (running.has(id)) throw new Error('该账户正在同步，请稍后再试');
  running.add(id);
  try {
    return await runSync(id, options);
  } finally {
    running.delete(id);
  }
}

export function lookbackDaysFor(account, adapter) {
  const requested = account.lookback_days === null || account.lookback_days === undefined
    ? config.syncLookbackDays
    : Number(account.lookback_days);
  const max = Number(adapter.maxLookbackDays) || 0;
  if (requested === 0) return max || config.syncLookbackDays;
  return max ? Math.min(requested, max) : requested;
}

/** 资金流水的保留期通常比仓位历史长，不受交易接口的 maxLookbackDays 限制 */
function transferLookbackDays(account) {
  const requested = account.lookback_days === null || account.lookback_days === undefined
    ? config.syncLookbackDays
    : Number(account.lookback_days);
  if (requested === 0) return 3650;
  return Math.min(Math.max(requested, 1), 3650);
}

function spotLookbackDays(account, adapter) {
  const requested = account.lookback_days === null || account.lookback_days === undefined
    ? config.syncLookbackDays
    : Number(account.lookback_days);
  const max = Number(adapter.maxSpotLookbackDays) || Number(adapter.maxLookbackDays) || 3650;
  if (requested === 0) return max;
  return Math.min(Math.max(requested, 1), max);
}

async function runSync(accountId, { limit = config.syncBatchLimit, registry = null } = {}) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('账户不存在');
  if (account.is_demo) throw new Error('演示账户不能同步真实交易所');
  const adapters = registry || registryFrom(exchangeList);
  const adapter = adapters[account.exchange] || getExchange(account.exchange);
  if (!adapter) throw new Error(`暂不支持交易所：${account.exchange}`);

  const creds = store.getAccountCredentials(accountId);
  if (account.exchange === 'hyperliquid') {
    if (!creds.wallet) throw new Error('请先填写钱包地址');
  } else if (!creds.apiKey || !creds.apiSecret) {
    throw new Error('账户缺少 API Key / Secret');
  }

  const now = Date.now();
  const previous = stateOf(account);
  const lookbackDays = lookbackDaysFor(account, adapter);
  let fromMs;
  let toMs;
  let cursor;
  let mode;

  // 客户端配对交易所（returnsFills）：成交覆盖未达到回溯起点前，强制全窗扫描
  // 原始成交；期间不导入半截回合，覆盖完成后按 symbol 全量重算并清理幻影。
  const fillsFromKey = `fills_from_${accountId}`;
  const fillsFrom = Number(store.getMeta(fillsFromKey, '0'));
  const fillsComplete = Boolean(adapter.returnsFills)
    && fillsFrom > 0
    && fillsFrom <= Date.now() - lookbackDays * DAY + DAY;
  const needFillsBackfill = Boolean(adapter.returnsFills) && !fillsComplete;

  if (account.assets_only) {
    // 仅资产模式（网格机器人子账户等）：不拉交易/现货/资金费，
    // 资金流水照常（6 小时节流），资产总览由 asset-worker 独立负责
    mode = 'assets_only';
    toMs = now;
    fromMs = now;
    cursor = null;
  } else if (needFillsBackfill) {
    // 成交回溯也要断点续传：历史上这里每次从 now 重新扫，窗口预算只有 8 个
    // （约 56 天），回溯范围大于预算时游标永远推不下去，会无限重扫最近一段。
    mode = 'fills_backfill';
    toMs = Number(previous.toMs) || now;
    fromMs = Number(previous.fromMs) || (now - lookbackDays * DAY);
    cursor = previous.cursor || null;
  } else if (account.sync_done && previous.cursor) {
    // 增量同步在 2 天窗口里超过一页时，继续把游标走完
    mode = 'incremental';
    fromMs = Number(previous.fromMs) || (now - 2 * DAY);
    toMs = Number(previous.toMs) || now;
    cursor = previous.cursor;
  } else if (account.sync_done) {
    mode = 'incremental';
    const last = Date.parse(account.last_sync_at || '') || (now - 7 * DAY);
    fromMs = Math.min(last, now) - 2 * DAY;
    toMs = now;
    cursor = null;
  } else if (previous.fromMs && previous.toMs) {
    mode = 'backfill';
    fromMs = Number(previous.fromMs) || (now - lookbackDays * DAY);
    toMs = Number(previous.toMs) || now;
    cursor = previous.cursor || null;
  } else {
    mode = 'backfill';
    toMs = now;
    fromMs = now - lookbackDays * DAY;
    cursor = null;
  }

  const runId = store.startSyncRun(accountId);
  try {
    const result = account.assets_only
      ? { trades: [], nextCursor: null }
      : await adapter.fetchTrades({
        creds,
        fromMs,
        toMs,
        cursor,
        limit: Math.max(100, Number(limit) || config.syncBatchLimit),
        windowBudget: config.syncWindowBudget,
      });
    const trades = Array.isArray(result?.trades) ? result.trades : [];
    const nextCursor = result?.nextCursor || null;
    const done = !nextCursor;

    let imported = { inserted: 0, updated: 0, skipped: 0 };
    let fillsInserted = 0;
    let prunedPhantoms = 0;
    if (adapter.returnsFills && Array.isArray(result.fills)) {
      // 客户端配对交易所：先持久化原始成交；某个 symbol 的成交覆盖足够
      // （最早成交不晚于库里最早开仓）时按全量重算回合（幂等 upsert）并清理
      // 增量批次产生的幻影；覆盖不足（成交已超出交易所保留期）则保持旧行为。
      fillsInserted = store.insertTradeFills(accountId, account.exchange, result.fills);
      const covered = done ? fromMs : cursorWatermark(nextCursor, fromMs);
      const nextWm = fillsFrom ? Math.min(fillsFrom, covered) : covered;
      if (nextWm !== fillsFrom) store.setMeta(fillsFromKey, String(Math.max(0, Math.round(nextWm))));
      // 覆盖恰好在本批完成时，也要立刻重算一遍；否则要等下一次同步
      // （sync_done=1 后 worker 可能几小时才会再叫醒该账户）才生成回合。
      const fillsCompleteNow = fillsComplete
        || (done && nextWm > 0 && nextWm <= Date.now() - lookbackDays * DAY + DAY);
      if (fillsCompleteNow) {
        const matcher = adapter.episodeMatching ? matchEpisodes : matchFills;
        const earliestOpen = new Map(
          store.listSymbolEarliestOpen(accountId).map((r) => [r.symbol, Date.parse(r.min_open)]),
        );
        // 只重算本交易所通道的成交池；exchange='csv' 的池归 CSV 导入的
        // 重建管道（rebuild.js）所有，掺进来会把同一笔成交算两遍
        for (const sym of store.listTradeFillSymbols(accountId, { exchange: account.exchange })) {
          const raw = store.listTradeFills(accountId, sym, { exchange: account.exchange });
          const fillObjs = raw.map((r) => ({
            id: r.external_id, symbol: sym, side: r.side, price: r.price, qty: r.qty,
            fee: r.fee, time: r.time, orderType: r.order_type || 'other',
            // 反向（币本位）合约：数量单位是张，面值用于盈亏与展示口径换算
            ...(Number(r.contract_value) > 0 ? { contractValue: Number(r.contract_value) } : {}),
          }));
          const earliestFill = fillObjs.length ? fillObjs[0].time : Infinity;
          const openBoundary = Number.isFinite(earliestOpen.get(sym)) ? earliestOpen.get(sym) : Infinity;
          if (earliestFill <= openBoundary + 60_000) {
            // 覆盖完整：重算可信，导入并清理幻影
            const recomputed = matcher(fillObjs, account.exchange);
            store.importTrades(recomputed, accountId, { upsert: true });
            prunedPhantoms += store.pruneTradesNotIn(accountId, account.exchange, sym, recomputed.map((t) => t.external_id));
          } else {
            // 保留期外的老回合无法重算：该 symbol 回退旧行为（按本批增量导入）
            const partial = trades.filter((t) => t.symbol === sym);
            if (partial.length) store.importTrades(partial, accountId, { upsert: true });
          }
        }
      }
    } else {
      // upsert：OKX 部分平仓会原地更新仓位历史行，重新拉到同 ID 时回写最终状态
      imported = store.importTrades(trades, accountId, { upsert: true });
    }

    // 资金费：按本批交易覆盖的时间范围单独拉取，再回填到对应交易。
    // OKX 的 funding 已在仓位历史里，适配器返回空数组。
    const warnings = [];
    if (Array.isArray(result?.streamErrors) && result.streamErrors.length) {
      // 多通道适配器（U 本位 + 币本位）：某个通道无权限/不可用时提示，另一条照常同步
      warnings.push(`部分通道跳过：${result.streamErrors.slice(0, 2).join('；')}`);
    }
    let fundingInserted = 0;
    if (typeof adapter.fetchFunding === 'function' && trades.length) {
      const openTimes = trades.map((t) => Date.parse(t.open_time)).filter(Number.isFinite);
      const closeTimes = trades.map((t) => Date.parse(t.close_time)).filter(Number.isFinite);
      if (openTimes.length && closeTimes.length) {
        const fFrom = Math.max(0, Math.min(...openTimes) - DAY);
        const fTo = Math.max(...closeTimes) + DAY;
        try {
          const funding = await adapter.fetchFunding({ creds, fromMs: fFrom, toMs: fTo, cursor: null, limit: 2000 });
          if (funding?.events?.length) fundingInserted = store.insertFundingEvents(funding.events, accountId);
        } catch (err) {
          warnings.push(`资金费拉取失败：${err?.message || err}`);
        }
      }
    }
    const fundingApplied = store.applyFundingEvents(accountId);
    let transfersInserted = 0;
      let ledgerInserted = 0;
    let spotInserted = 0;
    let spotFillsInserted = 0;
    let spotPruned = 0;
    if (typeof adapter.fetchTransfers === 'function') {
      const lastTransfer = Date.parse(account.last_transfer_sync_at || '') || 0;
      const due = !lastTransfer || (now - lastTransfer > 6 * 3600_000);
      if (due) {
        try {
          const tFrom = lastTransfer
            ? Math.max(0, lastTransfer - 2 * DAY)
            : Math.max(0, now - transferLookbackDays(account) * DAY);
          const transferResult = await adapter.fetchTransfers({
            creds, fromMs: tFrom, toMs: now, limit: 2000,
          });
          let transferRows = transferResult?.transfers || [];
          if (typeof adapter.fetchRebates === 'function') {
            try {
              const rebates = await adapter.fetchRebates({ creds, fromMs: tFrom, toMs: now, limit: 2000 });
              transferRows = transferRows.concat(rebates?.transfers || []);
            } catch (err) {
              warnings.push(`返佣账单拉取失败：${err?.message || err}`);
            }
          }
          transfersInserted = store.insertTransfers(transferRows, accountId);
          store.updateAccountTransferSync(accountId);
          if (typeof adapter.fetchLedgerTrades === 'function') {
            try {
              const led = await adapter.fetchLedgerTrades({ creds, fromMs: tFrom, toMs: now, limit: 500 });
              const res = store.importTrades(led?.trades || [], accountId, { upsert: true });
              ledgerInserted = res.inserted + (res.updated || 0);
              // 重建的回合不在成交批次里，资金费按同一窗口补拉一次（事件按 external_id 幂等）
              if (ledgerInserted && typeof adapter.fetchFunding === 'function') {
                try {
                  const funding = await adapter.fetchFunding({ creds, fromMs: tFrom, toMs: now, cursor: null, limit: 2000 });
                  if (funding?.events?.length) {
                    store.insertFundingEvents(funding.events, accountId);
                    store.applyFundingEvents(accountId);
                  }
                } catch { /* 资金费补充失败不影响主流程 */ }
              }
            } catch (err) {
              warnings.push(`账本回填失败：${err?.message || err}`);
            }
          }
        } catch (err) {
          warnings.push(`资金流水拉取失败：${err?.message || err}`);
          // 避免每 5 秒重试打爆接口；6 小时后再试，或点“重新回溯”立即重试
          store.updateAccountTransferSync(accountId);
        }
      }
    }
    if (!account.assets_only && typeof adapter.fetchSpotTrades === 'function') {
      const lastSpot = Date.parse(account.last_spot_sync_at || '') || 0;
      const due = !lastSpot || (now - lastSpot > config.spotRefreshHours * 3600_000);
      if (due) {
        try {
          const symbols = String(account.spot_symbols || '').split(/[,;，；\s]+/).filter(Boolean);
          const sFrom = lastSpot
            ? Math.max(0, lastSpot - 2 * DAY)
            : Math.max(0, now - spotLookbackDays(account, adapter) * DAY);
          const spot = await adapter.fetchSpotTrades({
            creds, fromMs: sFrom, toMs: now, limit: 2000, symbols,
          });
          const fills = spot?.fills || [];
          if (spot?.errors?.length) {
            warnings.push(`现货部分交易对失败：${spot.errors.slice(0, 2).join('；')}`);
          }
          if (fills.length) {
            spotFillsInserted = store.insertSpotFills(fills, accountId);
            store.recomputeSpotCostBasis(accountId);
            // T 回合 + FIFO：按触及 symbol 的全量成交重算（T 回合可能跨同步批次闭环），
            // 并清理被新口径取代的旧记录
            const touched = [...new Set(fills.map((f) => f.symbol))];
            const rec = store.recomputeSpotTrades(accountId, account.exchange, { symbols: touched });
            spotInserted = rec.inserted;
            spotPruned = rec.pruned;
          }
          store.updateAccountSpotSync(accountId);
        } catch (err) {
          warnings.push(`现货成交拉取失败：${err?.message || err}`);
          store.updateAccountSpotSync(accountId);
        }
      }
    }
    const batches = Number(previous.batches || 0) + 1;

    store.updateAccountSyncState(accountId, {
      state: done ? null : { fromMs, toMs, cursor: nextCursor, batches, mode },
      done: account.sync_done ? 1 : (done ? 1 : 0),
      status: 'ok',
      message: `fetched ${trades.length}, inserted ${imported.inserted}, updated ${imported.updated || 0}, skipped ${imported.skipped}`
        + (adapter.returnsFills ? `, fills ${fillsInserted}, pruned ${prunedPhantoms}` : '')
        + (fundingApplied ? `, funding ${fundingApplied}` : '')
        + (transfersInserted ? `, transfers ${transfersInserted}` : '')
          + (ledgerInserted ? `, ledger ${ledgerInserted}` : '')
      + (spotInserted ? `, spot ${spotInserted}` : '')
      + (spotFillsInserted ? `, spot fills ${spotFillsInserted}` : '')
      + (spotPruned ? `, spot pruned ${spotPruned}` : '')
        + (warnings.length ? `, warn: ${warnings[0]}` : ''),
    });
    store.finishSyncRun(runId, {
      fetched: trades.length,
      inserted: imported.inserted,
      updated: imported.updated || 0,
      skipped: imported.skipped,
      status: 'ok',
      message: done ? 'batch complete' : 'more history available',
    });
    // 成功一次即清零连续失败计数
    store.setSyncFail(accountId, null);

    return {
      ok: true,
      accountId: Number(accountId),
      exchange: account.exchange,
      mode,
      fetched: trades.length,
      inserted: imported.inserted,
      updated: imported.updated || 0,
      skipped: imported.skipped,
      fundingInserted,
      fundingApplied,
      transfersInserted,
      ledgerInserted,
      spotInserted,
      spotFillsInserted,
      warnings,
      done: Boolean(done),
      cursor: nextCursor,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    };
  } catch (err) {
    // 连续失败退避：计数持久化，第 5 次起暂停 24 小时（重启也生效）
    const prevFail = store.getSyncFail(accountId);
    const attempts = (Number(prevFail?.attempts) || 0) + 1;
    store.setSyncFail(accountId, {
      attempts,
      nextAt: Date.now() + nextSyncDelay(attempts),
      lastError: String(err?.message || err).slice(0, 300),
      at: new Date().toISOString(),
    });
    store.updateAccountSyncState(accountId, {
      state: account.sync_done ? null : previous,
      done: account.sync_done,
      status: 'error',
      message: err?.message || String(err),
    });
    store.finishSyncRun(runId, {
      status: 'error',
      message: err?.message || String(err),
    });
    throw err;
  }
}

/** 连续失败退避：前 4 次快速重试（15s→60s），第 5 次起改为 24 小时后再试 */
export function nextSyncDelay(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  if (n >= 5) return 24 * 3600_000;
  return Math.min(300_000, 15_000 * n);
}

/** CLI / 定时任务用：把所有真实账户拉到没有更多历史为止 */
export async function syncAllAccounts({ limit = config.syncBatchLimit, maxBatches = 20 } = {}) {
  const results = [];
  for (const account of store.listAccounts().filter((a) => !a.is_demo && a.exchange !== 'manual')) {
    let batches = 0;
    try {
      for (;;) {
        const r = await syncAccount(account.id, { limit });
        results.push(r);
        batches++;
        if (r.done || batches >= maxBatches) break;
      }
    } catch (err) {
      results.push({ ok: false, accountId: account.id, exchange: account.exchange, error: err?.message || String(err) });
    }
  }
  return results;
}
