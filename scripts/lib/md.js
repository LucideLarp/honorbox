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
// See URL_STRIP below: the string is normalized the way the url parser
// normalizes it before either gate gets to look at it.
const URL_GATE = /^(?:https?:\/\/|\/(?![/\\])|\.)/;
const URL_GATE_ANCHOR = /^(?:https?:\/\/|\/(?![/\\])|#|\.)/;

// The gate must read the url the BROWSER will parse, not the one we were
// handed. The WHATWG parser removes every ascii tab/LF/CR from a url before
// parsing it, so "/<TAB>/evil.example" reads here as a root-relative path — a
// leading "/" followed by something that is neither "/" nor "\" — and reaches
// the network as "//evil.example", the exact authority this gate exists to
// block. Strip first, gate second, and return the STRIPPED value so what we
// approved is byte-for-byte what we emit.
const URL_STRIP = /[\t\n\r]/g;

function safeUrl(url, { anchor = false } = {}) {
  const u = String(url == null ? '' : url).replace(URL_STRIP, '');
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

// GFM pipe tables. The delimiter row is what makes a table a table: a row of
// only -, :, | and spaces, with at least one dash. Without this second-line
// check, any prose line containing a pipe would open a table.
const TABLE_DELIM = /^\s*\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

// Split one table row into cells. A pipe inside a code span is content, not a
// separator (`a|b` is one cell), and \| is a literal pipe — the docs' cron and
// regex snippets rely on both.
function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function alignOf(spec) {
  const s = spec.trim();
  if (/^:-+:$/.test(s)) return ' style="text-align:center"';
  if (/-+:$/.test(s)) return ' style="text-align:right"';
  return '';
}

// A table starts here when line i has a pipe and line i+1 is a delimiter row
// with the same cell count (GFM's own rule; it keeps a stray pipe in prose
// from swallowing the next line).
function tableAt(lines, start) {
  if (start + 1 >= lines.length) return null;
  if (!lines[start].includes('|')) return null;
  if (!TABLE_DELIM.test(lines[start + 1]) || !lines[start + 1].includes('-')) return null;
  const head = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]);
  if (head.length !== aligns.length || head.length < 2) return null;
  const a = aligns.map(alignOf);
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
  const th = head.map((c, n) => `<th scope="col"${a[n]}>${inline(c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${head.map((_, n) => `<td${a[n]}>${inline(r[n] == null ? '' : r[n])}</td>`).join('')}</tr>`)
    .join('');
  // Same wrapper the builder's compare/ledger tables use, so a wide table
  // scrolls inside itself on a phone instead of widening the page.
  return { html: `<div class="table-scroll"><table><tr>${th}</tr>${body}</table></div>`, next: i };
}

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

// opts.sizeOf(src) -> {width, height} | null. Optional, and optional on
// purpose: markdown rendering stays a pure string->string function with no
// filesystem in it, so the caller that KNOWS where the images live is the one
// that measures them. Without it the markup is byte-for-byte what it was.
function renderMarkdown(src, opts = {}) {
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
          // Reserve the box before the lazy image arrives. Markdown has no
          // syntax for dimensions, so without this the gallery on
          // honorbox-pro.html shifted the page under the reader on a slow
          // connection (measured CLS 0.14-0.28, over the 0.1 threshold).
          const d = typeof opts.sizeOf === 'function' ? opts.sizeOf(m[2]) : null;
          const dims = d && d.width > 0 && d.height > 0 ? ` width="${d.width}" height="${d.height}"` : '';
          // escape the URL for the attribute — same discipline as link hrefs
          imgs.push(`<img src="${escapeHtml(m[2])}" alt="${escapeHtml(m[1])}" loading="lazy"${dims}>`);
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

    const table = tableAt(lines, i);
    if (table) {
      out.push(table.html);
      i = table.next;
      continue;
    }

    // paragraph: consume consecutive non-empty, non-structural lines
    // A table needs no blank line above it: stop the paragraph at one, or the
    // header row gets swallowed as prose and the table never renders.
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !STRUCTURAL.test(lines[i]) && !tableAt(lines, i)) {
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
// as the renderer. The extension test ignores any ?query or #fragment, so a
// cache-busted "cover.png?v=2" still qualifies: missing one means the page
// silently ships with no social card.
// opts.ext narrows which formats count. The caller picking an og:image passes
// a stricter set than the caller picking any image: link-preview scrapers are
// not browsers, and X in particular still declines WebP cards, so a shared
// product link would render with no image at all.
function firstRasterImage(src, opts = {}) {
  const ext = opts.ext || /\.(png|jpe?g|webp|gif)$/i;
  // own instance: LINKISH is module-level and exec() would share its lastIndex
  const re = new RegExp(LINKISH.source, 'g');
  let m;
  while ((m = re.exec(String(src == null ? '' : src)))) {
    const [, bang, , href] = m;
    const bare = href.split(/[?#]/)[0];
    if (bang && safeUrl(href) && ext.test(bare)) return href;
  }
  return null;
}

module.exports = { renderMarkdown, escapeHtml, inline, excerpt, firstRasterImage, safeUrl };
