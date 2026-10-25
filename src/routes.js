/**
 * 路由层：只负责解析请求、调用 store/stats、渲染页面。
 */

import fs from 'node:fs';
import { config } from './config.js';
import { dbSizeBytes } from './db.js';
import { escapeHtml, localInputToIso, uid, fmtNum } from './http.js';
import * as auth from './auth.js';
import * as store from './store.js';
import * as backup from './backup.js';
import { analyze, filterTrades } from './stats.js';
import { renderMarkdown } from './markdown.js';
import { aiSettingsPage } from './views/ai.js';
import {
  getLlmConfig, saveLlmConfig, callLlm, LLM_PRESETS,
} from './llm.js';
import {
  parseCsvSmart, autoMap, mappingFromForm, buildTrades, buildTradesFromFills,
  validateMapping, FIELD_DEFS, mappingFromTemplate, templateFromMapping,
  detectPreset, detectMode, decodeCsvBuffer,
} from './csv.js';
import { page } from './views/layout.js';
import { loginPage } from './views/auth.js';
import { dashboardPage } from './views/dashboard.js';
import { journalPage, journalCreatePage, journalEditPage, tradeDetailPage } from './views/journal.js';
import { calendarPage } from './views/calendar.js';
import { importPage, importPreviewPage } from './views/import.js';
import { accountsPage, accountNewPage, accountEditPage } from './views/accounts.js';
import { reconcilePage } from './views/reconcile.js';
import { reportPage, savedReportPage, aiReportsPage } from './views/review.js';
import { transfersPage } from './views/transfers.js';
import { botsPage } from './views/bots.js';
import { spotPage } from './views/spot.js';
import { spotSymbolPage } from './views/spot-symbol.js';
import { tagsPage } from './views/tags.js';
import { notesPage, noteViewPage, noteEditPage, symbolNotePage } from './views/notes.js';
import { settingsPage } from './views/settings.js';
import { exchangeMeta, getExchange } from './exchanges/index.js';
import { syncAccount, isSyncing } from './sync.js';
import { classifyOrderType } from './fills.js';
import { refreshLive, liveSnapshot } from './live.js';
import { reconcileTrades } from './reconcile.js';
import {
  buildPeriodReview, reviewMarkdown, reportPrompt, formatWeek, isoWeekOf, shiftWeek,
  parsePeriod, periodRange, shiftMonth, monthOf, yearOf,
} from './review.js';

const PAGE_SIZE = 50;

/* ---------------- 响应 helper ---------------- */

const html = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
});

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

const redirect = (location, status = 302, headers = {}) => new Response(null, {
  status,
  headers: { location, ...headers },
});

/* ---------------- 表单 ---------------- */

async function readForm(req) {
  const out = {};
  try {
    const fd = await req.formData();
    for (const [key, value] of fd.entries()) {
      let v;
      if (typeof value === 'string') {
        v = value;
      } else if (value && typeof value.text === 'function') {
        if (Number(value.size) > config.maxCsvBytes) throw new Error('上传文件超过 8MB 限制');
        out[`${key}__filename`] = String(value.name || '');
        v = decodeCsvBuffer(await value.arrayBuffer());
      } else {
        v = '';
      }
      if (key in out) out[key] = Array.isArray(out[key]) ? [...out[key], v] : [out[key], v];
      else out[key] = v;
    }
  } catch (err) {
    if (/超过 8MB/.test(err?.message || '')) throw err;
    // 空表单 / 非表单请求
  }
  return out;
}

const val = (body, key, fallback = '') => {
  const raw = body[key];
  if (raw === undefined) return fallback;
  return Array.isArray(raw) ? raw[raw.length - 1] : raw;
};

function backupForm(body) {
  return {
    localEnabled: val(body, 'local_enabled') === '1',
    localIntervalHours: val(body, 'local_interval_hours'),
    localKeep: val(body, 'local_keep'),
    webdavEnabled: val(body, 'webdav_enabled') === '1',
    webdavUrl: val(body, 'webdav_url'),
    webdavUsername: val(body, 'webdav_username'),
    webdavPassword: val(body, 'webdav_password'),
    clearWebdavPassword: val(body, 'clear_webdav_password') === '1',
    webdavDir: val(body, 'webdav_dir'),
    intervalHours: val(body, 'interval_hours'),
    keep: val(body, 'keep'),
    passphrase: val(body, 'passphrase'),
    clearPassphrase: val(body, 'clear_passphrase') === '1',
  };
}

function backupRedirect(notice, error) {
  const key = error ? 'error' : 'notice';
  return redirect('/dashboard/settings?' + key + '=' + encodeURIComponent(error || notice));
}

/** 图片上传：单独读二进制，不能走 readForm 的文本路径 */
async function readUpload(req) {
  const fd = await req.formData();
  const file = fd.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('没有选择图片');
  if (!file.size) throw new Error('图片为空');
  if (file.size > 5 * 1024 * 1024) throw new Error('图片超过 5MB');
  const mime = String(file.type || '');
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) {
    throw new Error('只支持 PNG / JPEG / GIF / WebP');
  }
  const data = Buffer.from(await file.arrayBuffer());
  return { name: String(file.name || 'image').slice(0, 200), mime, size: data.length, data };
}

const list = (body, key) => {
  const raw = body[key];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((x) => String(x));
};

function dateBound(value, endOfDay = false) {
  if (!value) return '';
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/* ---------------- 迷你路由 ---------------- */

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, regex, keys, handler });
};

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

function clientIp(req) {
  return req.headers.get('cf-connecting-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'local';
}

function isSecure(req) {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try { return new URL(req.url).protocol === 'https:'; } catch { return false; }
}

function ctxOf(req, params) {
  const url = new URL(req.url);
  return {
    req,
    url,
    params,
    query: Object.fromEntries(url.searchParams),
    user: auth.currentUser(req),
    ip: clientIp(req),
  };
}

function requireUser(ctx, next) {
  if (!ctx.user) {
    return redirect(`/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
  }
  return next(ctx);
}

function safeNext(raw) {
  const value = String(raw || '');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '';
  return value;
}

/* =========================================================
 *  认证
 * ========================================================= */

route('GET', '/', () => redirect('/dashboard'));

route('GET', '/login', (ctx) => {
  if (ctx.user) return redirect('/dashboard');
  const limit = auth.rateLimit(ctx.ip);
  return html(loginPage({
    next: safeNext(ctx.query.next),
    error: limit.blocked ? `尝试次数过多，请 ${limit.retryAfterSec} 秒后再试` : (ctx.query.error || ''),
    dev: auth.isDevPassword(),
  }), limit.blocked ? 429 : 200);
});

route('POST', '/login', async (ctx) => {
  const limit = auth.rateLimit(ctx.ip);
  if (limit.blocked) {
    return html(loginPage({ error: `尝试次数过多，请 ${limit.retryAfterSec} 秒后再试`, dev: auth.isDevPassword() }), 429);
  }
  const body = await readForm(ctx.req);
  const password = val(body, 'password');
  const next = safeNext(val(body, 'next'));
  const remember = val(body, 'remember') === '1' || val(body, 'remember') === 'on';

  if (!auth.verifyPassword(password)) {
    auth.recordFailure(ctx.ip);
    return html(loginPage({ next, error: password ? '密码错误' : '请输入访问密码', dev: auth.isDevPassword() }), 401);
  }
  auth.clearFailures(ctx.ip);
  const session = auth.login({ remember });
  return redirect(next || '/dashboard', 302, {
    'Set-Cookie': auth.cookieFor(session.token, session.maxAge, isSecure(ctx.req)),
  });
});

route('POST', '/logout', (ctx) => {
  auth.logout(ctx.req);
  return redirect('/', 302, { 'Set-Cookie': auth.clearCookie() });
});

/* =========================================================
 *  仪表盘
 * ========================================================= */

function allTrades() {
  return store.listTrades();
}

/** 账户同步进度：用「已回溯到的最旧交易」占 180 天窗口的比例近似 */
function accountProgress() {
  const out = {};
  for (const row of store.accountTradeStats()) {
    let state = {};
    try { state = JSON.parse(row.sync_state || '{}'); } catch { state = {}; }
    const pending = Boolean(row.sync_state);
    let progress = row.sync_done && !pending ? 1 : 0;
    if (pending && state.fromMs && state.toMs) {
      const span = Number(state.toMs) - Number(state.fromMs);
      const oldest = Date.parse(row.oldest_close || '');
      if (span > 0 && oldest) progress = Math.min(0.98, Math.max(0.02, (Number(state.toMs) - oldest) / span));
      else progress = 0.02;
    }
    const pct = Math.round(progress * 100);
    const label = row.sync_done && !pending
      ? `已完成 · ${fmtNum(row.trades)} 笔`
      : state.mode === 'incremental'
        ? `补拉最近成交 · ${fmtNum(row.trades)} 笔`
        : row.sync_state
          ? `回溯中 ${pct}% · ${fmtNum(row.trades)} 笔${row.oldest_close ? ` · 最旧 ${String(row.oldest_close).slice(0, 10)}` : ''}`
          : '等待自动同步';
    out[row.id] = {
      progress,
      pct,
      label,
      trades: row.trades,
      oldest: row.oldest_close,
      batches: Number(state.batches || 0),
      syncDone: Boolean(row.sync_done),
      pending,
      syncing: isSyncing(row.id),
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status,
    };
  }
  return out;
}

route('GET', '/dashboard', (ctx) => requireUser(ctx, (c) => {
  const market = ['all', 'futures', 'spot'].includes(c.query.market) ? c.query.market : 'all';
  const accounts = store.listAccounts();
  const accountId = accounts.some((a) => String(a.id) === String(c.query.account_id || '')) ? Number(c.query.account_id) : null;
  let all = allTrades();
  if (accountId) all = all.filter((t) => t.account_id === accountId);
  const trades = market === 'all' ? all : all.filter((t) => (t.market || 'futures') === market);
  const stats = analyze(trades);
  return html(page({
    title: '仪表盘 | TradeLedger',
    user: c.user,
    body: dashboardPage({
      user: c.user,
      stats,
      trades,
      market,
      accountId,
      accounts,
      balances: store.listBalances(accountId),
      positions: store.listPositions(accountId),
      spotBalances: store.listSpotBalances(accountId),
      spotHoldings: store.listSpotHoldings(accountId),
      funding: store.fundingSummary(accountId),
      rebates: store.rebateSummary(accountId),
      reviewQueue: store.listReviewQueue({
        threshold: -Math.max(30, (stats.avgLoss || 0) * 1.5),
        accountId,
        limit: 8,
      }),
      quickTags: (() => {
        const used = store.listTagsWithCounts();
        const names = used.map((x) => x.name);
        const defaults = ['追高', '逆势', '扛单', '计划内', '计划外'].filter((x) => !names.includes(x));
        return [...used.slice(0, 6).map((x) => ({ name: x.name, count: x.count, used: true })),
          ...defaults.slice(0, Math.max(0, 6 - used.length)).map((name) => ({ name, count: 0, used: false }))];
      })(),
      demo: store.demoStatus(),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

/* =========================================================
 *  盈亏日历
 * ========================================================= */

route('GET', '/dashboard/calendar', (ctx) => requireUser(ctx, (c) => {
  const now = new Date();
  const year = Math.min(Math.max(Number(c.query.year) || now.getFullYear(), 2000), 2100);
  const month = Math.min(Math.max(Number(c.query.month) || (now.getMonth() + 1), 1), 12);
  const accounts = store.listAccounts();
  const accountId = accounts.some((a) => String(a.id) === String(c.query.account_id || ''))
    ? Number(c.query.account_id) : null;
  let trades = allTrades();
  if (accountId) trades = trades.filter((t) => t.account_id === accountId);
  return html(page({
    title: '盈亏日历 | TradeLedger',
    user: c.user,
    body: calendarPage({
      user: c.user,
      trades,
      year,
      month,
      accounts,
      accountId,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

/* =========================================================
 *  交易记录
 * ========================================================= */

route('GET', '/dashboard/journal', (ctx) => requireUser(ctx, (c) => {
  const accounts = store.listAccounts();
  const accountId = accounts.some((a) => String(a.id) === String(c.query.account_id || '')) ? Number(c.query.account_id) : null;
  let all = allTrades();
  if (accountId) all = all.filter((t) => t.account_id === accountId);
  const notedCount = all.filter((t) => t.note && String(t.note).trim()).length;
  const stats = { noteCoverage: { total: all.length, noted: notedCount, ratio: all.length ? notedCount / all.length : 0 } };
  const filters = {
    account_id: accountId ? String(accountId) : 'all',
    market: c.query.market || 'all',
    side: c.query.side || 'all',
    result: c.query.result || 'all',
    symbol: c.query.symbol || 'all',
    orderType: c.query.orderType || 'all',
    tag: c.query.tag || '',
    note: c.query.note || 'all',
    from: c.query.from || '',
    to: c.query.to || '',
    q: c.query.q || '',
    sort: c.query.sort || 'time',
  };
  const filtered = filterTrades(all, {
    ...filters,
    from: dateBound(filters.from, false) || filters.from,
    to: dateBound(filters.to, true) || filters.to,
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageNo = Math.min(Math.max(Number(c.query.page) || 1, 1), totalPages);
  const trades = filtered.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
  const symbols = [...new Set(all.map((t) => t.symbol))].sort();
  return html(page({
    title: '交易记录 | TradeLedger',
    user: c.user,
    body: journalPage({
      user: c.user,
      trades,
      filters,
      accounts,
      tags: store.listTags(),
      symbols,
      pagination: { page: pageNo, pageSize: PAGE_SIZE, totalPages, total: filtered.length },
      noteCoverage: stats.noteCoverage,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

function parseTradeForm(body, { existing = null } = {}) {
  const openTime = localInputToIso(val(body, 'open_time')) || existing?.open_time;
  const closeTime = localInputToIso(val(body, 'close_time')) || existing?.close_time;
  if (!openTime || !closeTime) throw new Error('开仓/平仓时间格式不正确');
  if (new Date(openTime) > new Date(closeTime)) throw new Error('开仓时间不能晚于平仓时间');

  const side = val(body, 'side') === 'short' ? 'short' : 'long';
  const entry = Number(val(body, 'entry_price')) || 0;
  const exit = Number(val(body, 'exit_price')) || 0;
  const size = Number(val(body, 'size')) || 0;
  const fee = Number(val(body, 'fee')) || 0;
  const funding = Number(val(body, 'funding')) || 0;
  const pnlRaw = String(val(body, 'pnl')).trim();
  // pnl 是净盈亏：留空时按价差算毛盈亏，再把手续费/资金费加回去
  const pnl = pnlRaw === ''
    ? (exit - entry) * size * (side === 'short' ? -1 : 1) + fee + funding
    : Number(pnlRaw) || 0;
  const notional = Number(val(body, 'notional')) || Math.abs(entry * size);

  const picked = list(body, 'tags');
  const fresh = String(val(body, 'new_tags')).split(',').map((x) => x.trim()).filter(Boolean);
  const tags = [...new Set([...picked, ...fresh])];

  return {
    account_id: Number(val(body, 'account_id')) || undefined,
    symbol: String(val(body, 'symbol')).trim(),
    side,
    order_type: val(body, 'order_type') || 'market',
    open_time: openTime,
    close_time: closeTime,
    entry_price: entry,
    exit_price: exit,
    size,
    notional,
    pnl,
    fee,
    funding,
    note: String(val(body, 'note') || ''),
    tags,
  };
}

route('GET', '/dashboard/journal/new', (ctx) => requireUser(ctx, (c) => {
  let accounts = store.listAccounts();
  if (!accounts.length) accounts = [store.ensureDefaultAccount()];
  return html(page({
    title: '手动记录 | TradeLedger',
    user: c.user,
    body: journalCreatePage({
      user: c.user,
      accounts,
      tags: store.listTags(),
      error: c.query.error || '',
    }),
  }));
}));

route('POST', '/dashboard/journal/new', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    const input = parseTradeForm(body);
    const id = store.createTrade({ ...input, source: 'manual' }, { accountId: input.account_id });
    return redirect(`/dashboard/journal/${id}?notice=${encodeURIComponent('交易已保存')}`);
  } catch (err) {
    return html(page({
      title: '手动记录 | TradeLedger',
      user: c.user,
      body: journalCreatePage({
        user: c.user,
        accounts: store.listAccounts(),
        tags: store.listTags(),
        error: err.message || '保存失败',
      }),
    }), 400);
  }
}));

/** 交易详情缓存的关键字段指纹：交易被 amend（价格/数量/时间变化）后缓存自动失效 */
function detailCacheInputs(trade) {
  return [trade.entry_price, trade.exit_price, trade.size, trade.side, trade.open_time, trade.close_time].join('|');
}

/** 交易详情页的持仓盈亏曲线：优先读库（历史 K 线不可变），未命中再拉接口并落库 */
async function loadTradeCurve(trade) {
  const entry = Number(trade.entry_price) || 0;
  const size = Number(trade.size) || 0;
  const fromMs = Date.parse(trade.open_time || '');
  const toMs = Date.parse(trade.close_time || '');
  if (!entry || !size || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const inputs = detailCacheInputs(trade);
  const cached = store.getTradeCurveCache(trade.id);
  if (cached && cached.inputs === inputs && cached.candles?.length >= 2) {
    return { bar: cached.bar, candles: cached.candles, truncated: cached.truncated };
  }
  if (trade.account_is_demo) return { unsupported: '演示账户不拉取真实行情' };
  const adapter = getExchange(trade.account_exchange);
  if (!adapter || typeof adapter.fetchCandles !== 'function') {
    return { unsupported: `${adapter ? adapter.name : trade.account_exchange} 暂不支持行情拉取（当前支持 OKX）` };
  }
  try {
    const res = await adapter.fetchCandles({
      symbol: trade.symbol, market: trade.market || 'futures', fromMs, toMs,
      creds: store.getAccountCredentials(trade.account_id), // Gate 的 K 线接口也要签名
    });
    if (!res?.candles || res.candles.length < 2) return { unsupported: '该持仓区间没有可用的 K 线数据' };
    const result = { bar: res.bar, candles: res.candles, truncated: Boolean(res.truncated) };
    store.saveTradeCurveCache(trade.id, inputs, result);
    return result;
  } catch (err) {
    return { unsupported: `行情拉取失败：${String(err?.message || err).slice(0, 90)}` };
  }
}

/** 交易详情页的操作明细：该回合的逐笔成交（开仓/加仓/减仓/做T），同样落库缓存 */
async function loadTradeFills(trade) {
  const fromMs = Date.parse(trade.open_time || '');
  const toMs = Date.parse(trade.close_time || '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const inputs = detailCacheInputs(trade);
  const cached = store.getTradeFillsCache(trade.id);
  if (cached && cached.inputs === inputs && cached.fills?.length) {
    return { fills: cached.fills };
  }
  if (trade.account_is_demo) return { unsupported: '演示账户不拉取真实成交明细' };
  const adapter = getExchange(trade.account_exchange);
  if (!adapter || typeof adapter.fetchEpisodeFills !== 'function') {
    return { unsupported: `${adapter ? adapter.name : trade.account_exchange} 暂不支持成交明细拉取（当前支持 OKX）` };
  }
  try {
    const res = await adapter.fetchEpisodeFills({
      creds: store.getAccountCredentials(trade.account_id),
      symbol: trade.symbol,
      market: trade.market || 'futures',
      fromMs,
      toMs: toMs + 60_000, // 仓位历史的平仓时间戳可能略晚于最后一笔成交
    });
    if (!res?.fills?.length) {
      return { unsupported: res?.reason || '该区间没有拉到逐笔成交' };
    }
    // 顺手用逐笔的吃挂标记给回合分类（OKX execType / 币安 maker / HL crossed）
    if (trade.order_type === 'other' && res.fills.some((f) => f.execType || f.orderType)) {
      const orderType = classifyOrderType(res.fills);
      if (orderType !== 'other') store.setTradeOrderType(trade.id, orderType);
    }
    store.saveTradeFillsCache(trade.id, inputs, res.fills);
    return { fills: res.fills };
  } catch (err) {
    return { unsupported: `成交明细拉取失败：${String(err?.message || err).slice(0, 90)}` };
  }
}

route('GET', '/dashboard/journal/:id', (ctx) => requireUser(ctx, async (c) => {
  const trade = store.getTrade(c.params.id);
  if (!trade) return redirect('/dashboard/journal?error=' + encodeURIComponent('交易记录不存在'));
  const [curve, ops] = await Promise.all([loadTradeCurve(trade), loadTradeFills(trade)]);
  return html(page({
    title: `${trade.symbol} | TradeLedger`,
    user: c.user,
    body: tradeDetailPage({
      user: c.user,
      trade,
      curve,
      ops,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/journal/:id/edit', (ctx) => requireUser(ctx, (c) => {
  const trade = store.getTrade(c.params.id);
  if (!trade) return redirect('/dashboard/journal?error=' + encodeURIComponent('交易记录不存在'));
  return html(page({
    title: `编辑 ${trade.symbol} | TradeLedger`,
    user: c.user,
    body: journalEditPage({
      user: c.user,
      trade,
      accounts: store.listAccounts(),
      tags: store.listTags(),
    }),
  }));
}));

route('POST', '/dashboard/journal/:id/edit', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const id = Number(c.params.id);
  try {
    const input = parseTradeForm(body, { existing: store.getTrade(id) });
    store.updateTrade(id, input);
    return redirect(`/dashboard/journal/${id}?notice=${encodeURIComponent('已保存')}`);
  } catch (err) {
    const trade = store.getTrade(id);
    if (!trade) return redirect('/dashboard/journal?error=' + encodeURIComponent('交易记录不存在'));
    return html(page({
      title: `编辑 ${trade.symbol} | TradeLedger`,
      user: c.user,
      body: journalEditPage({
        user: c.user,
        trade,
        accounts: store.listAccounts(),
        tags: store.listTags(),
        error: err.message || '保存失败',
      }),
    }), 400);
  }
}));

route('POST', '/dashboard/journal/:id/delete', (ctx) => requireUser(ctx, (c) => {
  store.deleteTrade(Number(c.params.id));
  return redirect('/dashboard/journal?notice=' + encodeURIComponent('交易已删除'));
}));

route('POST', '/dashboard/journal/:id/note', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  store.setTradeNote(Number(c.params.id), String(val(body, 'note')));
  return redirect(`/dashboard/journal/${c.params.id}?notice=${encodeURIComponent('复盘已保存')}`);
}));

/** 快捷标签切换：仪表盘复盘队列行内按钮用，改完回到原页面 */
route('POST', '/dashboard/journal/:id/tag', (ctx) => requireUser(ctx, async (c) => {
  const trade = store.getTrade(c.params.id);
  if (!trade) return redirect('/dashboard');
  const body = await readForm(c.req);
  const name = String(val(body, 'tag') || '').slice(0, 30).trim();
  if (name) store.toggleTradeTag(Number(c.params.id), name);
  const back = String(val(body, 'back') || '/dashboard');
  return redirect(back.startsWith('/dashboard') ? back : '/dashboard');
}));

route('POST', '/api/trades/:id/note', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const body = await readForm(ctx.req);
  try {
    store.setTradeNote(Number(ctx.params.id), String(val(body, 'note')));
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: err.message || '保存失败' }, 400);
  }
});

/* =========================================================
 *  CSV 导入
 * ========================================================= */

route('GET', '/dashboard/import', (ctx) => requireUser(ctx, (c) => {
  let accounts = store.listAccounts();
  if (!accounts.length) accounts = [store.ensureDefaultAccount()];
  return html(page({
    title: 'CSV 导入 | TradeLedger',
    user: c.user,
    body: importPage({
      user: c.user,
      accounts,
      imports: store.listImports(20),
      templates: store.listImportTemplates(),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('POST', '/dashboard/import', (ctx) => requireUser(ctx, async (c) => {
  let body;
  try {
    body = await readForm(c.req);
  } catch (err) {
    return html(page({
      title: 'CSV 导入 | TradeLedger',
      user: c.user,
      body: importPage({
        user: c.user, accounts: store.listAccounts(), imports: store.listImports(20),
        error: err.message,
      }),
    }), 400);
  }

  const step = val(body, 'step', 'preview');
  let accounts = store.listAccounts();
  if (!accounts.length) {
    store.ensureDefaultAccount();
    accounts = store.listAccounts();
  }
  const accountId = Number(val(body, 'account_id')) || accounts[0]?.id;
  const tzOffset = Number(val(body, 'tz_offset') || 0);
  const costPositive = ['1', 'on', 'true'].includes(String(val(body, 'cost_positive')));
  const rawText = String(val(body, 'file') || val(body, 'csv_text') || '');
  const filename = String(val(body, 'file__filename') || '');

  const fail = (message) => html(page({
    title: 'CSV 导入 | TradeLedger',
    user: c.user,
    body: importPage({
      user: c.user, accounts, imports: store.listImports(20),
      templates: store.listImportTemplates(), error: message,
    }),
  }), 400);

  if (!rawText.trim()) return fail('没有读到 CSV 内容：请上传文件或粘贴文本');
  if (Buffer.byteLength(rawText, 'utf8') > config.maxCsvBytes) return fail('CSV 超过 8MB 限制');

  const parsed = parseCsvSmart(rawText);
  if (!parsed.rows.length) return fail('CSV 里没有数据行（没有找到表头或数据）');
  if (parsed.rows.length > config.maxCsvRows) return fail(`超过 ${config.maxCsvRows} 行上限，请拆分文件`);
  const preset = detectPreset(parsed.headers);
  const market = val(body, 'market') === 'spot' ? 'spot' : 'futures';

  const hasSubmittedMapping = FIELD_DEFS.some((f) => body[`map_${f.key}`] !== undefined);
  const templateId = Number(val(body, 'template_id')) || null;
  const selectedTemplate = templateId ? store.getImportTemplate(templateId) : null;
  let mapping;
  if (hasSubmittedMapping) {
    mapping = mappingFromForm(body);
  } else if (selectedTemplate) {
    let template = {};
    try { template = JSON.parse(selectedTemplate.mapping || '{}'); } catch { template = {}; }
    mapping = mappingFromTemplate(parsed.headers, template);
  } else {
    mapping = autoMap(parsed.headers);
  }
  let mode = String(val(body, 'mode') || 'auto');
  if (mode !== 'fills' && mode !== 'roundtrip') mode = detectMode(parsed.headers, mapping);
  const mappingErrors = validateMapping(mapping, parsed.headers, mode);
  const { trades, errors } = mode === 'fills'
    ? buildTradesFromFills(parsed.headers, parsed.rows, mapping, { tzOffset, costPositive, lineOffset: parsed.headerIndex, market })
    : buildTrades(parsed.headers, parsed.rows, mapping, { tzOffset, costPositive, defaultSide: 'long', lineOffset: parsed.headerIndex, market });
  const headerInfo = {
    headerIndex: parsed.headerIndex,
    skippedRows: parsed.skippedRows,
    delimiter: parsed.delimiter,
  };

  if (step === 'commit') {
    if (mappingErrors.length) {
      return html(page({
        title: '导入预览 | TradeLedger',
        user: c.user,
        body: importPreviewPage({
          user: c.user, headers: parsed.headers, mapping, trades, errors,
          rawText, accountId, tzOffset, costPositive, templateId, mode, preset, headerInfo, market,
          error: mappingErrors.join('；'),
        }),
      }), 400);
    }
    if (!trades.length) {
      return html(page({
        title: '导入预览 | TradeLedger',
        user: c.user,
        body: importPreviewPage({
          user: c.user, headers: parsed.headers, mapping, trades, errors,
          rawText, accountId, tzOffset, costPositive, templateId, mode, preset, headerInfo, market,
          error: mode === 'fills'
            ? '逐笔成交模式下没有配对出已平仓交易：请确认文件同时包含开仓和平仓成交，或改用「已平仓交易」模式/交易所的已平仓报表。'
            : `没有可导入的行${errors.length ? `（${errors.length} 行解析失败）` : ''}`,
        }),
      }), 400);
    }
    try {
      const result = store.importTrades(trades, accountId);
      store.recordImport({
        accountId, filename, rows: parsed.rows.length,
        inserted: result.inserted, skipped: result.skipped, failed: errors.length,
      });
      let templateNote = '';
      const templateName = String(val(body, 'template_name') || '').trim();
      if (templateName) {
        try {
          store.saveImportTemplate(templateName, templateFromMapping(parsed.headers, mapping));
          templateNote = `；映射模板「${templateName}」已保存`;
        } catch (e) {
          templateNote = `；模板保存失败：${e.message}`;
        }
      }
      const msg = `导入完成：写入 ${result.inserted} 笔，跳过重复 ${result.skipped} 笔`
        + (errors.length ? `，${errors.length} 行解析失败` : '') + templateNote;
      return redirect('/dashboard/import?notice=' + encodeURIComponent(msg));
    } catch (err) {
      return fail(`导入失败：${err.message || err}`);
    }
  }

  return html(page({
    title: '导入预览 | TradeLedger',
    user: c.user,
    body: importPreviewPage({
      user: c.user, headers: parsed.headers, mapping, trades, errors,
      rawText, accountId, tzOffset, costPositive, templateId, mode, preset, headerInfo, market,
      error: mappingErrors.join('；'),
    }),
  }));
}));

route('POST', '/dashboard/import/templates/delete', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  store.deleteImportTemplate(Number(val(body, 'id')));
  return redirect('/dashboard/import?notice=' + encodeURIComponent('映射模板已删除'));
}));

/* =========================================================
 *  现货
 * ========================================================= */

route('GET', '/dashboard/spot', (ctx) => requireUser(ctx, (c) => html(page({
  title: '现货 | TradeLedger',
  user: c.user,
  body: spotPage({
    user: c.user,
    balances: store.listSpotBalances(),
    holdings: store.listSpotHoldings(),
    fills: store.listSpotFills({ limit: 200 }),
    spotTrades: store.listSpotTrades(50),
    notice: c.query.notice || '',
    error: c.query.error || '',
  }),
}))));

route('POST', '/api/spot/note', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  try {
    const body = await readForm(ctx.req);
    const accountId = Number(val(body, 'account_id'));
    const symbol = String(val(body, 'symbol') || '').trim();
    const note = String(val(body, 'note') || '');
    if (!accountId || !symbol) return json({ ok: false, error: '参数不完整' }, 400);
    const id = store.saveSpotNote(accountId, symbol, note);
    return json({ ok: true, id });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 400);
  }
});

route('POST', '/dashboard/spot/note', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const accountId = Number(val(body, 'account_id'));
  const symbol = String(val(body, 'symbol') || '');
  const note = String(val(body, 'note') || '');
  const back = `/dashboard/spot/symbol/${encodeURIComponent(symbol)}`;
  try {
    if (val(body, 'open_new') === '1') {
      const id = store.openNewSpotNote(accountId, symbol);
      return redirect(`/dashboard/notes/${id}/edit`);
    }
    const id = store.saveSpotNote(accountId, symbol, note);
    return redirect(`${back}?notice=` + encodeURIComponent('现货备注已保存'));
  } catch (err) {
    return redirect(`${back}?error=` + encodeURIComponent(err?.message || String(err)));
  }
}));

route('GET', '/dashboard/spot/symbol/:symbol', (ctx) => requireUser(ctx, (c) => {
  const symbol = String(c.params.symbol || '');
  if (!symbol) return redirect('/dashboard/spot');
  return html(page({
    title: `${symbol} 现货详情 | TradeLedger`,
    user: c.user,
    body: spotSymbolPage({
      user: c.user,
      symbol,
      holdings: store.listSpotHoldings(null, symbol),
      fills: store.listSpotFills({ symbol, limit: 2000 }),
      trades: store.listSpotTradesBySymbol(symbol, 200),
      transfers: store.listTransfers({ asset: symbol.split('/')[0] || symbol, limit: 200 }),
      archiveNote: store.getNoteByCategory('symbol', symbol),
      spotNotes: store.listNotes({ category: 'spot', subject: symbol }),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/bots', (ctx) => requireUser(ctx, (c) => {
  const accounts = store.listAccounts();
  const accountId = accounts.some((a) => String(a.id) === String(c.query.account_id || ''))
    ? Number(c.query.account_id) : null;
  const bots = store.listBotTrades(accountId);
  return html(page({
    title: '策略机器人 | TradeLedger',
    user: c.user,
    body: botsPage({
      user: c.user,
      bots,
      accounts,
      accountId,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

/* =========================================================
 *  资金流水
 * ========================================================= */

route('GET', '/dashboard/transfers', (ctx) => requireUser(ctx, (c) => {
  const filters = {
    account_id: c.query.account_id || 'all',
    type: c.query.type || 'all',
    asset: c.query.asset || 'all',
    from: c.query.from || '',
    to: c.query.to || '',
  };
  const transfers = store.listTransfers({
    accountId: filters.account_id !== 'all' ? Number(filters.account_id) : null,
    type: filters.type,
    asset: filters.asset,
    from: dateBound(filters.from, false) || filters.from,
    to: dateBound(filters.to, true) || filters.to,
    limit: 500,
  });
  return html(page({
    title: '资金流水 | TradeLedger',
    user: c.user,
    body: transfersPage({
      user: c.user,
      transfers,
      summary: store.transferSummary(),
      filters,
      accounts: store.listAccounts().filter((a) => !a.is_demo),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

/* =========================================================
 *  交易所账户与同步
 * ========================================================= */

route('GET', '/dashboard/accounts', (ctx) => requireUser(ctx, (c) => {
  const accounts = store.listAccounts();
  const all = allTrades();
  return html(page({
    title: '交易所 | TradeLedger',
    user: c.user,
    body: accountsPage({
      user: c.user,
      accounts,
      meta: exchangeMeta,
      runs: store.listSyncRuns(null, 20),
      accountStats: accountProgress(),
      stats: {
        apiTrades: all.filter((t) => t.source === 'api').length,
        syncRuns: store.statsOverview().syncRuns,
      },
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/accounts/new', (ctx) => requireUser(ctx, (c) => {
  const selected = getExchange(c.query.exchange) ? c.query.exchange : 'okx';
  return html(page({
    title: '添加交易所 | TradeLedger',
    user: c.user,
    body: accountNewPage({ user: c.user, meta: exchangeMeta, selected }),
  }));
}));

route('POST', '/dashboard/accounts/new', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const exchange = String(val(body, 'exchange')).toLowerCase();
  const ex = getExchange(exchange);
  const fail = (message) => html(page({
    title: '添加交易所 | TradeLedger',
    user: c.user,
    body: accountNewPage({
      user: c.user, meta: exchangeMeta, selected: ex ? ex.id : 'okx',
      form: { name: val(body, 'name'), wallet: val(body, 'wallet') },
      error: message,
    }),
  }), 400);
  if (!ex) return fail('暂不支持的交易所');

  const apiKey = String(val(body, 'api_key') || val(body, 'wallet')).trim();
  const apiSecret = String(val(body, 'api_secret')).trim();
  // Passphrase 必须原样发送：OKX 区分大小写，且可能包含首尾空格
  const passphrase = String(val(body, 'passphrase'));
  const missing = ex.fields.filter((f) => {
    const v = f.key === 'wallet' ? val(body, 'wallet') : val(body, f.key);
    return !String(v || '').trim();
  });
  if (missing.length) return fail('请填写完整的 API 信息');

  try {
    await ex.verify({ apiKey, apiSecret, passphrase, wallet: apiKey });
  } catch (err) {
    const raw = err?.message || String(err);
    console.error(`[account-verify] ${ex.id}: ${raw}`);
    if (/50105|PASSPHRASE/i.test(raw)) {
      return fail('Passphrase 不正确：请填写创建 OKX API 时单独设置的 Passphrase，区分大小写，它不是登录密码。');
    }
    if (/50111|Invalid OK-ACCESS-KEY/i.test(raw)) {
      return fail('API Key 无效：请确认复制的是 OKX 的 API Key，且没有多余空格。');
    }
    const network = /超时|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(raw);
    return fail(network
      ? `连接交易所超时/网络不可达：${raw}。请检查网络；程序会自动探测本机 7890/7897/10809/1080 代理，也可以在 .env 设置 HTTPS_PROXY（例如 http://127.0.0.1:7890）后重启。`
      : `连接失败：${raw}`);
  }

  store.createAccount({
    exchange: ex.id,
    name: String(val(body, 'name') || ex.name),
    apiKey, apiSecret, passphrase,
    lookbackDays: val(body, 'lookback_days'),
    spotSymbols: val(body, 'spot_symbols'),
  });
  return redirect('/dashboard/accounts?notice=' + encodeURIComponent(`${ex.name} 已接入，正在后台自动回溯历史；进度见账户列表`));
}));

route('GET', '/dashboard/accounts/:id/edit', (ctx) => requireUser(ctx, (c) => {
  const account = store.getAccount(c.params.id);
  if (!account || account.is_demo) return redirect('/dashboard/accounts');
  return html(page({
    title: `编辑 ${account.name} | TradeLedger`,
    user: c.user,
    body: accountEditPage({
      user: c.user,
      account,
      exchange: getExchange(account.exchange),
      error: c.query.error || '',
    }),
  }));
}));

route('POST', '/dashboard/accounts/:id/edit', (ctx) => requireUser(ctx, async (c) => {
  const id = Number(c.params.id);
  const account = store.getAccount(id);
  if (!account || account.is_demo) return redirect('/dashboard/accounts');
  const body = await readForm(c.req);
  const apiKey = String(val(body, 'api_key') || val(body, 'wallet') || '').trim();
  const previousLookback = account.lookback_days;
  const previousSpot = account.spot_symbols || '';
  try {
    store.updateAccount(id, {
      name: val(body, 'name'),
      apiKey,
      apiSecret: String(val(body, 'api_secret') || '').trim(),
      passphrase: String(val(body, 'passphrase') || ''),
      lookbackDays: val(body, 'lookback_days'),
      spotSymbols: val(body, 'spot_symbols'),
    });
  } catch (err) {
    return redirect('/dashboard/accounts?error=' + encodeURIComponent(err.message || '保存失败'));
  }
  const updated = store.getAccount(id);
  const norm = (v) => (v === null || v === undefined || v === '' ? 180 : Number(v));
  if (norm(previousLookback) !== norm(updated.lookback_days)) {
    store.resetAccountSync(id);
  }
  if (String(previousSpot) !== String(updated.spot_symbols || '')) {
    store.resetAccountSpotSync(id);
  }
  return redirect('/dashboard/accounts?notice=' + encodeURIComponent('账户已更新'));
}));

route('GET', '/api/accounts/status', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const stats = accountProgress();
  return json({
    accounts: Object.entries(stats).map(([id, s]) => ({ id: Number(id), ...s })),
    anySyncing: Object.values(stats).some((s) => !s.syncDone),
    updatedAt: new Date().toISOString(),
  });
});

route('GET', '/api/positions/live', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  try {
    const snapshot = ctx.query.force === '1'
      ? await refreshLive({ force: true })
      : liveSnapshot();
    return json(snapshot);
  } catch (err) {
    return json({ error: 'refresh_failed', message: err?.message || String(err) }, 500);
  }
});

route('POST', '/dashboard/accounts/:id/resync', (ctx) => requireUser(ctx, (c) => {
  const account = store.getAccount(c.params.id);
  if (!account || account.is_demo) return redirect('/dashboard/accounts');
  store.resetAccountSync(account.id);
  return redirect('/dashboard/accounts?notice=' + encodeURIComponent('已重置，后台会按当前回溯范围重新扫描（已有交易会去重保留）'));
}));

route('POST', '/dashboard/accounts/:id/delete', (ctx) => requireUser(ctx, (c) => {
  store.deleteAccount(Number(c.params.id));
  return redirect('/dashboard/accounts?notice=' + encodeURIComponent('账户已删除，已同步的交易保留'));
}));

route('POST', '/dashboard/accounts/:id/sync', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const body = await readForm(ctx.req);
  const limit = Math.min(Math.max(Number(val(body, 'limit')) || config.syncBatchLimit, 100), 5000);
  try {
    const result = await syncAccount(Number(ctx.params.id), { limit });
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: err?.message || '同步失败' }, 400);
  }
});

/* =========================================================
 *  对账
 * ========================================================= */

route('GET', '/dashboard/reconcile', (ctx) => requireUser(ctx, async (c) => {
  const report = reconcileTrades(allTrades());
  // 月度对账：应用内净盈亏 vs 交易所账本实结算（支持 fetchMonthlyLedger 的交易所）
  const monthly = [];
  for (const account of store.listAccounts().filter((a) => !a.is_demo)) {
    const adapter = getExchange(account.exchange);
    if (!adapter || typeof adapter.fetchMonthlyLedger !== 'function') continue;
    const entry = { account: { id: account.id, name: account.name, exchange: account.exchange }, rows: [] };
    try {
      const trades = allTrades().filter((t) => t.account_id === account.id);
      const byMonth = new Map();
      for (const t of trades) {
        const d = new Date(t.close_time);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        byMonth.set(key, (byMonth.get(key) || 0) + Number(t.pnl || 0));
      }
      const creds = store.getAccountCredentials(account.id);
      const res = await adapter.fetchMonthlyLedger({ creds, months: 6 });
      entry.rows = (res?.months || []).map((r) => {
        const app = byMonth.get(r.month) || 0;
        const exchangeNet = r.pnl + r.fee + r.fund;
        return { month: r.month, app, exchange: exchangeNet, diff: app - exchangeNet };
      }).reverse();
    } catch (err) {
      entry.error = String(err?.message || err).slice(0, 90);
    }
    monthly.push(entry);
  }
  return html(page({
    title: '对账 | TradeLedger',
    user: c.user,
    body: reconcilePage({
      user: c.user,
      report,
      monthly,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/api/reconcile', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  return json(reconcileTrades(allTrades()));
});

/* =========================================================
 *  周期报告 / AI 生成
 * ========================================================= */

function shiftPeriod(period) {
  if (period.kind === 'month') {
    return { ...shiftMonth({ year: period.year, month: period.month }, -1), kind: 'month' };
  }
  if (period.kind === 'year') {
    return { kind: 'year', year: period.year - 1 };
  }
  return { kind: 'week', ...shiftWeek({ year: period.year, week: period.week }, -1) };
}

route('GET', '/dashboard/review', (ctx) => requireUser(ctx, (c) => {
  const period = parsePeriod(c.query);
  const range = periodRange(period);
  const review = buildPeriodReview(allTrades(), period);
  const markdown = reviewMarkdown(review);

  const nextPeriod = (() => {
    if (period.kind === 'month') {
      const n = shiftMonth({ year: period.year, month: period.month }, 1);
      return { kind: 'month', ...n };
    }
    if (period.kind === 'year') return { kind: 'year', year: period.year + 1 };
    return { kind: 'week', ...shiftWeek({ year: period.year, week: period.week }, 1) };
  })();

  const saved = store.latestReportGeneration(period.kind, range.label);
  const llmCfg = getLlmConfig();
  return html(page({
    title: `${review.period.kindLabel} ${range.label} | TradeLedger`,
    user: c.user,
    body: reportPage({
      user: c.user,
      review,
      prev: { ...shiftPeriod(period), label: periodRange(shiftPeriod(period)).label },
      next: { ...nextPeriod, label: periodRange(nextPeriod).label },
      markdownPreview: markdown.slice(0, 12000),
      markdownTruncated: markdown.length > 12000,
      promptText: reportPrompt(review),
      savedReport: saved,
      history: store.listReportGenerations(period.kind, 20)
        .filter((h) => h.period_label === range.label),
      aiStatus: {
        hasKey: llmCfg.hasKey,
        provider: llmCfg.provider,
        modelLabel: `${llmCfg.provider} · ${llmCfg.model}`,
      },
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('POST', '/dashboard/review/ai', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const period = parsePeriod({
    kind: val(body, 'kind'),
    week: val(body, 'week'),
    month: val(body, 'month'),
    year: val(body, 'year'),
  });
  const range = periodRange(period);
  const prompt = String(val(body, 'prompt') || '').trim();
  if (!prompt) {
    return redirect(`/dashboard/review?${periodQuery(period)}&error=` + encodeURIComponent('提示词不能为空'));
  }
  const config = getLlmConfig({ withSecret: true });
  if (!config.hasKey && config.provider !== 'ollama') {
    return redirect(`/dashboard/review?${periodQuery(period)}&error=` + encodeURIComponent('请先在 设置与数据 → AI 模型 配置 API Key'));
  }

  // 提交即返回；生成在后台跑，前端轮询 /api/review/ai/status
  const job = store.createReportJob({ periodKind: period.kind, periodLabel: range.label, promptLen: prompt.length });
  const periodFrom = range.from.toISOString();
  const periodTo = range.to.toISOString();
  const trades = allTrades().filter((t) => t.close_time >= periodFrom && t.close_time <= periodTo).length;
  (async () => {
    try {
      const text = await callLlm({ messages: [{ role: 'user', content: prompt }], config, timeout: 300_000 });
      const reportId = store.saveReportGeneration({
        periodKind: period.kind,
        periodLabel: range.label,
        prompt,
        content: text,
        model: `${config.provider}/${config.model}`,
        trades,
      });
      store.updateReportJob(job.id, { status: 'done', finishedAt: new Date().toISOString(), reportId });
    } catch (err) {
      store.updateReportJob(job.id, {
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: String(err?.message || err).slice(0, 500),
      });
    }
  })().catch(() => {});

  return json({ ok: true, jobId: job.id, statusUrl: `/api/review/ai/status?job=${encodeURIComponent(job.id)}` });
}));

route('GET', '/api/review/ai/status', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const job = store.getReportJob(String(ctx.query.job || ''));
  if (!job) return json({ ok: false, error: '任务不存在或已被清理' }, 404);
  return json({ ok: true, job });
});

route('POST', '/dashboard/review/ai/save-note', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const report = store.getReportGeneration(Number(val(body, 'report_id') || 0));
  if (!report) return redirect('/dashboard/review/ai-reports?error=' + encodeURIComponent('生成记录不存在'));
  try {
    const title = String(val(body, 'title') || '').trim()
      || `AI ${report.period_kind === 'week' ? '周' : report.period_kind === 'month' ? '月' : '年'}报解读 ${report.period_label}`;
    const content = [
      `> 由 ${report.model || 'AI'} 于 ${report.created_at} 生成 · 周期 ${report.period_label} · ${report.trades} 笔交易`,
      '',
      report.content,
    ].join('\n');
    store.saveNote({
      title: title.slice(0, 200),
      content,
      category: 'ai-report',
      subject: report.period_label,
    });
    return redirect(`/dashboard/review/ai-reports?notice=` + encodeURIComponent(`已保存为笔记「${title.slice(0, 40)}」`));
  } catch (err) {
    return redirect('/dashboard/review/ai-reports?error=' + encodeURIComponent(err?.message || String(err)));
  }
}));

/** AI 报告专页：所有周期的生成记录 */
route('GET', '/dashboard/review/ai-reports', (ctx) => requireUser(ctx, (c) => {
  const generations = store.listReportGenerations(null, 50);
  return html(page({
    title: 'AI 报告 | TradeLedger',
    user: c.user,
    body: aiReportsPage({
      user: c.user,
      generations,
      report: c.query.id ? store.getReportGeneration(Number(c.query.id)) : null,
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

function periodQuery(period) {
  if (period.kind === 'month') return `kind=month&month=${encodeURIComponent(periodRange(period).label)}`;
  if (period.kind === 'year') return `kind=year&year=${period.year}`;
  return `kind=week&week=${encodeURIComponent(periodRange(period).label)}`;
}

route('GET', '/dashboard/review/history/:id', (ctx) => requireUser(ctx, (c) => {
  const report = store.getReportGeneration(Number(c.params.id));
  if (!report) return redirect('/dashboard/review');
  return html(page({
    title: `AI 报告 ${report.period_label} | TradeLedger`,
    user: c.user,
    body: savedReportPage({ user: c.user, report }),
  }));
}));

route('POST', '/dashboard/review/history/delete', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const id = Number(val(body, 'id') || c.params.id || 0);
  const report = store.getReportGeneration(id);
  store.deleteReportGeneration(id);
  return redirect(report
    ? `/dashboard/review?kind=${report.period_kind}&notice=` + encodeURIComponent('生成记录已删除')
    : '/dashboard/review');
}));

route('GET', '/api/review', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const period = parsePeriod(ctx.query);
  const review = buildPeriodReview(allTrades(), period);
  if (ctx.query.format === 'md') {
    return new Response(reviewMarkdown(review), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': ctx.query.download === '1'
          ? `attachment; filename="tradeledger-review-${review.period.label}.md"`
          : 'inline',
      },
    });
  }
  return json(review);
});

/* =========================================================
 *  AI 复盘（生成入口已合并到周期报告页）
 * ========================================================= */

route('GET', '/dashboard/ai', (ctx) => requireUser(ctx, () => redirect('/dashboard/review')));

route('POST', '/dashboard/ai/config', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  saveLlmConfig({
    provider: val(body, 'provider'),
    baseUrl: val(body, 'baseUrl'),
    model: val(body, 'model'),
    apiKey: String(val(body, 'apiKey') || '').trim(),
    temperature: val(body, 'temperature'),
    maxTokens: val(body, 'maxTokens'),
    systemPrompt: val(body, 'systemPrompt'),
  });
  return redirect('/dashboard/settings/ai?notice=' + encodeURIComponent('模型配置已保存'));
}));

route('GET', '/dashboard/settings/ai', (ctx) => requireUser(ctx, (c) => html(page({
  title: 'AI 模型 | TradeLedger',
  user: c.user,
  body: aiSettingsPage({
    user: c.user,
    config: getLlmConfig(),
    presets: LLM_PRESETS,
    notice: c.query.notice || '',
    error: c.query.error || '',
  }),
}))));

route('POST', '/api/ai/test', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  try {
    const config = getLlmConfig({ withSecret: true });
    const text = await callLlm({
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      config,
      timeout: 30_000,
    });
    return json({ ok: true, text: text.slice(0, 120) });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 400);
  }
});

route('POST', '/api/markdown', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const body = await readForm(ctx.req);
  return json({ ok: true, html: renderMarkdown(String(val(body, 'text') || '')) });
});

/* =========================================================
 *  标签 / 笔记
 * ========================================================= */

route('GET', '/dashboard/tags', (ctx) => requireUser(ctx, (c) => html(page({
  title: '标签 | TradeLedger',
  user: c.user,
  body: tagsPage({
    user: c.user,
    tags: store.listTags(),
    stats: analyze(allTrades()),
    error: c.query.error || '',
  }),
}))));

route('POST', '/dashboard/tags', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const name = String(val(body, 'name')).trim();
  if (name) store.createTag(name, String(val(body, 'color') || '#4ade80'));
  return redirect('/dashboard/tags');
}));

route('POST', '/dashboard/tags/delete', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  store.deleteTag(Number(val(body, 'id')));
  return redirect('/dashboard/tags');
}));

const NOTES_PAGE_SIZE = 24;

route('GET', '/dashboard/notes', (ctx) => requireUser(ctx, (c) => {
  const category = ['all', 'periodic', 'symbol', 'strategy', 'spot', 'ai-report', 'general'].includes(c.query.category)
    ? c.query.category
    : 'all';
  const q = String(c.query.q || '').trim().slice(0, 100);
  // 搜索模式下统一用卡片网格展示结果；交易对分类的专属布局只在无关键词时生效
  const searchable = Boolean(q) || category !== 'symbol';
  const all = store.listNotes({ category: category === 'all' ? null : category, q: q || null });
  const totalPages = searchable ? Math.max(1, Math.ceil(all.length / NOTES_PAGE_SIZE)) : 1;
  const pageNo = searchable ? Math.min(Math.max(Number(c.query.page) || 1, 1), totalPages) : 1;
  const notes = searchable ? all.slice((pageNo - 1) * NOTES_PAGE_SIZE, pageNo * NOTES_PAGE_SIZE) : all;
  return html(page({
    title: '笔记 | TradeLedger',
    user: c.user,
    body: notesPage({
      user: c.user,
      notes,
      counts: store.noteCountsByCategory(),
      category,
      q,
      pagination: { page: pageNo, pageSize: NOTES_PAGE_SIZE, totalPages, total: all.length },
      symbolTradeNotes: store.listSymbolsWithTradeNotes(),
      recentTradeNotes: store.listRecentTradeNotes(20),
      currentWeek: formatWeek(isoWeekOf()),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/notes/new', (ctx) => requireUser(ctx, (c) => {
  const category = ['periodic', 'symbol', 'strategy', 'ai-report', 'general'].includes(c.query.category)
    ? c.query.category
    : 'general';
  const subject = String(c.query.subject || '');
  if (category === 'symbol' && subject) {
    const existing = store.getNoteByCategory('symbol', subject);
    if (existing) return redirect(`/dashboard/notes/${existing.id}/edit`);
  }
  return html(page({
    title: '新建笔记 | TradeLedger',
    user: c.user,
    body: noteEditPage({
      user: c.user, note: null, category, subject,
      symbols: store.listSymbols(),
    }),
  }));
}));

route('GET', '/dashboard/notes/symbol/:symbol', (ctx) => requireUser(ctx, (c) => {
  const symbol = String(c.params.symbol || '');
  if (!symbol) return redirect('/dashboard/notes?category=symbol');
  return html(page({
    title: `${symbol} 交易对档案 | TradeLedger`,
    user: c.user,
    body: symbolNotePage({
      user: c.user,
      symbol,
      note: store.getNoteByCategory('symbol', symbol),
      tradeNotes: store.listTradeNotesBySymbol(symbol),
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/notes/:id', (ctx) => requireUser(ctx, (c) => {
  const note = store.getNote(Number(c.params.id));
  if (!note) return redirect('/dashboard/notes');
  return html(page({
    title: `${note.title} | TradeLedger`,
    user: c.user,
    body: noteViewPage({
      user: c.user,
      note,
      tradeNotes: note.category === 'symbol' ? store.listTradeNotesBySymbol(note.subject) : [],
      notice: c.query.notice || '',
      error: c.query.error || '',
    }),
  }));
}));

route('GET', '/dashboard/notes/:id/edit', (ctx) => requireUser(ctx, (c) => {
  const note = store.getNote(Number(c.params.id));
  if (!note) return redirect('/dashboard/notes');
  let holding = null;
  if (note.category === 'spot' && note.account_id && note.subject) {
    holding = store.listSpotHoldings(Number(note.account_id), note.subject)[0] || null;
  }
  return html(page({
    title: `编辑 ${note.title} | TradeLedger`,
    user: c.user,
    body: noteEditPage({ user: c.user, note, symbols: store.listSymbols(), holding }),
  }));
}));

route('POST', '/dashboard/notes/upload', async (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  try {
    const file = await readUpload(ctx.req);
    const id = uid();
    store.saveResource({ id, ...file });
    return json({ ok: true, url: `/media/${id}`, markdown: `![${file.name}](/media/${id})` });
  } catch (err) {
    return json({ ok: false, error: err?.message || '上传失败' }, 400);
  }
});

route('GET', '/media/:id', (ctx) => {
  if (!ctx.user) return new Response('unauthorized', { status: 401 });
  const resource = store.getResource(ctx.params.id);
  if (!resource) return new Response('not found', { status: 404 });
  return new Response(resource.data, {
    headers: {
      'content-type': resource.mime,
      'content-length': String(resource.size),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
});

route('POST', '/dashboard/notes/save', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  const backToSpot = val(body, 'return_to') === 'spot' && val(body, 'subject');
  const draft = {
    id: val(body, 'id') ? Number(val(body, 'id')) : null,
    title: val(body, 'title') || '',
    content: val(body, 'content') || '',
    category: val(body, 'category') || 'general',
    subject: val(body, 'subject') || null,
    market: val(body, 'market') || null,
    account_id: val(body, 'account_id') || null,
  };
  try {
    const id = store.saveNote({ ...draft, accountId: draft.account_id });
    if (backToSpot) {
      return redirect(`/dashboard/spot/symbol/${encodeURIComponent(val(body, 'subject'))}?notice=` + encodeURIComponent('现货备注已保存'));
    }
    return redirect(`/dashboard/notes/${id}`);
  } catch (err) {
    // 校验失败时带着已填内容回到编辑页，不丢用户输入
    const note = draft.id ? { ...store.getNote(draft.id), ...draft, created_at: store.getNote(draft.id)?.created_at } : null;
    const errorMessage = err?.message || String(err);
    let holding = null;
    if ((draft.category === 'spot') && draft.account_id && draft.subject) {
      holding = store.listSpotHoldings(Number(draft.account_id), draft.subject)[0] || null;
    }
    return html(page({
      title: draft.id ? `编辑笔记 | TradeLedger` : '新建笔记 | TradeLedger',
      user: c.user,
      body: noteEditPage({
        user: c.user,
        note: draft.id ? { ...note, ...draft } : {
          id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          ...draft,
        },
        category: draft.category,
        subject: draft.subject || '',
        symbols: store.listSymbols(),
        holding,
        error: errorMessage,
      }),
    }), 200);
  }
}));

route('POST', '/dashboard/notes/delete', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  store.deleteNote(Number(val(body, 'id')));
  return redirect('/dashboard/notes?notice=' + encodeURIComponent('笔记已删除'));
}));

/* =========================================================
 *  设置与数据
 * ========================================================= */

route('GET', '/dashboard/settings', (ctx) => requireUser(ctx, async (c) => {
  const backupConfig = backup.getBackupConfig();
  let remote = null;
  let remoteError = '';
  if (c.query.remote === '1' && backupConfig.webdavEnabled && backupConfig.webdavUrl) {
    try {
      remote = (await backup.listRemoteBackups()).files;
    } catch (err) {
      remoteError = err?.message || String(err);
    }
  }
  return html(page({
    title: '设置与数据 | TradeLedger',
    user: c.user,
    body: settingsPage({
      user: c.user,
      overview: store.statsOverview(),
      dbBytes: dbSizeBytes(),
      seededAt: store.getMeta('seeded_at', ''),
      net: {
        proxy: store.getMeta('net_exchange_proxy', ''),
        hosts: store.getMeta('net_exchange_proxy_hosts', ''),
      },
      notice: c.query.notice || '',
      error: c.query.error || '',
      backup: {
        config: backupConfig,
        local: backup.listLocalBackups(),
        remote,
        remoteError,
        remoteRequested: c.query.remote === '1',
      },
    }),
  }));
}));

route('POST', '/dashboard/settings', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  if (body.display_name !== undefined) store.setMeta('display_name', String(val(body, 'display_name')).slice(0, 60));
  if (body.bio !== undefined) store.setMeta('bio', String(val(body, 'bio')).slice(0, 500));
  return redirect('/dashboard/settings?notice=' + encodeURIComponent('已保存'));
}));

route('POST', '/dashboard/settings/net-proxy', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  store.setMeta('net_exchange_proxy', String(val(body, 'proxy')).trim().slice(0, 300));
  store.setMeta('net_exchange_proxy_hosts', String(val(body, 'hosts')).trim().slice(0, 500));
  return redirect('/dashboard/settings?notice=' + encodeURIComponent('代理设置已保存，约 15 秒内生效'));
}));

route('POST', '/dashboard/settings/clear-demo', (ctx) => requireUser(ctx, (c) => {
  const r = store.clearDemoData();
  return redirect('/dashboard/settings?notice=' + encodeURIComponent(`演示数据已清除（${r.trades} 笔）`));
}));

route('POST', '/dashboard/settings/reset', (ctx) => requireUser(ctx, (c) => {
  store.clearAllData();
  auth.logout(c.req);
  return redirect('/login?error=' + encodeURIComponent('全部数据已清空'), 302, { 'Set-Cookie': auth.clearCookie() });
}));

/* ---------------- 完整备份与恢复 ---------------- */

route('POST', '/dashboard/settings/backup/local', (ctx) => requireUser(ctx, (c) => {
  try {
    const snap = backup.createLocalSnapshot('manual');
    return backupRedirect(`已创建本地快照 ${snap.name}（${backup.fmtBytes(snap.bytes)}，含 ${snap.resources} 个图片资源）`);
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('GET', '/dashboard/settings/backup/download', (ctx) => requireUser(ctx, (c) => {
  try {
    const name = String(c.query.name || '');
    const file = backup.resolveLocalSnapshot(name);
    const data = fs.readFileSync(file);
    return new Response(data, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': String(data.length),
      },
    });
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/delete', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    backup.deleteLocalSnapshot(val(body, 'name'));
    return backupRedirect('本地快照已删除');
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/restore-local', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    const meta = backup.stageRestoreFromLocal(val(body, 'name'));
    return backupRedirect(`已暂存 ${meta.name}，重启服务后自动恢复`);
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/webdav', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    const result = backup.saveBackupConfig(backupForm(body));
    return backupRedirect(result.warnings.length ? `已保存；${result.warnings.join('；')}` : '备份设置已保存');
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/test', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    backup.saveBackupConfig(backupForm(body));
    const r = await backup.testWebdavConnection();
    return backupRedirect(`WebDAV 连接成功（${r.ms} ms）`);
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/run', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    backup.saveBackupConfig(backupForm(body));
    const r = await backup.runRemoteBackup({ reason: 'manual' });
    return backupRedirect(`已上传 ${r.name}（${backup.fmtBytes(r.bytes)}${r.encrypted ? '，已加密' : ''}）`);
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/restore-remote', (ctx) => requireUser(ctx, async (c) => {
  const body = await readForm(c.req);
  try {
    const meta = await backup.stageRestoreFromRemote(val(body, 'name'));
    return backupRedirect(`已下载并暂存 ${meta.name}，重启服务后自动恢复`);
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

route('POST', '/dashboard/settings/backup/cancel-restore', (ctx) => requireUser(ctx, (c) => {
  try {
    backup.cancelPendingRestore();
    return backupRedirect('已取消待恢复的备份');
  } catch (err) {
    return backupRedirect('', err?.message || String(err));
  }
}));

/* =========================================================
 *  REST API
 * ========================================================= */

route('GET', '/api/health', () => json({ ok: true, version: '0.1.0', time: new Date().toISOString() }));

route('GET', '/api/me', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  return json({ id: ctx.user.id, username: ctx.user.username, display_name: ctx.user.display_name });
});

route('GET', '/api/summary', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const market = ['all', 'futures', 'spot'].includes(ctx.query.market) ? ctx.query.market : 'all';
  const all = allTrades();
  const s = analyze(market === 'all' ? all : all.filter((t) => (t.market || 'futures') === market));
  return json({
    market,
    total_trades: s.total,
    wins: s.wins,
    losses: s.losses,
    win_rate: s.winRate,
    total_pnl: s.totalPnl,
    expectancy: s.expectancy,
    avg_trade_duration_ms: s.avgDuration,
    max_drawdown: s.drawdown.maxDrawdown,
    long: { count: s.longs.count, win_rate: s.longs.winRate, pnl: s.longs.pnl },
    short: { count: s.shorts.count, win_rate: s.shorts.winRate, pnl: s.shorts.pnl },
    funding: s.funding,
    fees: s.fees,
    daily: s.daily,
    hour_weekday: s.hourWeekday,
    tags: s.tagStats,
    note_coverage: { noted: s.noteCoverage.noted, total: s.noteCoverage.total, ratio: s.noteCoverage.ratio },
  });
});

route('GET', '/api/trades', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const trades = filterTrades(allTrades(), ctx.query);
  const limit = Math.min(Math.max(Number(ctx.query.limit) || 100, 1), 1000);
  return json({ count: trades.length, trades: trades.slice(0, limit) });
});

route('GET', '/api/tags', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  return json({ tags: store.listTags() });
});

route('GET', '/api/transfers', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const transfers = store.listTransfers({
    accountId: ctx.query.accountId ? Number(ctx.query.accountId) : null,
    type: ctx.query.type || 'all',
    asset: ctx.query.asset || 'all',
    from: ctx.query.from || '',
    to: ctx.query.to || '',
    limit: ctx.query.limit || 500,
  });
  return json({ count: transfers.length, transfers, summary: store.transferSummary() });
});

route('GET', '/api/spot', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const balances = store.listSpotBalances();
  const holdings = store.listSpotHoldings();
  const fills = store.listSpotFills({ limit: Math.min(Number(ctx.query.limit) || 200, 2000) });
  return json({
    balances,
    holdings,
    fills,
    value: holdings.reduce((a, h) => a + (Number(h.value) || 0), 0),
  });
});

route('GET', '/api/notes', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  return json({ notes: store.listNotes() });
});

route('GET', '/api/export', (ctx) => {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);
  const format = ctx.query.format === 'csv' ? 'csv' : 'json';
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return new Response(store.exportTradesCsv(), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="tradeledger-${stamp}.csv"`,
      },
    });
  }
  return new Response(JSON.stringify(store.exportAll(), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="tradeledger-${stamp}.json"`,
    },
  });
});

route('GET', '/api/docs', (ctx) => html(page({
  title: 'API 文档 | TradeLedger',
  user: ctx.user,
  body: `<div class="container narrow prose">
    <h1>API 文档</h1>
    <p>所有接口都需要登录后的会话 Cookie。</p>
    <table class="table"><thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead><tbody>
      <tr><td>GET</td><td>/api/health</td><td>健康检查（公开）</td></tr>
      <tr><td>GET</td><td>/api/summary</td><td>汇总统计，含周×小时矩阵</td></tr>
      <tr><td>GET</td><td>/api/trades</td><td>明细，支持 side/result/symbol/tag/sort/from/to/limit</td></tr>
      <tr><td>GET</td><td>/api/transfers</td><td>资金流水（充提 / 内部划转）</td></tr>
      <tr><td>GET</td><td>/api/spot</td><td>现货余额、持仓成本与逐笔成交</td></tr>
      <tr><td>GET</td><td>/api/tags</td><td>标签</td></tr>
      <tr><td>GET</td><td>/api/notes</td><td>独立笔记</td></tr>
      <tr><td>GET</td><td>/api/reconcile</td><td>对账报告（复算一致率、差异最大的交易）</td></tr>
      <tr><td>GET</td><td>/api/review?week=YYYY-Www&amp;format=json|md</td><td>周报 / AI 复盘上下文</td></tr>
      <tr><td>GET</td><td>/api/accounts/status</td><td>账户同步进度（供进度条轮询）</td></tr>
      <tr><td>GET</td><td>/api/positions/live</td><td>余额 / 持仓 / 资金费率快照；?force=1 立即刷新</td></tr>
      <tr><td>POST</td><td>/api/ai/test</td><td>测试已保存的 LLM 配置</td></tr>
      <tr><td>POST</td><td>/dashboard/review/ai</td><td>提交周期报告 AI 生成（后台任务）</td></tr>
      <tr><td>GET</td><td>/api/review/ai/status?job=</td><td>查询 AI 生成任务进度</td></tr>
      <tr><td>POST</td><td>/dashboard/review/ai/save-note</td><td>把 AI 报告写入笔记</td></tr>
      <tr><td>POST</td><td>/api/markdown</td><td>Markdown 预览渲染</td></tr>
      <tr><td>POST</td><td>/dashboard/notes/upload</td><td>上传笔记图片（PNG/JPEG/GIF/WebP，≤5MB）</td></tr>
      <tr><td>GET</td><td>/media/:id</td><td>读取笔记图片（需登录）</td></tr>
      <tr><td>POST</td><td>/dashboard/accounts/:id/sync</td><td>同步一批历史，返回 JSON；done=true 表示回溯完成</td></tr>
      <tr><td>GET</td><td>/api/export?format=json|csv</td><td>全量导出</td></tr>
    </tbody></table>
  </div>`,
})));

/* =========================================================
 *  分发与错误处理
 * ========================================================= */

export async function handle(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  try {
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const match = matchRoute(method, pathname);
    if (match) {
      const ctx = ctxOf(request, match.params);
      const response = await match.handler(ctx);
      if (request.method === 'HEAD' && response.body) {
        return new Response(null, { status: response.status, headers: response.headers });
      }
      return response;
    }
    if (request.method === 'GET') {
      return html(page({
        title: '404 | TradeLedger',
        user: null,
        body: `<div class="container narrow prose center"><h1>404</h1><p>页面不存在</p><a class="btn btn-primary" href="/dashboard">回到仪表盘</a></div>`,
      }), 404);
    }
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('[error]', request.method, pathname, err);
    if (pathname.startsWith('/api/')) {
      return json({ error: 'internal_error', message: err?.message || String(err) }, 500);
    }
    return html(page({
      title: '500 | TradeLedger',
      user: null,
      body: `<div class="container narrow prose center"><h1>500</h1><p>${escapeHtml(err?.message || '服务器内部错误')}</p></div>`,
    }), 500);
  }
}
