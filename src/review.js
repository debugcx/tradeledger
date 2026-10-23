/**
 * 周期报告（周 / 月 / 年）与 AI 复盘上下文（纯函数）。
 *
 * 不调用任何外部模型：这里只把「这一段时间发生了什么」整理成结构化对象/Markdown，
 * 供用户复制到任意 LLM，或作为后续自动化的输入。
 */

import { analyze } from './stats.js';
import { tradeBreakdown } from './breakdown.js';

const DAY = 86400_000;
const pad = (n) => String(n).padStart(2, '0');

export function isoWeekOf(dateInput = new Date()) {
  const d = new Date(dateInput);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((t - yearStart) / DAY) + 1) / 7);
  return { year, week };
}

export function formatWeek({ year, week }) {
  return `${year}-W${pad(week)}`;
}

export function parseWeek(input) {
  const m = String(input || '').match(/^(\d{4})-W(\d{1,2})$/i);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/** 周一 00:00 到周日 23:59:59.999（服务端本地时区） */
export function weekRange({ year, week }) {
  const jan4 = new Date(year, 0, 4);
  const offset = (jan4.getDay() + 6) % 7;
  const firstMonday = new Date(year, 0, 4 - offset);
  const start = new Date(firstMonday.getTime() + (week - 1) * 7 * DAY);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * DAY - 1);
  return { from: start, to: end };
}

export function shiftWeek({ year, week }, delta) {
  const { from } = weekRange({ year, week });
  const shifted = new Date(from.getTime() + delta * 7 * DAY);
  return isoWeekOf(shifted);
}

/* ---------------- 月 / 年周期 ---------------- */

export function monthOf(dateInput = new Date()) {
  const d = new Date(dateInput);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function formatMonth({ year, month }) {
  return `${year}-${pad(month)}`;
}

export function parseMonth(input) {
  const m = String(input || '').match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function monthRange({ year, month }) {
  const from = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const to = new Date(year, month, 0, 23, 59, 59, 999);
  return { from, to };
}

export function shiftMonth({ year, month }, delta) {
  const d = new Date(year, month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function yearOf(dateInput = new Date()) {
  return { year: new Date(dateInput).getFullYear() };
}

export function formatYear({ year }) {
  return String(year);
}

export function parseYear(input) {
  const m = String(input || '').match(/^(\d{4})$/);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  return { year };
}

export function yearRange({ year }) {
  const from = new Date(year, 0, 1, 0, 0, 0, 0);
  const to = new Date(year, 11, 31, 23, 59, 59, 999);
  return { from, to };
}

/** 周期描述符：{ kind: 'week'|'month'|'year', ... } → { from, to, label } */
export function periodRange(period) {
  if (!period || !period.kind) return null;
  if (period.kind === 'week') {
    const r = weekRange(period);
    return { ...r, label: formatWeek(period) };
  }
  if (period.kind === 'month') {
    const r = monthRange(period);
    return { ...r, label: formatMonth(period) };
  }
  if (period.kind === 'year') {
    const r = yearRange(period);
    return { ...r, label: formatYear(period) };
  }
  return null;
}

/** 从 query 参数解析周期；缺省为本周 */
export function parsePeriod(query = {}) {
  const kind = ['week', 'month', 'year'].includes(String(query.kind)) ? String(query.kind) : 'week';
  if (kind === 'month') {
    const m = parseMonth(query.month) || monthOf();
    return { kind, ...m };
  }
  if (kind === 'year') {
    const y = parseYear(query.year) || yearOf();
    return { kind, ...y };
  }
  const w = parseWeek(query.week) || isoWeekOf();
  return { kind: 'week', ...w };
}

const KIND_LABEL = { week: '周报', month: '月报', year: '年报' };
export const periodKindLabel = (kind) => KIND_LABEL[kind] || '周期报告';

const slotLabel = (slot) => `${slot.weekdayLabel} ${pad(slot.hour)}:00–${pad(slot.hour)}:59`;

export function buildWeeklyReview(allTrades, { year, week } = isoWeekOf()) {
  return buildPeriodReview(allTrades, { kind: 'week', year, week });
}

/** 统一入口：周 / 月 / 年报告。返回结构与旧周报兼容（period.kind 新增）。 */
export function buildPeriodReview(allTrades, period = { kind: 'week', ...isoWeekOf() }) {
  const kind = ['week', 'month', 'year'].includes(period?.kind) ? period.kind : 'week';
  const range = periodRange(period);
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  const trades = (allTrades || []).filter((t) => t.close_time >= fromIso && t.close_time <= toIso);
  const s = analyze(trades);
  const kindLabel = periodKindLabel(kind);

  const slots = s.hourWeekday.flat().filter((c) => c.trades >= 2);
  const worstSlots = [...slots].filter((c) => c.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3)
    .map((c) => ({ label: slotLabel(c), pnl: c.pnl, trades: c.trades, winRate: c.winRate }));
  const bestSlots = [...slots].filter((c) => c.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 3)
    .map((c) => ({ label: slotLabel(c), pnl: c.pnl, trades: c.trades, winRate: c.winRate }));

  const tags = s.tagStats.filter((t) => t.count >= 3);
  const worstTags = [...tags].filter((t) => t.expectancy < 0).sort((a, b) => a.expectancy - b.expectancy).slice(0, 3)
    .map((t) => ({ tag: t.tag, count: t.count, pnl: t.pnl, expectancy: t.expectancy, winRate: t.winRate }));
  const bestTags = [...tags].filter((t) => t.expectancy > 0).sort((a, b) => b.expectancy - a.expectancy).slice(0, 3)
    .map((t) => ({ tag: t.tag, count: t.count, pnl: t.pnl, expectancy: t.expectancy, winRate: t.winRate }));

  const worstSymbols = [...s.symbols].filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 3)
    .map((x) => ({ symbol: x.symbol, pnl: x.pnl, count: x.count }));
  const bestSymbols = [...s.symbols].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 3)
    .map((x) => ({ symbol: x.symbol, pnl: x.pnl, count: x.count }));

  const notes = trades
    .filter((t) => t.note && String(t.note).trim())
    .sort((a, b) => String(b.note_updated_at || b.close_time).localeCompare(String(a.note_updated_at || a.close_time)))
    .slice(0, 5)
    .map((t) => ({
      symbol: t.symbol,
      pnl: t.pnl,
      close_time: t.close_time,
      note: String(t.note).slice(0, 300),
    }));

  const checked = trades.map((t) => tradeBreakdown(t)).filter((b) => b.pricePnl !== null);
  const mismatchCount = checked.filter((b) => !b.priceMatch).length;

  const questions = [];
  if (worstSlots.length) {
    questions.push(`为什么「${worstSlots[0].label}」是本${kind === 'week' ? '周' : kind === 'month' ? '月' : '年'}最亏的时段？那几笔的进场依据是否一致？`);
  }
  if (worstTags.length) {
    questions.push(`标签「${worstTags[0].tag}」的交易预期为 ${worstTags[0].expectancy.toFixed(2)}，这个标签的入场条件需要怎么改？`);
  }
  if (worstSymbols.length) {
    questions.push(`本${kind === 'week' ? '周' : kind === 'month' ? '月' : '年'}在 ${worstSymbols[0].symbol} 上亏得最多，是策略不适合这个品种，还是执行问题？`);
  }
  if (s.maxConsecutiveLoss >= 3) {
    questions.push(`出现 ${s.maxConsecutiveLoss} 连亏，连亏期间仓位和频率有没有放大？`);
  }
  if (s.noteCoverage.ratio < 0.5) {
    questions.push(`复盘覆盖率只有 ${(s.noteCoverage.ratio * 100).toFixed(0)}%，下个周期能不能至少给亏损单都写一句？`);
  }

  const headline = trades.length
    ? `${range.label} 共 ${s.total} 笔，净盈亏 ${s.totalPnl >= 0 ? '+' : '-'}$${Math.abs(s.totalPnl).toFixed(2)}，`
      + `胜率 ${(s.winRate * 100).toFixed(1)}%，最大回撤 $${s.drawdown.maxDrawdown.toFixed(2)}。`
    : `${range.label} 没有已平仓交易。`;

  return {
    period: {
      kind,
      label: range.label,
      kindLabel,
      from: fromIso,
      to: toIso,
      ...(kind === 'week' ? { year: period.year, week: period.week } : {}),
      ...(kind === 'month' ? { year: period.year, month: period.month } : {}),
      ...(kind === 'year' ? { year: period.year } : {}),
    },
    headline,
    stats: {
      total: s.total,
      wins: s.wins,
      losses: s.losses,
      winRate: s.winRate,
      totalPnl: s.totalPnl,
      expectancy: s.expectancy,
      avgWin: s.avgWin,
      avgLoss: s.avgLoss,
      maxDrawdown: s.drawdown.maxDrawdown,
      maxConsecutiveWin: s.maxConsecutiveWin,
      maxConsecutiveLoss: s.maxConsecutiveLoss,
      activeDays: s.activeDays,
      noteCoverage: s.noteCoverage,
      reconciliations: { checked: checked.length, mismatches: mismatchCount },
    },
    worstSlots,
    bestSlots,
    worstTags,
    bestTags,
    worstSymbols,
    bestSymbols,
    notes,
    questions,
    generatedAt: new Date().toISOString(),
  };
}

const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;

function money(v) {
  const n = Number(v) || 0;
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

export function reviewMarkdown(r) {
  const kindLabel = r.period.kindLabel || '周报';
  const lines = [];
  lines.push(`# TradeLedger ${kindLabel} ${r.period.label}`);
  lines.push('');
  lines.push(`> 区间：${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)}（服务端本地时区）`);
  lines.push('');
  lines.push('## 一句话总结');
  lines.push('');
  lines.push(r.headline);
  lines.push('');
  lines.push('## 核心指标');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push(`| 已平仓交易 | ${r.stats.total} 笔 |`);
  lines.push(`| 胜率 | ${pct(r.stats.winRate)}（${r.stats.wins} 盈 / ${r.stats.losses} 亏） |`);
  lines.push(`| 净盈亏 | ${money(r.stats.totalPnl)} |`);
  lines.push(`| 交易预期 | ${money(r.stats.expectancy)} |`);
  lines.push(`| 平均盈利 / 亏损 | ${money(r.stats.avgWin)} / ${money(-r.stats.avgLoss)} |`);
  lines.push(`| 最大回撤 | $${Number(r.stats.maxDrawdown).toFixed(2)} |`);
  lines.push(`| 最大连亏 | ${r.stats.maxConsecutiveLoss} 笔 |`);
  lines.push(`| 复盘覆盖率 | ${pct(r.stats.noteCoverage.ratio)} |`);
  lines.push('');

  const section = (title, rows, fmt) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!rows.length) {
      lines.push(`_${kindLabel}样本不足，跳过。_`);
    } else {
      for (const row of rows) lines.push(`- ${fmt(row)}`);
    }
    lines.push('');
  };

  section('最亏的 3 个时段', r.worstSlots,
    (x) => `${x.label}：${money(x.pnl)}，${x.trades} 笔，胜率 ${pct(x.winRate)}`);
  section('表现最好的 3 个时段', r.bestSlots,
    (x) => `${x.label}：${money(x.pnl)}，${x.trades} 笔，胜率 ${pct(x.winRate)}`);
  section('交易预期最差的标签', r.worstTags,
    (x) => `${x.tag}：预期 ${money(x.expectancy)}，${x.count} 笔，总盈亏 ${money(x.pnl)}`);
  section('交易预期最好的标签', r.bestTags,
    (x) => `${x.tag}：预期 ${money(x.expectancy)}，${x.count} 笔，总盈亏 ${money(x.pnl)}`);
  section('最亏的币种', r.worstSymbols, (x) => `${x.symbol}：${money(x.pnl)}，${x.count} 笔`);
  section('最赚的币种', r.bestSymbols, (x) => `${x.symbol}：${money(x.pnl)}，${x.count} 笔`);

  lines.push('## 复盘笔记摘录');
  lines.push('');
  if (!r.notes.length) {
    lines.push(`_${kindLabel}期间没有交易笔记。_`);
  } else {
    for (const n of r.notes) {
      lines.push(`- **${n.symbol}**（${n.close_time.slice(0, 10)}，${money(n.pnl)}）：${n.note}`);
    }
  }
  lines.push('');

  lines.push('## 给 AI 的复盘提示词');
  lines.push('');
  lines.push('```text');
  lines.push('你是一名纪律导向的交易教练。请基于下面的报告数据，指出 1 个最需要停止的行为、1 个最值得放大的优势，');
  lines.push('并给出下个周期可执行的 3 条规则。不要泛泛而谈，每条结论都要引用具体时段、标签或币种。');
  lines.push('```');
  lines.push('');
  lines.push('## 建议追问');
  lines.push('');
  for (const q of r.questions) lines.push(`- ${q}`);
  lines.push('');
  lines.push('---');
  lines.push(`由 TradeLedger 于 ${r.generatedAt} 生成。`);
  return lines.join('\n');
}

/** 报告生成提示词（AI 生成用），period 参数用于措辞 */
export function reportPrompt(review) {
  const kindLabel = review.period.kindLabel || '周报';
  const next = review.period.kind === 'week' ? '下周' : review.period.kind === 'month' ? '下个月' : '明年';
  return `你是一名纪律导向的加密货币交易教练。下面是一份 ${kindLabel}（${review.period.label}）的统计数据。请：
1. 用 3 条最重要的结论概括这个周期的表现（每条都要引用具体时段、标签或币种）；
2. 指出 1 个最需要停止的行为、1 个最值得放大的优势；
3. 给出${next}可执行的 3 条规则。

不要泛泛而谈，不要编造数据里不存在的内容；样本不足的地方要明确说明。输出使用 Markdown。

---

${reviewMarkdown(review)}`;
}
