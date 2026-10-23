import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const { renderMarkdown, stripMarkdown } = await import('../src/markdown.js');
const { nextCursorOf } = await import('../src/exchanges/okx.js');

test('OKX positions-history 分页游标：用 uTime+1，不用 posId', () => {
  assert.equal(nextCursorOf([{ uTime: 1000, posId: 'abc' }], 1), '1001');
  assert.equal(nextCursorOf([{ uTime: 1000 }], 2), null);
  assert.equal(nextCursorOf([{ posId: 'abc' }], 1), null);
  assert.equal(nextCursorOf([{ cTime: '2000' }], 1), '2001');
});

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

test('stripMarkdown：摘要去掉标记', () => {
  assert.equal(stripMarkdown('# 标题\n\n**粗体** [链接](/x) ![图](/media/1)'), '标题 粗体 链接');
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

  const context = llm.buildAiContext({
    trades: store.listTrades(),
    notes: [{ title: '本周总结', content: '不要追高', updated_at: '2026-10-01T09:00:00.000Z' }],
    scope: 'all',
    includeNotes: true,
    instruction: '重点看连亏',
  });
  assert.match(context.user, /本周总结/);
  assert.match(context.user, /不要追高/);
  assert.match(context.user, /重点看连亏/);
  assert.match(context.system, /交易教练/);

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
