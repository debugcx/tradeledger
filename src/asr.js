/**
 * 语音识别（ASR）：浏览器录音 → 服务端转写。
 *
 * - 默认 MiniMax /v1/speech_to_text，未配置专用 Key 时自动复用「AI 模型」里的 MiniMax Key；
 * - 也支持任意 OpenAI 兼容转写接口（OpenAI whisper、SiliconFlow SenseVoice、Groq…）；
 * - 配置存 meta 表，Key 用 AES-256-GCM 加密；
 * - 音频不上库、不落盘，转写完即丢。
 */

import * as store from './store.js';
import { encryptSecret, decryptSecret, hintKey } from './crypto.js';
import { assertSafeOutboundUrl } from './url-guard.js';

const LLM_ASR_FALLBACK = { provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', model: 'asr-1.0' };

/** 「AI 模型」里配的是 MiniMax 时，它的 Key 可用于语音识别（主接口或降级通道） */
function llmMinimaxKey() {
  if (!/minimax/i.test(store.getMeta('llm_base_url', ''))) return '';
  const enc = store.getMeta('llm_api_key_enc', '');
  return enc ? decryptSecret(enc) : '';
}

export const ASR_PRESETS = [
  { id: 'minimax', label: 'MiniMax（复用 AI 模型的 MiniMax Key）', baseUrl: 'https://api.minimax.cn/v1', model: 'asr-1.0' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow（SenseVoice，有免费额度）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
  { id: 'openai', label: 'OpenAI（whisper-1）', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { id: 'custom', label: '自定义 OpenAI 兼容转写接口', baseUrl: '', model: '' },
];

const PRESET_DEFAULTS = Object.fromEntries(ASR_PRESETS.map((p) => [p.id, p]));

export function getAsrConfig({ withSecret = false } = {}) {
  const provider = store.getMeta('asr_provider', 'minimax');
  const preset = PRESET_DEFAULTS[provider] || PRESET_DEFAULTS.minimax;
  const baseUrl = store.getMeta('asr_base_url', '') || preset.baseUrl;
  const model = store.getMeta('asr_model', '') || preset.model;
  const keyEnc = store.getMeta('asr_api_key_enc', '');
  const llmKey = provider === 'minimax' ? llmMinimaxKey() : '';
  const reusesLlmKey = Boolean(!keyEnc && llmKey);
  const config = {
    provider,
    baseUrl,
    model,
    hasKey: Boolean(keyEnc) || reusesLlmKey,
    hasDedicatedKey: Boolean(keyEnc),
    reusesLlmKey,
    fallbackLlm: store.getMeta('asr_fallback_llm', '1') !== '0',
    history: readHistory(),
    keyHint: store.getMeta('asr_api_key_hint', '') || (reusesLlmKey ? store.getMeta('llm_api_key_hint', '') : ''),
  };
  if (withSecret) {
    config.apiKey = keyEnc ? decryptSecret(keyEnc) : llmKey;
  }
  return config;
}

export function saveAsrConfig(input = {}) {
  if (input.provider) store.setMeta('asr_provider', String(input.provider).slice(0, 20));
  if (input.baseUrl !== undefined) {
    const baseUrl = String(input.baseUrl).trim().slice(0, 300);
    if (baseUrl) assertSafeOutboundUrl(baseUrl, { label: '语音识别接口地址' });
    store.setMeta('asr_base_url', baseUrl);
  }
  if (input.model !== undefined) store.setMeta('asr_model', String(input.model).trim().slice(0, 120));
  if (input.fallbackLlm !== undefined) store.setMeta('asr_fallback_llm', input.fallbackLlm ? '1' : '0');
  if (input.apiKey) {
    store.setMeta('asr_api_key_enc', encryptSecret(input.apiKey));
    store.setMeta('asr_api_key_hint', hintKey(input.apiKey));
  }
  if (input.clearKey) {
    store.setMeta('asr_api_key_enc', '');
    store.setMeta('asr_api_key_hint', '');
  }
  return getAsrConfig();
}

function minimaxFallbackConfig() {
  const key = llmMinimaxKey();
  if (!key) return null;
  return { ...LLM_ASR_FALLBACK, apiKey: key, reusesLlmKey: true, hasDedicatedKey: false };
}

/** 主接口配置 → 不可用时降级到 AI 模型的 MiniMax Key（两者相同则只跑一次） */
function asrAttempts() {
  const primary = getAsrConfig({ withSecret: true });
  const attempts = [{ label: '主接口', config: primary }];
  if (primary.fallbackLlm) {
    const fb = minimaxFallbackConfig();
    const sameAsPrimary = primary.provider === 'minimax' && fb && primary.apiKey === fb.apiKey;
    if (fb && !sameAsPrimary) attempts.push({ label: '降级 MiniMax', config: fb });
  }
  return attempts;
}

function isMinimax(cfg) {
  return cfg.provider === 'minimax' || /minimax\./i.test(cfg.baseUrl || '');
}

function readHistory() {
  try {
    const list = JSON.parse(store.getMeta('asr_history', '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 探测单个配置是否可用：带鉴权发一个空表单，按状态码区分「可用 / Key 错 / 地址错 / 不可达」 */
async function probeAsrConfig(cfg, timeout = 15_000) {
  if (!cfg.baseUrl) return { ok: false, error: '请先填写 Base URL' };
  if (!cfg.apiKey) return { ok: false, error: '没有可用的 API Key（未配置专用 Key，也无法复用 AI 模型的 Key）' };
  const url = (String(cfg.baseUrl).replace(/\/+$/, '')) + (isMinimax(cfg) ? '/speech_to_text' : '/audio/transcriptions');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: new FormData(),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    return { ok: false, error: '无法连接 ' + url + '（' + (err?.cause?.code || err?.name || err?.message || '网络错误') + '）' };
  }
  // 空表单会被服务端以 4xx 拒绝，但 401/403 之外的状态码说明地址和鉴权都通过了
  if (res.status === 401 || res.status === 403) return { ok: false, error: `Key 无效或无权限（HTTP ${res.status}）` };
  if (res.status === 402) return { ok: false, error: 'Key 有效，但账户余额不足（HTTP 402）' };
  if (res.status === 429) return { ok: false, error: 'Key 有效，但被限流或套餐用量已用完（HTTP 429）' };
  if (res.status === 404) return { ok: false, error: `接口不存在（HTTP 404），请检查 Base URL 是否需要带 /v1` };
  if (res.status >= 500) return { ok: false, error: `服务端异常（HTTP ${res.status}），稍后再试` };
  return { ok: true, note: `可用（HTTP ${res.status}，空请求被正常拒绝）` };
}

export async function testAsrConfig(config = null, timeout = 15_000) {
  const cfg = config || getAsrConfig({ withSecret: true });
  return probeAsrConfig(cfg, timeout);
}

/** 同时探测主接口与降级通道，任一可用即视为可用（与真实识别行为一致） */
export async function testAsrAll(timeout = 15_000) {
  const attempts = asrAttempts();
  const results = [];
  for (const attempt of attempts) {
    const r = await probeAsrConfig(attempt.config, timeout);
    results.push({ label: attempt.label, provider: attempt.config.provider, model: attempt.config.model, ...r });
  }
  return { ok: results.some((r) => r.ok), results };
}

/** 转写音频；data 是 Buffer，返回识别文本（静音段可能为空字符串） */
export async function transcribeAudio({ data, filename = 'audio.wav', contentType = 'audio/wav', config = null, timeout = 60_000 }) {
  const cfg = config || getAsrConfig({ withSecret: true });
  if (!cfg.baseUrl) throw new Error('请先在 设置 → AI 模型 里配置语音识别 Base URL');
  if (!cfg.model) throw new Error('请先配置语音识别模型名');
  if (!cfg.apiKey) {
    throw new Error(cfg.reusesLlmKey === false && cfg.provider === 'minimax'
      ? '请配置语音识别 API Key，或在「AI 模型」里配置 MiniMax Key 以便复用'
      : '请先配置语音识别 API Key');
  }
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  assertSafeOutboundUrl(base, { label: '语音识别接口地址' });
  const url = base + (isMinimax(cfg) ? '/speech_to_text' : '/audio/transcriptions');
  const fd = new FormData();
  fd.append('file', new Blob([data], { type: contentType }), filename);
  fd.append('model', cfg.model);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error('语音识别服务连接失败：' + (err?.cause?.code || err?.name || err?.message || err));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const snippet = String(body).replace(/\s+/g, ' ').slice(0, 240);
    if (res.status === 401 || res.status === 403) throw new Error('语音识别 Key 无效（HTTP ' + res.status + '）');
    if (res.status === 402) throw new Error('语音识别账户余额不足（HTTP 402）');
    if (res.status === 429) throw new Error('语音识别被限流或无该模型权限（HTTP 429）：' + snippet);
    throw new Error('语音识别失败（HTTP ' + res.status + '）：' + snippet);
  }
  const out = await res.json().catch(() => null);
  return String(out?.text || '').trim();
}

/** 主接口优先，不可用时自动降级；两条都失败时返回合并后的错误信息。
 *  每次识别都记录到日志和 meta（设置页可查看最近记录）。 */
export async function transcribeAudioWithFallback(input = {}) {
  const attempts = asrAttempts();
  const errors = [];
  const started = Date.now();
  for (const attempt of attempts) {
    const cfg = attempt.config;
    const startedAt = Date.now();
    try {
      const text = await transcribeAudio({ ...input, config: cfg });
      const ms = Date.now() - startedAt;
      console.log(`[asr] ${attempt.label} · ${cfg.provider} · ${cfg.model} · ${ms}ms · ${input.data?.length || 0}B → ${text.length} 字`);
      recordHistory({ at: new Date().toISOString(), ok: true, via: attempt.label, provider: cfg.provider, model: cfg.model, ms, chars: text.length });
      return { text, via: attempt.label, provider: cfg.provider, model: cfg.model };
    } catch (err) {
      const ms = Date.now() - startedAt;
      const message = err?.message || String(err);
      console.warn(`[asr] ${attempt.label}（${cfg.provider} · ${cfg.model}）失败 ${ms}ms：${message}`);
      errors.push(`${attempt.label}：${message}`);
    }
  }
  recordHistory({ at: new Date().toISOString(), ok: false, via: '全部失败', error: errors.join('；').slice(0, 300), ms: Date.now() - started, chars: 0 });
  throw new Error(errors.join('；'));
}

const HISTORY_LIMIT = 20;
const HISTORY_RETENTION_DAYS = 10;

function recordHistory(entry) {
  try {
    const raw = store.getMeta('asr_history', '[]');
    let list = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400_000;
    list = list.filter((h) => {
      const t = Date.parse(h && h.at ? h.at : '');
      return Number.isFinite(t) ? t >= cutoff : false;
    });
    list.unshift(entry);
    store.setMeta('asr_history', JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch { /* 记录失败不影响识别 */ }
}
