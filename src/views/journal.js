import {
  escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDuration, fmtDurationShort, fmtDateTime, fmtPrice, toLocalInput,
} from '../http.js';
import { tradeBreakdown } from '../breakdown.js';
import { renderMarkdown } from '../markdown.js';
import { lineChart, PALETTE } from '../charts.js';
import { shell, quickNoteBtn, tradeSideLabel } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

/**
 * 币本位（反向合约）的币口径金额。
 * 库里统一存 USD；按平仓价折回结算币，便于和交易所账单对账。
 * 非币本位（现货或 USDT/USDC 本位）返回 null。
 */
export function coinMarginedAmounts(trade) {
  const [base = '', quote = ''] = String(trade?.symbol || '').split('/');
  if (!base || String(quote).toUpperCase() !== 'USD' || trade?.market === 'spot') return null;
  const fx = Number(trade.exit_price);
  if (!(fx > 0)) return null;
  return {
    base,
    pnl: (Number(trade.pnl) || 0) / fx,
    fee: (Number(trade.fee) || 0) / fx,
    funding: (Number(trade.funding) || 0) / fx,
  };
}

/**
 * 反向合约成交的展示数量：库里的 qty 是张数，contractValue 是美元/张，
 * 按成交价折回结算币。非反向合约原样返回。
 */
export function inverseFillQty(fill) {
  const cv = Number(fill?.contractValue) || 0;
  const price = Number(fill?.price) || 0;
  if (!(cv > 0) || !(price > 0)) return Number(fill?.qty) || 0;
  return (Number(fill.qty) || 0) * cv / price;
}

/** 持仓期间浮盈亏曲线：K 线收盘价 × 方向 × 数量，不含手续费与资金费 */
function curvePanel(trade, curve) {
  if (!curve) return '';
  if (curve.unsupported) {
    return `<section class="panel">
      <div class="panel-head"><h2>持仓盈亏曲线（开仓 → 平仓）</h2></div>
      <div class="chart-empty">${e(curve.unsupported)}</div>
    </section>`;
  }
  const dir = trade.side === 'long' ? 1 : -1;
  const entry = Number(trade.entry_price) || 0;
  const size = Number(trade.size) || 0;
  const coin = coinMarginedAmounts(trade);
  const base = coin ? coin.base : '';
  // 反向合约：USD 浮盈 ÷ 当时价格 = 币计浮盈（等价于张数 × 面值 × (1/开仓价 − 1/现价)）
  const conv = (usd, price) => (coin && price > 0 ? usd / price : usd);
  const fmtVal = (v) => (coin
    ? `${Number(v) > 0 ? '+' : ''}${fmtNum(Number(v) || 0, 8)} ${base}`
    : fmtMoney(v));
  const fmtAbs = (v) => (coin ? `${fmtNum(Number(v) || 0, 8)} ${base}` : fmtMoney(v, { sign: false }));
  const multiDay = Date.parse(trade.close_time) - Date.parse(trade.open_time) > 86_400_000;
  const label = (v) => {
    const d = new Date(v);
    const p = (n) => String(n).padStart(2, '0');
    return multiDay
      ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
      : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const points = [{ x: label(trade.open_time), value: 0 }];
  for (const k of curve.candles) points.push({ x: label(k.t), value: conv((k.c - entry) * dir * size, k.c) });
  const exit = Number(trade.exit_price) || 0;
  const final = exit ? conv((exit - entry) * dir * size, exit) : points[points.length - 1].value;
  points.push({ x: `${label(trade.close_time)} 平仓`, value: final });

  let peak = -Infinity, trough = Infinity;
  for (const p of points) {
    if (p.value > peak) peak = p.value;
    if (p.value < trough) trough = p.value;
  }
  const giveback = Math.max(0, peak - final);

  return `<section class="panel">
    <div class="panel-head"><h2>持仓盈亏曲线（开仓 → 平仓）</h2>
      <span class="muted small">按 ${e(curve.bar)} K 线收盘价估算 · 不含手续费与资金费</span></div>
    <div class="mini-strip">
      <div class="mini-stat"><span>浮盈峰值</span><b class="${sign(peak)}">${fmtVal(peak)}</b></div>
      <div class="mini-stat"><span>最大浮亏</span><b class="${trough < 0 ? 'neg' : 'flat'}">${fmtVal(trough)}</b></div>
      <div class="mini-stat"><span>平仓价格毛盈亏</span><b class="${sign(final)}">${fmtVal(final)}</b></div>
      <div class="mini-stat"><span>利润回吐</span><b class="${giveback > 0 ? 'neg' : 'flat'}">${fmtAbs(giveback)}</b>
        <div class="muted small">浮盈峰值到平仓的回落幅度</div></div>
    </div>
    <div class="chart-box">
      ${lineChart({
        points,
        color: final >= 0 ? PALETTE.green : PALETTE.red,
        yFormat: (v) => (coin ? fmtNum(v, 8) : fmtMoney(v, { sign: false })),
        xFormat: (v) => String(v),
      })}
    </div>
    <p class="chart-note">${coin
      ? `曲线 = 张数 × 面值 × (1/开仓价 − 1/收盘价)，即未实现毛盈亏（${e(base)} 计）；手续费与资金费的结算时点交易所未提供，未计入曲线，最终净盈亏以上表为准。`
      : '曲线 = （K 线收盘价 − 开仓价） × 方向 × 数量，即未实现毛盈亏；手续费与资金费的结算时点交易所未提供，未计入曲线，最终净盈亏以上表为准。'}${curve.truncated ? '持仓时间过长，仅展示最近 300 根 K 线。' : ''}</p>
  </section>`;
}

function buildQuery(filters, pageNo) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (!value || value === 'all') continue;
    p.set(key, String(value));
  }
  if (pageNo && pageNo > 1) p.set('page', String(pageNo));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function pager(filters, pagination) {
  const { page, totalPages, total, pageSize } = pagination;
  const link = (n, label, cls = '') =>
    `<a class="pager-item ${cls}" href="/dashboard/journal${buildQuery(filters, n)}">${label}</a>`;
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  const nums = new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages));
  const items = [...nums].sort((a, b) => a - b).flatMap((n, i, arr) => {
    const prev = arr[i - 1];
    const els = [];
    if (prev && n - prev > 1) els.push('<span class="pager-dots">…</span>');
    els.push(link(n, String(n), n === page ? 'active' : ''));
    return els;
  }).join('');
  return `<div class="pager">
    <span class="muted small">第 ${fmtNum(first)}–${fmtNum(last)} 条 / 共 ${fmtNum(total)} 条</span>
    <div class="pager-links">
      ${page > 1 ? link(page - 1, '上一页') : '<span class="pager-item disabled">上一页</span>'}
      ${items}
      ${page < totalPages ? link(page + 1, '下一页') : '<span class="pager-item disabled">下一页</span>'}
    </div>
  </div>`;
}

function filterBar(filters, symbols, tags, accounts = []) {
  const opt = (value, label, current) =>
    `<option value="${e(value)}" ${String(current) === String(value) ? 'selected' : ''}>${e(label)}</option>`;
  return `<form method="get" action="/dashboard/journal" class="filter-bar">
    ${accounts.length > 1 ? `<select name="account_id">
      ${opt('all', '全部账户', filters.account_id)}
      ${accounts.map((a) => opt(String(a.id), `${a.name}${a.is_demo ? '（演示）' : ''}`, filters.account_id)).join('')}
    </select>` : ''}
    <select name="market">
      ${opt('all', '全部市场', filters.market)}
      ${opt('futures', '合约', filters.market)}
      ${opt('spot', '现货', filters.market)}
    </select>
    <select name="side">
      ${opt('all', '全部方向', filters.side)}
      ${opt('long', '做多', filters.side)}
      ${opt('short', '做空', filters.side)}
    </select>
    <select name="result">
      ${opt('all', '全部结果', filters.result)}
      ${opt('win', '盈利', filters.result)}
      ${opt('loss', '亏损', filters.result)}
    </select>
    <select name="symbol">
      ${opt('all', '全部币种', filters.symbol)}
      ${symbols.map((s) => opt(s, s, filters.symbol)).join('')}
    </select>
    <select name="orderType">
      ${opt('all', '全部类型', filters.orderType)}
      ${opt('market', '市价单', filters.orderType)}
      ${opt('limit', '限价单', filters.orderType)}
      ${opt('mixed', '混合', filters.orderType)}
      ${opt('other', '其他', filters.orderType)}
    </select>
    <select name="tag">
      ${opt('', '全部标签', filters.tag)}
      ${tags.map((t) => opt(t.name, t.name, filters.tag)).join('')}
    </select>
    <select name="note">
      ${opt('all', '笔记不限', filters.note)}
      ${opt('yes', '有复盘笔记', filters.note)}
      ${opt('no', '没写复盘', filters.note)}
    </select>
    <input type="date" name="from" value="${e(filters.from || '')}" title="开始日期">
    <input type="date" name="to" value="${e(filters.to || '')}" title="结束日期">
    <input name="q" value="${e(filters.q || '')}" placeholder="币种 / 笔记关键词">
    <select name="sort">
      ${opt('time', '按时间', filters.sort)}
      ${opt('pnl', '按盈亏', filters.sort)}
      ${opt('duration', '按时长', filters.sort)}
      ${opt('size', '按名义价值', filters.sort)}
    </select>
    <button class="btn btn-primary small" type="submit">筛选</button>
    <a class="btn btn-ghost small" href="/dashboard/journal">重置</a>
  </form>`;
}

/** 当前筛选 → /api/export 的查询串（与列表页同口径；sort/pagination 不参与导出） */
function exportQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'sort') continue;
    if (!value || value === 'all') continue;
    params.set(key, value);
  }
  return params.toString();
}

export function journalPage({ user, trades, filters, tags, symbols, pagination, noteCoverage, accounts = [], trashedCount = 0, back = '', notice, error }) {
  const backQ = back ? `?back=${encodeURIComponent(back)}` : '';
  const rows = trades.map((t) => {
    const coin = coinMarginedAmounts(t);
    return `<tr>
    <td class="bulk-cell"><input type="checkbox" form="journal-bulk" class="bulk-check" name="ids" value="${t.id}" aria-label="选择 ${e(t.symbol)} ${e(fmtDateTime(t.close_time))}"></td>
    <td>${fmtDateTime(t.close_time)}</td>
    <td><a href="/dashboard/journal/${t.id}"><b>${e(t.symbol)}</b></a>${coin ? ' <span class="status-badge muted" title="币本位（反向合约），盈亏按结算币显示">币本位</span>' : ''}
      <div class="muted small">${t.market === 'spot' ? '现货' : '合约'} · ${e(t.account_name || '—')} · <a href="/dashboard/notes/symbol/${encodeURIComponent(t.symbol)}">档案</a></div></td>
    <td><span class="side-tag ${t.side}">${e(tradeSideLabel(t))}</span></td>
    <td>${t.order_type === 'limit' ? '挂单' : t.order_type === 'market' ? '吃单' : t.order_type === 'mixed' ? '混合' : '—'}</td>
    <td class="num">${fmtPrice(t.entry_price)} → ${fmtPrice(t.exit_price)}</td>
    <td class="num">${fmtMoney(t.notional, { sign: false })}</td>
    <td class="num"><div class="${sign(t.pnl)} strong">${coin ? `${fmtNum(coin.pnl, 8)} ${e(coin.base)}` : fmtMoney(t.pnl)}</div>
      ${coin ? `<div class="muted small">${fmtMoney(t.pnl)}</div>` : ''}</td>
    <td class="num muted">${e(fmtDurationShort(new Date(t.close_time) - new Date(t.open_time)))}</td>
    <td class="tags-cell">${(t.tags || []).map((x) => `<span class="tag-pill">${e(x)}</span>`).join(' ')}</td>
    <td class="quick-note-cell">${quickNoteBtn(t)}</td>
    <td class="row-actions">
      <a class="btn btn-ghost small" href="/dashboard/journal/${t.id}${backQ}">详情</a>
      <a class="btn btn-ghost small" href="/dashboard/journal/${t.id}/edit${backQ}">编辑</a>
      <form method="post" action="/dashboard/journal/${t.id}/trash" class="inline" data-no-guard>
        <input type="hidden" name="back" value="${e(back || '/dashboard/journal')}">
        <button class="btn btn-ghost small danger" type="submit"
          title="移入垃圾箱：不参与统计，同步也不会再导回"
          data-confirm="把这条记录移入垃圾箱？&#10;统计会立即排除它，交易所同步也不会再把它导回来；可在交易记录 → 垃圾箱里恢复。">删除</button>
      </form>
    </td>
  </tr>`;
  }).join('');

  const coverage = noteCoverage && noteCoverage.total
    ? `<div class="coverage-inline"><span class="muted">复盘覆盖率</span>
        <b>${(noteCoverage.ratio * 100).toFixed(1)}%</b>
        <span class="muted small">（${noteCoverage.noted} / ${noteCoverage.total}）</span></div>`
    : '';

  const body = `
    ${coverage}
    <section class="panel">
      <div class="panel-head"><h2>筛选</h2></div>
      ${filterBar(filters, symbols, tags, accounts)}
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>交易记录</h2>
        <div class="head-actions">
          <a class="btn btn-ghost small" href="/api/export?format=csv&${exportQuery(filters)}" title="按当前筛选导出全部符合条件的数据（不限本页）">导出 CSV</a>
          <a class="btn btn-ghost small" href="/dashboard/import">导入 CSV</a>
          <a class="btn btn-ghost small" href="/dashboard/journal/trash">垃圾箱${trashedCount ? ` (${fmtNum(trashedCount)})` : ''}</a>
          <a class="btn btn-primary small" href="/dashboard/journal/new">+ 手动记录</a>
        </div>
      </div>
      <form id="journal-bulk" method="post" action="/dashboard/journal/trash-batch" class="bulk-bar">
        <input type="hidden" name="back" value="${e(back || '/dashboard/journal')}">
        <button class="btn btn-ghost small danger" type="submit" data-bulk-submit disabled>删除选中</button>
        <span class="muted small" data-bulk-count>勾选左侧复选框可批量移入垃圾箱（只作用于本页）</span>
      </form>
      <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="bulk-cell"><input type="checkbox" form="journal-bulk" data-bulk-all aria-label="全选本页"></th>
          <th>平仓时间</th><th>币种</th><th>方向</th><th>类型</th><th class="num">开仓 → 平仓</th>
          <th class="num">名义价值</th><th class="num" title="币本位（反向合约）按结算币显示，下方灰字为折合 USD">净盈亏</th><th class="num">持仓</th><th>标签</th><th>复盘</th><th></th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="12" class="muted center">没有符合条件的交易</td></tr>'}</tbody>
      </table>
      </div>
      ${pager(filters, pagination)}
    </section>`;

  return shell({
    active: 'journal',
    user,
    title: '交易记录',
    subtitle: '复盘笔记在详情页编辑，支持 Markdown 与图片',
    notice,
    error,
    body,
  });
}

function tagPicker(tags, selected = [], newTags = '') {
  const set = new Set(selected || []);
  const boxes = (tags || []).map((t) => `<label class="tag-check">
      <input type="checkbox" name="tags" value="${e(t.name)}" ${set.has(t.name) ? 'checked' : ''}>
      <span class="tag-pill">${e(t.name)}</span>
    </label>`).join('');
  return `<div class="tag-picker">${boxes || '<span class="muted small">还没有标签，可在下方新建</span>'}</div>
    <input name="new_tags" value="${e(newTags || '')}" placeholder="新标签，逗号分隔（例如：突破, 趋势）">`;
}

function tradeForm({ action, trade = {}, accounts, tags, back = '', error, submitLabel }) {
  const selectedAccount = trade.account_id || accounts[0]?.id;
  return `<section class="panel">
    <form method="post" action="${action}" class="form grid-form">
      <input type="hidden" name="back" value="${e(back)}">
      <label class="field"><span>币种</span><input name="symbol" required value="${e(trade.symbol || '')}" placeholder="BTC/USDT"></label>
      <label class="field"><span>方向</span>
        <select name="side">
          <option value="long" ${trade.side === 'short' ? '' : 'selected'}>做多</option>
          <option value="short" ${trade.side === 'short' ? 'selected' : ''}>做空</option>
        </select>
      </label>
      <label class="field"><span>订单类型</span>
        <select name="order_type">
          ${['market', 'limit', 'mixed', 'other'].map((v) => `<option value="${v}" ${(trade.order_type || 'market') === v ? 'selected' : ''}>${v === 'market' ? '市价单（吃单）' : v === 'limit' ? '限价单（挂单）' : v === 'mixed' ? '混合' : '其他'}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>账户</span>
        <select name="account_id">
          ${accounts.map((a) => `<option value="${a.id}" ${Number(selectedAccount) === a.id ? 'selected' : ''}>${e(a.name)}（${e(a.exchange)}）</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>开仓时间</span><input name="open_time" type="datetime-local" required value="${e(toLocalInput(trade.open_time))}"></label>
      <label class="field"><span>平仓时间</span><input name="close_time" type="datetime-local" required value="${e(toLocalInput(trade.close_time))}"></label>
      <label class="field"><span>开仓价</span><input name="entry_price" type="number" step="any" required value="${trade.entry_price ?? ''}"></label>
      <label class="field"><span>平仓价</span><input name="exit_price" type="number" step="any" required value="${trade.exit_price ?? ''}"></label>
      <label class="field"><span>数量</span><input name="size" type="number" step="any" value="${trade.size ?? ''}"></label>
      <label class="field"><span>名义价值（USD）</span><input name="notional" type="number" step="any" value="${trade.notional ?? ''}" placeholder="留空 = 开仓价 × 数量"></label>
      <label class="field"><span>净盈亏（留空自动算）</span><input name="pnl" type="number" step="any" value="${trade.pnl ?? ''}"></label>
      <label class="field"><span>手续费（正=返佣，负=支出）</span><input name="fee" type="number" step="any" value="${trade.fee ?? 0}"></label>
      <label class="field"><span>资金费（正=收取，负=支付）</span><input name="funding" type="number" step="any" value="${trade.funding ?? 0}"></label>
      <label class="field"><span>纪律</span>
        <select name="followed_plan">
          <option value="" ${trade.followed_plan == null ? 'selected' : ''}>未标记</option>
          <option value="1" ${Number(trade.followed_plan) === 1 ? 'selected' : ''}>按计划执行</option>
          <option value="0" ${Number(trade.followed_plan) === 0 ? 'selected' : ''}>违反计划</option>
        </select>
      </label>
      <div class="field wide"><span>标签</span>${tagPicker(tags, trade.tags || [], trade.new_tags || '')}</div>
      <label class="field wide"><span>备注</span><textarea name="note" rows="3">${e(trade.note || '')}</textarea></label>
      <div class="form-actions wide">
        <button class="btn btn-primary" type="submit">${e(submitLabel)}</button>
        <a class="btn btn-ghost" href="${e(back || '/dashboard/journal')}">取消</a>
      </div>
    </form>
  </section>`;
}

export function journalCreatePage({ user, accounts, tags, error, draft = null }) {
  return shell({
    active: 'journal', user, title: '手动记录一笔交易',
    subtitle: '自动同步之外的补充记录，同样参与全部统计。净盈亏留空时会按开平仓价自动计算。',
    error,
    body: tradeForm({
      action: '/dashboard/journal/new',
      trade: draft || {},
      accounts, tags, error: '',
      submitLabel: '保存交易',
    }),
  });
}

export function journalEditPage({ user, trade, accounts, tags, error, back = '' }) {
  return shell({
    active: 'journal', user,
    title: `编辑 ${trade.symbol}`,
    subtitle: '来源与外部 ID 不会被修改，避免重复导入',
    error,
    body: tradeForm({
      action: `/dashboard/journal/${trade.id}/edit`,
      trade, accounts, tags, back,
      submitLabel: '保存修改',
    }),
  });
}

/** 操作明细：该回合的逐笔成交（含加仓、减仓、做T），按时间归属同一记录 */
function opsPanel(trade, ops) {
  if (!ops) return '';
  if (ops.unsupported) {
    return `<section class="panel">
      <div class="panel-head"><h2>操作明细（开仓 → 平仓）</h2></div>
      <div class="chart-empty">${e(ops.unsupported)}</div>
    </section>`;
  }
  const fmtQty = (v) => {
    const n = Math.abs(Number(v) || 0);
    return (n < 1e-10 ? 0 : n).toLocaleString('en-US', { maximumFractionDigits: 6 });
  };
  const coin = coinMarginedAmounts(trade);
  const coinCcy = coin ? coin.base : '';
  // 币金额普遍很小（BTC 手续费常常 1e-7 级），币口径改用 8 位小数
  const fmtCoinQty = (v) => {
    const n = Math.abs(Number(v) || 0);
    return (n < 1e-12 ? 0 : n).toLocaleString('en-US', { maximumFractionDigits: 8 });
  };
  const fq = coinCcy ? fmtCoinQty : fmtQty;
  const isInverseFill = (f) => Number(f.contractValue) > 0;
  const feeInCoin = (f) => {
    const price = Number(f.price) || 0;
    return isInverseFill(f) && price > 0 ? Math.abs(Number(f.fee) || 0) / price : Math.abs(Number(f.fee) || 0);
  };
  let pos = 0;
  let makerCount = 0;
  let takerCount = 0;
  const fillOrderType = (f) => {
    if (f.orderType === 'limit' || f.orderType === 'market') return f.orderType;
    if (f.execType === 'M') return 'limit';
    if (f.execType === 'T') return 'market';
    return null;
  };
  const rows = ops.fills.map((f) => {
    const before = pos;
    const opened = Math.abs(before) < 1e-9;
    const rawQty = Math.abs(Number(f.qty) || 0);
    // 净头寸按「张」累计（开平张数一致才能归零）；展示时再按当前成交价折成币
    pos += f.side === 'buy' ? rawQty : -rawQty;
    const flat = Math.abs(pos) < 1e-9;
    const grew = Math.abs(pos) > Math.abs(before) + 1e-9;
    const qty = inverseFillQty(f);
    const heldQty = isInverseFill(f)
      ? (Number(f.price) > 0 ? pos * (Number(f.contractValue) || 0) / Number(f.price) : 0)
      : pos;
    const op = opened ? '首次开仓' : flat ? '平仓（清零）' : grew ? '加仓' : '减仓 / 做T';
    const ot = fillOrderType(f);
    if (ot === 'limit') makerCount++;
    else if (ot === 'market') takerCount++;
    const otCell = ot === 'limit'
      ? '<span class="status-badge blue">限价挂单</span>'
      : ot === 'market'
        ? '<span class="status-badge muted">市价吃单</span>'
        : '<span class="muted">—</span>';
    const feeUnit = isInverseFill(f) ? coinCcy : f.feeCcy;
    return `<tr>
      <td class="small">${e(fmtDateTime(new Date(f.t).toISOString()))}</td>
      <td>${op}</td>
      <td>${f.side === 'buy' ? '<span class="pos">买入</span>' : '<span class="neg">卖出</span>'}</td>
      <td>${otCell}</td>
      <td class="num">${fmtPrice(f.price)}</td>
      <td class="num">${fq(qty)}</td>
      <td class="num ${f.fee <= 0 ? 'neg' : 'pos'}">${f.fee ? `${fq(feeInCoin(f))} ${e(feeUnit || '')}` : '—'}</td>
      <td class="num strong">${fq(heldQty)}</td>
    </tr>`;
  }).join('');
  let buy = 0, sell = 0;
  const fees = new Map();
  for (const f of ops.fills) {
    const qty = inverseFillQty(f);
    if (f.side === 'buy') buy += qty; else sell += qty;
    if (f.fee) {
      const ccy = isInverseFill(f) ? (coinCcy || '—') : (f.feeCcy || '—');
      fees.set(ccy, (fees.get(ccy) || 0) + feeInCoin(f));
    }
  }
  const feeText = [...fees.entries()].map(([ccy, v]) => `${fq(v)} ${e(ccy)}`).join(' + ') || '—';
  const qtyHead = coinCcy ? `数量（${e(coinCcy)}）` : '数量';
  const qtyNote = coinCcy
    ? `数量与手续费按结算币（${e(coinCcy)}）显示：每笔成交按「合约张数 × 面值 ÷ 成交价」换算，手续费由 USD 折回币；「本笔后持仓」按张数净头寸折算，平仓归零。`
    : '数量为币本位（合约已按面值换算成币）；「本笔后持仓」为净头寸。头部统计里的「数量」是按毛盈亏反推的等效值，多腿回合以本表为准。';
  return `<section class="panel">
    <div class="panel-head"><h2>操作明细（开仓 → 平仓）</h2>
      <span class="muted small">同一回合的开仓、加仓、减仓、做T 全部归属这条记录 · 共 ${fmtNum(ops.fills.length)} 笔成交${makerCount || takerCount ? ` · 挂单 ${fmtNum(makerCount)} / 吃单 ${fmtNum(takerCount)}` : ''}</span></div>
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>时间</th><th>操作</th><th>方向</th><th>委托</th><th class="num">价格</th><th class="num">${qtyHead}</th><th class="num">手续费</th><th class="num">本笔后持仓</th></tr></thead>
      <tbody>
        ${rows}
        <tr><td colspan="4" class="strong">合计</td>
          <td></td>
          <td class="strong">买 ${fq(buy)} / 卖 ${fq(sell)}</td>
          <td class="num">${feeText}</td>
          <td class="num strong">${Math.abs(pos) < 1e-9 ? '归零' : fq(pos)}</td></tr>
      </tbody>
    </table>
    </div>
    <p class="chart-note">${qtyNote}</p>
  </section>`;
}

export function tradeDetailPage({ user, trade, curve = null, ops = null, quickTags = [], allTags = [], aiReady = false, aiModel = '', back = '', notice, error }) {
  const b = tradeBreakdown(trade);
  const pnlCls = sign(trade.pnl);
  // 币本位（反向合约）：交易所按结算币结算盈亏，库里统一存 USD。
  // 页面以币口径为主、USD 为辅，方便和交易所账单直接对账。
  const coin = coinMarginedAmounts(trade);
  const baseCcy = coin ? coin.base : '';
  const coinFx = coin ? Number(trade.exit_price) || 0 : 0;
  const coinPnl = coin ? coin.pnl : null;
  const fmtCoin = (v) => `${Number(v) > 0 ? '+' : ''}${fmtNum(Number(v) || 0, 8)} ${baseCcy}`;
  const coinText = (v) => (coin ? `${fmtNum(Number(v) / (coinFx || 1), 8)} ${baseCcy}` : fmtMoney(v));
  const breakdownVal = (v) => (coin
    ? `<span>${fmtCoin(Number(v) / (coinFx || 1))}</span><div class="muted small">${fmtMoney(v)}</div>`
    : fmtMoney(v));
  const tags = (trade.tags || []).map((x) => `<span class="tag-pill">${e(x)}</span>`).join(' ');
  // 详情页行内快捷标签：与仪表盘复盘队列同一套交互（点击即切换，免去进编辑表单）
  const current = new Set(trade.tags || []);
  const tagButton = (name) => `
      <form method="post" action="/dashboard/journal/${trade.id}/tag" class="inline quick-tag-form" data-no-guard>
        <input type="hidden" name="tag" value="${e(name)}">
        <input type="hidden" name="back" value="/dashboard/journal/${trade.id}">
        <button class="tag-pill ${current.has(name) ? 'active' : ''}" type="submit">${e(name)}</button>
      </form>`;
  const quickRow = (quickTags || []).map((x) => tagButton(x.name)).join(' ');
  // 快捷列表之外的标签：可展开后直接挂到这笔交易，不用进编辑表单
  const quickNames = new Set((quickTags || []).map((x) => x.name));
  const extraTags = (allTags || []).filter((t) => !quickNames.has(t.name));
  const extraRow = extraTags.length ? `
      <details style="margin-top:8px">
        <summary class="muted small" style="cursor:pointer">更多标签（${extraTags.length}）</summary>
        <div class="tag-row" style="margin-top:8px">${extraTags.map((t) => tagButton(t.name)).join(' ')}</div>
      </details>` : '';
  const diffCls = b.priceMatch === null ? 'flat' : b.priceMatch ? 'pos' : 'neg';
  const diffText = b.pricePnl === null
    ? '缺少开仓价 / 平仓价 / 数量，无法独立复算'
    : b.priceMatch ? '一致（差异在 1% / $0.01 容差内）' : '不一致（常见于合约面值、币本位或分批成交）';

  const body = `
    <section class="panel">
      <div class="panel-head">
        <h2>${e(trade.symbol)}
          <span class="side-tag ${trade.side}">${e(tradeSideLabel(trade))}</span>
          <span class="status-badge ${trade.market === 'spot' ? 'blue' : 'muted'}">${trade.market === 'spot' ? '现货' : '合约'}</span>
          ${coin ? '<span class="status-badge muted" title="反向合约：交易所按结算币结算，页面统计统一折成 USD">币本位</span>' : ''}
          ${trade.kind === 't_shot' ? '<span class="status-badge blue" title="做T：24 小时内同数量闭环，不影响底仓成本">T 回合</span>' : ''}
          <span class="pill ${b.pnl > 0 ? 'pill-green' : b.pnl < 0 ? 'pill-red' : ''}" ${coin ? `title="折合 ${fmtMoney(trade.pnl)}"` : ''}>${coin ? fmtCoin(coinPnl) : fmtMoney(trade.pnl)}</span>
        </h2>
        <div class="head-actions">
          <a class="btn btn-ghost small" href="${e(back || '/dashboard/journal')}">返回列表</a>
          <a class="btn btn-ghost small" href="/dashboard/notes/symbol/${encodeURIComponent(trade.symbol)}">交易对档案</a>
          <a class="btn btn-ghost small" href="/dashboard/journal/${trade.id}/edit${back ? `?back=${encodeURIComponent(back)}` : ''}">编辑数据</a>
          <form method="post" action="/dashboard/journal/${trade.id}/trash" class="inline" data-no-guard>
            <input type="hidden" name="back" value="${e(back)}">
            <button class="btn btn-ghost small danger" type="submit"
              data-confirm="把这条记录移入垃圾箱？&#10;统计会立即排除它，交易所同步也不会再把它导回来；可在交易记录 → 垃圾箱里恢复。">删除</button>
          </form>
        </div>
      </div>
      <div class="mini-strip">
        ${coin
          ? `<div class="mini-stat"><span>净盈亏（${e(baseCcy)}）</span><b class="${pnlCls}">${fmtCoin(coinPnl)}</b><div class="muted small">≈ ${fmtMoney(trade.pnl)}</div></div>
             <div class="mini-stat"><span>折合 USD</span><b class="${pnlCls}">${fmtMoney(trade.pnl)}</b></div>`
          : `<div class="mini-stat"><span>净盈亏</span><b class="${pnlCls}">${fmtMoney(trade.pnl)}</b></div>`}
        <div class="mini-stat"><span>收益率（按名义价值）</span><b class="${sign(b.returnPct)}">${b.returnPct === null ? '—' : fmtPct(b.returnPct)}</b></div>
        <div class="mini-stat"><span>持仓时长</span><b>${e(fmtDuration(b.durationMs))}</b></div>
        <div class="mini-stat"><span>账户</span><b class="small">${e(trade.account_name || '—')}</b></div>
      </div>
      <div class="stat-grid">
        <div class="stat-col">
          <div class="stat-item"><span class="stat-label">开仓 → 平仓</span><span class="stat-value">${fmtPrice(trade.entry_price)} → ${fmtPrice(trade.exit_price)}</span></div>
          <div class="stat-item"><span class="stat-label">数量${coin ? `（${e(baseCcy)}）` : ''}</span><span class="stat-value">${fmtNum(trade.size, 6)}</span></div>
          <div class="stat-item"><span class="stat-label">名义价值</span><span class="stat-value">${fmtMoney(trade.notional, { sign: false })}</span></div>
          <div class="stat-item"><span class="stat-label">订单类型</span><span class="stat-value">${trade.order_type === 'limit' ? '限价（纯挂单）' : trade.order_type === 'market' ? '市价（纯吃单）' : trade.order_type === 'mixed' ? '混合（吃挂均有）' : '其他/未知'}</span></div>
        </div>
        <div class="stat-col">
          <div class="stat-item"><span class="stat-label">开仓时间</span><span class="stat-value small">${e(fmtDateTime(trade.open_time))}</span></div>
          <div class="stat-item"><span class="stat-label">平仓时间</span><span class="stat-value small">${e(fmtDateTime(trade.close_time))}</span></div>
          <div class="stat-item"><span class="stat-label">来源</span><span class="stat-value small">${trade.source === 'demo' ? '演示' : trade.source === 'csv' ? 'CSV 导入' : trade.source === 'manual' ? '手动' : e(trade.source)}</span></div>
          <div class="stat-item"><span class="stat-label">外部 ID</span><span class="stat-value small">${e(trade.external_id || '—')}</span></div>
        </div>
      </div>
      <div class="tag-row" style="margin-top:12px">
        ${tags || '<span class="muted small">暂无标签，点下面快捷标签即可添加</span>'}
      </div>
      ${quickRow ? `<div class="tag-row" style="margin-top:8px">
        <span class="muted small">快捷标签：</span>${quickRow}
        <a class="muted small" href="/dashboard/tags#quick-tags">管理</a>
      </div>` : ''}
      ${extraRow}
    </section>

    ${curvePanel(trade, curve)}

    ${opsPanel(trade, ops)}

    <section class="panel">
      <div class="panel-head"><h2>盈亏是怎么算出来的</h2>
        <span class="muted small">只做展示与核对，不修改任何数据</span></div>
      <table class="table breakdown-table">
        <tbody>
          <tr><td>净盈亏（交易所记录${coin ? `，${e(baseCcy)}` : ''}）</td><td class="${pnlCls} strong">${breakdownVal(b.pnl)}</td>
            <td class="muted">统计汇总仍按 USD 聚合；明细按钮里的币口径为「USD ÷ 平仓价」</td></tr>
          <tr><td>手续费（记录值${coin ? `，${e(baseCcy)}` : ''}）</td><td class="${sign(b.fee)}">${breakdownVal(b.fee)}</td>
            <td class="muted">负数 = 支出，正数 = 返佣；公式里按「减手续费」处理</td></tr>
          <tr><td>资金费（记录值${coin ? `，${e(baseCcy)}` : ''}）</td><td class="${sign(b.funding)}">${breakdownVal(b.funding)}</td>
            <td class="muted">负数 = 支付，正数 = 收取；公式里按「减资金费」处理</td></tr>
          <tr class="breakdown-total"><td>毛盈亏 = 净盈亏 − 手续费 − 资金费</td><td class="${sign(b.gross)} strong">${breakdownVal(b.gross)}</td>
            <td class="muted">${coinText(b.pnl)} − (${coinText(b.fee)}) − (${coinText(b.funding)})</td></tr>
          <tr><td>独立复算：(平仓价 − 开仓价) × 数量 × 方向</td>
            <td class="${sign(b.pricePnl)}">${b.pricePnl === null ? '—' : breakdownVal(b.pricePnl)}</td>
            <td class="muted">只用价格与数量，不参考手续费${coin ? `；USD 结果 ÷ 平仓价 = ${e(baseCcy)}` : ''}</td></tr>
          <tr><td>复算差异</td><td class="${diffCls}">${b.priceDiff === null ? '—' : breakdownVal(b.priceDiff)}</td>
            <td class="muted">${e(diffText)}</td></tr>
        </tbody>
      </table>
      <p class="chart-note">
        公式：毛盈亏 = 净盈亏 − 手续费 − 资金费；净盈亏 = 毛盈亏 + 手续费 + 资金费。
        各交易所四舍五入可能带来 ±0.01 的显示差异。若复算不一致，优先核对数量单位（币 vs 张）与合约面值。
        ${coin ? `当前为币本位：表中主数字为 ${e(baseCcy)} 口径（按平仓价折算），灰色小字为 USD 口径。` : ''}
      </p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>交易复盘</h2>
        <div class="head-actions">
          ${aiReady
            ? `<button class="btn btn-ghost small" type="button" data-trade-ai="${trade.id}" title="使用 ${e(aiModel)} 生成复盘">AI 复盘</button>`
            : '<a class="btn btn-ghost small" href="/dashboard/settings/ai">配置 AI 模型</a>'}
          ${trade.note_updated_at ? `<span class="muted small">上次更新 ${e(fmtDateTime(trade.note_updated_at))}</span>` : ''}
        </div></div>
      <p class="muted small" data-trade-ai-status style="margin:0 0 8px">${aiReady ? `AI 会结合这笔交易与持仓期 K 线走势生成复盘，并直接填入下方笔记框，可编辑后再保存。` : '配置 AI 模型后，可一键生成这笔交易的复盘。'}</p>
      <div class="report-progress" data-trade-ai-progress hidden>
        <div class="report-progress-bar"><span></span></div>
      </div>
      ${trade.note ? `<div class="markdown" style="margin-bottom:16px">${renderMarkdown(trade.note)}</div>` : ''}
      <form method="post" action="/dashboard/journal/${trade.id}/note" class="form">
        <div class="md-toolbar">
          <label class="btn btn-ghost small"><span data-note-image-label>插入图片</span>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-note-image hidden>
          </label>
          <span class="muted small">图片上传后以 Markdown 插入光标处（PNG/JPEG/GIF/WebP，≤5MB）</span>
        </div>
        <label class="field wide"><span>这笔交易为什么开？执行了计划吗？错在哪 / 对在哪？（支持 Markdown）</span>
          <textarea name="note" rows="10" data-trade-note>${e(trade.note || '')}</textarea>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">保存复盘</button>
          <a class="btn btn-ghost" href="/dashboard/journal">返回列表</a>
        </div>
      </form>
    </section>`;

  return shell({
    active: 'journal', user, title: '交易详情',
    subtitle: `#${trade.id} · ${e(trade.symbol)} · 平仓于 ${e(fmtDateTime(trade.close_time))}`,
    notice, error, body,
  });
}

/** 垃圾箱：软删除的交易在这里集中管理；同步不会再导回，恢复或彻底删除二选一 */
export function journalTrashPage({ user, trades = [], total = 0, q = '', notice, error }) {
  const kw = String(q || '').trim();
  const count = kw
    ? `匹配 ${fmtNum(trades.length)} 条 / 共 ${fmtNum(total)} 条`
    : (total ? `${fmtNum(total)} 条` : '');
  const rows = trades.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.trashed_at))}</td>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td><b>${e(t.symbol)}</b><div class="muted small">${t.market === 'spot' ? '现货' : '合约'} · ${e(t.account_name || '—')}</div></td>
    <td><span class="side-tag ${t.side}">${e(tradeSideLabel(t))}</span></td>
    <td class="num ${sign(t.pnl)}">${fmtMoney(t.pnl)}</td>
    <td class="small muted">${e((t.note || '').replace(/\s+/g, ' ').slice(0, 40))}${t.note && t.note.length > 40 ? '…' : ''}</td>
    <td class="row-actions">
      <form method="post" action="/dashboard/journal/${t.id}/restore" class="inline">
        <button class="btn btn-ghost small" type="submit">恢复</button>
      </form>
      <form method="post" action="/dashboard/journal/${t.id}/delete" class="inline">
        <button class="btn btn-ghost small danger" type="submit"
          data-confirm="彻底删除后无法恢复。若交易所侧仍有这条记录，下次同步会重新导入。确定删除？">彻底删除</button>
      </form>
    </td>
  </tr>`).join('');

  return shell({
    active: 'journal', user,
    title: '交易垃圾箱',
    subtitle: '误操作或不需要的记录先扔到这里：不参与统计，交易所同步也不会再导回',
    notice, error,
    body: `
    <div class="page-actions">
      <a class="btn btn-ghost small" href="/dashboard/journal">← 返回交易记录</a>
    </div>
    <section class="panel">
      <div class="panel-head"><h2>垃圾箱</h2>
        <span class="muted small">${count}</span></div>
      ${(total || kw) ? `<form method="get" action="/dashboard/journal/trash" class="filter-bar">
        <input name="q" value="${e(kw)}" placeholder="搜索币种 / 备注 / 账户">
        <button class="btn btn-primary small" type="submit">搜索</button>
        ${kw ? '<a class="btn btn-ghost small" href="/dashboard/journal/trash">清除</a>' : ''}
      </form>` : ''}
      ${trades.length ? `<div class="table-wrap">
      <table class="table">
        <thead><tr><th>扔入时间</th><th>平仓时间</th><th>交易对</th><th>方向</th><th class="num">净盈亏</th><th>备注</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      <p class="chart-note">「恢复」把记录原样放回交易记录（标签与笔记一起回来）；「彻底删除」从数据库移除——
      若交易所侧仍有这条数据，下次同步会重新导入，届时可再扔进垃圾箱。
      另注意：现货和客户端配对的合约记录由成交重算得出，若之后的同步改变了配对结构
      （例如先前的卖出被买回、闭环成一个做T回合），可能生成一条新记录——再扔一次即可，之后不会再出现。</p>`
        : `<div class="muted center" style="padding:20px 0">${kw ? `没有匹配「${e(kw)}」的记录。` : '垃圾箱是空的。'}</div>`}
    </section>`,
  });
}
