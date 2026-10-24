import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_FILE = ':memory:';

const paths = [];

const now = Date.now();
const bills = [
  // 邀请返佣：应映射为 rebate
  { billId: 'r1', type: '150', balChg: '12.5', amt: '12.5', ccy: 'USDT', ts: String(now - 3600_000), notes: '' },
  // 手续费折扣返还：非 USDT 计价也应保留
  { billId: 'r2', type: '300', balChg: '0.002', amt: '0.002', ccy: 'BTC', ts: String(now - 7200_000), notes: '活动返还' },
  // 非返佣类型（充值）：应被过滤
  { billId: 'r3', type: '2', balChg: '100', amt: '100', ccy: 'USDT', ts: String(now - 10_800_000) },
  // 返佣类型但金额为负：应被过滤
  { billId: 'r4', type: '150', balChg: '-1', amt: '-1', ccy: 'USDT', ts: String(now - 14_400_000) },
  // 无 billId 的返佣：用 type:ts:amt 兜底生成 external_id
  { billId: '', type: '150', balChg: '5', amt: '5', ccy: 'USDT', ts: String(now - 18_000_000) },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  paths.push(url.pathname);
  res.setHeader('content-type', 'application/json');
  // 只返回资金账户账单；出现其他路径一律空数据
  const isBills = url.pathname === '/api/v5/asset/bills' || url.pathname === '/api/v5/asset/bills-history';
  res.end(JSON.stringify({ code: '0', data: isBills ? bills : [] }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OKX_API_BASE = `http://127.0.0.1:${server.address().port}`;

// 查询串导入，避免与其他测试文件共享已缓存的 okx 模块 BASE
const { okx } = await import('../src/exchanges/okx.js?okx-rebates-test');

test('OKX fetchRebates：按类型白名单过滤并映射为 rebate 流水', async () => {
  try {
    const creds = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
    // 窗口起点晚于最旧一条（now-18_000_000），首页后即停止分页；
    // 近期窗口也不会触发 bills-history
    const fromMs = now - 17_999_999;
    const result = await okx.fetchRebates({ creds, fromMs, toMs: now, limit: 2000 });
    const rows = result.transfers;
    assert.equal(rows.length, 3);
    assert.deepEqual(paths, ['/api/v5/asset/bills']);

    const first = rows[0];
    assert.equal(first.external_id, 'okx:rebate:r1');
    assert.equal(first.type, 'rebate');
    assert.equal(first.asset, 'USDT');
    assert.equal(first.amount, 12.5);
    assert.equal(first.fee, 0);
    assert.equal(first.note, '邀请返佣');
    assert.equal(new Date(first.tx_time).getTime(), now - 3600_000);

    const second = rows[1];
    assert.equal(second.asset, 'BTC');
    assert.equal(second.note, '活动返还'); // notes 优先于默认标签

    const third = rows[2];
    assert.equal(third.external_id, `okx:rebate:150:${now - 18_000_000}:5`);
    assert.equal(third.amount, 5);

    // 重复拉取同一批账单：每次调用内部去重，条数稳定
    const again = await okx.fetchRebates({ creds, fromMs, toMs: now, limit: 2000 });
    assert.equal(again.transfers.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
