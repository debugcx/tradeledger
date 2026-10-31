/**
 * LLM 接入（OpenAI 兼容 / Anthropic / Ollama）。
 *
 * - 配置存 meta 表；API Key 用 AES-256-GCM 加密；
 * - 只发送用户主动选择的复盘上下文与笔记，不发送交易凭据；
 * - 应用不内置任何模型额度，使用你自己的 Key / 本地 Ollama。
 */

import { requestJson } from './http-client.js';
import * as store from './store.js';
import { encryptSecret, decryptSecret, hintKey } from './crypto.js';

export const LLM_PRESETS = [
  { id: 'openai', label: 'OpenAI / 兼容接口', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', provider: 'openai' },
  { id: 'deepseek', label: 'DeepSeek（OpenAI 兼容）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', provider: 'openai' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', provider: 'anthropic' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', provider: 'ollama' },
  { id: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '', model: '', provider: 'openai' },
];

export function getLlmConfig({ withSecret = false } = {}) {
  const provider = store.getMeta('llm_provider', 'openai');
  const baseUrl = store.getMeta('llm_base_url', 'https://api.openai.com/v1');
  const model = store.getMeta('llm_model', 'gpt-4o-mini');
  const temperature = Number(store.getMeta('llm_temperature', '0.4'));
  const maxTokens = Number(store.getMeta('llm_max_tokens', '2000'));
  const systemPrompt = store.getMeta('llm_system_prompt', '');
  const keyEnc = store.getMeta('llm_api_key_enc', '');
  const config = {
    provider,
    baseUrl,
    model,
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.4,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(32000, Math.max(200, maxTokens)) : 2000,
    systemPrompt,
    hasKey: Boolean(keyEnc),
    keyHint: store.getMeta('llm_api_key_hint', ''),
  };
  if (withSecret) {
    config.apiKey = keyEnc ? decryptSecret(keyEnc) : '';
  }
  return config;
}

export function saveLlmConfig(input = {}) {
  if (input.provider) store.setMeta('llm_provider', String(input.provider).slice(0, 20));
  if (input.baseUrl !== undefined) store.setMeta('llm_base_url', String(input.baseUrl).trim().slice(0, 300));
  if (input.model !== undefined) store.setMeta('llm_model', String(input.model).trim().slice(0, 120));
  if (input.temperature !== undefined) store.setMeta('llm_temperature', String(Number(input.temperature) || 0));
  if (input.maxTokens !== undefined) store.setMeta('llm_max_tokens', String(Math.max(200, Number(input.maxTokens) || 2000)));
  if (input.systemPrompt !== undefined) store.setMeta('llm_system_prompt', String(input.systemPrompt).slice(0, 4000));
  if (input.apiKey) {
    store.setMeta('llm_api_key_enc', encryptSecret(input.apiKey));
    store.setMeta('llm_api_key_hint', hintKey(input.apiKey));
  }
  if (input.clearKey) {
    store.setMeta('llm_api_key_enc', '');
    store.setMeta('llm_api_key_hint', '');
  }
  return getLlmConfig();
}

function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 API Base URL');
  return `${base}${suffix}`;
}

export async function callLlm({ messages, config = null, timeout = 90_000 } = {}) {
  const cfg = config || getLlmConfig({ withSecret: true });
  if (!cfg.model) throw new Error('请先配置模型名称');
  const provider = cfg.provider === 'anthropic' ? 'anthropic' : cfg.provider === 'ollama' ? 'ollama' : 'openai';
  const system = (messages.find((m) => m.role === 'system')?.content) || cfg.systemPrompt || '';
  const userMessages = messages.filter((m) => m.role !== 'system');

  if (provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('请先填写 Anthropic API Key');
    const res = await requestJson(endpoint(cfg.baseUrl, '/v1/messages'), {
      method: 'POST',
      timeout,
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        system,
        messages: userMessages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
    });
    const blocks = res.json?.content;
    const text = Array.isArray(blocks) ? blocks.map((b) => b.text || '').join('') : '';
    if (!text) throw new Error('Anthropic 没有返回文本');
    return text;
  }

  if (provider === 'ollama') {
    const res = await requestJson(endpoint(cfg.baseUrl, '/api/chat'), {
      method: 'POST',
      timeout,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [{ role: 'system', content: system }, ...userMessages],
        options: { temperature: cfg.temperature, num_predict: cfg.maxTokens },
      }),
    });
    const text = res.json?.message?.content;
    if (!text) throw new Error('Ollama 没有返回文本');
    return text;
  }

  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, ...userMessages],
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };
  const res = await requestJson(endpoint(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    timeout,
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = res.json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('模型没有返回文本');
  return text;
}


/**
 * 单笔交易的 AI 复盘提示词（纯函数）：只喂这一笔交易的数据（可附带持仓期行情摘要），避免模型编造。
 */
export function buildTradeReviewPrompt(trade, { breakdown = null, fills = [], market = null } = {}) {
  const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
  const durMs = Date.parse(trade.close_time || '') - Date.parse(trade.open_time || '');
  const durH = Number.isFinite(durMs) ? (durMs / 3600_000).toFixed(2) : '—';
  const side = trade.side === 'short' ? '做空' : '做多';
  const orderLabel = { market: '市价（吃单）', limit: '限价（挂单）', mixed: '混合（吃挂均有）', other: '未知' }[trade.order_type || 'other'] || '未知';
  const lines = [
    '你是纪律导向的加密货币交易教练。只根据下面这一笔交易的记录复盘，不要编造行情、新闻或未给出的数据；信息不足就直说。',
    '',
    '# 交易记录',
    `- 币种：${trade.symbol}　方向：${side}　市场：${trade.market === 'spot' ? '现货' : '合约'}`,
    `- 开仓 → 平仓：${trade.open_time || '—'} → ${trade.close_time || '—'}（持仓 ${durH} 小时）`,
    `- 开仓价 ${fmt(trade.entry_price, 6)} → 平仓价 ${fmt(trade.exit_price, 6)}　数量 ${fmt(trade.size, 6)}　名义价值 ${fmt(trade.notional)} USDT`,
    `- 净盈亏 ${fmt(trade.pnl)} USDT　手续费 ${fmt(trade.fee, 4)}　资金费 ${fmt(trade.funding, 4)}　订单类型：${orderLabel}`,
    `- 账户：${trade.account_name || '—'}（${trade.account_exchange || '—'}）　数据来源：${trade.source === 'api' ? '交易所同步' : trade.source === 'csv' ? 'CSV 导入' : trade.source === 'manual' ? '手动记录' : trade.source || '—'}`,
  ];
  if (Array.isArray(trade.tags) && trade.tags.length) lines.push(`- 标签：${trade.tags.join('、')}`);
  if (breakdown) {
    if (breakdown.pricePnl === null) {
      lines.push(`- 盈亏构成：毛盈亏 ${fmt(breakdown.gross)} USDT（缺少开平仓价/数量，无法按价格复算）`);
    } else {
      lines.push(`- 盈亏构成：毛盈亏 ${fmt(breakdown.gross)} USDT，按开平仓价复算 ${fmt(breakdown.pricePnl)} USDT（${breakdown.priceMatch ? '一致' : '不一致，可能含合约面值/分批成交因素'}）`);
    }
  }
  if (Array.isArray(fills) && fills.length) {
    const isMaker = (f) => f.orderType === 'limit' || f.execType === 'M';
    const isTaker = (f) => f.orderType === 'market' || f.execType === 'T';
    const maker = fills.filter(isMaker).length;
    const taker = fills.filter(isTaker).length;
    lines.push(`- 成交明细：共 ${fills.length} 笔${maker || taker ? `（挂单 ${maker} 笔 / 吃单 ${taker} 笔）` : ''}`);
  }
  if (market && Array.isArray(market.path) && market.path.length) {
    const p = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
    const durH2 = market.spanMs ? (market.spanMs / 3600_000).toFixed(1) : durH;
    lines.push(
      '',
      `# 持有期行情（交易所 K 线，周期 ${market.bar || '—'}，共 ${market.count} 根，约 ${durH2} 小时）`,
      `- 区间最高 ${fmt(market.high, 6)} / 最低 ${fmt(market.low, 6)}，振幅 ${Number(market.rangePct).toFixed(2)}%`,
      `- 按${side}方向折算：最大浮盈 ${p(market.favorPct)}，最大浮亏 ${p(-market.adversePct)}，平仓时 ${p(market.exitPct)}`,
      `- 价格路径（按持仓时间分段，相对开仓价）：${market.path.map((x) => p(x.pct)).join(' → ')}`,
      '- 说明：这是持仓期间真实发生的价格路径，用来评估择时与止盈/止损执行，不要臆测路径之外的信息。',
    );
  }
  if (trade.note && String(trade.note).trim()) {
    lines.push('', '# 用户已有的笔记（可作为背景，不必复述）', String(trade.note).slice(0, 1500));
  }
  const reqs = [
    '1. **一句话结论**：这笔交易整体执行如何',
    '2. **执行质量**：入场 / 加减仓 / 离场 各一句评价（结合持仓时长与成交笔数判断）',
    '3. **风险与仓位**：这笔交易承担的风险与结果是否匹配',
  ];
  if (market && market.favorPct !== undefined) {
    reqs.push(`${reqs.length + 1}. **离场时机**：结合持有期行情的最大浮盈/浮亏与价格路径，判断止盈、止损或扛单是否合理`);
  }
  reqs.push(
    `${reqs.length + 1}. **最值得保留的一点** + **最该改掉的一点**`,
    `${reqs.length + 2}. **下次同类交易的 2–3 条具体规则**`,
    '不要输出与这笔交易无关的泛泛建议；不要在结尾邀请用户继续提问。',
  );
  lines.push(
    '',
    '# 输出要求（Markdown，中文，400 字以内，直接给结论，不要客套）',
    ...reqs,
  );
  return lines.join('\n');
}
