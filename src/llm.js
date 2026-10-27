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

