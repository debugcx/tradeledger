import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCsvSmart, autoMap, detectPreset, detectMode, validateMapping,
  buildTrades, buildTradesFromFills, decodeCsvBuffer, normalizeCsvSymbol,
} from '../src/csv.js';

test('CSV：跳过标题/账户信息行，定位表头', () => {
  const text = [
    'OKX Futures Position History',
    'Account: 123456',
    'Instrument ID,Position Side,Open Time,Close Time,Open Avg Price,Close Avg Price,Open Max Pos,Realized PnL,Fee,Funding Fee',
    'BTC-USDT-SWAP,long,2026-10-01 10:00:00,2026-10-01 12:00:00,68000,69000,1,99.5,-1.2,-0.3',
  ].join('\n');
  const parsed = parseCsvSmart(text);
  assert.equal(parsed.headerIndex, 2);
  assert.equal(parsed.skippedRows, 2);
  assert.deepEqual(parsed.headers.slice(0, 3), ['Instrument ID', 'Position Side', 'Open Time']);
});

test('CSV：OKX 仓位历史（round trip）自动映射与导入', () => {
  const text = [
    'Instrument ID,Position Side,Open Time,Close Time,Open Avg Price,Close Avg Price,Open Max Pos,Realized PnL,Fee,Funding Fee',
    'BTC-USDT-SWAP,long,2026-10-01 10:00:00,2026-10-01 12:00:00,68000,69000,1,99.5,-1.2,-0.3',
  ].join('\n');
  const parsed = parseCsvSmart(text);
  const mapping = autoMap(parsed.headers);
  assert.equal(mapping.symbol, 0);
  assert.equal(mapping.side, 1);
  assert.equal(mapping.entry_price, 4);
  assert.equal(mapping.exit_price, 5);
  assert.equal(mapping.size, 6);
  assert.equal(mapping.pnl, 7);
  assert.equal(detectMode(parsed.headers, mapping), 'roundtrip');
  assert.deepEqual(validateMapping(mapping, parsed.headers, 'roundtrip'), []);

  const { trades, errors } = buildTrades(parsed.headers, parsed.rows, mapping, { tzOffset: 0, costPositive: true });
  assert.equal(errors.length, 0);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.symbol, 'BTC/USDT');
  assert.equal(t.side, 'long');
  assert.equal(t.size, 1);
  assert.equal(t.entry_price, 68000);
  assert.equal(t.exit_price, 69000);
  assert.equal(t.pnl, 99.5);
  assert.equal(t.fee, -1.2);
  assert.equal(t.funding, -0.3);
  assert.match(t.external_id, /^csv:/);
});

test('CSV：Binance 现货逐笔成交自动识别并 FIFO 配对', () => {
  const text = [
    'Time,Pair,Side,Price,Executed,Amount,Fee',
    '2026-10-01 10:00:00,BTCUSDT,BUY,100,1,100,0.1',
    '2026-10-01 11:00:00,BTCUSDT,SELL,110,1,110,0.1',
  ].join('\n');
  const parsed = parseCsvSmart(text);
  const mapping = autoMap(parsed.headers);
  assert.equal(mapping.symbol, 1);
  assert.equal(mapping.close_time, 0);
  assert.equal(mapping.exit_price, 3);
  assert.equal(mapping.size, 4);
  assert.equal(detectMode(parsed.headers, mapping), 'fills');
  assert.deepEqual(validateMapping(mapping, parsed.headers, 'fills'), []);

  const { trades, errors } = buildTradesFromFills(parsed.headers, parsed.rows, mapping, {
    tzOffset: 0, costPositive: true,
  });
  assert.equal(errors.length, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, 'BTC/USDT');
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].entry_price, 100);
  assert.equal(trades[0].exit_price, 110);
  assert.equal(trades[0].size, 1);
  assert.equal(trades[0].fee, -0.2);
  assert.ok(Math.abs(trades[0].pnl - 9.8) < 1e-9);
  assert.equal(trades[0].source, 'csv');
});

test('CSV：没有方向列时按带符号数量配对（Gate/Bitget fills）', () => {
  const text = [
    'Contract,Size,Price,Fee,Create Time',
    'BTC_USDT,1,100,0.1,2026-10-01 10:00:00',
    'BTC_USDT,-1,110,0.1,2026-10-01 11:00:00',
  ].join('\n');
  const parsed = parseCsvSmart(text);
  const mapping = autoMap(parsed.headers);
  assert.equal(mapping.symbol, 0);
  assert.equal(mapping.size, 1);
  assert.equal(mapping.exit_price, 2);
  assert.equal(mapping.fee, 3);
  assert.equal(mapping.open_time, 4);
  assert.equal(detectMode(parsed.headers, mapping), 'fills');
  assert.deepEqual(validateMapping(mapping, parsed.headers, 'fills'), []);

  const { trades, errors } = buildTradesFromFills(parsed.headers, parsed.rows, mapping, {
    tzOffset: 0, costPositive: true,
  });
  assert.equal(errors.length, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, 'BTC/USDT');
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].entry_price, 100);
  assert.equal(trades[0].exit_price, 110);
  assert.ok(Math.abs(trades[0].pnl - 9.8) < 1e-9);
});

test('CSV：现货逐笔成交按 long-only 配对，忽略无持仓的卖出', () => {
  const text = [
    'Time,Pair,Side,Price,Executed,Fee',
    '2026-10-01 09:00:00,ETHUSDT,SELL,2000,1,0.1',
    '2026-10-01 10:00:00,ETHUSDT,BUY,1000,1,0.1',
    '2026-10-01 11:00:00,ETHUSDT,SELL,1100,1,0.1',
  ].join('\n');
  const parsed = parseCsvSmart(text);
  const mapping = autoMap(parsed.headers);
  assert.equal(detectMode(parsed.headers, mapping), 'fills');

  const futures = buildTradesFromFills(parsed.headers, parsed.rows, mapping, {
    tzOffset: 0, costPositive: true, market: 'futures',
  });
  assert.equal(futures.trades.length, 1);
  assert.equal(futures.trades[0].side, 'short');
  assert.equal(futures.trades[0].market, 'futures');

  const spot = buildTradesFromFills(parsed.headers, parsed.rows, mapping, {
    tzOffset: 0, costPositive: true, market: 'spot',
  });
  assert.equal(spot.errors.length, 0);
  assert.equal(spot.trades.length, 1);
  assert.equal(spot.trades[0].side, 'long');
  assert.equal(spot.trades[0].market, 'spot');
  assert.equal(spot.trades[0].entry_price, 1000);
  assert.equal(spot.trades[0].exit_price, 1100);
});

test('CSV：Bybit 逐仓盈亏表头识别', () => {
  const headers = ['Symbol', 'Side', 'Qty', 'Entry Price', 'Exit Price', 'Closed PnL', 'Fees', 'Funding Fee', 'Created Time', 'Updated Time'];
  const preset = detectPreset(headers);
  assert.equal(preset.id, 'bybit');
  const mapping = autoMap(headers);
  assert.equal(mapping.symbol, 0);
  assert.equal(mapping.side, 1);
  assert.equal(mapping.size, 2);
  assert.equal(mapping.entry_price, 3);
  assert.equal(mapping.exit_price, 4);
  assert.equal(mapping.pnl, 5);
  assert.equal(mapping.fee, 6);
  assert.equal(mapping.funding, 7);
  assert.equal(mapping.open_time, 8);
  assert.equal(mapping.close_time, 9);
  assert.equal(detectMode(headers, mapping), 'roundtrip');
});

test('CSV：无效映射与符号归一', () => {
  const headers = ['Pair', 'Price', 'Qty'];
  const mapping = autoMap(headers);
  const errs = validateMapping(mapping, headers, 'fills');
  assert.ok(errs.length >= 1);
  assert.equal(normalizeCsvSymbol('BTC-USDT-SWAP'), 'BTC/USDT');
  assert.equal(normalizeCsvSymbol('BTC_USDT'), 'BTC/USDT');
  assert.equal(normalizeCsvSymbol('BTCUSDT'), 'BTC/USDT');
  assert.equal(normalizeCsvSymbol('ETHUSDC'), 'ETH/USDC');
  assert.equal(normalizeCsvSymbol('SMOKE-CSV-1/USDT'), 'SMOKE-CSV-1/USDT');
});

test('CSV：UTF-8 / UTF-16 编码解码', () => {
  const text = 'Symbol,Side\nBTCUSDT,Buy';
  const utf8 = Buffer.from(text, 'utf8');
  assert.equal(decodeCsvBuffer(utf8), text);

  const utf8Bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8]);
  assert.equal(decodeCsvBuffer(utf8Bom), text);

  const utf16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeCsvBuffer(utf16le), text);
});
