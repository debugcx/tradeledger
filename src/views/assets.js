import {
  escapeHtml as e, fmtMoney, fmtNum, fmtPrice, fmtDateTime, toLocalInput,
} from '../http.js';
import { shell } from './layout.js';
import { lineChart, PALETTE } from '../charts.js';
import { BUCKET_ORDER, staleMs, bucketLabel } from '../assets.js';
import { CHAINS } from '../wallets/index.js';

const TAB_LABELS = {
  overview: '总览',
  manual: '手动资产',
  wallets: '钱包',
  sources: '同步记录',
};

function tabs(active) {
  return `<div class="settings-tabs">
    ${Object.entries(TAB_LABELS).map(([key, label]) =>
      `<a href="/dashboard/assets?tab=${key}" class="${key === active ? 'active' : ''}">${e(label)}</a>`).join('')}
  </div>`;
}

function kindLabel(kind) {
  if (kind === 'exchange') return '交易所';
  if (kind === 'wallet') return '链上';
  if (kind === 'manual') return '手动';
  return kind || '';
}

function sourceBadge(row) {
  const kind = row.venue_kind;
  const text = kind === 'manual' ? '手动' : kind === 'wallet' ? '链上' : 'API';
  return `<span class="tag-pill">${e(text)}</span>`;
}

function staleTag(row) {
  const at = Date.parse(row.fetched_at || '') || 0;
  if (!at || Date.now() - at <= staleMs()) return '';
  return '<span class="muted small" title="超过两个刷新周期未更新"> · 旧</span>';
}

function chainText(chain) {
  const found = CHAINS.find((c) => c.id === chain);
  return found ? found.label : chain;
}

function venueKey(row) {
  return row.venue_kind === 'manual'
    ? `manual:${row.venue_name || ''}`
    : `${row.venue_kind}:${row.venue_id}`;
}

function positionRows(rows) {
  if (!rows.length) {
    return '<tr><td colspan="9" class="muted center">还没有资产数据。添加交易所账户或钱包后，后台会自动同步。</td></tr>';
  }
  return rows.map((r) => {
    const value = r.value_usd === null || r.value_usd === undefined ? null : Number(r.value_usd);
    const cls = value === null ? 'muted' : value < 0 ? 'neg' : '';
    const name = r.manual_id
      ? `<a href="/dashboard/assets?tab=manual&edit=${r.manual_id}"><b>${e(r.asset)}</b></a>`
      : `<b>${e(r.asset)}</b>`;
    const detail = [r.product, r.protocol].filter(Boolean).join(' · ');
    const chain = r.chain ? `<div class="muted small">${e(chainText(r.chain))}</div>` : '';
    return `<tr>
      <td class="small"><b>${e(r.venue_name || '—')}</b><div class="muted small">${e(kindLabel(r.venue_kind))}${r.venue_meta ? ` · ${e(r.venue_meta)}` : ''}</div></td>
      <td><span class="tag-pill">${e(bucketLabel(r.bucket))}</span></td>
      <td>${name}${detail ? `<div class="muted small">${e(detail)}</div>` : ''}${chain}</td>
      <td class="num">${fmtNum(r.amount, 8)}</td>
      <td class="num">${r.price_usd === null || r.price_usd === undefined ? '—' : fmtPrice(r.price_usd)}</td>
      <td class="num ${cls}">${value === null ? '未估值' : fmtMoney(value, { sign: false })}</td>
      <td class="small">${sourceBadge(r)}<div class="muted small" title="${e(r.source)}">${e(String(r.source).slice(0, 42))}</div>
        ${r.source_ref ? `<div class="muted small" title="${e(r.source_ref)}">${e(String(r.source_ref).slice(0, 28))}</div>` : ''}</td>
      <td class="small muted">${e(fmtDateTime(r.fetched_at))}${staleTag(r)}</td>
      <td class="small">${r.locked_until ? `锁定至 ${e(fmtDateTime(r.locked_until))}` : ''}${r.note ? `<div class="muted" title="${e(r.note)}">${e(String(r.note).slice(0, 18))}</div>` : ''}</td>
    </tr>`;
  }).join('');
}

function overviewTab({ summary, rows, snapshots, filters, runs = [] }) {
  const problems = runs
    .filter((r) => r.status === 'error' || r.status === 'partial')
    .slice(0, 5);
  const problemRows = problems.map((r) => `<tr>
    <td class="small">${e(fmtDateTime(r.started_at))}</td>
    <td class="small"><b>${e(r.venue_name || `#${r.venue_id}`)}</b><div class="muted">${e(kindLabel(r.venue_kind))}</div></td>
    <td>${r.status === 'error' ? '<span class="neg">失败</span>' : '<span class="muted">部分成功</span>'}</td>
    <td class="small muted" title="${e(r.message || '')}">${e(String(r.message || '').slice(0, 100))}</td>
  </tr>`).join('');
  const venueOptions = summary.byVenue.map((v) =>
    `<option value="${e(v.key)}" ${filters.venue === v.key ? 'selected' : ''}>${e(v.name || v.key)}（${e(kindLabel(v.kind))}）</option>`).join('');
  const bucketOptions = BUCKET_ORDER
    .filter((b) => summary.byBucket.some((x) => x.bucket === b) || b === filters.bucket)
    .map((b) => `<option value="${e(b)}" ${filters.bucket === b ? 'selected' : ''}>${e(bucketLabel(b))}</option>`).join('');
  const points = snapshots.map((s) => ({ x: String(s.snapshot_date).slice(5), value: Number(s.net_usd) || 0 }));
  const bucketRows = summary.byBucket.map((b) => {
    const share = summary.total > 0 ? Math.max(0, b.net) / summary.total : 0;
    return `<tr>
      <td><span class="tag-pill">${e(b.label)}</span></td>
      <td class="num">${fmtMoney(b.gross, { sign: false })}</td>
      <td class="num ${b.debt ? 'neg' : ''}">${b.debt ? fmtMoney(-b.debt) : '—'}</td>
      <td class="num strong ${b.net < 0 ? 'neg' : ''}">${fmtMoney(b.net, { sign: false })}</td>
      <td style="min-width:120px"><div class="asset-bar"><span style="width:${(share * 100).toFixed(1)}%"></span></div></td>
      <td class="num small">${b.count}${b.unpriced ? ` <span class="muted">· ${b.unpriced} 未估值</span>` : ''}</td>
    </tr>`;
  }).join('');
  const venueRows = summary.byVenue.map((v) => {
    const share = summary.total > 0 ? Math.max(0, v.net) / summary.total : 0;
    return `<tr>
      <td class="small"><b>${e(v.name || v.key)}</b><div class="muted">${e(kindLabel(v.kind))}${v.meta ? ` · ${e(v.meta)}` : ''}</div></td>
      <td class="num">${fmtMoney(v.gross, { sign: false })}</td>
      <td class="num ${v.debt ? 'neg' : ''}">${v.debt ? fmtMoney(-v.debt) : '—'}</td>
      <td class="num strong">${fmtMoney(v.net, { sign: false })}</td>
      <td style="min-width:120px"><div class="asset-bar"><span style="width:${(share * 100).toFixed(1)}%"></span></div></td>
      <td class="num small">${v.count}${v.unpriced ? ` <span class="muted">· ${v.unpriced} 未估值</span>` : ''}</td>
    </tr>`;
  }).join('');

  return `
    <div class="mini-strip">
      <div class="mini-stat"><span>净资产（USD）</span><b class="${summary.net < 0 ? 'neg' : ''}">${fmtMoney(summary.net, { sign: false })}</b></div>
      <div class="mini-stat"><span>总资产</span><b>${fmtMoney(summary.total, { sign: false })}</b></div>
      <div class="mini-stat"><span>负债</span><b class="${summary.liabilities ? 'neg' : ''}">${summary.liabilities ? fmtMoney(-summary.liabilities) : '$0.00'}</b></div>
      <div class="mini-stat"><span>未估值</span><b>${fmtNum(summary.unpriced)} <span class="muted small">项</span></b>
        <div class="muted small">不计入总额，明细里单独标出</div></div>
      <div class="mini-stat"><span>最近更新</span><b class="small">${summary.updatedAt ? e(fmtDateTime(summary.updatedAt)) : '等待首次同步'}</b></div>
    </div>

    ${problems.length ? `<section class="panel">
      <div class="panel-head"><h2>同步提示</h2>
        <a class="btn btn-ghost small" href="/dashboard/assets?tab=sources">查看全部同步记录</a></div>
      <p class="muted small" style="margin:0 0 10px">以下是最近未完全成功的场所。旧数据会保留，不会被 0 覆盖；理财/现货等某个接口失败时，只影响对应的资产桶。</p>
      <table class="table">
        <thead><tr><th>时间</th><th>场所</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>${problemRows}</tbody>
      </table>
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><h2>资产曲线</h2>
        <span class="muted small">每日快照的净资产；至少两天的数据才会成线</span></div>
      ${lineChart({ points, width: 960, height: 220, color: PALETTE.green, yFormat: (v) => fmtMoney(v, { sign: false }) })}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>按资产桶</h2><span class="muted small">交易账户 / 现货 / 资金 / 理财 / 质押 / 打新 / 链上 DeFi</span></div>
      <table class="table">
        <thead><tr><th>桶</th><th class="num">资产</th><th class="num">负债</th><th class="num">净值</th><th>占比</th><th class="num">条目</th></tr></thead>
        <tbody>${bucketRows || '<tr><td colspan="6" class="muted center">暂无数据</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>按场所</h2>
        <form method="post" action="/dashboard/assets/refresh" class="inline">
          <input type="hidden" name="kind" value="all">
          <button class="btn btn-primary small" type="submit">刷新全部资产</button>
        </form>
      </div>
      <table class="table">
        <thead><tr><th>场所</th><th class="num">资产</th><th class="num">负债</th><th class="num">净值</th><th>占比</th><th class="num">条目</th></tr></thead>
        <tbody>${venueRows || '<tr><td colspan="6" class="muted center">还没有接入任何账户或钱包</td></tr>'}</tbody>
      </table>
      <p class="chart-note">交易所资产来自只读 API；钱包来自索引服务；打新/锁仓等 API 查不到的产品来自手动台账。每行都记录来源与抓取时间。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>资产明细</h2>
        <span class="muted small">筛选只影响下方明细，不影响上方汇总</span></div>
      <form method="get" action="/dashboard/assets" class="filter-bar" style="margin-bottom:12px">
        <input type="hidden" name="tab" value="overview">
        <select name="venue">
          <option value="all">全部场所</option>
          ${venueOptions}
        </select>
        <select name="bucket">
          <option value="all">全部资产桶</option>
          ${bucketOptions}
        </select>
        <input name="q" value="${e(filters.q)}" placeholder="币种 / 产品 / 协议">
        <button class="btn btn-ghost small" type="submit">筛选</button>
      </form>
      <table class="table">
        <thead><tr><th>场所</th><th>桶</th><th>币种 / 产品</th><th class="num">数量</th><th class="num">价格</th><th class="num">市值</th><th>来源</th><th>更新时间</th><th>备注</th></tr></thead>
        <tbody>${positionRows(rows)}</tbody>
      </table>
    </section>`;
}

function manualForm({ asset = null, action, submitLabel }) {
  const a = asset || {};
  return `<form method="post" action="${action}" class="form grid-form">
    <label class="field"><span>场所 / 产品来源</span>
      <input name="venue_name" maxlength="80" required value="${e(a.venue_name || '')}" placeholder="币安 Launchpool / OKX Jumpstart"></label>
    <label class="field"><span>资产桶</span>
      <select name="bucket">
        ${['launchpool', 'earn_flexible', 'earn_locked', 'staking', 'other'].map((b) =>
          `<option value="${b}" ${String(a.bucket || 'launchpool') === b ? 'selected' : ''}>${e(bucketLabel(b))}</option>`).join('')}
      </select></label>
    <label class="field"><span>产品名称</span>
      <input name="product" maxlength="120" value="${e(a.product || '')}" placeholder="例如 HODLer 空投 / 第 68 期 Launchpool"></label>
    <label class="field"><span>币种</span>
      <input name="asset" maxlength="40" required value="${e(a.asset || '')}" placeholder="BNB / USDT"></label>
    <label class="field"><span>数量</span>
      <input type="number" step="any" name="amount" value="${a.amount === undefined ? '' : e(a.amount)}" placeholder="0"></label>
    <label class="field"><span>价格（USD，可选）</span>
      <input type="number" step="any" name="price_usd" value="${a.price_usd === null || a.price_usd === undefined ? '' : e(a.price_usd)}" placeholder="留空自动取行情"></label>
    <label class="field"><span>总市值覆盖（USD，可选）</span>
      <input type="number" step="any" name="value_usd" value="${a.value_usd === null || a.value_usd === undefined ? '' : e(a.value_usd)}" placeholder="未上市/无法定价时直接填总市值"></label>
    <label class="field"><span>锁定至（可选）</span>
      <input type="datetime-local" name="locked_until" value="${toLocalInput(a.locked_until)}"></label>
    <label class="field"><span>状态</span>
      <select name="status">
        <option value="active" ${a.status !== 'redeemed' ? 'selected' : ''}>持有 / 锁定中</option>
        <option value="redeemed" ${a.status === 'redeemed' ? 'selected' : ''}>已赎回 / 已结束</option>
      </select></label>
    <label class="field wide"><span>备注</span>
      <input name="note" maxlength="1000" value="${e(a.note || '')}" placeholder="认购金额、预计分配、赎回记录等">
    </label>
    <div class="form-actions wide">
      <button class="btn btn-primary" type="submit">${e(submitLabel)}</button>
      ${asset ? '<a class="btn btn-ghost" href="/dashboard/assets?tab=manual">取消</a>' : ''}
    </div>
  </form>`;
}

function manualTab({ manual, editAsset }) {
  const rows = manual.map((a) => {
    const value = a.value_usd === null || a.value_usd === undefined
      ? (a.price_usd === null || a.price_usd === undefined ? null : Number(a.amount) * Number(a.price_usd))
      : Number(a.value_usd);
    const active = a.status !== 'redeemed';
    return `<tr>
      <td><b>${e(a.venue_name)}</b></td>
      <td><span class="tag-pill">${e(bucketLabel(a.bucket))}</span>${a.product ? `<div class="muted small">${e(a.product)}</div>` : ''}</td>
      <td><b>${e(a.asset)}</b></td>
      <td class="num">${fmtNum(a.amount, 8)}</td>
      <td class="num">${a.price_usd === null || a.price_usd === undefined ? '—' : fmtPrice(a.price_usd)}</td>
      <td class="num">${value === null ? '未估值' : fmtMoney(value, { sign: false })}</td>
      <td class="small">${a.locked_until ? e(fmtDateTime(a.locked_until)) : '—'}</td>
      <td>${active ? '<span class="side-tag long">计入总资产</span>' : '<span class="muted small">已结束</span>'}</td>
      <td class="small muted" title="${e(a.note || '')}">${e(String(a.note || '').slice(0, 24))}</td>
      <td class="row-actions">
        <a class="btn btn-ghost small" href="/dashboard/assets?tab=manual&edit=${a.id}">编辑</a>
        <form method="post" action="/dashboard/assets/manual/${a.id}/delete" class="inline" onsubmit="return confirm('删除这条手动资产？')">
          <button class="btn btn-ghost small danger" type="submit">删除</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `
    <section class="panel">
      <div class="panel-head"><h2>手动资产台账</h2>
        <span class="muted small">打新、Launchpool、双币赢、API 查不到的锁仓理财</span></div>
      <p class="muted small" style="margin:0 0 12px">
        手动资产会直接计入总资产。如果同一笔资金已经被交易所 API 计入（例如现货账户里的冻结余额），
        请不要重复录入；反之，打新资金已经从现货扣走、API 又查不到仓位时，就在这里记录。
        状态为「已赎回 / 已结束」的记录保留历史，但不计入当前总资产。
      </p>
      ${manualForm({
        asset: editAsset,
        action: editAsset ? `/dashboard/assets/manual/${editAsset.id}/update` : '/dashboard/assets/manual/new',
        submitLabel: editAsset ? '保存修改' : '添加手动资产',
      })}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>台账记录</h2><span class="muted small">${manual.length} 条</span></div>
      <table class="table">
        <thead><tr><th>场所</th><th>桶 / 产品</th><th>币种</th><th class="num">数量</th><th class="num">价格</th><th class="num">市值</th><th>锁定至</th><th>状态</th><th>备注</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="10" class="muted center">还没有手动资产</td></tr>'}</tbody>
      </table>
    </section>`;
}

function providerCard(p) {
  const cfg = p.config || {};
  return `<div class="asset-provider">
    <div class="panel-head"><h3>${e(p.name)}</h3>
      <span class="muted small">${cfg.hasKey ? `已保存 · ${e(cfg.apiKeyHint || '****')}` : '未配置 Key'}</span></div>
    <p class="muted small" style="margin:0 0 10px">${e(p.description)}<br>${e(p.addressHint || '')}</p>
    <form method="post" action="/dashboard/assets/providers" class="form grid-form">
      <input type="hidden" name="provider" value="${e(p.id)}">
      <label class="field wide"><span>API Key</span>
        <input type="password" name="api_key" maxlength="500" placeholder="${cfg.hasKey ? '已保存，留空不变' : '未配置'}" autocomplete="new-password"></label>
      <label class="field wide"><span>Base URL（可选）</span>
        <input name="base_url" maxlength="300" value="${e(cfg.baseUrl || '')}" placeholder="${p.id === 'debank' ? 'https://pro-openapi.debank.com' : 'https://api.zerion.io'}"></label>
      <label class="check"><input type="checkbox" name="clear_key" value="1"> 清除已保存的 Key</label>
      <div class="form-actions wide"><button class="btn btn-primary small" type="submit">保存 ${e(p.name)}</button></div>
    </form>
  </div>`;
}

function walletsTab({ wallets, providers, walletRuns, walletRefreshMinutes = 240 }) {
  const rows = wallets.map((w) => {
    const chains = (() => { try { return JSON.parse(w.chains || '[]'); } catch { return []; } })();
    return `<tr>
      <td><b>${e(w.name)}</b><div class="muted small">${e(w.provider)}</div></td>
      <td class="small"><code title="${e(w.address)}">${e(w.address.slice(0, 10))}…${e(w.address.slice(-6))}</code></td>
      <td class="small">${chains.length ? chains.map((c) => `<span class="tag-pill">${e(chainText(c))}</span>`).join(' ') : '<span class="muted">全部链</span>'}</td>
      <td class="small">${w.last_sync_at ? e(fmtDateTime(w.last_sync_at)) : '—'}
        <div class="${w.last_sync_status === 'error' ? 'neg' : 'muted'} small" title="${e(w.last_sync_message || '')}">${e(w.last_sync_status || '')} ${e(String(w.last_sync_message || '').slice(0, 30))}</div></td>
      <td>${w.enabled ? '启用' : '<span class="muted">停用</span>'}</td>
      <td class="row-actions">
        <form method="post" action="/dashboard/assets/wallets/${w.id}/sync" class="inline">
          <button class="btn btn-ghost small" type="submit">同步</button>
        </form>
        <a class="btn btn-ghost small" href="/dashboard/assets/wallets/${w.id}/edit">编辑</a>
        <form method="post" action="/dashboard/assets/wallets/${w.id}/delete" class="inline" onsubmit="return confirm('删除钱包及其链上仓位记录？')">
          <button class="btn btn-ghost small danger" type="submit">删除</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  const presetMinutes = [30, 60, 120, 240, 360, 720, 1440, 2880, 10080];
  const options = [...new Set([...presetMinutes, Number(walletRefreshMinutes) || 240])]
    .sort((a, b) => a - b)
    .map((m) => `<option value="${m}" ${Number(walletRefreshMinutes) === m ? 'selected' : ''}>${m >= 1440 ? `${(m / 1440).toFixed(m % 1440 ? 1 : 0)} 天（${m} 分钟）` : m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}</option>`)
    .join('');

  return `
    <section class="panel">
      <div class="panel-head"><h2>钱包索引服务</h2><span class="muted small">Key 用 AES-256-GCM 加密存储</span></div>
      <div class="asset-provider-grid">${providers.map(providerCard).join('')}</div>
      <p class="chart-note">推荐 DeBank（EVM DeFi 覆盖最好）。Zerion 支持 EVM + Solana。索引服务按请求计费，请把同步周期设置得宽松一些。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>自动同步周期</h2>
        <span class="muted small">当前：每 ${e(fmtNum(walletRefreshMinutes))} 分钟（${(Number(walletRefreshMinutes) / 60).toFixed(Number(walletRefreshMinutes) % 60 ? 1 : 0)} 小时）</span></div>
      <form method="post" action="/dashboard/assets/wallet-settings" class="form grid-form">
        <label class="field"><span>钱包刷新间隔</span>
          <select name="wallet_refresh_minutes">${options}</select></label>
        <div class="form-actions wide">
          <button class="btn btn-primary small" type="submit">保存周期</button>
        </div>
      </form>
      <p class="chart-note">对所有钱包生效，保存后下一轮生效；手动点「同步」不受周期限制。默认 240 分钟（4 小时），最小 5 分钟；.env 的 WALLET_REFRESH_MINUTES 只作为未设置时的初始默认。</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>链上钱包</h2>
        <a class="btn btn-primary small" href="/dashboard/assets/wallets/new">+ 添加钱包</a>
      </div>
      <p class="muted small" style="margin:0 0 12px">只需要公开地址，不需要私钥或助记词。同一个 EVM 地址可以扫描多条链；不勾选链时默认全部链。</p>
      <table class="table">
        <thead><tr><th>名称 / 服务</th><th>地址</th><th>链</th><th>最近同步</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted center">还没有添加钱包</td></tr>'}</tbody>
      </table>
      ${walletRuns?.length ? `<p class="chart-note">最近钱包同步：${walletRuns.slice(0, 3).map((r) =>
        `${e(r.started_at ? fmtDateTime(r.started_at) : '')} ${r.status === 'error' ? '失败' : '完成'} ${e(String(r.message || '').slice(0, 40))}`).join(' · ')}</p>` : ''}
    </section>`;
}

function sourcesTab({ runs, prices }) {
  const runRows = runs.map((r) => `<tr>
    <td class="small">${e(fmtDateTime(r.started_at))}</td>
    <td class="small"><b>${e(r.venue_name || `#${r.venue_id}`)}</b><div class="muted">${e(kindLabel(r.venue_kind))}</div></td>
    <td>${r.status === 'error' ? '<span class="neg">失败</span>' : r.status === 'partial' ? '<span class="muted">部分成功</span>' : '完成'}</td>
    <td class="num">${fmtNum(r.positions)}</td>
    <td class="small muted" title="${e(r.message || '')}">${e(String(r.message || '').slice(0, 90))}</td>
    <td class="small"><code>${e(r.source || '')}</code></td>
  </tr>`).join('');
  const priceRows = prices.map((p) => `<tr>
    <td><b>${e(p.asset)}</b></td>
    <td class="num">${fmtPrice(p.price_usd)}</td>
    <td class="small"><code>${e(p.source)}</code></td>
    <td class="small muted">${e(fmtDateTime(p.fetched_at))}</td>
  </tr>`).join('');

  return `
    <section class="panel">
      <div class="panel-head"><h2>同步记录</h2>
        <form method="post" action="/dashboard/assets/refresh" class="inline">
          <input type="hidden" name="kind" value="all">
          <button class="btn btn-primary small" type="submit">立即刷新全部</button>
        </form>
      </div>
      <p class="muted small" style="margin:0 0 12px">每次交易所 / 钱包同步都会留下一条记录，包含来源接口、成功/失败原因和写入条目数。部分成功表示某些桶（例如理财权限不足）失败，但其他桶已更新。</p>
      <table class="table">
        <thead><tr><th>时间</th><th>场所</th><th>状态</th><th class="num">条目</th><th>说明</th><th>来源</th></tr></thead>
        <tbody>${runRows || '<tr><td colspan="6" class="muted center">还没有同步记录</td></tr>'}</tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>价格缓存</h2><span class="muted small">OKX / Binance 公共行情，稳定币固定 1</span></div>
      <table class="table">
        <thead><tr><th>币种</th><th class="num">USD 价格</th><th>来源</th><th>更新时间</th></tr></thead>
        <tbody>${priceRows || '<tr><td colspan="4" class="muted center">还没有价格缓存</td></tr>'}</tbody>
      </table>
    </section>`;
}

export function assetsPage({
  user, activeTab = 'overview', summary, rows = [], snapshots = [], filters = {},
  manual = [], editAsset = null, wallets = [], providers = [], runs = [], prices = [],
  walletRefreshMinutes = 240, notice = '', error = '',
}) {
  let tabBody = '';
  if (activeTab === 'manual') tabBody = manualTab({ manual, editAsset });
  else if (activeTab === 'wallets') tabBody = walletsTab({
    wallets, providers, walletRuns: runs.filter((r) => r.venue_kind === 'wallet'), walletRefreshMinutes,
  });
  else if (activeTab === 'sources') tabBody = sourcesTab({ runs, prices });
  else tabBody = overviewTab({ summary, rows, snapshots, filters, runs });

  return shell({
    active: 'assets', user, title: '资产总览',
    subtitle: '把交易所、资金账户、理财、质押、打新和 Web3 钱包放到同一个 USD 口径里；每一条都能追溯来源',
    notice, error,
    body: `${tabs(activeTab)}${tabBody}`,
  });
}

export function walletFormPage({ user, wallet = null, providers = [], notice = '', error = '' }) {
  const editing = Boolean(wallet?.id);
  const chains = (() => { try { return JSON.parse(wallet?.chains || '[]'); } catch { return []; } })();
  const selected = new Set(chains);
  const provider = providers.find((p) => p.id === (wallet?.provider || providers[0]?.id));
  return shell({
    active: 'assets', user, title: editing ? '编辑钱包' : '添加钱包',
    subtitle: '只读公开地址；系统不会要求私钥或助记词',
    notice, error,
    body: `<section class="panel">
      <form method="post" action="${editing ? `/dashboard/assets/wallets/${wallet.id}/edit` : '/dashboard/assets/wallets/new'}" class="form grid-form">
        <label class="field"><span>名称</span>
          <input name="name" maxlength="60" value="${e(wallet?.name || '')}" placeholder="主钱包"></label>
        <label class="field"><span>索引服务</span>
          <select name="provider">
            ${providers.map((p) => `<option value="${p.id}" ${provider?.id === p.id ? 'selected' : ''}>${e(p.name)}</option>`).join('')}
          </select></label>
        <label class="field wide"><span>地址</span>
          <input name="address" maxlength="200" required value="${e(wallet?.address || '')}" placeholder="${e(provider?.addressHint || '0x...')}"></label>
        <div class="field wide"><span>链（不选 = 全部链）</span>
          <div class="check-grid">
            ${CHAINS.map((c) => `<label class="check"><input type="checkbox" name="chains" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''}> ${e(c.label)}</label>`).join('')}
          </div>
        </div>
        <label class="check wide"><input type="checkbox" name="enabled" value="1" ${wallet?.enabled === 0 ? '' : 'checked'}> 启用自动同步</label>
        <div class="form-actions wide">
          <button class="btn btn-primary" type="submit">${editing ? '保存修改' : '添加并同步'}</button>
          <a class="btn btn-ghost" href="/dashboard/assets?tab=wallets">返回</a>
        </div>
      </form>
      <p class="chart-note">DeBank 只支持 EVM 地址；Zerion 同时支持 EVM 和 Solana。勾选链只影响展示，索引服务仍可能按地址扫描全部链。</p>
    </section>`,
  });
}
