import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const passwordFromEnv = Boolean(process.env.TRADELEDGER_PASSWORD || process.env.ACCESS_PASSWORD);

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'tradeledger.db'),
  backupDir: process.env.BACKUP_DIR || path.join(ROOT, 'data', 'backups'),
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8790),
  password: process.env.TRADELEDGER_PASSWORD || process.env.ACCESS_PASSWORD || 'demo1234',
  passwordFromEnv,
  sessionCookie: 'tl_session',
  sessionDays: 7,
  rememberDays: 30,
  maxCsvBytes: 8 * 1024 * 1024,
  maxCsvRows: 50000,
  syncLookbackDays: Number(process.env.SYNC_LOOKBACK_DAYS || 180),
  syncBatchLimit: Number(process.env.SYNC_BATCH_LIMIT || 1000),
  syncWindowDays: 7,
  syncWindowBudget: Number(process.env.SYNC_WINDOW_BUDGET || 8),
  transferRefreshHours: Math.max(1, Number(process.env.TRANSFER_REFRESH_HOURS || 6)),
  spotRefreshHours: Math.max(1, Number(process.env.SPOT_REFRESH_HOURS || 1)),
  liveRefreshSeconds: Number(process.env.LIVE_REFRESH_SECONDS || 60),
  syncWorkerSeconds: Number(process.env.SYNC_WORKER_SECONDS || 5),
  seedDemo: process.env.SEED_DEMO !== '0',
};
