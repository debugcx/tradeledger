import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';

const { classifyOrderType } = await import('../src/fills.js');

test('classifyOrderType：纯挂/纯吃/混合/未知', () => {
  assert.equal(classifyOrderType([{ execType: 'M' }, { execType: 'M' }]), 'limit');
  assert.equal(classifyOrderType([{ execType: 'T' }, { execType: 'T' }]), 'market');
  assert.equal(classifyOrderType([{ execType: 'M' }, { execType: 'T' }]), 'mixed');
  assert.equal(classifyOrderType([{ orderType: 'Limit' }, { orderType: 'Market' }]), 'mixed');
  assert.equal(classifyOrderType([{ orderType: 'other' }]), 'other');
  assert.equal(classifyOrderType([]), 'other');
});
