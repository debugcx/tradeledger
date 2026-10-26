import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const store = await import('../src/store.js');

test('快捷标签：默认自动，保存后去重、去空白', () => {
  assert.equal(store.getQuickTags(), null);
  store.setQuickTags(['追高', ' 试单 ', '追高', '']);
  assert.deepEqual(store.getQuickTags(), ['追高', '试单']);
  assert.equal(store.getMeta('quick_tags'), JSON.stringify(['追高', '试单']));
});

test('快捷标签：最多 12 个，清空后恢复自动', () => {
  store.setQuickTags(Array.from({ length: 15 }, (_, i) => `T${i}`));
  assert.equal(store.getQuickTags().length, 12);
  store.setQuickTags([]);
  assert.equal(store.getQuickTags(), null);
});

test('快捷标签：损坏的配置按未配置处理', () => {
  store.setMeta('quick_tags', '{not-json');
  assert.equal(store.getQuickTags(), null);
});
