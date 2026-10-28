import test from 'node:test';
import assert from 'node:assert/strict';

// 先以默认时区（服务器本地）导入一份
const stats = await import('../src/stats.js');

const localKey = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

test('日期筛选：from=to 同一天时包含当天全部交易（旧实现会丢掉结束日）', () => {
  const mk = (close) => ({ close_time: close, pnl: 1, notional: 1, side: 'long', size: 1, open_time: close });
  const trades = [
    mk('2026-05-08T00:30:00.000Z'),
    mk('2026-05-08T15:59:59.000Z'),
    mk('2026-05-09T01:00:00.000Z'),
  ];
  const expected = trades.filter((t) => localKey(t.close_time) === '2026-05-08').length;
  assert.ok(expected >= 2, '测试样本应覆盖同一天多笔');
  const got = stats.filterTrades(trades, { from: '2026-05-08', to: '2026-05-08' });
  assert.equal(got.length, expected);
  // 区间包含结束日
  const range = stats.filterTrades(trades, { from: '2026-05-08', to: '2026-05-09' });
  assert.equal(range.length, 3);
});

test('TRADELEDGER_TZ：日期键/小时/星期按指定时区计算', async () => {
  const iso = '2026-01-01T20:00:00.000Z'; // UTC 周四 20:00；上海 周五 04:00
  process.env.TRADELEDGER_TZ = 'UTC';
  const utc = await import('../src/stats.js?tz-utc');
  process.env.TRADELEDGER_TZ = 'Asia/Shanghai';
  const cst = await import('../src/stats.js?tz-cst');
  try {
    assert.equal(utc.localDayKey(iso), '2026-01-01');
    assert.equal(cst.localDayKey(iso), '2026-01-02');
    assert.equal(utc.localMonthKey(iso), '2026-01');
    assert.equal(cst.localMonthKey(iso), '2026-01');

    const mk = { close_time: iso, open_time: iso, pnl: 5, notional: 1, side: 'long', size: 1 };
    const su = utc.analyze([mk]);
    const sc = cst.analyze([mk]);
    assert.equal(su.hourBuckets[20].trades, 1);
    assert.equal(sc.hourBuckets[4].trades, 1);
    assert.equal(su.weekdayBuckets[4].trades, 1); // 周四
    assert.equal(sc.weekdayBuckets[5].trades, 1); // 周五
    assert.equal(su.daily[0].date, '2026-01-01');
    assert.equal(sc.daily[0].date, '2026-01-02');
  } finally {
    delete process.env.TRADELEDGER_TZ;
  }
});

test('无效时区回退到本地时区，不抛错', async () => {
  process.env.TRADELEDGER_TZ = 'Not/AZone';
  try {
    const bad = await import('../src/stats.js?tz-bad');
    assert.equal(bad.localDayKey('2026-01-01T20:00:00.000Z'), localKey('2026-01-01T20:00:00.000Z'));
  } finally {
    delete process.env.TRADELEDGER_TZ;
  }
});
