/* TradeLedger 前端交互：软导航、主题、时间默认值、行内笔记、防重复提交 */
(function () {
  'use strict';

  var THEME_KEY = 'tl-theme';
  var root = document.documentElement;
  var cleanups = [];

  function onCleanup(fn) { cleanups.push(fn); }
  function cleanupPage() {
    for (var i = 0; i < cleanups.length; i++) {
      try { cleanups[i](); } catch (e) { /* 忽略清理异常 */ }
    }
    cleanups = [];
  }
  function pageInterval(fn, ms) {
    var id = setInterval(fn, ms);
    onCleanup(function () { clearInterval(id); });
    return id;
  }
  function pageTimeout(fn, ms) {
    var id = setTimeout(fn, ms);
    onCleanup(function () { clearTimeout(id); });
    return id;
  }

  /* ---------------- 主题（头部常驻，只绑定一次） ---------------- */
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }

  function initTheme() {
    var toggle = document.getElementById('themeToggle');
    if (!toggle || toggle.dataset.themeBound === '1') return;
    toggle.dataset.themeBound = '1';
    toggle.addEventListener('click', function () {
      var next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
    });
  }

  /* ---------------- 页面级交互 ---------------- */

  /* 新建交易时给空的时间框填默认值：开仓 2 小时前，平仓现在 */
  function initTimeDefaults() {
    var dtInputs = document.querySelectorAll('form[action="/dashboard/journal/new"] input[type="datetime-local"]');
    if (dtInputs.length !== 2) return;
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var fmt = function (d) {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };
    if (!dtInputs[0].value) {
      var open = new Date(now.getTime() - 2 * 3600 * 1000);
      dtInputs[0].value = fmt(open);
    }
    if (!dtInputs[1].value) dtInputs[1].value = fmt(now);
  }

  /* 列表页行内复盘：fetch 保存，不跳页 */
  function initQuickNotes() {
    document.querySelectorAll('form.quick-note').forEach(function (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var id = form.getAttribute('data-trade-id');
        var input = form.querySelector('input[name="note"]');
        var btn = form.querySelector('button[type="submit"]');
        if (!id || !input || !btn) return;
        btn.disabled = true;
        btn.textContent = '保存中…';
        fetch('/api/trades/' + encodeURIComponent(id) + '/note', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ note: input.value }).toString(),
        }).then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok && data.ok, data: data }; });
        }).then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || '保存失败');
          form.classList.add('saved');
          btn.textContent = '已保存';
          setTimeout(function () {
            form.classList.remove('saved');
            btn.textContent = '保存';
            btn.disabled = false;
          }, 1800);
        }).catch(function (err) {
          btn.textContent = '保存失败';
          btn.disabled = false;
          btn.title = err.message || '';
        });
      });
    });
  }

  /* 现货持仓备注：fetch 保存，不跳页 */
  function initSpotNotes() {
    document.querySelectorAll('form.spot-note').forEach(function (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var accountId = form.getAttribute('data-account-id');
        var symbol = form.getAttribute('data-symbol');
        var input = form.querySelector('input[name="note"]');
        var btn = form.querySelector('button[type="submit"]');
        if (!accountId || !symbol || !input || !btn) return;
        btn.disabled = true;
        btn.textContent = '保存中…';
        fetch('/api/spot/note', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            account_id: accountId,
            symbol: symbol,
            note: input.value,
          }).toString(),
        }).then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok && data.ok, data: data }; });
        }).then(function (r) {
          if (!r.ok) throw new Error((r.data && r.data.error) || '保存失败');
          form.classList.add('saved');
          btn.textContent = '已保存';
          setTimeout(function () {
            form.classList.remove('saved');
            btn.textContent = '保存';
            btn.disabled = false;
          }, 1800);
        }).catch(function (err) {
          btn.textContent = '保存失败';
          btn.disabled = false;
          btn.title = err.message || '';
        });
      });
    });
  }

  /* 提示条：右上角关闭 + 成功/信息类自动消失 */
  function initAlerts() {
    function dismiss(el) {
      if (!el || el.classList.contains('alert-hiding')) return;
      clearTimeout(el.__alertTimer);
      el.classList.add('alert-hiding');
      setTimeout(function () { el.remove(); }, 180);
    }
    function decorate(el) {
      if (!el || el.dataset.alertReady === '1') return;
      el.dataset.alertReady = '1';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'alert-close';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '×';
      close.addEventListener('click', function () { dismiss(el); });
      el.appendChild(close);
      var isOk = el.classList.contains('alert-ok');
      var isInfo = el.classList.contains('alert-info');
      var hasAction = !!el.querySelector('form, button:not(.alert-close)');
      if ((isOk || isInfo) && !hasAction && !el.hasAttribute('data-persist')) {
        el.__alertTimer = setTimeout(function () { dismiss(el); }, isOk ? 5000 : 8000);
      }
    }
    document.querySelectorAll('.alert').forEach(decorate);
    var main = document.querySelector('main.site-main');
    if (main && window.MutationObserver) {
      var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            if (node.classList && node.classList.contains('alert')) decorate(node);
            if (node.querySelectorAll) node.querySelectorAll('.alert').forEach(decorate);
          });
        });
      });
      observer.observe(main, { childList: true, subtree: true });
      onCleanup(function () { observer.disconnect(); });
    }
  }

  /* 导入确认：防止双击重复提交 */
  function initImportGuard() {
    var marker = document.querySelector('form[action="/dashboard/import"] input[name="step"][value="commit"]');
    if (!marker) return;
    var form = marker.closest('form');
    if (!form) return;
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    });
  }

  /* ---------------- 交易所同步 ---------------- */
  function initSyncButtons() {
    function statusEl(id) {
      return document.querySelector('[data-sync-status="' + id + '"]');
    }
    function setStatus(id, text, error) {
      var el = statusEl(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'small ' + (error ? 'neg' : 'muted');
      if (error) el.title = text;
    }

    async function oneBatch(id) {
      var res = await fetch('/dashboard/accounts/' + encodeURIComponent(id) + '/sync', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'limit=1000',
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* 非 JSON */ }
      if (!res.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      return data;
    }

    async function syncOne(id, btn, reload) {
      var original = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
      var fetched = 0;
      var inserted = 0;
      try {
        for (var batch = 1; batch <= 50; batch++) {
          if (btn && !document.body.contains(btn)) return { ok: true, fetched: fetched, inserted: inserted, done: false };
          setStatus(id, '第 ' + batch + ' 批同步中…');
          var data = await oneBatch(id);
          fetched += Number(data.fetched) || 0;
          inserted += Number(data.inserted) || 0;
          setStatus(id, '第 ' + batch + ' 批：拉取 ' + data.fetched + '，写入 ' + data.inserted + (data.done ? ' · 完成' : ' · 继续…'));
          if (data.done) {
            setStatus(id, '完成：共拉取 ' + fetched + '，写入 ' + inserted);
            if (btn) { btn.textContent = '已同步'; }
            if (reload) pageTimeout(function () { location.reload(); }, 900);
            return { ok: true, fetched: fetched, inserted: inserted };
          }
        }
        setStatus(id, '已达到单次 50 批上限，再点一次继续回溯');
        if (btn) { btn.disabled = false; btn.textContent = '继续同步'; }
        return { ok: true, fetched: fetched, inserted: inserted, done: false };
      } catch (err) {
        setStatus(id, '失败：' + (err.message || '未知错误'), true);
        if (btn) { btn.disabled = false; btn.textContent = original || '重试'; }
        return { ok: false, error: err.message };
      }
    }

    document.querySelectorAll('[data-sync-account]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        syncOne(btn.getAttribute('data-sync-account'), btn, true);
      });
    });

    document.querySelectorAll('[data-sync-all]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var ids = [];
        try { ids = JSON.parse(btn.getAttribute('data-sync-all') || '[]'); } catch (e) { ids = []; }
        if (!ids.length) return;
        btn.disabled = true;
        var original = btn.textContent;
        btn.textContent = '同步中…';
        for (var i = 0; i < ids.length; i++) {
          await syncOne(ids[i], null, false);
        }
        btn.textContent = original;
        btn.disabled = false;
        pageTimeout(function () { location.reload(); }, 900);
      });
    });
  }

  /* ---------------- 实时持仓面板 ---------------- */
  function initLivePanel() {
    var panel = document.querySelector('[data-live-panel]');
    var rowBox = document.querySelector('[data-live-rows]');
    if (!panel || !rowBox) return;

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function money(n) {
      var v = Number(n) || 0;
      return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function num(v) { return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
    function cls(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat'; }
    function rate(v) {
      if (v === null || v === undefined || v === '') return '—';
      return (Number(v) * 100).toFixed(4) + '%';
    }
    function when(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return '—'; }
    }

    function render(data) {
      var balances = data.balances || [];
      var positions = data.positions || [];
      var equity = balances.reduce(function (a, b) { return a + (Number(b.total) || 0); }, 0);
      var unrealized = positions.reduce(function (a, p) { return a + (Number(p.unrealized) || 0); }, 0);

      var eq = document.querySelector('[data-live-equity]');
      var count = document.querySelector('[data-live-count]');
      var upl = document.querySelector('[data-live-unrealized]');
      if (eq) eq.textContent = money(equity);
      if (count) count.textContent = String(positions.length);
      if (upl) { upl.textContent = money(unrealized); upl.className = cls(unrealized); }

      rowBox.innerHTML = positions.map(function (p) {
        return '<tr>' +
          '<td class="small">' + esc(p.account_name) + '</td>' +
          '<td><b>' + esc(p.symbol) + '</b></td>' +
          '<td><span class="side-tag ' + (p.side === 'long' ? 'long' : 'short') + '">' + (p.side === 'long' ? '多' : '空') + '</span></td>' +
          '<td>' + num(p.size) + '</td>' +
          '<td>' + money(p.entry_price) + '</td>' +
          '<td>' + money(p.mark_price) + '</td>' +
          '<td class="strong ' + cls(Number(p.unrealized)) + '">' + money(p.unrealized) + '</td>' +
          '<td class="rate">' + rate(p.funding_rate) + '</td>' +
          '<td class="small muted">' + when(p.next_funding_time) + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="9" class="muted center">当前没有合约持仓</td></tr>';

      var spotHoldings = data.spotHoldings || [];
      var spotBalances = data.spotBalances || [];
      var spotValue = spotHoldings.reduce(function (a, h) { return a + (Number(h.value) || 0); }, 0);
      var spotCount = document.querySelector('[data-live-spot-count]');
      var spotValueEl = document.querySelector('[data-live-spot-value]');
      var spotRows = document.querySelector('[data-live-spot-rows]');
      if (spotCount) spotCount.textContent = String(spotBalances.length);
      if (spotValueEl) spotValueEl.textContent = money(spotValue);
      if (spotRows) {
        spotRows.innerHTML = spotHoldings.map(function (h) {
          var price = (h.price === null || h.price === undefined) ? '—' : money(h.price);
          var value = (h.value === null || h.value === undefined) ? '—' : money(h.value);
          return '<tr>' +
            '<td class="small">' + esc(h.account_name) + '</td>' +
            '<td><b>' + esc(h.symbol) + '</b></td>' +
            '<td>' + num(h.quantity) + '</td>' +
            '<td>' + price + '</td>' +
            '<td>' + value + '</td>' +
            '</tr>';
        }).join('') || '<tr><td colspan="5" class="muted center">当前没有现货持仓</td></tr>';
      }

      var up = document.querySelector('[data-live-updated]');
      if (up) {
        up.textContent = data.updatedAt ? '更新于 ' + when(data.updatedAt).slice(11) : '等待首次刷新';
        if (data.errors && data.errors.length) up.textContent += ' · ' + data.errors[0];
      }
    }

    async function poll(force) {
      var btn = panel.querySelector('[data-live-refresh]');
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/positions/live' + (force ? '?force=1' : ''), { credentials: 'same-origin' });
        var data = await res.json();
        if (res.ok && data && !data.error) render(data);
        else {
          var up = document.querySelector('[data-live-updated]');
          if (up) up.textContent = '刷新失败：' + ((data && (data.message || data.error)) || ('HTTP ' + res.status));
        }
      } catch (err) {
        var u = document.querySelector('[data-live-updated]');
        if (u) u.textContent = '刷新失败：网络异常';
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    var refreshBtn = panel.querySelector('[data-live-refresh]');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { poll(true); });
    poll(false);
    pageInterval(function () { poll(false); }, 30000);
  }

  /* ---------------- 自动同步进度条 ---------------- */
  function initAutoSyncBar() {
    var waiting = document.querySelector('[data-sync-bar][data-done="0"]');
    if (!waiting) return;
    var finished = false;

    async function poll() {
      try {
        var res = await fetch('/api/accounts/status', { credentials: 'same-origin' });
        if (!res.ok) return;
        var data = await res.json();
        var allDone = true;
        (data.accounts || []).forEach(function (a) {
          var bar = document.querySelector('[data-sync-bar="' + a.id + '"] span');
          var txt = document.querySelector('[data-sync-status="' + a.id + '"]');
          if (bar) bar.style.width = Math.round((a.progress || 0) * 100) + '%';
          if (txt) txt.textContent = a.label || '';
          if (!a.syncDone || a.pending) allDone = false;
        });
        if (allDone && (data.accounts || []).length && !finished) {
          finished = true;
          pageTimeout(function () { location.reload(); }, 1200);
        }
      } catch (e) { /* 轮询失败下次再试 */ }
    }

    poll();
    pageInterval(poll, 3000);
  }

  /* ---------------- 周报复制 ---------------- */
  function initCopyReview() {
    function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
      return new Promise(function (resolve, reject) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
        document.body.removeChild(ta);
      });
    }

    document.querySelectorAll('[data-copy-review]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var week = btn.getAttribute('data-copy-review');
        var original = btn.textContent;
        btn.disabled = true;
        try {
          var res = await fetch('/api/review?week=' + encodeURIComponent(week) + '&format=md', { credentials: 'same-origin' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await copyText(await res.text());
          btn.textContent = '已复制';
        } catch (err) {
          btn.textContent = '复制失败';
        }
        setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 1800);
      });
    });
  }

  /* ---------------- 添加交易所：验证中的反馈 ---------------- */
  function initAccountForm() {
    var form = document.querySelector('form[action="/dashboard/accounts/new"]');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      var pass = form.querySelector('input[name="passphrase"]');
      if (pass && pass.value && pass.value !== pass.value.trim()) {
        if (!confirm('检测到 Passphrase 前后有空格。OKX 会按原样校验，确定继续吗？')) {
          ev.preventDefault();
          return;
        }
      }
      var btn = form.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '正在连接交易所…';
      }
      if (!form.querySelector('[data-verify-hint]')) {
        var hint = document.createElement('div');
        hint.className = 'alert alert-info';
        hint.setAttribute('data-verify-hint', '');
        hint.setAttribute('data-persist', '');
        hint.textContent = '正在用只读接口验证 API，最长约 12 秒…';
        form.prepend(hint);
      }
    });
  }

  /* ---------------- AI 复盘 ---------------- */
  function initAi() {
    var preset = document.querySelector('[data-llm-preset]');
    var configForm = document.getElementById('llm-config-form');
    if (preset && configForm) {
      preset.addEventListener('change', function () {
        var opt = preset.selectedOptions[0];
        if (!opt) return;
        var provider = configForm.querySelector('[name="provider"]');
        var base = configForm.querySelector('[name="baseUrl"]');
        var model = configForm.querySelector('[name="model"]');
        if (provider) provider.value = opt.getAttribute('data-provider') || provider.value;
        if (base && opt.getAttribute('data-base')) base.value = opt.getAttribute('data-base');
        if (model && opt.getAttribute('data-model')) model.value = opt.getAttribute('data-model');
      });
    }

    var testBtn = document.querySelector('[data-ai-test]');
    var testOut = document.querySelector('[data-ai-test-result]');
    if (testBtn) {
      testBtn.addEventListener('click', async function () {
        testBtn.disabled = true;
        if (testOut) { testOut.textContent = '测试中…'; testOut.className = 'muted small'; }
        try {
          var res = await fetch('/api/ai/test', { method: 'POST', credentials: 'same-origin' });
          var data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
          if (testOut) testOut.textContent = '可用：' + String(data.text || 'OK').slice(0, 80);
        } catch (err) {
          if (testOut) { testOut.textContent = '失败：' + err.message; testOut.className = 'muted small neg'; }
        } finally {
          testBtn.disabled = false;
        }
      });
    }

    var genForm = document.getElementById('ai-generate-form');
    if (genForm) {
      var resultBox = document.querySelector('[data-ai-result]');
      var status = document.querySelector('[data-ai-status]');
      var actions = document.querySelector('[data-ai-actions]');
      var lastText = '';

      genForm.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var btn = genForm.querySelector('[data-ai-generate]');
        if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
        if (status) { status.textContent = '正在调用模型…'; status.className = 'muted small'; }
        try {
          var body = new URLSearchParams(new FormData(genForm)).toString();
          var res = await fetch('/api/ai/generate', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body,
          });
          var data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
          lastText = data.text || '';
          if (resultBox) resultBox.innerHTML = data.html || '';
          if (actions) actions.style.display = 'flex';
          if (status) status.textContent = '完成 · ' + data.tradeCount + ' 笔交易 · ' + data.label + (data.truncated ? ' · 上下文已截断' : '');
        } catch (err) {
          if (status) { status.textContent = '失败：' + err.message; status.className = 'muted small neg'; }
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = '生成复盘'; }
        }
      });

      var saveBtn = document.querySelector('[data-ai-save]');
      if (saveBtn) {
        saveBtn.addEventListener('click', async function () {
          if (!lastText) return;
          saveBtn.disabled = true;
          try {
            var res = await fetch('/api/ai/save-note', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                title: 'AI 复盘 ' + new Date().toISOString().slice(0, 10),
                content: lastText,
              }).toString(),
            });
            var data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
            saveBtn.textContent = '已保存为笔记';
          } catch (err) {
            saveBtn.textContent = '保存失败';
          } finally {
            setTimeout(function () {
              saveBtn.disabled = false;
              saveBtn.textContent = '保存为笔记';
            }, 1800);
          }
        });
      }
    }
  }

  /* ---------------- Markdown 预览 / 图片上传 ---------------- */
  function initMarkdown() {
    var previewBtn = document.querySelector('[data-md-preview]');
    var box = document.querySelector('[data-md-preview-box]');
    var textarea = document.getElementById('note-content');
    if (previewBtn && box && textarea) {
      previewBtn.addEventListener('click', async function () {
        if (!box.hidden) { box.hidden = true; previewBtn.textContent = '预览'; return; }
        try {
          var res = await fetch('/api/markdown', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ text: textarea.value }).toString(),
          });
          var data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || '预览失败');
          box.innerHTML = data.html || '<p class="muted">（空）</p>';
          box.hidden = false;
          previewBtn.textContent = '收起预览';
        } catch (err) {
          box.innerHTML = '<p class="neg">预览失败：' + String(err.message).replace(/</g, '&lt;') + '</p>';
          box.hidden = false;
        }
      });
    }

    var imageInput = document.querySelector('[data-note-image]');
    if (imageInput && textarea) {
      imageInput.addEventListener('change', async function () {
        var file = imageInput.files && imageInput.files[0];
        if (!file) return;
        var label = imageInput.closest('label');
        var labelText = label ? label.querySelector('[data-note-image-label]') : null;
        var original = labelText ? labelText.textContent : '';
        if (labelText) labelText.textContent = '上传中…';
        try {
          var fd = new FormData();
          fd.set('image', file);
          var res = await fetch('/dashboard/notes/upload', { method: 'POST', credentials: 'same-origin', body: fd });
          var data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
          var start = textarea.selectionStart || textarea.value.length;
          var before = textarea.value.slice(0, start);
          var after = textarea.value.slice(start);
          var prefix = before && !before.endsWith('\n') ? '\n\n' : '';
          textarea.value = before + prefix + data.markdown + '\n' + after;
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = (before + prefix + data.markdown + '\n').length;
        } catch (err) {
          alert('图片上传失败：' + err.message);
        } finally {
          imageInput.value = '';
          if (labelText) labelText.textContent = original || '插入图片';
        }
      });
    }
  }

  /* ---------------- 周期报告：AI 生成进度 ---------------- */
  function initReportAi() {
    var form = document.getElementById('report-ai-form');
    if (!form) return;

    var progress = form.querySelector('[data-report-progress]');
    var progressText = form.querySelector('[data-report-progress-text]');
    var bar = progress ? progress.querySelector('.report-progress-bar span') : null;
    var btn = form.querySelector('[data-report-generate]');
    var resultBox = document.querySelector('[data-report-result]');
    var timer = null;
    var elapsed = 0;

    function stopProgress() {
      if (timer) clearInterval(timer);
      timer = null;
      if (progress) progress.hidden = true;
      if (btn) { btn.disabled = false; btn.textContent = '调用 AI 生成解读'; }
    }

    function showProgress(label) {
      if (progress) progress.hidden = false;
      if (progressText) progressText.textContent = label;
      if (bar) bar.style.width = Math.min(92, elapsed * 2.2) + '%';
    }

    function poll(jobId) {
      fetch('/api/review/ai/status?job=' + encodeURIComponent(jobId), { credentials: 'same-origin' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var job = data && data.job;
          if (!data.ok || !job) { stopProgress(); showProgress('任务状态丢失，请到 AI 报告专页查看'); return; }
          if (job.status === 'done') {
            stopProgress();
            showProgress('生成完成，正在刷新页面…');
            setTimeout(function () { location.reload(); }, 900);
          } else if (job.status === 'error') {
            stopProgress();
            showProgress('生成失败：' + (job.error || '未知错误'));
          } else {
            elapsed += 3;
            var secs = Math.round((Date.now() - Date.parse(job.startedAt)) / 1000);
            showProgress('模型生成中… 已等待 ' + secs + ' 秒（大模型通常需要 30–120 秒，可离开页面，结果会保存）');
            timer = setTimeout(function () { poll(jobId); }, 3000);
          }
        })
        .catch(function () {
          elapsed += 3;
          showProgress('网络波动，继续等待…');
          timer = setTimeout(function () { poll(jobId); }, 3000);
        });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (btn) { btn.disabled = true; btn.textContent = '已提交，生成中…'; }
      elapsed = 0;
      showProgress('已提交，等待模型返回…');
      var body = new URLSearchParams(new FormData(form)).toString();
      fetch(form.getAttribute('action'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body,
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.ok && data.jobId) {
          poll(data.jobId);
        } else {
          stopProgress();
          showProgress('提交失败：' + ((data && data.error) || 'HTTP ' + res.status));
          if (btn) { btn.disabled = false; btn.textContent = '调用 AI 生成解读'; }
        }
      }).catch(function (err) {
        stopProgress();
        showProgress('提交失败：' + (err.message || '网络异常'));
        if (btn) { btn.disabled = false; btn.textContent = '调用 AI 生成解读'; }
      });
    });
  }

  function initPage() {
    initTheme();
    initTimeDefaults();
    initQuickNotes();
    initSpotNotes();
    initAlerts();
    initImportGuard();
    initSyncButtons();
    initLivePanel();
    initAutoSyncBar();
    initCopyReview();
    initAccountForm();
    initAi();
    initReportAi();
    initMarkdown();
  }

  /* ---------------- 软导航：只替换主内容，不整页刷新 ---------------- */
  var progress = document.createElement('div');
  progress.id = 'tl-nav-progress';
  progress.setAttribute('aria-hidden', 'true');
  document.body.appendChild(progress);

  var progressTimer = null;
  function setLoading(on) {
    clearTimeout(progressTimer);
    if (on) {
      progressTimer = setTimeout(function () { progress.classList.add('active'); }, 120);
    } else {
      progress.classList.remove('active');
    }
  }

  var navSeq = 0;
  var currentKey = location.pathname + location.search;
  var scrollMem = {};
  var activeTransition = null;

  function keyOf(url) { return url.pathname + url.search; }

  /* 用 View Transition 做交叉淡入；不可用时直接替换。回调只执行一次。 */
  function startSwap(swap) {
    var done = false;
    function once() {
      if (done) return;
      done = true;
      swap();
    }
    if (!document.startViewTransition || document.visibilityState !== 'visible') {
      once();
      return;
    }
    if (activeTransition && activeTransition.skipTransition) {
      try { activeTransition.skipTransition(); } catch (e) { /* 忽略 */ }
    }
    try {
      var transition = document.startViewTransition(once);
      activeTransition = transition;
      var clear = function () { if (activeTransition === transition) activeTransition = null; };
      if (transition.finished) transition.finished.then(clear, clear);
      if (transition.ready) transition.ready.catch(function () { /* 过渡被跳过 */ });
      setTimeout(once, 250);
    } catch (e) {
      once();
    }
  }

  function isSoftNavLink(a) {
    if (!a || a.target || a.hasAttribute('download') || a.hasAttribute('data-no-soft-nav')) return false;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;
    return /^\/dashboard(?:\/|$)/.test(url.pathname);
  }

  function applyMain(doc, url, restore) {
    var nextMain = doc.querySelector('main.site-main');
    var curMain = document.querySelector('main.site-main');
    if (!nextMain || !curMain) return false;

    cleanupPage();
    curMain.innerHTML = nextMain.innerHTML;
    if (doc.title) document.title = doc.title;

    var nextKey = keyOf(url);
    currentKey = nextKey;

    initPage();

    var hash = url.hash ? decodeURIComponent(url.hash.slice(1)) : '';
    if (hash) {
      var target = document.getElementById(hash);
      if (target) { target.scrollIntoView({ block: 'start' }); return true; }
    }
    if (restore && scrollMem[nextKey] != null) window.scrollTo(0, scrollMem[nextKey]);
    else window.scrollTo(0, 0);
    return true;
  }

  async function navigate(url, push) {
    var seq = ++navSeq;
    scrollMem[currentKey] = window.scrollY;
    setLoading(true);
    try {
      var res = await fetch(url.href, { credentials: 'same-origin', headers: { 'X-TL-Nav': '1' } });
      if (seq !== navSeq) return;
      if (res.redirected && /\/login(?:$|\?)/.test(res.url)) { location.href = res.url; return; }
      var type = res.headers.get('content-type') || '';
      if (!res.ok || type.indexOf('text/html') === -1) { location.href = url.href; return; }
      var html = await res.text();
      if (seq !== navSeq) return;
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.querySelector('main.site-main')) { location.href = url.href; return; }

      if (push) history.pushState({ soft: true }, '', url.href);
      setLoading(false);

      var restore = !push;
      var swap = function () {
        if (seq !== navSeq) return;
        if (!applyMain(doc, url, restore)) location.href = url.href;
      };
      startSwap(swap);
    } catch (err) {
      if (seq === navSeq) location.href = url.href;
    } finally {
      if (seq === navSeq) setLoading(false);
    }
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!isSoftNavLink(a)) return;
    var url = new URL(a.href, location.href);
    if (url.hash && keyOf(url) === currentKey) return;
    ev.preventDefault();
    navigate(url, true);
  });

  document.addEventListener('submit', function (ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    if (!form || !form.getAttribute) return;
    if (String(form.method || 'get').toLowerCase() !== 'get') return;
    if (form.hasAttribute('data-no-soft-nav')) return;
    var action = new URL(form.getAttribute('action') || location.href, location.href);
    if (action.origin !== location.origin || !/^\/dashboard(?:\/|$)/.test(action.pathname)) return;
    ev.preventDefault();
    var params = new URLSearchParams(new FormData(form));
    action.search = params.toString();
    action.hash = '';
    navigate(action, true);
  });

  window.addEventListener('popstate', function () {
    var url = new URL(location.href);
    if (!/^\/dashboard(?:\/|$)/.test(url.pathname)) return;
    navigate(url, false);
  });

  initPage();
})();
