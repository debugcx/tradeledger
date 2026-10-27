import test from 'node:test';
import assert from 'node:assert/strict';

const { barChart } = await import('../src/charts.js?bar-geom-test');

/** 从 barChart 输出里解析每个柱子的 rect（y 与 height），用于几何断言 */
function parseRects(svg) {
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
  return rects.map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
}

test('barChart：正负柱均以零线为基准，正柱不再贯穿全图', () => {
  // 视图：720x220，padL=54 padR=12 padT=12 padB=32 → 绘图高 h=176，plot [12,188]
  const svg = barChart({
    items: [
      { label: '周二', value: 601 },
      { label: '周日', value: -1728 },
      { label: '周一', value: -2504 },
    ],
    width: 720, height: 220,
  });
  const rects = parseRects(svg);
  assert.equal(rects.length, 3);

  // max=601 min=-2504 span=3105；h=176；零线位置 = 12 + 176×(601/3105) = 45.99
  const h = 176, padT = 12, min = -2504, span = 3105;
  const zeroY = padT + h - ((0 - min) / span) * h;

  const [tue, sun, mon] = rects; // 按 items 顺序
  // 正柱 601：顶端在数值位置，高度 = 到零线
  const tueVY = padT + h - ((601 - min) / span) * h;
  assert.ok(Math.abs(tue.y - tueVY) < 0.5, `正柱顶 ${tue.y} 应在数值位置 ${tueVY.toFixed(1)}`);
  assert.ok(Math.abs(tue.h - (zeroY - tueVY)) < 0.5, `正柱高 ${tue.h} 应为 ${ (zeroY - tueVY).toFixed(1) }（到零线），而不是贯穿全图`);
  // 负柱 -1728：从零线画到数值位置
  const sunVY = padT + h - ((-1728 - min) / span) * h;
  assert.ok(Math.abs(sun.y - zeroY) < 0.5, '负柱顶应在零线');
  assert.ok(Math.abs(sun.h - (sunVY - zeroY)) < 0.5, `负柱高 ${sun.h} 应为 ${ (sunVY - zeroY).toFixed(1) }（零线到数值）`);
  // 最小值柱：底边贴绘图区底，柱体从零线画到底
  assert.ok(Math.abs(mon.y + mon.h - (padT + h)) < 0.5, '最小值柱底应贴绘图区底');
  assert.ok(Math.abs(mon.h - (padT + h - zeroY)) < 0.6, '最小值柱应从零线画到绘图区底');
});
