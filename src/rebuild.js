/**
 * fills → 回合重建（fill-first 管道）。
 *
 * CSV 逐笔成交模式不再「单文件内配对完就扔」：原始成交先落库
 * （trade_fills，exchange='csv' 标记来源通道），配对则针对该账户 + symbol
 * 的全部历史 fills 全量重算。由此获得：
 *   - 开平仓跨文件 / 跨年也能配上（先导入平仓、后补开仓文件同样成立）；
 *   - 重复导入幂等：成交按内容指纹去重，重算结果按回合指纹去重；
 *   - 重算改变配对时，旧行上的笔记 / 标签先迁移到最接近的新回合再清理。
 *
 * 与 API 同步通道的隔离靠两层：
 *   1. 成交池分流——本模块只配对 exchange='csv' 的池，sync.js 只配对
 *      exchange=<交易所> 的池（两边都不看对方）；
 *   2. 清理范围分流——prune/迁移都限定 source='csv'，同步通道的 api 行
 *      永远不会被本通道触碰，反之亦然。
 * 回合 external_id 前缀沿用账户的交易所名：与同步通道对同一物理成交
 * 配出相同指纹时，external_id 一致 → importTrades 去重，同一回合只落一行。
 * （OKX 等仓位历史口径的交易所除外：CSV fills 配对与 episodes 聚合粒度
 * 不同、指纹不同，同时段并用会产生近似重复行——导入前请先清空或避开
 * 已同步时段，与旧行为一致。）
 *
 * 不设覆盖水位门槛（不同于 sync.js）：CSV 成交池只增不减，回合永远由
 * 池内成交推出，重算 + 清理对本通道始终安全；池覆盖不到的更早历史本就
 * 不属于本通道，由已平仓交易模式或 API 同步负责。
 */

import * as store from './store.js';
import { matchFills, matchEpisodes } from './fills.js';

const CLOSE_TOLERANCE_MS = 180_000;

/** 按开/平时间就近为将被清理的旧行找继任回合，迁移笔记与标签 */
function carryAnnotations(staleRows, targets) {
  let carried = 0;
  for (const stale of staleRows) {
    if (!stale.note && !stale.tag_count) continue;
    const openMs = Date.parse(stale.open_time);
    const closeMs = Date.parse(stale.close_time);
    if (!Number.isFinite(openMs) && !Number.isFinite(closeMs)) continue;
    let best = null;
    let bestScore = Infinity;
    for (const t of targets) {
      if (t.id === stale.id) continue;
      const gap = Math.min(
        Number.isFinite(openMs) ? Math.abs(t.openMs - openMs) : Infinity,
        Number.isFinite(closeMs) ? Math.abs(t.closeMs - closeMs) : Infinity,
      );
      if (gap >= CLOSE_TOLERANCE_MS) continue;
      // 重算可能翻转方向（补上开仓腿后 short 占位回合变 long）：
      // 时间就近优先，同方向再加分
      const score = gap + (t.side === stale.side ? 0 : CLOSE_TOLERANCE_MS);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best) {
      carried += store.mergeTradeAnnotations(stale.id, best.id);
    }
  }
  return carried;
}

/**
 * 落库传入的 fills 并对涉及 symbol 全量重算。
 * exchange：账户的交易所名（回合 external_id 前缀，与同步通道对齐以便去重）。
 * 返回 { fills: {inserted, skipped}, trades: {inserted, skipped}, pruned, carried, symbols }。
 */
export function rebuildFromFills(accountId, fills, { exchange = 'manual', episodeMatching = false } = {}) {
  const id = Number(accountId);
  const prefix = String(exchange) || 'csvf';
  const fillsResult = store.insertCsvFills(id, fills);
  const symbols = [...new Set((fills || [])
    .filter((f) => f?.symbol && Number(f.time) && Number(f.qty) > 0 && Number(f.price) > 0)
    .map((f) => String(f.symbol)))];
  if (!symbols.length) {
    return { fills: fillsResult, trades: { inserted: 0, skipped: 0 }, pruned: 0, carried: 0, symbols: [] };
  }

  const matcher = episodeMatching ? matchEpisodes : matchFills;
  const trades = { inserted: 0, skipped: 0 };
  let pruned = 0;
  let carried = 0;
  for (const symbol of symbols) {
    const pool = store.listTradeFills(id, symbol, { exchange: 'csv' }).map((r) => ({
      id: r.external_id, symbol, side: r.side, price: r.price, qty: r.qty,
      fee: r.fee, time: r.time, orderType: r.order_type || 'other',
    }));
    // matchFills 产出默认 source='api'：CSV 通道必须覆盖为 'csv'，
    // 否则同步层的 upsert/清理口径会被污染
    const recomputed = matcher(pool, prefix).map((t) => ({ ...t, source: 'csv' }));
    const res = store.importTrades(recomputed, id);
    trades.inserted += res.inserted;
    trades.skipped += res.skipped;

    const keep = new Set(recomputed.map((t) => String(t.external_id)));
    // 落库后再查目标行：新插入的行才有数据库 ID；跨通道去重时回合
    // 可能落在同步已建的 api 行上，目标查询不限来源（但必须留在重算
    // 集合里——迁到另一个也将被清理的行等于白迁）
    const lane = store.listFillLaneTrades(id, symbol, prefix, { source: 'csv' });
    const targets = store.listFillLaneTrades(id, symbol, prefix, { source: null })
      .filter((r) => keep.has(String(r.external_id)))
      .map((r) => ({
        ...r,
        openMs: Date.parse(r.open_time),
        closeMs: Date.parse(r.close_time),
      }));
    const stale = lane.filter((r) => !keep.has(String(r.external_id)));
    carried += carryAnnotations(stale, targets);
    pruned += store.pruneTradesNotIn(id, prefix, symbol, [...keep], { source: 'csv' });
  }
  return { fills: fillsResult, trades, pruned, carried, symbols };
}
