import { escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDateTime } from '../http.js';
import { renderMarkdown } from '../markdown.js';
import { shell } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;

function listSection(title, rows, render, empty = '本周期样本不足。') {
  return `<section class="panel">
    <div class="panel-head"><h2>${e(title)}</h2></div>
    ${rows.length ? `<ul class="review-list">${rows.map((r) => `<li>${render(r)}</li>`).join('')}</ul>`
      : `<p class="muted small">${e(empty)}</p>`}
  </section>`;
}

export function reportPage({
  user, review, prev, next, markdownPreview, promptText,
  savedReport = null, history = [], aiStatus = null, notice, error,
}) {
  const kind = review.period.kind;
  const kindLabel = review.period.kindLabel;
  const s = review.stats;

  const queryOf = (p) => {
    if (p.kind === 'month') return `kind=month&month=${p.label}`;
    if (p.kind === 'year') return `kind=year&year=${p.label}`;
    return `kind=week&week=${p.label}`;
  };

  const periodLabelInput = kind === 'week'
    ? `<input type="week" name="week" value="${e(review.period.label)}">`
    : kind === 'month'
      ? `<input type="month" name="month" value="${e(review.period.label)}">`
      : `<input type="number" name="year" min="2000" max="2100" value="${e(review.period.label)}" style="width:110px">`;

  const modelReady = aiStatus && (aiStatus.hasKey || aiStatus.provider === 'ollama');
  const aiPanel = `<section class="panel" id="ai-report">
    <div class="panel-head"><h2>AI 生成报告解读</h2>
      <span class="muted small">${aiStatus
        ? (modelReady ? `模型：${e(aiStatus.modelLabel)}` : '未配置 API Key')
        : '未配置模型'}</span></div>
    ${aiStatus && !modelReady ? `<div class="alert alert-info">还没有配置 API Key。到 <a href="/dashboard/settings/ai">设置与数据 → AI 模型</a> 配置后就能一键生成。</div>` : ''}
    <form method="post" action="/dashboard/review/ai" class="form" id="report-ai-form">
      <input type="hidden" name="kind" value="${e(kind)}">
      ${kind === 'week' ? `<input type="hidden" name="week" value="${e(review.period.label)}">` : ''}
      ${kind === 'month' ? `<input type="hidden" name="month" value="${e(review.period.label)}">` : ''}
      ${kind === 'year' ? `<input type="hidden" name="year" value="${e(review.period.label)}">` : ''}
      <label class="field wide"><span>提示词（已按报告数据生成，可手工编辑后再生成）</span>
        <textarea id="report-prompt" name="prompt" rows="12">${e(promptText)}</textarea>
      </label>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" data-report-generate ${modelReady ? '' : 'disabled'}>调用 AI 生成解读</button>
        <span class="muted small" data-report-status>提示词包含完整报告数据；生成在后台进行，可离开页面</span>
        <a class="btn btn-ghost small" href="/dashboard/review/ai-reports">AI 报告专页</a>
      </div>
      <div class="report-progress" data-report-progress hidden>
        <div class="report-progress-bar"><span></span></div>
        <div class="muted small" data-report-progress-text>已提交，等待模型返回…</div>
      </div>
    </form>
    <div class="ai-result markdown" data-report-result>${savedReport ? renderMarkdown(savedReport.content) : ''}</div>
    ${savedReport ? `<div class="form-actions">
      <a class="btn btn-primary small" href="/dashboard/review/ai-reports?id=${savedReport.id}">在 AI 报告专页打开</a>
      <form method="post" action="/dashboard/review/ai/save-note" class="inline">
        <input type="hidden" name="report_id" value="${savedReport.id}">
        <button class="btn btn-ghost small" type="submit">写入笔记</button>
      </form>
    </div>` : ''}
    ${history.length ? `<details style="margin-top:14px">
      <summary class="muted small" style="cursor:pointer">这个周期的历史生成（${history.length}）</summary>
      <table class="table" style="margin-top:8px">
        <thead><tr><th>时间</th><th>模型</th><th>交易数</th><th>大小</th><th></th></tr></thead>
        <tbody>${history.map((h) => `<tr>
          <td class="small">${e(fmtDateTime(h.created_at))}</td>
          <td class="small muted">${e(h.model || '—')}</td>
          <td>${fmtNum(h.trades)}</td>
          <td class="small muted">${fmtNum(h.content_len)} 字</td>
          <td class="row-actions">
            <a class="btn btn-ghost small" href="/dashboard/review/history/${h.id}">查看</a>
            <form method="post" action="/dashboard/review/history/delete" class="inline" onsubmit="return confirm('删除这条生成记录？')">
              <input type="hidden" name="id" value="${h.id}">
              <button class="btn btn-ghost small danger" type="submit">删除</button>
            </form>
          </td>
        </tr>`).join('')}</tbody>
      </table>
    </details>` : ''}
  </section>`;

  const body = `
    <a class="ai-reports-banner" href="/dashboard/review/ai-reports">
      <div>
        <b>AI 报告专页</b>
        <span class="muted small">查看所有周期的 AI 解读 · 一键写入笔记</span>
      </div>
      <span class="ai-reports-banner-arrow">→</span>
    </a>
    <section class="panel">
      <div class="panel-head">
        <h2>选择周期</h2>
        <div class="head-actions">
          <div class="report-kind-tabs">
            <a href="/dashboard/review?kind=week" class="${kind === 'week' ? 'active' : ''}">周报</a>
            <a href="/dashboard/review?kind=month" class="${kind === 'month' ? 'active' : ''}">月报</a>
            <a href="/dashboard/review?kind=year" class="${kind === 'year' ? 'active' : ''}">年报</a>
          </div>
          <form method="get" action="/dashboard/review" class="week-picker">
            <input type="hidden" name="kind" value="${e(kind)}">
            ${periodLabelInput}
            <button class="btn btn-primary small" type="submit">查看</button>
          </form>
        </div>
      </div>
      <div class="head-actions">
        <a class="btn btn-ghost small" href="/dashboard/review?${queryOf(prev)}">← 上一个周期</a>
        <a class="btn btn-ghost small" href="/dashboard/review?${queryOf(next)}">下一个周期 →</a>
        <a class="btn btn-ghost small" href="/api/review?${queryOf(review.period)}&format=md">下载 Markdown</a>
        <a class="btn btn-ghost small" href="/api/review?${queryOf(review.period)}&format=json">下载 JSON</a>
        <button class="btn btn-ghost small" type="button" data-copy-review="${e(review.period.label)}">复制 Markdown</button>
        <a class="btn btn-ghost small" href="#ai-report">AI 解读 ↓</a>
      </div>
      <p class="muted small" style="margin:12px 0 0">区间：${e(review.period.from.slice(0, 10))} → ${e(review.period.to.slice(0, 10))}（服务端本地时区）</p>
    </section>

    <section class="panel review-headline">
      <div class="panel-head"><h2>${e(review.period.label)} ${e(kindLabel)}</h2></div>
      <p class="review-headline-text">${e(review.headline)}</p>
      <div class="mini-strip" style="margin:0">
        <div class="mini-stat"><span>净盈亏</span><b class="${sign(s.totalPnl)}">${fmtMoney(s.totalPnl)}</b></div>
        <div class="mini-stat"><span>胜率</span><b>${fmtPct(s.winRate)}</b><div class="muted small">${s.wins} 盈 / ${s.losses} 亏</div></div>
        <div class="mini-stat"><span>交易预期</span><b class="${sign(s.expectancy)}">${fmtMoney(s.expectancy)}</b></div>
        <div class="mini-stat"><span>最大回撤</span><b class="neg">${fmtMoney(s.maxDrawdown, { sign: false })}</b></div>
        <div class="mini-stat"><span>最大连亏</span><b class="${s.maxConsecutiveLoss >= 3 ? 'neg' : ''}">${s.maxConsecutiveLoss} 笔</b></div>
        <div class="mini-stat"><span>复盘覆盖率</span><b>${pct(s.noteCoverage.ratio)}</b></div>
        <div class="mini-stat"><span>对账不一致</span><b class="${s.reconciliations.mismatches ? 'neg' : 'pos'}">${fmtNum(s.reconciliations.mismatches)}</b></div>
      </div>
    </section>

    ${listSection('最亏的 3 个时段', review.worstSlots,
      (x) => `<b>${e(x.label)}</b>：<span class="neg">${fmtMoney(x.pnl)}</span> · ${x.trades} 笔 · 胜率 ${fmtPct(x.winRate)}`)}
    ${listSection('交易预期最差的标签', review.worstTags,
      (x) => `<b>${e(x.tag)}</b>：预期 <span class="${sign(x.expectancy)}">${fmtMoney(x.expectancy)}</span> · ${x.count} 笔 · 总盈亏 ${fmtMoney(x.pnl)}`)}
    ${listSection('最亏的币种', review.worstSymbols,
      (x) => `<b>${e(x.symbol)}</b>：<span class="neg">${fmtMoney(x.pnl)}</span> · ${x.count} 笔`)}
    ${listSection('表现最好的 3 个时段', review.bestSlots,
      (x) => `<b>${e(x.label)}</b>：<span class="pos">${fmtMoney(x.pnl)}</span> · ${x.trades} 笔 · 胜率 ${fmtPct(x.winRate)}`)}
    ${listSection('交易预期最好的标签', review.bestTags,
      (x) => `<b>${e(x.tag)}</b>：预期 <span class="${sign(x.expectancy)}">${fmtMoney(x.expectancy)}</span> · ${x.count} 笔 · 总盈亏 ${fmtMoney(x.pnl)}`)}
    ${listSection('最赚的币种', review.bestSymbols,
      (x) => `<b>${e(x.symbol)}</b>：<span class="pos">${fmtMoney(x.pnl)}</span> · ${x.count} 笔`)}

    <section class="panel">
      <div class="panel-head"><h2>复盘笔记摘录</h2></div>
      ${review.notes.length ? `<ul class="review-list">
        ${review.notes.map((n) => `<li><b>${e(n.symbol)}</b>
          <span class="muted small">（${e(n.close_time.slice(0, 10))} · ${fmtMoney(n.pnl)}）</span>
          <div class="muted small" style="margin-top:3px">${e(n.note)}</div></li>`).join('')}
      </ul>` : `<p class="muted small">${e(kindLabel)}期间没有交易笔记。</p>`}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>建议追问</h2>
        <span class="muted small">让 AI 优先回答这些问题，或自己思考</span></div>
      ${review.questions.length ? `<ol class="review-questions">${review.questions.map((q) => `<li>${e(q)}</li>`).join('')}</ol>`
        : '<p class="muted small">样本不足，暂无建议。</p>'}
    </section>

    ${aiPanel}

    <section class="panel">
      <div class="panel-head"><h2>报告数据（Markdown）</h2>
        <span class="muted small">提示词与数据都在里面，也可以喂给任意模型</span></div>
      <details>
        <summary class="muted small" style="cursor:pointer">展开完整 Markdown</summary>
        <pre class="code review-context">${e(markdownPreview)}</pre>
      </details>
    </section>`;

  return shell({
    active: 'review', user, title: '周期报告',
    subtitle: '周报 / 月报 / 年报：不只记数字，把每个周期最该改的一件事找出来',
    notice, error, body,
  });
}

export function savedReportPage({ user, report, notice, error }) {
  const kindLabel = { week: '周', month: '月', year: '年' }[report.period_kind] || '';
  return shell({
    active: 'review', user, title: 'AI 报告存档',
    subtitle: `${e(report.period_label)} · 生成于 ${e(fmtDateTime(report.created_at))}${report.model ? ` · ${e(report.model)}` : ''}`,
    notice, error,
    body: `<div class="page-actions">
      <a class="btn btn-ghost small" href="/dashboard/review/ai-reports">← 返回 AI 报告</a>
      <a class="btn btn-ghost small" href="/dashboard/review?kind=${e(report.period_kind)}">查看${e(kindLabel)}报数据</a>
      <form method="post" action="/dashboard/review/ai/save-note" class="inline">
        <input type="hidden" name="report_id" value="${report.id}">
        <button class="btn btn-primary small" type="submit">写入笔记</button>
      </form>
      <form method="post" action="/dashboard/review/history/delete" class="inline" onsubmit="return confirm('删除这条生成记录？')">
        <input type="hidden" name="id" value="${report.id}">
        <button class="btn btn-ghost small danger" type="submit">删除</button>
      </form>
    </div>
    <div class="panel markdown">${renderMarkdown(report.content) || '<p class="muted">这份存档是空的。</p>'}</div>`,
  });
}

export function aiReportsPage({ user, generations, report = null, notice, error }) {
  const kindLabel = (k) => ({ week: '周', month: '月', year: '年' }[k] || k);
  const rows = generations.map((g) => `<tr>
    <td class="small">${e(fmtDateTime(g.created_at))}</td>
    <td class="small">${e(g.period_label)} <span class="muted">(${e(kindLabel(g.period_kind))}报)</span></td>
    <td class="small muted">${e(g.model || '—')}</td>
    <td>${fmtNum(g.trades)}</td>
    <td class="small muted">${fmtNum(g.content_len)} 字</td>
    <td class="row-actions">
      <a class="btn btn-ghost small" href="/dashboard/review/ai-reports?id=${g.id}">查看</a>
      <form method="post" action="/dashboard/review/ai/save-note" class="inline">
        <input type="hidden" name="report_id" value="${g.id}">
        <button class="btn btn-ghost small" type="submit" title="保存为笔记">写入笔记</button>
      </form>
      <form method="post" action="/dashboard/review/history/delete" class="inline" onsubmit="return confirm('删除这条生成记录？')">
        <input type="hidden" name="id" value="${g.id}">
        <button class="btn btn-ghost small danger" type="submit">删除</button>
      </form>
    </td>
  </tr>`).join('');

  return shell({
    active: 'review', user, title: 'AI 报告',
    subtitle: '所有周期的 AI 生成记录：查看、写入笔记、删除',
    notice, error,
    body: `
    <div class="page-actions"><a class="btn btn-ghost small" href="/dashboard/review">← 周期报告</a></div>
    ${report ? `<section class="panel">
      <div class="panel-head"><h2>${e(report.period_label)} 解读</h2>
        <div class="head-actions">
          <span class="muted small">${e(fmtDateTime(report.created_at))}${report.model ? ` · ${e(report.model)}` : ''}</span>
          <form method="post" action="/dashboard/review/ai/save-note" class="inline">
            <input type="hidden" name="report_id" value="${report.id}">
            <button class="btn btn-primary small" type="submit">写入笔记</button>
          </form>
        </div>
      </div>
      <div class="markdown">${renderMarkdown(report.content) || '<p class="muted">这份记录是空的。</p>'}</div>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>生成记录</h2><span class="muted small">${generations.length} 条</span></div>
      ${rows ? `<table class="table">
        <thead><tr><th>时间</th><th>周期</th><th>模型</th><th>交易数</th><th>大小</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<p class="muted small">还没有生成记录。到<a href="/dashboard/review">周期报告</a>页选一个周期，点「调用 AI 生成解读」。</p>'}
    </section>`,
  });
}
