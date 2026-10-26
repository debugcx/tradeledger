import { escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDuration } from '../http.js';
import { shell, settingsNav } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

function quickTagsSection(tags = [], quickTags = null) {
  const selected = new Set(quickTags || []);
  const boxes = (tags || []).map((t) => `<label class="tag-check">
      <input type="checkbox" name="tags" value="${e(t.name)}" ${selected.has(t.name) ? 'checked' : ''}>
      <span class="tag-pill">${e(t.name)}</span>
      <span class="muted small">${fmtNum(t.count)} 笔</span>
    </label>`).join('');
  return `<section class="panel" id="quick-tags">
    <div class="panel-head"><h2>快捷标签</h2>
      <span class="muted small">勾选后会显示在仪表盘「优先复盘」的行内按钮</span></div>
    <form method="post" action="/dashboard/tags/quick-tags" class="form">
      <div class="tag-picker">${boxes || '<span class="muted small">还没有标签，在下方输入即可新建</span>'}</div>
      <label class="field wide" style="margin-top:14px"><span>新增标签</span>
        <input name="new_tags" maxlength="300" placeholder="逗号分隔，例如：试单, 追单（新增后会自动加入快捷标签）"></label>
      <p class="muted small">最多 12 个。全部不勾选时恢复自动模式（显示最常用的 6 个）。</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">保存快捷标签</button></div>
    </form>
  </section>`;
}

export function tagsPage({ user, tags, tagsWithCounts = [], quickTags = null, stats, error, notice = '' }) {
  const maxAbs = Math.max(1, ...stats.tagStats.map((t) => Math.abs(t.expectancy)));
  const rows = stats.tagStats.length ? stats.tagStats.map((t) => {
    const width = (Math.abs(t.expectancy) / maxAbs) * 100;
    return `<tr>
      <td><a class="tag-pill" href="/dashboard/journal?tag=${encodeURIComponent(t.tag)}">${e(t.tag)}</a></td>
      <td>${fmtNum(t.count)}</td>
      <td class="${sign(t.pnl)}">${fmtMoney(t.pnl)}</td>
      <td>${fmtPct(t.winRate)}</td>
      <td>${fmtMoney(t.avgWin)}</td>
      <td>${fmtMoney(-t.avgLoss, { sign: false })}</td>
      <td>${e(fmtDuration(t.avgDuration))}</td>
      <td class="${sign(t.expectancy)}">${fmtMoney(t.expectancy)}
        <div class="mini-bar"><span style="width:${width.toFixed(1)}%;background:${t.expectancy >= 0 ? '#4ade80' : '#ff6b57'}"></span></div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="8" class="muted center">还没有标签数据。给交易打上标签后，这里会按标签统计表现。</td></tr>';

  const body = `
    ${settingsNav('tags')}
    <section class="panel">
      <div class="panel-head"><h2>新建标签</h2></div>
      ${error ? `<div class="alert alert-error">${e(error)}</div>` : ''}
      <form method="post" action="/dashboard/tags" class="filter-bar">
        <input name="name" required maxlength="40" placeholder="标签名称，例如：突破">
        <span class="muted small">颜色</span>
        <input name="color" type="color" value="#4ade80" title="颜色">
        <button class="btn btn-primary small" type="submit">添加</button>
      </form>
    </section>
    ${quickTagsSection(tagsWithCounts, quickTags)}
    <section class="panel">
      <div class="panel-head"><h2>标签表现</h2>
        <span class="muted small">按交易预期排序；条形长度 = 预期绝对值</span></div>
      <table class="table">
        <thead><tr><th>标签</th><th>笔数</th><th>总盈亏</th><th>胜率</th><th>平均盈利</th><th>平均亏损</th><th>平均持仓</th><th>交易预期</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>全部标签</h2></div>
      <div class="tag-row">
        ${tags.map((t) => `<span class="tag-pill" style="border-color:${e(t.color)}">${e(t.name)}
          <form method="post" action="/dashboard/tags/delete" class="inline"
            onsubmit='return confirm(${e(JSON.stringify(`删除标签「${t.name}」？交易记录不会被删除。`))})'>
            <input type="hidden" name="id" value="${t.id}">
            <button class="tag-del" type="submit" title="删除">×</button>
          </form></span>`).join('') || '<span class="muted">还没有标签</span>'}
      </div>
    </section>`;

  return shell({ active: 'tags', user, title: '标签', subtitle: '用标签回答：哪类交易在赚钱，哪类在送钱', notice, body });
}
