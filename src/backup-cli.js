/**
 * 备份 CLI。
 *
 *   npm run backup             创建本地快照；如果启用了 WebDAV，再上传
 *   npm run backup:list        列出本地 / 远端备份
 *   npm run restore:stage -- <文件名>   暂存一个备份（本地 .db 或远端 .db.gz[.enc]）
 *   npm run restore            应用 data/restore-pending.db（需先停止服务）
 */

import { applyPendingRestore } from './restore.js';

const cmd = process.argv[2] || 'backup';

if (cmd === 'restore' || cmd === 'apply') {
  const result = applyPendingRestore();
  if (!result) {
    console.log('没有待恢复的备份（data/restore-pending.db 不存在）');
  } else if (result.ok) {
    console.log(`已恢复数据库；恢复前的数据库保存在 ${result.preRestore}`);
  } else {
    console.error(`恢复失败：${result.error}`);
    console.error('请先停止 TradeLedger 服务，再重新运行 npm run restore。');
    process.exitCode = 1;
  }
} else {
  const backup = await import('./backup.js');

  if (cmd === 'backup' || cmd === 'snapshot') {
    const snap = backup.createLocalSnapshot('cli');
    console.log(`本地快照：${snap.name}（${backup.fmtBytes(snap.bytes)}，${snap.resources} 个图片资源）`);
    if (cmd === 'backup') {
      const cfg = backup.getBackupConfig();
      if (cfg.webdavEnabled && cfg.webdavUrl) {
        const result = await backup.runRemoteBackup({ reason: 'cli' });
        console.log(`WebDAV：${result.name}（${backup.fmtBytes(result.bytes)}${result.encrypted ? '，已加密' : ''}）`);
      } else {
        console.log('WebDAV 未启用，跳过上传。');
      }
    }
  } else if (cmd === 'upload') {
    const result = await backup.runRemoteBackup({ reason: 'cli' });
    console.log(`已上传：${result.name}（${backup.fmtBytes(result.bytes)}${result.encrypted ? '，已加密' : ''}）`);
  } else if (cmd === 'list') {
    const cfg = backup.getBackupConfig();
    console.log('本地快照：');
    const local = backup.listLocalBackups();
    if (!local.length) console.log('  （无）');
    for (const f of local) console.log(`  ${f.name}  ${backup.fmtBytes(f.bytes)}  ${f.created_at}`);
    if (cfg.webdavEnabled && cfg.webdavUrl) {
      console.log('远端备份：');
      const remote = await backup.listRemoteBackups();
      if (!remote.files.length) console.log('  （无）');
      for (const f of remote.files) {
        console.log(`  ${f.name}  ${backup.fmtBytes(f.bytes)}${f.encrypted ? '  已加密' : ''}  ${f.created_at || ''}`);
      }
    }
  } else if (cmd === 'stage') {
    const name = process.argv[3];
    if (!name) {
      console.error('用法：npm run restore:stage -- <备份文件名>');
      process.exitCode = 1;
    } else {
      const meta = name.endsWith('.db')
        ? backup.stageRestoreFromLocal(name)
        : await backup.stageRestoreFromRemote(name);
      console.log(`已暂存：${meta.name}。停止服务后运行 npm run restore 应用。`);
    }
  } else {
    console.log('用法：node src/backup-cli.js [backup|snapshot|upload|list|stage <name>|restore]');
    process.exitCode = 1;
  }
}
