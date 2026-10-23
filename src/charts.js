/**
 * 轻量 SVG 图表（服务端直出，零依赖）
 */

import { escapeHtml as e } from './http.js';

export const PALETTE = {
  green: '#4ade80',
  greenSoft: 'rgba(74,222,128,0.16)',
  red: '#ff6b57',
  redSoft: 'rgba(255,107,87,0.16)',
  yellow: '#ffd21e',
  blue: '#58a6ff',
  purple: '#a78bfa',
  grid: 'rgba(148,163,184,0.14)',
  text: '#8b98a5',
};

export function donut({ pct, color = PALETTE.green, size = 92, stroke = 9, label = '' }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, Number(pct) || 0));
  const dash = `${(c * clamped).toFixed(2)} ${c.toFixed(2)}`;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut" role="img" aria-label="胜率 ${(clamped * 100).toFixed(2)}%">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(148,163,184,0.16)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    ${label ? `<text x="50%" y="50%" text-anchor="middle" dy="0.08em" class="donut-label">${e(label)}</text>` : ''}
  </svg>`;
}

export function lineChart({
  points = [], width = 720, height = 220, color = PALETTE.green,
  yFormat = (v) => v.toFixed(0), xFormat = (v) => String(v), zeroLine = true,
}) {
  if (!points.length) return `<div class="chart-empty">暂无数据</div>`;
  const padL = 54, padR = 12, padT = 12, padB = 28;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const xs = points.map((_, i) => (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w));
  const values = points.map((p) => Number(p.value) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const ys = values.map((v) => padT + h - ((v - min) / span) * h);

  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${(padT + h).toFixed(1)} L${xs[0].toFixed(1)},${(padT + h).toFixed(1)} Z`;
  const gradId = `lg${Math.random().toString(36).slice(2, 9)}`;

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (h / 4) * i;
    const v = max - (span / 4) * i;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + w).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${PALETTE.grid}"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis-label">${e(yFormat(v))}</text>`;
  }

  const step = Math.max(1, Math.ceil(points.length / 6));
  let xlabels = '';
  for (let i = 0; i < points.length; i += step) {
    xlabels += `<text x="${xs[i].toFixed(1)}" y="${(padT + h + 18).toFixed(1)}" text-anchor="middle" class="axis-label">${e(xFormat(points[i].x ?? i))}</text>`;
  }

  let dots = '';
  if (points.length <= 80) {
    dots = xs.map((x, i) =>
      `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.3" fill="${color}"><title>${e(String(points[i].x ?? i))}: ${e(yFormat(values[i]))}</title></circle>`).join('');
  }

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" preserveAspectRatio="none" role="img">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    ${zeroLine && min < 0 && max > 0 ? `<line x1="${padL}" y1="${(padT + h - ((0 - min) / span) * h).toFixed(1)}" x2="${(padL + w).toFixed(1)}" y2="${(padT + h - ((0 - min) / span) * h).toFixed(1)}" stroke="rgba(148,163,184,0.4)" stroke-dasharray="4 4"/>` : ''}
    <path d="${area}" fill="url(#${gradId})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlabels}
  </svg>`;
}

export function barChart({
  items = [], width = 720, height = 220, color = PALETTE.green,
  yFormat = (v) => v.toFixed(0), labelFormat = (v) => String(v),
}) {
  if (!items.length) return `<div class="chart-empty">暂无数据</div>`;
  const padL = 54, padR = 12, padT = 12, padB = 32;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const values = items.map((i) => Number(i.value) || 0);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const gap = w / items.length;
  const bw = Math.max(3, gap * 0.66);
  const zeroY = padT + h - ((0 - min) / span) * h;

  let bars = '';
  const labelEvery = Math.max(1, Math.ceil(items.length / 14));
  items.forEach((it, i) => {
    const v = Number(it.value) || 0;
    const x = padL + gap * i + (gap - bw) / 2;
    const y = v >= 0 ? padT + h - ((v - min) / span) * h : zeroY;
    const bh = Math.max(1, Math.abs(((v - min) / span) * h));
    const fill = it.color || (v >= 0 ? color : PALETTE.red);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}" opacity="0.86"><title>${e(labelFormat(it.label))}: ${e(yFormat(v))}</title></rect>`;
    if (i % labelEvery === 0) {
      bars += `<text x="${(padL + gap * i + gap / 2).toFixed(1)}" y="${(padT + h + 18).toFixed(1)}" text-anchor="middle" class="axis-label">${e(labelFormat(it.label))}</text>`;
    }
  });

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (h / 4) * i;
    const v = max - (span / 4) * i;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + w).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${PALETTE.grid}"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis-label">${e(yFormat(v))}</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" preserveAspectRatio="none" role="img">
    ${grid}
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${(padL + w).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="rgba(148,163,184,0.4)"/>
    ${bars}
  </svg>`;
}

/** 周 × 小时交叉热力图：行 = 周日..周六，列 = 0..23 时 */
export function weekHourHeatmap({ matrix = [], cell = 22, gap = 3 }) {
  if (!matrix.length) return `<div class="chart-empty">暂无数据</div>`;
  const labelW = 42, topH = 20;
  const cols = 24, rows = 7;
  const gridW = cols * (cell + gap) - gap;
  const gridH = rows * (cell + gap) - gap;
  const width = labelW + gridW + 8;
  const height = topH + gridH + 6;
  const absMax = Math.max(1, ...matrix.flat().map((c) => Math.abs(Number(c?.pnl) || 0)));
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  let cells = '';
  for (let wd = 0; wd < rows; wd++) {
    for (let h = 0; h < cols; h++) {
      const c = matrix[wd]?.[h];
      const x = labelW + h * (cell + gap);
      const y = topH + wd * (cell + gap);
      if (!c || !c.trades) {
        cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="rgba(148,163,184,0.07)"/>`;
        continue;
      }
      const pnl = Number(c.pnl) || 0;
      const intensity = Math.min(1, Math.abs(pnl) / absMax);
      const base = pnl >= 0 ? '74,222,128' : '255,107,87';
      const alpha = (0.18 + intensity * 0.72).toFixed(2);
      cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="rgba(${base},${alpha})">`
        + `<title>${labels[wd]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59\n`
        + `盈亏 ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}\n`
        + `${c.trades} 笔 · 胜率 ${((Number(c.winRate) || 0) * 100).toFixed(0)}%</title></rect>`;
    }
    cells += `<text x="${labelW - 6}" y="${(topH + wd * (cell + gap) + cell - 6).toFixed(1)}" text-anchor="end" class="axis-label">${labels[wd]}</text>`;
  }

  let hourLabels = '';
  for (let h = 0; h < cols; h += 3) {
    hourLabels += `<text x="${(labelW + h * (cell + gap) + cell / 2).toFixed(1)}" y="12" text-anchor="middle" class="axis-label">${h}时</text>`;
  }

  return `<svg viewBox="0 0 ${width} ${height}" class="heatmap heatmap-hour" role="img" aria-label="周 × 小时盈亏热力图">
    ${hourLabels}${cells}
  </svg>`;
}
