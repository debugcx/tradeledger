import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let denyTotalBalance = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'GET') { res.statusCode = 404; return res.end('{}'); }
  if (url.pathname === '/api/v4/futures/usdt/accounts') {
    return res.end(JSON.stringify({ total: '0', available: '0', currency: 'USDT' }));
  }
  if (url.pathname === '/api/v4/futures/btc/accounts') {
    return res.end(JSON.stringify([{ label: 'USER_NOT_FOUND', message: 'transfer funds first' }]));
  }
  if (url.pathname === '/api/v4/spot/accounts') {
    return res.end(JSON.stringify([
      { currency: 'USDT', available: '12.09', locked: '0' },
      { currency: 'GT', available: '0.36', locked: '0' },
    ]));
  }
  if (url.pathname === '/api/v4/earn/uni/lends') return res.end(JSON.stringify([]));
  if (url.pathname === '/api/v4/earn/staking/assets') return res.end(JSON.stringify([]));
  if (url.pathname === '/api/v4/wallet/total_balance') {
    if (denyTotalBalance) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ label: 'PERMISSION_INVALID', message: '' }));
    }
    // 网格机器人（量化策略）的资金只在 total_balance 出现；spot 是等值口径，不能重复计入
    return res.end(JSON.stringify({
      details: {
        quant: { currency: 'USDT', amount: '100.4404217' },
        spot: { currency: 'USDT', amount: '17.12478797' },
        margin: { currency: 'USDT', amount: '0' },
        futures: { currency: 'USDT', amount: '0' },
        delivery: { currency: 'USDT', amount: '0' },
      },
      total: { amount: '117.56520967', currency: 'USDT' },
    }));
  }
  res.statusCode = 404;
  res.end('{}');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.GATE_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { gate } = await import('../src/exchanges/gate.js?gate-assets-test');

test('Gate 资产：网格（量化账户）余额计入，且不与现货重复', async () => {
  const result = await gate.fetchAssetPositions({ apiKey: 'k', apiSecret: 's' });
  assert.deepEqual(result.errors, []);
  const quant = result.positions.find((p) => p.bucket === 'quant');
  assert.ok(quant, '应包含量化策略账户（网格机器人的资金）');
  assert.equal(quant.asset, 'USDT');
  assert.ok(Math.abs(quant.amount - 100.4404217) < 1e-9);
  // 现货来自专用接口，total_balance 的等值 spot 不得重复计入
  const spotUsdt = result.positions.filter((p) => p.bucket === 'spot' && p.asset === 'USDT');
  assert.equal(spotUsdt.length, 1);
  assert.ok(Math.abs(spotUsdt[0].amount - 12.09) < 1e-9);
  const total = result.positions.reduce((a, p) => a + p.amount, 0);
  assert.ok(Math.abs(total - (100.4404217 + 12.09 + 0.36)) < 1e-9);
  assert.ok(result.buckets.includes('quant'));
  assert.ok(result.buckets.includes('spot'));
});

test('Gate 资产：total_balance 无权限时只报错该桶，其余照常', async () => {
  denyTotalBalance = true;
  try {
    const result = await gate.fetchAssetPositions({ apiKey: 'k', apiSecret: 's' });
    assert.equal(result.positions.filter((p) => p.bucket === 'quant').length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /量化\/杠杆账户/);
    assert.ok(result.positions.some((p) => p.bucket === 'spot' && p.asset === 'USDT'));
  } finally {
    denyTotalBalance = false;
  }
});

test.after(() => new Promise((r) => server.close(r)));
