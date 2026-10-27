import { escapeHtml as e } from '../http.js';
import { layout } from './layout.js';

export function loginPage({ next = '', error = '', dev = false }) {
  return layout({
    title: '登录 | TradeLedger',
    body: `<div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand"><span class="brand-mark big">TL</span></div>
        <h1>TradeLedger</h1>
        <p class="muted">交易复盘台账 · 本地优先 · 数据自持</p>
        ${dev ? `<div class="alert alert-info">未设置 <code>TRADELEDGER_PASSWORD</code>，当前使用开发密码 <b>demo1234</b>。部署或长期使用前请配置环境变量。</div>` : ''}
        ${error ? `<div class="alert alert-error">${e(error)}</div>` : ''}
        <form method="post" action="/login" class="form">
          <input type="hidden" name="next" value="${e(next)}">
          <label class="field"><span>访问密码</span>
            <input name="password" type="password" required autofocus autocomplete="current-password">
          </label>
          <label class="check"><input type="checkbox" name="remember" value="1"> 30 天内免登录</label>
          <button class="btn btn-primary wide" type="submit">进入</button>
        </form>
        <p class="auth-foot muted small">单用户 · 无注册 · 无找回密码</p>
      </div>
    </div>`,
  });
}
