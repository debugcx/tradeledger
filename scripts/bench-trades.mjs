/**
 * 交易列表读放大基线/回归压测。
 *
 *   node scripts/bench-trades.mjs
 *   BENCH_N=200000 node --expose-gc scripts/bench-trades.mjs
 *
 * 对比「全表 listTrades + filterTrades」与「SQL count + 分页」的延迟，
 * 并校验两条路径返回的 ID 顺序一致。使用临时数据库，不碰 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.TRADELEDGER_TZ = process.env.TRADELEDGER_TZ || 'UTC';
process.env.TRADELEDGER_MASTER_KEY = process.env.TRADELEDGER_MASTER_KEY || 'a'.repeat(64);

const N = Math.max(Number(process.env.BENCH_N) || 100_000, 1000);
const PAGE = 50;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bench-'));
const file = path.join(dir, 'bench.db');

const { openDb, setDb, closeDb, getDb } = await import('../src/db.js');
const store = await import('../src/store.js');
const { filterTrades, analyzeCachedLazy, analyze } = await import('../src/stats.js');

setDb(openDb(file));
const db = getDb();
const account = store.createAccount({ exchange: 'bench', name: 'bench', apiKey: 'k', apiSecret: 's' });

const symbols = Array.from({ length: 20 }, (_, i) => `SYM${String(i).padStart(2, '0')}/USDT`);
const orderTypes = ['market', 'limit', 'other'];
const start = Date.UTC(2026, 0, 1);
const insert = db.prepare(`INSERT INTO trades
  (account_id, external_id, symbol, side, order_type, size, notional, entry_price, exit_price,
   open_time, close_time, pnl, fee, funding, source, market, note, note_updated_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const t0 = performance.now();
db.exec('BEGIN');
for (let i = 0; i < N; i++) {
  const close = new Date(start + Math.floor((i / N) * 273 * 86400_000)).toISOString();
  const open = new Date(new Date(close).getTime() - ((i % 4) + 1) * 3600_000).toISOString();
  const side = i % 2 ? 'short' : 'long';
  const pnl = ((i * 37) % 200) - 80;
  const note = i % 5 === 0 ? `bench note ${i}` : null;
  insert.run(
    account.id, `bench:${i}`, symbols[i % symbols.length], side, orderTypes[i % 3],
    1 + (i % 5), 50 + (i % 500), 100, 100 + pnl, open, close, pnl, 0, 0,
    'manual', i % 10 === 0 ? 'spot' : 'futures', note, note ? close : null, close, close,
  );
}
// 模拟真实的标签挂载：10% / 5% 交易。
const tagAt = new Date().toISOString();
db.prepare("INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)").run('bench-a', '#4ade80', tagAt);
db.prepare("INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)").run('bench-b', '#60a5fa', tagAt);
const tagA = db.prepare("SELECT id FROM tags WHERE name = 'bench-a'").get().id;
const tagB = db.prepare("SELECT id FROM tags WHERE name = 'bench-b'").get().id;
db.exec(`INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) SELECT id, ${Number(tagA)} FROM trades WHERE id % 10 = 0`);
db.exec(`INSERT OR IGNORE INTO trade_tags (trade_id, tag_id) SELECT id, ${Number(tagB)} FROM trades WHERE id % 20 = 0`);
db.exec('COMMIT');
const seedMs = performance.now() - t0;

const dateFilter = { account_id: String(account.id), from: '2026-06-01', to: '2026-08-31', sort: 'time' };
const tagFilter = { account_id: String(account.id), tag: 'bench-a', sort: 'time' };

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(label, fn, runs = 3) {
  const times = [];
  let value;
  for (let i = 0; i < runs; i++) {
    if (global.gc) global.gc();
    const t = performance.now();
    value = fn();
    times.push(performance.now() - t);
  }
  return { label, ms: median(times), value };
}

function heapMb() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

console.log(`\nTradeLedger 列表读放大压测`);
console.log(`  交易数: ${N.toLocaleString()} · 页面大小: ${PAGE} · 时区: ${process.env.TRADELEDGER_TZ}`);
console.log(`  种子数据写入: ${seedMs.toFixed(0)} ms\n`);

const rows = [];

// 1) 首页：日期区间 + 时间排序
{
  const heapBefore = heapMb();
  const legacy = measure('legacy', () => {
    const all = filterTrades(store.listTrades(), dateFilter);
    return { total: all.length, page: all.slice(0, PAGE).map((t) => t.id) };
  }, 2);
  const heapAfter = heapMb();
  const paged = measure('paged', () => {
    const total = store.countTradesFiltered(dateFilter);
    const page = store.listTradesPage(dateFilter, { limit: PAGE, offset: 0 }).map((t) => t.id);
    return { total, page };
  }, 5);
  if (JSON.stringify(legacy.value) !== JSON.stringify(paged.value)) {
    console.error('  ✗ legacy 与 paged 结果不一致', legacy.value, paged.value);
    process.exitCode = 1;
  }
  rows.push(['首页（日期区间）', legacy, paged, `${(heapAfter - heapBefore).toFixed(0)} MB`]);
}

// 2) 深分页：日期区间内的一个较深位置
{
  const offset = Math.min(Math.floor(N / 20), 20_000);
  const legacy = measure('legacy', () => {
    const all = filterTrades(store.listTrades(), dateFilter);
    return all.slice(offset, offset + PAGE).map((t) => t.id);
  }, 1);
  const paged = measure('paged', () => store.listTradesPage(dateFilter, { limit: PAGE, offset }).map((t) => t.id), 3);
  if (JSON.stringify(legacy.value) !== JSON.stringify(paged.value)) {
    console.error('  ✗ 深分页结果不一致');
    process.exitCode = 1;
  }
  rows.push([`深分页 offset=${offset}`, legacy, paged, '—']);
}

// 3) 标签筛选
{
  const legacy = measure('legacy', () => {
    const all = filterTrades(store.listTrades(), tagFilter);
    return { total: all.length, page: all.slice(0, PAGE).map((t) => t.id) };
  }, 2);
  const paged = measure('paged', () => {
    const total = store.countTradesFiltered(tagFilter);
    const page = store.listTradesPage(tagFilter, { limit: PAGE, offset: 0 }).map((t) => t.id);
    return { total, page };
  }, 5);
  if (JSON.stringify(legacy.value) !== JSON.stringify(paged.value)) {
    console.error('  ✗ 标签筛选结果不一致');
    process.exitCode = 1;
  }
  rows.push(['标签筛选', legacy, paged, '—']);
}

// 4) 按盈亏排序
{
  const q = { account_id: String(account.id), sort: 'pnl' };
  const legacy = measure('legacy', () => filterTrades(store.listTrades(), q).slice(0, PAGE).map((t) => t.id), 1);
  const paged = measure('paged', () => store.listTradesPage(q, { limit: PAGE, offset: 0 }).map((t) => t.id), 3);
  if (JSON.stringify(legacy.value) !== JSON.stringify(paged.value)) {
    console.error('  ✗ pnl 排序结果不一致');
    process.exitCode = 1;
  }
  rows.push(['按盈亏排序', legacy, paged, '—']);
}

// 5) 仪表盘统计：冷启动需要全量，命中缓存后不再加载。
//    先空跑一次预热 V8/JIT，再各测一轮，避免把解释器启动开销算进冷路径。
{
  analyzeCachedLazy('warmup', 'bench-dash', () => [{}]);
  const version = store.tradesVersion();
  let loads = 0;
  const loader = () => {
    loads += 1;
    return filterTrades(store.listTrades(), dateFilter);
  };
  const cold = measure('cold', () => analyzeCachedLazy(version, 'bench-dash', loader), 1);
  const warm = measure('warm', () => analyzeCachedLazy(version, 'bench-dash', loader), 5);
  rows.push(['仪表盘统计（冷/热）', cold, warm, `loader ${loads} 次`]);
}

// 6) 冷路径拆解：定位 listTrades / 标签挂载 / filter / analyze 各占多少
{
  const load = measure('load', () => store.listTrades(), 1);
  const noTags = measure('noTags', () => store.listTrades({ withTags: false }), 1);
  const filtered = measure('filter', () => filterTrades(load.value, {}), 3);
  const analyzed = measure('analyze', () => analyze(filtered.value), 1);
  console.log(`\n冷路径拆解（${N.toLocaleString()} 笔）`);
  console.log(`  listTrades(含标签): ${load.ms.toFixed(0)} ms`);
  console.log(`  listTrades(不含标签): ${noTags.ms.toFixed(0)} ms`);
  console.log(`  filterTrades(无筛选排序): ${filtered.ms.toFixed(0)} ms`);
  console.log(`  analyze: ${analyzed.ms.toFixed(0)} ms`);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('场景', 24)}${pad('旧/冷路径', 16)}${pad('新/热路径', 16)}${pad('加速', 10)}备注`);
for (const [name, legacy, paged, note] of rows) {
  const speed = legacy.ms > 0 ? (legacy.ms / Math.max(paged.ms, 0.01)).toFixed(1) + 'x' : '—';
  console.log(`${pad(name, 24)}${pad(legacy.ms.toFixed(0) + ' ms', 16)}${pad(paged.ms.toFixed(1) + ' ms', 16)}${pad(speed, 10)}${note}`);
}
console.log(`\n结果一致性: ${process.exitCode ? 'FAILED' : 'OK'}`);

closeDb();
fs.rmSync(dir, { recursive: true, force: true });
