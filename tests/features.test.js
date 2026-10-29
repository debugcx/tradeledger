import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const { renderMarkdown } = await import('../src/markdown.js');

test('回溯范围：按交易所上限截断，0 表示全部可用', async () => {
  const { lookbackDaysFor } = await import('../src/sync.js');
  assert.equal(lookbackDaysFor({ lookback_days: 0 }, { maxLookbackDays: 90 }), 90);
  assert.equal(lookbackDaysFor({ lookback_days: 365 }, { maxLookbackDays: 90 }), 90);
  assert.equal(lookbackDaysFor({ lookback_days: null }, { maxLookbackDays: 730 }), 180);
  assert.equal(lookbackDaysFor({ lookback_days: 0 }, { maxLookbackDays: 3650 }), 3650);
  assert.equal(lookbackDaysFor({ lookback_days: 90 }, {}), 90);
});

test('Markdown：标题、粗体、链接、图片、列表、代码', () => {
  const html = renderMarkdown([
    '# 周复盘',
    '',
    '本周 **执行** 不错，参考 [规则](/dashboard/review)。',
    '',
    '![截图](/media/abc)',
    '',
    '- 第一点',
    '- 第二点',
    '',
    '```js',
    'const x = 1;',
    '```',
  ].join('\n'));
  assert.match(html, /<h1>周复盘<\/h1>/);
  assert.match(html, /<strong>执行<\/strong>/);
  assert.match(html, /<a href="\/dashboard\/review"/);
  assert.match(html, /<img src="\/media\/abc"/);
  assert.match(html, /<ul><li>第一点<\/li><li>第二点<\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-js">/);
});

test('Markdown：原始 HTML 与 javascript: 图片被拦截', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n![x](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(!/<img[^>]+src="javascript:/i.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('资金费分配、余额/持仓、图片资源与 LLM 配置', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const llm = await import('../src/llm.js');

  const account = store.createAccount({ exchange: 'fake', name: 'A', apiKey: 'key-9999', apiSecret: 's' });
  assert.equal(store.getAccountCredentials(account.id).apiSecret, 's');
  const passAccount = store.createAccount({
    exchange: 'fake', name: 'P', apiKey: 'k2', apiSecret: 's2', passphrase: '  p@ss  ',
  });
  assert.equal(store.getAccountCredentials(passAccount.id).passphrase, '  p@ss  ');

  const lbAccount = store.createAccount({
    exchange: 'fake', name: 'L', apiKey: 'k3', apiSecret: 's3', lookbackDays: 0,
  });
  assert.equal(lbAccount.lookback_days, 0);
  store.updateAccount(lbAccount.id, { lookbackDays: 90 });
  assert.equal(store.getAccount(lbAccount.id).lookback_days, 90);
  store.updateAccountSyncState(lbAccount.id, { done: 1, state: { fromMs: 1, toMs: 2 } });
  assert.equal(store.getAccount(lbAccount.id).sync_done, 1);
  store.resetAccountSync(lbAccount.id);
  assert.equal(store.getAccount(lbAccount.id).sync_done, 0);
  assert.equal(store.getAccount(lbAccount.id).sync_state, null);
  store.updateAccountTransferSync(lbAccount.id);
  assert.ok(store.getAccount(lbAccount.id).last_transfer_sync_at);

  const transferCount = store.insertTransfers([
    { external_id: 'tr1', type: 'deposit', asset: 'USDT', amount: 100, fee: 0, tx_time: '2026-10-01T00:00:00.000Z', tx_id: '0x1', chain: 'TRC20' },
    { external_id: 'tr2', type: 'withdraw', asset: 'USDT', amount: 40, fee: 1, tx_time: '2026-10-02T00:00:00.000Z' },
  ], account.id);
  assert.equal(transferCount, 2);
  assert.equal(store.insertTransfers([
    { external_id: 'tr1', type: 'deposit', asset: 'USDT', amount: 100, tx_time: '2026-10-01T00:00:00.000Z' },
  ], account.id), 0);
  assert.equal(store.listTransfers({ accountId: account.id }).length, 2);
  assert.equal(store.listTransfers({ accountId: account.id, type: 'withdraw' }).length, 1);
  const ts = store.transferSummary();
  assert.equal(ts.deposits, 100);
  assert.equal(ts.withdrawals, 40);
  assert.equal(ts.net, 60);

  // 返佣账单：计入流水但不计入充值/提现汇总；rebateSummary 区分 USDT 与非 USDT
  assert.equal(store.insertTransfers([
    { external_id: 'rb1', type: 'rebate', asset: 'USDT', amount: 12.5, fee: 0, tx_time: '2026-10-03T00:00:00.000Z', note: '邀请返佣' },
    { external_id: 'rb2', type: 'rebate', asset: 'BTC', amount: 0.002, fee: 0, tx_time: '2026-10-04T00:00:00.000Z' },
  ], account.id), 2);
  assert.equal(store.listTransfers({ accountId: account.id, type: 'rebate' }).length, 2);
  const ts2 = store.transferSummary();
  assert.equal(ts2.deposits, 100);
  assert.equal(ts2.withdrawals, 40);
  assert.deepEqual(store.rebateSummary(), { count: 2, usdt: 12.5, others: 1 });
  assert.deepEqual(store.rebateSummary(account.id), { count: 2, usdt: 12.5, others: 1 });
  const net = store.transferSummary().byAssetNet;
  assert.equal(net.length, 2);
  const usdt = net.find((x) => x.asset === 'USDT');
  assert.equal(usdt.inflow, 112.5); // 充值 100 + 返佣 12.5
  assert.equal(usdt.outflow, 40);   // 提现 40（不含手续费字段）
  const trade = {
    external_id: 't1',
    symbol: 'BTC/USDT',
    side: 'long',
    order_type: 'market',
    size: 1,
    notional: 100,
    entry_price: 100,
    exit_price: 110,
    open_time: '2026-10-01T00:00:00.000Z',
    close_time: '2026-10-01T08:00:00.000Z',
    pnl: 10,
    fee: -1,
    funding: 0,
    source: 'api',
  };
  store.importTrades([trade], account.id);

  const inserted = store.insertFundingEvents([
    { external_id: 'f1', symbol: 'BTC/USDT', time: '2026-10-01T04:00:00.000Z', amount: -2 },
    { external_id: 'f2', symbol: 'BTC/USDT', time: '2026-10-02T04:00:00.000Z', amount: 1 },
  ], account.id);
  assert.equal(inserted, 2);
  const applied = store.applyFundingEvents(account.id);
  assert.equal(applied, 1);

  const saved = store.listTrades()[0];
  assert.equal(saved.funding, -2);
  assert.equal(saved.pnl, 8);
  const summary = store.fundingSummary();
  assert.equal(summary.events, 2);
  assert.equal(summary.net, -1);
  assert.equal(summary.unallocated, 1);
  assert.equal(summary.unallocatedAmount, 1);

  store.replaceBalances(account.id, [{ asset: 'USDT', total: 100, free: 50 }]);
  store.replacePositions(account.id, [{
    symbol: 'BTC/USDT', side: 'long', size: 1, entry_price: 100, mark_price: 110,
    unrealized: 10, funding_rate: 0.0001, next_funding_time: '2026-10-01T16:00:00.000Z',
  }]);
  assert.equal(store.listBalances()[0].total, 100);
  assert.equal(store.listPositions()[0].funding_rate, 0.0001);

  store.saveResource({ id: 'r1', name: 'x.png', mime: 'image/png', size: 3, data: Buffer.from([1, 2, 3]) });
  const resource = store.getResource('r1');
  assert.equal(resource.mime, 'image/png');
  assert.equal(resource.data.length, 3);

  llm.saveLlmConfig({ provider: 'openai', baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'sk-test-9999' });
  const cfg = llm.getLlmConfig();
  assert.equal(cfg.hasKey, true);
  assert.equal(cfg.keyHint, '9999');
  assert.equal(llm.getLlmConfig({ withSecret: true }).apiKey, 'sk-test-9999');
  llm.saveLlmConfig({ temperature: 0.7 });
  assert.equal(llm.getLlmConfig().temperature, 0.7);

  await assert.rejects(
    () => llm.callLlm({
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'openai', baseUrl: 'https://example.com/v1', model: 'm', apiKey: '' },
    }),
    /API Key/,
  );

  store.clearAllData();
  closeDb();
});

test('importTrades upsert：api 行回写最终状态，笔记保留，其他来源不受影响', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const acc = store.createAccount({ exchange: 'fake', name: 'U', apiKey: 'k', apiSecret: 's' });
  const base = {
    external_id: 'okx:111:2000', symbol: 'BTC/USDT', side: 'long', order_type: 'other',
    size: 3, notional: 300, entry_price: 105.985, exit_price: 106.19,
    open_time: '2026-10-20T14:12:41.693Z', close_time: '2026-10-22T08:10:02.213Z',
    source: 'api', market: 'futures',
  };
  const r1 = store.importTrades([{ ...base, pnl: 0.257, note: '中途快照，待平仓' }], acc.id);
  assert.equal(r1.inserted, 1);

  // OKX 原地更新了同一行（补仓 + 止损后的最终状态）
  const final = { ...base, size: 8, entry_price: 105.7425, exit_price: 104.15875, pnl: -13.49 };
  const r2 = store.importTrades([final], acc.id, { upsert: true });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 1);
  assert.equal(r2.skipped, 0);
  const row = store.listTrades({ accountId: acc.id }).find((t) => t.external_id === base.external_id);
  assert.equal(row.pnl, -13.49);
  assert.equal(row.size, 8);
  assert.equal(row.note, '中途快照，待平仓'); // 复盘笔记不被交易所数据覆盖
  assert.ok(row.note_updated_at);

  // 不开 upsert：维持旧的只跳过行为
  const r3 = store.importTrades([{ ...final, pnl: 999 }], acc.id);
  assert.equal(r3.inserted, 0);
  assert.equal(r3.skipped, 1);
  assert.equal(store.listTrades({ accountId: acc.id })[0].pnl, -13.49);

  // 非 api 来源（如 CSV）即使开了 upsert 也不回写
  const r4 = store.importTrades([{ ...final, pnl: 999, source: 'csv' }], acc.id, { upsert: true });
  assert.equal(r4.updated, 0);
  assert.equal(r4.skipped, 1);
  assert.equal(store.listTrades({ accountId: acc.id })[0].pnl, -13.49);

  // OKX 补写 openTime 导致同一回合带着新 ID 再来：按指纹改键，不产生重复行
  const drifted = {
    ...final,
    external_id: 'okx:111:9999',
    open_time: '2026-10-20T14:13:07.493Z',
    close_time: '2026-10-22T08:10:27.213Z',
    note: '不应覆盖已有笔记',
  };
  const r5 = store.importTrades([drifted], acc.id, { upsert: true });
  assert.equal(r5.updated, 1);
  assert.equal(r5.inserted, 0);
  const afterDrift = store.listTrades({ accountId: acc.id });
  assert.equal(afterDrift.length, 1);
  assert.equal(afterDrift[0].external_id, 'okx:111:9999'); // 已改键到新 ID
  assert.equal(afterDrift[0].note, '中途快照，待平仓'); // 用户笔记保留
  assert.equal(afterDrift[0].close_time, '2026-10-22T08:10:27.213Z'); // 时间字段回写为最终值

  store.clearAllData();
  closeDb();
});

test('行为诊断指标 + 多空统计排除无方向记录 + 复盘队列与快捷标签', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { analyze, filterTrades } = await import('../src/stats.js');
  const acc = store.createAccount({ exchange: 'fake', name: 'D', apiKey: 'k', apiSecret: 's' });

  // 胜率 80%（4/5）但均亏是均盈 10 倍：典型小赢大亏
  const mk = (id, pnl, hours, note = null) => ({
    external_id: `d:${id}`, symbol: 'BTC/USDT', side: 'long', size: 1,
    entry_price: 100, exit_price: 100 + pnl, pnl, fee: 0, funding: 0, source: 'api',
    open_time: '2026-10-01T00:00:00.000Z',
    close_time: new Date(Date.parse('2026-10-01T00:00:00.000Z') + hours * 3600_000).toISOString(),
    note,
  });
  store.importTrades([
    mk('w1', 1, 1), mk('w2', 1, 2), mk('w3', 1, 1), mk('w4', 1, 2),   // 4 笔小赢（持仓短）
    mk('big', -40, 24),                                                 // 1 笔大亏（持仓久）
    { ...mk('ledger', 0.5, 1), size: 0, notional: 0 },                  // 账本回填无方向
  ], acc.id);

  const trades = store.listTrades({ accountId: acc.id });
  const s = analyze(filterTrades(trades, {}));
  assert.equal(s.winRate, 5 / 6); // 4 笔小赢 + 账本回填 0.5 也是赢单
  const b = s.behavior;
  assert.ok(Math.abs(b.payoffRatio - (0.9 / 40)) < 1e-9);          // 均盈 0.9 / 均亏 40
  assert.ok(Math.abs(b.breakevenRatio - (1 / 6) / (5 / 6)) < 1e-9); // (1-胜率)/胜率 = 0.2
  assert.equal(b.bigLossCount, 1);
  assert.ok(Math.abs(b.bigLossSum - 40) < 1e-9);
  assert.ok(Math.abs(b.bigLossVsProfit - 40 / 4.5) < 1e-9);       // 抵消总盈利的 889%
  assert.ok(b.lossDurationMs > b.winDurationMs * 5);             // 亏损单拿得久
  // 多空统计排除 size=0 的账本回填记录
  assert.equal(s.longs.count, 5);
  assert.equal(s.shorts.count, 0);

  // 复盘队列：只有没写笔记的大亏（阈值 -30）会进队
  store.importTrades([mk('done', -35, 3, '已复盘'), mk('open', -31, 3)], acc.id);
  const queue2 = store.listReviewQueue({ threshold: -30, accountId: acc.id, limit: 10 });
  const queuedIds = queue2.map((t) => t.external_id);
  assert.ok(queuedIds.includes('d:big'));
  assert.ok(queuedIds.includes('d:open'));
  assert.ok(!queuedIds.includes('d:done')); // 写过复盘的不进队

  // 快捷标签切换
  const target = queue2[0];
  const t1 = store.toggleTradeTag(target.id, '扛单');
  assert.deepEqual(t1, { tag: '扛单', attached: true });
  assert.ok(store.getTrade(target.id).tags.includes('扛单'));
  const t2 = store.toggleTradeTag(target.id, '扛单');
  assert.deepEqual(t2, { tag: '扛单', attached: false });
  assert.ok(!store.getTrade(target.id).tags.includes('扛单'));

  store.clearAllData();
  closeDb();
});

test('交易详情缓存：曲线/明细落库回读、指纹失效、随交易级联删除', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const acc = store.createAccount({ exchange: 'fake', name: 'C', apiKey: 'k', apiSecret: 's' });
  const r = store.importTrades([{
    external_id: 'fake:curve:1', symbol: 'BTC/USDT', side: 'long', size: 1,
    entry_price: 100, exit_price: 110, pnl: 10, source: 'api',
    open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-01T02:00:00.000Z',
  }], acc.id);
  const tradeId = store.listTrades({ accountId: acc.id })[0].id;

  // 曲线：保存 → 回读一致
  const candles = [{ t: 1, o: 99, h: 101, l: 98, c: 100 }, { t: 2, o: 100, h: 111, l: 99, c: 110 }];
  const inputs = '100|110|1|long|2026-10-01T00:00:00.000Z|2026-10-01T02:00:00.000Z';
  assert.equal(store.getTradeCurveCache(tradeId), null);
  store.saveTradeCurveCache(tradeId, inputs, { bar: '1h', candles, truncated: false });
  const curve = store.getTradeCurveCache(tradeId);
  assert.equal(curve.bar, '1h');
  assert.deepEqual(curve.candles, candles);
  assert.equal(curve.truncated, false);

  // 明细：保存 → 回读一致
  assert.equal(store.getTradeFillsCache(tradeId), null);
  store.saveTradeFillsCache(tradeId, inputs, [{ t: 1, side: 'buy', price: 100, qty: 1, fee: -0.1, feeCcy: 'USDT' }]);
  assert.equal(store.getTradeFillsCache(tradeId).fills.length, 1);

  // 同一 trade_id 重复保存（amend 后新指纹）→ 覆盖而非新增
  store.saveTradeCurveCache(tradeId, inputs + ':amended', { bar: '2h', candles, truncated: true });
  const amended = store.getTradeCurveCache(tradeId);
  assert.equal(amended.inputs, inputs + ':amended');
  assert.equal(amended.bar, '2h');
  assert.equal(amended.truncated, true);

  // 删除交易 → 缓存级联删除
  store.deleteTrade(tradeId);
  assert.equal(store.getTradeCurveCache(tradeId), null);
  assert.equal(store.getTradeFillsCache(tradeId), null);

  store.clearAllData();
  closeDb();
});

test('笔记分类：周期 / 交易对档案 / 策略 / 现货备注与逐笔复盘汇总', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');

  const account = store.createAccount({ exchange: 'fake', name: 'N', apiKey: 'k', apiSecret: 's' });
  store.createTrade({
    symbol: 'BTC/USDT', side: 'long', size: 1, notional: 100,
    entry_price: 100, exit_price: 99,
    open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-01T02:00:00.000Z',
    pnl: -1, note: '突破失败，追高了',
  }, { accountId: account.id });

  const periodic = store.saveNote({ category: 'periodic', subject: '2026-W42', title: '', content: '周复盘' });
  assert.ok(periodic > 0);
  assert.match(store.getNote(periodic).title, /2026-W42/);

  const symbolId = store.saveNote({ category: 'symbol', subject: 'BTC/USDT', title: '', content: '档案 v1' });
  const symbolAgain = store.saveNote({ category: 'symbol', subject: 'BTC/USDT', content: '档案 v2' });
  assert.equal(symbolAgain, symbolId);
  assert.equal(store.listNotes({ category: 'symbol' }).length, 1);
  assert.equal(store.getNoteByCategory('symbol', 'BTC/USDT').content, '档案 v2');
  assert.throws(() => store.saveNote({ category: 'symbol', content: '缺少交易对' }), /需要填写交易对/);

  store.saveNote({ category: 'strategy', subject: '突破回踩', content: '策略规则' });
  const spotId = store.saveSpotNote(account.id, 'BTC/USDT', '长期持有');
  assert.equal(store.saveSpotNote(account.id, 'BTC/USDT', '长期持有，跌破 80 止损'), spotId);

  // 清仓重新买入：开一段新备注，旧备注保留
  store.replaceSpotHoldings(account.id, [{
    symbol: 'BTC/USDT', asset: 'BTC', quote: 'USDT', quantity: 1, price: 100, value: 100,
  }]);
  const round2 = store.openNewSpotNote(account.id, 'BTC/USDT');
  assert.notEqual(round2, spotId);
  assert.match(store.getNote(round2).title, /第2段$/);
  assert.throws(() => store.openNewSpotNote(account.id, 'ETH/USDT'), /没有持仓/);

  const spotNotesList = store.listNotes({ category: 'spot', subject: 'BTC/USDT' });
  assert.equal(spotNotesList.length, 2);
  assert.equal(spotNotesList[0].id, round2);

  const counts = store.noteCountsByCategory();
  assert.equal(counts.periodic, 1);
  assert.equal(counts.symbol, 1);
  assert.equal(counts.strategy, 1);
  assert.equal(counts.spot, 2);
  assert.equal(counts.all, 5);

  const grouped = store.listSymbolsWithTradeNotes();
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].symbol, 'BTC/USDT');
  assert.equal(grouped[0].count, 1);
  assert.equal(store.listTradeNotesBySymbol('BTC/USDT')[0].note, '突破失败，追高了');
  assert.equal(store.listRecentTradeNotes()[0].note, '突破失败，追高了');

  // 搜索：标题 / 内容 / 关联对象，LIKE 通配符按字面匹配
  assert.equal(store.listNotes({ q: '周复盘' }).length, 1);
  assert.equal(store.listNotes({ q: '突破回踩' }).length, 1);
  assert.equal(store.listNotes({ category: 'strategy', q: '档案' }).length, 0);
  assert.equal(store.listNotes({ q: '档案' }).length, 1);
  assert.equal(store.listNotes({ q: '%' }).length, 0);
  assert.equal(store.listNotes({ q: '不存在的关键词' }).length, 0);

  const holding = store.listSpotHoldings()[0];
  // 有多段备注时持仓显示最新一段（第2段，内容为空），旧段落保留为历史
  assert.equal(holding.note_id, round2);

  closeDb();
});

test('现货：long-only 配对、market 标记、同步与持仓存储', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const { matchFills } = await import('../src/fills.js');
  const { filterTrades } = await import('../src/stats.js');
  const { syncAccount } = await import('../src/sync.js');

  const account = store.createAccount({ exchange: 'fake', name: 'Spot', apiKey: 'k', apiSecret: 's' });
  const fake = {
    async fetchTrades() { return { trades: [], nextCursor: null }; },
    async fetchSpotTrades() {
      return {
        fills: [
          { id: 'b1', symbol: 'BTC/USDT', side: 'buy', price: 100, qty: 1, fee: -0.1, time: Date.parse('2026-10-01T10:00:00Z') },
          { id: 's1', symbol: 'BTC/USDT', side: 'sell', price: 110, qty: 1, fee: -0.1, time: Date.parse('2026-10-01T11:00:00Z') },
          { id: 'x1', symbol: 'ETH/USDT', side: 'sell', price: 200, qty: 1, fee: 0, time: Date.parse('2026-10-01T12:00:00Z') },
          { id: 'b2', symbol: 'SOL/USDT', side: 'buy', price: 20, qty: 2, fee: 0, time: Date.parse('2026-10-01T13:00:00Z') },
        ],
        nextCursor: null,
      };
    },
    async fetchSpotLive() {
      return {
        balances: [{ asset: 'BTC', total: 1, free: 1 }],
        holdings: [{ symbol: 'BTC/USDT', asset: 'BTC', quote: 'USDT', quantity: 1, price: 110, value: 110 }],
      };
    },
  };

  const result = await syncAccount(account.id, { registry: { fake } });
  assert.equal(result.spotInserted, 1);
  assert.equal(result.spotFillsInserted, 4);
  assert.equal(store.listSpotFills().length, 4);
  const costBasis = store.listSpotCostBasis(account.id);
  assert.equal(costBasis.length, 1);
  assert.equal(costBasis[0].symbol, 'SOL/USDT');
  assert.equal(costBasis[0].quantity, 2);
  assert.equal(costBasis[0].avg_cost, 20);
  const trades = store.listTrades();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].market, 'spot');
  assert.equal(trades[0].symbol, 'BTC/USDT');
  assert.equal(filterTrades(trades, { market: 'spot' }).length, 1);
  assert.equal(filterTrades(trades, { market: 'futures' }).length, 0);

  const live = await fake.fetchSpotLive();
  store.replaceSpotBalances(account.id, live.balances);
  store.replaceSpotHoldings(account.id, live.holdings);
  assert.equal(store.listSpotBalances()[0].total, 1);
  assert.equal(store.listSpotHoldings()[0].value, 110);
  assert.ok(store.getAccount(account.id).last_spot_sync_at);

  // 没有买入的卖出不会被当成开空
  const longOnly = matchFills([
    { id: 's2', symbol: 'SOL/USDT', side: 'sell', price: 20, qty: 2, fee: 0, time: 1000 },
  ], 'spot:test', { longOnly: true });
  assert.equal(longOnly.length, 0);

  store.clearAllData();
  closeDb();
});

test('LLM：三种接口的请求与解析（本地假服务）', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/chat/completions')) {
        res.end(JSON.stringify({ choices: [{ message: { content: 'openai-ok' } }] }));
      } else if (req.url.endsWith('/v1/messages')) {
        res.end(JSON.stringify({ content: [{ text: 'anthropic-ok' }] }));
      } else if (req.url.endsWith('/api/chat')) {
        res.end(JSON.stringify({ message: { content: 'ollama-ok' } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const { callLlm } = await import('../src/llm.js');

  try {
    const openai = await callLlm({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      config: { provider: 'openai', baseUrl: `${base}/v1`, model: 'm', apiKey: 'k', temperature: 0.4, maxTokens: 100 },
      timeout: 3000,
    });
    assert.equal(openai, 'openai-ok');

    const anthropic = await callLlm({
      messages: [{ role: 'user', content: 'u' }],
      config: { provider: 'anthropic', baseUrl: base, model: 'm', apiKey: 'k', temperature: 0.4, maxTokens: 100 },
      timeout: 3000,
    });
    assert.equal(anthropic, 'anthropic-ok');

    const ollama = await callLlm({
      messages: [{ role: 'user', content: 'u' }],
      config: { provider: 'ollama', baseUrl: base, model: 'm', temperature: 0.4, maxTokens: 100 },
      timeout: 3000,
    });
    assert.equal(ollama, 'ollama-ok');
  } finally {
    server.close();
  }
});

test('Markdown：URL 中的下划线不被强调改写', () => {
  const html = renderMarkdown('参考 [文档](https://example.com/a__b__c/next_page)');
  assert.match(html, /href="https:\/\/example\.com\/a__b__c\/next_page"/);
  assert.ok(!html.includes('<strong>'));
});

test('资金费归属：api upsert 之后不被抹掉', async () => {
  const { openDb, setDb, closeDb } = await import('../src/db.js');
  setDb(openDb(':memory:'));
  const store = await import('../src/store.js');
  const acc = store.createAccount({ exchange: 'gate', name: 'FUND' });
  const trade = {
    external_id: 'g1', symbol: 'DOGE/USDT', side: 'long', order_type: 'market',
    size: 100, notional: 10, entry_price: 0.1, exit_price: 0.11,
    open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-02T00:00:00.000Z',
    pnl: 1, fee: -0.01, funding: 0, source: 'api',
  };
  store.importTrades([trade], acc.id, { upsert: true });
  store.insertFundingEvents([
    { external_id: 'fe1', symbol: 'DOGE/USDT', time: '2026-10-01T08:00:00.000Z', amount: -0.5 },
  ], acc.id);
  assert.equal(store.applyFundingEvents(acc.id), 1);
  const after = store.listTrades().find((t) => t.external_id === 'g1');
  assert.equal(Number(after.funding), -0.5);

  // 模拟下一次增量同步：适配器数据不带资金费，重新 upsert
  store.importTrades([{ ...trade }], acc.id, { upsert: true });
  const again = store.listTrades().find((t) => t.external_id === 'g1');
  assert.equal(Number(again.funding), -0.5, '资金费不应被 upsert 抹掉');
  assert.ok(Math.abs(Number(again.pnl) - 0.5) < 1e-9, 'pnl 应保留资金费调整');
  store.clearAllData();
  closeDb();
});
