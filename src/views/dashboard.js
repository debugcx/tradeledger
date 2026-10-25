import { escapeHtml as e, fmtMoney, fmtNum, fmtPct, fmtDuration, fmtDateTime, fmtPrice } from '../http.js';
import { config } from '../config.js';
import { donut, lineChart, barChart, weekHourHeatmap, PALETTE } from '../charts.js';
import { shell } from './layout.js';

const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');

function kpiBar(s) {
  return `<section class="kpi-bar">
    <div class="kpi-cell">
      <div class="kpi-icon green">▤</div>
      <div><div class="kpi-label">总交易次数</div><div class="kpi-value">${fmtNum(s.total)}</div></div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon yellow">◔</div>
      <div><div class="kpi-label">胜率</div><div class="kpi-value">${fmtPct(s.winRate)}</div>
        <div class="kpi-sub"><span class="pos">${s.wins} 盈</span> <span class="neg">${s.losses} 亏</span></div></div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon blue">◷</div>
      <div><div class="kpi-label">平均持仓时长</div><div class="kpi-value">${e(fmtDuration(s.avgDuration))}</div></div>
    </div>
    <div class="kpi-cell kpi-ratios">
      <div class="ratio-line"><span class="muted">多单占比</span><span class="pos strong">${fmtPct(s.longs.ratio)} (${s.longs.count})</span></div>
      <div class="ratio-line"><span class="muted">空单占比</span><span class="neg strong">${fmtPct(s.shorts.ratio)} (${s.shorts.count})</span></div>
      <div class="ratio-bar">
        <span style="width:${(s.longs.ratio * 100).toFixed(2)}%;background:${PALETTE.green}"></span>
        <span style="width:${(s.shorts.ratio * 100).toFixed(2)}%;background:${PALETTE.red}"></span>
      </div>
    </div>
  </section>`;
}

/** 行为诊断：把「胜率 × 盈亏比 → 期望」的关系翻译成可执行的结论 */
function diagnosisPanel(s) {
  const b = s.behavior || {};
  const payoffOk = b.payoffRatio >= b.breakevenRatio;
  const pf = Number.isFinite(b.profitFactor) ? `${b.profitFactor.toFixed(2)}x` : '∞';
  const holdRatio = b.winDurationMs > 0 ? b.lossDurationMs / b.winDurationMs : 0;
  const verdict = s.expectancy >= 0
    ? `当前组合为正期望：每笔平均 ${fmtMoney(s.expectancy)}。`
    : `当前组合为负期望：每笔平均 ${fmtMoney(s.expectancy)}。`;
  const advice = payoffOk
    ? '盈亏比已越过保本线，保持并继续提高单笔质量。'
    : `${fmtPct(s.winRate, 1)} 的胜率需要盈亏比 ≥ ${b.breakevenRatio.toFixed(3)} 才能保本，实际只有 ${b.payoffRatio.toFixed(3)} —— 亏损单平均是盈利单的 ${(1 / Math.max(b.payoffRatio, 1e-9)).toFixed(1)} 倍，优先解决「亏大钱」而不是继续提高胜率。`;
  return `<section class="panel">
    <div class="panel-head"><h2>行为诊断</h2>
      <span class="muted small">胜率本身不决定盈亏，胜率 × 盈亏比才是</span></div>
    <div class="grid-4">
      <div class="mini-stat"><span>盈亏比（均盈 / 均亏）</span><b class="${payoffOk ? 'pos' : 'neg'}">${b.payoffRatio.toFixed(3)}</b>
        <div class="muted small">保本线 ${b.breakevenRatio.toFixed(3)}（由 ${fmtPct(s.winRate, 1)} 胜率决定）</div></div>
      <div class="mini-stat"><span>利润因子</span><b class="${b.profitFactor >= 1 ? 'pos' : 'neg'}">${pf}</b>
        <div class="muted small">总盈利 ÷ 总亏损，大于 1 才赚钱</div></div>
      <div class="mini-stat"><span>最差 5% 的亏损</span><b class="neg">${fmtMoney(-b.bigLossSum, { sign: false })}</b>
        <div class="muted small">${fmtNum(b.bigLossCount)} 笔，抵消总盈利的 ${b.bigLossVsProfit !== null ? fmtPct(b.bigLossVsProfit, 1) : '—'}</div></div>
      <div class="mini-stat"><span>亏损单持仓 vs 盈利单</span>
        <b class="${holdRatio > 1.5 ? 'neg' : 'flat'}" style="font-size:14px">${e(fmtDuration(b.lossDurationMs))} / ${e(fmtDuration(b.winDurationMs))}</b>
        <div class="muted small">${holdRatio > 1.5 ? '亏损单拿得明显更久：止损偏晚' : '两侧持仓时长基本对称'}</div></div>
    </div>
    <p class="chart-note">${e(verdict)} ${e(advice)}</p>
  </section>`;
}

/** 优先复盘队列：还没写复盘的大亏交易，支持行内快捷打标签 */
function reviewQueuePanel(queue, quickTags, backQuery) {
  if (!queue || !queue.length) {
    return `<section class="panel">
      <div class="panel-head"><h2>优先复盘</h2>
        <span class="muted small">亏损超过阈值且还没写复盘的交易</span></div>
      <div class="chart-empty">大亏交易都已写过复盘 ✓</div>
    </section>`;
  }
  const tagBtn = (tradeId, name, active) =>
    `<form method="post" action="/dashboard/journal/${tradeId}/tag" class="inline quick-tag-form">
      <input type="hidden" name="tag" value="${e(name)}">
      <input type="hidden" name="back" value="/dashboard${backQuery}">
      <button class="tag-pill ${active ? 'active' : ''}" type="submit">${e(name)}</button>
    </form>`;
  const rows = queue.map((t) => {
    const current = new Set(t.tags || []);
    return `<tr>
      <td class="small">${e(fmtDateTime(t.close_time))}</td>
      <td><a href="/dashboard/journal/${t.id}"><b>${e(t.symbol)}</b></a>
        <span class="muted small">${e(t.account_name || '')}</span></td>
      <td class="neg strong">${fmtMoney(t.pnl)}</td>
      <td class="small">${e(fmtDuration(Date.parse(t.close_time) - Date.parse(t.open_time)))}</td>
      <td class="quick-tag-cell">
        ${quickTags.map((x) => tagBtn(t.id, x.name, current.has(x.name))).join(' ')}
        <a class="muted small" href="/dashboard/journal/${t.id}">写复盘 →</a>
      </td>
    </tr>`;
  }).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>优先复盘</h2>
      <span class="muted small">按亏损从大到小 · 点标签快速归类，进详情页写复盘</span></div>
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>平仓时间</th><th>交易对</th><th>净盈亏</th><th>持仓</th><th>快捷标签</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  </section>`;
}

function statPanel(s) {
  const item = (label, value, cls = '') =>
    `<div class="stat-item"><span class="stat-label">${e(label)}</span><span class="stat-value ${cls}">${value}</span></div>`;
  return `<section class="panel">
    <div class="panel-head"><h2>统计</h2></div>
    <div class="stat-grid">
      <div class="stat-col">
        ${item('总盈亏', fmtMoney(s.totalPnl), sign(s.totalPnl))}
        ${item('交易预期', fmtMoney(s.expectancy), sign(s.expectancy))}
        ${item('日均收益', fmtMoney(s.dailyAvgPnl), sign(s.dailyAvgPnl))}
        ${item('日均成交量', fmtMoney(s.dailyAvgVolume, { sign: false }))}
        ${item('最大单笔收益', fmtMoney(s.maxGain), sign(s.maxGain))}
        ${item('最大单笔亏损', fmtMoney(s.maxLoss), sign(s.maxLoss))}
      </div>
      <div class="stat-col">
        ${item('日均交易次数', `${s.dailyAvgTrades.toFixed(2)} <span class="muted">(${s.activeDays} 天)</span>`)}
        ${item('平均交易盈利', fmtMoney(s.avgWin), 'pos')}
        ${item('平均交易亏损', fmtMoney(-s.avgLoss, { sign: false }), '')}
        ${item('最大连续盈利', String(s.maxConsecutiveWin), 'pos')}
        ${item('最大连续亏损', String(s.maxConsecutiveLoss), 'neg')}
        ${item('总交易量', fmtMoney(s.totalVolume, { sign: false }))}
      </div>
    </div>
  </section>`;
}

function sideRow(title, block, color) {
  const isLong = color === 'green';
  return `<section class="side-row ${isLong ? 'long' : 'short'}">
    <div class="side-card">
      <h3>${e(title)}</h3>
      <div class="side-big">${block.count}</div>
      <div class="ratio-bar big"><span style="width:${(block.ratio * 100).toFixed(2)}%;background:${isLong ? PALETTE.green : PALETTE.red}"></span></div>
      <div class="side-caption">占全部交易 ${fmtPct(block.ratio)}</div>
    </div>
    <div class="side-card">
      <h3>${e(title)}胜率</h3>
      <div class="donut-wrap">${donut({ pct: block.winRate, color: isLong ? PALETTE.green : PALETTE.red, size: 88, label: fmtPct(block.winRate) })}</div>
      <div class="side-caption">${block.wins} 盈 / ${block.losses} 亏</div>
    </div>
    <div class="side-card">
      <h3>平均${e(title)}持仓时长</h3>
      <div class="side-big small">${e(fmtDuration(block.avgDuration))}</div>
      <div class="metric-line"><span>高于均时胜率</span><span class="strong">${fmtPct(block.winAboveAvgRate)}</span></div>
      <div class="mini-bar"><span style="width:${(block.winAboveAvgRate * 100).toFixed(1)}%;background:${PALETTE.green}"></span></div>
      <div class="metric-line"><span>低于均时胜率</span><span class="strong">${fmtPct(block.winBelowAvgRate)}</span></div>
      <div class="mini-bar"><span style="width:${(block.winBelowAvgRate * 100).toFixed(1)}%;background:${PALETTE.red}"></span></div>
    </div>
    <div class="side-card">
      <h3>${e(title)}实现总盈亏</h3>
      <div class="pill ${isLong ? 'pill-green' : 'pill-red'}">${fmtMoney(block.pnl)}</div>
      <div class="side-caption">平均盈利 ${fmtMoney(block.avgWin)}</div>
      <div class="side-caption">平均亏损 ${fmtMoney(block.avgLoss, { sign: false })}</div>
    </div>
  </section>`;
}

function weekHourPanel(s) {
  const pad2 = (h) => String(h ?? 0).padStart(2, '0');
  const label = (slot) => `${slot.weekdayLabel} ${pad2(slot.hour)}:00–${pad2(slot.hour)}:59`;
  const slotCard = (title, slot, value, cls = '') => (slot ? `<div class="mini-stat">
      <span>${e(title)}</span><b class="${cls}">${value}</b>
      <div class="muted small">${e(label(slot))} · ${slot.trades} 笔</div>
    </div>` : '');
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'; } catch { return '本地时区'; }
  })();
  return `<section class="panel">
    <div class="panel-head">
      <h2>周 × 小时盈亏热力图</h2>
      <span class="muted small">颜色越深 = 金额越大 · 空白格子 = 该时段没有平仓交易</span>
    </div>
    <div class="heatmap-wrap">${weekHourHeatmap({ matrix: s.hourWeekday })}</div>
    <div class="mini-strip" style="margin:14px 0 0">
      ${slotCard('最赚钱的时段', s.bestSlot, fmtMoney(s.bestSlot?.pnl || 0), 'pos')}
      ${slotCard('最亏钱的时段', s.worstSlot, fmtMoney(s.worstSlot?.pnl || 0), 'neg')}
      ${slotCard('胜率最高的时段（≥3 笔）', s.bestWinRateSlot, fmtPct(s.bestWinRateSlot?.winRate || 0), 'pos')}
    </div>
    <p class="chart-note">按平仓时间统计，时区：${e(tz)}。单格样本太小时结论仅供参考。</p>
  </section>`;
}

function analysisPanel(s) {
  const dailyPnl = s.daily.map((d) => ({ x: d.date, value: d.pnl }));
  const cumPnl = s.cumulative.map((d) => ({ x: d.date, value: d.value }));
  const ddSeries = s.drawdown.series.map((d) => ({ x: d.date, value: d.value }));
  const hourItems = s.hourBuckets.map((b) => ({ label: `${String(b.hour).padStart(2, '0')}时`, value: b.pnl }));
  const weekdayItems = s.weekdayBuckets.map((b) => ({ label: b.label, value: b.pnl }));
  const durationCount = s.durationBuckets.map((b) => ({ label: b.label, value: b.count }));
  const durationPnl = s.durationBuckets.map((b) => ({ label: b.label, value: b.pnl }));
  const symbolItems = s.symbols.slice(0, 12).map((x) => ({
    label: x.symbol, value: x.pnl, color: x.pnl >= 0 ? PALETTE.green : PALETTE.red,
  }));

  return `<section class="panel">
    <div class="panel-head"><h2>分析</h2></div>
    <div class="grid-2">
      <div class="chart-box"><h3>按天交易盈亏</h3>
        ${lineChart({ points: dailyPnl, color: PALETTE.green, xFormat: (v) => String(v).slice(5) })}</div>
      <div class="chart-box"><h3>累计盈亏</h3>
        ${lineChart({ points: cumPnl, color: PALETTE.blue, xFormat: (v) => String(v).slice(5) })}</div>
      <div class="chart-box"><h3>回撤（滚动峰值）</h3>
        ${lineChart({ points: ddSeries, color: PALETTE.red, xFormat: (v) => String(v).slice(5) })}
        <div class="chart-note">最大回撤 <b class="neg">${fmtMoney(s.drawdown.maxDrawdown, { sign: false })}</b>
          ${s.drawdown.maxDrawdownPct ? `（${fmtPct(s.drawdown.maxDrawdownPct)}）` : ''}</div></div>
      <div class="chart-box"><h3>按小时交易盈亏</h3>${barChart({ items: hourItems, color: PALETTE.blue })}</div>
      <div class="chart-box"><h3>按星期交易盈亏</h3>${barChart({ items: weekdayItems, color: PALETTE.yellow })}</div>
      <div class="chart-box"><h3>持仓时长分布（笔数）</h3>${barChart({ items: durationCount, color: PALETTE.purple })}</div>
      <div class="chart-box"><h3>按持仓时长的盈亏</h3>${barChart({ items: durationPnl, color: PALETTE.green })}</div>
      <div class="chart-box"><h3>币种盈亏</h3>${barChart({ items: symbolItems })}</div>
      <div class="chart-box"><h3>多空比</h3>
        <div class="longshort">
          <div class="ls-col long"><div class="ls-num">${fmtNum(s.longs.count)}</div><div class="ls-label">多单</div>
            <div class="ls-sub">${fmtPct(s.longs.ratio)} · 胜率 ${fmtPct(s.longs.winRate)}</div></div>
          <div class="ls-col short"><div class="ls-num">${fmtNum(s.shorts.count)}</div><div class="ls-label">空单</div>
            <div class="ls-sub">${fmtPct(s.shorts.ratio)} · 胜率 ${fmtPct(s.shorts.winRate)}</div></div>
        </div></div>
    </div>
  </section>`;
}

function feesPanel(s, funding, rebates = null) {
  return `<section class="panel">
    <div class="panel-head"><h2>资金费与手续费</h2></div>
    <div class="grid-4">
      <div class="mini-stat"><span>收到的资金费</span><b class="${sign(s.funding.received)}">${fmtMoney(s.funding.received)}</b></div>
      <div class="mini-stat"><span>支付的资金费</span><b class="${s.funding.paid ? 'neg' : ''}">${fmtMoney(-s.funding.paid, { sign: false })}</b></div>
      <div class="mini-stat"><span>净资金费</span><b class="${sign(s.funding.net)}">${fmtMoney(s.funding.net)}</b></div>
      <div class="mini-stat"><span>净手续费</span><b class="${sign(s.fees.net)}">${fmtMoney(s.fees.net)}</b></div>
      <div class="mini-stat"><span>做市返佣</span><b class="pos">${fmtMoney(s.fees.makerRebate)}</b>
        <div class="muted small">成交记录里的正手续费（负费率）</div></div>
      <div class="mini-stat"><span>支付的手续费</span><b class="neg">${fmtMoney(-s.fees.marketFee, { sign: false })}</b></div>
      ${funding ? `<div class="mini-stat"><span>资金费流水（单独拉取）</span><b>${fmtNum(funding.events)} 条</b>
        <div class="muted small">未匹配 ${fmtNum(funding.unallocated)} 条 · ${fmtMoney(funding.unallocatedAmount)}</div></div>` : ''}
      ${rebates?.count ? `<div class="mini-stat"><span>账单返佣（邀请/活动）</span><b class="pos">${fmtMoney(rebates.usdt)}</b>
        <div class="muted small">${fmtNum(rebates.count)} 条入账${rebates.others ? ` · ${fmtNum(rebates.others)} 条非 USDT 未计入` : ''} · 明细见资金流水</div></div>` : ''}
    </div>
  </section>`;
}

function orderPanel(s) {
  const rows = s.orderTypes.map((o) => `<tr>
    <td>${o.key === 'market' ? '市价（吃单）' : o.key === 'limit' ? '限价（挂单）' : o.key === 'mixed' ? '混合（吃挂均有）' : '其他/未知'}</td>
    <td>${fmtNum(o.count)}</td><td>${fmtPct(o.ratio)}</td>
    <td class="${sign(o.pnl)}">${fmtMoney(o.pnl)}</td><td>${fmtPct(o.winRate)}</td>
    <td>${fmtMoney(o.avgWin)}</td><td>${fmtMoney(-o.avgLoss, { sign: false })}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>市价单与限价单</h2></div>
    <table class="table">
      <thead><tr><th>类型</th><th>笔数</th><th>占比</th><th>总盈亏</th><th>胜率</th><th>平均盈利</th><th>平均亏损</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function sizePanel(s) {
  const rows = s.sizeBuckets.map((b) => `<tr>
    <td>${e(b.label)}</td><td>${fmtNum(b.count)}</td><td>${fmtPct(b.winRate)}</td>
    <td class="${sign(b.pnl)}">${fmtMoney(b.pnl)}</td><td>${fmtMoney(b.avgPnl)}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>仓位报告</h2></div>
    <table class="table">
      <thead><tr><th>仓位区间</th><th>笔数</th><th>胜率</th><th>总盈亏</th><th>单笔均值</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function tagPanel(s) {
  const rows = s.tagStats.length ? s.tagStats.map((t) => `<tr>
    <td><span class="tag-pill">${e(t.tag)}</span></td><td>${fmtNum(t.count)}</td>
    <td class="${sign(t.pnl)}">${fmtMoney(t.pnl)}</td><td>${fmtPct(t.winRate)}</td>
    <td>${e(fmtDuration(t.avgDuration))}</td><td class="${sign(t.expectancy)}">${fmtMoney(t.expectancy)}</td>
  </tr>`).join('') : '<tr><td colspan="6" class="muted center">还没有标签数据</td></tr>';
  return `<section class="panel">
    <div class="panel-head"><h2>标签报告</h2><a class="btn btn-ghost small" href="/dashboard/tags">管理标签</a></div>
    <table class="table">
      <thead><tr><th>标签</th><th>笔数</th><th>总盈亏</th><th>胜率</th><th>平均持仓</th><th>交易预期</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function noteCoverageBar(nc) {
  if (!nc || !nc.total) return '';
  const pct = (nc.ratio * 100).toFixed(1);
  return `<section class="panel note-coverage">
    <div class="coverage-line">
      <span>复盘覆盖率</span><b>${pct}%</b>
      <span class="muted">（${nc.noted} / ${nc.total} 笔交易写了复盘笔记）</span>
      <a class="btn btn-ghost small" href="/dashboard/journal?note=no">找出没复盘的交易</a>
    </div>
    <div class="ratio-bar"><span style="width:${pct}%;background:#7DA2FF"></span></div>
    ${nc.recent?.length ? `<div class="coverage-recent muted small">最近复盘：${
      nc.recent.map((r) => `<a href="/dashboard/journal/${r.id}" title="${e(r.note)}">${e(r.symbol)}</a>`).join(' · ')
    }</div>` : ''}
  </section>`;
}

function dailyPanel(s) {
  const rows = [...s.daily].reverse().slice(0, 30).map((d) => `<tr>
    <td>${d.date}</td><td>${d.trades}</td><td>${fmtPct(d.winRate)}</td>
    <td class="${sign(d.pnl)}">${fmtMoney(d.pnl)}</td><td>${fmtMoney(d.volume, { sign: false })}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>按天明细（最近 30 天）</h2></div>
    <table class="table">
      <thead><tr><th>日期</th><th>笔数</th><th>胜率</th><th>盈亏</th><th>成交量</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted center">暂无数据</td></tr>'}</tbody>
    </table>
  </section>`;
}

function recentTrades(trades) {
  const rows = trades.slice(0, 20).map((t) => `<tr>
    <td>${fmtDateTime(t.close_time)}</td>
    <td><a href="/dashboard/journal/${t.id}"><b>${e(t.symbol)}</b></a>
      <div class="muted small">${t.market === 'spot' ? '现货' : '合约'}</div></td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '做多' : '做空'}</span></td>
    <td>${t.order_type === 'limit' ? '限价' : t.order_type === 'market' ? '市价' : '其他'}</td>
    <td>${fmtPrice(t.entry_price)} → ${fmtPrice(t.exit_price)}</td>
    <td>${fmtMoney(t.notional, { sign: false })}</td>
    <td class="${sign(t.pnl)} strong">${fmtMoney(t.pnl)}</td>
    <td class="muted">${e(fmtDuration(new Date(t.close_time) - new Date(t.open_time)))}</td>
    <td>${(t.tags || []).map((x) => `<span class="tag-pill">${e(x)}</span>`).join(' ')}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>最近交易</h2><a class="btn btn-ghost small" href="/dashboard/journal">查看全部</a></div>
    <table class="table">
      <thead><tr><th>平仓时间</th><th>币种</th><th>方向</th><th>类型</th><th>开仓 → 平仓</th><th>名义价值</th><th>净盈亏</th><th>持仓</th><th>标签</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted center">暂无交易记录</td></tr>'}</tbody>
    </table>
  </section>`;
}

function fmtRate(v) {
  if (v === null || v === undefined || v === '') return '—';
  return `${(Number(v) * 100).toFixed(4)}%`;
}

function livePositionsPanel({ accounts, balances, positions, spotBalances = [], spotHoldings = [], accountId = null }) {
  const real = accounts.filter((a) => !a.is_demo && a.exchange !== 'manual');
  if (!real.length) {
    return `<section class="panel" data-live-panel>
      <div class="panel-head"><h2>实时持仓</h2></div>
      <p class="muted">还没有接入真实交易所。<a href="/dashboard/accounts/new">添加只读 API</a> 后，这里会定时刷新余额、持仓和资金费率。</p>
    </section>`;
  }

  const totalEquity = balances.reduce((a, b) => a + (Number(b.total) || 0), 0);
  const unrealized = positions.reduce((a, p) => a + (Number(p.unrealized) || 0), 0);
  const updatedAt = [...balances, ...positions].map((x) => x.updated_at).sort().at(-1) || null;

  const rows = positions.map((p) => `<tr>
    <td class="small">${e(p.account_name || '')}</td>
    <td><b>${e(p.symbol)}</b></td>
    <td><span class="side-tag ${p.side}">${p.side === 'long' ? '多' : '空'}</span></td>
    <td>${fmtNum(p.size, 4)}</td>
    <td>${fmtPrice(p.entry_price)}</td>
    <td>${fmtPrice(p.mark_price)}</td>
    <td class="strong ${sign(p.unrealized)}">${fmtMoney(p.unrealized)}</td>
    <td class="rate">${fmtRate(p.funding_rate)}</td>
    <td class="small muted">${p.next_funding_time ? e(fmtDateTime(p.next_funding_time)) : '—'}</td>
  </tr>`).join('');

  return `<section class="panel" data-live-panel${accountId ? ` data-live-account="${accountId}"` : ''}>
    <div class="panel-head">
      <h2>实时持仓 <span class="muted small" data-live-updated>${updatedAt ? `更新于 ${e(fmtDateTime(updatedAt))}` : '等待首次刷新'}</span></h2>
      <div class="head-actions">
        <button class="btn btn-ghost small" type="button" data-live-refresh>立即刷新</button>
      </div>
    </div>
    <div class="mini-strip" style="margin-bottom:14px">
      <div class="mini-stat"><span>总资产（已同步账户）</span><b data-live-equity>${fmtMoney(totalEquity, { sign: false })}</b></div>
      <div class="mini-stat"><span>当前持仓</span><b data-live-count>${positions.length}</b></div>
      <div class="mini-stat"><span>未实现盈亏</span><b data-live-unrealized class="${sign(unrealized)}">${fmtMoney(unrealized)}</b></div>
    </div>
    <table class="table">
      <thead><tr><th>账户</th><th>币种</th><th>方向</th><th>数量</th><th>开仓价</th><th>标记价</th><th>未实现盈亏</th><th>资金费率</th><th>下次结算</th></tr></thead>
      <tbody data-live-rows>${rows || '<tr><td colspan="9" class="muted center">当前没有合约持仓</td></tr>'}</tbody>
    </table>

    <div class="live-subhead">
      <h3>现货</h3>
      <span class="muted small">市值按当前价格估算；没有价格时只显示数量</span>
    </div>
    <div class="mini-strip" style="margin-bottom:12px">
      <div class="mini-stat"><span>现货持仓币种</span><b data-live-spot-count>${spotHoldings.length}</b></div>
      <div class="mini-stat"><span>现货市值</span><b data-live-spot-value>${fmtMoney(spotHoldings.reduce((a, h) => a + (Number(h.value) || 0), 0), { sign: false })}</b></div>
    </div>
    <table class="table">
      <thead><tr><th>账户</th><th>交易对</th><th>数量</th><th>价格</th><th>市值</th></tr></thead>
      <tbody data-live-spot-rows>${spotHoldings.map((h) => `<tr>
        <td class="small">${e(h.account_name || '')}</td>
        <td><b>${e(h.symbol)}</b></td>
        <td>${fmtNum(h.quantity, 6)}</td>
        <td>${h.price === null || h.price === undefined ? '—' : fmtPrice(h.price)}</td>
        <td>${h.value === null || h.value === undefined ? '—' : fmtMoney(h.value, { sign: false })}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted center">当前没有现货持仓</td></tr>'}
      </tbody>
    </table>
    <p class="chart-note">${config.liveRefreshSeconds > 0
      ? `后台每 ${config.liveRefreshSeconds} 秒向交易所刷新一次；页面每 30 秒读一次本地快照。`
      : '后台定时刷新已关闭（LIVE_REFRESH_SECONDS=0），可点「立即刷新」。'}
      资金费率为当前值，结算后计入交易净盈亏。</p>
  </section>`;
}

export function dashboardPage({ user, stats, trades, market = 'all', accounts = [], accountId = null, balances = [], positions = [], spotBalances = [], spotHoldings = [], funding = null, rebates = null, reviewQueue = [], quickTags = [], demo, notice, error }) {
  const tabHref = (m) => `/dashboard?market=${m}${accountId ? `&account_id=${accountId}` : ''}`;
  const accountOptions = ['<option value="all">全部账户（聚合）</option>']
    .concat(accounts.map((a) => `<option value="${a.id}" ${accountId && String(accountId) === String(a.id) ? 'selected' : ''}>${e(a.name)}（${e(a.exchange)}${a.is_demo ? ' · 演示' : ''}）</option>`))
    .join('');
  const body = `
    <div class="dash-filter">
      <div class="market-tabs">
        <a class="${market === 'all' ? 'active' : ''}" href="${tabHref('all')}">全部</a>
        <a class="${market === 'futures' ? 'active' : ''}" href="${tabHref('futures')}">合约</a>
        <a class="${market === 'spot' ? 'active' : ''}" href="${tabHref('spot')}">现货</a>
      </div>
      ${accounts.length > 1 ? `<form method="get" action="/dashboard" class="account-picker" data-autosubmit>
        <input type="hidden" name="market" value="${e(market)}">
        <select name="account_id" aria-label="按账户查看">${accountOptions}</select>
        <button class="btn btn-ghost small" type="submit">切换账户</button>
      </form>` : ''}
    </div>
    ${accountId ? `<p class="chart-note" style="margin:-4px 0 12px">正在查看单个账户的数据；切换上方选项回到全部账户聚合视图。</p>` : ''}
    <div class="mini-strip">
      <div class="mini-stat"><span>总盈亏</span><b class="${sign(stats.totalPnl)}">${fmtMoney(stats.totalPnl)}</b></div>
      <div class="mini-stat"><span>交易预期</span><b class="${sign(stats.expectancy)}">${fmtMoney(stats.expectancy)}</b></div>
      <div class="mini-stat"><span>最大回撤</span><b class="neg">${fmtMoney(stats.drawdown.maxDrawdown, { sign: false })}</b></div>
      <div class="mini-stat"><span>复盘覆盖率</span><b>${fmtPct(stats.noteCoverage.ratio, 1)}</b></div>
    </div>
    ${demo?.active ? `<div class="alert alert-info demo-banner">
      <span><b>当前包含演示数据</b>（${fmtNum(demo.trades)} 笔 · ${demo.accounts} 个演示账户）。
      接入真实数据前请先清除，否则统计会真假混在一起。</span>
      <form method="post" action="/dashboard/settings/clear-demo" onsubmit="return confirm('确定清除全部演示数据吗？真实交易不会被删除。')">
        <button class="btn small" type="submit">清除演示数据</button>
      </form>
    </div>` : ''}
    ${kpiBar(stats)}
    ${diagnosisPanel(stats)}
    ${reviewQueuePanel(reviewQueue, quickTags, `?market=${market}${accountId ? `&account_id=${accountId}` : ''}`)}
    ${statPanel(stats)}
    ${livePositionsPanel({ accounts, balances, positions, spotBalances, spotHoldings, accountId })}
    ${sideRow('多单', stats.longs, 'green')}
    ${sideRow('空单', stats.shorts, 'red')}
    ${analysisPanel(stats)}
    ${weekHourPanel(stats)}
    ${feesPanel(stats, funding, rebates)}
    ${orderPanel(stats)}
    ${sizePanel(stats)}
    ${tagPanel(stats)}
    ${noteCoverageBar(stats.noteCoverage)}
    ${dailyPanel(stats)}
    ${recentTrades(trades)}`;

  return shell({
    active: 'dashboard',
    user,
    title: '仪表盘',
    subtitle: `共 ${fmtNum(stats.total)} 笔已平仓交易 · ${stats.activeDays} 个活跃交易日 · 数据截至 ${fmtDateTime(trades[0]?.close_time || new Date().toISOString())}`,
    actions: '<a class="btn btn-ghost" href="/dashboard/import">导入 CSV</a><a class="btn btn-primary" href="/dashboard/journal/new">+ 手动记录</a>',
    notice,
    error,
    body,
  });
}
