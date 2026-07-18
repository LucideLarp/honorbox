// Minimal markdown renderer for store pages: headings, paragraphs, bold/italic,
// inline code, fenced code blocks, links, unordered/ordered lists, blockquotes, hr.
// Deliberately small; store pages are authored in-repo, not user-supplied.
'use strict';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const safe = /^(https?:\/\/|\/|#|\.)/.test(href) ? href : '#';
    return `<a href="${safe}">${text}</a>`;
  });
  return out;
}

function renderMarkdown(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // standalone image lines; consecutive ones group into a gallery grid
    if (/^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line)) {
      const imgs = [];
      while (i < lines.length && /^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(lines[i])) {
        const m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(lines[i++]);
        const src = /^(https?:\/\/|\/|\.)/.test(m[2]) ? m[2] : '';
        if (src) imgs.push(`<img src="${src}" alt="${escapeHtml(m[1])}" loading="lazy">`);
      }
      if (imgs.length > 1) out.push(`<div class="gallery">${imgs.join('')}</div>`);
      else if (imgs.length === 1) out.push(`<figure>${imgs[0]}</figure>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${buf.map(inline).join('<br>')}</p></blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''));
      out.push(`<ul>${buf.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ''));
      out.push(`<ol>${buf.map((li) => `<li>${inline(li)}</li>`).join('')}</ol>`);
      continue;
    }

    // paragraph: consume consecutive non-empty, non-structural lines
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4}\s|```|[-*]\s|\d+\.\s|>|(-{3,}|\*{3,})\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${buf.map(inline).join(' ')}</p>`);
  }
  return out.join('\n');
}

module.exports = { renderMarkdown, escapeHtml, inline };
