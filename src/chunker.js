/**
 * 内容定义分块（CDC）：用于 WebDAV 增量备份。
 *
 * 用 FastCDC 风格的 gear 滚动哈希找边界，而不是固定大小切分——
 * 这样在文件中间插入/删除数据时，只影响附近的块，后续块仍能复用。
 * gear 表用固定种子生成，保证跨进程、跨版本分块结果一致（去重的前提）。
 */

const MIN_SIZE = 64 * 1024;
const MAX_SIZE = 1024 * 1024;
const BOUNDARY_BITS = 18; // 平均额外 ~256KB 出现一个边界

const GEAR = (() => {
  let x = 0x9e3779b9 >>> 0;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    table[i] = x;
  }
  return table;
})();

/**
 * 把 Buffer 切成内容相关的块。
 * @param {Buffer} buffer
 * @param {{min?:number,max?:number,bits?:number}} opts
 * @returns {Buffer[]} 连续子切片，拼起来等于原 Buffer
 */
export function chunkBuffer(buffer, { min = MIN_SIZE, max = MAX_SIZE, bits = BOUNDARY_BITS } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return [];
  const mask = (1 << bits) - 1;
  const out = [];
  let start = 0;
  while (start < buf.length) {
    const hardEnd = Math.min(buf.length, start + max);
    let end = hardEnd;
    if (hardEnd - start > min) {
      let h = 0;
      // 前 min 字节不找边界，保证块不会太小
      for (let i = start + min; i < hardEnd; i++) {
        h = ((((h << 1) >>> 0) + GEAR[buf[i]]) >>> 0);
        if ((h & mask) === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out.push(buf.subarray(start, end));
    start = end;
  }
  return out;
}

export const CHUNK_LIMITS = { min: MIN_SIZE, max: MAX_SIZE, bits: BOUNDARY_BITS };
