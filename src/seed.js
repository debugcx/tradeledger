/**
 * 演示数据生成器（固定随机序列 + 固定时间窗口，结果可复现）
 *
 *   node src/seed.js            # 空库时灌入；已有交易则跳过
 *   node src/seed.js --reset    # 清空后重新灌入
 *
 * 锚点：2026-10-20T15:59Z，共 564 笔，覆盖约 180 天、两个演示账户。
 */

import { pathToFileURL } from 'node:url';
import { closeDb, getDb } from './db.js';
import * as store from './store.js';
import { nowIso } from './http.js';

const SEED_END = Date.parse('2026-10-20T15:59:00Z');
const WINDOW_DAYS = 180;
const TOTAL_TRADES = 564;

const SYMBOLS = [
  { symbol: 'BTC/USDT', base: 68000, vol: 0.012 },
  { symbol: 'ETH/USDT', base: 3200, vol: 0.018 },
  { symbol: 'SOL/USDT', base: 150, vol: 0.03 },
  { symbol: 'DOGE/USDT', base: 0.12, vol: 0.04 },
  { symbol: 'XRP/USDT', base: 0.6, vol: 0.03 },
  { symbol: 'AVAX/USDT', base: 30, vol: 0.035 },
  { symbol: 'LINK/USDT', base: 14, vol: 0.028 },
  { symbol: 'ARB/USDT', base: 1.2, vol: 0.045 },
  { symbol: 'OP/USDT', base: 2.4, vol: 0.04 },
  { symbol: 'TON/USDT', base: 6, vol: 0.05 },
];

const TAGS = ['突破', '回调', '趋势', '逆势', '止损离场', '早进', 'FOMO', '计划内'];
const NOTES = [
  '按计划进场，止损放在前低下方，仓位正常。',
  '追高进场，买在了一根大阳线末尾，下次等回踩。',
  '信号没问题，但止盈太早，只吃到一半行情。',
  '逆势抄底，逻辑不成立，应该放弃这笔。',
  '持仓时间过长，资金费率吃掉了利润。',
  '严格执行计划，亏损也在可接受范围内。',
  '连续亏损后情绪急躁，放大了仓位。',
  '突破回踩确认后进场，这笔是标准模板。',
];

/** mulberry32：小而稳定的可复现 PRNG */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v, d = 2) => Math.round(Number(v) * 10 ** d) / 10 ** d;

/** 价格精度跟随量级：避免 1.2 这种价位被四舍五入到 2 位后掩盖真实价差 */
const roundPrice = (v) => {
  const n = Math.abs(Number(v) || 0);
  if (n >= 1000) return round(v, 2);
  if (n >= 100) return round(v, 3);
  if (n >= 1) return round(v, 5);
  return round(v, 6);
};

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function makeTrades(rng) {
  const trades = [];
  for (let i = 0; i < TOTAL_TRADES; i++) {
    const meta = pick(rng, SYMBOLS);
    const side = rng() < 0.54 ? 'long' : 'short';
    const dir = side === 'long' ? 1 : -1;
    const orderType = rng() < 0.62 ? 'market' : 'limit';

    // 开仓时间：窗口内偏工作时段（8–24 点）
    const dayOffset = Math.floor(rng() * WINDOW_DAYS);
    const hour = Math.floor((rng() * (16 / 24) + 7 / 24) * 24) % 24;
    const dayMs = SEED_END - dayOffset * 86400_000;
    const openAt = new Date(dayMs);
    openAt.setUTCHours(hour, Math.floor(rng() * 60), Math.floor(rng() * 60), 0);


    const durationMs = (() => {
      const r = rng();
      if (r < 0.36) return (2 + rng() * 28) * 60_000;
      if (r < 0.66) return (0.5 + rng() * 5) * 3600_000;
      if (r < 0.88) return (6 + rng() * 18) * 3600_000;
      return (1 + rng() * 5) * 86400_000;
    })();
    // 不截断到窗口末端：截断会让大量交易堆在同一秒（显示成同一时间）
    const openMs = openAt.getTime();
    const closeMs = openMs + durationMs;

    const entryPrice = meta.base * (1 + (rng() - 0.5) * 0.06);
    let rawMove = (rng() - 0.5) * meta.vol * 2;
    if (rng() < 0.05) rawMove *= 3;                       // 偶发大行情
    if (rng() < 0.03) rawMove = -Math.abs(rawMove) * 2;    // 偶发大亏
    const exitPrice = entryPrice * (1 + rawMove);

    const notional = round(500 + rng() ** 1.5 * 30000, 2);
    const size = round(notional / entryPrice, 6);
    const gross = (exitPrice - entryPrice) * size * dir;

    const fee = round(orderType === 'market'
      ? -notional * 0.0005 * (0.8 + rng() * 0.4)
      : (rng() < 0.3 ? notional * 0.0001 : -notional * 0.0002), 4);
    const funding = round((rng() - 0.55) * notional * 0.0002, 4);
    const pnl = round(gross + fee + funding, 2);

    const tags = [];
    for (const tag of TAGS) if (rng() < 0.16) tags.push(tag);
    if (!tags.length && rng() < 0.5) tags.push(pick(rng, TAGS));

    trades.push({
      external_id: `seed:${i + 1}`,
      symbol: meta.symbol,
      side,
      order_type: orderType,
      size,
      notional,
      entry_price: roundPrice(entryPrice),
      exit_price: roundPrice(exitPrice),
      open_time: new Date(openMs).toISOString(),
      close_time: new Date(closeMs).toISOString(),
      pnl,
      fee,
      funding,
      source: 'demo',
      note: rng() < 0.12 ? `${pick(rng, NOTES)}（${meta.symbol}）` : null,
      tags,
    });
  }
  return trades.sort((a, b) => a.close_time.localeCompare(b.close_time));
}

export function seed({ reset = false, force = false, quiet = false } = {}) {
  const log = (...args) => { if (!quiet) console.log(...args); };
  getDb(); // 确保 schema 已建

  if (reset) {
    store.clearAllData();
    log('已清空全部数据');
  } else if (store.countTrades() > 0 && !force) {
    log(`已有 ${store.countTrades()} 笔交易，跳过灌种子（要重置请用 --reset）`);
    return { skipped: true, trades: store.countTrades() };
  }

  const existingDemo = store.listAccounts().filter((a) => a.is_demo);
  const accounts = existingDemo.length ? existingDemo : [
    (() => {
      const at = nowIso();
      const r = getDb().prepare(
        "INSERT INTO accounts (exchange, name, is_demo, created_at) VALUES ('okx', 'OKX 演示', 1, ?)",
      ).run(at);
      return store.getAccount(Number(r.lastInsertRowid));
    })(),
    (() => {
      const at = nowIso();
      const r = getDb().prepare(
        "INSERT INTO accounts (exchange, name, is_demo, created_at) VALUES ('bybit', 'Bybit 演示', 1, ?)",
      ).run(at);
      return store.getAccount(Number(r.lastInsertRowid));
    })(),
  ];

  const rng = mulberry32(20261020);
  const trades = makeTrades(rng);
  // 按账户分组后一次事务写入：逐笔提交在 WAL 下会慢 10 倍以上
  const byAccount = new Map();
  trades.forEach((trade, index) => {
    const account = accounts[index % accounts.length];
    if (!byAccount.has(account.id)) byAccount.set(account.id, []);
    byAccount.get(account.id).push(trade);
  });
  let inserted = 0;
  for (const [accountId, list] of byAccount) {
    inserted += store.importTrades(list, accountId).inserted;
  }

  store.setMeta('seeded_at', nowIso());
  store.setMeta('seed_window_end', new Date(SEED_END).toISOString());
  log(`演示数据已生成：${inserted} 笔交易，${accounts.length} 个演示账户`);
  return { inserted, trades: inserted };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    seed({ reset: process.argv.includes('--reset'), force: process.argv.includes('--force') });
  } finally {
    closeDb();
  }
}
