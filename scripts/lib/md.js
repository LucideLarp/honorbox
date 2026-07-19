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
      const rejected = [];
      while (i < lines.length && /^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(lines[i])) {
        const m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(lines[i++]);
        if (/^(https?:\/\/|\/|\.)/.test(m[2])) {
          // escape the URL for the attribute — same discipline as link hrefs
          imgs.push(`<img src="${escapeHtml(m[2])}" alt="${escapeHtml(m[1])}" loading="lazy">`);
        } else {
          // rejected scheme: keep the line visible instead of vanishing silently
          rejected.push(`<p>${inline(m[0])}</p>`);
        }
      }
      if (imgs.length > 1) out.push(`<div class="gallery">${imgs.join('')}</div>`);
      else if (imgs.length === 1) out.push(`<figure>${imgs[0]}</figure>`);
      out.push(...rejected);
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
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// Lines that are markdown structure, not paragraph prose. Mirrors the
// renderer's dispatch above; keep the two in sync.
const STRUCTURAL = /^(#{1,4}\s|```|[-*]\s|\d+\.\s|>|!\[|(-{3,}|\*{3,})\s*$)/;

// Plain-text excerpt of the first real paragraph — for per-page meta
// descriptions. Skips headings, images, fences, lists, and quotes; strips
// inline markdown; truncates at a word boundary.
function excerpt(src, max = 160) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (/^\s*$/.test(lines[i]) || STRUCTURAL.test(lines[i].trim()))) {
    if (/^```/.test(lines[i].trim())) { i++; while (i < lines.length && !/^```\s*$/.test(lines[i])) i++; }
    i++;
  }
  const buf = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && !STRUCTURAL.test(lines[i].trim())) buf.push(lines[i++]);
  const text = buf.join(' ')
    .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1') // images before links: same prefix
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return cut.slice(0, space > max * 0.6 ? space : max).replace(/[\s,;:.]+$/, '') + '…';
}

// First raster image referenced in a markdown body — social-card material.
// SVG is skipped (link-preview scrapers don't render it); same scheme gate
// as the renderer.
function firstRasterImage(src) {
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(src == null ? '' : src)))) {
    if (/^(https?:\/\/|\/|\.)/.test(m[1]) && /\.(png|jpe?g|webp|gif)$/i.test(m[1])) return m[1];
  }
  return null;
}

module.exports = { renderMarkdown, escapeHtml, inline, excerpt, firstRasterImage };
