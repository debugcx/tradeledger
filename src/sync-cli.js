import { closeDb } from './db.js';
import { syncAllAccounts } from './sync.js';

try {
  const results = await syncAllAccounts();
  for (const r of results) {
    if (r.ok) {
      console.log(`[${r.exchange}] 批次：拉取 ${r.fetched}，写入 ${r.inserted}，跳过 ${r.skipped}，完成=${r.done}`);
    } else {
      console.error(`[${r.exchange}] 同步失败：${r.error}`);
    }
  }
  if (results.some((r) => r.ok === false)) process.exitCode = 1;
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  closeDb();
}
