import { escapeHtml as e } from '../http.js';
import { shell, settingsNav } from './layout.js';

function configPanel({ config, presets, notice, error }) {
  const presetOptions = presets.map((p) => `<option value="${e(p.id)}" data-provider="${e(p.provider)}" data-base="${e(p.baseUrl)}" data-model="${e(p.model)}">${e(p.label)}</option>`).join('');
  return `
    ${error ? `<div class="alert alert-error">${e(error)}</div>` : ''}
    ${notice ? `<div class="alert alert-ok">${e(notice)}</div>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>模型配置</h2>
        <span class="muted small">${config.hasKey ? `已保存 Key ••••${e(config.keyHint || '')}` : '还没有保存 API Key'}</span></div>
      <form method="post" action="/dashboard/ai/config" class="form grid-form" id="llm-config-form">
        <label class="field"><span>快速预设</span>
          <select data-llm-preset>${presetOptions}</select>
        </label>
        <label class="field"><span>接口类型</span>
          <select name="provider">
            ${['openai', 'anthropic', 'ollama'].map((p) => `<option value="${p}" ${config.provider === p ? 'selected' : ''}>${p === 'openai' ? 'OpenAI 兼容' : p === 'anthropic' ? 'Anthropic' : 'Ollama 本地'}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Base URL</span>
          <input name="baseUrl" value="${e(config.baseUrl)}" placeholder="https://api.openai.com/v1">
        </label>
        <label class="field"><span>模型</span>
          <input name="model" value="${e(config.model)}" placeholder="gpt-4o-mini / deepseek-chat / qwen2.5:7b">
        </label>
        <label class="field"><span>API Key（留空保持不变）</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${config.hasKey ? '已保存，留空不改' : 'sk-...'}">
        </label>
        <label class="field"><span>温度（0–2）</span>
          <input name="temperature" type="number" step="0.1" min="0" max="2" value="${config.temperature}">
        </label>
        <label class="field"><span>最大输出 tokens</span>
          <input name="maxTokens" type="number" step="100" min="200" max="32000" value="${config.maxTokens}">
        </label>
        <label class="field wide"><span>系统提示词（可选）</span>
          <textarea name="systemPrompt" rows="3" placeholder="留空使用内置的交易教练提示词">${e(config.systemPrompt || '')}</textarea>
        </label>
        <div class="form-actions wide">
          <button class="btn btn-primary" type="submit">保存配置</button>
          <button class="btn btn-ghost" type="button" data-ai-test>测试已保存配置</button>
          <span class="muted small" data-ai-test-result></span>
        </div>
      </form>
      <p class="chart-note">
        Key 用 AES-256-GCM 加密存储，只用于你主动点击“生成”时调用模型；应用不会把你的交易数据发给除该模型之外的任何服务。
        用本地 Ollama 时不需要 Key，Base URL 填 <code>http://127.0.0.1:11434</code>。
      </p>
    </section>`;
}

function fmtAsrTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(iso || '');
  }
}

function asrHistoryTable(history) {
  if (!Array.isArray(history) || !history.length) {
    return '<p class="chart-note">还没有识别记录。用一次语音输入后，这里会显示每次识别走的通道和模型。</p>';
  }
  const rows = history.map((h) => {
    const ok = h && h.ok;
    const detail = ok
      ? `${e(h.provider || '')} · ${e(h.model || '')}`
      : `<span class="neg">${e(String(h.error || '识别失败').slice(0, 100))}</span>`;
    return `<tr>
      <td class="muted small">${e(fmtAsrTime(h.at))}</td>
      <td>${ok ? e(h.via || '') : '<span class="neg">全部失败</span>'}</td>
      <td class="muted small">${detail}</td>
      <td class="muted small">${ok ? `${Number(h.ms) || 0}ms` : '—'}</td>
      <td class="muted small">${ok ? `${Number(h.chars) || 0} 字` : '—'}</td>
    </tr>`;
  }).join('');
  return `<div class="muted small" style="margin:14px 0 6px">最近识别记录（最新在上，最多 20 条，保留 10 天）</div>
    <table>
      <thead><tr><th>时间</th><th>通道</th><th>模型</th><th>耗时</th><th>字数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function asrPanel({ asr, asrPresets }) {
  const presetOptions = asrPresets.map((p) => `<option value="${e(p.id)}" data-provider="${e(p.id === 'minimax' ? 'minimax' : 'openai')}" data-base="${e(p.baseUrl)}" data-model="${e(p.model)}">${e(p.label)}</option>`).join('');
  const keyState = asr.hasDedicatedKey
    ? `已保存专用 Key ••••${e(asr.keyHint || '')}`
    : asr.reusesLlmKey ? '未配置专用 Key，复用「AI 模型」的 MiniMax Key'
    : asr.fallbackLlm ? '未配置主接口 Key，将自动降级到 AI 模型的 MiniMax Key'
    : '没有可用 Key';
  return `
    <section class="panel">
      <div class="panel-head"><h2>语音识别</h2>
        <span class="muted small">${e(keyState)}</span></div>
      <form method="post" action="/dashboard/asr/config" class="form grid-form" id="asr-config-form">
        <label class="field"><span>快速预设</span>
          <select data-asr-preset>${presetOptions}</select>
        </label>
        <label class="field"><span>接口类型</span>
          <select name="provider">
            <option value="minimax" ${asr.provider === 'minimax' ? 'selected' : ''}>MiniMax speech_to_text</option>
            <option value="openai" ${asr.provider !== 'minimax' ? 'selected' : ''}>OpenAI 兼容转写接口</option>
          </select>
        </label>
        <label class="field"><span>Base URL</span>
          <input name="baseUrl" value="${e(asr.baseUrl)}" placeholder="https://api.minimax.cn/v1">
        </label>
        <label class="field"><span>模型</span>
          <input name="model" value="${e(asr.model)}" placeholder="asr-1.0 / whisper-1 / FunAudioLLM/SenseVoiceSmall">
        </label>
        <label class="field"><span>API Key（留空保持不变）</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${asr.hasDedicatedKey ? '已保存，留空不改' : asr.reusesLlmKey ? '留空则复用 AI 模型的 MiniMax Key' : 'sk-...'}">
        </label>
        <label class="field wide checkbox-field">
          <label><input type="checkbox" name="fallbackLlm" value="1" ${asr.fallbackLlm ? 'checked' : ''}> 主接口不可用时自动降级到「AI 模型」的 MiniMax Key</label>
        </label>
        <div class="form-actions wide">
          <button class="btn btn-primary" type="submit">保存配置</button>
          <button class="btn btn-ghost" type="button" data-asr-test>测试已保存配置</button>
          <span class="muted small" data-asr-test-result></span>
        </div>
      </form>
      <p class="chart-note">
        用于笔记 / 复盘的语音输入：浏览器录音上传到上面配置的服务转写成文字。音频只发往该接口，不落盘不进数据库。
        保存的配置（如硅基流动 SenseVoice）优先使用；勾选降级时，主接口没配 Key、网络不通或额度用尽会自动改用 AI 模型里的 MiniMax Key 识别。
      </p>
      ${asrHistoryTable(asr.history)}
    </section>`;
}

export function aiSettingsPage({ user, config, asr, presets, asrPresets, notice, error }) {
  return shell({
    active: 'ai-settings', user, title: 'AI 模型',
    subtitle: '配置用于复盘的模型与语音识别；Key 加密保存在本地',
    body: settingsNav('ai') + configPanel({ config, presets, notice, error }) + asrPanel({ asr, asrPresets }),
  });
}
