/**
 * 极简 Markdown 渲染器（零依赖，安全优先）。
 *
 * 支持：标题、粗体/斜体/删除线、行内代码、代码块、链接、图片、
 * 无序/有序列表、引用、分隔线、段落与换行。
 * 不支持原始 HTML（会被转义），因此笔记内容不会注入脚本。
 */

import { escapeHtml } from './http.js';

function safeUrl(raw, { image = false } = {}) {
  const url = String(raw || '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/media/')) return url;
  if (!image && (url.startsWith('/') || url.startsWith('#'))) return url;
  if (!image && /^mailto:/i.test(url)) return url;
  return '';
}

function renderInline(input) {
  let text = escapeHtml(input);

  // 行内代码先抽出来，避免里面的 * / _ 被当成强调
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, alt, url) => {
    const safe = safeUrl(url, { image: true });
    if (!safe) return match;
    return `<img src="${safe}" alt="${alt}" loading="lazy">`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
    const safe = safeUrl(url);
    if (!safe) return match;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 注意：强调必须在链接/图片插入之前处理，否则会误改 href 里的下划线
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

  text = text.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)] || ''}</code>`);
  return text;
}

export function renderMarkdown(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // 代码块
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((x) => `<li>${renderInline(x)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map((x) => `<li>${renderInline(x)}</li>`).join('')}</ol>`);
      continue;
    }

    // 段落：连续非空行合并，保留换行
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^```/.test(lines[i])
      && !/^(#{1,6})\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('\n');
}

/** 列表摘要用：去掉 Markdown 标记，保留可读文字 */
export function stripMarkdown(source) {
  return String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
