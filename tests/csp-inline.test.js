import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const viewsDir = new URL('../src/views/', import.meta.url);

test('视图不再包含内联事件处理器（CSP script-src self）', () => {
  const offenders = [];
  for (const name of fs.readdirSync(viewsDir)) {
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(new URL(name, viewsDir), 'utf8');
    if (/onsubmit=|onclick=|onchange=|onload=|onerror=/.test(text)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('确认对话框统一走 data-confirm，由 app.js 委托处理', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /initConfirmForms/);
  assert.match(app, /data-confirm/);
  // 每个内联确认都已迁移
  const journal = fs.readFileSync(new URL('../src/views/journal.js', import.meta.url), 'utf8');
  assert.match(journal, /data-confirm="把这条记录移入垃圾箱？&#10;/);
  assert.ok(!journal.includes('onclick='));
});

test('对账面板与主题脚本外置，页面以 src 引用', () => {
  assert.ok(fs.existsSync(new URL('../public/reconcile-monthly.js', import.meta.url)));
  assert.ok(fs.existsSync(new URL('../public/theme-init.js', import.meta.url)));
  const reconcile = fs.readFileSync(new URL('../src/views/reconcile.js', import.meta.url), 'utf8');
  assert.match(reconcile, /<script src="\/reconcile-monthly\.js" defer><\/script>/);
  const layout = fs.readFileSync(new URL('../src/views/layout.js', import.meta.url), 'utf8');
  assert.match(layout, /<script src="\$\{asset\('\/theme-init\.js'\)\}"><\/script>/);
});
