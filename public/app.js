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

  /* ---------------- 隐私模式（头部常驻，打码整个内容区） ----------------
   * 预渲染脚本（layout head）在首帧前读 localStorage 置 data-privacy，
   * 所以开启状态下刷新页面不会闪现内容；storage 事件同步其他标签页。 */
  var PRIVACY_KEY = 'tl-privacy';

  function privacyOn() { return root.dataset.privacy === '1'; }

  function applyPrivacyState() {
    var toggle = document.getElementById('privacyToggle');
    if (!toggle) return;
    var on = privacyOn();
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.classList.toggle('active', on);
    toggle.title = on ? '隐私模式已开启：点击显示内容' : '隐私模式：打码页面内容（截图分享前开启）';
  }

  function initPrivacy() {
    var toggle = document.getElementById('privacyToggle');
    if (toggle && toggle.dataset.privacyBound !== '1') {
      toggle.dataset.privacyBound = '1';
      toggle.addEventListener('click', function () {
        var on = !privacyOn();
        if (on) root.dataset.privacy = '1';
        else delete root.dataset.privacy;
        try { localStorage.setItem(PRIVACY_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
        applyPrivacyState();
      });
    }
    applyPrivacyState();
  }

  window.addEventListener('storage', function (ev) {
    if (ev.key !== PRIVACY_KEY) return;
    if (ev.newValue === '1') root.dataset.privacy = '1';
    else delete root.dataset.privacy;
    applyPrivacyState();
  });

  /* ---------------- 语音输入：给复盘 / 笔记 textarea 加麦克风按钮 ----------------
   * 麦克风 → AudioWorklet 采集 16kHz 单声道 PCM → 能量 VAD 自动断句（说一句出一句）→
   * 每句打包 WAV POST /api/asr 服务端转写 → 文本插入光标处。
   * 依赖 设置 → AI 模型 里的「语音识别」配置；未配置时点击会提示。 */

  const DICTATION_WORKLET_SRC = `
class AsrCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.win = new Float32Array(4096);
    this.winLen = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.win[this.winLen++] = ch[i];
        if (this.winLen === this.win.length) { this.flush(); this.winLen = 0; }
      }
    }
    return true;
  }
  flush() {
    let sumSq = 0, acc = 0, n = 0, oi = 0;
    const out = new Int16Array(Math.ceil(this.winLen / this.ratio));
    for (let i = 0; i < this.winLen; i++) {
      const s = this.win[i];
      sumSq += s * s;
      acc += s; n++;
      if (n >= this.ratio) { out[oi++] = s2i(acc / n); acc = 0; n = 0; }
    }
    this.port.postMessage({ rms: Math.sqrt(sumSq / this.winLen), pcm: out }, [out.buffer]);
  }
}
function s2i(s) { return s < -1 ? -32768 : s > 1 ? 32767 : Math.round(s * 32767); }
registerProcessor('asr-capture', AsrCapture);
`;

  var activeDictationStop = null; // 全局只允许一路录音

  function wavBlob(samples) { // Int16Array @16k mono → WAV Blob
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buf);
    var w = function (off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    new Int16Array(buf, 44).set(samples);
    return new Blob([buf], { type: 'audio/wav' });
  }

  function attachDictation(textarea) {
    if (!textarea || textarea.dataset.dictationBound === '1') return;
    textarea.dataset.dictationBound = '1';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost small dictation-btn';
    btn.title = '语音输入（服务端识别，说一句写一句）';
    btn.textContent = '🎙 语音';
    var status = document.createElement('span');
    status.className = 'muted small dictation-status';

    var session = null;
    var starting = false; // 防止快速连点导致并发启动多路麦克风
    var insertAt = -1; // 后续句子的插入位置（追加模式）；-1 = 用当前光标

    function setStatus(msg, isError) {
      status.textContent = msg || '';
      status.className = 'muted small dictation-status' + (isError ? ' neg' : '');
    }

    function insertText(text) {
      var len = textarea.value.length;
      var at = insertAt >= 0 ? Math.min(insertAt, len) : (textarea.selectionStart == null ? len : textarea.selectionStart);
      var end = insertAt >= 0 ? at : (textarea.selectionEnd || at);
      textarea.value = textarea.value.slice(0, at) + text + textarea.value.slice(end);
      insertAt = at + text.length;
      textarea.selectionStart = textarea.selectionEnd = insertAt;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return text.length;
    }

    function upload(pcm) {
      var fd = new FormData();
      fd.append('audio', wavBlob(pcm), 'segment.wav');
      setStatus('识别中…');
      fetch('/api/asr', { method: 'POST', credentials: 'same-origin', body: fd })
        .then(function (res) {
          return res.json().then(
            function (d) { return { res: res, d: d }; },
            function () { return { res: res, d: {} }; }
          );
        })
        .then(function (out) {
          if (!out.res.ok || !out.d.ok) throw new Error((out.d && out.d.error) || ('HTTP ' + out.res.status));
          var text = String(out.d.text || '');
          if (window.console && console.debug && out.d.model) {
            console.debug('[asr] 识别通道：' + (out.d.via || '—') + ' · ' + (out.d.provider || '') + ' · ' + out.d.model);
          }
          if (!text) { if (session) setStatus('这句没听清，可以再说一遍'); return; }
          var n = insertText(text);
          setStatus('已写入 ' + n + ' 字' + (session ? '，继续说…' : ''));
        })
        .catch(function (err) {
          setStatus('识别失败：' + (err && err.message || err), true);
        });
    }

    function stop() {
      if (!session) return;
      var s = session;
      session = null;
      if (activeDictationStop === stop) activeDictationStop = null;
      try { if (s.flush) s.flush(); } catch (e) { /* 已清空 */ }
      try { s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停止 */ }
      try { s.ctx.close(); } catch (e) { /* 已关闭 */ }
      URL.revokeObjectURL(s.workletUrl);
      btn.textContent = '🎙 语音';
      btn.classList.remove('active');
      if (status.textContent.indexOf('聆听中') === 0) setStatus('');
    }

    async function start() {
      if (starting) return;
      starting = true;
      btn.textContent = '⏳ 启动中…';
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setStatus('语音输入需要 HTTPS 或 localhost 访问（当前地址不是安全上下文）', true);
          btn.textContent = '🎙 语音';
          return;
        }
        if (activeDictationStop) activeDictationStop();
        var stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (err) {
          var name = err && err.name;
          setStatus(
            name === 'NotAllowedError' ? '麦克风权限被拒绝：请在浏览器地址栏允许麦克风'
            : name === 'NotFoundError' ? '没有检测到麦克风设备'
            : '无法访问麦克风：' + (err && err.message || err),
            true
          );
          btn.textContent = '🎙 语音';
          return;
        }
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var workletUrl = URL.createObjectURL(new Blob([DICTATION_WORKLET_SRC], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(workletUrl);
        } catch (err) {
          URL.revokeObjectURL(workletUrl);
          try { ctx.close(); } catch (e) { /* 已关闭 */ }
          stream.getTracks().forEach(function (t) { t.stop(); });
          setStatus('浏览器不支持音频采集（AudioWorklet）', true);
          btn.textContent = '🎙 语音';
          return;
        }
      try { await ctx.resume(); } catch (e) { /* 某些平台无需 resume */ }
      var source = ctx.createMediaStreamSource(stream);
      var node = new AudioWorkletNode(ctx, 'asr-capture');
      var mute = ctx.createGain(); // 零增益接到 destination：保证渲染图持续拉取 worklet，且不外放
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);

      /* VAD 参数：自适应能量阈值（跟环境最安静水平走，照顾小音量/远场麦克风）+ 静音断句 */
      var END_SILENCE = 700, MIN_SPEECH = 300, MAX_SEG = 60000, PRE_ROLL = 6400;
      var minRms = 0.001; // 环境噪声下限：立即跟上更安静的瞬间，环境变吵时快速上漂
      function speechThreshold() { return Math.max(0.005, Math.min(0.03, minRms * 6)); }
      var chunkMs = 4096 / ctx.sampleRate * 1000;
      var seg = [], segSamples = 0, pre = [], preSamples = 0;
      var speaking = false, silenceMs = 0, speechMs = 0, segMs = 0;
      var listenMs = 0, maxRms = 0, quietHintShown = false;

      function flushSegment() {
        var chunks = seg, voiced = speechMs, total = segSamples;
        seg = []; segSamples = 0; speaking = false; silenceMs = 0; speechMs = 0; segMs = 0;
        if (!total || voiced < MIN_SPEECH) return;
        var merged = new Int16Array(total);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }
        upload(merged);
      }

      node.port.onmessage = function (ev) {
        if (!session) return;
        var pcm = new Int16Array(ev.data.pcm);
        var rms = ev.data.rms;
        if (!speaking) {
          listenMs += chunkMs;
          if (rms > maxRms) maxRms = rms;
          // 噪声下限：立即跟上更安静的瞬间；环境变吵时快速上漂（约 3 秒跟平），避免噪声误触发
          minRms += (Math.min(rms, 0.03) - minRms) * (rms < minRms ? 1 : 0.05);
          var th = speechThreshold();
          if (!quietHintShown && listenMs > 5000 && maxRms < th * 0.6) {
            quietHintShown = true;
            setStatus('聆听中…（没检测到声音，检查麦克风是否选对/静音）');
          }
          pre.push(pcm); preSamples += pcm.length;
          while (pre.length && preSamples - pre[0].length >= PRE_ROLL) preSamples -= pre.shift().length;
          if (rms >= th) {
            speaking = true; silenceMs = 0; speechMs = chunkMs; segMs = 0;
            seg = pre; segSamples = preSamples;
            pre = []; preSamples = 0;
            if (quietHintShown) setStatus('聆听中…（听到了，停顿后自动写入）');
          }
          return;
        }
        seg.push(pcm); segSamples += pcm.length; segMs += chunkMs;
        if (rms >= speechThreshold()) { silenceMs = 0; speechMs += chunkMs; }
        else silenceMs += chunkMs;
        if (silenceMs >= END_SILENCE || segMs >= MAX_SEG) flushSegment();
      };

      session = { stream: stream, ctx: ctx, workletUrl: workletUrl, flush: flushSegment };
      activeDictationStop = stop;
      onCleanup(stop); // 软导航离开时收麦，避免后台一直录音
      stream.getTracks()[0].addEventListener('ended', stop);
      btn.textContent = '⏺ 停止';
      btn.classList.add('active');
      setStatus('聆听中…（说一句，停顿即写入）');
      } finally {
        starting = false;
      }
    }

    btn.addEventListener('click', function () {
      if (session) { stop(); return; }
      start();
    });

    var actions = textarea.closest('.quick-note-editor, .form, .panel, form') || textarea.parentNode;
    var bar = actions.querySelector('.quick-note-actions, .form-actions, .pos-note-actions, .dictation-bar');
    if (bar) { bar.appendChild(btn); bar.appendChild(status); }
    else { textarea.parentNode.insertBefore(btn, textarea.nextSibling); textarea.parentNode.insertBefore(status, btn.nextSibling); }
  }

  var DICTATION_SELECTOR = 'textarea[name="note"], textarea[name="content"], textarea[data-dictation]';
  var dictationObserver = null;

  function attachDictationAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var targets = scope.querySelectorAll(DICTATION_SELECTOR);
    for (var i = 0; i < targets.length; i++) attachDictation(targets[i]);
  }

  function initDictation() {
    attachDictationAll(document);
    // 动态插入的编辑器（实时持仓笔记等）也自动挂上语音按钮
    if (dictationObserver || !window.MutationObserver) return;
    dictationObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches(DICTATION_SELECTOR)) attachDictation(node);
          attachDictationAll(node);
        }
      }
    });
    dictationObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------------- 仪表盘面板排序：拖拽 + 服务端持久化 ---------------- */
  function initDashboardOrder() {
    var main = document.querySelector('main.site-main');
    if (!main) return;
    var panels = Array.prototype.slice.call(main.querySelectorAll('section[data-panel] .panel-head'));
    var dragging = null;

    function panelOf(el) { return el && el.closest ? el.closest('section[data-panel]') : null; }
    function clearMarks() {
      Array.prototype.forEach.call(main.querySelectorAll('[data-panel].drop-before, [data-panel].drop-after'), function (p) {
        p.classList.remove('drop-before', 'drop-after');
      });
    }
    function persist() {
      var ids = Array.prototype.map.call(main.querySelectorAll('section[data-panel]'), function (p) { return p.dataset.panel; });
      fetch('/api/dashboard/order', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: ids }),
      });
    }

    panels.forEach(function (head) {
      if (head.querySelector('.drag-grip')) return;
      var panel = panelOf(head);
      if (!panel) return;
      var grip = document.createElement('span');
      grip.className = 'drag-grip';
      grip.textContent = '⠿';
      grip.title = '拖拽调整面板顺序';
      grip.setAttribute('draggable', 'true');
      head.insertBefore(grip, head.firstChild);
      grip.addEventListener('dragstart', function (ev) {
        dragging = panel;
        panel.classList.add('dragging');
        try { ev.dataTransfer.setData('text/plain', panel.dataset.panel); ev.dataTransfer.effectAllowed = 'move'; } catch (e) { /* 忽略 */ }
      });
      grip.addEventListener('dragend', function () {
        panel.classList.remove('dragging');
        dragging = null;
        clearMarks();
        persist();
      });
    });

    if (main.dataset.orderDelegated !== '1') {
      main.dataset.orderDelegated = '1';
      main.addEventListener('dragover', function (ev) {
        if (!dragging) return;
        var target = panelOf(ev.target);
        if (!target || target === dragging) return;
        ev.preventDefault();
        clearMarks();
        var rect = target.getBoundingClientRect();
        var before = ev.clientY < rect.top + rect.height / 2;
        target.classList.add(before ? 'drop-before' : 'drop-after');
        target.dataset.dropBefore = before ? '1' : '0';
      });
      main.addEventListener('drop', function (ev) {
        if (!dragging) return;
        var target = panelOf(ev.target);
        if (!target || target === dragging) return;
        ev.preventDefault();
        var before = target.dataset.dropBefore !== '0';
        target.parentNode.insertBefore(dragging, before ? target : target.nextSibling);
        clearMarks();
      });
    }
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
    // 持仓笔记编辑中：暂停整表重绘，避免 30 秒刷新把输入框冲掉
    var noteEditing = false;

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function money(n) {
      var v = Number(n) || 0;
      return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    // 与服务端 fmtPrice 同规则：<1 的价格显示 6 位小数，避免刷新后变成 $0.00
    function price(n) {
      var v = Number(n) || 0;
      var abs = Math.abs(v);
      var decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
      return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
    }
    function num(v) { return (Number(v) || 0).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
    function cls(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat'; }
    function rate(v) {
      if (v === null || v === undefined || v === '') return '—';
      return (Number(v) * 100).toFixed(4) + '%';
    }
    // 与服务端 fmtDateTime 同格式：YYYY-MM-DD HH:mm
    function when(iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function render(raw) {
      var data = raw || {};
      var acc = panel.getAttribute('data-live-account');
      if (acc) {
        // 仪表盘按单账户查看时，只展示该账户的快照数据
        var pick = function (list) {
          return (list || []).filter(function (x) { return String(x.account_id) === acc; });
        };
        data = {
          updatedAt: data.updatedAt,
          errors: data.errors,
          balances: pick(data.balances),
          positions: pick(data.positions),
          positionNotes: pick(data.positionNotes),
          spotBalances: pick(data.spotBalances),
          spotHoldings: pick(data.spotHoldings),
        };
      }
      var balances = data.balances || [];
      var positions = data.positions || [];
      // 不同币种数量不能直接相加：这里只汇总稳定币，非稳定币在下方提示数量。
      var STABLE = { USD: 1, USDT: 1, USDC: 1, DAI: 1, FDUSD: 1, TUSD: 1, USDD: 1, USDE: 1, USDS: 1, BUSD: 1, PYUSD: 1, GUSD: 1, FRAX: 1, LUSD: 1, CRVUSD: 1, GHO: 1, USD1: 1 };
      var equity = balances.reduce(function (a, b) {
        return STABLE[String(b.asset || '').toUpperCase()] ? a + (Number(b.total) || 0) : a;
      }, 0);
      var nonStable = balances.filter(function (b) {
        return !STABLE[String(b.asset || '').toUpperCase()] && Math.abs(Number(b.total) || 0) > 0;
      }).length;
      var unrealized = positions.reduce(function (a, p) { return a + (Number(p.unrealized) || 0); }, 0);

      var eq = document.querySelector('[data-live-equity]');
      var count = document.querySelector('[data-live-count]');
      var upl = document.querySelector('[data-live-unrealized]');
      var nonStableEl = document.querySelector('[data-live-nonstable]');
      if (eq) eq.textContent = money(equity);
      if (nonStableEl) nonStableEl.textContent = nonStable ? nonStable + ' 个非稳定币未折算' : '仅稳定币口径';
      if (count) count.textContent = String(positions.length);
      if (upl) { upl.textContent = money(unrealized); upl.className = cls(unrealized); }

      // 行内笔记：与服务端 livePositionsPanel 的 noteCell 保持同一结构
      var noteMap = {};
      (data.positionNotes || []).forEach(function (n) {
        noteMap[n.account_id + '|' + n.symbol + '|' + n.side] = n;
      });
      function noteCell(p) {
        var note = noteMap[p.account_id + '|' + p.symbol + '|' + p.side];
        var attrs = 'data-account="' + esc(p.account_id) + '" data-symbol="' + esc(p.symbol) + '"' +
          ' data-side="' + (p.side === 'short' ? 'short' : 'long') + '"' +
          ' data-content="' + esc(note ? note.content : '') + '"';
        var firstLine = note ? String(note.content).split('\n')[0] : '';
        var label = note
          ? '📝 ' + esc(firstLine.slice(0, 20)) + ((firstLine.length > 20 || note.content.indexOf('\n') >= 0) ? '…' : '')
          : '＋ 笔记';
        var title = note ? esc(note.content) : '记录这笔持仓的想法，平仓后自动归入交易记录';
        return '<td class="pos-note-cell"><button type="button" class="pos-note' + (note ? ' has' : '') + '" data-pos-note ' + attrs + ' title="' + title + '">' + label + '</button></td>';
      }

      if (!noteEditing) {
        rowBox.innerHTML = positions.map(function (p) {
          return '<tr>' +
            '<td class="small">' + esc(p.account_name) + '</td>' +
            '<td><b>' + esc(p.symbol) + '</b></td>' +
            '<td><span class="side-tag ' + (p.side === 'long' ? 'long' : 'short') + '">' + (p.side === 'long' ? '多' : '空') + '</span></td>' +
            noteCell(p) +
            '<td>' + num(p.size) + '</td>' +
            '<td>' + price(p.entry_price) + '</td>' +
            '<td>' + price(p.mark_price) + '</td>' +
            '<td class="strong ' + cls(Number(p.unrealized)) + '">' + money(p.unrealized) + '</td>' +
            '<td class="rate">' + rate(p.funding_rate) + '</td>' +
            '<td class="small muted">' + when(p.next_funding_time) + '</td>' +
            '</tr>';
        }).join('') || '<tr><td colspan="10" class="muted center">当前没有合约持仓</td></tr>';
      }

      var spotHoldings = data.spotHoldings || [];
      var spotValue = spotHoldings.reduce(function (a, h) { return a + (Number(h.value) || 0); }, 0);
      var spotCount = document.querySelector('[data-live-spot-count]');
      var spotValueEl = document.querySelector('[data-live-spot-value]');
      var spotRows = document.querySelector('[data-live-spot-rows]');
      if (spotCount) spotCount.textContent = String(spotHoldings.length);
      if (spotValueEl) spotValueEl.textContent = money(spotValue);
      if (spotRows) {
        spotRows.innerHTML = spotHoldings.map(function (h) {
          var priceText = (h.price === null || h.price === undefined) ? '—' : price(h.price);
          var value = (h.value === null || h.value === undefined) ? '—' : money(h.value);
          return '<tr>' +
            '<td class="small">' + esc(h.account_name) + '</td>' +
            '<td><b>' + esc(h.symbol) + '</b></td>' +
            '<td>' + num(h.quantity) + '</td>' +
            '<td>' + priceText + '</td>' +
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

    // 事件委托绑定在 tbody 上：整表重绘后依然有效
    rowBox.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-pos-note]') : null;
      if (!btn) return;
      if (rowBox.querySelector('.pos-note-editor')) return; // 一次只开一个编辑器
      openNoteEditor(btn);
    });

    function openNoteEditor(btn) {
      var cell = btn.closest('td');
      if (!cell) return;
      noteEditing = true;
      cell.innerHTML = '<div class="pos-note-editor">' +
        '<textarea maxlength="2000" rows="3" data-dictation placeholder="这笔持仓的想法…平仓后自动归入交易记录">' +
        esc(btn.getAttribute('data-content') || '') +
        '</textarea>' +
        '<div class="pos-note-actions">' +
        '<button type="button" class="btn small" data-note-save>保存</button>' +
        '<button type="button" class="btn btn-ghost small" data-note-cancel>取消</button>' +
        '</div></div>';
      var ta = cell.querySelector('textarea');
      ta.focus();
      var acc = btn.getAttribute('data-account');
      var sym = btn.getAttribute('data-symbol');
      var side = btn.getAttribute('data-side');
      cell.querySelector('[data-note-save]').addEventListener('click', async function () {
        try {
          var res = await fetch('/api/positions/note', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'account_id=' + encodeURIComponent(acc) +
              '&symbol=' + encodeURIComponent(sym) +
              '&side=' + encodeURIComponent(side) +
              '&note=' + encodeURIComponent(ta.value),
          });
          var data = await res.json().catch(function () { return null; });
          if (!res.ok || !data || !data.ok) {
            throw new Error((data && (data.message || data.error)) || 'HTTP ' + res.status);
          }
        } catch (err) {
          alert('保存失败：' + err.message);
          return;
        }
        noteEditing = false;
        poll(false);
      });
      cell.querySelector('[data-note-cancel]').addEventListener('click', function () {
        noteEditing = false;
        poll(false);
      });
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
        // 属性值是完整的周期查询串（如 kind=month&month=2026-10），老数据里可能只有周期标签
        var q = btn.getAttribute('data-copy-review') || '';
        if (!/^(kind=|week=)/.test(q)) q = 'week=' + encodeURIComponent(q);
        var original = btn.textContent;
        btn.disabled = true;
        try {
          var res = await fetch('/api/review?' + q + '&format=md', { credentials: 'same-origin' });
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

    var asrPreset = document.querySelector('[data-asr-preset]');
    var asrForm = document.getElementById('asr-config-form');
    if (asrPreset && asrForm) {
      asrPreset.addEventListener('change', function () {
        var opt = asrPreset.selectedOptions[0];
        if (!opt) return;
        var provider = asrForm.querySelector('[name="provider"]');
        var base = asrForm.querySelector('[name="baseUrl"]');
        var model = asrForm.querySelector('[name="model"]');
        if (provider) provider.value = opt.getAttribute('data-provider') || provider.value;
        if (base && opt.getAttribute('data-base')) base.value = opt.getAttribute('data-base');
        if (model && opt.getAttribute('data-model')) model.value = opt.getAttribute('data-model');
      });
    }

    var asrTestBtn = document.querySelector('[data-asr-test]');
    var asrTestOut = document.querySelector('[data-asr-test-result]');
    if (asrTestBtn) {
      asrTestBtn.addEventListener('click', async function () {
        asrTestBtn.disabled = true;
        if (asrTestOut) { asrTestOut.textContent = '测试中…'; asrTestOut.className = 'muted small'; }
        try {
          var res = await fetch('/api/asr/test', { method: 'POST', credentials: 'same-origin' });
          var data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.note || data.error || ('HTTP ' + res.status));
          if (asrTestOut) asrTestOut.textContent = data.note || '可用';
        } catch (err) {
          if (asrTestOut) { asrTestOut.textContent = '失败：' + err.message; asrTestOut.className = 'muted small neg'; }
        } finally {
          asrTestBtn.disabled = false;
        }
      });
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

    // 面板内的插入图片按钮：交易详情页复盘框、笔记编辑页共用同一套上传逻辑
    document.querySelectorAll('[data-note-image]').forEach(function (imageInput) {
      if (imageInput.dataset.imgBound === '1') return;
      var panel = imageInput.closest('.panel') || imageInput.closest('form');
      var target = (panel && panel.querySelector('textarea')) || textarea;
      if (!target) return;
      bindImagePicker(imageInput, target);
    });
  }

  /* ---------------- 图片上传 + 光标处插入（快评框 / 详情复盘框 / 笔记编辑页共用） ---------------- */
  function insertIntoTextarea(textarea, text) {
    var start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
    var before = textarea.value.slice(0, start);
    var after = textarea.value.slice(typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start);
    var prefix = before && !before.endsWith('\n') ? '\n\n' : '';
    var inserted = prefix + text + '\n';
    textarea.value = before + inserted + after;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = (before + inserted).length;
  }

  function bindImagePicker(input, textarea, labelText) {
    if (!input || !textarea || input.dataset.imgBound === '1') return;
    input.dataset.imgBound = '1';
    input.addEventListener('change', async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var label = input.closest('label');
      var status = labelText || (label ? label.querySelector('[data-note-image-label]') : null);
      var original = status ? status.textContent : '';
      if (status) status.textContent = '上传中…';
      try {
        var fd = new FormData();
        fd.set('image', file);
        var res = await fetch('/dashboard/notes/upload', { method: 'POST', credentials: 'same-origin', body: fd });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '上传失败');
        insertIntoTextarea(textarea, data.markdown);
      } catch (err) {
        alert('图片上传失败：' + (err && err.message || err));
      } finally {
        input.value = '';
        if (status) status.textContent = original || '插入图片';
      }
    });
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
    // 软导航离开页面时停止轮询，避免后台任务完成后把用户当前页 reload 掉
    onCleanup(function () {
      if (timer) { clearTimeout(timer); timer = null; }
      reloading = false;
    });
    var reloading = false;

    function stopProgress() {
      if (timer) clearTimeout(timer);
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
            if (reloading) return;
            reloading = true;
            showProgress('生成完成，正在刷新页面…');
            setTimeout(function () { if (reloading) location.reload(); }, 900);
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
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      }).then(function (r) {
        if (r.ok && r.data && r.data.ok && r.data.jobId) {
          poll(r.data.jobId);
        } else {
          stopProgress();
          showProgress('提交失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)));
          if (btn) { btn.disabled = false; btn.textContent = '调用 AI 生成解读'; }
        }
      }).catch(function (err) {
        stopProgress();
        showProgress('提交失败：' + (err.message || '网络异常'));
        if (btn) { btn.disabled = false; btn.textContent = '调用 AI 生成解读'; }
      });
    });
  }

  /* 带 data-autosubmit 的表单：下拉一改就提交（保留按钮，无 JS 也能用） */
  function initAutoSubmit() {
    document.querySelectorAll('form[data-autosubmit]').forEach(function (form) {
      form.querySelectorAll('select').forEach(function (sel) {
        sel.addEventListener('change', function () { form.submit(); });
      });
    });
  }

  /* 折线图悬浮：十字线 + 气泡显示该点的时间和数值（K 线数据由 SVG data 属性携带） */
  function initChartHover() {
    document.querySelectorAll('svg.chart[data-line-points]').forEach(function (svg) {
      if (svg.dataset.hoverReady) return;
      svg.dataset.hoverReady = '1';
      var rows;
      try { rows = JSON.parse(svg.dataset.linePoints || '[]'); } catch (err) { return; }
      if (!Array.isArray(rows) || rows.length < 2) return;
      var vbw = parseFloat(svg.dataset.vbw || '720');
      var vbh = parseFloat(svg.dataset.vbh || '220');
      var pl = parseFloat(svg.dataset.pl || '54');
      var pr = parseFloat(svg.dataset.pr || '12');
      var wrap = svg.parentElement;
      if (!wrap || getComputedStyle(wrap).position === 'static') {
        if (wrap) wrap.style.position = 'relative';
      }
      var tip = document.createElement('div');
      tip.className = 'chart-hover-tip';
      tip.setAttribute('aria-hidden', 'true');
      var cross = document.createElement('div');
      cross.className = 'chart-hover-cross';
      cross.setAttribute('aria-hidden', 'true');
      var dot = document.createElement('div');
      dot.className = 'chart-hover-dot';
      dot.setAttribute('aria-hidden', 'true');
      wrap.appendChild(cross);
      wrap.appendChild(dot);
      wrap.appendChild(tip);

      var hide = function () {
        tip.style.opacity = '0';
        cross.style.opacity = '0';
        dot.style.opacity = '0';
      };
      svg.addEventListener('mouseleave', hide);
      svg.addEventListener('mousemove', function (ev) {
        var rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // SVG 元素没有 offsetLeft/offsetTop，全部用 rect 相对 wrap 计算
        var wrapRect = wrap.getBoundingClientRect();
        var xVb = (ev.clientX - rect.left) / rect.width * vbw;
        var frac = (xVb - pl) / (vbw - pl - pr);
        var idx = Math.round(frac * (rows.length - 1));
        if (idx < 0) idx = 0;
        if (idx > rows.length - 1) idx = rows.length - 1;
        var row = rows[idx];
        var fracI = idx / (rows.length - 1);
        var px = rect.left - wrapRect.left + (pl + fracI * (vbw - pl - pr)) / vbw * rect.width;
        var py = rect.top - wrapRect.top + parseFloat(row[2]) / vbh * rect.height;
        cross.style.left = px + 'px';
        cross.style.opacity = '1';
        dot.style.left = (px - 5) + 'px';
        dot.style.top = (py - 5) + 'px';
        dot.style.opacity = '1';
        tip.textContent = row[0] + ' · ' + row[1];
        // 气泡默认在点上方（translate -50%,-135%），越界时钳制在容器内
        var tipH = tip.offsetHeight || 26;
        var half = tip.offsetWidth / 2 || 60;
        var tipTop = Math.max(py, tipH * 1.35 + 4);
        var tipLeft = Math.min(Math.max(px, half + 2), (wrap.clientWidth || 9999) - half - 2);
        tip.style.left = tipLeft + 'px';
        tip.style.top = tipTop + 'px';
        tip.style.opacity = '1';
      });
    });
  }

  /* 图表点击大图：委托监听（软导航安全），克隆 SVG 进全屏遮罩 */
  function initChartZoom() {
    if (document.getElementById('tl-lightbox')) return;
    var box = document.createElement('div');
    box.id = 'tl-lightbox';
    box.innerHTML = '<div class="tl-lightbox-inner"><div class="tl-lightbox-title">点击空白处或按 Esc 关闭</div></div><div class="tl-lightbox-close">×</div>';
    document.body.appendChild(box);

    var close = function () { box.classList.remove('open'); var inner = box.querySelector('.tl-lightbox-inner svg'); if (inner) inner.remove(); };
    box.addEventListener('click', function (ev) {
      if (ev.target === box || ev.target.classList.contains('tl-lightbox-close') || ev.target.classList.contains('tl-lightbox-inner')) close();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
    document.addEventListener('click', function (ev) {
      var svg = ev.target.closest && ev.target.closest('svg.chart, svg.heatmap, svg.donut');
      if (!svg || box.classList.contains('open')) return;
      var inner = box.querySelector('.tl-lightbox-inner');
      var old = inner.querySelector('svg');
      if (old) old.remove();
      var panel = svg.closest('.panel');
      var heading = panel ? panel.querySelector('.panel-head h2') : null;
      box.querySelector('.tl-lightbox-title').textContent =
        (heading ? heading.textContent + ' · ' : '') + '点击空白处或按 Esc 关闭';
      var clone = svg.cloneNode(true);
      clone.removeAttribute('data-hover-ready'); // 让悬浮逻辑在大图里重新绑定
      inner.appendChild(clone);
      box.classList.add('open');
      initChartHover(); // 大图里的坐标点同样支持悬浮弹窗
    });
  }

  /* ---------------- 交易详情：AI 复盘 ---------------- */
  function initTradeAi() {
    var btn = document.querySelector('[data-trade-ai]');
    if (!btn) return;
    var panel = btn.closest('.panel');
    var input = panel ? panel.querySelector('[data-trade-note]') : null;
    var status = panel ? panel.querySelector('[data-trade-ai-status]') : null;
    var progress = panel ? panel.querySelector('[data-trade-ai-progress]') : null;
    var bar = progress ? progress.querySelector('.report-progress-bar span') : null;
    if (!input) return;
    var label = btn.textContent;
    var timer = null;
    var startedAt = 0;

    function stopTicker() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    // 软导航离开页面时停止计时，避免残留定时器
    onCleanup(stopTicker);

    function startTicker() {
      stopTicker();
      startedAt = Date.now();
      if (progress) progress.hidden = false;
      if (bar) bar.style.width = '4%';
      timer = setInterval(function () {
        var secs = Math.round((Date.now() - startedAt) / 1000);
        // 没有真实进度可拿：缓慢逼近 92%，完成时再跳 100%
        if (bar) bar.style.width = Math.min(92, 4 + secs * 1.6) + '%';
        if (status) {
          status.textContent = '正在生成… 已等待 ' + secs + ' 秒（通常 10–60 秒，请勿关闭页面）';
          status.className = 'muted small';
        }
      }, 1000);
    }

    function finishTicker(done) {
      stopTicker();
      if (bar && done) bar.style.width = '100%';
      if (done) {
        setTimeout(function () { if (progress) progress.hidden = true; }, 700);
      } else if (progress) {
        progress.hidden = true;
      }
    }

    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'AI 生成中…';
      if (status) { status.textContent = '正在按这笔交易的记录生成复盘，通常需要 10–60 秒…'; status.className = 'muted small'; }
      startTicker();
      fetch('/api/trades/' + encodeURIComponent(btn.getAttribute('data-trade-ai')) + '/ai-review', {
        method: 'POST',
        credentials: 'same-origin',
      }).then(function (res) {
        return res.json().then(function (data) { return { res: res, data: data }; }).catch(function () {
          return { res: res, data: {} };
        });
      }).then(function (out) {
        if (!out.res.ok || !out.data.ok) {
          throw new Error((out.data && (out.data.error || out.data.message)) || ('HTTP ' + out.res.status));
        }
        finishTicker(true);
        var current = input.value.trim();
        input.value = current ? current + '\n\n---\n\n' + out.data.text : out.data.text;
        input.focus();
        if (status) { status.textContent = '已生成并填入下方笔记框，可编辑后点「保存复盘」。'; status.className = 'muted small pos'; }
      }).catch(function (err) {
        finishTicker(false);
        if (status) { status.textContent = 'AI 生成失败：' + (err && err.message || err); status.className = 'muted small neg'; }
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = label;
      });
    });
  }

  /* ---------------- 交易记录：批量勾选移入垃圾箱 ---------------- */
  function initBulkSelect() {
    var form = document.getElementById('journal-bulk');
    if (!form || form.dataset.bulkBound === '1') return;
    form.dataset.bulkBound = '1';
    var checks = Array.prototype.slice.call(document.querySelectorAll('input.bulk-check[form="journal-bulk"]'));
    var all = document.querySelector('input[data-bulk-all]');
    var count = form.querySelector('[data-bulk-count]');
    var submit = form.querySelector('[data-bulk-submit]');
    var emptyHint = '勾选左侧复选框可批量移入垃圾箱（只作用于本页）';
    if (!checks.length) { form.hidden = true; return; }

    function selected() {
      return checks.filter(function (c) { return c.checked; });
    }
    function refresh() {
      var n = selected().length;
      if (submit) submit.disabled = n === 0;
      if (count) count.textContent = n ? '已选 ' + n + ' 条' : emptyHint;
      if (all) {
        all.checked = n > 0 && n === checks.length;
        all.indeterminate = n > 0 && n < checks.length;
      }
    }
    checks.forEach(function (c) { c.addEventListener('change', refresh); });
    if (all) {
      all.addEventListener('change', function () {
        checks.forEach(function (c) { c.checked = all.checked; });
        refresh();
      });
    }
    form.addEventListener('submit', function (ev) {
      var n = selected().length;
      if (!n) { ev.preventDefault(); return; }
      if (!window.confirm('把选中的 ' + n + ' 条记录移入垃圾箱？\n统计立即排除，交易所同步也不会再导回；可在交易记录 → 垃圾箱里恢复。')) {
        ev.preventDefault();
      }
    });
    refresh();
  }

  function initPage() {
    initTheme();
    initPrivacy();
    initTimeDefaults();
    initAlerts();
    initImportGuard();
    initBulkSelect();
    initSyncButtons();
    initLivePanel();
    initAutoSyncBar();
    initCopyReview();
    initAccountForm();
    initAi();
    initReportAi();
    initTradeAi();
    initMarkdown();
    initAutoSubmit();
    initChartHover();
    initChartZoom();
    initQuickNote();
    initDictation();
    initDashboardOrder();
  }

  /* ---------------- 行内快评：表格行下方展开输入框，就地保存 ---------------- */
  var quickNoteBound = false;
  var openEditor = null; // { row, editorRow, btn }

  function closeQuickEditor() {
    if (!openQuickEditor()) return;
    var row = openEditor.editorRow;
    openEditor = null;
    if (row && row.parentNode) row.parentNode.removeChild(row);
  }
  function openQuickEditor() { return openEditor; }

  function saveQuickNote() {
    if (!openEditor) return;
    var btn = openEditor.btn;
    var id = btn.getAttribute('data-quick-note');
    var textarea = openEditor.editorRow.querySelector('textarea');
    var status = openEditor.editorRow.querySelector('[data-qnote-status]');
    var text = textarea.value;
    if (status) status.textContent = '保存中…';
    fetch('/api/trades/' + encodeURIComponent(id) + '/note', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ note: text }).toString(),
    }).then(function (res) {
      return res.json().then(function (data) { return { res: res, data: data }; }, function () { return { res: res, data: {} }; });
    }).then(function (out) {
      if (!out.res.ok || !out.data.ok) {
        throw new Error((out.data && (out.data.error || out.data.message)) || ('HTTP ' + out.res.status));
      }
      var trimmed = text.trim();
      btn.setAttribute('data-note', trimmed);
      if (trimmed) {
        btn.classList.add('has-note');
        var flat = trimmed.replace(/\s+/g, ' ');
        btn.textContent = flat.length > 24 ? flat.slice(0, 24) + '…' : flat;
        btn.title = flat.slice(0, 200);
      } else {
        btn.classList.remove('has-note');
        btn.textContent = '+ 快评';
        btn.title = '写一句话快评';
      }
      if (status) status.textContent = '已保存 ✓';
      pageTimeout(function () { closeQuickEditor(); }, 400);
    }).catch(function (err) {
      if (status) status.textContent = '保存失败：' + (err && err.message || err);
    });
  }

  function toggleQuickEditor(btn) {
    if (openEditor && openEditor.btn === btn) { closeQuickEditor(); return; }
    closeQuickEditor();
    var row = btn.closest('tr');
    if (!row || !row.parentNode) return;
    var editorRow = document.createElement('tr');
    editorRow.className = 'quick-note-row';
    var td = document.createElement('td');
    td.colSpan = row.children.length;
    td.innerHTML = '<div class="quick-note-editor">' +
      '<textarea rows="3" maxlength="5000" placeholder="一句话也行：为什么开 / 错在哪 / 下次怎么办（Ctrl+Enter 保存，Esc 取消）"></textarea>' +
      '<div class="quick-note-actions">' +
      '<button type="button" class="btn btn-primary small" data-qnote-save>保存</button>' +
      '<button type="button" class="btn btn-ghost small" data-qnote-cancel>取消</button>' +
      '<label class="btn btn-ghost small"><span data-note-image-label>插入图片</span>' +
      '<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-note-image hidden></label>' +
      '<span class="muted small" data-qnote-status>支持 Markdown 与图片</span>' +
      '</div></div>';
    editorRow.appendChild(td);
    row.parentNode.insertBefore(editorRow, row.nextSibling);
    var textarea = td.querySelector('textarea');
    textarea.value = btn.getAttribute('data-note') || '';
    openEditor = { row: row, editorRow: editorRow, btn: btn };
    onCleanup(closeQuickEditor); // 软导航离开时收起，避免残留
    attachDictation(textarea);
    td.querySelector('[data-qnote-save]').addEventListener('click', saveQuickNote);
    td.querySelector('[data-qnote-cancel]').addEventListener('click', closeQuickEditor);
    bindImagePicker(td.querySelector('[data-note-image]'), textarea);
    textarea.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        saveQuickNote();
      }
    });
    textarea.focus();
  }

  function initQuickNote() {
    if (!document.querySelector('[data-quick-note]')) return;
    if (quickNoteBound) return;
    quickNoteBound = true;
    // 委托到 document：软导航换页后新表格行依然有效
    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-quick-note]') : null;
      if (btn) {
        ev.preventDefault();
        toggleQuickEditor(btn);
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeQuickEditor();
    });
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

  // 快捷标签无刷新提交：fetch 后原地切换 active，连续打标签不再整页 reload
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || !form.classList || !form.classList.contains('quick-tag-form')) return;
    ev.preventDefault();
    var btn = form.querySelector('button');
    if (!btn) return;
    var wasActive = btn.classList.contains('active');
    fetch(form.getAttribute('action'), {
      method: 'POST',
      body: new FormData(form),
      credentials: 'same-origin',
      redirect: 'manual',
    }).then(function (res) {
      if (res.type === 'opaqueredirect' || res.ok) btn.classList.toggle('active', !wasActive);
      else location.reload();
    }).catch(function () { location.reload(); });
  });

  // 指标下钻：点击带 data-details-open 的统计块，展开并滚动到对应 <details> 明细
  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-details-open]') : null;
    if (!el || el.closest('a, button, form')) return;
    var target = document.getElementById(el.getAttribute('data-details-open'));
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // 全站防重复提交：POST 表单提交后禁用按钮；整页跳转/刷新后自然恢复。
  // 30 秒兜底自动恢复，避免网络失败时按钮永久禁用。
  document.addEventListener('submit', function (ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    if (!form || form.nodeType !== 1) return;
    if (String(form.getAttribute('method') || '').toLowerCase() !== 'post') return;
    if (form.hasAttribute('data-no-guard') || form.dataset.guarded) return;
    form.dataset.guarded = '1';
    var buttons = Array.prototype.slice.call(form.querySelectorAll('button[type="submit"], button:not([type])'));
    buttons.forEach(function (btn) {
      if (btn.disabled) return;
      btn.dataset.label = btn.textContent;
      btn.textContent = /备份|测试/.test(btn.dataset.label) ? '处理中…' : '提交中…';
      btn.disabled = true;
    });
    setTimeout(function () {
      buttons.forEach(function (btn) {
        if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
        btn.disabled = false;
      });
      delete form.dataset.guarded;
    }, 30000);
  });
  window.addEventListener('pageshow', function () {
    // bfcache 后退回来的页面：恢复被禁用的按钮
    document.querySelectorAll('form[data-guarded]').forEach(function (form) {
      form.querySelectorAll('button[data-label]').forEach(function (btn) {
        if (btn.dataset.label !== undefined) btn.textContent = btn.dataset.label;
        btn.disabled = false;
      });
      delete form.dataset.guarded;
    });
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
