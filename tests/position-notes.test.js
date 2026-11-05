import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let seq = 0;
function trade(over = {}) {
  return {
    external_id: `t:${++seq}`,
    symbol: 'BTC-USDT-SWAP',
    side: 'long',
    order_type: 'limit',
    size: 1,
    notional: 60000,
    entry_price: 60000,
    exit_price: 61000,
    open_time: iso(-3600_000),
    close_time: iso(0),
    pnl: 1000,
    fee: 6,
    funding: 0,
    source: 'api',
    market: 'futures',
    ...over,
  };
}

async function setup() {
  const { openDb, setDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  return import('../src/store.js');
}

test('持仓笔记：写入/覆盖/清除，未平仓不归档', async () => {
  const store = await setup();
  const acc = store.createAccount({ exchange: 'fake', name: '笔记A', apiKey: 'k', apiSecret: 's' });

  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '突破回踩进场，止损 61000');
  assert.equal(store.listPositionNotes().length, 1);
  const first = store.listPositionNotes()[0];
  assert.equal(first.content, '突破回踩进场，止损 61000');
  assert.equal(first.side, 'long');

  // 覆盖更新保留首次写入时间：归档靠它判定笔记属于哪个回合
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '改主意：止损放宽');
  assert.equal(store.listPositionNotes()[0].created_at, first.created_at);

  // 空内容 = 清除
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '  ');
  assert.equal(store.listPositionNotes().length, 0);
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '突破回踩进场，止损 61000');

  // 持仓还在：显式归档与交易落库钩子都不动它
  store.replacePositions(acc.id, [{
    symbol: 'BTC-USDT-SWAP', side: 'long', size: 2,
    entry_price: 60000, mark_price: 60500, unrealized: 500,
  }]);
  store.archivePositionNotes(acc.id);
  assert.equal(store.listPositionNotes().length, 1);

  // 部分平仓交易落库（importTrades 钩子自动触发），仍未清仓 → 不归档、交易不带笔记
  store.importTrades([trade({ external_id: 'part1' })], acc.id, { upsert: true });
  assert.equal(store.listPositionNotes().length, 1);
  assert.equal(store.listTrades({ accountId: acc.id })[0].note, null);
});

test('持仓笔记：清仓后归档进本回合全部平仓交易并消费', async () => {
  const store = await setup();
  const acc = store.createAccount({ exchange: 'fake', name: '笔记B', apiKey: 'k', apiSecret: 's' });

  store.replacePositions(acc.id, [{
    symbol: 'BTC-USDT-SWAP', side: 'long', size: 2,
    entry_price: 60000, mark_price: 60500, unrealized: 500,
  }]);
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', 'FIFO 拆两条，都要带上');

  // 持仓还在 → 不归档
  store.archivePositionNotes(acc.id);
  assert.equal(store.listPositionNotes().length, 1);

  // 清仓：快照里持仓消失，平仓交易尚未同步 → 挂起保留
  store.replacePositions(acc.id, []);
  store.archivePositionNotes(acc.id);
  assert.equal(store.listPositionNotes().length, 1);

  // 本回合两条平仓交易（FIFO 拆分）落库 → 归档到两条，笔记消费掉
  store.importTrades([
    trade({ external_id: 'p1' }),
    trade({ external_id: 'p2' }),
  ], acc.id, { upsert: true });
  assert.equal(store.listPositionNotes().length, 0);
  const rows = store.listTrades({ accountId: acc.id });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.note, 'FIFO 拆两条，都要带上');
    assert.ok(r.note_updated_at);
  }
});

test('持仓笔记：早于笔记的旧回合不被污染，已有笔记的交易不覆盖', async () => {
  const store = await setup();
  const acc = store.createAccount({ exchange: 'fake', name: '笔记C', apiKey: 'k', apiSecret: 's' });

  // 旧回合：平仓时间早于笔记写入 30 分钟（超出宽限）→ 不归档
  store.replacePositions(acc.id, []);
  store.importTrades([trade({ external_id: 'old', close_time: iso(-30 * 60_000) })], acc.id, { upsert: true });
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '新想法');
  store.importTrades([trade({ external_id: 'old2', close_time: iso(-30 * 60_000) })], acc.id, { upsert: true });
  assert.equal(store.listPositionNotes().length, 1);
  assert.equal(store.listTrades({ accountId: acc.id }).every((r) => !r.note), true);

  // 宽限内（5 分钟前平仓才写的笔记）→ 归档
  store.archivePositionNotes(acc.id);
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '刚平仓就记');
  store.importTrades([trade({ external_id: 'recent', close_time: iso(-5 * 60_000) })], acc.id, { upsert: true });
  assert.equal(store.listPositionNotes().length, 0);
  assert.equal(store.listTrades({ accountId: acc.id }).find((r) => r.external_id === 'recent').note, '刚平仓就记');

  // 重开仓写新笔记：已带笔记的交易不覆盖，空位交易才归档
  store.replacePositions(acc.id, [{
    symbol: 'BTC-USDT-SWAP', side: 'long', size: 1,
    entry_price: 62000, mark_price: 62500, unrealized: 500,
  }]);
  store.setPositionNote(acc.id, 'BTC-USDT-SWAP', 'long', '第二回合');
  store.replacePositions(acc.id, []);
  store.importTrades([
    trade({ external_id: 'noted', close_time: iso(60_000), note: '手动复盘写好了' }),
    trade({ external_id: 'blank', close_time: iso(120_000) }),
  ], acc.id, { upsert: true });
  assert.equal(store.listPositionNotes().length, 0);
  const noted = store.listTrades({ accountId: acc.id }).find((r) => r.external_id === 'noted');
  const blank = store.listTrades({ accountId: acc.id }).find((r) => r.external_id === 'blank');
  assert.equal(noted.note, '手动复盘写好了');
  assert.equal(blank.note, '第二回合');
});

test('持仓笔记：liveSnapshot 快照带 positionNotes', async () => {
  const store = await setup();
  const { liveSnapshot } = await import('../src/live.js');
  const acc = store.createAccount({ exchange: 'fake', name: '笔记D', apiKey: 'k', apiSecret: 's' });

  store.setPositionNote(acc.id, 'ETH-USDT-SWAP', 'short', '资金费率高，做空吃费率');
  const snap = liveSnapshot();
  assert.equal(snap.positionNotes.length, 1);
  assert.equal(snap.positionNotes[0].content, '资金费率高，做空吃费率');
});
