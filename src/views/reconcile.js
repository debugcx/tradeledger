import { escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDateTime } from '../http.js';
import { shell } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
const sourceLabel = (s) => ({ api: '交易所同步', csv: 'CSV 导入', manual: '手动', demo: '演示' }[s] || s);

/** 月度对账：应用内净盈亏 vs 交易所账本实结算（盈亏+手续费+资金费） */
function monthlyPanel(monthly) {
  if (!monthly || !monthly.length) return '';
  const blocks = monthly.map((m) => {
    if (m.error) {
      return `<section class="panel">
        <div class="panel-head"><h2>月度对账 · ${e(m.account.name)}</h2></div>
        <div class="chart-empty">账本拉取失败：${e(m.error)}</div>
      </section>`;
    }
    const rows = m.rows.map((r) => {
      const ok = Math.abs(r.diff) <= Math.max(1, Math.abs(r.exchange) * 0.02);
      return `<tr>
        <td>${e(r.month)}</td>
        <td class="${sign(r.app)}">${fmtMoney(r.app)}</td>
        <td class="${sign(r.exchange)}">${fmtMoney(r.exchange)}</td>
        <td class="${ok ? 'pos' : 'neg'} strong">${ok ? '一致' : fmtMoney(r.diff)}</td>
      </tr>`;
    }).join('');
    return `<section class="panel">
      <div class="panel-head"><h2>月度对账 · ${e(m.account.name)}（${e(m.account.exchange)}）</h2>
        <span class="muted small">应用内净盈亏 vs 交易所账本（已实现盈亏+手续费+资金费）· 缓存 30 分钟</span></div>
      <table class="table">
        <thead><tr><th>月份</th><th>应用内</th><th>交易所账本</th><th>差异</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted center">暂无数据</td></tr>'}</tbody>
      </table>
    </section>`;
  }).join('');
  return blocks;
}

export function reconcilePage({ user, report, monthly = [], notice, error }) {
  const sourceRows = report.bySource.map((s) => `<tr>
    <td>${e(sourceLabel(s.source))}</td>
    <td>${fmtNum(s.checked)}</td>
    <td class="${s.mismatches ? 'neg' : 'pos'}">${fmtNum(s.mismatches)}</td>
    <td class="muted">${fmtNum(s.missing)}</td>
    <td>${s.checked ? fmtPct(1 - s.mismatches / s.checked) : '—'}</td>
  </tr>`).join('');

  const worstRows = report.worst.map((r) => `<tr>
    <td class="small">${e(fmtDateTime(r.close_time))}</td>
    <td><a href="/dashboard/journal/${r.id}"><b>${e(r.symbol)}</b></a></td>
    <td><span class="side-tag ${r.side}">${r.side === 'long' ? '多' : '空'}</span></td>
    <td class="small">${e(sourceLabel(r.source))}</td>
    <td>${fmtMoney(r.gross)}</td>
    <td>${fmtMoney(r.pricePnl)}</td>
    <td class="${sign(r.diff)} strong">${fmtMoney(r.diff)}</td>
  </tr>`).join('');

  const missingRows = report.missingExamples.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td><a href="/dashboard/journal/${t.id}"><b>${e(t.symbol)}</b></a></td>
    <td class="small">${e(sourceLabel(t.source))}</td>
    <td class="muted small">${!t.entry_price ? '缺开仓价 ' : ''}${!t.exit_price ? '缺平仓价 ' : ''}${!t.size ? '缺数量' : ''}</td>
  </tr>`).join('');

  const body = `
    <div class="mini-strip">
      <div class="mini-stat"><span>交易总数</span><b>${fmtNum(report.total)}</b></div>
      <div class="mini-stat"><span>可独立复算</span><b>${fmtNum(report.checked)}</b></div>
      <div class="mini-stat"><span>复算不一致</span><b class="${report.mismatches ? 'neg' : 'pos'}">${fmtNum(report.mismatches)}</b></div>
      <div class="mini-stat"><span>缺少价格/数量</span><b class="muted">${fmtNum(report.missing)}</b></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>对账说明</h2></div>
      <p class="muted small" style="margin:0">
        对账只用「开仓价 / 平仓价 / 数量 / 方向」独立算一次毛盈亏，再与记录值
        「净盈亏 − 手续费 − 资金费」比较。差异在 1% 或 $0.01 以内视为一致。
        合约面值、币本位、分批成交都可能让复算值与交易所净额不同——这类差异不是错误，
        但值得逐笔核对数量单位。缺少开/平仓价的交易（例如只导出盈亏的 CSV）无法复算。
      </p>
      ${report.checked ? `<p class="chart-note">当前复算一致率：<b class="${report.matchRate > 0.95 ? 'pos' : 'neg'}">${fmtPct(report.matchRate)}</b></p>` : ''}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>按来源</h2></div>
      <table class="table">
        <thead><tr><th>来源</th><th>可复算</th><th>不一致</th><th>缺字段</th><th>一致率</th></tr></thead>
        <tbody>${sourceRows || '<tr><td colspan="5" class="muted center">暂无数据</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>差异最大的交易</h2><span class="muted small">按绝对差异排序，最多 50 笔</span></div>
      <table class="table">
        <thead><tr><th>平仓时间</th><th>币种</th><th>方向</th><th>来源</th><th>毛盈亏（记录）</th><th>按价格复算</th><th>差异</th></tr></thead>
        <tbody>${worstRows || '<tr><td colspan="7" class="pos center">没有发现不一致</td></tr>'}</tbody>
      </table>
    </section>

    ${report.missing ? `<section class="panel">
      <div class="panel-head"><h2>无法复算的交易</h2><span class="muted small">前 20 笔</span></div>
      <table class="table">
        <thead><tr><th>平仓时间</th><th>币种</th><th>来源</th><th>缺失字段</th></tr></thead>
        <tbody>${missingRows}</tbody>
      </table>
    </section>` : ''}

    ${monthlyPanel(monthly)}`;

  return shell({
    active: 'reconcile', user, title: '对账',
    subtitle: '把每一笔的盈亏摊开核对，而不是只相信一个总数',
    notice, error, body,
  });
}
