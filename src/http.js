/**
 * HTTP 无关的工具函数：转义、Cookie、格式化、时间。
 * 全部为纯函数，方便单元测试。
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* 非法 cookie 忽略 */ }
  }
  return out;
}

export const nowIso = () => new Date().toISOString();

export const uid = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function fmtMoney(v, { sign = true, decimals = 2, prefix = '$' } = {}) {
  const n = Number(v) || 0;
  const pre = n > 0 && sign ? '+' : n < 0 ? '-' : '';
  return `${pre}${prefix}${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function fmtNum(v, decimals = 0) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(v, decimals = 2) {
  return `${((Number(v) || 0) * 100).toFixed(decimals)}%`;
}

export function fmtPrice(v) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** 列表用的紧凑时长：5天16时 / 2时8分 / 19分44秒 */
export function fmtDurationShort(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function fmtDuration(ms) {  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天 ${h}小时 ${m}分`;
  if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

export const fmtDateTime = (iso) => fmtDate(iso, true);

/** <input type="datetime-local"> 需要的本地时间串 */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地 datetime-local → UTC ISO；非法返回 null */
export function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 常量时间比较，避免计时侧信道 */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''));
  const y = new TextEncoder().encode(String(b ?? ''));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/* ---------------- 请求体限长 ----------------
 * Request.formData()/json() 会先把整个请求缓冲进内存；这里先按流式读取并
 * 在超过上限时立即取消，避免无 Content-Length 的 chunked 请求绕过检查。
 */

export async function readBodyLimited(req, maxBytes, label = '请求体') {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`${label}超过大小限制`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 已取消 */ }
        throw new Error(`${label}超过大小限制`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readFormDataLimited(req, maxBytes, label = '表单') {
  const body = await readBodyLimited(req, maxBytes, label);
  if (!body.byteLength) return new FormData();
  const capped = new Request(req.url, { method: req.method, headers: req.headers, body });
  return capped.formData();
}

export async function readJsonLimited(req, maxBytes, label = 'JSON 请求体') {
  const body = await readBodyLimited(req, maxBytes, label);
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSON 格式不正确');
  }
}
