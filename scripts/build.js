#!/usr/bin/env node
// HonorBox static site builder: store.config.json + products/*.md + pages/*.md
// + themes/<theme>/ -> dist/. Zero dependencies.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./lib/fm.js');
const { renderMarkdown, escapeHtml, excerpt, firstRasterImage, safeUrl } = require('./lib/md.js');
const { imageSize } = require('./lib/imgsize.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Intrinsic size of a site-relative image reference ("./assets/x.webp"), read
// from the file on disk so an <img> can reserve its box before it loads.
// Remote URLs, SVGs and anything unreadable return null and the attributes are
// simply omitted, never guessed. A wrong reservation shifts the page just as
// badly as no reservation.
const sizeCache = new Map();
function sizeOfLocal(src) {
  if (typeof src !== 'string' || /^(?:[a-z]+:)?\/\//i.test(src)) return null;
  if (sizeCache.has(src)) return sizeCache.get(src);
  let size = null;
  try {
    const rel = src.replace(/^\.?\//, '').split(/[?#]/)[0];
    const file = path.join(ROOT, rel);
    // Stay inside the repo: a "../.." reference must not read the disk.
    if (path.relative(ROOT, file).startsWith('..')) throw new Error('outside root');
    size = imageSize(fs.readFileSync(file));
  } catch { size = null; }
  sizeCache.set(src, size);
  return size;
}
const MD_OPTS = { sizeOf: sizeOfLocal };

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

// Href for an HTML attribute from a config- or frontmatter-authored URL:
// neutralize anything that isn't http(s)/relative/anchor (blocks javascript:
// and protocol-relative "//host"), then attribute-escape. The gate itself is
// md.js's, so the renderer and the builder cannot disagree about what a safe
// URL is. EVERY url we put in an href/src goes through here. Escaping alone is
// not enough: it happily preserves a javascript: value.
function safeHref(url) {
  return escapeHtml(safeUrl(url, { anchor: true }) || '#');
}

// ---------- SEO / social plumbing (pure helpers, covered by core.test.js) ----------

// "$29" / "$29.50" -> "29" / "29.50" for schema.org offers. Null when the
// frontmatter price isn't a plain USD amount, so the offer is honestly
// omitted rather than guessed.
function usdPrice(price) {
  const m = /^\$(\d+(?:\.\d{1,2})?)$/.exec(String(price == null ? '' : price).trim());
  return m ? m[1] : null;
}

// Absolute site URL for a markdown/config-relative reference ("./assets/x.png").
function absUrl(site, ref) {
  const u = String(ref == null ? '' : ref);
  return /^https?:\/\//.test(u) ? u : `${site}/${u.replace(/^\.?\//, '')}`;
}

// The replacement is a FUNCTION, not a string: in a string replacement "$&"
// and "$'" are substitution patterns, and escapeHtml does not touch "$", so a
// config value could otherwise paste matched or trailing document text
// (quotes included) into the tag it is being written into.
function injectHead(html, block) {
  return html.includes('</head>') ? html.replace('</head>', () => `${block}\n</head>`) : html;
}

// Fill {{placeholders}} in a theme layout, in a SINGLE pass. Sequential
// per-key replaces let one value's text contain another key's placeholder and
// get expanded on that key's turn, which let an escaped config string smuggle
// the raw, unescaped page HTML into <title> or a meta attribute. Own keys
// only, so inherited names like "constructor" are not placeholders.
function tpl(layout, vars) {
  return layout.replace(/\{\{([a-z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

// Set a <meta ... content="..."> value: replace in place when the theme layout
// already emits the tag (both themes hardcode og:type="website"), else append
// to <head>. Attribute-level only: themes own their markup.
function setMeta(html, attr, name, content) {
  const esc = escapeHtml(String(content));
  const re = new RegExp(`(<meta\\s+${attr}="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, (m, open, close) => `${open}${esc}${close}`);
  return injectHead(html, `<meta ${attr}="${name}" content="${esc}">`);
}

// JSON-LD <script> with `<` escaped so no config/frontmatter text can ever
// close the tag (same discipline as attribute escaping elsewhere).
function jsonLdScript(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

// Pages promoted from home "steps" sections (config-authored ./slug.html
// links) are guide articles; the rest of pages/ is store chrome (terms etc.).
function guideSlugs(sections) {
  const slugs = new Set();
  for (const s of sections || []) {
    if (s.type !== 'steps') continue;
    for (const it of s.items || []) {
      const m = /^\.\/([A-Za-z0-9_-]+)\.html$/.exec(it.href || '');
      if (m) slugs.add(m[1]);
    }
  }
  return slugs;
}

// ---------- docs ----------

// Which docs/*.md become pages on the store, in reading order (the docs index
// and the nav follow this order, not the alphabet).
//
// pro-evidence.md is deliberately NOT here. It is Pro sales collateral (dated
// transcripts of live-store runs plus a paid playbook's table of contents)
// rather than store documentation, and publishing it as a peer of the setup
// guide both dilutes the docs and creates a page that silently goes stale.
// It stays readable in the repo, where an auditing buyer already looks.
//
// failure-catalogue.md IS here, and is the one doc that is not about operating
// HonorBox. It is the catalogue behind Pro's conformance suite, published whole
// and free: it is worth reading on its own, it is what the suite's checks are
// generated from, and keeping it off the site would leave "published openly" as
// a claim rather than a fact. Regenerated from Pro, never edited here.
const PUBLISHED_DOCS = ['how-it-works', 'setup', 'subscriptions', 'least-privilege', 'instant-delivery', 'tax', 'failure-catalogue'];

// docs/*.md carry no frontmatter: the first "# " line is the title. Split it
// off so the page template owns the <h1> (same shape as pages/) instead of the
// document rendering a second one under the theme's.
function docTitle(md, fallback) {
  const m = /^\s*#\s+(.+?)\s*$/m.exec(md);
  if (!m) return { title: fallback, body: md };
  return { title: m[1], body: md.slice(0, m.index) + md.slice(m.index + m[0].length) };
}

// Rewrite a doc's repo-relative links for the published site:
//   [x](setup.md)        -> ./setup.html         (a sibling doc we publish)
//   [x](pro-evidence.md) -> GitHub blob URL      (a doc we do not publish)
//   [x](../webhook-mode/)-> GitHub tree URL      (a directory outside docs/)
//   [x](../scripts/f.js) -> GitHub blob URL      (a file outside docs/)
// http(s) and #anchors are left exactly as authored.
//
// This runs on the markdown source, so it must not corrupt a link-looking
// string inside a code span. docs/how-it-works.md carries the username regex
// `...](?:-?[a-zA-Z0-9]){0,38}$`. The targets below are anchored to real path
// shapes (a .md suffix, or a leading ../), which that regex is not.
function rewriteDocLinks(md, { repo, published = PUBLISHED_DOCS } = {}) {
  const blob = (p) => (repo ? `https://github.com/${repo}/blob/main/${p}` : `#${p}`);
  const tree = (p) => (repo ? `https://github.com/${repo}/tree/main/${p}` : `#${p}`);
  return String(md)
    // sibling doc: bare name, no slash, .md suffix, optional #anchor.
    // The anchor is carried into BOTH branches. Dropping it on the way to
    // GitHub silently turned a deep link into a section into a link at the top
    // of a 500-line document, which is the kind of rot nobody reports and
    // everybody notices.
    .replace(/(\]\()([A-Za-z0-9_-]+)\.md(#[A-Za-z0-9_-]+)?(\))/g, (m, open, slug, hash, close) =>
      published.includes(slug)
        ? `${open}./${slug}.html${hash || ''}${close}`
        : `${open}${blob(`docs/${slug}.md`)}${hash || ''}${close}`
    )
    // anything one level up: ../dir/ (tree) or ../dir/file.ext (blob)
    .replace(/(\]\()\.\.\/([A-Za-z0-9_./-]+)(\))/g, (m, open, rest, close) =>
      `${open}${rest.endsWith('/') ? tree(rest) : blob(rest)}${close}`
    );
}

function productJsonLd(p, config, image) {
  const site = config.url.replace(/\/$/, '');
  const url = `${site}/${p.id}.html`;
  const price = usdPrice(p.price);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: p.tagline || '',
    url,
    brand: { '@type': 'Brand', name: config.name },
  };
  if (image) ld.image = image;
  if (price) {
    ld.offers = {
      '@type': 'Offer',
      price,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url,
    };
  }
  return ld;
}

function homeJsonLd(config, logo) {
  const site = config.url.replace(/\/$/, '');
  const org = { '@type': 'Organization', '@id': `${site}/#org`, name: config.name, url: `${site}/` };
  if (logo) org.logo = logo;
  if (config.support_email) org.email = config.support_email;
  if (config.repo) org.sameAs = [`https://github.com/${config.repo}`];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      org,
      {
        '@type': 'WebSite',
        name: config.name,
        url: `${site}/`,
        description: config.tagline || '',
        publisher: { '@id': `${site}/#org` },
      },
    ],
  };
}

function articleJsonLd({ title, description, url, config, image, dateModified }) {
  const site = config.url.replace(/\/$/, '');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description: description || '',
    url,
    mainEntityOfPage: url,
    author: { '@type': 'Organization', name: config.name, url: `${site}/` },
    publisher: { '@type': 'Organization', name: config.name, url: `${site}/` },
  };
  if (image) ld.image = image;
  if (dateModified) ld.dateModified = dateModified;
  return ld;
}

// entries: [{ path, lastmod, priority }]; path is relative to the site root.
function sitemapXml(site, entries) {
  const urls = entries.map(({ path: p, lastmod, priority }) => {
    const parts = [`<loc>${escapeHtml(`${site}/${p}`)}</loc>`];
    if (lastmod) parts.push(`<lastmod>${escapeHtml(lastmod)}</lastmod>`);
    if (priority != null) parts.push(`<priority>${priority.toFixed(1)}</priority>`);
    return `  <url>${parts.join('')}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// Focus-only styling for the skip link, self-contained so no theme file has
// to know about it; theme vars with fallbacks keep it on-palette.
const SKIP_LINK_STYLE =
  '<style>.skip-link{position:absolute;left:-999rem}.skip-link:focus{left:.5rem;top:.5rem;z-index:99;background:var(--paper,#fff);color:var(--ink,#000);outline:2px solid var(--accent,currentColor);padding:.4rem .8rem}</style>';

// Attribute-level a11y pass on a rendered page. Strictly additive: themes own
// the DOM and class names; we only add attributes and the skip link.
function decoratePage(html) {
  let out = html.replace('<main>', '<main id="main">');
  out = out.replace('<nav class="site-nav">', '<nav class="site-nav" aria-label="Primary">');
  // A theme may ship its own skip link (stand does) and style it itself.
  // Injecting a second one duplicates the control for keyboard users, and
  // our <style> lands after the theme stylesheet, so it would also override
  // the theme's designed focus state. Only fill the gap when there is one.
  if (out.includes('<main id="main">') && !out.includes('class="skip-link"')) {
    out = out.replace(/(<body[^>]*>)/, '$1\n<a class="skip-link" href="#main">Skip to content</a>');
    out = injectHead(out, SKIP_LINK_STYLE);
  }
  return out;
}

// Frontmatter mistakes surface as a per-file list naming the field, not a
// TypeError from deep inside a template string (a missing "price" used to
// die with "Cannot read properties of undefined (reading 'replace')").
function productProblems(p) {
  const out = [];
  if (!p.id) out.push('missing "id" (the page slug, e.g. id: my-tool)');
  else if (!/^[A-Za-z0-9_-]+$/.test(String(p.id))) out.push(`"id" must be a slug of [A-Za-z0-9_-], got ${JSON.stringify(p.id)}`);
  if (!p.name) out.push('missing "name"');
  if (p.price == null || p.price === '') out.push('missing "price" (e.g. price: $29)');
  if (!Array.isArray(p.features)) out.push('"features" must be a list ("features:" then "  - item" lines)');
  return out;
}

// The same courtesy for store.config.json. Without it a missing key dies deep
// in a template string ("Cannot read properties of undefined") naming neither
// the file nor the field.
const SECTION_TYPES = ['steps', 'compare', 'faq', 'note', 'showcase'];

function configProblems(c) {
  const out = [];
  for (const key of ['name', 'tagline', 'url']) {
    if (typeof c[key] !== 'string' || !c[key].trim()) out.push(`missing "${key}" (a non-empty string)`);
  }
  if (c.sections != null && !Array.isArray(c.sections)) out.push('"sections" must be a list');
  (Array.isArray(c.sections) ? c.sections : []).forEach((s, i) => {
    // An unrecognized type used to render as '', so a seller's typo
    // silently deleted a whole band of the storefront with a green build.
    if (!s || typeof s !== 'object') out.push(`sections[${i}] must be an object`);
    else if (!SECTION_TYPES.includes(s.type)) {
      out.push(`sections[${i}] has unknown type ${JSON.stringify(s.type)} (expected one of: ${SECTION_TYPES.join(', ')})`);
    }
  });
  return out;
}

// This repo is two things at once: HonorBox's live store, and the template
// sellers fork. Everything in products/ is real and wired to HonorBox's Stripe
// account, so a fork that re-homes the storefront but keeps these links ships
// Buy buttons that take its buyers' money into HonorBox's balance and deliver
// nothing. The build refuses once the store identity is no longer HonorBox's.
// Adding a product to this repo means adding its checkout identifiers here.
const UPSTREAM_REPO = 'Honorboxx/honorbox';
const UPSTREAM_CHECKOUT = new Set([
  'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03', // Crew, payment link URL
  'https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00', // HonorBox Pro, payment link URL
  'plink_1TupsnE9zX2nUu1OV1JOs3x3', // Crew
  'plink_1Tudl9E9zX2nUu1OZywmp76G', // HonorBox Pro
  'price_1TupsmE9zX2nUu1O0MI3E8oR', // Crew
  'price_1TudkyE9zX2nUu1OTQhtZq8Q', // HonorBox Pro
]);

// Is this HonorBox's own storefront, or somebody's copy of it? The question is
// unavoidable because this repo is at once the live store and the template of
// itself: the shipped config carries REAL, live checkout links into HonorBox's
// Stripe account.
//
// The gate used to key on `repo` alone, which left it silent for the one person
// it most needed to stop. `repo` is not in the field list in docs/setup.md, so a
// seller who edited exactly what the docs told them to (name, url, seller, the
// copy) kept `repo` at its shipped value, the guard returned [], the build
// exited 0, and their storefront's hero button read "Buy HonorBox Pro · $29"
// pointed at our checkout. Their buyers' money would have landed in our balance.
//
// Identity is the honest signal. If ANY of name/url/repo has been made theirs,
// this is no longer our store and our checkout links have no business in it.
const UPSTREAM_NAME = 'HonorBox';
const UPSTREAM_URL = 'https://honorboxx.github.io/honorbox';
const trimSlash = (v) => String(v || '').replace(/\/$/, '');

function isUpstreamStore(config) {
  return (
    config.repo === UPSTREAM_REPO &&
    config.name === UPSTREAM_NAME &&
    trimSlash(config.url) === UPSTREAM_URL
  );
}


// A fork rarely keeps our link byte-for-byte either. Appending a utm
// parameter, a fragment, or a trailing slash, or pasting it back in a
// different case, all used to walk straight past an exact-string Set, and the
// resulting build was GREEN, so nothing told the forker their Buy button was
// still paying HonorBox. Compare on a normalized key instead: query and
// fragment removed (they change nothing about which checkout is opened),
// trailing slashes dropped, case folded. Folding case can only make the guard
// refuse MORE, and a seller whose own link differs from ours only by case does
// not exist.
function checkoutKey(v) {
  return String(v).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}
const UPSTREAM_CHECKOUT_KEYS = new Set([...UPSTREAM_CHECKOUT].map(checkoutKey));
// Our plink_/price_ ids are also caught anywhere inside a longer string, so
// pasting the id into a url (or a url into the id field) is still refused.
const UPSTREAM_CHECKOUT_IDS = [...UPSTREAM_CHECKOUT].filter((v) => /^(?:plink|price)_/.test(v)).map(checkoutKey);

function templateProblems(config, products) {
  if (isUpstreamStore(config)) return [];
  const out = [];
  // Say the quiet part first: the field nobody was told to set is the field
  // that decides where the fulfillment engine tries to invite buyers.
  if (!config.repo || config.repo === UPSTREAM_REPO) {
    out.push('store.config.json: "repo" is still HonorBox\'s ("' + (config.repo || '') + '"). Set it to YOUR storefront repo (owner/name). It is how this build knows the store is yours.');
  }
  const owned = (v) => {
    if (typeof v !== 'string') return false;
    // The id search runs on the whole lowercased value, NOT on checkoutKey's
    // output: the key drops everything from "?" onward, which would throw away
    // the very id we are looking for in ".../x?pl=plink_…".
    const lower = v.trim().toLowerCase();
    return UPSTREAM_CHECKOUT_KEYS.has(checkoutKey(v)) || UPSTREAM_CHECKOUT_IDS.some((id) => lower.includes(id));
  };
  for (const p of products) {
    if (owned(p.payment_link)) {
      out.push(`products/${p.id}.md: payment_link is HonorBox's own checkout, so this store would sell HonorBox's product and the money would land in HonorBox's Stripe account. Replace it with your own payment link.`);
    }
  }
  (Array.isArray(config.fulfillment) ? config.fulfillment : []).forEach((g, i) => {
    if (!g || typeof g !== 'object') return;
    for (const key of ['payment_link', 'price']) {
      if (owned(g[key])) out.push(`store.config.json: fulfillment[${i}].${key} is HonorBox's own ${key}, replace it with yours`);
    }
    if (typeof g.repo === 'string' && g.repo.startsWith(`${UPSTREAM_REPO.split('/')[0]}/`)) {
      out.push(`store.config.json: fulfillment[${i}].repo is "${g.repo}", a HonorBox repo you cannot invite buyers into; point it at your own product repo`);
    }
  });
  return out;
}

// Body of the public ledger page. Pure so the escaping is testable without a
// real ledger file. Everything the fulfillment bot writes is escaped, the
// total included: it is a Stripe integer today, but this is the one page a
// seller publishes to strangers and "the number is bot-written" is exactly the
// assumption that rots.
function trustArticle(ledger) {
  const ledgerRows = (ledger.rows || [])
    .slice()
    .reverse()
    .map(
      (r) =>
        `<tr${r.needs_attention ? ' class="attn"' : ''}><td>${escapeHtml(r.ts.slice(0, 10))}</td><td>${escapeHtml(r.product)}</td><td class="num">${r.amount.toFixed(2)} ${escapeHtml(r.currency)}</td><td>${escapeHtml(r.country || 'n/a')}</td><td class="num">${escapeHtml(r.ref)}</td></tr>`
    )
    .join('');
  return `<article class="prose trust">
<h1>Public ledger</h1>
<p>Every sale this store makes is committed here by the fulfillment bot: date, product, amount,
buyer country, and an anonymous reference. No names, no emails.</p>
<p class="ledger-total"><strong>${escapeHtml(String(ledger.total_sales || 0))}</strong> sales recorded · last updated ${escapeHtml((ledger.updated || 'never').slice(0, 16).replace('T', ' '))} UTC</p>
<div class="table-scroll"><table class="ledger">
<tr><th scope="col">Date</th><th scope="col">Product</th><th scope="col">Amount</th><th scope="col">Country</th><th scope="col">Ref</th></tr>
${ledgerRows || '<tr><td colspan="5" class="muted">No sales yet. The box is open.</td></tr>'}
</table></div>
<p class="muted">Raw data: <a href="./ledger/ledger.json">ledger.json</a> · Updated on every fulfillment run.</p>
</article>`;
}

// Products and pages share one output namespace and pages are written second,
// so a colliding slug silently replaces a product page (and its Buy button)
// with prose. Pure so the collision rule is testable without a real tree.
function slugProblems(productIds, pageSlugs, { dir = 'pages', what = 'product id' } = {}) {
  const ids = new Set(productIds);
  return pageSlugs
    .filter((slug) => ids.has(slug))
    .map((slug) => `${dir}/${slug}.md: slug "${slug}" collides with ${what} "${slug}" (the page would overwrite the product's checkout)`);
}

function buyButton(p, big = false) {
  // No usable checkout link: missing, or a URL the gate rejects. Gating a bad
  // link down to "#" would ship a Buy button that looks alive and goes
  // nowhere; from the buyer's side that is the same problem as no link at all,
  // so it gets the state this module already has. For a forker who typo'd
  // their payment_link, "Checkout coming soon" is also the readable signal.
  if (!p.payment_link || typeof p.payment_link !== 'string' || !safeUrl(p.payment_link, { anchor: true })) {
    return `<span class="btn btn-disabled" title="Checkout not configured yet">Checkout coming soon</span>`;
  }
  return `<a class="btn btn-buy${big ? ' btn-big' : ''}" href="${safeHref(p.payment_link)}">Buy ${escapeHtml(p.name)} · ${escapeHtml(p.price)}</a>`;
}

// variant: '' (default) | 'flagship' | 'companion'. Additive modifier classes
// only: every theme keeps styling .product-card; a theme that knows the
// variants steps the companion down visually.
function productCard(p, variant = '') {
  return `<article class="product-card${variant ? ` ${variant}` : ''}">
  <div class="pc-head">
    ${p.badge ? `<span class="badge">${escapeHtml(p.badge)}</span>` : ''}
    <h3><a href="./${escapeHtml(p.id)}.html">${escapeHtml(p.name)}</a></h3>
    <p class="pc-tagline">${escapeHtml(p.tagline || '')}</p>
  </div>
  <ul class="pc-features">${p.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
  <div class="pc-buy">
    <span class="price">${escapeHtml(p.price)}<small> ${escapeHtml(p.price_note || '')}</small></span>
    ${buyButton(p)}
  </div>
</article>`;
}

function section(s, sizeOf = sizeOfLocal) {
  if (s.type === 'steps') {
    // Optional `note`, same contract as `compare` and `showcase` already have.
    // Without it a note written on a steps section is silently dropped, which
    // is the failure shape this repo keeps fixing: config that looks honoured
    // and is not.
    return `<section class="steps"><h2>${escapeHtml(s.title)}</h2>${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ''}<ol class="steps-list">${s.items
      .map((it) => {
        const h = it.href
          ? `<a href="${safeHref(it.href)}">${escapeHtml(it.title)}</a>`
          : escapeHtml(it.title);
        return `<li><h3>${h}</h3><p>${escapeHtml(it.text)}</p></li>`;
      })
      .join('')}</ol></section>`;
  }
  if (s.type === 'compare') {
    const head = `<tr>${s.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr>`;
    const rows = s.rows
      .map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="rowhead"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`)
      .join('');
    return `<section class="compare"><h2>${escapeHtml(s.title)}</h2>${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ''}<div class="table-scroll" tabindex="0" role="region" aria-label="Comparison table, scrolls sideways"><table>${head}${rows}</table></div></section>`;
  }
  if (s.type === 'faq') {
    // Optional `href`/`href_label`: an answer that points at a doc gets a real
    // link. The answer itself stays plain escaped text (no HTML in config), so
    // the link is appended rather than embedded, same discipline as `steps`.
    return `<section class="faq"><h2>${escapeHtml(s.title)}</h2>${s.items
      .map((it) => {
        const more = it.href
          ? ` <a class="faq-more" href="${safeHref(it.href)}">${escapeHtml(it.href_label || 'Read the guide')}</a>`
          : '';
        return `<details><summary>${escapeHtml(it.q)}</summary><p>${escapeHtml(it.a)}${more}</p></details>`;
      })
      .join('')}</section>`;
  }
  if (s.type === 'note') {
    return `<section class="note"><p>${escapeHtml(s.text)}</p></section>`;
  }
  if (s.type === 'showcase') {
    // Visual proof band: real storefront screenshots. Same escaping discipline
    // as every other sink (safeHref on urls, escapeHtml on text); width/height
    // are numeric attributes so layout is reserved before the lazy image loads.
    const figs = (s.items || [])
      .map((it) => {
        // The FILE is the truth, the config is the fallback. These items
        // carried width="1360" height="900" for images that are actually
        // 1200x630. That aspect ratio is 26% wrong, reserving a box the
        // image never fills. A declared number drifts the moment the art is
        // re-exported; a measured one cannot.
        const measured = typeof sizeOf === 'function' ? sizeOf(it.img) : null;
        const w = measured ? measured.width : Number(it.width);
        const h = measured ? measured.height : Number(it.height);
        const dims =
          Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
            ? ` width="${w}" height="${h}"`
            : '';
        const img = `<img src="${safeHref(it.img)}" alt="${escapeHtml(it.alt || '')}" loading="lazy" decoding="async"${dims}>`;
        const fig = `<figure>${img}${it.caption ? `<figcaption>${escapeHtml(it.caption)}</figcaption>` : ''}</figure>`;
        return it.href ? `<a class="showcase-link" href="${safeHref(it.href)}">${fig}</a>` : fig;
      })
      .join('');
    return `<section class="showcase"><h2>${escapeHtml(s.title)}</h2>${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ''}<div class="showcase-grid">${figs}</div></section>`;
  }
  return '';
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });

  const config = JSON.parse(read(path.join(ROOT, 'store.config.json')));
  const themeDir = path.join(ROOT, 'themes', config.theme || 'stand');
  const layout = read(path.join(themeDir, 'layout.html'));

  const problems = []; // fatal: the build refuses to ship a store this broken
  const warnings = []; // non-fatal, but printed on EVERY build, never silent
  for (const problem of configProblems(config)) problems.push(`store.config.json: ${problem}`);
  const products = listMd(path.join(ROOT, 'products')).map((f) => {
    const { data, body, error } = parseFrontmatter(read(path.join(ROOT, 'products', f)));
    if (error) problems.push(`products/${f}: ${error}`);
    for (const problem of productProblems(data)) problems.push(`products/${f}: ${problem}`);
    // The social card, when it is named explicitly, is a deliberate choice,
    // so a broken one is a build error, not something to paper over. Checked
    // HERE rather than where the card is emitted, because that happens after
    // the problem gate has already run.
    if (data.og_image) {
      const bare = String(data.og_image).split(/[?#]/)[0];
      if (!/\.(png|jpe?g|gif)$/i.test(bare)) {
        problems.push(`products/${f}: og_image must be .png/.jpg/.gif: link-preview scrapers do not reliably render anything else`);
      } else if (!/^https?:\/\//i.test(bare) && !fs.existsSync(path.join(ROOT, bare.replace(/^\.?\//, '')))) {
        problems.push(`products/${f}: og_image "${data.og_image}" does not exist`);
      }
    }
    return { ...data, features: data.features || [], body, html: renderMarkdown(body, MD_OPTS) };
  }).sort((a, b) => (Number(a.order || 999) - Number(b.order || 999)) || String(a.name).localeCompare(b.name, 'en'));
  const ids = new Set();
  for (const p of products) {
    if (ids.has(p.id)) problems.push(`products: duplicate id "${p.id}" (pages would overwrite each other)`);
    ids.add(p.id);
  }

  const pages = listMd(path.join(ROOT, 'pages')).map((f) => {
    const { data, body, error } = parseFrontmatter(read(path.join(ROOT, 'pages', f)));
    if (error) problems.push(`pages/${f}: ${error}`);
    const slug = f.replace(/\.md$/, '');
    return {
      slug,
      title: data.title || f,
      meta_title: data.meta_title,
      description: data.description,
      body,
      html: renderMarkdown(body, MD_OPTS),
    };
  });

  // Published docs, in PUBLISHED_DOCS order. Links are rewritten before the
  // markdown is rendered so sibling-doc references resolve on the site.
  const docsDir = path.join(ROOT, 'docs');
  const docs = PUBLISHED_DOCS.flatMap((slug) => {
    const file = path.join(docsDir, `${slug}.md`);
    if (!fs.existsSync(file)) {
      problems.push(`docs/${slug}.md: listed in PUBLISHED_DOCS but missing`);
      return [];
    }
    const raw = read(file);
    const { title, body } = docTitle(raw, slug);
    const src = rewriteDocLinks(body, { repo: config.repo });
    return [{ slug, title, body: src, html: renderMarkdown(src, MD_OPTS) }];
  });

  problems.push(...slugProblems(ids, pages.map((p) => p.slug)));
  // Docs share the flat output namespace with products and pages.
  problems.push(...slugProblems(ids, docs.map((d) => d.slug), { dir: 'docs' }));
  problems.push(...slugProblems(
    new Set(pages.map((p) => p.slug)),
    docs.map((d) => d.slug),
    { dir: 'docs', what: 'page slug' }
  ));
  problems.push(...templateProblems(config, products));
  if (problems.length) {
    console.error(`build: fix your store config and frontmatter first:\n  ${problems.join('\n  ')}`);
    process.exit(2);
  }

  const site = config.url.replace(/\/$/, '');
  // Sitemap <lastmod> / Article dateModified: honor a pinned BUILD_DATE (CI
  // can pass one for reproducible builds), else today, same determinism
  // level as the {{year}} already in the footer.
  const buildDate = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BUILD_DATE || '')
    ? process.env.BUILD_DATE
    : new Date().toISOString().slice(0, 10);
  // Default social card: config override > the configured theme's real
  // storefront screenshot (raster, because scrapers don't render SVG) > the logo.
  const themePreview = `assets/previews/${config.theme || 'stand'}.png`;
  const defaultOgImage = config.og_image
    ? absUrl(site, config.og_image)
    : fs.existsSync(path.join(ROOT, themePreview))
      ? `${site}/${themePreview}`
      : fs.existsSync(path.join(ROOT, 'assets', 'logo.svg'))
        ? `${site}/assets/logo.svg`
        : null;
  const guides = guideSlugs(config.sections);

  const fill = (vars) => tpl(layout, vars);

  const ledgerFile = path.join(ROOT, 'ledger', 'ledger.json');
  const hasLedger = fs.existsSync(ledgerFile);

  function page({ title, description, slug, content, bodyClass = '', ogTitle, ogType = 'website', ogImage = defaultOgImage, jsonLd, noindex = false }) {
    const nav = [
      `<a href="./">Store</a>`,
      ...(docs.length ? [`<a href="./docs.html">Docs</a>`] : []),
      ...(hasLedger ? [`<a href="./trust.html">Ledger</a>`] : []),
      ...(config.repo ? [`<a href="https://github.com/${escapeHtml(config.repo)}">GitHub</a>`] : []),
    ].join('');
    const footer = pages
      .map((p) => `<a href="./${escapeHtml(p.slug)}.html">${escapeHtml(p.title)}</a>`)
      .join(' · ');
    const canonical = `${site}/${slug === 'index' ? '' : slug + '.html'}`;
    const desc = description || config.meta_description || config.tagline || '';
    let out = fill({
      lang: 'en',
      title: escapeHtml(title),
      description: escapeHtml(desc),
      canonical: escapeHtml(canonical),
      store_name: escapeHtml(config.name),
      nav,
      content,
      footer,
      seller: escapeHtml(config.seller || ''),
      year: String(new Date().getFullYear()),
      body_class: bodyClass,
    });
    // Social cards: the layouts hardcode og:title/og:description/og:type, so
    // set them in place (og:title without the " · Store" suffix; the site
    // name lives in og:site_name) and append what they lack.
    const shareTitle = ogTitle || title;
    out = setMeta(out, 'property', 'og:type', ogType);
    out = setMeta(out, 'property', 'og:title', shareTitle);
    out = injectHead(out, [
      `<meta property="og:url" content="${escapeHtml(canonical)}">`,
      `<meta property="og:site_name" content="${escapeHtml(config.name)}">`,
      ...(ogImage ? [`<meta property="og:image" content="${escapeHtml(ogImage)}">`] : []),
      `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`,
      `<meta name="twitter:title" content="${escapeHtml(shareTitle)}">`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
      ...(ogImage ? [`<meta name="twitter:image" content="${escapeHtml(ogImage)}">`] : []),
      ...(noindex ? ['<meta name="robots" content="noindex">'] : []),
      ...(jsonLd ? [jsonLdScript(jsonLd)] : []),
    ].join('\n'));
    return decoratePage(out);
  }

  // ---------- home ----------
  const hero = `<section class="hero">
  <p class="kicker">${escapeHtml(config.kicker || '')}</p>
  <h1>${escapeHtml(config.headline || config.name)}</h1>
  <p class="lede">${escapeHtml(config.tagline)}</p>
  <div class="hero-ctas">
    ${products[0] ? buyButton(products[0], true) : ''}
    ${config.repo ? `<a class="btn btn-ghost" href="https://github.com/${escapeHtml(config.repo)}">Read the engine on GitHub</a>` : ''}
  </div>
  <p class="hero-sub">${escapeHtml(config.subline || '')}</p>
</section>`;

  const home =
    hero +
    `<section class="products">${products.map((p, i) => productCard(p, i === 0 ? 'flagship' : 'companion')).join('')}</section>` +
    (config.sections || []).map(section).join('\n');

  write(path.join(DIST, 'index.html'), page({
    // meta_title (config-optional) wins verbatim: Google shows ~60 chars and
    // the name+tagline default blows well past it.
    title: config.meta_title || `${config.name} · ${config.tagline}`,
    ogTitle: config.headline || config.name,
    slug: 'index',
    content: home,
    bodyClass: 'home',
    jsonLd: homeJsonLd(config, fs.existsSync(path.join(ROOT, 'assets', 'logo.svg')) ? `${site}/assets/logo.svg` : null),
  }));

  // ---------- product pages ----------
  for (const p of products) {
    const content = `<article class="product-page">
  <p class="kicker">${escapeHtml(config.name)}</p>
  <h1>${escapeHtml(p.name)}</h1>
  <p class="lede">${escapeHtml(p.tagline || '')}</p>
  <div class="pc-buy standalone"><span class="price">${escapeHtml(p.price)}<small> ${escapeHtml(p.price_note || '')}</small></span>${buyButton(p)}</div>
  <div class="prose">${p.html}</div>
  <div class="pc-buy standalone">${buyButton(p, true)}</div>
</article>`;
    // The social card, decided in three explicit steps rather than inherited
    // from whatever image happens to be first in the body.
    //
    // The failure this replaces: the gallery moved to WebP, firstRasterImage
    // found nothing a scraper could decode, and the card SILENTLY fell back to
    // the theme preview. The page still built green while the product's link
    // preview quietly changed. That is the same shape as every bug worth fixing
    // here, where the system reports success and does something else.
    //
    // Scraper-safe formats only: a card scraper that cannot decode WebP shows
    // no preview at all, and a blank card costs more than the bytes WebP saves.
    // Those bytes are not on the critical path anyway: a card image is fetched
    // by scrapers, never by a visitor loading the page.
    const OG_SAFE = /\.(png|jpe?g|gif)$/i;
    let ogImage;
    if (p.og_image) {
      ogImage = absUrl(site, p.og_image); // validated before the gate, below
    } else {
      const bodyImage = firstRasterImage(p.body, { ext: OG_SAFE });
      ogImage = bodyImage ? absUrl(site, bodyImage) : defaultOgImage;
      // The page HAS pictures, none of them usable as a card, and nobody chose
      // one. Say so on every build instead of substituting in silence.
      if (!bodyImage && firstRasterImage(p.body)) {
        warnings.push(
          `products/${p.id}: every image in the body is a format link-preview scrapers ` +
            `do not reliably render, so the card fell back to ${defaultOgImage}. ` +
            `Set "og_image:" in the frontmatter to choose one deliberately.`
        );
      }
    }
    write(path.join(DIST, `${p.id}.html`), page({
      title: p.meta_title || `${p.name} · ${config.name}`,
      ogTitle: p.name,
      // frontmatter description > tagline > first paragraph (page() falls
      // back to config.tagline last)
      description: p.description || p.tagline || excerpt(p.body),
      slug: p.id,
      content,
      ogType: 'product',
      ogImage,
      jsonLd: productJsonLd(p, config, ogImage),
    }));
  }

  // ---------- markdown pages ----------
  for (const p of pages) {
    const isGuide = guides.has(p.slug);
    const url = `${site}/${p.slug}.html`;
    // frontmatter description > first paragraph (page() falls back to
    // config.tagline last)
    const desc = p.description || excerpt(p.body);
    write(
      path.join(DIST, `${p.slug}.html`),
      page({
        title: p.meta_title || `${p.title} · ${config.name}`,
        ogTitle: p.title,
        description: desc,
        slug: p.slug,
        content: `<article class="prose"><h1>${escapeHtml(p.title)}</h1>${p.html}</article>`,
        ogType: isGuide ? 'article' : 'website',
        jsonLd: isGuide
          ? articleJsonLd({ title: p.title, description: desc, url, config, image: defaultOgImage, dateModified: buildDate })
          : undefined,
      })
    );
  }

  // ---------- docs ----------
  for (const d of docs) {
    const url = `${site}/${d.slug}.html`;
    const desc = excerpt(d.body);
    write(
      path.join(DIST, `${d.slug}.html`),
      page({
        title: `${d.title} · ${config.name}`,
        ogTitle: d.title,
        description: desc,
        slug: d.slug,
        content: `<article class="prose doc"><h1>${escapeHtml(d.title)}</h1>${d.html}</article>`,
        ogType: 'article',
        jsonLd: articleJsonLd({ title: d.title, description: desc, url, config, image: defaultOgImage, dateModified: buildDate }),
      })
    );
  }

  if (docs.length) {
    const list = docs
      .map(
        (d) =>
          `<li><h3><a href="./${escapeHtml(d.slug)}.html">${escapeHtml(d.title)}</a></h3><p>${escapeHtml(excerpt(d.body))}</p></li>`
      )
      .join('');
    write(path.join(DIST, 'docs.html'), page({
      title: `Docs · ${config.name}`,
      ogTitle: 'Docs',
      description: `How ${config.name} works, how to set it up, what it can and cannot do.`,
      slug: 'docs',
      content: `<article class="prose"><h1>Docs</h1>
<p class="lede">How it works, how to run it, and where the limits are. The same
files that ship in the repo.</p>
<ol class="doc-list">${list}</ol></article>`,
    }));
  }

  // ---------- trust / ledger page (opt-in: only if ledger/ledger.json exists) ----------
  if (hasLedger) {
    const ledger = JSON.parse(read(ledgerFile));
    const trust = trustArticle(ledger);
    write(path.join(DIST, 'trust.html'), page({
      title: `Public ledger · ${config.name}`,
      ogTitle: 'Public ledger',
      description: 'Every sale this store makes (date, product, amount, buyer country), committed publicly by the fulfillment bot. No names, no emails.',
      slug: 'trust',
      content: trust,
    }));
    write(path.join(DIST, 'ledger', 'ledger.json'), JSON.stringify(ledger, null, 2));
  }

  // ---------- static passthroughs ----------
  const assetsDir = path.join(ROOT, 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(DIST, 'assets'), { recursive: true });
  }
  const staticDir = path.join(ROOT, 'static');
  if (fs.existsSync(staticDir)) {
    for (const f of fs.readdirSync(staticDir)) fs.copyFileSync(path.join(staticDir, f), path.join(DIST, f));
  }
  fs.copyFileSync(path.join(themeDir, 'style.css'), path.join(DIST, 'style.css'));
  const favicon = path.join(themeDir, 'favicon.svg');
  if (fs.existsSync(favicon)) fs.copyFileSync(favicon, path.join(DIST, 'favicon.svg'));
  write(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
  const sitemapEntries = [
    { path: '', lastmod: buildDate, priority: 1.0 },
    ...(hasLedger ? [{ path: 'trust.html', lastmod: buildDate, priority: 0.5 }] : []),
    ...products.map((p) => ({ path: `${p.id}.html`, lastmod: buildDate, priority: 0.9 })),
    ...pages.map((p) => ({ path: `${p.slug}.html`, lastmod: buildDate, priority: guides.has(p.slug) ? 0.7 : 0.3 })),
    ...(docs.length ? [{ path: 'docs.html', lastmod: buildDate, priority: 0.6 }] : []),
    ...docs.map((d) => ({ path: `${d.slug}.html`, lastmod: buildDate, priority: 0.7 })),
  ];
  write(path.join(DIST, 'sitemap.xml'), sitemapXml(site, sitemapEntries));
  write(path.join(DIST, '404.html'), page({ title: `Not found · ${config.name}`, slug: '404', content: `<article class="prose"><h1>Nothing at this stand</h1><p>That page doesn't exist. <a href="./">Back to the store.</a></p></article>`, noindex: true }));
  write(path.join(DIST, '.nojekyll'), '');

  // Printed at the END, after the pages that generate them have been written.
  // Not fatal, but a silent fallback is how the product's social card changed
  // without anyone deciding to change it. A green build still has to say so.
  for (const w of warnings) console.error(`build: WARN ${w}`);
  console.log(`built dist/: ${products.length} product(s), ${pages.length} page(s), ${docs.length} doc(s), ledger page: ${hasLedger ? 'on' : 'off'}`);
}

module.exports = {
  escapeHtml, buyButton, productCard, productProblems, configProblems, slugProblems, templateProblems, isUpstreamStore, section,
  usdPrice, absUrl, tpl, injectHead, setMeta, jsonLdScript, guideSlugs, trustArticle,
  productJsonLd, homeJsonLd, articleJsonLd, sitemapXml, decoratePage,
  PUBLISHED_DOCS, docTitle, rewriteDocLinks,
};

if (require.main === module) main();
