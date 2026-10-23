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
import { buildWeeklyReview, reviewMarkdown, weekRange, isoWeekOf } from './review.js';
import { analyze } from './stats.js';

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

/* ---------------- 复盘上下文 ---------------- */

const trim = (s, n) => String(s || '').slice(0, n);

function scopeRange(scope, trades, week) {
  if (scope === 'week') {
    const wk = week || isoWeekOf();
    const range = weekRange(wk);
    return { from: range.from.getTime(), to: range.to.getTime(), label: `${wk.year}-W${String(wk.week).padStart(2, '0')}` };
  }
  if (scope === 'all') {
    const times = (trades || []).map((t) => Date.parse(t.close_time)).filter(Number.isFinite);
    return { from: times.length ? Math.min(...times) : Date.now(), to: Date.now(), label: '全部历史' };
  }
  return { from: Date.now() - 14 * 86400_000, to: Date.now(), label: '最近 14 天' };
}

export function buildAiContext({ trades = [], notes = [], week = null, scope = 'week', includeNotes = true, instruction = '' }) {
  const range = scopeRange(scope, trades, week);
  const filtered = trades.filter((t) => {
    const ms = Date.parse(t.close_time);
    return Number.isFinite(ms) && ms >= range.from && ms <= range.to;
  });

  let context;
  if (scope === 'week') {
    const review = buildWeeklyReview(trades, week || isoWeekOf());
    context = reviewMarkdown(review);
  } else {
    const s = analyze(filtered);
    const slots = s.hourWeekday.flat().filter((c) => c.trades >= 2);
    const worstSlots = [...slots].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
    const bestSlots = [...slots].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    const tags = s.tagStats.filter((t) => t.count >= 3);
    const worstTags = [...tags].sort((a, b) => a.expectancy - b.expectancy).slice(0, 5);
    const bestTags = [...tags].sort((a, b) => b.expectancy - a.expectancy).slice(0, 5);
    const worstSymbols = [...s.symbols].filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5);
    const bestSymbols = [...s.symbols].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    const lines = [
      `# 交易复盘上下文（${range.label}）`,
      '',
      `区间：${new Date(range.from).toISOString().slice(0, 10)} → ${new Date(range.to).toISOString().slice(0, 10)}`,
      `交易 ${s.total} 笔，净盈亏 ${s.totalPnl.toFixed(2)}，胜率 ${(s.winRate * 100).toFixed(1)}%，交易预期 ${s.expectancy.toFixed(2)}，最大回撤 ${s.drawdown.maxDrawdown.toFixed(2)}，最大连亏 ${s.maxConsecutiveLoss} 笔。`,
      '',
      '## 最差时段',
      ...(worstSlots.length ? worstSlots.map((c) => `- ${c.weekdayLabel} ${String(c.hour).padStart(2, '0')}:00：${c.pnl.toFixed(2)}，${c.trades} 笔，胜率 ${(c.winRate * 100).toFixed(0)}%`) : ['- 样本不足']),
      '',
      '## 最好时段',
      ...(bestSlots.length ? bestSlots.map((c) => `- ${c.weekdayLabel} ${String(c.hour).padStart(2, '0')}:00：${c.pnl.toFixed(2)}，${c.trades} 笔，胜率 ${(c.winRate * 100).toFixed(0)}%`) : ['- 样本不足']),
      '',
      '## 交易预期最差的标签',
      ...(worstTags.length ? worstTags.map((t) => `- ${t.tag}：预期 ${t.expectancy.toFixed(2)}，${t.count} 笔，总盈亏 ${t.pnl.toFixed(2)}`) : ['- 样本不足']),
      '',
      '## 交易预期最好的标签',
      ...(bestTags.length ? bestTags.map((t) => `- ${t.tag}：预期 ${t.expectancy.toFixed(2)}，${t.count} 笔，总盈亏 ${t.pnl.toFixed(2)}`) : ['- 样本不足']),
      '',
      '## 最亏的币种',
      ...(worstSymbols.length ? worstSymbols.map((x) => `- ${x.symbol}：${x.pnl.toFixed(2)}，${x.count} 笔`) : ['- 无']),
      '',
      '## 最赚的币种',
      ...(bestSymbols.length ? bestSymbols.map((x) => `- ${x.symbol}：${x.pnl.toFixed(2)}，${x.count} 笔`) : ['- 无']),
    ];
    context = lines.join('\n');
  }

  if (includeNotes) {
    const standalone = (notes || []).slice(0, 10);
    if (standalone.length) {
      context += '\n\n# 我的独立笔记\n\n';
      context += standalone.map((n) => `## ${n.title}（${String(n.updated_at).slice(0, 10)}）\n${trim(n.content, 1500)}`).join('\n\n');
    }
    const tradeNotes = filtered
      .filter((t) => t.note && String(t.note).trim())
      .sort((a, b) => String(b.note_updated_at || b.close_time).localeCompare(String(a.note_updated_at || a.close_time)))
      .slice(0, 10);
    if (tradeNotes.length) {
      context += '\n\n# 交易复盘笔记\n\n';
      context += tradeNotes.map((t) => `## ${t.symbol}（${String(t.close_time).slice(0, 10)}，${Number(t.pnl).toFixed(2)}）\n${trim(t.note, 500)}`).join('\n\n');
    }
  }

  const system = '你是一名纪律导向的加密货币交易教练。只基于用户提供的复盘数据与笔记作答，' 
    + '不要编造不存在的交易、指标或新闻。结论要引用具体时段、标签、币种或笔记内容；' 
    + '如果样本不足，要明确说明。输出使用 Markdown，先给 3 条最重要的结论，再给下周可执行的规则。';
  const ask = instruction.trim() || '请基于以上数据生成一份复盘：1 个最需要停止的行为、1 个最值得放大的优势，以及下周可执行的 3 条规则。';
  const user = `${context}\n\n# 我的要求\n\n${ask}`;

  return {
    system,
    user: user.slice(0, 40_000),
    label: range.label,
    tradeCount: filtered.length,
    truncated: user.length > 40_000,
  };
}
