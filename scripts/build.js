#!/usr/bin/env node
// HonorBox static site builder: store.config.json + products/*.md + pages/*.md
// + themes/<theme>/ -> dist/. Zero dependencies.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./lib/fm.js');
const { renderMarkdown, escapeHtml, excerpt, firstRasterImage } = require('./lib/md.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

// Href for an HTML attribute from a config-authored URL: neutralize any scheme
// that isn't http(s)/relative/anchor (blocks javascript:), then attribute-escape.
// Same discipline the markdown renderer applies to link/image URLs.
function safeHref(url) {
  const u = String(url == null ? '' : url);
  return escapeHtml(/^(https?:\/\/|\/|#|\.)/.test(u) ? u : '#');
}

// ---------- SEO / social plumbing (pure helpers, covered by core.test.js) ----------

// "$29" / "$29.50" -> "29" / "29.50" for schema.org offers. Null when the
// frontmatter price isn't a plain USD amount — then the offer is honestly
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

function injectHead(html, block) {
  return html.includes('</head>') ? html.replace('</head>', `${block}\n</head>`) : html;
}

// Set a <meta ... content="..."> value: replace in place when the theme layout
// already emits the tag (both themes hardcode og:type="website"), else append
// to <head>. Attribute-level only — themes own their markup.
function setMeta(html, attr, name, content) {
  const esc = escapeHtml(String(content));
  const re = new RegExp(`(<meta\\s+${attr}="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+content=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, `$1${esc}$2`);
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

// entries: [{ path, lastmod, priority }] — path relative to the site root.
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
  if (out.includes('<main id="main">')) {
    out = out.replace(/(<body[^>]*>)/, '$1\n<a class="skip-link" href="#main">Skip to content</a>');
    out = injectHead(out, SKIP_LINK_STYLE);
  }
  return out;
}

function buyButton(p, big = false) {
  if (!p.payment_link || typeof p.payment_link !== 'string') {
    return `<span class="btn btn-disabled" title="Checkout not configured yet">Checkout coming soon</span>`;
  }
  return `<a class="btn btn-buy${big ? ' btn-big' : ''}" href="${escapeHtml(p.payment_link)}">Buy ${escapeHtml(p.name)} — ${escapeHtml(p.price)}</a>`;
}

function productCard(p) {
  return `<article class="product-card">
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

function section(s) {
  if (s.type === 'steps') {
    return `<section class="steps"><h2>${escapeHtml(s.title)}</h2><ol class="steps-list">${s.items
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
    return `<section class="compare"><h2>${escapeHtml(s.title)}</h2>${s.note ? `<p class="muted">${escapeHtml(s.note)}</p>` : ''}<div class="table-scroll"><table>${head}${rows}</table></div></section>`;
  }
  if (s.type === 'faq') {
    return `<section class="faq"><h2>${escapeHtml(s.title)}</h2>${s.items
      .map((it) => `<details><summary>${escapeHtml(it.q)}</summary><p>${escapeHtml(it.a)}</p></details>`)
      .join('')}</section>`;
  }
  if (s.type === 'note') {
    return `<section class="note"><p>${escapeHtml(s.text)}</p></section>`;
  }
  return '';
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });

  const config = JSON.parse(read(path.join(ROOT, 'store.config.json')));
  const themeDir = path.join(ROOT, 'themes', config.theme || 'stand');
  const layout = read(path.join(themeDir, 'layout.html'));

  const products = listMd(path.join(ROOT, 'products')).map((f) => {
    const { data, body } = parseFrontmatter(read(path.join(ROOT, 'products', f)));
    return { ...data, features: data.features || [], body, html: renderMarkdown(body) };
  }).sort((a, b) => (Number(a.order || 999) - Number(b.order || 999)) || String(a.name).localeCompare(b.name));

  const pages = listMd(path.join(ROOT, 'pages')).map((f) => {
    const { data, body } = parseFrontmatter(read(path.join(ROOT, 'pages', f)));
    return {
      slug: f.replace(/\.md$/, ''),
      title: data.title || f,
      meta_title: data.meta_title,
      description: data.description,
      body,
      html: renderMarkdown(body),
    };
  });

  const site = config.url.replace(/\/$/, '');
  // Sitemap <lastmod> / Article dateModified: honor a pinned BUILD_DATE (CI
  // can pass one for reproducible builds), else today — same determinism
  // level as the {{year}} already in the footer.
  const buildDate = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BUILD_DATE || '')
    ? process.env.BUILD_DATE
    : new Date().toISOString().slice(0, 10);
  // Default social card: config override > the configured theme's real
  // storefront screenshot (raster — scrapers don't render SVG) > the logo.
  const themePreview = `assets/previews/${config.theme || 'stand'}.png`;
  const defaultOgImage = config.og_image
    ? absUrl(site, config.og_image)
    : fs.existsSync(path.join(ROOT, themePreview))
      ? `${site}/${themePreview}`
      : fs.existsSync(path.join(ROOT, 'assets', 'logo.svg'))
        ? `${site}/assets/logo.svg`
        : null;
  const guides = guideSlugs(config.sections);

  function tpl(vars) {
    let out = layout;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
    return out;
  }

  const ledgerFile = path.join(ROOT, 'ledger', 'ledger.json');
  const hasLedger = fs.existsSync(ledgerFile);

  function page({ title, description, slug, content, bodyClass = '', ogTitle, ogType = 'website', ogImage = defaultOgImage, jsonLd, noindex = false }) {
    const nav = [
      `<a href="./">Store</a>`,
      ...(hasLedger ? [`<a href="./trust.html">Ledger</a>`] : []),
      ...(config.repo ? [`<a href="https://github.com/${escapeHtml(config.repo)}">GitHub</a>`] : []),
    ].join('');
    const footer = pages
      .map((p) => `<a href="./${escapeHtml(p.slug)}.html">${escapeHtml(p.title)}</a>`)
      .join(' · ');
    const canonical = `${site}/${slug === 'index' ? '' : slug + '.html'}`;
    const desc = description || config.tagline || '';
    let out = tpl({
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
    // set them in place (og:title without the " — Store" suffix; the site
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
    ${config.repo ? `<a class="btn btn-ghost" href="https://github.com/${escapeHtml(config.repo)}">Star the free core</a>` : ''}
  </div>
  <p class="hero-sub">${escapeHtml(config.subline || '')}</p>
</section>`;

  const home =
    hero +
    `<section class="products">${products.map(productCard).join('')}</section>` +
    (config.sections || []).map(section).join('\n');

  write(path.join(DIST, 'index.html'), page({
    // meta_title (config-optional) wins verbatim: Google shows ~60 chars and
    // the name+tagline default blows well past it.
    title: config.meta_title || `${config.name} — ${config.tagline}`,
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
    const bodyImage = firstRasterImage(p.body);
    const ogImage = bodyImage ? absUrl(site, bodyImage) : defaultOgImage;
    write(path.join(DIST, `${p.id}.html`), page({
      title: p.meta_title || `${p.name} — ${config.name}`,
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
        title: p.meta_title || `${p.title} — ${config.name}`,
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

  // ---------- trust / ledger page (opt-in: only if ledger/ledger.json exists) ----------
  if (hasLedger) {
    const ledger = JSON.parse(read(ledgerFile));
    const ledgerRows = (ledger.rows || [])
      .slice()
      .reverse()
      .map(
        (r) =>
          `<tr${r.needs_attention ? ' class="attn"' : ''}><td>${escapeHtml(r.ts.slice(0, 10))}</td><td>${escapeHtml(r.product)}</td><td class="num">${r.amount.toFixed(2)} ${escapeHtml(r.currency)}</td><td>${escapeHtml(r.country || '—')}</td><td class="num">${escapeHtml(r.ref)}</td></tr>`
      )
      .join('');
    const trust = `<article class="prose trust">
<h1>Public ledger</h1>
<p>Every sale this store makes is committed here by the fulfillment bot — date, product, amount,
buyer country, and an anonymous reference. No names, no emails.</p>
<p class="ledger-total"><strong>${ledger.total_sales || 0}</strong> sales recorded · last updated ${escapeHtml((ledger.updated || 'never').slice(0, 16).replace('T', ' '))} UTC</p>
<div class="table-scroll"><table class="ledger">
<tr><th scope="col">Date</th><th scope="col">Product</th><th scope="col">Amount</th><th scope="col">Country</th><th scope="col">Ref</th></tr>
${ledgerRows || '<tr><td colspan="5" class="muted">No sales yet. The box is open.</td></tr>'}
</table></div>
<p class="muted">Raw data: <a href="./ledger/ledger.json">ledger.json</a> · Updated on every fulfillment run.</p>
</article>`;
    write(path.join(DIST, 'trust.html'), page({
      title: `Public ledger — ${config.name}`,
      ogTitle: 'Public ledger',
      description: 'Every sale this store makes — date, product, amount, and buyer country — committed publicly by the fulfillment bot. No names, no emails.',
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
  ];
  write(path.join(DIST, 'sitemap.xml'), sitemapXml(site, sitemapEntries));
  write(path.join(DIST, '404.html'), page({ title: `Not found — ${config.name}`, slug: '404', content: `<article class="prose"><h1>Nothing at this stand</h1><p>That page doesn't exist. <a href="./">Back to the store.</a></p></article>`, noindex: true }));
  write(path.join(DIST, '.nojekyll'), '');

  console.log(`built dist/: ${products.length} product(s), ${pages.length} page(s), ledger page: ${hasLedger ? 'on' : 'off'}`);
}

module.exports = {
  escapeHtml, buyButton, productCard, section,
  usdPrice, absUrl, injectHead, setMeta, jsonLdScript, guideSlugs,
  productJsonLd, homeJsonLd, articleJsonLd, sitemapXml, decoratePage,
};

if (require.main === module) main();
