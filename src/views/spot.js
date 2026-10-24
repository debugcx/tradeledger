import { escapeHtml as e, fmtMoney, fmtNum, fmtPrice, fmtDateTime } from '../http.js';
import { shell } from './layout.js';

export function spotPage({ user, balances, holdings, fills, spotTrades = [], notice, error }) {
  const spotValue = holdings.reduce((a, h) => a + (Number(h.value) || 0), 0);
  const withCost = holdings.filter((h) => h.avg_cost !== null && h.avg_cost !== undefined);
  const coverage = holdings.length ? withCost.length / holdings.length : 0;
  // 计价币（USDT/USDC）不参与持仓行，单独汇总展示，避免「资产数」和持仓表对不上
  const quoteTotal = balances
    .filter((b) => b.asset === 'USDT' || b.asset === 'USDC')
    .reduce((a, b) => a + (Number(b.total) || 0), 0);

  const holdingRows = holdings.map((h) => {
    const qty = Number(h.quantity) || 0;
    const costQty = h.cost_quantity === null || h.cost_quantity === undefined ? null : Number(h.cost_quantity);
    const cost = h.avg_cost === null || h.avg_cost === undefined ? null : Number(h.avg_cost);
    const value = h.value === null || h.value === undefined ? null : Number(h.value);
    const costConsistent = costQty !== null && Math.abs(costQty - qty) <= Math.max(1e-8, Math.abs(qty) * 0.01);
    const unrealized = costConsistent && cost !== null && value !== null ? value - cost * qty : null;
    const cls = unrealized === null ? 'muted' : unrealized > 0 ? 'pos' : unrealized < 0 ? 'neg' : '';
    return `<tr>
      <td class="small">${e(h.account_name)} <span class="muted">${e(h.exchange)}</span></td>
      <td><a href="/dashboard/spot/symbol/${encodeURIComponent(h.symbol)}"><b>${e(h.symbol)}</b></a></td>
      <td>${fmtNum(qty, 8)}</td>
      <td>${cost === null ? '—' : fmtPrice(cost)}
        ${costQty !== null && !costConsistent ? `<div class="muted small">成本数量 ${fmtNum(costQty, 8)}</div>` : ''}</td>
      <td>${h.price === null || h.price === undefined ? '—' : fmtPrice(h.price)}</td>
      <td>${value === null ? '—' : fmtMoney(value, { sign: false })}</td>
      <td class="${cls}">${unrealized === null ? '—' : fmtMoney(unrealized)}</td>
      <td class="small">
        ${h.note_id ? `<a href="/dashboard/notes/${h.note_id}" title="查看现货备注">有备注</a>` : '<span class="muted">—</span>'}
      </td>
    </tr>`;
  }).join('');

  const fillRows = fills.map((f) => `<tr>
    <td class="small">${e(fmtDateTime(f.time))}</td>
    <td class="small">${e(f.account_name)} <span class="muted">${e(f.exchange)}</span></td>
    <td><a href="/dashboard/spot/symbol/${encodeURIComponent(f.symbol)}"><b>${e(f.symbol)}</b></a></td>
    <td><span class="side-tag ${f.side === 'buy' ? 'long' : 'short'}">${f.side === 'buy' ? '买入' : '卖出'}</span></td>
    <td>${fmtPrice(f.price)}</td>
    <td>${fmtNum(f.qty, 8)}</td>
    <td class="${f.fee > 0 ? 'pos' : f.fee < 0 ? 'neg' : ''}">${fmtMoney(f.fee)}</td>
  </tr>`).join('');

  const spotTradeRows = spotTrades.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td><a href="/dashboard/spot/symbol/${encodeURIComponent(t.symbol)}"><b>${e(t.symbol)}</b></a><div class="muted small">${e(t.account_name)}</div></td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '做多' : '做空'}</span></td>
    <td>${fmtNum(t.size, 8)}</td>
    <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${fmtMoney(t.pnl)}</td>
    <td><a class="btn btn-ghost small" href="/dashboard/journal/${t.id}">详情</a></td>
  </tr>`).join('');

  const body = `
    <div class="mini-strip">
      <div class="mini-stat"><span>持仓币种</span><b>${fmtNum(holdings.length)}</b>
        <div class="muted small">不含 USDT 等计价币</div></div>
      <div class="mini-stat"><span>计价币余额</span><b>${fmtNum(quoteTotal, 2)} <span class="muted small">USDT/USDC</span></b></div>
      <div class="mini-stat"><span>现货市值</span><b>${fmtMoney(spotValue, { sign: false })}</b></div>
      <div class="mini-stat"><span>成本基础覆盖</span><b>${(coverage * 100).toFixed(0)}%</b>
        <div class="muted small">${withCost.length} / ${holdings.length} 个持仓有买入成本</div></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>现货持仓</h2>
        <span class="muted small">市值按实时价格估算；成本来自已同步的买入成交</span></div>
      <table class="table">
        <thead><tr><th>账户</th><th>交易对</th><th>数量</th><th>平均成本</th><th>当前价</th><th>市值</th><th>未实现盈亏</th><th>备注</th></tr></thead>
        <tbody>${holdingRows || '<tr><td colspan="8" class="muted center">还没有现货持仓。添加交易所并同步后，这里会显示现货余额。</td></tr>'}</tbody>
      </table>
      <p class="chart-note">备注与复盘都在交易对详情页编辑，支持 Markdown 和图片；点交易对名字进入。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>现货交易复盘</h2>
        <span class="muted small">卖出配对后的已实现交易；<a href="/dashboard/journal?market=spot">在交易记录中筛选</a></span></div>
      <table class="table">
        <thead><tr><th>平仓时间</th><th>交易对</th><th>方向</th><th>数量</th><th>盈亏</th><th></th></tr></thead>
        <tbody>${spotTradeRows || '<tr><td colspan="6" class="muted center">还没有已实现的现货交易。买入后卖出，配对完成才会出现在这里。</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>现货成交</h2>
        <span class="muted small">最近 200 笔；逐笔成交按 long-only FIFO 统计已实现盈亏</span></div>
      <table class="table">
        <thead><tr><th>时间</th><th>账户</th><th>交易对</th><th>方向</th><th>价格</th><th>数量</th><th>手续费</th></tr></thead>
        <tbody>${fillRows || '<tr><td colspan="7" class="muted center">还没有现货成交记录。</td></tr>'}</tbody>
      </table>
    </section>`;

  return shell({
    active: 'spot', user, title: '现货',
    subtitle: '现货余额、持仓成本与逐笔成交；已实现盈亏会进入交易记录',
    notice, error, body,
  });
}
