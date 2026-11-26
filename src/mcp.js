/**
 * MCP 工具目录与 JSON-RPC 分发（服务端实现）。
 *
 * 同时服务于：
 * - `POST /mcp`（Streamable HTTP，无状态）：Agent 直接连服务器，不依赖本机脚本；
 * - `scripts/mcp-server.mjs`（stdio）：只是把消息转发到 /mcp，方便只支持 stdio 的客户端。
 *
 * 工具执行通过注入的 `callApi(method, path, body)` 完成，HTTP 端点内部会走
 * `/api/v1`（复用鉴权、scope、审计与校验），避免两套逻辑漂移。
 */

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

export const MCP_TOOLS = [
  {
    name: 'trades_search',
    description: '查询交易列表（支持账户、市场、方向、盈亏、币种、标签、日期、关键词、分页）。返回 {count, trades}。',
    inputSchema: { type: 'object', properties: TRADE_SEARCH_PROPS, additionalProperties: false },
    run: (args, callApi) => callApi('GET', `/api/v1/trades${queryString(args, Object.keys(TRADE_SEARCH_PROPS))}`),
  },
  {
    name: 'trade_get',
    description: '读取单笔交易详情，含标签与已持久化的逐笔成交（最多 500 条，fills_total 为真实总数）。',
    inputSchema: TRADE_ID,
    run: (args, callApi) => callApi('GET', `/api/v1/trades/${encodeURIComponent(args.id)}`),
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
    run: (args, callApi) => callApi('GET', `/api/v1/summary${queryString(args, ['accountId', 'market', 'from', 'to'])}`),
  },
  {
    name: 'positions_list',
    description: '实时持仓列表，含标记价与未实现盈亏。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, callApi) => callApi('GET', '/api/v1/positions'),
  },
  {
    name: 'accounts_list',
    description: '账户列表（不含任何密钥），含最近同步状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, callApi) => callApi('GET', '/api/v1/accounts'),
  },
  {
    name: 'tags_list',
    description: '标签列表及使用次数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, callApi) => callApi('GET', '/api/v1/tags'),
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
    run: (args, callApi) => callApi('GET', `/api/v1/notes${queryString(args, ['category', 'subject', 'q', 'accountId', 'limit'])}`),
  },
  {
    name: 'missed_trades_list',
    description: '错过机会记录（观察中/方向对/方向错/过期）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      additionalProperties: false,
    },
    run: (args, callApi) => callApi('GET', `/api/v1/missed${queryString(args, ['limit'])}`),
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
    run: (args, callApi) => callApi('PATCH', `/api/v1/trades/${encodeURIComponent(args.id)}`, { note: args.note }),
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
    run: (args, callApi) => callApi('PATCH', `/api/v1/trades/${encodeURIComponent(args.id)}`, { tags: args.tags }),
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
    run: (args, callApi) => callApi('POST', `/api/v1/trades/${encodeURIComponent(args.id)}/tags/toggle`, { tag: args.tag }),
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
    run: (args, callApi) => callApi('POST', '/api/v1/positions/note', {
      accountId: args.accountId,
      symbol: args.symbol,
      side: args.side || 'long',
      note: args.note,
    }),
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 处理单条 JSON-RPC 消息。
 * 返回响应对象；通知（无 id）返回 null。
 * `callApi(method, path, body)` 由调用方注入（HTTP 端点走内部 /api/v1）。
 */
export async function dispatchMcp(message, callApi, { version = '0' } = {}) {
  const { id, method, params } = message || {};
  const hasId = id !== undefined && id !== null;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(hasId ? id : null, -32600, '无效的 JSON-RPC 请求');
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tradeledger', version },
      instructions: 'TradeLedger 台账：查询交易/统计/持仓，写复盘与标签。读取用 trades_search / trade_get / ledger_summary；写入用 trade_note_set / trade_tags_set。',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, {
      tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
    try {
      const data = await tool.run(params?.arguments || {}, callApi);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: `调用失败：${err?.message || err}` }],
        isError: true,
      });
    }
  }
  if (!hasId) return null;
  return rpcError(id, -32601, `不支持的方法：${method}`);
}
