import { escapeHtml as e, fmtDateTime, fmtMoney, fmtNum } from '../http.js';
import { renderMarkdown } from '../markdown.js';
import { shell } from './layout.js';

const CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'periodic', label: '周期复盘' },
  { key: 'symbol', label: '交易对档案' },
  { key: 'strategy', label: '策略手册' },
  { key: 'spot', label: '现货备注' },
  { key: 'ai-report', label: 'AI 解读' },
  { key: 'general', label: '自由笔记' },
];

const LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

const DESCRIPTIONS = {
  all: '所有复盘笔记；交易对档案和现货备注也会汇总到这里',
  periodic: '按周 / 月 / 季度回看，不绑定单笔交易',
  symbol: '每个交易对一篇长期档案，自动汇总这个交易对上的逐笔复盘',
  strategy: '把可复用的入场、加仓、离场规则写下来',
  spot: '现货持仓逻辑、目标价与止盈止损；在现货页可以直接编辑',
  'ai-report': 'AI 生成的周期报告解读；在周期报告页一键写入，也可继续编辑',
  general: '不属于以上分类的随手记录',
};

function tabs(active, counts, q = '') {
  const suffix = q ? `&q=${encodeURIComponent(q)}` : '';
  return `<div class="notes-tabs">
    ${CATEGORIES.map((c) => `<a href="/dashboard/notes?category=${c.key}${suffix}" class="${c.key === active ? 'active' : ''}">${e(c.label)}${counts[c.key] ? ` <span class="muted">${counts[c.key]}</span>` : ''}</a>`).join('')}
  </div>`;
}

function notePager(category, q, pagination) {
  const { page, totalPages, total, pageSize } = pagination;
  if (!totalPages || totalPages <= 1) return '';
  const link = (n, label, cls = '') => {
    const p = new URLSearchParams();
    if (category !== 'all') p.set('category', category);
    if (q) p.set('q', q);
    if (n > 1) p.set('page', String(n));
    const s = p.toString();
    return `<a class="pager-item ${cls}" href="/dashboard/notes${s ? `?${s}` : ''}">${label}</a>`;
  };
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  const nums = [...new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages))];
  const items = nums.sort((a, b) => a - b).flatMap((n, i, arr) => {
    const prev = arr[i - 1];
    const els = [];
    if (prev && n - prev > 1) els.push('<span class="pager-dots">…</span>');
    els.push(link(n, String(n), n === page ? 'active' : ''));
    return els;
  }).join('');
  return `<div class="pager">
    <span class="muted small">第 ${fmtNum(first)}–${fmtNum(last)} 篇 / 共 ${fmtNum(total)} 篇</span>
    <div class="pager-links">
      ${page > 1 ? link(page - 1, '上一页') : '<span class="pager-item disabled">上一页</span>'}
      ${items}
      ${page < totalPages ? link(page + 1, '下一页') : '<span class="pager-item disabled">下一页</span>'}
    </div>
  </div>`;
}

function categoryBadge(category) {
  const key = LABELS[category] ? category : 'general';
  return `<span class="note-badge note-badge-${key}">${e(LABELS[key])}</span>`;
}

function noteCard(n) {
  const rendered = renderMarkdown(n.content);
  return `<article class="note-card">
    <div class="note-card-top">${categoryBadge(n.category)}${n.subject ? `<span class="note-subject">${e(n.subject)}</span>` : ''}</div>
    <h3><a href="/dashboard/notes/${n.id}">${e(n.title)}</a></h3>
    <div class="muted small">更新于 ${e(fmtDateTime(n.updated_at))}${n.account_name ? ` · ${e(n.account_name)}` : ''}</div>
    <div class="note-card-body markdown">${rendered || '<p class="muted">（空）</p>'}</div>
  </article>`;
}

function newHref(category, currentWeek) {
  if (category === 'periodic') return `/dashboard/notes/new?category=periodic&subject=${encodeURIComponent(currentWeek || '')}`;
  if (category === 'spot') return '/dashboard/spot';
  return `/dashboard/notes/new?category=${category === 'all' ? 'general' : category}`;
}

export function notesPage({ user, notes, counts, category = 'all', q = '', pagination = null, symbolTradeNotes = [], recentTradeNotes = [], currentWeek = '', notice, error }) {
  const searching = Boolean(q);
  const symbolNotes = searching ? [] : notes.filter((n) => n.category === 'symbol');
  const archiveSymbols = new Set(symbolNotes.map((n) => n.subject));
  const gaps = symbolTradeNotes.filter((s) => !archiveSymbols.has(s.symbol));

  let content = '';
  let pagerHtml = '';
  if (searching) {
    const cards = notes.map(noteCard).join('');
    content = cards
      ? `<div class="notes-grid">${cards}</div>`
      : `<div class="panel muted center">没有匹配「${e(q)}」的笔记。换个关键词，或<a href="/dashboard/notes">清除搜索</a>。</div>`;
    pagerHtml = pagination ? notePager(category, q, pagination) : '';
  } else if (category === 'symbol') {
    const archiveCards = symbolNotes.map((n) => `<article class="note-card">
      <div class="note-card-top">${categoryBadge('symbol')}<span class="note-subject">${e(n.subject || '')}</span></div>
      <h3><a href="/dashboard/notes/symbol/${encodeURIComponent(n.subject || '')}">${e(n.title)}</a></h3>
      <div class="muted small">更新于 ${e(fmtDateTime(n.updated_at))}</div>
      <div class="note-card-body markdown">${renderMarkdown(n.content) || '<p class="muted">（空）</p>'}</div>
    </article>`).join('');
    const gapCards = gaps.map((s) => `<article class="note-card note-card-gap">
      <div class="note-card-top"><span class="note-badge">待建档</span><span class="note-subject">${e(s.symbol)}</span></div>
      <h3><a href="/dashboard/notes/symbol/${encodeURIComponent(s.symbol)}">${e(s.symbol)}</a></h3>
      <div class="muted small">已有 ${s.count} 条逐笔复盘 · 最近 ${e(fmtDateTime(s.last_time))}</div>
      <p class="note-excerpt">这个交易对还没有长期档案。把反复出现的判断、失效条件和执行问题整理成一篇。</p>
      <a class="btn btn-ghost small" href="/dashboard/notes/new?category=symbol&subject=${encodeURIComponent(s.symbol)}">建立档案</a>
    </article>`).join('');

    const recentRows = recentTradeNotes.map((t) => `<tr>
      <td class="small">${e(fmtDateTime(t.close_time))}</td>
      <td><b>${e(t.symbol)}</b><div class="muted small">${t.market === 'spot' ? '现货' : '合约'}</div></td>
      <td><span class="side-tag ${t.side}">${t.side === 'long' ? '多' : '空'}</span></td>
      <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${fmtMoney(t.pnl)}</td>
      <td>${e(t.note || '')}</td>
      <td><a class="btn btn-ghost small" href="/dashboard/journal/${t.id}">查看交易</a></td>
    </tr>`).join('');
    const recentTable = recentRows ? `<section class="panel" style="margin-top:18px">
      <div class="panel-head"><h2>最近的逐笔复盘</h2>
        <span class="muted small">来自交易记录里的行内备注，按交易对自动归档</span></div>
      <table class="table">
        <thead><tr><th>平仓时间</th><th>交易对</th><th>方向</th><th>盈亏</th><th>当时写的复盘</th><th></th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </section>` : '';

    if (!archiveCards && !gapCards) {
      content = `<div class="panel muted center">还没有交易对档案。先在交易记录里写几条复盘，或直接新建一篇档案。</div>`;
    } else {
      content = `<div class="notes-grid">${archiveCards}${gapCards}</div>${recentTable}`;
    }
  } else {
    const cards = notes.map(noteCard).join('');
    content = cards
      ? `<div class="notes-grid">${cards}</div>`
      : `<div class="panel muted center">${e(DESCRIPTIONS[category] || '还没有笔记。')} 点右上角新建一篇。</div>`;
    pagerHtml = pagination ? notePager(category, q, pagination) : '';
  }

  const body = `
    ${tabs(category, counts, q)}
    <div class="notes-toolbar">
      <form method="get" action="/dashboard/notes" class="notes-search" role="search">
        <input type="hidden" name="category" value="${e(category)}">
        <input name="q" value="${e(q)}" placeholder="搜索标题、内容、交易对" maxlength="100" aria-label="搜索笔记">
        <button class="btn btn-primary small" type="submit">搜索</button>
        ${searching ? `<a class="btn btn-ghost small" href="/dashboard/notes?category=${e(category)}">清除</a>` : ''}
      </form>
      <div class="page-actions">
        <a class="btn btn-primary" href="${newHref(category, currentWeek)}">${category === 'spot' ? '去现货页写备注' : category === 'symbol' ? '+ 新建交易对档案' : category === 'periodic' ? '+ 新建本周复盘' : '+ 新建笔记'}</a>
      </div>
    </div>
    <p class="chart-note" style="margin:-6px 0 14px">${searching ? `搜索「${e(q)}」· 找到 ${fmtNum(pagination?.total ?? notes.length)} 篇` : e(DESCRIPTIONS[category] || '')}</p>
    ${content}
    ${pagerHtml}`;

  return shell({
    active: 'notes', user, title: '笔记',
    subtitle: '周期复盘、交易对档案、策略手册与现货备注，支持 Markdown 与图片',
    notice, error, body,
  });
}

export function noteViewPage({ user, note, tradeNotes = [], notice, error }) {
  const isSymbol = note.category === 'symbol';
  const tradeRows = tradeNotes.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '多' : '空'}</span>
      <span class="muted small">${t.market === 'spot' ? '现货' : '合约'}</span></td>
    <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${fmtMoney(t.pnl)}</td>
    <td>${e(t.note || '')}</td>
    <td><a class="btn btn-ghost small" href="/dashboard/journal/${t.id}">查看交易</a></td>
  </tr>`).join('');

  const symbolPanel = isSymbol ? `<section class="panel">
    <div class="panel-head"><h2>这个交易对的逐笔复盘</h2>
      <span class="muted small">${tradeNotes.length} 条</span></div>
    ${tradeRows ? `<table class="table">
      <thead><tr><th>平仓时间</th><th>方向</th><th>盈亏</th><th>当时写的复盘</th><th></th></tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>` : '<p class="muted small">还没有逐笔复盘。在交易记录里写下的备注会自动出现在这里。</p>'}
  </section>` : '';

  return shell({
    active: 'notes', user,
    title: note.title,
    subtitle: `${e(LABELS[note.category] || '笔记')}${note.subject ? ` · ${e(note.subject)}` : ''} · 更新于 ${e(fmtDateTime(note.updated_at))}`,
    notice, error,
    body: `<section class="panel">
      <div class="panel-head">
        <h2>${e(note.title)}</h2>
        <div class="head-actions">
          ${isSymbol ? `<a class="btn btn-ghost small" href="/dashboard/journal?symbol=${encodeURIComponent(note.subject || '')}">查看交易记录</a>` : ''}
          ${note.category === 'spot' ? '<a class="btn btn-ghost small" href="/dashboard/spot">去现货页</a>' : ''}
          <a class="btn btn-ghost small" href="/dashboard/notes/${note.id}/edit">编辑</a>
          <form method="post" action="/dashboard/notes/delete" class="inline"
            onsubmit="return confirm('确定删除这篇笔记吗？')">
            <input type="hidden" name="id" value="${note.id}">
            <button class="btn btn-ghost small danger" type="submit">删除</button>
          </form>
        </div>
      </div>
      <div class="note-meta">${categoryBadge(note.category)}${note.subject ? `<span class="note-subject">${e(note.subject)}</span>` : ''}${note.account_name ? `<span class="muted small">${e(note.account_name)}</span>` : ''}</div>
      <div class="markdown">${renderMarkdown(note.content) || '<p class="muted">这篇笔记还是空的。</p>'}</div>
    </section>
    ${symbolPanel}`,
  });
}

export function symbolNotePage({ user, symbol, note, tradeNotes = [], notice, error }) {
  const tradeRows = tradeNotes.map((t) => `<tr>
    <td class="small">${e(fmtDateTime(t.close_time))}</td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '多' : '空'}</span>
      <span class="muted small">${t.market === 'spot' ? '现货' : '合约'}</span></td>
    <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${fmtMoney(t.pnl)}</td>
    <td>${e(t.note || '')}</td>
    <td><a class="btn btn-ghost small" href="/dashboard/journal/${t.id}">查看交易</a></td>
  </tr>`).join('');

  const hasSpot = tradeNotes.some((t) => t.market === 'spot');
  const hasFutures = tradeNotes.some((t) => t.market !== 'spot');

  return shell({
    active: 'notes', user, title: `${symbol} 交易对档案`,
    subtitle: '长期档案 + 这个交易对上的逐笔复盘（合约与现货）',
    notice, error,
    body: `<div class="page-actions">
      <a class="btn btn-ghost small" href="/dashboard/notes?category=symbol">← 返回交易对档案</a>
      <a class="btn btn-ghost small" href="/dashboard/journal?symbol=${encodeURIComponent(symbol)}">查看交易记录</a>
      <a class="btn btn-ghost small" href="/dashboard/spot/symbol/${encodeURIComponent(symbol)}">现货详情</a>
    </div>
    <section class="panel">
      <div class="panel-head"><h2>长期档案</h2>
        <div class="head-actions">
          ${note
            ? `<a class="btn btn-ghost small" href="/dashboard/notes/${note.id}/edit">编辑档案</a>`
            : `<a class="btn btn-primary small" href="/dashboard/notes/new?category=symbol&subject=${encodeURIComponent(symbol)}">建立档案</a>`}
        </div>
      </div>
      ${note
        ? `<div class="markdown">${renderMarkdown(note.content) || '<p class="muted">档案还是空的。</p>'}</div>`
        : '<p class="muted small">还没有这个交易对的长期档案。把它的结构、有效条件、失效条件和执行问题写下来。</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>逐笔复盘</h2><span class="muted small">${tradeNotes.length} 条</span></div>
      ${tradeRows ? `<table class="table">
        <thead><tr><th>平仓时间</th><th>方向</th><th>盈亏</th><th>当时写的复盘</th><th></th></tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>` : '<p class="muted small">还没有逐笔复盘。在交易记录里给单笔交易写备注后会汇总到这里。</p>'}
      ${hasSpot && hasFutures ? '<p class="muted small">上面同时包含这个交易对的合约与现货复盘；也可以到<a href="/dashboard/spot/symbol/' + encodeURIComponent(symbol) + '">现货详情</a>查看现货成交与充提。</p>' : ''}
    </section>`,
  });
}

export function noteEditPage({ user, note, category = 'general', subject = '', symbols = [], holding = null, error }) {
  const isNew = !note;
  const current = note?.category || category || 'general';
  const isSpot = current === 'spot';
  const options = CATEGORIES.filter((c) => c.key !== 'all' && c.key !== 'spot');
  const backHref = isSpot && holding
    ? `/dashboard/spot/symbol/${encodeURIComponent(note?.subject || subject || '')}`
    : `/dashboard/notes${isSpot ? '?category=spot' : current === 'symbol' ? '?category=symbol' : ''}`;

  const holdingPanel = isSpot && holding ? `<section class="panel">
      <div class="panel-head"><h2>当前持仓</h2>
        <span class="muted small">实时数据，仅供写作时参考</span></div>
      <div class="mini-strip">
        <div class="mini-stat"><span>交易对</span><b class="small">${e(holding.symbol)}</b></div>
        <div class="mini-stat"><span>账户</span><b class="small">${e(holding.account_name || '—')}</b></div>
        <div class="mini-stat"><span>持仓数量</span><b>${fmtNum(holding.quantity, 8)}</b></div>
        <div class="mini-stat"><span>平均成本</span><b class="small">${holding.avg_cost === null || holding.avg_cost === undefined ? '—' : fmtNum(holding.avg_cost, 6)}</b></div>
        <div class="mini-stat"><span>当前价</span><b class="small">${holding.price === null || holding.price === undefined ? '—' : fmtNum(holding.price, 6)}</b></div>
        <div class="mini-stat"><span>市值</span><b class="small">${holding.value === null || holding.value === undefined ? '—' : fmtNum(holding.value, 2)}</b></div>
      </div>
    </section>` : '';

  return shell({
    active: 'notes', user,
    title: isNew ? '新建笔记' : '编辑笔记',
    subtitle: isNew ? '选一个分类，长期积累会自己长出结构' : `创建于 ${e(fmtDateTime(note.created_at))}`,
    error,
    body: `${holdingPanel}<section class="panel">
      <form method="post" action="/dashboard/notes/save" class="form">
        <input type="hidden" name="id" value="${note?.id || ''}">
        <input type="hidden" name="account_id" value="${note?.account_id || ''}">
        <input type="hidden" name="market" value="${note?.market || ''}">
        ${isSpot && holding ? '<input type="hidden" name="return_to" value="spot">' : ''}
        ${isSpot ? '<input type="hidden" name="category" value="spot">' : ''}
        <div class="grid-form">
          ${isSpot ? `<div class="field wide"><span>分类</span><b>现货备注</b>
            <div class="muted small">${holding ? `绑定 ${e(holding.account_name)} 的 ${e(holding.symbol)} 持仓` : '现货备注绑定账户与交易对'}</div></div>` : `<label class="field"><span>分类</span>
            <select name="category">
              ${options.map((c) => `<option value="${c.key}" ${current === c.key ? 'selected' : ''}>${e(c.label)}</option>`).join('')}
            </select>
          </label>`}
          <label class="field"><span>关联对象（可选）</span>
            <input name="subject" list="note-symbols" maxlength="120" value="${e(note?.subject || subject || '')}"
              placeholder="BTC/USDT、突破回踩、2026-W42">
            <div class="muted small">交易对档案每个交易对只保留一篇；策略和周期可以同名多篇。</div>
          </label>
        </div>
        <datalist id="note-symbols">${symbols.map((s) => `<option value="${e(s)}"></option>`).join('')}</datalist>
        <label class="field"><span>标题</span>
          <input name="title" maxlength="200" value="${e(note?.title || '')}" placeholder="例如：BTC/USDT 交易对档案 / 第 42 周复盘 / 突破回踩策略">
        </label>
        <div class="md-toolbar">
          <label class="btn btn-ghost small"><span data-note-image-label>插入图片</span>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-note-image hidden>
          </label>
          <button class="btn btn-ghost small" type="button" data-md-preview>预览</button>
          <span class="muted small">支持标题、列表、粗体、链接、图片；也兼容外部图片 URL</span>
        </div>
        <div class="markdown md-preview" data-md-preview-box hidden></div>
        <label class="field"><span>内容（Markdown）</span>
          <textarea id="note-content" name="content" rows="18" placeholder="# 本周复盘&#10;&#10;- 做对了什么&#10;- 做错了什么&#10;&#10;![截图](/media/...)">${e(note?.content || '')}</textarea>
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">保存</button>
          <a class="btn btn-ghost" href="${backHref}">返回</a>
        </div>
      </form>
      ${!isNew ? `<form method="post" action="/dashboard/notes/delete" class="form-delete"
        onsubmit="return confirm('确定删除这篇笔记吗？')">
        <input type="hidden" name="id" value="${note.id}">
        <button class="btn btn-ghost danger" type="submit">删除这篇笔记</button>
      </form>` : ''}
    </section>`,
  });
}
