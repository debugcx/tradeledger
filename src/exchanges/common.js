/**
 * 交易所适配器公共工具：成交配对、时间窗、符号归一化。
 */

export { matchFills } from '../fills.js';

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function msToIso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 从各交易所的合约名提取 BTC/USDT 形式 */
export function toSymbol(raw, quoteHint = '') {
  let s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  s = s.replace(/-OFF\d{6,8}-\d+$/i, '').replace(/-OFF.*$/i, '');
  s = s.replace(/-SWAP$/i, '').replace(/[-_]/g, '/');
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
  }
  const quotes = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
  for (const q of quotes) {
    if (quoteHint && q !== quoteHint) continue;
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}/${q}`;
  }
  return s;
}

export function normalizeOrderType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'other';
  if (s.includes('market') || s.includes('市价')) return 'market';
  if (s.includes('limit') || s.includes('限价')) return 'limit';
  return 'other';
}

/** 把 [fromMs, toMs] 切成长度 windowMs 的窗口，新的在前 */
export function windowsDescending(fromMs, toMs, windowMs) {
  const out = [];
  let end = toMs;
  let guard = 0;
  while (end > fromMs && guard < 500) {
    const start = Math.max(fromMs, end - windowMs);
    out.push({ from: start, to: end });
    end = start - 1;
    guard++;
  }
  return out;
}

export const SPOT_QUOTES = new Set(['USDT', 'USDC', 'USD']);

export function splitPair(symbol) {
  const parts = String(symbol || '').split('/');
  return { base: parts[0] || '', quote: parts[1] || '' };
}

export function isSupportedSpotSymbol(symbol) {
  const { base, quote } = splitPair(symbol);
  return Boolean(base) && SPOT_QUOTES.has(quote);
}

/** 把手续费换算成计价币（quote）；返回正数成本 */
export function quoteFee(fee, feeAsset, base, quote, price) {
  const amount = Math.abs(num(fee));
  if (!amount) return 0;
  const asset = String(feeAsset || '').toUpperCase();
  if (asset === String(quote).toUpperCase()) return amount;
  if (asset === String(base).toUpperCase()) return amount * (num(price) || 0);
  return 0;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
