/**
 * HTTP 冒烟测试：对运行中的实例跑一遍全部路由与核心写流程。
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs http://127.0.0.1:8790
 *
 * 环境变量：SMOKE_PASSWORD（默认 demo1234）
 */

const base = process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:8790';
const password = process.env.SMOKE_PASSWORD || 'demo1234';

let cookie = '';
let pass = 0;
let fail = 0;
const failures = [];

function record(ok, label, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(`${label} ${detail}`);
    console.log(`  ✗ ${label} ${detail}`);
  }
}

async function req(path, { method = 'GET', form, body, headers = {}, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (form) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body) {
    payload = body;
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

const text = (res) => res.text();
const jsonOf = (res) => res.json();

/* ---------------- 公开路由 ---------------- */

console.log(`\n▶ 公开路由 (${base})`);
{
  const login = await req('/login');
  const html = await text(login);
  record(login.status === 200, 'GET /login → 200', `→ ${login.status}`);
  record(html.includes('访问密码') && html.includes('TradeLedger'), '登录页渲染正常');

  const health = await req('/api/health');
  const h = await jsonOf(health);
  record(health.status === 200 && h.ok === true, 'GET /api/health → 200 ok', `→ ${health.status}`);

  for (const path of ['/style.css', '/app.js']) {
    const res = await req(path);
    record(res.status === 200, `GET ${path} → 200`, `→ ${res.status}`);
  }

  const missing = await req('/no-such-page');
  record(missing.status === 404, 'GET /no-such-page → 404', `→ ${missing.status}`);
}

/* ---------------- 未登录 ---------------- */

console.log('\n▶ 未登录保护');
for (const path of ['/dashboard', '/dashboard/calendar', '/dashboard/journal', '/dashboard/import',
  '/dashboard/tags', '/dashboard/notes', '/dashboard/settings']) {
  const res = await req(path);
  record(res.status === 302 && String(res.headers.get('location')).startsWith('/login'),
    `GET ${path} → 302 /login`, `→ ${res.status}`);
}
{
  const res = await req('/api/summary');
  record(res.status === 401, 'GET /api/summary 未登录 → 401', `→ ${res.status}`);
}

/* ---------------- 登录 ---------------- */

console.log('\n▶ 登录');
{
  const bad = await req('/login', { method: 'POST', form: { password: 'definitely-wrong' } });
  record(bad.status === 401, '错误密码 → 401', `→ ${bad.status}`);

  const good = await req('/login', { method: 'POST', form: { password, remember: '1' } });
  record(good.status === 302, '正确密码 → 302', `→ ${good.status}`);
  record(cookie.startsWith('tl_session='), '拿到会话 Cookie');

  const again = await req('/login');
  record(again.status === 302, '已登录访问 /login → 302', `→ ${again.status}`);
}

/* ---------------- 页面 ---------------- */

console.log('\n▶ 登录后页面');
const protectedPaths = ['/dashboard', '/dashboard/calendar', '/dashboard/journal', '/dashboard/journal/new',
  '/dashboard/transfers', '/dashboard/spot', '/dashboard/import', '/dashboard/accounts', '/dashboard/accounts/new',
  '/dashboard/reconcile', '/dashboard/review', '/dashboard/tags', '/dashboard/notes',
  '/dashboard/notes/new', '/dashboard/settings', '/api/docs'];
for (const path of protectedPaths) {
  const res = await req(path);
  record(res.status === 200, `GET ${path} → 200`, `→ ${res.status}`);
}
{
  const html = await text(await req('/dashboard/settings'));
  record(html.includes('完整备份与恢复') && html.includes('WebDAV 自动备份'), '设置页包含完整备份与 WebDAV 配置');
}

console.log('\n▶ 仪表盘内容');
{
  const html = await text(await req('/dashboard'));
  for (const needle of ['周 × 小时盈亏热力图', '复盘覆盖率', '资金费与手续费', '标签报告', '最近交易', '多空比', '实时持仓']) {
    record(html.includes(needle), `仪表盘包含「${needle}」`);
  }
  record(html.includes('data-live-panel'), '实时持仓面板已渲染');
  record(html.includes('资金费流水'), '资金费流水统计已渲染');
  record((html.match(/heatmap-hour/g) || []).length === 1, '热力图 SVG 已渲染');
  record(html.includes('最赚钱的时段') && html.includes('胜率最高的时段'), '热力图附带最佳/最差时段');
  record(html.includes('href="/dashboard/accounts"') && html.includes('href="/dashboard/reconcile"')
    && html.includes('href="/dashboard/review"') && html.includes('href="/dashboard/transfers"')
    && html.includes('href="/dashboard/spot"') && !html.includes('href="/dashboard/ai"'),
  '侧栏包含交易所/资金流水/现货/对账/周期报告（无 AI 复盘）');
  record(html.indexOf('设置与数据') >= 0 && html.indexOf('设置与数据') < html.indexOf('href="/dashboard/reconcile"'),
    '对账已归入「设置与数据」分组');
  record(!html.includes('现货资产种类'), '现货计数不再用「余额种类」口径');
}

console.log('\n▶ 日历');
{
  const html = await text(await req('/dashboard/calendar'));
  record(html.includes('cal-grid') && html.includes('cal-legend'), '日历网格渲染');
  record(html.includes('本月盈亏'), '日历带月度汇总');
}

console.log('\n▶ 交易列表');
let summaryBefore = 0;
{
  const html = await text(await req('/dashboard/journal'));
  record(html.includes('class="pager"'), '有分页条');
  record(html.includes('条 / 共'), '显示分页统计');
  record(!html.includes('quick-note'), '列表不再有行内复盘输入（复盘在详情页）');
  summaryBefore = (await jsonOf(await req('/api/summary'))).total_trades;
  record(summaryBefore > 0, `演示数据已就绪（${summaryBefore} 笔）`);
}

/* ---------------- 统计 API ---------------- */

console.log('\n▶ 统计 API');
{
  const s = await jsonOf(await req('/api/summary'));
  record(s.total_trades === summaryBefore, 'summary 交易数与列表一致', `→ ${s.total_trades}`);
  record(typeof s.total_pnl === 'number', 'summary 有 total_pnl');
  record(Array.isArray(s.hour_weekday) && s.hour_weekday.length === 7
    && s.hour_weekday.every((row) => row.length === 24), 'hour_weekday 是 7×24 矩阵');
  record(s.note_coverage.total === s.total_trades, 'note_coverage 总数一致');
}

/* ---------------- P1：交易所与对账 ---------------- */

console.log('\n▶ P1 交易所与对账');
{
  const accountsHtml = await text(await req('/dashboard/accounts'));
  record(accountsHtml.includes('已接入账户') && accountsHtml.includes('添加交易所'), '交易所页渲染');
  record(accountsHtml.includes('演示账户不可同步'), '演示账户不可同步');

  const okxNew = await text(await req('/dashboard/accounts/new?exchange=okx'));
  record(okxNew.includes('Passphrase') && okxNew.includes('验证并保存'), 'OKX 表单含 Passphrase');
  record(okxNew.includes('历史回溯范围') && okxNew.includes('全部可用'), '账户表单含历史范围选项');
  const hlNew = await text(await req('/dashboard/accounts/new?exchange=hyperliquid'));
  record(hlNew.includes('钱包地址') && !hlNew.includes('API Secret'), 'Hyperliquid 只要求钱包地址');

  const transfersHtml = await text(await req('/dashboard/transfers'));
  record(transfersHtml.includes('充提、划转与返佣') && transfersHtml.includes('总充值'), '资金流水页渲染');
  record(transfersHtml.includes('value="rebate"') && transfersHtml.includes('>返佣</option>'), '资金流水支持按返佣筛选');
  const transfersApi = await jsonOf(await req('/api/transfers'));
  record(transfersApi.count === 0 && transfersApi.summary, '资金流水 API 正常');
  const dashNoRebate = await text(await req('/dashboard'));
  record(!dashNoRebate.includes('账单返佣'), '无返佣数据时仪表盘不显示账单返佣统计');
  record(dashNoRebate.includes('成交记录里的正手续费（负费率）'), '做市返佣保留并注明口径');

  // 行为诊断 + 优先复盘
  record(dashNoRebate.includes('行为诊断'), '仪表盘包含行为诊断面板');
  record(dashNoRebate.includes('保本线'), '行为诊断展示盈亏比保本线');
  record(dashNoRebate.includes('优先复盘'), '仪表盘包含优先复盘队列');
  record(dashNoRebate.includes('快捷标签') || dashNoRebate.includes('大亏交易都已写过复盘'), '复盘队列快捷标签渲染');

  const spotHtml = await text(await req('/dashboard/spot'));
  record(spotHtml.includes('现货持仓') && spotHtml.includes('现货成交'), '现货页渲染');
  const spotApi = await jsonOf(await req('/api/spot'));
  record(Array.isArray(spotApi.balances) && Array.isArray(spotApi.holdings)
    && Array.isArray(spotApi.fills), '现货 API 结构正确');
  const spotSummary = await jsonOf(await req('/api/summary?market=spot'));
  record(spotSummary.market === 'spot' && spotSummary.total_trades === 0, '市场过滤：演示库无现货交易');

  const badExchange = await req('/dashboard/accounts/new', {
    method: 'POST', form: { exchange: 'notreal', name: 'x' },
  });
  record(badExchange.status === 400, '不支持的交易所 → 400', `→ ${badExchange.status}`);

  const missing = await req('/dashboard/accounts/new', {
    method: 'POST', form: { exchange: 'okx', name: 'x', api_key: '', api_secret: '', passphrase: '' },
  });
  record(missing.status === 400, '缺凭据 → 400', `→ ${missing.status}`);

  const syncMissing = await req('/dashboard/accounts/999999/sync', { method: 'POST', form: { limit: '100' } });
  const syncBody = await syncMissing.json().catch(() => null);
  record(syncMissing.status === 400, '同步不存在的账户 → 400', `→ ${syncMissing.status}`);
  record(syncBody?.ok === false && /账户不存在/.test(String(syncBody.error || '')), '同步错误返回 JSON 原因');

  const statusRes = await req('/api/accounts/status');
  const statusBody = await statusRes.json();
  record(statusRes.status === 200 && Array.isArray(statusBody.accounts), '账户同步状态 API 正常');
  record(accountsHtml.includes('data-account-row'), '账户行带自动刷新锚点');

  const liveRes = await req('/api/positions/live');
  const live = await liveRes.json();
  record(liveRes.status === 200 && Array.isArray(live.positions) && Array.isArray(live.balances),
    '实时持仓 API 结构正确');
  record(typeof live.hasRealAccounts === 'boolean', '实时持仓带 hasRealAccounts 标记');

  const reconHtml = await text(await req('/dashboard/reconcile'));
  record(reconHtml.includes('对账说明') && reconHtml.includes('按来源'), '对账页渲染');
  record(reconHtml.includes('一致率'), '对账页显示一致率');
  const recon = await jsonOf(await req('/api/reconcile'));
  record(recon.total === summaryBefore, '对账覆盖全部交易', `→ ${recon.total}`);
  record(recon.checked > 0 && recon.mismatches < recon.checked, '对账统计合理',
    `checked=${recon.checked} mismatch=${recon.mismatches}`);
}

/* ---------------- P2：周报与 AI 上下文 ---------------- */

console.log('\n▶ P2 周报与 AI 上下文');
{
  const reviewHtml = await text(await req('/dashboard/review'));
  record(reviewHtml.includes('周期报告') && reviewHtml.includes('建议追问') && reviewHtml.includes('AI 生成报告解读'), '周期报告页渲染');
  record(reviewHtml.includes('kind=month') && reviewHtml.includes('kind=year'), '周报 / 月报 / 年报切换');
  record(reviewHtml.includes('下载 Markdown') && reviewHtml.includes('下载 JSON'), '报告有导出入口');

  const review = await jsonOf(await req('/api/review?format=json'));
  record(review.period && review.stats && Array.isArray(review.questions), '周报 JSON 结构正确');

  const mdRes = await req('/api/review?format=md');
  const md = await text(mdRes);
  record(mdRes.status === 200 && /text\/markdown/.test(mdRes.headers.get('content-type') || ''),
    'Markdown 导出 → 200', `→ ${mdRes.status}`);
  record(md.startsWith('# TradeLedger 周报'), 'Markdown 标题正确');
  record(md.includes('给 AI 的复盘提示词'), 'Markdown 含提示词');

  const badWeek = await req('/api/review?week=bad&format=json');
  record(badWeek.status === 200, '非法周参数回退本周', `→ ${badWeek.status}`);
}

/* ---------------- AI ---------------- */

console.log('\n▶ AI');
{
  const aiOld = await req('/dashboard/ai');
  record(aiOld.status === 302 && String(aiOld.headers.get('location')).startsWith('/dashboard/review'),
    '旧入口 /dashboard/ai 重定向到周期报告', `→ ${aiOld.status}`);
  const aiSettingsHtml = await text(await req('/dashboard/settings/ai'));
  record(aiSettingsHtml.includes('模型配置') && aiSettingsHtml.includes('data-ai-test'), 'AI 模型设置页有配置/测试入口');

  if (aiSettingsHtml.includes('还没有保存 API Key')) {
    const test = await req('/api/ai/test', { method: 'POST' });
    const testBody = await test.json().catch(() => null);
    record(test.status === 400 && testBody?.ok === false, '未配置 Key 时测试 → 400', `→ ${test.status}`);
  } else {
    record(true, '已配置 Key，跳过真实调用（避免产生费用）');
  }
}

/* ---------------- Markdown 与图片 ---------------- */

console.log('\n▶ Markdown 与图片');
{
  const md = await jsonOf(await req('/api/markdown', { method: 'POST', form: { text: '# Hi\n\n**B**' } }));
  record(md.ok && md.html.includes('<h1>Hi</h1>') && md.html.includes('<strong>B</strong>'),
    'Markdown API 渲染正确');

  const noteContent = '# smoke 复盘\n\n**执行**不错。\n\n- 减少追高\n';
  await req('/dashboard/notes/save', { method: 'POST', form: { title: 'smoke-md', content: noteContent } });
  const note = (await jsonOf(await req('/api/notes'))).notes.find((n) => n.title === 'smoke-md');
  record(!!note, 'Markdown 笔记已创建');
  if (note) {
    const view = await text(await req(`/dashboard/notes/${note.id}`));
    record(view.includes('<h1>smoke 复盘</h1>') && view.includes('<strong>执行</strong>')
      && view.includes('<li>减少追高</li>'), '笔记按 Markdown 渲染');
    const edit = await text(await req(`/dashboard/notes/${note.id}/edit`));
    record(edit.includes('data-note-image') && edit.includes('data-md-preview'), '编辑页有图片上传与预览');
  }

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const fd = new FormData();
  fd.set('image', new File([png], 'smoke.png', { type: 'image/png' }));
  const upload = await req('/dashboard/notes/upload', { method: 'POST', body: fd });
  const uploadBody = await upload.json();
  record(upload.status === 200 && uploadBody.ok === true, '图片上传 → 200', `→ ${upload.status}`);
  record(String(uploadBody.url || '').startsWith('/media/'), '返回 /media 地址');
  if (uploadBody.url) {
    const media = await req(uploadBody.url);
    record(media.status === 200 && media.headers.get('content-type') === 'image/png', '图片可读取');
  }
  if (note) await req('/dashboard/notes/delete', { method: 'POST', form: { id: String(note.id) } });
}

/* ---------------- 交易写流程 ---------------- */

console.log('\n▶ 交易写流程');
let manualId = null;
{
  const res = await req('/dashboard/journal/new', {
    method: 'POST',
    form: {
      symbol: 'SMOKE-MANUAL/USDT', side: 'long', order_type: 'limit', account_id: '1',
      open_time: '2026-10-01T10:00', close_time: '2026-10-01T12:00',
      entry_price: '100', exit_price: '110', size: '2', notional: '', pnl: '', fee: '-1', funding: '-0.5',
      tags: 'smoke-tag', new_tags: '', note: '冒烟测试',
    },
  });
  record(res.status === 302, '手动新增交易 → 302', `→ ${res.status}`);
  manualId = Number(String(res.headers.get('location') || '').match(/\/dashboard\/journal\/(\d+)/)?.[1]);
  record(!!manualId, `拿到新交易 id=${manualId}`);

  const afterCreate = (await jsonOf(await req('/api/summary'))).total_trades;
  record(afterCreate === summaryBefore + 1, `交易数 ${summaryBefore} → ${afterCreate}`);

  const detail = await text(await req(`/dashboard/journal/${manualId}`));
  for (const needle of ['盈亏是怎么算出来的', '毛盈亏 = 净盈亏 − 手续费 − 资金费', '独立复算', '复算差异', '交易复盘']) {
    record(detail.includes(needle), `详情页包含「${needle}」`);
  }

  const noteRes = await req(`/api/trades/${manualId}/note`, {
    method: 'POST', form: { note: '行内复盘已保存' },
  });
  record(noteRes.status === 200, '行内复盘接口 → 200', `→ ${noteRes.status}`);
  const row = (await jsonOf(await req('/api/trades?limit=1000'))).trades.find((t) => t.id === manualId);
  record(row?.note === '行内复盘已保存', '复盘笔记已写回');
  record(row?.pnl === 18.5, `净盈亏自动计算正确（${row?.pnl}）`);

  const edit = await req(`/dashboard/journal/${manualId}/edit`, {
    method: 'POST',
    form: {
      symbol: 'SMOKE-MANUAL/USDT', side: 'short', order_type: 'market', account_id: '1',
      open_time: '2026-10-01T10:00', close_time: '2026-10-01T12:00',
      entry_price: '100', exit_price: '110', size: '2', notional: '200', pnl: '11.5',
      fee: '-1', funding: '-0.5', tags: 'smoke-tag', new_tags: '', note: '冒烟测试',
    },
  });
  record(edit.status === 302, '编辑交易 → 302', `→ ${edit.status}`);
  const edited = (await jsonOf(await req('/api/trades?limit=1000'))).trades.find((t) => t.id === manualId);
  record(edited?.side === 'short', '方向已更新');
}

/* ---------------- 标签 / 笔记 ---------------- */

console.log('\n▶ 标签与笔记');
{
  const tagsBefore = (await jsonOf(await req('/api/tags'))).tags.length;
  await req('/dashboard/tags', { method: 'POST', form: { name: 'smoke-tag', color: '#4ade80' } });
  const tags = (await jsonOf(await req('/api/tags'))).tags;
  record(tags.some((t) => t.name === 'smoke-tag'), '标签可读回');
  const tagHtml = await text(await req('/dashboard/tags'));
  record(tagHtml.includes('标签表现') && tagHtml.includes('交易预期'), '标签页有表现报告');
  record(tags.length >= tagsBefore, '标签数量未减少');

  await req('/dashboard/notes/save', { method: 'POST', form: { title: 'smoke-note', content: '冒烟笔记' } });
  const notes = (await jsonOf(await req('/api/notes'))).notes;
  const smokeNote = notes.find((n) => n.title === 'smoke-note');
  record(!!smokeNote, '笔记可读回');
  if (smokeNote) {
    const detail = await req(`/dashboard/notes/${smokeNote.id}`);
    record(detail.status === 200, '笔记详情页 → 200', `→ ${detail.status}`);
    await req('/dashboard/notes/delete', { method: 'POST', form: { id: String(smokeNote.id) } });
    const after = (await jsonOf(await req('/api/notes'))).notes;
    record(!after.some((n) => n.id === smokeNote.id), '笔记已删除');
  }

  // 交易对档案 + 现货备注
  await req('/dashboard/notes/save', {
    method: 'POST',
    form: { category: 'symbol', subject: 'SMOKE/USDT', title: 'SMOKE 交易对档案', content: 'smoke archive' },
  });
  const notes2 = (await jsonOf(await req('/api/notes'))).notes;
  const symbolNote = notes2.find((n) => n.title === 'SMOKE 交易对档案');
  record(!!symbolNote && symbolNote.category === 'symbol', '交易对档案已创建');
  if (symbolNote) {
    const symbolPage = await text(await req('/dashboard/notes/symbol/SMOKE%2FUSDT'));
    record(symbolPage.includes('smoke archive') && symbolPage.includes('逐笔复盘'), '交易对档案页可读');
  }

  const spotNoteRes = await req('/api/spot/note', {
    method: 'POST',
    form: { account_id: '1', symbol: 'SMOKE/USDT', note: 'spot smoke note' },
  });
  const spotNoteBody = await spotNoteRes.json().catch(() => null);
  record(spotNoteRes.status === 200 && spotNoteBody?.ok === true, '现货备注已保存');
  const spotNotesHtml = await text(await req('/dashboard/notes?category=spot'));
  record(spotNotesHtml.includes('spot smoke note'), '现货备注出现在笔记分类');

  if (symbolNote) await req('/dashboard/notes/delete', { method: 'POST', form: { id: String(symbolNote.id) } });
  if (spotNoteBody?.id) await req('/dashboard/notes/delete', { method: 'POST', form: { id: String(spotNoteBody.id) } });
}

/* ---------------- CSV 导入 ---------------- */

console.log('\n▶ CSV 导入');
const csvText = 'symbol,side,close_time,pnl,fee,funding,open_time,entry_price,exit_price,size,notional,tags\n'
  + 'SMOKE-CSV-1/USDT,long,2026-10-03 10:00:00,12.5,0.5,0.1,2026-10-03 08:00:00,1,1.05,100,100,smoke-csv\n'
  + 'SMOKE-CSV-2/USDT,short,2026-10-04 10:00:00,-5,0.2,0,2026-10-04 09:00:00,2,1.95,50,100,smoke-csv\n';
{
  const form = new FormData();
  form.set('step', 'preview');
  form.set('account_id', '1');
  form.set('tz_offset', '0');
  form.set('cost_positive', '1');
  form.set('file', new File([csvText], 'smoke.csv', { type: 'text/csv' }));
  const upload = await req('/dashboard/import', { method: 'POST', body: form });
  const uploadHtml = await text(upload);
  record(upload.status === 200, '文件上传预览 → 200', `→ ${upload.status}`);
  record(uploadHtml.includes('确认导入 2 笔'), '上传后解析出 2 笔');

  const preview = await req('/dashboard/import', {
    method: 'POST',
    form: { step: 'preview', account_id: '1', tz_offset: '0', cost_positive: '1', csv_text: csvText },
  });
  const previewHtml = await text(preview);
  record(preview.status === 200 && previewHtml.includes('第 2 步'), '粘贴预览 → 第 2 步', `→ ${preview.status}`);
  record(previewHtml.includes('前 10 行预览'), '预览包含前 10 行');
  record(previewHtml.includes('name="map_symbol"') && previewHtml.includes('name="map_close_time"'), '列映射可编辑');

  const commit = await req('/dashboard/import', {
    method: 'POST',
    form: { step: 'commit', account_id: '1', tz_offset: '0', cost_positive: '1', csv_text: csvText },
  });
  record(commit.status === 302, '确认导入 → 302', `→ ${commit.status}`);
  const afterImport = (await jsonOf(await req('/api/summary'))).total_trades;
  record(afterImport === summaryBefore + 3, `导入后交易数 ${afterImport}（+2 导入 +1 手动）`);

  const imported = (await jsonOf(await req('/api/trades?limit=1000'))).trades
    .filter((t) => t.symbol.startsWith('SMOKE-CSV'));
  record(imported.length === 2, `导入的交易可读回（${imported.length} 笔）`);
  const first = imported.find((t) => t.symbol === 'SMOKE-CSV-1/USDT');
  record(first?.fee === -0.5 && first?.funding === -0.1, '费用符号已归一（正数视为支出）', JSON.stringify(first));
  record((first?.tags || []).includes('smoke-csv'), '导入的标签已关联');

  await req('/dashboard/import', {
    method: 'POST',
    form: { step: 'commit', account_id: '1', tz_offset: '0', cost_positive: '1', csv_text: csvText },
  });
  const afterRepeat = (await jsonOf(await req('/api/summary'))).total_trades;
  record(afterRepeat === afterImport, '重复导入被去重（交易数不变）');

  // 现货市场：逐笔成交按 long-only 配对，并标记 market=spot
  const spotCsv = 'Time,Pair,Side,Price,Executed,Fee\n'
    + '2026-10-05 10:00:00,SMOKE-SPOT/USDT,BUY,10,2,0.01\n'
    + '2026-10-05 12:00:00,SMOKE-SPOT/USDT,SELL,12,2,0.01\n';
  const spotPreview = await req('/dashboard/import', {
    method: 'POST',
    form: { step: 'preview', account_id: '1', tz_offset: '0', cost_positive: '1', market: 'spot', csv_text: spotCsv },
  });
  const spotPreviewHtml = await text(spotPreview);
  record(spotPreview.status === 200 && spotPreviewHtml.includes('value="spot" selected'), '现货 CSV 预览识别为现货');
  await req('/dashboard/import', {
    method: 'POST',
    form: { step: 'commit', account_id: '1', tz_offset: '0', cost_positive: '1', market: 'spot', csv_text: spotCsv },
  });
  const spotImported = (await jsonOf(await req('/api/trades?market=spot&limit=1000'))).trades
    .filter((t) => t.symbol === 'SMOKE-SPOT/USDT');
  record(spotImported.length === 1 && spotImported[0].market === 'spot',
    '现货 CSV 导入并标记 market=spot', JSON.stringify(spotImported));

  const history = await text(await req('/dashboard/import'));
  record(history.includes('smoke.csv') || history.includes('导入记录'), '导入审计可见');

  // 映射模板：保存 → 出现在列表 → 可套用 → 可删除
  await req('/dashboard/import', {
    method: 'POST',
    form: {
      step: 'commit', account_id: '1', tz_offset: '0', cost_positive: '1',
      csv_text: csvText, template_name: 'smoke-map',
    },
  });
  const importPageHtml = await text(await req('/dashboard/import'));
  record(importPageHtml.includes('smoke-map'), '映射模板出现在导入页');
  const templateId = Number((importPageHtml.match(/<option value="(\d+)">smoke-map<\/option>/) || [])[1]);
  record(!!templateId, `取到模板 id=${templateId}`);
  if (templateId) {
    const tplPreview = await req('/dashboard/import', {
      method: 'POST',
      form: {
        step: 'preview', account_id: '1', tz_offset: '0', cost_positive: '1',
        csv_text: csvText, template_id: String(templateId),
      },
    });
    record(tplPreview.status === 200 && (await text(tplPreview)).includes('第 2 步'), '套用模板预览 → 200');
    await req('/dashboard/import/templates/delete', { method: 'POST', form: { id: String(templateId) } });
    record(!(await text(await req('/dashboard/import'))).includes('smoke-map'), '映射模板已删除');
  }
}

/* ---------------- 账户维度 / 笔记搜索分页 / 布局 ---------------- */

console.log('\n▶ 账户维度筛选');
{
  const cal = await text(await req('/dashboard/calendar?account_id=1'));
  record(cal.includes('正在查看单个账户'), '盈亏日历单账户视图生效');
  record(cal.includes('year=') && cal.includes('account_id=1'), '日历翻月链接保留账户参数');
  const calAll = await text(await req('/dashboard/calendar'));
  record(!calAll.includes('正在查看单个账户'), '日历无效/缺省账户回退聚合');
  const acc = await text(await req('/dashboard?account_id=1'));
  record(acc.includes('正在查看单个账户'), '仪表盘单账户视图生效');
  record(acc.includes('market=futures&account_id=1'), '市场页签保留账户参数');
  const accBad = await text(await req('/dashboard?account_id=99999'));
  record(!accBad.includes('正在查看单个账户'), '无效账户号回退到聚合视图');

  const jr = await text(await req('/dashboard/journal?account_id=1'));
  record(jr.includes('条 / 共') && jr.includes('SMOKE-CSV-1/USDT'), '交易记录按账户过滤后仍有导入数据');
  const jrApi = await jsonOf(await req('/api/trades?account_id=1&limit=1000'));
  record(jrApi.trades.length > 0 && jrApi.trades.every((t) => t.account_id === 1), 'API 也支持 account_id 过滤');
}

console.log('\n▶ 交易详情盈亏曲线');
{
  // 快捷标签：验证仪表盘渲染的表单 action 指向正确路由，并按表单路径走一遍挂/摘
  const dash = await text(await req('/dashboard'));
  const action = (dash.match(/action="(\/dashboard\/journal\/\d+\/tag)"/) || [])[1];
  record(Boolean(action), `快捷标签表单 action 指向路由（${action || '未找到'}）`);
  if (action) {
    await req(action, { method: 'POST', form: { tag: 'smoke-quick', back: '/dashboard' } });
    const afterAdd = await text(await req(action.replace(/\/tag$/, '')));
    record(afterAdd.includes('smoke-quick'), '快捷标签 POST 挂上');
    await req(action, { method: 'POST', form: { tag: 'smoke-quick', back: '/dashboard' } });
    const afterDel = await text(await req(action.replace(/\/tag$/, '')));
    record(!afterDel.includes('smoke-quick'), '快捷标签 POST 再点移除');
  }

  const list = (await jsonOf(await req('/api/trades?limit=5'))).trades;
  let sawPanel = false;
  let sawChart = false;
  for (const t of list.slice(0, 5)) {
    const html = await text(await req(`/dashboard/journal/${t.id}`));
    if (!html.includes('持仓盈亏曲线（开仓 → 平仓）')) continue;
    sawPanel = true;
    // 演示账户不拉真实行情 → 命中提示分支；真实账户才有 SVG 曲线
    if (html.includes('演示账户不拉取真实行情')) sawChart = true;
    break;
  }
  record(sawPanel, '交易详情页渲染盈亏曲线面板');
  record(sawChart, '演示账户显示行情提示而不请求外网');
  for (const t of list.slice(0, 5)) {
    const html = await text(await req(`/dashboard/journal/${t.id}`));
    if (!html.includes('操作明细（开仓 → 平仓）')) continue;
    record(html.includes('演示账户不拉取真实成交明细'), '操作明细面板渲染（演示账户提示而不请求外网）');
    break;
  }
}

console.log('\n▶ 笔记搜索与分页');
{
  const hit = await text(await req('/dashboard/notes?q=' + encodeURIComponent('spot smoke note')));
  record(hit.includes('spot smoke note') && hit.includes('搜索「'), '笔记搜索按内容命中');
  const miss = await text(await req('/dashboard/notes?q=' + encodeURIComponent('绝不存在的关键词xyz')));
  record(miss.includes('没有匹配') && miss.includes('清除'), '搜索无结果时给出提示与清除入口');

  for (let i = 1; i <= 26; i++) {
    await req('/dashboard/notes/save', { method: 'POST', form: { title: `SMOKE-PAGE-${String(i).padStart(2, '0')}`, content: `分页冒烟 ${i}` } });
  }
  const q = encodeURIComponent('SMOKE-PAGE');
  const page1 = await text(await req(`/dashboard/notes?q=${q}`));
  record(page1.includes('SMOKE-PAGE-26') && !page1.includes('SMOKE-PAGE-01'), '第 1 页只含最新 24 篇');
  record(page1.includes('下一页') && page1.includes('共 26 篇'), '分页条与总数已渲染');
  const page2 = await text(await req(`/dashboard/notes?q=${q}&page=2`));
  record(page2.includes('SMOKE-PAGE-01') && !page2.includes('SMOKE-PAGE-26'), '第 2 页含最旧 2 篇');

  const created = (await jsonOf(await req('/api/notes'))).notes.filter((n) => /^SMOKE-PAGE-/.test(n.title));
  for (const n of created) await req('/dashboard/notes/delete', { method: 'POST', form: { id: String(n.id) } });
  record((await jsonOf(await req('/api/notes'))).notes.every((n) => !/^SMOKE-PAGE-/.test(n.title)), '分页测试笔记已清理');
}

console.log('\n▶ 布局修复');
{
  const html = await text(await req('/dashboard/transfers'));
  record(html.includes('table-wrap'), '宽表格容器支持横向滚动');
  record(!html.includes('随账户同步自动更新；需要钱包/资产只读权限'), '旧的断裂 panel-head 文案已合并');
  const spotHtml = await text(await req('/dashboard/spot'));
  record(spotHtml.includes('持仓币种') && spotHtml.includes('计价币余额'), '现货页计数口径与持仓一致');
}

/* ---------------- 筛选与导出 ---------------- */

console.log('\n▶ 筛选与导出');
{
  const html = await text(await req('/dashboard/journal?side=long&result=win&note=yes'));
  record(html.includes('筛选'), '组合筛选页面正常');
  record(html.includes('side=long'), '分页/筛选参数保留');

  const range = await text(await req('/dashboard/journal?from=2026-10-01&to=2026-10-04'));
  record(range.includes('条 / 共'), '日期区间筛选正常');

  const expJson = await req('/api/export?format=json');
  record(expJson.status === 200 && /application\/json/.test(expJson.headers.get('content-type') || ''), 'JSON 导出 → 200');
  const data = await jsonOf(expJson);
  record(Array.isArray(data.trades) && data.trades.length > 0, 'JSON 导出含交易');

  const expCsv = await req('/api/export?format=csv');
  const csv = await text(expCsv);
  record(expCsv.status === 200 && /text\/csv/.test(expCsv.headers.get('content-type') || ''), 'CSV 导出 → 200');
  record(csv.startsWith('symbol,side,order_type'), 'CSV 表头与导入器兼容');
}

/* ---------------- 清理 ---------------- */

console.log('\n▶ 清理测试数据');
{
  const all = (await jsonOf(await req('/api/trades?limit=1000'))).trades;
  const targets = all.filter((t) => String(t.symbol).startsWith('SMOKE'));
  for (const t of targets) {
    await req(`/dashboard/journal/${t.id}/delete`, { method: 'POST' });
  }
  const after = (await jsonOf(await req('/api/summary'))).total_trades;
  record(after === summaryBefore, `交易数已还原 ${after} === ${summaryBefore}`);

  const smokeTag = (await jsonOf(await req('/api/tags'))).tags.find((t) => t.name === 'smoke-tag');
  if (smokeTag) await req('/dashboard/tags/delete', { method: 'POST', form: { id: String(smokeTag.id) } });
  const csvTag = (await jsonOf(await req('/api/tags'))).tags.find((t) => t.name === 'smoke-csv');
  if (csvTag) await req('/dashboard/tags/delete', { method: 'POST', form: { id: String(csvTag.id) } });
  const tagsAfter = (await jsonOf(await req('/api/tags'))).tags;
  record(!tagsAfter.some((t) => t.name === 'smoke-tag' || t.name === 'smoke-csv'), '临时标签已清理');
}

/* ---------------- 登录限速 ---------------- */

console.log('\n▶ 登录限速（独立 IP，避免锁死本机）');
{
  const fakeIp = '203.0.113.55';
  for (let i = 0; i < 10; i++) {
    await req('/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': fakeIp },
      form: { password: 'wrong' },
    });
  }
  const blocked = await req('/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': fakeIp },
    form: { password },
  });
  record(blocked.status === 429, '连续失败后返回 429', `→ ${blocked.status}`);
  const other = await req('/login', { method: 'POST', form: { password: 'wrong' } });
  record(other.status === 401, '其他 IP 不受影响', `→ ${other.status}`);
}

/* ---------------- 结果 ---------------- */

console.log(`\n${'─'.repeat(48)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
