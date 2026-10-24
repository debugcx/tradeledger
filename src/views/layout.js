import { escapeHtml as e } from '../http.js';

const NAV = [
  { href: '/dashboard', label: '仪表盘', key: 'dashboard' },
  { href: '/dashboard/calendar', label: '盈亏日历', key: 'calendar' },
  { href: '/dashboard/journal', label: '交易记录', key: 'journal' },
  { href: '/dashboard/transfers', label: '资金流水', key: 'transfers' },
  { href: '/dashboard/spot', label: '现货', key: 'spot' },
  { href: '/dashboard/bots', label: '策略机器人', key: 'bots' },
  { href: '/dashboard/notes', label: '笔记', key: 'notes' },
  { href: '/dashboard/review', label: '周期报告', key: 'review' },
];

const SETTINGS_NAV = [
  { href: '/dashboard/settings', label: '常规与备份', key: 'settings', tab: 'general' },
  { href: '/dashboard/import', label: '数据导入', key: 'import', tab: 'import' },
  { href: '/dashboard/accounts', label: '交易所', key: 'accounts', tab: 'accounts' },
  { href: '/dashboard/reconcile', label: '对账', key: 'reconcile' },
  { href: '/dashboard/tags', label: '标签', key: 'tags', tab: 'tags' },
  { href: '/dashboard/settings/ai', label: 'AI 模型', key: 'ai-settings', tab: 'ai' },
];

/** 设置区二级导航 */
export function settingsNav(active = 'general') {
  return `<div class="settings-tabs">
    ${SETTINGS_NAV.map((item) => `<a href="${item.href}" class="${item.tab === active ? 'active' : ''}">${e(item.label)}</a>`).join('')}
  </div>`;
}

export function layout({ title = 'TradeLedger', user = null, body = '', description = '' }) {
  const authArea = user
    ? `<div class="nav-user">
        <a class="nav-user-name" href="/dashboard/settings">${e(user.display_name || user.username)}</a>
        <form method="post" action="/logout" class="inline"><button class="btn btn-ghost small" type="submit">退出</button></form>
      </div>`
    : `<a class="btn btn-primary small" href="/login">进入</a>`;

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%237DA2FF'/><text x='16' y='22' font-size='18' font-family='monospace' text-anchor='middle' fill='%230B0E14'>TL</text></svg>">
<link rel="stylesheet" href="/style.css">
<script>try{var t=localStorage.getItem('tl-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}</script>
</head>
<body>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/dashboard"><span class="brand-mark">TL</span><span class="brand-name">TradeLedger</span></a>
    <span class="site-motto">前途是光明的，道路是曲折的</span>
    <div class="header-right">
      <button class="icon-btn" id="themeToggle" type="button" title="切换主题" aria-label="切换主题">◐</button>
      ${authArea}
    </div>
  </div>
</header>
<main class="site-main">${body}</main>
<script src="/app.js"></script>
</body>
</html>`;
}

export const page = (opts) => layout(opts);

export function alert(message, kind = 'error') {
  if (!message) return '';
  return `<div class="alert alert-${e(kind)}">${e(message)}</div>`;
}

export function sidebar(active, user) {
  const settingsActive = SETTINGS_NAV.some((item) => item.key === active);
  return `<aside class="side-nav">
    <div class="side-user">
      <div class="avatar">${e(String(user?.display_name || user?.username || 'O').slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="side-user-name">${e(user?.display_name || user?.username || 'Owner')}</div>
        <div class="muted small">本地台账 · 单用户</div>
      </div>
    </div>
    <nav>
      ${NAV.map((item) => `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${e(item.label)}</a>`).join('')}
      <div class="nav-group">
        <div class="nav-group-title ${settingsActive ? 'active' : ''}">设置与数据</div>
        ${SETTINGS_NAV.map((item) => `<a class="nav-sub-item ${item.key === active ? 'active' : ''}" href="${item.href}">${e(item.label)}</a>`).join('')}
      </div>
    </nav>
    <a class="side-new" href="/dashboard/journal/new">+ 手动记录一笔</a>
  </aside>`;
}

/** 带侧栏的页面壳 */
export function shell({ active = '', user, title, subtitle = '', actions = '', notice = '', error = '', body = '' }) {
  return `<div class="app-shell">
    ${sidebar(active, user)}
    <div class="app-main">
      <div class="page-head">
        <div>
          <h1 class="page-title">${e(title)}</h1>
          ${subtitle ? `<p class="muted">${subtitle}</p>` : ''}
        </div>
        ${actions ? `<div class="head-actions">${actions}</div>` : ''}
      </div>
      ${notice ? alert(notice, 'ok') : ''}
      ${error ? alert(error, 'error') : ''}
      ${body}
    </div>
  </div>`;
}
