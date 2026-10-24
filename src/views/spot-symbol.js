import { escapeHtml as e, fmtMoney, fmtNum, fmtPrice, fmtDateTime, fmtDuration } from '../http.js';
import { renderMarkdown } from '../markdown.js';
import { shell } from './layout.js';

const TYPE_LABEL = {
  deposit: '充值',
  withdraw: '提现',
  internal_in: '内部转入',
  internal_out: '内部转出',
  rebate: '返佣',
  other: '其他',
};
const IN_TYPES = new Set(['deposit', 'internal_in', 'rebate']);

function holdingStart(fills) {
  const sorted = [...fills].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const lots = [];
  for (const f of sorted) {
    const qty = Math.abs(Number(f.qty) || 0);
    if (f.side === 'buy') {
      lots.push({ qty, time: f.time });
    } else {
      let remain = qty;
      while (remain > 1e-12 && lots.length) {
        const take = Math.min(remain, lots[0].qty);
        lots[0].qty -= take;
        remain -= take;
        if (lots[0].qty <= 1e-12) lots.shift();
      }
    }
  }
  return lots.length ? lots[0].time : null;
}

export function spotSymbolPage({
  user, symbol, holdings = [], fills = [], trades = [], transfers = [], archiveNote = null, spotNotes = [], notice, error,
}) {
  const totalQty = holdings.reduce((a, h) => a + (Number(h.quantity) || 0), 0);
  const spotValue = holdings.reduce((a, h) => a + (Number(h.value) || 0), 0);
  const unrealized = holdings.reduce((a, h) => {
    const qty = Number(h.quantity) || 0;
    const costQty = h.cost_quantity === null || h.cost_quantity === undefined ? null : Number(h.cost_quantity);
    const cost = h.avg_cost === null || h.avg_cost === undefined ? null : Number(h.avg_cost);
    const value = h.value === null || h.value === undefined ? null : Number(h.value);
    const consistent = costQty !== null && Math.abs(costQty - qty) <= Math.max(1e-8, Math.abs(qty) * 0.01);
    return a + (consistent && cost !== null && value !== null ? value - cost * qty : 0);
  }, 0);

  const buys = fills.filter((f) => f.side === 'buy');
  const sells = fills.filter((f) => f.side === 'sell');
  const buyQty = buys.reduce((a, f) => a + (Number(f.qty) || 0), 0);
  const sellQty = sells.reduce((a, f) => a + (Number(f.qty) || 0), 0);
  const buyAmount = buys.reduce((a, f) => a + (Number(f.qty) || 0) * (Number(f.price) || 0), 0);
  const sellAmount = sells.reduce((a, f) => a + (Number(f.qty) || 0) * (Number(f.price) || 0), 0);
  const avgBuy = buyQty > 0 ? buyAmount / buyQty : null;
  const avgSell = sellQty > 0 ? sellAmount / sellQty : null;
  const totalFee = fills.reduce((a, f) => a + (Number(f.fee) || 0), 0);
  const realized = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const totalSize = trades.reduce((a, t) => a + (Number(t.size) || 0), 0);
  const avgHoldMs = totalSize > 0
    ? trades.reduce((a, t) => {
      const ms = Date.parse(t.close_time) - Date.parse(t.open_time);
      return a + (Number.isFinite(ms) ? ms : 0) * (Number(t.size) || 0);
    }, 0) / totalSize
    : null;

  const fillsByAccount = new Map();
  for (const f of fills) {
    if (!fillsByAccount.has(f.account_id)) fillsByAccount.set(f.account_id, []);
    fillsByAccount.get(f.account_id).push(f);
  }

  const holdingRows = holdings.map((h) => {
    const qty = Number(h.quantity) || 0;
    const costQty = h.cost_quantity === null || h.cost_quantity === undefined ? null : Number(h.cost_quantity);
    const cost = h.avg_cost === null || h.avg_cost === undefined ? null : Number(h.avg_cost);
    const value = h.value === null || h.value === undefined ? null : Number(h.value);
    const price = h.price === null || h.price === undefined ? null : Number(h.price);
    const consistent = costQty !== null && Math.abs(costQty - qty) <= Math.max(1e-8, Math.abs(qty) * 0.01);
    const upl = consistent && cost !== null && value !== null ? value - cost * qty : null;
    const start = holdingStart(fillsByAccount.get(h.account_id) || []);
    const heldMs = start ? Date.now() - Date.parse(start) : null;
    return `<tr>
      <td class="small">${e(h.account_name)} <span class="muted">${e(h.exchange)}</span></td>
      <td>${fmtNum(qty, 8)}</td>
      <td>${cost === null ? '—' : fmtPrice(cost)}
        ${costQty !== null && !consistent ? `<div class="muted small">成本数量 ${fmtNum(costQty, 8)}</div>` : ''}</td>
      <td>${price === null ? '—' : fmtPrice(price)}</td>
      <td>${value === null ? '—' : fmtMoney(value, { sign: false })}</td>
      <td class="${upl === null ? 'muted' : upl > 0 ? 'pos' : upl < 0 ? 'neg' : ''}">${upl === null ? '—' : fmtMoney(upl)}</td>
      <td class="small">${start ? e(fmtDateTime(start)) : '—'}<div class="muted small">${heldMs === null ? '' : `已持有 ${fmtDuration(heldMs)}`}</div></td>
      <td class="small">
        ${h.note_id ? `<a href="/dashboard/notes/${h.note_id}" title="查看现货备注">有备注</a>` : '<span class="muted">—</span>'}
      </td>
    </tr>`;
  }).join('');

  const fillRows = fills.map((f) => `<tr>
    <td class="small">${e(fmtDateTime(f.time))}</td>
    <td class="small">${e(f.account_name)} <span class="muted">${e(f.exchange)}</span></td>
    <td><span class="side-tag ${f.side === 'buy' ? 'long' : 'short'}">${f.side === 'buy' ? '买入' : '卖出'}</span></td>
    <td>${fmtPrice(f.price)}</td>
    <td>${fmtNum(f.qty, 8)}</td>
    <td>${fmtMoney((Number(f.price) || 0) * (Number(f.qty) || 0), { sign: false })}</td>
    <td class="${f.fee > 0 ? 'pos' : f.fee < 0 ? 'neg' : ''}">${fmtMoney(f.fee)}</td>
  </tr>`).join('');

  const tradeRows = trades.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.open_time))}</td>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td class="small">${e(fmtDuration(Date.parse(t.close_time) - Date.parse(t.open_time)))}</td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '做多' : '做空'}</span></td>
    <td>${fmtNum(t.size, 8)}</td>
    <td>${fmtPrice(t.entry_price)} → ${fmtPrice(t.exit_price)}</td>
    <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${fmtMoney(t.pnl)}</td>
    <td><a class="btn btn-ghost small" href="/dashboard/journal/${t.id}">详情</a></td>
  </tr>`).join('');

  const assetOfSymbol = symbol.split('/')[0] || symbol;
  const transfersForAsset = (transfers || []).filter((t) =>
    String(t.asset).toUpperCase() === assetOfSymbol.toUpperCase());

  const transferRows = transfersForAsset.map((t) => {
    const incoming = IN_TYPES.has(t.type);
    const numFmt = (n) => Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 8 });
    const txid = String(t.tx_id || '');
    return `<tr>
      <td class="small">${e(fmtDateTime(t.tx_time))}</td>
      <td class="small">${e(t.account_name)} <span class="muted">${e(t.exchange)}</span></td>
      <td><span class="status-badge ${incoming ? 'pos' : t.type === 'other' ? 'muted' : 'neg'}">${e(TYPE_LABEL[t.type] || t.type)}</span></td>
      <td class="${incoming ? 'pos' : 'neg'} strong">${incoming ? '+' : '-'}${numFmt(t.amount)} ${e(t.asset)}</td>
      <td>${t.fee ? `${numFmt(t.fee)} ${e(t.asset)}` : '—'}</td>
      <td class="small">${e(t.chain || '—')}</td>
      <td class="small">${txid ? `<span class="rate" title="${e(txid)}">${e(txid.slice(0, 14))}${txid.length > 14 ? '…' : ''}</span>` : '—'}</td>
      <td class="muted small">${e(t.note || '')}</td>
    </tr>`;
  }).join('');

  return shell({
    active: 'spot', user, title: `${symbol} 现货详情`,
    subtitle: '买入卖出、持仓成本、平均持仓时间与复盘笔记',
    notice, error,
    body: `<div class="page-actions">
      <a class="btn btn-ghost small" href="/dashboard/spot">← 返回现货</a>
      <a class="btn btn-ghost small" href="/dashboard/journal?market=spot&symbol=${encodeURIComponent(symbol)}">在交易记录中筛选</a>
    </div>

    <div class="mini-strip">
      <div class="mini-stat"><span>当前持仓</span><b>${fmtNum(totalQty, 8)}</b></div>
      <div class="mini-stat"><span>持仓市值</span><b>${fmtMoney(spotValue, { sign: false })}</b></div>
      <div class="mini-stat"><span>已实现盈亏</span><b class="${realized > 0 ? 'pos' : realized < 0 ? 'neg' : ''}">${fmtMoney(realized)}</b></div>
      <div class="mini-stat"><span>平均持仓时间</span><b class="small">${avgHoldMs === null ? '—' : fmtDuration(avgHoldMs)}</b></div>
    </div>
    <div class="mini-strip">
      <div class="mini-stat"><span>买入 / 卖出</span><b class="small">${buys.length} / ${sells.length} 笔</b></div>
      <div class="mini-stat"><span>买入均价</span><b class="small">${avgBuy === null ? '—' : fmtPrice(avgBuy)}</b></div>
      <div class="mini-stat"><span>卖出均价</span><b class="small">${avgSell === null ? '—' : fmtPrice(avgSell)}</b></div>
      <div class="mini-stat"><span>手续费合计</span><b class="small">${fmtMoney(totalFee)}</b></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>当前持仓</h2>
        <span class="muted small">首次买入按 FIFO 剩余批次计算</span></div>
      <table class="table">
        <thead><tr><th>账户</th><th>数量</th><th>平均成本</th><th>当前价</th><th>市值</th><th>未实现盈亏</th><th>首次买入 / 已持有</th><th>备注</th></tr></thead>
        <tbody>${holdingRows || '<tr><td colspan="8" class="muted center">这个交易对当前没有持仓。</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>买入 / 卖出记录</h2>
        <span class="muted small">最近 ${fills.length} 笔现货成交</span></div>
      <table class="table">
        <thead><tr><th>时间</th><th>账户</th><th>方向</th><th>价格</th><th>数量</th><th>金额</th><th>手续费</th></tr></thead>
        <tbody>${fillRows || '<tr><td colspan="7" class="muted center">还没有现货成交记录。</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>已实现交易</h2>
        <span class="muted small">FIFO 配对后的现货交易；复盘笔记在交易详情页编辑</span></div>
      <table class="table">
        <thead><tr><th>开仓时间</th><th>平仓时间</th><th>持仓时长</th><th>方向</th><th>数量</th><th>开 → 平</th><th>盈亏</th><th></th></tr></thead>
        <tbody>${tradeRows || '<tr><td colspan="8" class="muted center">还没有已实现的现货交易。买入后卖出，配对完成才会出现在这里。</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>充提与划转（${e(assetOfSymbol)}）</h2>
        <span class="muted small">这个币种的链上充提记录，按币种数量显示</span></div>
      <table class="table">
        <thead><tr><th>时间</th><th>账户</th><th>类型</th><th>数量</th><th>手续费</th><th>链</th><th>TxID</th><th>备注</th></tr></thead>
        <tbody>${transferRows || `<tr><td colspan="8" class="muted center">还没有 ${e(assetOfSymbol)} 的充提记录。</td></tr>`}</tbody>
      </table>
      <p class="chart-note">完整流水在<a href="/dashboard/transfers?asset=${encodeURIComponent(assetOfSymbol)}">资金流水</a>查看。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>交易对档案（现货）</h2>
        <div class="head-actions">
          <a class="btn btn-ghost small" href="/dashboard/notes/symbol/${encodeURIComponent(symbol)}">完整档案页</a>
          ${archiveNote
            ? `<a class="btn btn-ghost small" href="/dashboard/notes/${archiveNote.id}/edit">编辑档案</a>`
            : `<a class="btn btn-primary small" href="/dashboard/notes/new?category=symbol&subject=${encodeURIComponent(symbol)}">建立档案</a>`}
        </div>
      </div>
      ${archiveNote
        ? `<div class="markdown">${renderMarkdown(archiveNote.content) || '<p class="muted">档案还是空的。</p>'}</div>`
        : '<p class="muted small">还没有这个交易对的长期档案。写现货的结构、买入逻辑和失效条件。</p>'}
      <p class="chart-note">这是同一个档案的现货视角；在「完整档案页」里还能看到该交易对的合约逐笔复盘（如果有）。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>现货备注（持仓计划）</h2>
        <span class="muted small">与「笔记 → 现货备注」同步；支持 Markdown 与图片</span></div>
      ${holdings.length ? holdings.map((h) => {
        const accountNotes = spotNotes.filter((n) => String(n.account_id) === String(h.account_id));
        const current = accountNotes[0];
        const history = accountNotes.slice(1);
        return `${current ? `<div class="spot-note-current">
          <div class="spot-note-head">
            <b>${e(h.account_name)}</b> <span class="muted small">${e(h.exchange)} · ${e(symbol)} · 更新于 ${e(fmtDateTime(current.updated_at))}</span>
            <div class="head-actions">
              <a class="btn btn-ghost small" href="/dashboard/notes/${current.id}/edit">编辑</a>
              <a class="btn btn-ghost small" href="/dashboard/notes/${current.id}">在笔记中打开</a>
            </div>
          </div>
          <div class="markdown">${renderMarkdown(current.content) || '<p class="muted">这篇备注还是空的，点「编辑」开始写。</p>'}</div>
        </div>` : `<div class="spot-note-current">
          <div class="spot-note-head">
            <b>${e(h.account_name)}</b> <span class="muted small">${e(h.exchange)} · ${e(symbol)}</span>
          </div>
          <form method="post" action="/dashboard/spot/note" class="form-actions" style="margin:8px 0 0">
            <input type="hidden" name="account_id" value="${h.account_id}">
            <input type="hidden" name="symbol" value="${e(symbol)}">
            <input type="hidden" name="open_new" value="1">
            <button class="btn btn-primary small" type="submit">+ 开始写备注</button>
            <span class="muted small">会打开 Markdown 编辑器，保存后回到本页</span>
          </form>
        </div>`}
        ${history.length ? `<div class="spot-note-history">
          <span class="muted small">历史备注：</span>
          ${history.map((n) => `<span class="tag-pill"><a href="/dashboard/notes/${n.id}">${e(n.title)}</a></span>`).join(' ')}
        </div>` : ''}`;
      }).join('') : `<div class="panel muted center">当前没有持仓；要写备注请先买入并在同步后回到这里。</div>`}
      <p class="chart-note">这里直接显示备注内容（和合约详情页的「交易复盘」一样）；点「编辑」在笔记页修改。清仓重新买入后，可以开一段新备注，旧的自动归为历史。</p>
      ${holdings.some((h) => spotNotes.some((n) => String(n.account_id) === String(h.account_id))) ? `<form method="post" action="/dashboard/spot/note" class="form-actions" style="margin-top:6px">
        <input type="hidden" name="account_id" value="${e(holdings[0].account_id)}">
        <input type="hidden" name="symbol" value="${e(symbol)}">
        <input type="hidden" name="open_new" value="1">
        <button class="btn btn-ghost small" type="submit">清仓重新买入？开一段新备注</button>
      </form>` : ''}
    </section>`,
  });
}
