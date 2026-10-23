import { escapeHtml as e, fmtDateTime, fmtNum } from '../http.js';
import { config } from '../config.js';
import { shell, settingsNav } from './layout.js';

function exchangeName(meta, id) {
  if (id === 'manual') return '手动记录';
  return meta.find((x) => x.id === id)?.name || id;
}

function statusOf(account) {
  if (account.exchange === 'manual') return { label: '手动', cls: 'muted' };
  if (account.is_demo) return { label: '演示', cls: 'muted' };
  if (account.last_sync_status === 'error') return { label: '同步失败', cls: 'neg' };
  if (account.sync_done) return { label: '已完整', cls: 'pos' };
  if (account.sync_state) return { label: '回溯中', cls: 'blue' };
  return { label: '未同步', cls: 'muted' };
}

function stateHint(account) {
  if (!account.sync_state) return '';
  try {
    const st = JSON.parse(account.sync_state);
    if (st.cursor) return '还有更早的历史，点同步继续';
    return '等待下一批';
  } catch {
    return '';
  }
}

function runsTable(runs) {
  const rows = runs.map((r) => `<tr>
    <td class="small">${e(fmtDateTime(r.finished_at || r.started_at))}</td>
    <td>${e(r.account_name)} <span class="muted small">${e(r.exchange)}</span></td>
    <td>${fmtNum(r.fetched)}</td>
    <td class="pos">${fmtNum(r.inserted)}</td>
    <td class="muted">${fmtNum(r.skipped)}</td>
    <td class="${r.status === 'error' ? 'neg' : r.status === 'ok' ? 'pos' : 'muted'}">${e(r.status)}</td>
    <td class="small muted">${e(String(r.message || '').slice(0, 80))}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>同步记录</h2></div>
    <table class="table">
      <thead><tr><th>时间</th><th>账户</th><th>拉取</th><th>写入</th><th>跳过</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted center">还没有同步记录</td></tr>'}</tbody>
    </table>
  </section>`;
}

export function accountsPage({ user, accounts, meta, runs, accountStats = {}, stats, notice, error }) {
  const real = accounts.filter((a) => !a.is_demo && a.exchange !== 'manual');
  const rows = accounts.map((a) => {
    const st = statusOf(a);
    const hint = stateHint(a);
    const prog = accountStats[a.id];
    const showProgress = !a.is_demo && a.exchange !== 'manual';
    return `<tr data-account-row="${a.id}">
      <td><b>${e(exchangeName(meta, a.exchange))}</b></td>
      <td>${e(a.name)}<div class="muted small">回溯：${e(lookbackLabel(a.lookback_days))}</div></td>
      <td class="muted small">${a.api_key_hint ? `••••${e(a.api_key_hint)}` : '—'}</td>
      <td><span class="status-badge ${st.cls}">${e(st.label)}</span>
        ${hint ? `<div class="muted small">${e(hint)}</div>` : ''}</td>
      <td class="small">${a.last_sync_at ? e(fmtDateTime(a.last_sync_at)) : '—'}
        ${a.last_sync_message ? `<div class="muted small" title="${e(a.last_sync_message)}">${e(a.last_sync_message.slice(0, 42))}</div>` : ''}</td>
      <td class="progress-cell">
        ${showProgress ? `<div class="progress" data-sync-bar="${a.id}" data-done="${a.sync_done && !prog?.pending ? 1 : 0}">
            <span style="width:${prog?.pct || 0}%"></span>
          </div>
          <div class="muted small" data-sync-status="${a.id}">${e(prog?.label || '等待自动同步')}</div>`
        : '<span class="muted small">—</span>'}
      </td>
      <td class="row-actions">
        ${a.is_demo ? '<span class="muted small">演示账户不可同步</span>'
          : a.exchange === 'manual' ? '<span class="muted small">手动账户无需同步</span>'
          : `
          <button class="btn btn-ghost small" type="button" data-sync-account="${a.id}">同步</button>
          <a class="btn btn-ghost small" href="/dashboard/accounts/${a.id}/edit">编辑</a>
          <form method="post" action="/dashboard/accounts/${a.id}/resync" class="inline"
            onsubmit="return confirm('按当前回溯范围重新扫一遍历史？已有交易会按去重保留。')">
            <button class="btn btn-ghost small" type="submit">重新回溯</button>
          </form>
          <form method="post" action="/dashboard/accounts/${a.id}/delete" class="inline"
            onsubmit="return confirm('删除账户「${e(a.name)}」？已同步的交易会保留。')">
            <button class="btn btn-ghost small danger" type="submit">删除</button>
          </form>`}
      </td>
    </tr>`;
  }).join('');

  if (!accounts.length) {
    return shell({
      active: 'accounts', user, title: '交易所', notice, error,
      subtitle: '只读 API Key，凭据加密存储；同步的交易与 CSV 导入共用同一套去重',
      body: `${settingsNav('accounts')}<section class="panel center muted" style="padding:40px">
        还没有接入交易所。<a href="/dashboard/accounts/new">添加第一个只读 API</a>，或先 <a href="/dashboard/import">导入 CSV</a>。
      </section>`,
    });
  }

  const realIds = JSON.stringify(real.map((a) => a.id));
  const body = `
    ${settingsNav('accounts')}
    <div class="mini-strip">
      <div class="mini-stat"><span>可同步账户</span><b>${real.length}</b></div>
      <div class="mini-stat"><span>已同步交易</span><b>${fmtNum(stats.apiTrades || 0)}</b></div>
      <div class="mini-stat"><span>同步失败</span><b class="${accounts.some((a) => a.last_sync_status === 'error') ? 'neg' : ''}">${accounts.filter((a) => a.last_sync_status === 'error').length}</b></div>
      <div class="mini-stat"><span>同步记录</span><b>${fmtNum(stats.syncRuns || 0)}</b></div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h2>已接入账户</h2>
        <div class="head-actions">
          ${real.length ? `<button class="btn btn-ghost small" type="button" data-sync-all='${e(realIds)}'>同步全部</button>` : ''}
          <a class="btn btn-primary small" href="/dashboard/accounts/new">+ 添加交易所</a>
        </div>
      </div>
      <table class="table">
        <thead><tr><th>交易所</th><th>名称</th><th>Key</th><th>状态</th><th>最近同步</th><th>进度</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="chart-note">
        API Key 只勾「读取」权限；凭据用 AES-256-GCM 加密后存在本地数据库。
        首次同步会从 ${config.syncLookbackDays} 天前开始回溯，可分多批完成；完成后每次只拉最近 2 天并自动去重。
      </p>
    </section>
    ${runsTable(runs)}`;

  return shell({
    active: 'accounts', user, title: '交易所',
    subtitle: '只读 API Key · 分批回溯 · 断点续传 · 与 CSV 共用去重',
    notice, error, body,
  });
}

function lookbackLabel(days) {
  if (days === null || days === undefined || days === '') return '默认 180 天';
  if (Number(days) === 0) return '全部可用';
  return `${Number(days)} 天`;
}

function lookbackOptions(current) {
  const value = current === null || current === undefined || current === '' ? '180' : String(current);
  const options = [
    ['90', '90 天'],
    ['180', '180 天'],
    ['365', '1 年'],
    ['730', '2 年'],
    ['3650', '10 年'],
    ['0', '全部可用（按交易所保留期）'],
  ];
  return options.map(([v, label]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`).join('');
}

export function accountNewPage({ user, meta, selected, form = {}, error }) {
  const ex = meta.find((x) => x.id === selected) || meta[0];
  const picker = meta.map((x) => `<a class="ex-pick ${x.id === ex.id ? 'active' : ''}" href="/dashboard/accounts/new?exchange=${x.id}">${e(x.name)}</a>`).join('');
  const fields = ex.fields.map((f) => {
    const isPass = f.key === 'passphrase';
    const isSecret = f.key !== 'wallet';
    return `<label class="field ${f.key === 'wallet' ? 'wide' : ''}">
      <span>${e(f.label)}</span>
      <input name="${f.key}" ${isSecret ? 'type="password"' : ''}
        autocomplete="${isPass ? 'new-password' : 'off'}" spellcheck="false" autocapitalize="off"
        value="${e(form[f.key] || '')}" placeholder="${e(f.placeholder || '')}">
      ${isPass ? '<div class="muted small">创建 API 时单独设置的 Passphrase，区分大小写，不是登录密码</div>' : ''}
    </label>`;
  }).join('');

  return shell({
    active: 'accounts', user, title: '添加交易所',
    subtitle: '只需要只读权限；我们不会、也无法用这些 Key 下单',
    error,
    body: `
      ${settingsNav('accounts')}
      <section class="panel">
        <div class="panel-head"><h2>选择交易所</h2></div>
        <div class="ex-picker">${picker}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>${e(ex.name)} 凭据</h2></div>
        <form method="post" action="/dashboard/accounts/new" class="form grid-form">
          <input type="hidden" name="exchange" value="${e(ex.id)}">
          <label class="field wide"><span>账户名称</span>
            <input name="name" required maxlength="60" value="${e(form.name || `${ex.name} 主账户`)}"></label>
          ${fields}
          <label class="field"><span>历史回溯范围</span>
            <select name="lookback_days">${lookbackOptions(form.lookback_days)}</select>
            <div class="muted small">OKX / Bitget 约 3 个月，Gate 约 6 个月；其他交易所按接口保留期</div>
          </label>
          <label class="field wide"><span>现货交易对（可选）</span>
            <input name="spot_symbols" value="${e(form.spot_symbols || '')}" placeholder="BTCUSDT,ETHUSDT；留空则按现货余额自动推导">
            <div class="muted small">Binance / Bitget / Gate 的现货成交接口需要交易对；OKX / Bybit / Hyperliquid 可自动拉全量</div>
          </label>
          <div class="form-actions wide">
            <button class="btn btn-primary" type="submit">验证并保存</button>
            <a class="btn btn-ghost" href="/dashboard/accounts">取消</a>
          </div>
        </form>
        <ul class="tips-list">${(ex.tips || []).map((t) => `<li>${e(t)}</li>`).join('')}</ul>
        <p class="chart-note">
          验证时会真实请求交易所只读接口。若长时间没有响应，通常是本机无法直连；
          程序会自动探测 7890 / 7897 / 10809 / 1080 端口上的本地代理，
          也可以在 <code>.env</code> 设置 <code>HTTPS_PROXY</code> 后重启服务。
        </p>
      </section>`,
  });
}

export function accountEditPage({ user, account, exchange, error }) {
  const fields = (exchange?.fields || [
    { key: 'api_key', label: 'API Key' },
    { key: 'api_secret', label: 'API Secret' },
    { key: 'passphrase', label: 'Passphrase' },
  ]).map((f) => {
    const isPass = f.key === 'passphrase';
    const isSecret = f.key !== 'wallet';
    return `<label class="field ${f.key === 'wallet' ? 'wide' : ''}">
      <span>${e(f.label)}（留空不改）</span>
      <input name="${f.key}" ${isSecret ? 'type="password"' : ''}
        autocomplete="${isPass ? 'new-password' : 'off'}" spellcheck="false" autocapitalize="off"
        placeholder="${f.key === 'api_key' && account.api_key_hint ? `当前 ••••${e(account.api_key_hint)}` : '留空保持不变'}">
      ${isPass ? '<div class="muted small">区分大小写，不是登录密码</div>' : ''}
    </label>`;
  }).join('');

  return shell({
    active: 'accounts', user,
    title: `编辑 ${account.name}`,
    subtitle: '留空的密钥字段会保持原值；API Key 只能读取，不能下单',
    error,
    body: `${settingsNav('accounts')}<section class="panel">
      <form method="post" action="/dashboard/accounts/${account.id}/edit" class="form grid-form">
        <label class="field wide"><span>账户名称</span>
          <input name="name" required maxlength="60" value="${e(account.name)}"></label>
        ${fields}
        <label class="field"><span>历史回溯范围</span>
          <select name="lookback_days">${lookbackOptions(account.lookback_days)}</select>
          <div class="muted small">修改后会自动从头重新回溯；已有交易会按去重保留</div>
        </label>
        <label class="field wide"><span>现货交易对（可选）</span>
          <input name="spot_symbols" value="${e(account.spot_symbols || '')}" placeholder="BTCUSDT,ETHUSDT；留空则按现货余额自动推导">
          <div class="muted small">修改后会重新拉取现货成交；Binance / Bitget / Gate 必填或留空自动推导</div>
        </label>
        <div class="form-actions wide">
          <button class="btn btn-primary" type="submit">保存</button>
          <a class="btn btn-ghost" href="/dashboard/accounts">返回</a>
        </div>
      </form>
      <p class="chart-note">如果更换了 API Key，保存后会从下一次同步开始使用新凭据；已同步的交易不受影响。</p>
    </section>`,
  });
}
