import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsv, detectDelimiter, autoMap, parseNumber, parseTimeValue,
  normalizeSide, normalizeOrderType, buildTrades, fingerprintTrade,
  templateFromMapping, mappingFromTemplate,
} from '../src/csv.js';
import { analyze, filterTrades, dailyMap } from '../src/stats.js';
import { tradeBreakdown } from '../src/breakdown.js';

const headers = ['Time', 'Symbol', 'Side', 'Price', 'Quantity', 'Realized Profit', 'Fee', 'Fee Coin'];

function trade(overrides = {}) {
  return {
    id: 1,
    symbol: 'BTC/USDT',
    side: 'long',
    order_type: 'market',
    size: 1,
    notional: 10000,
    entry_price: 10000,
    exit_price: 10100,
    open_time: '2026-10-01T00:00:00.000Z',
    close_time: '2026-10-01T02:00:00.000Z',
    pnl: 100,
    fee: 0,
    funding: 0,
    tags: [],
    note: null,
    ...overrides,
  };
}

/* ---------------- CSV 解析 ---------------- */

test('parseCsv：引号、逗号、换行与 BOM', () => {
  const text = '\uFEFFa,b\n1,"x,y"\n2,"line1\nline2"\n\n';
  const { headers: h, rows } = parseCsv(text);
  assert.deepEqual(h, ['a', 'b']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], 'x,y');
  assert.equal(rows[1][1], 'line1\nline2');
});

test('detectDelimiter：自动识别分号/制表符', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
});

test('autoMap：Binance 风格表头', () => {
  const m = autoMap(headers);
  assert.equal(m.close_time, 0);
  assert.equal(m.symbol, 1);
  assert.equal(m.side, 2);
  assert.equal(m.exit_price, 3);
  assert.equal(m.size, 4);
  assert.equal(m.pnl, 5);
  assert.equal(m.fee, 6);
});

test('autoMap：中文表头', () => {
  const zh = ['开仓时间', '平仓时间', '交易对', '方向', '开仓均价', '平仓均价', '数量', '已实现盈亏', '手续费', '资金费'];
  const m = autoMap(zh);
  assert.equal(m.open_time, 0);
  assert.equal(m.close_time, 1);
  assert.equal(m.symbol, 2);
  assert.equal(m.side, 3);
  assert.equal(m.entry_price, 4);
  assert.equal(m.exit_price, 5);
  assert.equal(m.size, 6);
  assert.equal(m.pnl, 7);
  assert.equal(m.fee, 8);
  assert.equal(m.funding, 9);
});

test('autoMap：Bybit closed-pnl 表头', () => {
  const bybit = ['Symbol', 'Side', 'Qty', 'Entry Price', 'Exit Price', 'Closed PnL', 'Fees', 'Funding Fee', 'Created Time', 'Updated Time'];
  const m = autoMap(bybit);
  assert.equal(m.symbol, 0);
  assert.equal(m.side, 1);
  assert.equal(m.size, 2);
  assert.equal(m.entry_price, 3);
  assert.equal(m.exit_price, 4);
  assert.equal(m.pnl, 5);
  assert.equal(m.fee, 6);
  assert.equal(m.funding, 7);
  assert.equal(m.open_time, 8);
  assert.equal(m.close_time, 9);
});

test('parseNumber：千分位、括号负数、货币符号', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('(12.30)'), -12.3);
  assert.equal(parseNumber('-$5.00'), -5);
  assert.equal(parseNumber('12.5 USDT'), 12.5);
  assert.equal(parseNumber('0,5'), 0.5);
  assert.equal(parseNumber(''), 0);
});

test('parseTimeValue：epoch、无时区字符串、时区偏移', () => {
  assert.equal(parseTimeValue('1759312800'), '2025-10-01T10:00:00.000Z');
  assert.equal(parseTimeValue('1759312800000'), '2025-10-01T10:00:00.000Z');
  assert.equal(parseTimeValue('2026-10-01 10:00:00', 8), '2026-10-01T02:00:00.000Z');
  assert.equal(parseTimeValue('2026-10-01T10:00:00Z'), '2026-10-01T10:00:00.000Z');
  assert.equal(parseTimeValue('2026/10/01 10:00', 0), '2026-10-01T10:00:00.000Z');
  assert.equal(parseTimeValue('not-a-date'), null);
});

test('normalizeSide / normalizeOrderType', () => {
  assert.equal(normalizeSide('Buy'), 'long');
  assert.equal(normalizeSide('Sell'), 'short');
  assert.equal(normalizeSide('开多'), 'long');
  assert.equal(normalizeSide('平空'), 'short');
  assert.equal(normalizeSide('平多'), 'long');
  assert.equal(normalizeSide('做空'), 'short');
  assert.equal(normalizeOrderType('LIMIT'), 'limit');
  assert.equal(normalizeOrderType('市价'), 'market');
  assert.equal(normalizeOrderType(''), 'other');
});

test('buildTrades：自动映射、费用符号、标签、指纹去重', () => {
  const { headers: h, rows } = parseCsv(
    'symbol,side,close_time,pnl,fee,funding,entry_price,exit_price,size,tags\n'
    + 'BTC/USDT,long,2026-10-01 10:00:00,12.5,0.5,0.1,100,101,1,"趋势;计划内"\n',
  );
  const mapping = autoMap(h);
  const a = buildTrades(h, rows, mapping, { tzOffset: 0, costPositive: true });
  assert.equal(a.errors.length, 0);
  assert.equal(a.trades.length, 1);
  const t = a.trades[0];
  assert.equal(t.pnl, 12.5);
  assert.equal(t.fee, -0.5);
  assert.equal(t.funding, -0.1);
  assert.deepEqual(t.tags, ['趋势', '计划内']);
  assert.match(t.external_id, /^csv:[0-9a-f]{16}$/);

  // 同样的行再次导入，指纹必须一致
  const b = buildTrades(h, rows, mapping, { tzOffset: 0, costPositive: true });
  assert.equal(fingerprintTrade(t), fingerprintTrade(b.trades[0]));
  assert.equal(t.external_id, b.trades[0].external_id);
});

test('buildTrades：缺少盈亏时用价格与数量计算', () => {
  const { headers: h, rows } = parseCsv(
    'symbol,side,close_time,entry_price,exit_price,size,open_time\n'
    + 'ETH/USDT,short,2026-10-01 12:00:00,100,90,2,2026-10-01 10:00:00\n',
  );
  const mapping = autoMap(h);
  const { trades, errors } = buildTrades(h, rows, mapping, { tzOffset: 0 });
  assert.equal(errors.length, 0);
  assert.equal(trades[0].pnl, 20); // 空单：(100-90)*2
  assert.equal(trades[0].notional, 200);
});

test('映射模板：按表头名保存，换列顺序后仍可复用', () => {
  const headers = ['Time', 'Symbol', 'Side', 'Price', 'Quantity', 'Realized Profit', 'Fee'];
  const mapping = autoMap(headers);
  const template = templateFromMapping(headers, mapping);
  assert.equal(template.symbol, 'Symbol');
  assert.equal(template.close_time, 'Time');

  const reordered = ['Symbol', 'Time', 'Realized Profit', 'Side', 'Price', 'Quantity', 'Fee'];
  const mapped = mappingFromTemplate(reordered, template);
  assert.equal(mapped.symbol, 0);
  assert.equal(mapped.close_time, 1);
  assert.equal(mapped.pnl, 2);
  assert.equal(mapped.side, 3);
  assert.equal(mapped.exit_price, 4);
  assert.equal(mapped.size, 5);
  assert.equal(mapped.fee, 6);
});

test('buildTrades：坏行进入 errors，不阻断其他行', () => {
  const { headers: h, rows } = parseCsv(
    'symbol,close_time,pnl\nGOOD/USDT,2026-10-01 10:00:00,5\n,2026-10-01 11:00:00,6\nBAD/USDT,nope,7\n',
  );
  const { trades, errors } = buildTrades(h, rows, autoMap(h), {});
  assert.equal(trades.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /币种|时间/);
});

/* ---------------- 统计 ---------------- */

test('analyze：胜率、期望值、累计与回撤', () => {
  const trades = [
    trade({ id: 1, pnl: 100, close_time: '2026-10-01T10:00:00.000Z' }),
    trade({ id: 2, pnl: -50, side: 'short', close_time: '2026-10-02T10:00:00.000Z' }),
    trade({ id: 3, pnl: 30, close_time: '2026-10-03T10:00:00.000Z' }),
    trade({ id: 4, pnl: -10, side: 'short', close_time: '2026-10-04T10:00:00.000Z' }),
  ];
  const s = analyze(trades);
  assert.equal(s.total, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.avgWin, 65);
  assert.equal(s.avgLoss, 30);
  assert.equal(s.expectancy, 17.5);
  assert.equal(s.totalPnl, 70);
  assert.equal(s.longs.count, 2);
  assert.equal(s.shorts.count, 2);
  assert.equal(s.maxConsecutiveWin, 1);
  assert.equal(s.maxConsecutiveLoss, 1);
  assert.equal(s.cumulative.at(-1).value, 70);
  assert.equal(s.drawdown.maxDrawdown, 50);
  assert.equal(s.hourWeekday.length, 7);
  assert.equal(s.hourWeekday[0].length, 24);
  assert.equal(s.daily.length, 4);
});

test('analyze：空数据不抛错', () => {
  const s = analyze([]);
  assert.equal(s.total, 0);
  assert.equal(s.winRate, 0);
  assert.equal(s.hourWeekday.length, 7);
  assert.equal(s.hourWeekday[0].length, 24);
  assert.equal(s.bestSlot, null);
  assert.equal(s.drawdown.maxDrawdown, 0);
});

test('analyze：周×小时矩阵的盈亏合计等于总盈亏', () => {
  const trades = [
    trade({ id: 1, pnl: 12, close_time: '2026-10-01T10:00:00.000Z' }),
    trade({ id: 2, pnl: -3, close_time: '2026-10-01T11:00:00.000Z' }),
    trade({ id: 3, pnl: 7, close_time: '2026-10-02T10:00:00.000Z' }),
  ];
  const s = analyze(trades);
  const matrixSum = s.hourWeekday.flat().reduce((acc, c) => acc + c.pnl, 0);
  assert.equal(Number(matrixSum.toFixed(6)), s.totalPnl);
  assert.equal(s.bestSlot.pnl, 12);
  assert.equal(s.worstSlot.pnl, -3);
});

test('filterTrades：筛选与排序', () => {
  const trades = [
    trade({ id: 1, side: 'long', pnl: 10, tags: ['趋势'], note: 'ok', account_id: 1 }),
    trade({ id: 2, side: 'short', pnl: -5, tags: ['逆势'], note: null, account_id: 2 }),
    trade({ id: 3, side: 'long', pnl: 20, symbol: 'ETH/USDT', tags: ['趋势'], account_id: 1 }),
  ];
  assert.equal(filterTrades(trades, { side: 'long' }).length, 2);
  assert.equal(filterTrades(trades, { result: 'loss' }).length, 1);
  assert.equal(filterTrades(trades, { tag: '趋势' }).length, 2);
  assert.equal(filterTrades(trades, { note: 'yes' }).length, 1);
  assert.equal(filterTrades(trades, { q: 'eth' }).length, 1);
  assert.equal(filterTrades(trades, { sort: 'pnl' })[0].id, 3);
  assert.equal(filterTrades(trades, { account_id: '1' }).length, 2);
  assert.equal(filterTrades(trades, { account_id: '2' }).length, 1);
  assert.equal(filterTrades(trades, { account_id: 'all' }).length, 3);
});

test('dailyMap：按本地日期聚合', () => {
  const map = dailyMap([
    trade({ pnl: 1, close_time: '2026-10-01T10:00:00.000Z' }),
    trade({ pnl: 2, close_time: '2026-10-01T11:00:00.000Z' }),
  ]);
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].trades, 2);
  assert.equal([...map.values()][0].pnl, 3);
});

/* ---------------- 盈亏推导 ---------------- */

test('tradeBreakdown：毛盈亏 = 净盈亏 − 手续费 − 资金费', () => {
  const b = tradeBreakdown(trade({ pnl: 7, fee: -2, funding: -1, entry_price: 100, exit_price: 110, size: 1 }));
  assert.equal(b.gross, 10);
  assert.equal(b.pricePnl, 10);
  assert.equal(b.priceMatch, true);
  assert.equal(b.costs, -3);
});

test('tradeBreakdown：空单方向与复算差异', () => {
  const b = tradeBreakdown(trade({
    side: 'short', entry_price: 100, exit_price: 90, size: 2, pnl: 18, fee: -1, funding: -1,
  }));
  assert.equal(b.pricePnl, 20);
  assert.equal(b.gross, 20);
  assert.equal(b.priceMatch, true);
  const c = tradeBreakdown(trade({ pnl: 12.5, fee: -0.5, funding: -0.1, entry_price: 1, exit_price: 1.05, size: 100 }));
  assert.equal(c.gross, 13.1);
  assert.ok(Math.abs(c.pricePnl - 5) < 1e-9);
  assert.equal(c.priceMatch, false);
});

/* ---------------- 数据库与种子 ---------------- */

test('seed：固定 564 笔，清空演示数据后归零', async () => {
  process.env.DB_FILE = ':memory:';
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { seed } = await import('../src/seed.js');

  seed({ quiet: true });
  assert.equal(store.countTrades(), 564);
  const stats = analyze(store.listTrades());
  assert.equal(stats.total, 564);
  assert.ok(stats.winRate > 0.2 && stats.winRate < 0.8);
  assert.equal(store.listAccounts().length, 2);

  const cleared = store.clearDemoData();
  assert.equal(cleared.trades, 564);
  assert.equal(store.countTrades(), 0);
  closeDb();
});
