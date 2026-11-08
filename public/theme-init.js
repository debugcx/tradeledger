/**
 * 主题/隐私预初始化：在首帧渲染前把 <html data-theme/data-privacy> 设好，
 * 避免暗色用户看到闪白。必须在 <head> 内同步执行，所以单独成一个文件
 * （CSP script-src 'self' 不允许内联脚本）。
 */
try {
  var t = localStorage.getItem('tl-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  if (localStorage.getItem('tl-privacy') === '1') document.documentElement.dataset.privacy = '1';
} catch (e) { /* localStorage 不可用时用默认主题 */ }
