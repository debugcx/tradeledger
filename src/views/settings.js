import { escapeHtml as e, fmtBytes, fmtNum, fmtDateTime } from '../http.js';
import { shell, settingsNav } from './layout.js';

function backupSection({ config = {}, local = [], remote = null, remoteError = '', remoteRequested = false }) {
  const pending = config.pending;
  const localRows = local.map((b) => `<tr>
    <td class="small"><code>${e(b.name)}</code></td>
    <td class="small">${e(fmtDateTime(b.created_at))}</td>
    <td>${fmtBytes(b.bytes)}</td>
    <td class="row-actions">
      <a class="btn btn-ghost small" href="/dashboard/settings/backup/download?name=${encodeURIComponent(b.name)}" download>下载</a>
      <form method="post" action="/dashboard/settings/backup/restore-local" class="inline" onsubmit="return confirm('恢复会覆盖当前数据库，并在重启服务后生效。继续吗？')">
        <input type="hidden" name="name" value="${e(b.name)}">
        <button class="btn btn-ghost small" type="submit">恢复</button>
      </form>
      <form method="post" action="/dashboard/settings/backup/delete" class="inline" onsubmit="return confirm('删除这个本地快照？')">
        <input type="hidden" name="name" value="${e(b.name)}">
        <button class="btn btn-ghost small danger" type="submit">删除</button>
      </form>
    </td>
  </tr>`).join('');

  const remoteRows = (remote || []).map((f) => `<tr>
    <td class="small"><code>${e(f.name)}</code></td>
    <td class="small">${e(f.created_at ? fmtDateTime(f.created_at) : '—')}</td>
    <td>${fmtBytes(f.bytes)}</td>
    <td>${f.encrypted ? '已加密' : '<span class="muted">未加密</span>'}</td>
    <td class="row-actions">
      <form method="post" action="/dashboard/settings/backup/restore-remote" class="inline" onsubmit="return confirm('从 WebDAV 下载并恢复这份备份？会先暂存，重启服务后生效。')">
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

export function settingsPage({ user, overview, dbBytes, seededAt, notice, error, backup = {} }) {
  const demoBox = overview.demoAccounts
    ? `<div class="danger-row">
        <div><b>清除演示数据</b><p class="muted small">删除 ${overview.demoAccounts} 个演示账户及其全部交易，保留真实交易、笔记和标签。</p></div>
        <form method="post" action="/dashboard/settings/clear-demo" onsubmit="return confirm('确定清除全部演示数据吗？真实交易不会被删除。')">
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
          <p class="muted small">删除交易、标签、笔记、导入记录与所有账户。不可恢复，请先导出备份。</p></div>
        <form method="post" action="/dashboard/settings/reset" onsubmit="return confirm('最后确认：清空全部数据？此操作不可恢复。')">
          <button class="btn btn-ghost danger" type="submit">清空全部数据</button>
        </form>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>关于</h2></div>
      <p class="muted small">
        TradeLedger v0.1 · 本地优先 · 单密码登录 · 零第三方依赖。<br>
        访问密码来自环境变量 <code>TRADELEDGER_PASSWORD</code>，修改后需要重启服务；
        已登录的会话最长 30 天有效。
      </p>
    </section>`;

  return shell({
    active: 'settings', user, title: '设置与数据',
    subtitle: '数据在你手里：随时导出，随时搬走',
    notice, error, body,
  });
}
