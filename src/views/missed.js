import { escapeHtml as e, fmtMoney, fmtNum, fmtDateTime } from '../http.js';
import { shell } from './layout.js';

const STATUS_OPTIONS = [
  ['open', '观察中'],
  ['win', '方向对（做了会赚）'],
  ['lose', '方向错（做了会亏）'],
  ['expired', '过期（行情走完没给机会）'],
];

const STATUS_CLASS = { open: 'flat', win: 'pos', lose: 'neg', expired: 'muted' };

/**
 * 错过交易页：记录「观察过但没开仓」的机会，并自我判定做了会怎样。
 * 价值在于对照：反复「方向对但没做」说明执行有问题；「方向错没做」说明等待是对的。
 */
export function missedPage({ user, list, notice, error }) {
  const counted = list.filter((r) => r.status === 'win' || r.status === 'lose');
  const wins = counted.filter((r) => r.status === 'win').length;
  const verdict = counted.length
    ? `已判定 ${counted.length} 笔：方向对 ${wins} 笔（${((wins / counted.length) * 100).toFixed(0)}%）、方向错 ${counted.length - wins} 笔。`
    : '给每条记录标记「方向对 / 方向错」，积累一段时间就能看出：错过的是不是真的更好。';

  const rows = list.map((r) => `<tr>
    <td><b>${e(r.symbol)}</b><div class="muted small">${e(fmtDateTime(r.created_at))}</div></td>
    <td><span class="side-tag ${r.direction}">${r.direction === 'short' ? '做空' : '做多'}</span></td>
    <td class="num small">${r.entry_price != null ? e(Number(r.entry_price).toString()) : '—'}</td>
    <td class="num small">${r.stop_price != null ? e(Number(r.stop_price).toString()) : '—'}</td>
    <td class="num small">${r.target_price != null ? e(Number(r.target_price).toString()) : '—'}</td>
    <td class="num small">${r.rr != null ? `<b>${r.rr.toFixed(2)}R</b>` : '<span class="muted">—</span>'}</td>
    <td>
      <form method="post" action="/dashboard/missed/status" class="inline" data-autosubmit>
        <input type="hidden" name="id" value="${r.id}">
        <select name="status" aria-label="判定">
          ${STATUS_OPTIONS.map(([v, label]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </form>
    </td>
    <td class="small">${e(r.note || '')}</td>
    <td>
      <form method="post" action="/dashboard/missed/delete" class="inline"
        data-confirm="删除这条错过交易记录？">
        <input type="hidden" name="id" value="${r.id}">
        <button class="btn btn-ghost small" type="submit">删除</button>
      </form>
    </td>
  </tr>`).join('');

  return shell({
    active: 'missed',
    user,
    title: '错过交易',
    subtitle: '观察过但没开仓的机会：记录下来，和实盘对照，分清「错过」是纪律还是遗憾',
    actions: '',
    notice,
    error,
    body: `
    <section class="panel">
      <div class="panel-head"><h2>记一笔错过的机会</h2>
        <span class="muted small">价格都可以留空，先记方向和理由</span></div>
      <form method="post" action="/dashboard/missed/add" class="form grid-form">
        <label class="field"><span>币种</span><input name="symbol" required placeholder="BTC/USDT"></label>
        <label class="field"><span>如果做了：方向</span>
          <select name="direction">
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </label>
        <label class="field"><span>计划入场价</span><input name="entry_price" type="number" step="any"></label>
        <label class="field"><span>计划止损价</span><input name="stop_price" type="number" step="any"></label>
        <label class="field"><span>计划目标价</span><input name="target_price" type="number" step="any"></label>
        <label class="field wide"><span>为什么没做 / 当时的依据</span><textarea name="note" rows="2" placeholder="例：等回踩没等到；信号出现时在忙别的…"></textarea></label>
        <div class="form-actions wide">
          <button class="btn btn-primary" type="submit">记录</button>
        </div>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>记录</h2>
        <span class="muted small">${e(verdict)}</span></div>
      ${list.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>币种</th><th>假设方向</th><th class="num">入场</th><th class="num">止损</th><th class="num">目标</th><th class="num">假想盈亏比</th><th>判定</th><th>依据 / 没做的原因</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="muted">还没有记录。错过不丢人，忘了错过才可惜。</p>'}
    </section>`,
  });
}
