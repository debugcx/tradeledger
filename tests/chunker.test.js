import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chunkBuffer, CHUNK_LIMITS } from '../src/chunker.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function pseudoRandom(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

test('CDC 分块：确定性、大小边界、可无损拼接', () => {
  const buf = pseudoRandom(3 * 1024 * 1024, 7);
  const a = chunkBuffer(buf);
  const b = chunkBuffer(buf);
  assert.ok(a.length >= 2);
  assert.deepEqual(a.map((c) => c.length), b.map((c) => c.length));
  assert.ok(Buffer.concat(a).equals(buf));
  a.forEach((c, i) => {
    assert.ok(c.length <= CHUNK_LIMITS.max);
    if (i < a.length - 1) assert.ok(c.length >= CHUNK_LIMITS.min);
  });
});

test('CDC 分块：中间插入少量字节后，大部分块仍可复用', () => {
  const buf = pseudoRandom(3 * 1024 * 1024, 11);
  const insertAt = 1024 * 1024 + 123;
  const modified = Buffer.concat([
    buf.subarray(0, insertAt),
    Buffer.from('hello world'),
    buf.subarray(insertAt),
  ]);
  const before = new Set(chunkBuffer(buf).map(sha));
  const after = chunkBuffer(modified);
  const reused = after.filter((c) => before.has(sha(c))).length;
  assert.ok(reused >= Math.floor(after.length * 0.5), `复用 ${reused}/${after.length} 块，应至少一半`);
});
