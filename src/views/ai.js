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

export function aiSettingsPage({ user, config, presets, notice, error }) {
  return shell({
    active: 'ai-settings', user, title: 'AI 模型',
    subtitle: '配置用于复盘的模型；Key 加密保存在本地',
    body: settingsNav('ai') + configPanel({ config, presets, notice, error }),
  });
}
