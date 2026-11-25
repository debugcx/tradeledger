import { escapeHtml as e, fmtBytes, fmtNum, fmtDateTime } from '../http.js';
import { APP_VERSION } from '../version.js';
import fs from 'node:fs';
import { shell, settingsNav } from './layout.js';

/** 前端资源构建时间（app.js 的修改时间，模块加载时取一次；重启服务即刷新）。
 *  排查「页面还是旧版」用：浏览器里跑的是旧 JS 时这个时间对不上。 */
const BUILD_TIME = (() => {
  try {
    return fmtDateTime(fs.statSync(new URL('../../public/app.js', import.meta.url)).mtime.toISOString());
  } catch {
    return '未知';
  }
})();

function backupSection({ config = {}, local = [], remote = null, remoteError = '', remoteRequested = false }) {
  const pending = config.pending;
  const localRows = local.map((b) => `<tr>
    <td class="small"><code>${e(b.name)}</code></td>
    <td class="small">${e(fmtDateTime(b.created_at))}</td>
    <td>${fmtBytes(b.bytes)}</td>
    <td class="row-actions">
      <a class="btn btn-ghost small" href="/dashboard/settings/backup/download?name=${encodeURIComponent(b.name)}" download>下载</a>
      <form method="post" action="/dashboard/settings/backup/restore-local" class="inline" data-confirm="恢复会覆盖当前数据库，并在重启服务后生效。继续吗？">
        <input type="hidden" name="name" value="${e(b.name)}">
        <button class="btn btn-ghost small" type="submit">恢复</button>
      </form>
      <form method="post" action="/dashboard/settings/backup/delete" class="inline" data-confirm="删除这个本地快照？">
        <input type="hidden" name="name" value="${e(b.name)}">
        <button class="btn btn-ghost small danger" type="submit">删除</button>
      </form>
    </td>
  </tr>`).join('');

  const remoteRows = (remote || []).map((f) => `<tr>
    <td class="small"><code>${e(f.name)}</code>
      ${f.format === 'chunked' ? '<span class="tag-pill">增量</span>' : ''}</td>
    <td class="small">${e(f.created_at ? fmtDateTime(f.created_at) : '—')}</td>
    <td>${fmtBytes(f.bytes)}</td>
    <td>${f.encrypted ? '已加密' : '<span class="muted">未加密</span>'}</td>
    <td class="row-actions">
      <form method="post" action="/dashboard/settings/backup/restore-remote" class="inline" data-confirm="从 WebDAV 下载并恢复这份备份？会先暂存，重启服务后生效。">
        <input type="hidden" name="name" value="${e(f.name)}">
        <button class="btn btn-ghost small" type="submit">下载并恢复</button>
      </form>
    </td>
  </tr>`).join('');

  return `<section class="panel">
    <div class="panel-head"><h2>完整备份与恢复</h2></div>
    <p class="muted small" style="margin:0 0 10px">
      完整备份是 SQLite 一致性快照，包含交易、账户、标签、笔记、同步配置和笔记图片。
      笔记图片以 BLOB 存在 <code>resources</code> 表，恢复后 <code>/media/...</code> 会照常显示；
      JSON / CSV 导出不包含图片二进制。
    </p>
    <div class="mini-strip">
      <div class="mini-stat"><span>本地快照</span><b>${fmtNum(local.length)} 份</b></div>
      <div class="mini-stat"><span>最近本地</span><b class="small">${config.lastLocalAt ? e(fmtDateTime(config.lastLocalAt)) : '—'}</b></div>
      <div class="mini-stat"><span>最近 WebDAV</span><b class="small ${config.lastRemoteStatus === 'error' ? 'neg' : ''}">${config.lastRemoteAt ? e(fmtDateTime(config.lastRemoteAt)) : (config.lastRemoteAttemptAt ? '上次失败' : '—')}</b></div>
      <div class="mini-stat"><span>备份内容</span><b class="small">数据库 + 图片</b></div>
    </div>

    ${pending ? `<div class="alert alert-info">
      <b>已暂存恢复：</b>${e(pending.name || '备份文件')} · ${e(pending.at ? fmtDateTime(pending.at) : '')}
      <p class="small" style="margin:6px 0">重启 TradeLedger 服务后会自动替换数据库；替换前会把当前数据库保存到 <code>data/backups/pre-restore-*.db</code>。</p>
      <form method="post" action="/dashboard/settings/backup/cancel-restore" class="inline">
        <button class="btn btn-ghost small" type="submit">取消待恢复</button>
      </form>
    </div>` : ''}

    <div class="panel-head" style="margin-top:12px"><h2>本地快照</h2>
      <form method="post" action="/dashboard/settings/backup/local" class="inline">
        <button class="btn btn-primary small" type="submit">立即创建快照</button>
      </form>
    </div>
    ${localRows ? `<table class="table">
      <thead><tr><th>文件</th><th>时间</th><th>大小</th><th>操作</th></tr></thead>
      <tbody>${localRows}</tbody>
    </table>` : '<p class="muted small">还没有本地快照。首次自动备份会在后台创建，也可以点上面的按钮立即创建。</p>'}

    <div class="panel-head" style="margin-top:18px"><h2>WebDAV 自动备份</h2></div>
    <p class="muted small" style="margin:0 0 8px">
      支持 Nextcloud、坚果云等 WebDAV 服务。坚果云/Nextcloud 请使用「应用密码」，不要用登录密码。
      备份会先 gzip 压缩；设置备份密码后，上传前再用 AES-256-GCM 加密。
      默认「增量」模式：快照按内容分块，只上传变化的块（首次仍会完整上传）；切回「完整」则每次上传整包。
    </p>
    <form method="post" action="/dashboard/settings/backup/webdav" class="form grid-form">
      <label class="field checkbox-field"><span>本地自动快照</span>
        <label class="check"><input type="checkbox" name="local_enabled" value="1" ${config.localEnabled ? 'checked' : ''}> 按间隔自动创建</label>
      </label>
      <label class="field"><span>本地间隔（小时）</span><input type="number" name="local_interval_hours" min="1" max="720" value="${Number(config.localIntervalHours) || 24}"></label>
      <label class="field"><span>本地保留份数</span><input type="number" name="local_keep" min="1" max="100" value="${Number(config.localKeep) || 14}"></label>
      <label class="field checkbox-field"><span>WebDAV 自动备份</span>
        <label class="check"><input type="checkbox" name="webdav_enabled" value="1" ${config.webdavEnabled ? 'checked' : ''}> 启用</label>
      </label>
      <label class="field wide"><span>WebDAV 地址</span>
        <input name="webdav_url" maxlength="500" value="${e(config.webdavUrl || '')}" placeholder="https://dav.jianguoyun.com/dav/">
      </label>
      <label class="field"><span>用户名</span>
        <input name="webdav_username" maxlength="200" value="${e(config.webdavUsername || '')}" autocomplete="username">
      </label>
      <label class="field"><span>密码 / 应用密码</span>
        <input type="password" name="webdav_password" maxlength="500" placeholder="${config.hasWebdavPassword ? '已保存，留空不变' : '未设置'}" autocomplete="new-password">
      </label>
      <label class="field"><span>远端目录</span>
        <input name="webdav_dir" maxlength="200" value="${e(config.webdavDir || 'TradeLedger')}" placeholder="TradeLedger">
      </label>
      <label class="field"><span>备份间隔（小时）</span>
        <input type="number" name="interval_hours" min="1" max="720" value="${Number(config.intervalHours) || 24}">
      </label>
      <label class="field"><span>远端保留份数</span>
        <input type="number" name="keep" min="1" max="100" value="${Number(config.keep) || 14}">
      </label>
      <label class="field"><span>WebDAV 备份模式</span>
        <select name="backup_mode">
          <option value="incremental" ${config.backupMode !== 'full' ? 'selected' : ''}>增量（分块去重，推荐）</option>
          <option value="full" ${config.backupMode === 'full' ? 'selected' : ''}>完整（每次单个压缩包）</option>
        </select>
      </label>
      <label class="field"><span>备份密码（可选，≥8 位）</span>
        <input type="password" name="passphrase" maxlength="200" placeholder="${config.hasPassphrase ? '已设置，留空不变' : '未设置（上传不加密）'}" autocomplete="new-password">
      </label>
      <label class="check"><input type="checkbox" name="clear_webdav_password" value="1"> 清除已保存的 WebDAV 密码</label>
      <label class="check"><input type="checkbox" name="clear_passphrase" value="1"> 清除已保存的备份密码</label>
      <div class="form-actions wide">
        <button class="btn btn-primary" type="submit">保存备份设置</button>
        <button class="btn btn-ghost" type="submit" formaction="/dashboard/settings/backup/test">测试连接</button>
        <button class="btn btn-ghost" type="submit" formaction="/dashboard/settings/backup/run">立即备份到 WebDAV</button>
      </div>
    </form>
    ${config.lastRemoteMessage ? `<p class="chart-note ${config.lastRemoteStatus === 'error' ? 'neg' : ''}">最近一次 WebDAV：${e(config.lastRemoteMessage)}</p>` : ''}

    <div class="panel-head" style="margin-top:18px"><h2>远端备份</h2>
      <a class="btn btn-ghost small" href="/dashboard/settings?remote=1">刷新远端列表</a>
    </div>
    ${remoteError ? `<div class="alert alert-error">${e(remoteError)}</div>` : ''}
    ${remoteRequested && remote === null && !remoteError ? '<p class="muted small">尚未启用 WebDAV 备份，或没有配置地址。</p>' : ''}
    ${remote ? (remoteRows ? `<table class="table">
      <thead><tr><th>文件</th><th>时间</th><th>大小</th><th>加密</th><th>操作</th></tr></thead>
      <tbody>${remoteRows}</tbody>
    </table>` : '<p class="muted small">远端还没有备份。</p>') : (remoteRequested ? '' : '<p class="muted small">点击「刷新远端列表」从 WebDAV 读取备份清单。</p>')}
  </section>`;
}

function agentApiSection({ tokens = [], audit = [], newToken = null, actionQuery = '' }) {
  const now = Date.now();
  const statusOf = (t) => {
    if (t.revoked_at) return { label: '已撤销', cls: 'muted' };
    if (t.expires_at && Date.parse(t.expires_at) <= now) return { label: '已过期', cls: 'neg' };
    return { label: '有效', cls: 'pos' };
  };
  const rows = tokens.map((t) => {
    const st = statusOf(t);
    const scope = String(t.scopes || '').includes('write') ? '读写' : '只读';
    return `<tr>
      <td class="small"><b>${e(t.name)}</b></td>
      <td class="small"><code>${e(t.hint)}</code></td>
      <td class="small">${scope}</td>
      <td class="small">${e(fmtDateTime(t.created_at))}</td>
      <td class="small">${t.last_used_at ? e(fmtDateTime(t.last_used_at)) : '—'}</td>
      <td class="small">${t.expires_at ? e(fmtDateTime(t.expires_at)) : '永久'}</td>
      <td class="small ${st.cls}">${st.label}</td>
      <td class="row-actions">${t.revoked_at ? '' : `<form method="post" action="/dashboard/settings/api-tokens/${Number(t.id)}/revoke${actionQuery}" class="inline" data-confirm="撤销后使用该 Token 的 Agent 会立即失效，继续吗？">
        <button class="btn btn-ghost small danger" type="submit">撤销</button>
      </form>`}</td>
    </tr>`;
  }).join('');

  const auditRows = audit.map((a) => `<tr>
    <td class="small">${e(fmtDateTime(a.created_at))}</td>
    <td class="small"><code>${e(a.method)} ${e(a.path)}</code></td>
    <td class="small ${Number(a.status) >= 400 ? 'neg' : 'pos'}">${fmtNum(a.status)}</td>
    <td class="small">${e(a.token_name || '登录会话')}</td>
    <td class="small muted">${e(a.ip || '—')}</td>
    <td class="small muted">${fmtNum(a.ms)}ms</td>
  </tr>`).join('');

  return `<section class="panel" id="agent-api">
    <div class="panel-head"><h2>Agent 接入（API / MCP）</h2><span class="muted small">/api/v1 · Bearer Token</span></div>
    <p class="muted small" style="margin:0 0 10px">
      给外部 Agent 用的独立令牌：只能访问 <code>/api/v1/*</code>（交易查询、统计、持仓、笔记与标签），
      不能打开页面、读取账户密钥或触发同步。「读写」也只允许写备注、标签和持仓笔记。
      Token 明文<b>只显示一次</b>，服务端只保存哈希；公网使用请务必走 HTTPS，并在防火墙限制来源 IP。
    </p>
    ${newToken ? `<div class="alert alert-info">
      <b>新 Token 已创建，只显示这一次：</b>
      <pre style="margin:8px 0;white-space:pre-wrap;word-break:break-all"><code>${e(newToken.token)}</code></pre>
      <p class="small" style="margin:0">复制到 Agent 配置后刷新本页即不可再查看；遗失请撤销后重新创建。</p>
    </div>` : ''}
    <form method="post" action="/dashboard/settings/api-tokens${actionQuery}" class="form grid-form">
      <label class="field"><span>名称</span><input name="name" maxlength="60" placeholder="ZCode / Claude Desktop"></label>
      <label class="field"><span>权限</span>
        <select name="scopes">
          <option value="read">只读（查询）</option>
          <option value="write">读写（查询 + 备注/标签）</option>
        </select>
      </label>
      <label class="field"><span>有效期</span>
        <select name="expiresDays">
          <option value="">永久</option>
          <option value="30">30 天</option>
          <option value="90">90 天</option>
          <option value="365">365 天</option>
        </select>
      </label>
      <div class="form-actions wide"><button class="btn btn-primary" type="submit">创建 Token</button></div>
    </form>
    ${rows ? `<table class="table" style="margin-top:12px">
      <thead><tr><th>名称</th><th>提示</th><th>权限</th><th>创建</th><th>最近使用</th><th>到期</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : '<p class="muted small">还没有 Token。创建后可在 Agent 的 MCP 配置或脚本里使用。</p>'}
    <p class="muted small" style="margin:12px 0 0">
      接口列表与 curl 示例见 <a href="/api/docs">/api/docs</a>；MCP 桥接脚本为仓库内
      <code>scripts/mcp-server.mjs</code>，环境变量 <code>TRADELEDGER_BASE_URL</code> 与
      <code>TRADELEDGER_API_TOKEN</code>。
    </p>
    ${auditRows ? `<div class="panel-head" style="margin-top:16px"><h2>最近调用</h2><span class="muted small">保留 30 天 · 最近 20 条</span></div>
    <table class="table">
      <thead><tr><th>时间</th><th>请求</th><th>状态</th><th>Token</th><th>IP</th><th>耗时</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>` : ''}
  </section>`;
}

export function settingsPage({ user, overview, dbBytes, seededAt, recentImports = [], notice, error, backup = {}, net = {}, apiTokens = [], apiAudit = [], newToken = null }) {
  const demoBox = overview.demoAccounts
    ? `<div class="danger-row">
        <div><b>清除演示数据</b><p class="muted small">删除 ${overview.demoAccounts} 个演示账户及其全部交易，保留真实交易、笔记和标签。</p></div>
        <form method="post" action="/dashboard/settings/clear-demo" data-confirm="确定清除全部演示数据吗？真实交易不会被删除。">
          <button class="btn btn-ghost" type="submit">清除演示数据</button>
        </form>
      </div>`
    : '<p class="muted small">当前没有演示账户。</p>';

  const body = `
    ${settingsNav('general')}
    <div class="mini-strip">
      <div class="mini-stat"><span>交易</span><b>${fmtNum(overview.trades)} 笔</b></div>
      <div class="mini-stat"><span>账户</span><b>${fmtNum(overview.accounts)} 个</b></div>
      <div class="mini-stat"><span>标签 / 笔记</span><b>${fmtNum(overview.tags)} / ${fmtNum(overview.notes)}</b></div>
      <div class="mini-stat"><span>数据库大小</span><b>${fmtBytes(dbBytes)}</b></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>个人资料</h2></div>
      <form method="post" action="/dashboard/settings" class="form grid-form">
        <label class="field"><span>显示名</span><input name="display_name" maxlength="60" value="${e(user.display_name || '')}"></label>
        <label class="field wide"><span>简介</span><textarea name="bio" rows="2" maxlength="500">${e(user.bio || '')}</textarea></label>
        <div class="form-actions wide"><button class="btn btn-primary" type="submit">保存</button></div>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>导出</h2></div>
      <div class="export-grid">
        <div class="export-card">
          <h3>全量 JSON</h3>
          <p class="muted small">交易、账户、标签、笔记、导入记录。适合长期备份与迁移；不包含笔记图片。</p>
          <a class="btn btn-ghost" href="/api/export?format=json">下载 JSON</a>
        </div>
        <div class="export-card">
          <h3>交易 CSV</h3>
          <p class="muted small">字段与 CSV 导入器兼容，可以在另一个实例里重新导入。</p>
          <a class="btn btn-ghost" href="/api/export?format=csv">下载 CSV</a>
        </div>
      </div>
      <p class="chart-note">需要包含笔记图片的完整备份，请用下面的「完整备份与恢复」。</p>
    </section>

    ${backupSection(backup)}
    <div class="panel-head" style="margin-top:18px"><h2>交易所网络代理</h2></div>
    <form method="post" action="/dashboard/settings/net-proxy" class="form">
      <label class="field"><span>代理地址（留空 = 不使用；支持 http:// 与 socks5://，可带账号密码 user:pass@host:port）</span>
        <input name="proxy" value="${e(net.proxy || '')}" placeholder="例如 socks5://127.0.0.1:7891 或 http://127.0.0.1:7891">
      </label>
      <label class="field"><span>生效域名（逗号分隔的后缀，这些域名的流量强制走代理；其余域名直连失败时也会自动回退到代理）</span>
        <input name="hosts" value="${e(net.hosts || '')}" placeholder="例如 binance.com,bybit.com">
      </label>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">保存代理设置</button>
        <span class="muted small">保存后约 15 秒内生效，无需重启；留空则恢复默认（不使用专用代理）</span>
      </div>
    </form>

    <section class="panel">
      <div class="panel-head"><h2>交易所凭据</h2></div>
      <p class="muted small" style="margin:0 0 8px">
        API Key / Secret 使用 AES-256-GCM 加密后保存在本地数据库，视图与导出都不会输出密文。
        主密钥优先读取环境变量 <code>TRADELEDGER_MASTER_KEY</code>；未配置时首次运行会在数据库同目录生成
        <code>data/master.key</code>。换机器迁移时请把数据库和 master.key 一起带走，否则旧凭据无法解密。
      </p>
      <p class="muted small" style="margin:0">
        当前同步记录 ${fmtNum(overview.syncRuns)} 次。只读 Key 只能拉取历史，无法下单或提现。
      </p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>数据维护</h2></div>
      ${demoBox}
      ${seededAt ? `<p class="muted small">演示数据生成于 ${e(fmtDateTime(seededAt))}</p>` : ''}
      <div class="danger-row">
        <div><b class="danger-text">清空全部数据</b>
          <p class="muted small">删除交易、成交缓存、标签、笔记、导入记录、AI 报告、设置、已保存密钥与所有账户。不可恢复，请先导出备份。</p></div>
        <form method="post" action="/dashboard/settings/reset" data-confirm="最后确认：清空全部数据？此操作不可恢复。">
          <button class="btn btn-ghost danger" type="submit">清空全部数据</button>
        </form>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>最近导入</h2><span class="muted small">最多 10 条 · 完整历史在<a href="/dashboard/import">数据导入</a>页</span></div>
      ${recentImports.length ? `<table class="table">
        <thead><tr><th>时间</th><th>账户</th><th>文件</th><th class="num">行数</th><th class="num">入库</th><th class="num">跳过</th><th class="num">失败</th></tr></thead>
        <tbody>${recentImports.map((i) => `<tr>
          <td class="small">${e(fmtDateTime(i.created_at))}</td>
          <td class="small">${e(i.account_name || '—')}</td>
          <td class="small"><code>${e(i.filename)}</code></td>
          <td class="num">${fmtNum(i.rows)}</td>
          <td class="num pos">${fmtNum(i.inserted)}</td>
          <td class="num muted">${fmtNum(i.skipped)}</td>
          <td class="num ${i.failed ? 'neg' : 'muted'}">${fmtNum(i.failed)}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<p class="muted small">还没有导入记录。CSV 导入在<a href="/dashboard/import">数据导入</a>页完成。</p>'}
    </section>

    ${agentApiSection({ tokens: apiTokens, audit: apiAudit, newToken })}

    <section class="panel">
      <div class="panel-head"><h2>关于</h2></div>
      <p class="muted small">
        TradeLedger v${e(APP_VERSION)} · 本地优先 · 单密码登录 · 零第三方依赖。<br>
        前端资源构建于 ${e(BUILD_TIME)}——页面显示的界面与这里对不上时，强刷一次浏览器（Ctrl+F5）即可对齐。<br>
        访问密码来自环境变量 <code>TRADELEDGER_PASSWORD</code>，修改后需要重启服务；
        已登录的会话最长 30 天有效。<br>
        部署到 UTC 服务器时，可设置环境变量 <code>TRADELEDGER_TZ=Asia/Shanghai</code>，
        让热力图、日历与周期报告仍按北京时间计算。
        开发者接口：<a href="/api/docs">/api/docs</a>。
      </p>
    </section>`;

  return shell({
    active: 'settings', user, title: '设置与数据',
    subtitle: '数据在你手里：随时导出，随时搬走',
    notice, error, body,
  });
}

/** Agent 接入独立页：Token 管理 + REST / MCP 用法 */
export function agentSettingsPage({ user, notice, error, apiTokens = [], apiAudit = [], newToken = null }) {
  return shell({
    active: 'agent',
    user,
    title: 'Agent 接入',
    subtitle: '给外部 Agent 的独立 Token：只访问 /api/v1，读写仅限备注与标签',
    notice,
    error,
    body: `${settingsNav('agent')}
      <section class="panel">
        <div class="panel-head"><h2>怎么接</h2><span class="muted small">Bearer Token · 与登录 Cookie 隔离</span></div>
        <ol class="muted small" style="margin:0 0 10px;padding-left:18px">
          <li>在下方创建 Token：只查询选「只读」，需要写复盘/标签选「读写」。</li>
          <li>REST：请求头加 <code>Authorization: Bearer tl_...</code>，端点前缀 <code>/api/v1</code>。</li>
          <li>MCP：把仓库里的 <code>scripts/mcp-server.mjs</code> 配到客户端，环境变量填地址与 Token。</li>
        </ol>
        <pre style="white-space:pre-wrap"><code>curl -H "Authorization: Bearer tl_xxx" http://你的地址/api/v1/trades?limit=20</code></pre>
        <pre style="white-space:pre-wrap"><code>{
  "mcpServers": {
    "tradeledger": {
      "command": "node",
      "args": ["F:/zcode/tradeledger/scripts/mcp-server.mjs"],
      "env": {
        "TRADELEDGER_BASE_URL": "http://你的地址",
        "TRADELEDGER_API_TOKEN": "tl_xxx"
      }
    }
  }
}</code></pre>
        <p class="muted small" style="margin:10px 0 0">
          完整端点见 <a href="/api/docs">/api/docs</a>。Token 只能访问 v1，
          不能读账户密钥、触发同步或删除交易；所有调用都会留审计。
        </p>
      </section>
      ${agentApiSection({ tokens: apiTokens, audit: apiAudit, newToken, actionQuery: '?tab=agent' })}`,
  });
}
