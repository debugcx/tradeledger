/**
 * 对账页月度面板：异步拉取 /dashboard/reconcile/monthly 片段并替换占位。
 * 由 reconcilePage 以 <script src> 引用（CSP 不允许内联脚本）。
 */
(function () {
  var box = document.getElementById('monthly-panels');
  if (!box) return;
  var params = new URLSearchParams();
  var accountId = box.getAttribute('data-account-id');
  if (accountId) params.set('account_id', accountId);
  if (new URLSearchParams(location.search).get('refresh') === '1') params.set('refresh', '1');
  function fail(message) {
    var section = document.createElement('section');
    section.className = 'panel';
    var head = document.createElement('div');
    head.className = 'panel-head';
    var title = document.createElement('h2');
    title.textContent = '月度对账';
    head.appendChild(title);
    var empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = message;
    section.appendChild(head);
    section.appendChild(empty);
    box.replaceChildren(section);
  }
  fetch('/dashboard/reconcile/monthly' + (params.toString() ? '?' + params.toString() : ''), {
    headers: { accept: 'text/html' },
  })
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
    .then(function (html) {
      if (html && html.trim()) box.innerHTML = html;
      else fail('没有可对账的交易所账户');
    })
    .catch(function (err) { fail('账本加载失败：' + (err && err.message ? err.message : String(err))); });
})();
