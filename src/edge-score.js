/**
 * 优势分（Edge Score）——版本化的综合表现评分（纯函数）。
 *
 * 六个分量各自按「满分线」线性归一到 0–1，加权求和（权重合计 100，得分即 0–100）：
 *   胜率      ≥ 60% 满分        权重 15
 *   盈亏比 PF ≥ 3.0 满分        权重 25
 *   均盈/均亏 ≥ 2.5 满分        权重 20
 *   最大回撤  0% 满分，≥25% 0 分  权重 15
 *   恢复因子  ≥ 3× 满分         权重 10（净盈亏 / 最大回撤）
 *   一致性    盈利集中度 ≤15% 满分 权重 15（最大盈利日占盈利日总利润的比例）
 *
 * 规则：
 *   - 已平仓交易不足 5 笔时不给分（样本太少的胜率与 PF 都是噪声）；
 *   - 分量阈值是标定点：改任何阈值/权重都算口径变更，必须递增 EDGE_SCORE_VERSION；
 *   - 无正峰值日时（从未创新高）回撤无法按比例度量，该分量记 0 分。
 */

export const EDGE_SCORE_VERSION = 1;

const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

export function edgeScore(stats) {
  const closed = Number(stats?.total) || 0;
  if (closed < 5) {
    return {
      version: EDGE_SCORE_VERSION,
      score: null,
      reason: `已平仓交易不足 5 笔（当前 ${closed}），样本不足以评分`,
      components: [],
    };
  }

  const pf = Number(stats.behavior?.profitFactor) || 0;
  const winLossRatio = stats.avgLoss > 0
    ? stats.avgWin / stats.avgLoss
    : (stats.avgWin > 0 ? Infinity : 0);
  const dd = stats.drawdown || {};
  const ddPct = Number(dd.maxDrawdownPct) || 0;
  // analyze 的口径：peak 为 0 时 ddPct 强制 0——这是「从未有正峰值」而非「没有回撤」
  const ddBlind = Number(dd.maxDrawdown) > 0 && ddPct === 0;
  const recovery = Number(dd.maxDrawdown) > 0
    ? Math.max(Number(stats.totalPnl) || 0, 0) / Number(dd.maxDrawdown)
    : (Number(stats.totalPnl) > 0 ? Infinity : 0);
  const concentration = Number(stats.profitConcentration) || 0;

  const components = [
    { key: 'winRate', label: '胜率', weight: 15, fullMarks: '60%',
      value: stats.winRate, text: `${(stats.winRate * 100).toFixed(1)}%`,
      score: clamp01(stats.winRate / 0.6) },
    { key: 'profitFactor', label: '盈亏比', weight: 25, fullMarks: '3.0',
      value: pf, text: pf === Infinity ? '∞' : pf.toFixed(2),
      score: pf === Infinity ? 1 : clamp01(pf / 3) },
    { key: 'winLossRatio', label: '均盈/均亏', weight: 20, fullMarks: '2.5',
      value: winLossRatio, text: winLossRatio === Infinity ? '∞' : winLossRatio.toFixed(2),
      score: winLossRatio === Infinity ? 1 : clamp01(winLossRatio / 2.5) },
    { key: 'drawdown', label: '最大回撤', weight: 15, fullMarks: '0%',
      value: ddPct, text: `${(ddPct * 100).toFixed(1)}%`,
      score: ddBlind ? 0 : clamp01(1 - ddPct / 0.25) },
    { key: 'recovery', label: '恢复因子', weight: 10, fullMarks: '3×',
      value: recovery, text: recovery === Infinity ? '∞' : recovery.toFixed(2),
      score: recovery === Infinity ? 1 : clamp01(recovery / 3) },
    { key: 'consistency', label: '盈利一致性', weight: 15, fullMarks: '≤15% 集中度',
      value: concentration, text: `${(concentration * 100).toFixed(0)}%`,
      score: clamp01((1 - concentration) / (1 - 0.15)) },
  ];

  const raw = components.reduce((a, c) => a + c.score * c.weight, 0);
  return {
    version: EDGE_SCORE_VERSION,
    score: Math.round(raw * 100) / 100,
    reason: null,
    components,
  };
}
