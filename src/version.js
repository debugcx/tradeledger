/**
 * 应用版本：以 package.json 为准，模块加载时取一次。
 *
 * 容器里用 `node src/server.js` 直接启动，没有 npm 注入的 npm_package_version，
 * 所以不能依赖该环境变量（否则健康检查永远报旧版本）。
 */

import fs from 'node:fs';

export const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
