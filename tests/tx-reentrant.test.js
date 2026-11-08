import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { openDb, setDb, closeDb, tx, run, get } = await import('../src/db.js');
setDb(openDb(':memory:'));

test('tx 基础：提交与回滚', () => {
  run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  tx(() => run("INSERT INTO t (v) VALUES ('a')"));
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='a'").n, 1);

  assert.throws(() => tx(() => {
    run("INSERT INTO t (v) VALUES ('b')");
    throw new Error('boom');
  }), /boom/);
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='b'").n, 0, '回滚后不应有 b');

  // 回滚后事务可以正常开启
  tx(() => run("INSERT INTO t (v) VALUES ('c')"));
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='c'").n, 1);
});

test('tx 重入：嵌套调用并入外层事务，不再抛错', () => {
  const inner = () => tx(() => run("INSERT INTO t (v) VALUES ('inner')"));
  tx(() => { inner(); });
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='inner'").n, 1);
});

test('tx 重入：内层抛错向上传播，整体回滚', () => {
  assert.throws(() => tx(() => {
    run("INSERT INTO t (v) VALUES ('outer1')");
    tx(() => {
      run("INSERT INTO t (v) VALUES ('inner2')");
      throw new Error('inner-boom');
    });
  }), /inner-boom/);
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='outer1'").n, 0);
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v='inner2'").n, 0);
});

test('tx 重入：两层嵌套正常提交', () => {
  tx(() => {
    run("INSERT INTO t (v) VALUES ('l1')");
    tx(() => {
      run("INSERT INTO t (v) VALUES ('l2')");
      tx(() => run("INSERT INTO t (v) VALUES ('l3')"));
    });
  });
  assert.equal(get("SELECT COUNT(*) AS n FROM t WHERE v IN ('l1','l2','l3')").n, 3);
});

test.after(() => closeDb());
