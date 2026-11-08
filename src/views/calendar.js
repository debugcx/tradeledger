import { escapeHtml as e, fmtMoney, fmtNum, fmtPct } from '../http.js';
import { localDayKey } from '../stats.js';
import { shell } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
const pad = (n) => String(n).padStart(2, '0');
// 与日期筛选/统计共用同一个业务时区口径（TRADELEDGER_TZ）。
const localKey = (iso) => localDayKey(iso);

/** 日历按本地日期聚合；收益数字与列表页的日期筛选一致 */
function buildDaily(trades) {
  const map = new Map();
  for (const t of trades || []) {
    const key = localKey(t.close_time);
    if (!map.has(key)) map.set(key, { pnl: 0, trades: 0, wins: 0 });
    const d = map.get(key);
    d.pnl += Number(t.pnl) || 0;
    d.trades += 1;
    if (t.pnl > 0) d.wins += 1;
  }
  return map;
}

/**
 * 周汇总：把当月日历按周切片（与日历网格同一行），每行给出盈亏/笔数/胜率。
 * 半月（月初/月末不满一周）也能给出部分数据，不做 ISO 周对齐——这里
 * 的语义是「日历上的第几行」，与用户看到的格子一一对应。
 */
function buildWeekRows(weeks, daily, month) {
  return weeks.map((week, index) => {
    const agg = { pnl: 0, trades: 0, wins: 0, days: 0, label: '' };
    for (const cell of week) {
      if (!cell) continue;
      const d = daily.get(cell.key);
      if (!d || !d.trades) continue;
      agg.pnl += d.pnl;
      agg.trades += d.trades;
      agg.wins += d.wins;
      agg.days += 1;
      agg.label = cell.key; // 保持最后一天，显示为日期区间
    }
    const first = week.find((c) => c)?.day;
    const last = [...week].reverse().find((c) => c)?.day;
    agg.range = first && last
      ? (first === last ? `${month}月${first}日` : `${month}/${String(first).padStart(2, '0')} – ${month}/${String(last).padStart(2, '0')}`)
      : '';
    agg.winRate = agg.trades ? agg.wins / agg.trades : 0;
    agg.index = index + 1;
    return agg;
  }).filter((w) => w.trades > 0);
}

export function calendarPage({ user, trades, year, month, accounts = [], accountId = null, notice, error }) {
  const daily = buildDaily(trades);
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const startPad = first.getDay();
  const todayKey = localKey(new Date().toISOString());
  const accParam = accountId ? `&account_id=${accountId}` : '';

  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${pad(month)}-${pad(day)}`;
    const data = daily.get(key) || { pnl: 0, trades: 0, wins: 0 };
    cells.push({ day, key, ...data });
  }
  while (cells.length % 7) cells.push(null);

  const monthPnl = [...daily.entries()]
    .filter(([key]) => key.startsWith(`${year}-${pad(month)}`))
    .reduce((acc, [, d]) => acc + d.pnl, 0);
  const monthDays = [...daily.keys()].filter((k) => k.startsWith(`${year}-${pad(month)}`));
  const tradingDays = monthDays.length;
  const winDays = monthDays.filter((k) => (daily.get(k)?.pnl || 0) > 0).length;
  const best = monthDays.map((k) => ({ key: k, ...daily.get(k) })).sort((a, b) => b.pnl - a.pnl)[0];
  const worst = monthDays.map((k) => ({ key: k, ...daily.get(k) })).sort((a, b) => a.pnl - b.pnl)[0];

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const weekRows = buildWeekRows(weeks, daily, month);

  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  const dayCell = (cell) => {
    if (!cell) return '<div class="cal-cell empty" aria-hidden="true"></div>';
    const cls = cell.trades ? (cell.pnl > 0 ? 'pos-day' : cell.pnl < 0 ? 'neg-day' : 'flat-day') : 'no-day';
    const isToday = cell.key === todayKey ? ' today' : '';
    return `<a class="cal-cell ${cls}${isToday}" href="/dashboard/journal?from=${cell.key}&to=${cell.key}${accParam}" title="${cell.key} · ${cell.trades} 笔">
      <span class="cal-day">${cell.day}</span>
      ${cell.trades ? `<span class="cal-pnl">${fmtMoney(cell.pnl, { sign: false })}</span>
        <span class="cal-meta">${cell.trades} 笔 · ${fmtPct(cell.wins / cell.trades, 0)}</span>`
      : '<span class="cal-meta muted">—</span>'}
    </a>`;
  };

  const accountOptions = ['<option value="all">全部账户（聚合）</option>']
    .concat(accounts.map((a) => `<option value="${a.id}" ${accountId && String(accountId) === String(a.id) ? 'selected' : ''}>${e(a.name)}（${e(a.exchange)}${a.is_demo ? ' · 演示' : ''}）</option>`))
    .join('');

  const body = `
    ${accounts.length > 1 ? `<form method="get" action="/dashboard/calendar" class="filter-bar" data-autosubmit>
      <input type="hidden" name="year" value="${year}">
      <input type="hidden" name="month" value="${month}">
      <select name="account_id" aria-label="按账户查看">${accountOptions}</select>
      <button class="btn btn-primary small" type="submit">筛选</button>
      ${accountId ? `<a class="btn btn-ghost small" href="/dashboard/calendar?year=${year}&month=${month}">清除</a>` : ''}
    </form>
    <p class="chart-note" style="margin:-4px 0 12px">${accountId ? '正在查看单个账户的数据 · 点击日历格跳转的交易列表也会带上账户筛选' : ''}</p>` : ''}
    <div class="mini-strip">
      <div class="mini-stat"><span>本月盈亏</span><b class="${sign(monthPnl)}">${fmtMoney(monthPnl)}</b></div>
      <div class="mini-stat"><span>交易天数</span><b>${tradingDays}</b></div>
      <div class="mini-stat"><span>盈利天数</span><b class="pos">${winDays} <span class="muted small">/ ${tradingDays}</span></b></div>
      <div class="mini-stat"><span>最好单日</span><b class="pos">${best ? fmtMoney(best.pnl) : '—'}</b>
        <div class="muted small">${best ? best.key : ''}</div></div>
      <div class="mini-stat"><span>最差单日</span><b class="neg">${worst ? fmtMoney(worst.pnl) : '—'}</b>
        <div class="muted small">${worst ? worst.key : ''}</div></div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h2>${year} 年 ${month} 月</h2>
        <div class="head-actions">
          <a class="btn btn-ghost small" href="/dashboard/calendar?year=${prev.y}&month=${prev.m}${accParam}">← 上一月</a>
          <a class="btn btn-ghost small" href="/dashboard/calendar${accountId ? `?account_id=${accountId}` : ''}">回到本月</a>
          <a class="btn btn-ghost small" href="/dashboard/calendar?year=${next.y}&month=${next.m}${accParam}">下一月 →</a>
        </div>
      </div>
      <div class="cal-head">
        ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      </div>
      <div class="cal-grid">
        ${weeks.map((week) => week.map(dayCell).join('')).join('')}
      </div>
      <div class="cal-legend">
        <span><i class="dot pos"></i>盈利</span>
        <span><i class="dot neg"></i>亏损</span>
        <span><i class="dot flat"></i>持平</span>
        <span class="muted">点击某一天可跳到当天交易</span>
      </div>
    </section>
    ${weekRows.length ? `<section class="panel">
      <div class="panel-head"><h2>周汇总</h2><span class="muted small">按日历行切分 · 只有交易日的周会列出</span></div>
      <table class="table">
        <thead><tr><th>周</th><th class="num">盈亏</th><th class="num">交易</th><th class="num">盈利天数</th><th class="num">胜率</th></tr></thead>
        <tbody>${weekRows.map((w) => `<tr>
          <td>第 ${w.index} 行 <span class="muted small">${w.range}</span></td>
          <td class="num ${sign(w.pnl)} strong">${fmtMoney(w.pnl)}</td>
          <td class="num">${fmtNum(w.trades)}</td>
          <td class="num muted">${w.days}</td>
          <td class="num">${fmtPct(w.winRate, 0)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </section>` : ''}`;

  return shell({
    active: 'calendar', user, title: '盈亏日历',
    subtitle: '按平仓日期统计；颜色只表示方向，金额在格子里',
    notice, error, body,
  });
}
