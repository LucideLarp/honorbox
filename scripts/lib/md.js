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

// Which URLs may reach an href/src attribute: explicit http(s), or a reference
// that stays on this origin. A leading "//" or "/\" is an *authority*, not a
// path — the WHATWG url parser treats a backslash as a slash for special
// schemes — so "//evil.example/x" reads like a local path but resolves to
// somebody else's origin under our scheme. Root-relative "/path" still works.
// One definition, shared with build.js's safeHref, so the gates guarding
// links, images, and the checkout button cannot drift apart (that drift is how
// the buy button ended up with no scheme gate at all).
// anchor: links may target "#section"; an image src has no use for one.
const URL_GATE = /^(?:https?:\/\/|\/(?![/\\])|\.)/;
const URL_GATE_ANCHOR = /^(?:https?:\/\/|\/(?![/\\])|#|\.)/;

function safeUrl(url, { anchor = false } = {}) {
  const u = String(url == null ? '' : url);
  return (anchor ? URL_GATE_ANCHOR : URL_GATE).test(u) ? u : null;
}

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const safe = safeUrl(href, { anchor: true }) || '#';
    return `<a href="${safe}">${text}</a>`;
  });
  return out;
}

// Lines that are markdown structure, not paragraph prose. One definition
// shared by the renderer's paragraph terminator and excerpt(), so the two
// can never drift apart again (an image line after a paragraph used to be
// swallowed because a hand-copied variant here lacked `!\[`).
const STRUCTURAL = /^(#{1,4}\s|```|[-*]\s|\d+\.\s|>|!\[|(-{3,}|\*{3,})\s*$)/;

function renderMarkdown(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    // Any line starting ``` opens a fence; the info string ("js",
    // "objective-c", "c++") is free-form and unused here.
    if (/^```/.test(line)) {
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
        if (safeUrl(m[2])) {
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
      // an indented non-empty line continues the item above (wrapped source)
      while (i < lines.length && (/^[-*]\s+/.test(lines[i]) || (buf.length && /^\s+\S/.test(lines[i])))) {
        if (/^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''));
        else buf[buf.length - 1] += ' ' + lines[i++].trim();
      }
      out.push(`<ul>${buf.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\d+\.\s+/.test(lines[i]) || (buf.length && /^\s+\S/.test(lines[i])))) {
        if (/^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ''));
        else buf[buf.length - 1] += ' ' + lines[i++].trim();
      }
      out.push(`<ol>${buf.map((li) => `<li>${inline(li)}</li>`).join('')}</ol>`);
      continue;
    }

    // paragraph: consume consecutive non-empty, non-structural lines
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !STRUCTURAL.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

// Plain-text excerpt of the first real paragraph — for per-page meta
// descriptions. Skips headings, images, fences, lists, and quotes; strips
// inline markdown; truncates at a word boundary.
function excerpt(src, max = 160) {
  const lines = String(src == null ? '' : src).split(/\r?\n/);
  let i = 0;
  let inBlock = false; // inside a structural block whose wrapped lines are indented
  while (i < lines.length) {
    if (/^\s*$/.test(lines[i])) { inBlock = false; i++; continue; }
    if (STRUCTURAL.test(lines[i].trim())) {
      if (/^```/.test(lines[i].trim())) { i++; while (i < lines.length && !/^```\s*$/.test(lines[i])) i++; }
      inBlock = true; i++; continue;
    }
    // an indented line continues the list item above (same rule the renderer
    // applies), so it is part of the block, not the first paragraph
    if (inBlock && /^\s+\S/.test(lines[i])) { i++; continue; }
    break;
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
    if (safeUrl(m[1]) && /\.(png|jpe?g|webp|gif)$/i.test(m[1])) return m[1];
  }
  return null;
}

module.exports = { renderMarkdown, escapeHtml, inline, excerpt, firstRasterImage, safeUrl };
