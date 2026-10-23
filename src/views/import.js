import { escapeHtml as e, fmtMoney, fmtNum, fmtDateTime } from '../http.js';
import { FIELD_DEFS } from '../csv.js';
import { shell, settingsNav } from './layout.js';

const TZ_OPTIONS = [
  { value: '0', label: 'UTC（交易所导出常用）' },
  { value: '8', label: 'UTC+8（北京时间）' },
  { value: '-5', label: 'UTC−5（美东）' },
  { value: '-8', label: 'UTC−8（美西）' },
];

function uploadForm({ accounts, templates = [], error }) {
  return `<section class="panel">
    <div class="panel-head"><h2>第 1 步：选择 CSV</h2></div>
    ${error ? `<div class="alert alert-error">${e(error)}</div>` : ''}
    <form method="post" action="/dashboard/import" enctype="multipart/form-data" class="form grid-form">
      <input type="hidden" name="step" value="preview">
      <label class="field"><span>导入到账户</span>
        <select name="account_id">
          ${accounts.map((a) => `<option value="${a.id}">${e(a.name)}（${e(a.exchange)}）</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>时间列没有时区时，按哪个时区解释</span>
        <select name="tz_offset">${TZ_OPTIONS.map((o) => `<option value="${o.value}">${e(o.label)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>市场类型</span>
        <select name="market">
          <option value="futures">合约</option>
          <option value="spot">现货</option>
        </select>
        <div class="muted small">现货的逐笔成交会按 long-only FIFO 配对，不会开空</div>
      </label>
      ${templates.length ? `<label class="field"><span>列映射模板</span>
        <select name="template_id">
          <option value="">自动识别</option>
          ${templates.map((t) => `<option value="${t.id}">${e(t.name)}</option>`).join('')}
        </select>
      </label>` : ''}
      <label class="field checkbox-field"><span>费用符号</span>
        <label class="check"><input type="checkbox" name="cost_positive" value="1" checked>
          手续费 / 资金费的正数视为「支出」</label>
      </label>
      <label class="field wide"><span>上传文件（.csv / .txt，≤ 8MB）</span>
        <input type="file" name="file" accept=".csv,.txt,text/csv">
      </label>
      <label class="field wide"><span>或者直接粘贴 CSV 文本</span>
        <textarea name="csv_text" rows="8" placeholder="symbol,side,close_time,pnl,fee&#10;BTC/USDT,long,2026-10-01 12:00:00,120.5,-1.2"></textarea>
      </label>
      <div class="form-actions wide">
        <button class="btn btn-primary" type="submit">解析并预览</button>
      </div>
    </form>
    <p class="chart-note">
      要求：第一行是表头，一行 = 一笔已平仓交易。逐笔成交导出（每行是开仓或平仓单腿）无法在这里合并成 round-trip，
      请优先使用交易所的「平仓盈亏 / Closed PnL / 成交历史」报表。
    </p>
  </section>`;
}

function mappingSelect(field, headers, mapping) {
  const current = mapping[field.key];
  const options = ['<option value="">（不使用）</option>']
    .concat(headers.map((h, i) => `<option value="${i}" ${Number(current) === i ? 'selected' : ''}>${e(h || `第 ${i + 1} 列`)}</option>`));
  return `<label class="field"><span>${e(field.label)}${field.required ? ' *' : ''}</span>
    <select name="map_${field.key}">${options.join('')}</select></label>`;
}

function previewTable(trades) {
  const rows = trades.slice(0, 10).map((t) => `<tr>
    <td><b>${e(t.symbol)}</b></td>
    <td><span class="side-tag ${t.side}">${t.side === 'long' ? '多' : '空'}</span></td>
    <td class="small">${e(t.open_time.slice(0, 16).replace('T', ' '))}</td>
    <td class="small">${e(t.close_time.slice(0, 16).replace('T', ' '))}</td>
    <td>${fmtNum(t.entry_price, 4)} → ${fmtNum(t.exit_price, 4)}</td>
    <td>${fmtNum(t.size, 4)}</td>
    <td class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''} strong">${fmtMoney(t.pnl)}</td>
    <td>${fmtMoney(t.fee)}</td>
    <td>${fmtMoney(t.funding)}</td>
    <td>${(t.tags || []).map((x) => `<span class="tag-pill">${e(x)}</span>`).join(' ')}</td>
  </tr>`).join('');
  return `<table class="table">
    <thead><tr><th>币种</th><th>方向</th><th>开仓</th><th>平仓</th><th>价格</th><th>数量</th><th>净盈亏</th><th>手续费</th><th>资金费</th><th>标签</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function errorList(errors) {
  if (!errors.length) return '';
  return `<div class="alert alert-error">
    <b>有 ${errors.length} 行无法解析（导入时会跳过）：</b>
    <ul class="error-list">${errors.slice(0, 10).map((x) => `<li>第 ${x.line} 行：${e(x.message)}</li>`).join('')}
    ${errors.length > 10 ? `<li>…… 还有 ${errors.length - 10} 行</li>` : ''}</ul>
  </div>`;
}

function previewForm({ headers, mapping, trades, errors, rawText, accountId, tzOffset, costPositive, templateId, mode = 'roundtrip', preset = {}, headerInfo = {}, market = 'futures', error }) {
  const modeLabel = mode === 'fills' ? '逐笔成交（FIFO 配对）' : '已平仓交易（一行一笔）';
  return `<section class="panel">
    <div class="panel-head"><h2>第 2 步：确认列映射与预览</h2></div>
    ${error ? `<div class="alert alert-error">${e(error)}</div>` : ''}
    <div class="mini-strip">
      <div class="mini-stat"><span>解析到</span><b>${fmtNum(trades.length)} 笔</b></div>
      <div class="mini-stat"><span>无法解析</span><b class="${errors.length ? 'neg' : ''}">${errors.length} 行</b></div>
      <div class="mini-stat"><span>识别格式</span><b class="small">${e(preset.label || '通用（自动识别）')}</b></div>
      <div class="mini-stat"><span>数据形态</span><b class="small">${e(modeLabel)}</b></div>
      <div class="mini-stat"><span>市场</span><b class="small">${market === 'spot' ? '现货' : '合约'}</b></div>
      <div class="mini-stat"><span>表头位置</span><b class="small">第 ${Number(headerInfo.headerIndex || 0) + 1} 行${headerInfo.skippedRows ? ` · 跳过 ${headerInfo.skippedRows} 行说明` : ''}</b></div>
    </div>
    ${errorList(errors)}
    <form method="post" action="/dashboard/import" class="form">
      <input type="hidden" name="step" value="commit">
      <input type="hidden" name="account_id" value="${e(accountId)}">
      <input type="hidden" name="tz_offset" value="${e(tzOffset)}">
      <input type="hidden" name="cost_positive" value="${costPositive ? '1' : '0'}">
      ${templateId ? `<input type="hidden" name="template_id" value="${e(templateId)}">` : ''}
      <textarea name="csv_text" class="visually-hidden" aria-hidden="true">${e(rawText)}</textarea>
      <div class="grid-form">
        <label class="field"><span>市场类型</span>
          <select name="market">
            <option value="futures" ${market !== 'spot' ? 'selected' : ''}>合约</option>
            <option value="spot" ${market === 'spot' ? 'selected' : ''}>现货</option>
          </select>
        </label>
        <label class="field"><span>数据形态</span>
          <select name="mode">
            <option value="roundtrip" ${mode !== 'fills' ? 'selected' : ''}>已平仓交易（一行一笔）</option>
            <option value="fills" ${mode === 'fills' ? 'selected' : ''}>逐笔成交（自动 FIFO 配对）</option>
          </select>
          <div class="muted small">改成逐笔成交后，点下方「重新解析预览」再确认</div>
        </label>
        ${FIELD_DEFS.map((f) => mappingSelect(f, headers, mapping)).join('')}
        <label class="field wide"><span>保存当前映射为模板（可选）</span>
          <input name="template_name" maxlength="60" placeholder="例如：Binance 合约历史">
        </label>
      </div>
      <div class="panel-head" style="margin-top:8px"><h2>前 10 行预览</h2></div>
      ${previewTable(trades)}
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">确认导入 ${fmtNum(trades.length)} 笔</button>
        <button class="btn btn-ghost" type="submit" name="step" value="preview">按当前映射重新解析预览</button>
        <a class="btn btn-ghost" href="/dashboard/import">重新选择文件</a>
      </div>
    </form>
  </section>`;
}

function historyTable(imports) {
  const rows = imports.map((i) => `<tr>
    <td class="small">${e(fmtDateTime(i.created_at))}</td>
    <td>${e(i.account_name)}</td>
    <td class="small">${e(i.filename || '粘贴文本')}</td>
    <td>${fmtNum(i.rows)}</td>
    <td class="pos">${fmtNum(i.inserted)}</td>
    <td class="muted">${fmtNum(i.skipped)}</td>
    <td class="${i.failed ? 'neg' : 'muted'}">${fmtNum(i.failed)}</td>
  </tr>`).join('');
  return `<section class="panel">
    <div class="panel-head"><h2>导入记录</h2></div>
    <table class="table">
      <thead><tr><th>时间</th><th>账户</th><th>文件</th><th>行数</th><th>写入</th><th>跳过重复</th><th>失败</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted center">还没有导入记录</td></tr>'}</tbody>
    </table>
  </section>`;
}

function templatesPanel(templates) {
  if (!templates.length) return '';
  return `<section class="panel">
    <div class="panel-head"><h2>映射模板</h2><span class="muted small">下次导入同类文件可直接套用</span></div>
    <div class="tag-row">
      ${templates.map((t) => `<span class="tag-pill">${e(t.name)}
        <form method="post" action="/dashboard/import/templates/delete" class="inline"
          onsubmit="return confirm('删除模板「${e(t.name)}」？')">
          <input type="hidden" name="id" value="${t.id}">
          <button class="tag-del" type="submit" title="删除">×</button>
        </form></span>`).join('')}
    </div>
  </section>`;
}

export function importPage({ user, accounts, imports, templates = [], notice, error }) {
  const body = `
    ${settingsNav('import')}
    <section class="panel guide-panel">
      <div class="panel-head"><h2>怎么导</h2></div>
      <ol class="steps">
        <li>从交易所导出「成交历史 / 平仓盈亏」CSV（一行一笔已平仓交易）。</li>
        <li>上传或粘贴，系统自动识别分隔符和常见中英文表头。</li>
        <li>在预览页改列映射：至少要有「币种」「平仓时间」，以及「净盈亏」或「开/平仓价 + 数量」。</li>
        <li>确认导入。重复的行会按外部 ID 或业务指纹自动跳过，可重复导入同一份文件。</li>
      </ol>
    </section>
    ${uploadForm({ accounts, templates, error })}
    ${templatesPanel(templates)}
    ${historyTable(imports)}`;

  return shell({
    active: 'import', user, title: 'CSV 导入',
    subtitle: '历史数据进得来，换工具才不用从头开始',
    notice, body,
  });
}

export function importPreviewPage({
  user, headers, mapping, trades, errors, rawText, accountId, tzOffset, costPositive,
  templateId, mode, preset, headerInfo, market, error,
}) {
  return shell({
    active: 'import', user, title: '导入预览',
    subtitle: '确认列映射后才会写入数据库；这一步不会改任何现有数据',
    body: `${settingsNav('import')}${previewForm({
      headers, mapping, trades, errors, rawText, accountId, tzOffset, costPositive,
      templateId, mode, preset, headerInfo, market, error,
    })}`,
  });
}
