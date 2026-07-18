#!/usr/bin/env node
// HonorBox static site builder: store.config.json + products/*.md + pages/*.md
// + themes/<theme>/ -> dist/. Zero dependencies.
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./lib/fm.js');
const { renderMarkdown, escapeHtml } = require('./lib/md.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

fs.rmSync(DIST, { recursive: true, force: true });

const config = JSON.parse(read(path.join(ROOT, 'store.config.json')));
const themeDir = path.join(ROOT, 'themes', config.theme || 'stand');
const layout = read(path.join(themeDir, 'layout.html'));

const products = listMd(path.join(ROOT, 'products')).map((f) => {
  const { data, body } = parseFrontmatter(read(path.join(ROOT, 'products', f)));
  return { ...data, features: data.features || [], html: renderMarkdown(body) };
});

const pages = listMd(path.join(ROOT, 'pages')).map((f) => {
  const { data, body } = parseFrontmatter(read(path.join(ROOT, 'pages', f)));
  return { slug: f.replace(/\.md$/, ''), title: data.title || f, html: renderMarkdown(body) };
});

function tpl(vars) {
  let out = layout;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

const ledgerFile = path.join(ROOT, 'ledger', 'ledger.json');
const hasLedger = fs.existsSync(ledgerFile);

function page({ title, description, slug, content, bodyClass = '' }) {
  const nav = [
    `<a href="./">Store</a>`,
    ...(hasLedger ? [`<a href="./trust.html">Ledger</a>`] : []),
    ...(config.repo ? [`<a href="https://github.com/${config.repo}">GitHub</a>`] : []),
  ].join('');
  const footer = pages
    .map((p) => `<a href="./${p.slug}.html">${escapeHtml(p.title)}</a>`)
    .join(' · ');
  return tpl({
    lang: 'en',
    title: escapeHtml(title),
    description: escapeHtml(description || config.tagline || ''),
    canonical: `${config.url.replace(/\/$/, '')}/${slug === 'index' ? '' : slug + '.html'}`,
    store_name: escapeHtml(config.name),
    nav,
    content,
    footer,
    seller: escapeHtml(config.seller || ''),
    year: String(new Date().getFullYear()),
    body_class: bodyClass,
  });
}

function buyButton(p, big = false) {
  if (!p.payment_link || typeof p.payment_link !== 'string') {
    return `<span class="btn btn-disabled" title="Checkout not configured yet">Checkout coming soon</span>`;
  }
  return `<a class="btn btn-buy${big ? ' btn-big' : ''}" href="${p.payment_link}">Buy ${escapeHtml(p.name)} — ${escapeHtml(p.price)}</a>`;
}

function productCard(p) {
  return `<article class="product-card">
  <div class="pc-head">
    ${p.badge ? `<span class="badge">${escapeHtml(p.badge)}</span>` : ''}
    <h3><a href="./${p.id}.html">${escapeHtml(p.name)}</a></h3>
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
      .map((it) => `<li><h3>${escapeHtml(it.title)}</h3><p>${escapeHtml(it.text)}</p></li>`)
      .join('')}</ol></section>`;
  }
  if (s.type === 'compare') {
    const head = `<tr>${s.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
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

// ---------- home ----------
const hero = `<section class="hero">
  <p class="kicker">${escapeHtml(config.kicker || '')}</p>
  <h1>${escapeHtml(config.headline || config.name)}</h1>
  <p class="lede">${escapeHtml(config.tagline)}</p>
  <div class="hero-ctas">
    ${products[0] ? buyButton(products[0], true) : ''}
    ${config.repo ? `<a class="btn btn-ghost" href="https://github.com/${config.repo}">Star the free core</a>` : ''}
  </div>
  <p class="hero-sub">${escapeHtml(config.subline || '')}</p>
</section>`;

const home =
  hero +
  `<section class="products">${products.map(productCard).join('')}</section>` +
  (config.sections || []).map(section).join('\n');

write(path.join(DIST, 'index.html'), page({ title: `${config.name} — ${config.tagline}`, slug: 'index', content: home, bodyClass: 'home' }));

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
  write(path.join(DIST, `${p.id}.html`), page({ title: `${p.name} — ${config.name}`, description: p.tagline, slug: p.id, content }));
}

// ---------- markdown pages ----------
for (const p of pages) {
  write(
    path.join(DIST, `${p.slug}.html`),
    page({ title: `${p.title} — ${config.name}`, slug: p.slug, content: `<article class="prose"><h1>${escapeHtml(p.title)}</h1>${p.html}</article>` })
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
<tr><th>Date</th><th>Product</th><th>Amount</th><th>Country</th><th>Ref</th></tr>
${ledgerRows || '<tr><td colspan="5" class="muted">No sales yet. The box is open.</td></tr>'}
</table></div>
<p class="muted">Raw data: <a href="./ledger/ledger.json">ledger.json</a> · Updated on every fulfillment run.</p>
</article>`;
write(path.join(DIST, 'trust.html'), page({ title: `Public ledger — ${config.name}`, slug: 'trust', content: trust }));
write(path.join(DIST, 'ledger', 'ledger.json'), JSON.stringify(ledger, null, 2));
}

// ---------- static passthroughs ----------
fs.copyFileSync(path.join(themeDir, 'style.css'), path.join(DIST, 'style.css'));
const favicon = path.join(themeDir, 'favicon.svg');
if (fs.existsSync(favicon)) fs.copyFileSync(favicon, path.join(DIST, 'favicon.svg'));
write(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${config.url.replace(/\/$/, '')}/sitemap.xml\n`);
const urls = ['', ...(hasLedger ? ['trust.html'] : []), ...products.map((p) => `${p.id}.html`), ...pages.map((p) => `${p.slug}.html`)];
write(
  path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${config.url.replace(/\/$/, '')}/${u}</loc></url>`)
    .join('\n')}\n</urlset>\n`
);
write(path.join(DIST, '404.html'), page({ title: `Not found — ${config.name}`, slug: '404', content: `<article class="prose"><h1>Nothing at this stand</h1><p>That page doesn't exist. <a href="./">Back to the store.</a></p></article>` }));
write(path.join(DIST, '.nojekyll'), '');

console.log(`built dist/: ${products.length} product(s), ${pages.length} page(s), ledger page: ${hasLedger ? 'on' : 'off'}`);
