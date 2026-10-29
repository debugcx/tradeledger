import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-backup-'));
process.env.DB_FILE = path.join(root, 'test.db');
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.TRADELEDGER_MASTER_KEY = 'ab'.repeat(32);

const store = await import('../src/store.js');
const backup = await import('../src/backup.js');
const { closeDb } = await import('../src/db.js');
const { applyPendingRestore } = await import('../src/restore.js');

const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

function startFakeDav() {
  const files = new Map();
  const deletes = [];
  const mkcols = [];
  const expectedAuth = 'Basic ' + Buffer.from('u:p').toString('base64');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'MKCOL') { mkcols.push(p); res.writeHead(201); return res.end(); }
      if (req.method === 'PUT') { files.set(p, Buffer.concat(chunks)); res.writeHead(201); return res.end(); }
      if (req.method === 'GET') {
        if (!files.has(p)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(files.get(p));
      }
      if (req.method === 'DELETE') {
        deletes.push(p);
        files.delete(p);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, files, deletes, mkcols, port: server.address().port }));
  });
}

test('备份：快照包含笔记图片 BLOB，且可校验完整性', () => {
  const account = store.ensureDefaultAccount();
  store.createTrade({
    symbol: 'BTC/USDT', side: 'long', size: 1, notional: 100,
    entry_price: 100, exit_price: 110,
    open_time: '2026-10-01T00:00:00.000Z', close_time: '2026-10-01T01:00:00.000Z',
    pnl: 10, fee: -0.1,
  }, { accountId: account.id });
  store.saveResource({ id: 'img-test', name: 'shot.png', mime: 'image/png', size: image.length, data: image });

  const snap = backup.createLocalSnapshot('test');
  assert.equal(snap.integrity, 'ok');
  assert.equal(snap.trades, 1);
  assert.equal(snap.resources, 1);
  assert.ok(snap.bytes > 0);

  const db = new DatabaseSync(path.join(root, 'backups', snap.name), { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM resources WHERE id = ?').get('img-test');
    assert.deepEqual(Buffer.from(row.data), image);
  } finally {
    db.close();
  }

  const list = backup.listLocalBackups();
  assert.ok(list.some((f) => f.name === snap.name));
  assert.equal(backup.resolveLocalSnapshot(snap.name), path.join(root, 'backups', snap.name));
  assert.throws(() => backup.resolveLocalSnapshot('../test.db'), /不合法/);
});

test('备份：AES-256-GCM 加密与错误密码', () => {
  const payload = Buffer.from('tradeledger backup payload');
  const enc = backup.encryptBuffer(payload, 'backup-pass-123');
  assert.equal(backup.decryptBuffer(enc, 'backup-pass-123').toString(), payload.toString());
  assert.throws(() => backup.decryptBuffer(enc, 'wrong-pass-123'), /密码错误/);
  assert.throws(() => backup.encryptBuffer(payload, 'short'), /至少 8 位/);
});

test('备份：WebDAV 上传、清单、下载、保留策略与恢复暂存', async () => {
  const dav = await startFakeDav();
  try {
    const cfg = {
      webdavEnabled: true,
      webdavUrl: `http://127.0.0.1:${dav.port}/dav`,
      webdavUsername: 'u',
      webdavPassword: 'p',
      webdavDir: 'TradeLedger',
      intervalHours: 6,
      keep: 5,
      backupMode: 'full',
      passphrase: 'backup-pass-123',
      localEnabled: true,
      localIntervalHours: 24,
      localKeep: 5,
    };
    const saved = backup.saveBackupConfig(cfg);
    assert.deepEqual(saved.warnings, []);
    const tested = await backup.testWebdavConnection();
    assert.ok(tested.ms >= 0);
    assert.equal(tested.dir.endsWith('/TradeLedger'), true);

    const first = await backup.runRemoteBackup({ reason: 'test' });
    assert.ok(first.name.endsWith('.db.gz.enc'));
    assert.equal(first.encrypted, true);
    const listed = await backup.listRemoteBackups();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].sha256.length, 64);

    const dl = await backup.downloadRemoteBackup(first.name);
    assert.equal(dl.buffer.subarray(0, 16).toString('latin1'), 'SQLite format 3\u0000');
    const staged = await backup.stageRestoreFromRemote(first.name);
    assert.equal(staged.source, 'webdav');
    assert.ok(fs.existsSync(path.join(root, 'restore-pending.db')));
    backup.cancelPendingRestore();
    assert.equal(fs.existsSync(path.join(root, 'restore-pending.db')), false);

    // 让旧快照超过 60 秒，下一轮会创建新快照；keep=1 应删掉远端旧文件
    const oldSnap = backup.listLocalBackups()[0];
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(path.join(root, 'backups', oldSnap.name), past, past);
    backup.saveBackupConfig({ ...cfg, keep: 1 });
    const second = await backup.runRemoteBackup({ reason: 'test-2' });
    assert.notEqual(second.name, first.name);
    const after = await backup.listRemoteBackups();
    assert.equal(after.files.length, 1);
    assert.equal(after.files[0].name, second.name);
    assert.ok(dav.deletes.some((p) => p.endsWith(first.name)));
  } finally {
    await new Promise((resolve) => dav.server.close(resolve));
  }
});

test('增量备份：分块去重、重组校验与保留清理', async () => {
  const dav = await startFakeDav();
  try {
    // 大块随机内容作主体：两次快照之间应大部分分块不变
    const big = Buffer.alloc(3 * 1024 * 1024);
    let x = 123456789;
    for (let i = 0; i < big.length; i++) {
      x ^= (x << 13) >>> 0; x >>>= 0;
      x ^= x >>> 17;
      x ^= (x << 5) >>> 0; x >>>= 0;
      big[i] = x & 0xff;
    }
    store.saveResource({ id: 'big-blob', name: 'big.bin', mime: 'application/octet-stream', size: big.length, data: big });

    const cfg = {
      webdavEnabled: true,
      webdavUrl: `http://127.0.0.1:${dav.port}/dav`,
      webdavUsername: 'u',
      webdavPassword: 'p',
      webdavDir: 'TradeLedger',
      intervalHours: 6,
      keep: 3,
      backupMode: 'incremental',
      passphrase: 'backup-pass-123',
      localEnabled: true,
      localIntervalHours: 24,
      localKeep: 10,
    };
    backup.saveBackupConfig(cfg);

    const first = await backup.runRemoteBackup({ reason: 'inc-1' });
    assert.equal(first.mode, 'incremental');
    assert.ok(first.name.endsWith('.db.chunks'));
    assert.equal(first.encrypted, true);
    assert.ok(first.chunks.total >= 2);
    assert.equal(first.chunks.uploaded, first.chunks.total);
    assert.ok(dav.mkcols.some((p) => p.endsWith('/chunks')), '应先创建 chunks 子目录');
    const chunkFiles = [...dav.files.keys()].filter((p) => p.includes('/chunks/'));
    assert.equal(chunkFiles.length, first.chunks.total);

    // 只加一笔交易：第二次应复用绝大多数分块，只上传少量新块
    const account = store.ensureDefaultAccount();
    store.createTrade({
      symbol: 'ETH/USDT', side: 'long', size: 2, notional: 200,
      entry_price: 100, exit_price: 105,
      open_time: '2026-10-02T00:00:00.000Z', close_time: '2026-10-02T01:00:00.000Z',
      pnl: 10, fee: -0.1,
    }, { accountId: account.id });
    const second = await backup.runRemoteBackup({ reason: 'inc-2' });
    assert.notEqual(second.name, first.name);
    assert.ok(second.chunks.reused >= 1, `第二次应复用分块（${second.chunks.reused}/${second.chunks.total}）`);
    assert.ok(second.chunks.uploaded < second.chunks.total);
    assert.ok(second.uploadedBytes < first.uploadedBytes);

    // 远端按清单重组后必须与本地快照逐字节一致
    const dl = await backup.downloadRemoteBackup(second.name);
    const local = fs.readFileSync(second.snapshot.file);
    assert.ok(dl.buffer.equals(local));
    assert.equal(backup.sha256Hex(dl.buffer), dl.entry.sha256);
    const staged = await backup.stageRestoreFromRemote(second.name);
    assert.equal(staged.sha256.length, 64);
    backup.cancelPendingRestore();

    // keep=1：旧快照被裁掉；剩余快照引用的分块必须都还在
    backup.saveBackupConfig({ ...cfg, keep: 1 });
    const third = await backup.runRemoteBackup({ reason: 'inc-3' });
    const listed = await backup.listRemoteBackups();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, third.name);
    const dirPath = new URL(listed.dir).pathname;
    for (const c of listed.files[0].chunks) {
      assert.ok(dav.files.has(`${dirPath}/chunks/${c.f}`), `分块 ${c.f.slice(0, 8)} 应仍在远端`);
    }
  } finally {
    await new Promise((resolve) => dav.server.close(resolve));
  }
});

test('增量备份：更换备份密码后，新快照可恢复、旧快照明确报错', async () => {
  const dav = await startFakeDav();
  try {
    const cfg = {
      webdavEnabled: true,
      webdavUrl: `http://127.0.0.1:${dav.port}/dav`,
      webdavUsername: 'u',
      webdavPassword: 'p',
      webdavDir: 'TradeLedger',
      intervalHours: 6,
      keep: 5,
      backupMode: 'incremental',
      passphrase: 'old-pass-123',
      localEnabled: true,
      localIntervalHours: 24,
      localKeep: 10,
    };
    backup.saveBackupConfig(cfg);
    const first = await backup.runRemoteBackup({ reason: 'rot-1' });
    assert.equal(first.encrypted, true);

    // 换密码后再备份：分块必须按新密码重新加密上传，不能复用旧密文
    backup.saveBackupConfig({ ...cfg, passphrase: 'new-pass-456' });
    const second = await backup.runRemoteBackup({ reason: 'rot-2' });
    assert.equal(second.chunks.uploaded, second.chunks.total);
    assert.equal(second.chunks.reused, 0);

    const dl2 = await backup.downloadRemoteBackup(second.name);
    assert.ok(dl2.buffer.equals(fs.readFileSync(second.snapshot.file)));

    // 旧快照是旧密码加密的：新密码下给出明确提示，而不是解密崩溃
    await assert.rejects(
      () => backup.downloadRemoteBackup(first.name),
      /旧的备份密码/,
    );
  } finally {
    await new Promise((resolve) => dav.server.close(resolve));
  }
});

test('恢复：暂存后重启替换数据库，并保留 pre-restore 副本', () => {
  const snap = backup.createLocalSnapshot('restore-test');
  store.setMeta('restore_probe', 'after');
  backup.stageRestoreFromLocal(snap.name);
  closeDb();

  const result = applyPendingRestore();
  assert.equal(result.ok, true);
  assert.equal(store.getMeta('restore_probe', null), null);

  const pre = new DatabaseSync(result.preRestore, { readOnly: true });
  try {
    assert.equal(pre.prepare("SELECT value FROM meta WHERE key = 'restore_probe'").get().value, 'after');
  } finally {
    pre.close();
  }
});

test.after(() => {
  try { closeDb(); } catch { /* 忽略 */ }
  fs.rmSync(root, { recursive: true, force: true });
});
