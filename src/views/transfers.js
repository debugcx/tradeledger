import { escapeHtml as e, fmtMoney, fmtNum, fmtDateTime } from '../http.js';
import { shell } from './layout.js';

const TYPE_LABEL = {
  deposit: '充值',
  withdraw: '提现',
  internal_in: '内部转入',
  internal_out: '内部转出',
  other: '其他',
};

const IN_TYPES = new Set(['deposit', 'internal_in']);

export function transfersPage({ user, transfers, summary, filters, accounts, notice, error }) {
  const accountOptions = ['<option value="all">全部账户</option>']
    .concat(accounts.map((a) => `<option value="${a.id}" ${String(filters.account_id) === String(a.id) ? 'selected' : ''}>${e(a.name)}（${e(a.exchange)}）</option>`))
    .join('');
  const typeOptions = ['all', 'deposit', 'withdraw', 'internal_in', 'internal_out', 'other']
    .map((t) => `<option value="${t}" ${filters.type === t ? 'selected' : ''}>${t === 'all' ? '全部类型' : TYPE_LABEL[t]}</option>`)
    .join('');

  const numFmt = (n) => {
    const v = Math.abs(Number(n) || 0);
    return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
  };
  const rows = transfers.map((t) => {
    const incoming = IN_TYPES.has(t.type);
    const cls = incoming ? 'pos' : t.type === 'other' ? 'muted' : 'neg';
    const amount = `${incoming ? '+' : '-'}${numFmt(t.amount)} ${e(t.asset)}`;
    const txid = String(t.tx_id || '');
    return `<tr>
      <td class="small">${e(fmtDateTime(t.tx_time))}</td>
      <td class="small">${e(t.account_name)} <span class="muted">${e(t.exchange)}</span></td>
      <td><span class="status-badge ${incoming ? 'pos' : t.type === 'other' ? 'muted' : 'neg'}">${e(TYPE_LABEL[t.type] || t.type)}</span></td>
      <td><b>${e(t.asset)}</b></td>
      <td class="${cls} strong">${amount}</td>
      <td>${t.fee ? `${numFmt(t.fee)} ${e(t.asset)}` : '—'}</td>
      <td class="small">${e(t.chain || '—')}</td>
      <td class="small">${txid ? `<span class="rate" title="${e(txid)}">${e(txid.slice(0, 14))}${txid.length > 14 ? '…' : ''}</span>` : '—'}</td>
      <td class="muted small">${e(t.note || '')}</td>
    </tr>`;
  }).join('');

  const assetRows = summary.byAsset.map((x) => `<tr>
    <td><b>${e(x.asset)}</b></td><td>${fmtNum(x.count)}</td>
    <td>${numFmt(x.amount)}</td>
  </tr>`).join('');

  const assetNet = new Map();
  for (const t of transfers) {
    const asset = t.asset || '—';
    const cur = assetNet.get(asset) || { in: 0, out: 0 };
    const amt = Math.abs(Number(t.amount) || 0);
    if (IN_TYPES.has(t.type)) cur.in += amt;
    else cur.out += amt;
    assetNet.set(asset, cur);
  }
  const assetSummaryRows = [...assetNet.entries()]
    .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
    .map(([asset, v]) => `<tr>
      <td><b>${e(asset)}</b></td>
      <td class="pos">+${numFmt(v.in)}</td>
      <td class="neg">-${numFmt(v.out)}</td>
      <td class="${v.in - v.out >= 0 ? 'pos' : 'neg'} strong">${v.in - v.out >= 0 ? '+' : '-'}${numFmt(Math.abs(v.in - v.out))}</td>
    </tr>`).join('');

  const body = `
    <div class="mini-strip">
      <div class="mini-stat"><span>流水记录</span><b>${fmtNum(summary.count)}</b></div>
      <div class="mini-stat"><span>充值币种</span><b class="small">${fmtNum(assetNet.size)} 个</b></div>
      <div class="mini-stat"><span>总充值</span><b class="pos">${fmtMoney(summary.deposits, { sign: false })}</b></div>
      <div class="mini-stat"><span>总提现</span><b class="neg">${fmtMoney(summary.withdrawals, { sign: false })}</b></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>筛选</h2></div>
      <form method="get" action="/dashboard/transfers" class="filter-bar">
        <select name="account_id">${accountOptions}</select>
        <select name="type">${typeOptions}</select>
        <input name="asset" value="${e(filters.asset === 'all' ? '' : filters.asset)}" placeholder="币种，例如 USDT">
        <input type="date" name="from" value="${e(filters.from || '')}" title="开始日期">
        <input type="date" name="to" value="${e(filters.to || '')}" title="结束日期">
        <button class="btn btn-primary small" type="submit">筛选</button>
        <a class="btn btn-ghost small" href="/dashboard/transfers">重置</a>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>充提与划转</h2>
        <span class="muted small">随账户同步自动更新；需要钱包/资产只读权限</span>
      </div>
      <table class="table">
        <thead><tr><th>时间</th><th>账户</th><th>类型</th><th>币种</th><th>金额</th><th>手续费</th><th>链</th><th>TxID</th><th>备注</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="muted center">还没有资金流水。添加交易所并同步后，这里会出现充值、提现和内部划转。</td></tr>'}</tbody>
      </table>
    </section>

    ${summary.byAsset.length ? `<section class="panel">
      <div class="panel-head"><h2>按币种汇总</h2>
        <span class="muted small">直接按币种数量累计，不做 USDT 换算</span></div>
      <table class="table">
        <thead><tr><th>币种</th><th>笔数</th><th>金额合计</th></tr></thead>
        <tbody>${assetRows}</tbody>
      </table>
    </section>` : ''}

    ${assetSummaryRows ? `<section class="panel">
      <div class="panel-head"><h2>币种净流入 / 流出</h2>
        <span class="muted small">充值 +，提现 −；跨币种不做换算</span></div>
      <table class="table">
        <thead><tr><th>币种</th><th>充入</th><th>提出</th><th>净额</th></tr></thead>
        <tbody>${assetSummaryRows}</tbody>
      </table>
    </section>` : ''}`;

  return shell({
    active: 'transfers', user, title: '资金流水',
    subtitle: '充值、提现、内部划转放在同一条时间线上',
    notice, error, body,
  });
}
