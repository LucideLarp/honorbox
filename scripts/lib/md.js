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

// Links and images share one shape: an optional `!`, the text, the target, and
// an optional "title". The target allows one level of nested parens, so a
// wikipedia-style url survives instead of being cut at its first `)`.
const LINKISH = /(!?)\[([^\]]*)\]\(\s*([^\s()]*(?:\([^()]*\)[^\s()]*)*)(?:\s+"([^"]*)")?\s*\)/g;

// Placeholders for constructs lifted out of the stream. Control characters, so
// they cannot appear in page text; incoming text is stripped of them anyway.
const CODE = '\u0000';
const OPEN = '\u0001';
const CLOSE = '\u0002';
const MARKERS = /[\u0000-\u0002]/g;

// Inline rendering lifts each construct out of the stream before the next rule
// runs, instead of stacking regexes over one string. The old order replaced
// code spans first and then ran bold, emphasis and links straight through the
// result, so markdown characters inside a code span were treated as markup:
// `^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$` published on the live store as
// `^<a href="#">a-zA-Z0-9</a>{0,38}$`, with the middle of the regex eaten.
function inline(s) {
  const spans = [];
  const links = [];
  let out = String(s == null ? '' : s).replace(MARKERS, '');

  // 1. code spans come out first: nothing may look inside them. A run of
  //    backticks of any length delimits, so ``a ` b`` holds a literal tick.
  out = out.replace(/(`+)([\s\S]+?)\1(?!`)/g, (_, ticks, code) =>
    `${CODE}${spans.push(code.replace(/^ ([\s\S]*) $/, '$1')) - 1}${CODE}`
  );

  // 2. links and images. The text stays in the stream between markers so it
  //    still picks up emphasis; only the attributes are lifted out.
  out = out.replace(LINKISH, (m, bang, text, href, title) => {
    if (bang) {
      // A rejected scheme degrades to the alt text: still visible, but the
      // scheme itself never reaches the page, not even as inert prose.
      if (!safeUrl(href)) return text;
      return `${OPEN}${links.push({ img: true, href, title, alt: text }) - 1}${OPEN}`;
    }
    if (!text) return m; // [](url): a link with no accessible name is not a link
    const i = links.push({ href: safeUrl(href, { anchor: true }) || '#', title }) - 1;
    return `${OPEN}${i}${OPEN}${text}${CLOSE}${i}${CLOSE}`;
  });

  out = escapeHtml(out);
  // 3. an author who writes &amp; or &mdash; means the entity, not the letters
  out = out.replace(/&amp;(#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, '&$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 4. put the lifted constructs back, escaped and inert
  const attr = (l) => (l.title ? ` title="${escapeHtml(l.title)}"` : '');
  out = out.replace(new RegExp(OPEN + '(\\d+)' + OPEN, 'g'), (_, n) => {
    const l = links[n];
    return l.img
      ? `<img src="${escapeHtml(l.href)}" alt="${escapeHtml(l.alt)}" loading="lazy"${attr(l)}>`
      : `<a href="${escapeHtml(l.href)}"${attr(l)}>`;
  });
  out = out.replace(new RegExp(CLOSE + '\\d+' + CLOSE, 'g'), '</a>');
  return out.replace(new RegExp(CODE + '(\\d+)' + CODE, 'g'), (_, n) => `<code>${escapeHtml(spans[n])}</code>`);
}

// Lines that are markdown structure, not paragraph prose. One definition
// shared by the renderer's paragraph terminator and excerpt(), so the two
// can never drift apart again (an image line after a paragraph used to be
// swallowed because a hand-copied variant here lacked `!\[`).
const STRUCTURAL = /^(#{1,4}\s|```|[-*]\s|\d+\.\s|>|!\[|(-{3,}|\*{3,})\s*$)/;

// Lists nest by indentation. The previous rule folded ANY indented line into
// the item above, so a nested list came out as one run-on item with its
// markers still in the text: "- a" over "  - b" rendered <li>a - b</li>.
// A deeper marker now opens a sublist inside the item it belongs to, while a
// plain indented line still continues wrapped prose as before.
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const NUMBER = /^(\s*)\d+\.\s+(.*)$/;

function listAt(lines, start, base) {
  const ordered = !BULLET.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = BULLET.exec(lines[i]) || NUMBER.exec(lines[i]);
    if (m) {
      const indent = m[1].length;
      if (indent < base) break;
      if (indent > base) {
        if (!items.length) break;
        const sub = listAt(lines, i, indent);
        items[items.length - 1].sub += sub.html;
        i = sub.next;
        continue;
      }
      // a different marker kind at the same depth starts a different list
      if (!BULLET.test(lines[i]) !== ordered) break;
      items.push({ text: m[2], sub: '' });
      i++;
      continue;
    }
    // wrapped source: an indented plain line continues the item above, but
    // only while that item has not already opened a sublist
    const last = items[items.length - 1];
    if (last && !last.sub && /^\s+\S/.test(lines[i])) {
      last.text += ' ' + lines[i++].trim();
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  return {
    html: `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join('')}</${tag}>`,
    next: i,
  };
}

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

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const list = listAt(lines, i, 0);
      out.push(list.html);
      i = list.next;
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
    // same shape the renderer uses, so a url with parens or a titled image
    // cannot leave residue in a meta description that the body renders fine
    .replace(LINKISH, (_m, _bang, label) => label)
    .replace(/(`+)([\s\S]+?)\1(?!`)/g, '$2')
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
  // own instance: LINKISH is module-level and exec() would share its lastIndex
  const re = new RegExp(LINKISH.source, 'g');
  let m;
  while ((m = re.exec(String(src == null ? '' : src)))) {
    const [, bang, , href] = m;
    if (bang && safeUrl(href) && /\.(png|jpe?g|webp|gif)$/i.test(href)) return href;
  }
  return null;
}

module.exports = { renderMarkdown, escapeHtml, inline, excerpt, firstRasterImage, safeUrl };
