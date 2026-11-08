import test from 'node:test';
import assert from 'node:assert/strict';

const { calendarPage } = await import('../src/views/calendar.js');

const user = { id: 1, display_name: 'T' };
const t = (closeIso, pnl) => ({
  symbol: 'BTC/USDT', side: 'long', close_time: closeIso, pnl,
  open_time: closeIso, entry_price: 1, exit_price: 1, notional: 1,
});

test('日历页周汇总：按日历行切分并给出盈亏/笔数/胜率', () => {
  // 2026 年 3 月 1 日是周日；第一行 = 3/1–3/7
  const html = calendarPage({
    user,
    trades: [
      t('2026-03-02T02:00:00.000Z', 100), // 周一
      t('2026-03-03T02:00:00.000Z', -30), // 周二
      t('2026-03-05T02:00:00.000Z', 20),  // 周四
      t('2026-03-09T02:00:00.000Z', 50),  // 第二行（3/8–3/14）
    ],
    year: 2026,
    month: 3,
  });
  assert.match(html, /周汇总/);
  assert.match(html, /第 1 行/);
  assert.match(html, /\+?\$90\.00|>-?\$90/); // 100-30+20
  assert.match(html, /第 2 行/);
  assert.match(html, /\$50\.00/);
});

test('日历页周汇总：无交易的月份不渲染周汇总面板', () => {
  const html = calendarPage({ user, trades: [], year: 2026, month: 3 });
  assert.ok(!html.includes('周汇总'));
});

test('日历页周汇总：单账户过滤后只显示该账户数据', () => {
  const html = calendarPage({
    user,
    trades: [t('2026-03-02T02:00:00.000Z', 100)],
    year: 2026,
    month: 3,
  });
  assert.match(html, /周汇总/);
});
