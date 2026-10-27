import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

const { requestJson, setExchangeProxyProvider } = await import('../src/http-client.js?socks-test');

// 迷你 SOCKS5 服务器：支持无认证与用户密码认证；
// 收到 CONNECT 后假装连接成功，回写 goodServer 的响应（不真的连目标域名）
let authMode = 'none'; // 'none' | 'password'
let socksConnects = 0;
const socksServer = net.createServer((socket) => {
  let stage = 'greet';
  let buf = Buffer.alloc(0);
  let repliedConnect = false;
  const good = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 26\r\n\r\n{"ok":true,"via":"socks5"}';
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 'greet') {
      if (buf.length < 2) return;
      assert.equal(buf[0], 5);
      const wantPassword = authMode === 'password';
      const choose = wantPassword ? 2 : 0;
      if (buf.length < 2 + buf[1]) return; // 方法列表未收全
      if (wantPassword && !buf.subarray(2, 2 + buf[1]).includes(2)) {
        // 客户端没提供密码认证：按协议回「无可接受方法」，让用例自然失败
        socket.end(Buffer.from([5, 255]));
        return;
      }
      socket.write(Buffer.from([5, choose]));
      buf = Buffer.alloc(0);
      stage = choose === 2 ? 'auth' : 'target';
      return;
    }
    if (stage === 'auth') {
      if (buf.length < 2) return;
      const ulen = buf[1];
      const user = buf.subarray(2, 2 + ulen).toString();
      const plen = buf[2 + ulen];
      const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
      if (user !== 'socksuser' || pass !== 'sockspass') {
        socket.write(Buffer.from([1, 1])); // 认证失败
        socket.end();
        return;
      }
      socket.write(Buffer.from([1, 0]));
      buf = Buffer.alloc(0);
      stage = 'target';
      return;
    }
    if (stage === 'target') {
      if (!repliedConnect) {
        if (buf.length < 5) return;
        assert.equal(buf[0], 5);
        assert.equal(buf[1], 1); // CONNECT
        socksConnects++;
        repliedConnect = true;
        // 回复成功（bind 0.0.0.0:0）；HTTP 响应等收到客户端请求后再回
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        buf = Buffer.alloc(0);
        return;
      }
      socket.write(good);
      socket.end(); // 客户端带 Connection: close
      buf = Buffer.alloc(0);
    }
  });
});
socksServer.on('error', (e) => console.error('MOCK server error:', e.code || e.message));
await new Promise((r) => socksServer.listen(0, '127.0.0.1', r));

// 「直连源站」：总是返回地区封锁页
const direct = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: 0, msg: 'Service unavailable from a restricted location' }));
});
await new Promise((r) => direct.listen(0, '127.0.0.1', r));

const socksPort = socksServer.address().port;
const directPort = direct.address().port;

test('SOCKS5 代理（无认证）：强制分流生效', async () => {
  authMode = 'none';
  process.env.EXCHANGE_PROXY = `socks5://127.0.0.1:${socksPort}`;
  process.env.EXCHANGE_PROXY_HOSTS = 'blocked-exchange.test';
  const res = await requestJson(`http://blocked-exchange.test:${directPort}/api/v1/ping`);
  assert.equal(res.json.via, 'socks5');
  assert.ok(socksConnects >= 1);
});

test('SOCKS5 代理（账号密码）：认证通过', async () => {
  authMode = 'password';
  socksConnects = 0;
  process.env.EXCHANGE_PROXY = `socks5://socksuser:sockspass@127.0.0.1:${socksPort}`;
  delete process.env.EXCHANGE_PROXY_HOSTS; // 不强制 → 直连封锁页 → 自适应回退走 socks5
  const res = await requestJson(`http://blocked-exchange.test:${directPort}/api/v1/ping`);
  assert.equal(res.json.via, 'socks5');
  assert.equal(socksConnects, 1);
});

test('SOCKS5 密码错误：给出明确错误', async () => {
  authMode = 'password';
  process.env.EXCHANGE_PROXY = `socks5://socksuser:wrongpass@127.0.0.1:${socksPort}`;
  process.env.EXCHANGE_PROXY_HOSTS = 'blocked-exchange.test';
  await assert.rejects(
    () => requestJson(`http://blocked-exchange.test:${directPort}/ping`),
    /SOCKS5 账号或密码错误/,
  );
});

test('运行时 provider（设置页代理）：不依赖 env 即可生效', async () => {
  authMode = 'none';
  socksConnects = 0;
  delete process.env.EXCHANGE_PROXY;
  delete process.env.EXCHANGE_PROXY_HOSTS;
  // 设置页保存的代理经 store 注册的 provider 注入，requestRaw 必须消费它
  setExchangeProxyProvider(() => ({ proxy: `socks5://127.0.0.1:${socksPort}`, hosts: 'blocked-exchange.test' }));
  try {
    const res = await requestJson(`http://blocked-exchange.test:${directPort}/api/v1/ping`);
    assert.equal(res.json.via, 'socks5');
    assert.equal(socksConnects, 1);
  } finally {
    setExchangeProxyProvider(null);
  }
});

test.after(() => {
  socksServer.close();
  direct.close();
  delete process.env.EXCHANGE_PROXY;
  delete process.env.EXCHANGE_PROXY_HOSTS;
});
