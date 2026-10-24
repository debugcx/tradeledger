import { escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDateTime } from '../http.js';
import { shell } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

/** 从机器人备注里提取参数段（格式见 okx.fetchBots：策略机器人·合约网格 200 格 · 套利 632 次 · …） */
function parseNote(note) {
  const text = String(note || '');
  const kind = text.includes('现货网格') ? '现货网格' : text.includes('合约网格') ? '合约网格' : '';
  const grids = (/(\d+) 格/.exec(text) || [])[1] || '';
  const arbs = (/套利 ([\d.]+) 次/.exec(text) || [])[1] || '';
  const gridProfit = (/网格利润 (-?[\d.]+)/.exec(text) || [])[1] || '';
  const floatProfit = (/浮动盈亏 (-?[\d.]+)/.exec(text) || [])[1] || '';
  return { kind, grids, arbs, gridProfit, floatProfit };
}

export function botsPage({ user, bots, accounts = [], accountId = null, notice, error }) {
  const total = bots.length;
  const pnl = bots.reduce((a, b) => a + Number(b.pnl || 0), 0);
  const fee = bots.reduce((a, b) => a + Math.abs(Number(b.fee || 0)), 0);
  const wins = bots.filter((b) => Number(b.pnl) > 0).length;
  const arbs = bots.reduce((a, b) => a + Number((/套利 ([\d.]+) 次/.exec(b.note || '') || [])[1] || 0), 0);

  const accountOptions = ['<option value="all">全部账户</option>']
    .concat(accounts.map((a) => `<option value="${a.id}" ${String(accountId) === String(a.id) ? 'selected' : ''}>${e(a.name)}（${e(a.exchange)}）</option>`))
    .join('');

  const rows = bots.map((b) => {
    const p = parseNote(b.note);
    const ret = b.notional ? Number(b.pnl) / b.notional : 0;
    return `<tr>
      <td class="small">${e(fmtDateTime(b.close_time))}</td>
      <td class="small">${e(b.account_name)} <span class="muted">${e(b.account_exchange)}</span></td>
      <td><a href="/dashboard/journal/${b.id}"><b>${e(b.symbol)}</b></a>
        <span class="status-badge ${b.market === 'spot' ? 'blue' : 'muted'}">${b.market === 'spot' ? '现货' : '合约'}</span></td>
      <td class="small">${p.kind || '策略'}${p.grids ? ` · ${e(p.grids)} 格` : ''}</td>
      <td>${p.arbs ? fmtNum(p.arbs) : '—'}</td>
      <td>${b.notional ? fmtMoney(b.notional, { sign: false }) : '—'}</td>
      <td class="${sign(Number(p.gridProfit))}">${p.gridProfit !== '' ? fmtMoney(Number(p.gridProfit), { sign: true }) : '—'}</td>
      <td class="${sign(Number(p.floatProfit))}">${p.floatProfit !== '' ? fmtMoney(Number(p.floatProfit), { sign: true }) : '—'}</td>
      <td class="${sign(Number(b.pnl))} strong">${fmtMoney(b.pnl)}</td>
      <td>${b.notional ? `<span class="${sign(ret)}">${fmtPct(ret)}</span>` : '—'}</td>
      <td class="neg">${fmtMoney(-Math.abs(Number(b.fee || 0)), { sign: false })}</td>
    </tr>`;
  }).join('');

  const body = `
    <div class="mini-strip">
      <div class="mini-stat"><span>机器人回合</span><b>${fmtNum(total)}</b></div>
      <div class="mini-stat"><span>总净盈亏</span><b class="${sign(pnl)}">${fmtMoney(pnl)}</b></div>
      <div class="mini-stat"><span>总套利次数</span><b>${fmtNum(arbs)}</b></div>
      <div class="mini-stat"><span>总手续费</span><b class="neg">${fmtMoney(-fee, { sign: false })}</b></div>
      <div class="mini-stat"><span>盈利回合占比</span><b>${total ? fmtPct(wins / total) : '—'}</b></div>
    </div>

    ${accounts.length > 1 ? `<form method="get" action="/dashboard/bots" class="filter-bar" data-autosubmit>
      <select name="account_id" aria-label="按账户查看">${accountOptions}</select>
      <button class="btn btn-primary small" type="submit">筛选</button>
    </form>` : ''}

    <section class="panel">
      <div class="panel-head"><h2>已结束的机器人回合</h2>
        <span class="muted small">每个机器人从启动到停止记为一个回合 · 每 6 小时随同步更新 · 点击交易对看完整详情</span></div>
      ${total ? `<div class="table-wrap">
      <table class="table">
        <thead><tr><th>结束时间</th><th>账户</th><th>交易对</th><th>类型</th><th>套利次数</th><th>投资额</th><th>网格利润</th><th>浮动盈亏</th><th>净盈亏</th><th>收益率</th><th>手续费</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>` : `<div class="chart-empty">还没有已结束的机器人回合。<br><span class="muted small">当前支持 OKX 的现货/合约网格机器人历史；结束后的回合会自动出现在这里。</span></div>`}
    </section>`;

  return shell({
    active: 'bots', user, title: '策略机器人',
    subtitle: '网格等策略机器人的回合盈亏 · 已并入主统计（可用「策略机器人」标签在交易记录里排除）',
    notice, error, body,
  });
}
