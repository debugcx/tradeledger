#!/usr/bin/env node
/**
 * TradeLedger MCP 桥接（stdio，JSON-RPC 2.0，换行分隔）。
 *
 * 把 TradeLedger 的 /api/v1 包装成 MCP 工具，供 Claude Desktop / ZCode 等
 * MCP 客户端调用。零第三方依赖，Node ≥ 24。
 *
 * 环境变量：
 *   TRADELEDGER_BASE_URL     例如 http://10.126.126.50:8790 或 https://ledger.example.com
 *   TRADELEDGER_API_TOKEN    在 TradeLedger「设置 → Agent 接入」创建
 *   TRADELEDGER_MCP_TIMEOUT_MS  可选，单次 HTTP 超时，默认 60000
 *
 * 注意：stdout 只输出 MCP 协议消息；诊断信息全部走 stderr，避免污染协议。
 */

import fs from 'node:fs';
import readline from 'node:readline';

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0';
  } catch {
    return '0';
  }
})();

const BASE = String(process.env.TRADELEDGER_BASE_URL || '').trim().replace(/\/+$/, '');
const TOKEN = String(process.env.TRADELEDGER_API_TOKEN || '').trim();
const TIMEOUT_MS = Math.max(1000, Number(process.env.TRADELEDGER_MCP_TIMEOUT_MS) || 60_000);
const PROTOCOL_VERSION = '2024-11-05';

const log = (...args) => console.error('[tradeledger-mcp]', ...args);

/* ---------------- REST 调用 ---------------- */

function queryString(args = {}, keys = []) {
  const q = new URLSearchParams();
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (value === 'all') continue;
    q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : '';
}

async function api(method, path, body) {
  if (!BASE) throw new Error('缺少环境变量 TRADELEDGER_BASE_URL');
  if (!TOKEN) throw new Error('缺少环境变量 TRADELEDGER_API_TOKEN（在 TradeLedger 设置页创建）');
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`无法连接 ${BASE}（${err?.cause?.code || err?.name || err?.message || '网络错误'}）`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const message = data?.error?.message || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  if (data === null) throw new Error('服务端返回的不是 JSON');
  return data;
}

/* ---------------- 工具定义 ---------------- */

const TRADE_SEARCH_PROPS = {
  accountId: { type: 'integer', description: '账户 ID（可选）' },
  market: { type: 'string', enum: ['all', 'futures', 'spot'], description: '市场，默认 all' },
  side: { type: 'string', enum: ['all', 'long', 'short'], description: '方向' },
  result: { type: 'string', enum: ['all', 'win', 'lose'], description: '盈亏结果' },
  symbol: { type: 'string', description: '交易对，例如 BTC/USDT' },
  orderType: { type: 'string', enum: ['all', 'market', 'limit', 'mixed', 'other'], description: '委托类型' },
  tag: { type: 'string', description: '标签名' },
  note: { type: 'string', enum: ['all', 'yes', 'no'], description: '是否有备注' },
  from: { type: 'string', description: '本地日期下限 YYYY-MM-DD' },
  to: { type: 'string', description: '本地日期上限 YYYY-MM-DD' },
  q: { type: 'string', description: '关键词（币种/备注/标签）' },
  sort: { type: 'string', enum: ['time', 'timeAsc', 'pnl', 'duration', 'size'], description: '排序，默认 time' },
  limit: { type: 'integer', minimum: 1, maximum: 200, description: '每页条数，默认 50' },
  offset: { type: 'integer', minimum: 0, description: '偏移' },
};

const TRADE_ID = {
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1, description: '交易 ID' } },
  required: ['id'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'trades_search',
    description: '查询交易列表（支持账户、市场、方向、盈亏、币种、标签、日期、关键词、分页）。返回 {count, trades}。',
    inputSchema: { type: 'object', properties: TRADE_SEARCH_PROPS, additionalProperties: false },
    run: (args) => api('GET', `/api/v1/trades${queryString(args, Object.keys(TRADE_SEARCH_PROPS))}`),
  },
  {
    name: 'trade_get',
    description: '读取单笔交易详情，含标签与已持久化的逐笔成交（最多 500 条，fills_total 为真实总数）。',
    inputSchema: TRADE_ID,
    run: (args) => api('GET', `/api/v1/trades/${encodeURIComponent(args.id)}`),
  },
  {
    name: 'ledger_summary',
    description: '汇总统计：胜率、盈亏、盈亏比、最大回撤、优势分、多空拆分、资金费/手续费、按币种与标签汇总、每日曲线。可按账户/市场/日期过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'integer', description: '账户 ID（可选）' },
        market: { type: 'string', enum: ['all', 'futures', 'spot'] },
        from: { type: 'string', description: '本地日期下限 YYYY-MM-DD' },
        to: { type: 'string', description: '本地日期上限 YYYY-MM-DD' },
      },
      additionalProperties: false,
    },
    run: (args) => api('GET', `/api/v1/summary${queryString(args, ['accountId', 'market', 'from', 'to'])}`),
  },
  {
    name: 'positions_list',
    description: '实时持仓列表，含标记价与未实现盈亏。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/v1/positions'),
  },
  {
    name: 'accounts_list',
    description: '账户列表（不含任何密钥），含最近同步状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/v1/accounts'),
  },
  {
    name: 'tags_list',
    description: '标签列表及使用次数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/v1/tags'),
  },
  {
    name: 'notes_search',
    description: '查询独立笔记（周期复盘、交易对档案、策略、AI 报告等）。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['general', 'periodic', 'symbol', 'strategy', 'spot', 'ai-report'] },
        subject: { type: 'string', description: '主题，例如 BTC/USDT 或 2026-W48' },
        q: { type: 'string', description: '标题/正文关键词' },
        accountId: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 50' },
      },
      additionalProperties: false,
    },
    run: (args) => api('GET', `/api/v1/notes${queryString(args, ['category', 'subject', 'q', 'accountId', 'limit'])}`),
  },
  {
    name: 'missed_trades_list',
    description: '错过机会记录（观察中/方向对/方向错/过期）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      additionalProperties: false,
    },
    run: (args) => api('GET', `/api/v1/missed${queryString(args, ['limit'])}`),
  },
  {
    name: 'trade_note_set',
    description: '写入/覆盖一笔交易的复盘备注（传空字符串可清空）。需要读写 Token。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        note: { type: 'string', description: 'Markdown 备注，最长 100000 字' },
      },
      required: ['id', 'note'],
      additionalProperties: false,
    },
    run: (args) => api('PATCH', `/api/v1/trades/${encodeURIComponent(args.id)}`, { note: args.note }),
  },
  {
    name: 'trade_tags_set',
    description: '替换一笔交易的全部标签（传空数组清空）。最多 20 个，每个 ≤40 字。需要读写 Token。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      },
      required: ['id', 'tags'],
      additionalProperties: false,
    },
    run: (args) => api('PATCH', `/api/v1/trades/${encodeURIComponent(args.id)}`, { tags: args.tags }),
  },
  {
    name: 'trade_tag_toggle',
    description: '给一笔交易添加或移除一个标签（同名已存在则移除）。需要读写 Token。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        tag: { type: 'string', maxLength: 40 },
      },
      required: ['id', 'tag'],
      additionalProperties: false,
    },
    run: (args) => api('POST', `/api/v1/trades/${encodeURIComponent(args.id)}/tags/toggle`, { tag: args.tag }),
  },
  {
    name: 'position_note_set',
    description: '给当前持仓写挂起笔记；平仓后会自动归档进对应交易记录。需要读写 Token。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'integer', minimum: 1 },
        symbol: { type: 'string', description: '例如 BTC/USDC' },
        side: { type: 'string', enum: ['long', 'short'] },
        note: { type: 'string', description: '最长 2000 字；空字符串删除' },
      },
      required: ['accountId', 'symbol', 'note'],
      additionalProperties: false,
    },
    run: (args) => api('POST', '/api/v1/positions/note', {
      accountId: args.accountId,
      symbol: args.symbol,
      side: args.side || 'long',
      note: args.note,
    }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------------- JSON-RPC ---------------- */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(message) {
  const { id, method, params } = message || {};
  const hasId = id !== undefined && id !== null;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tradeledger', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
    try {
      const data = await tool.run(params?.arguments || {});
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `调用失败：${err?.message || err}` }],
        isError: true,
      });
    }
  }
  if (!hasId) return undefined; // 未知通知：静默忽略
  return rpcError(id, -32601, `不支持的方法：${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();

rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    rpcError(null, -32700, 'JSON 解析失败');
    return;
  }
  chain = chain
    .then(() => dispatch(message))
    .catch((err) => {
      log('unhandled', err);
      if (message && message.id !== undefined) rpcError(message.id, -32603, err?.message || '内部错误');
    });
});

rl.on('close', () => {
  // 不用 process.exit：Windows 下与尚未关闭的 stdio 句柄竞争会触发 libuv 断言。
  // 让事件循环自然退出即可（stdin 已结束，没有其他定时器）。
  chain.finally(() => { process.exitCode = 0; });
});

log(`ready · base=${BASE || '(未设置)'} · token=${TOKEN ? '已设置' : '(未设置)'} · timeout=${TIMEOUT_MS}ms`);
