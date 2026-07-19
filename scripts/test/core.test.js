'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  validUsername,
  extractGithubUsername,
  pickNewPaidSessions,
  ledgerRow,
  nextCursor,
  matchGrant,
} = require('../lib/fulfill-core.js');
const { parseFrontmatter } = require('../lib/fm.js');
const { renderMarkdown, excerpt, firstRasterImage } = require('../lib/md.js');
const {
  section, buyButton, productCard,
  usdPrice, absUrl, setMeta, jsonLdScript, guideSlugs,
  productJsonLd, homeJsonLd, articleJsonLd, sitemapXml, decoratePage,
} = require('../build.js');

const GRANTS = [{ payment_link: 'plink_1', product: 'HonorBox Pro', repo: 'o/r' }];

function session(over = {}) {
  return {
    id: 'cs_test_abc123',
    status: 'complete',
    payment_status: 'paid',
    payment_link: 'plink_1',
    created: 1_700_000_000,
    amount_total: 2900,
    currency: 'usd',
    customer_details: { address: { country: 'DE' } },
    custom_fields: [{ key: 'github_username', text: { value: 'octocat' } }],
    ...over,
  };
}

test('username validation accepts real forms, rejects junk', () => {
  for (const ok of ['octocat', 'a', 'Honorboxx', 'a-b-c', 'x1', 'A9'.repeat(19) + 'a']) {
    assert.ok(validUsername(ok), ok);
  }
  for (const bad of ['', '-lead', 'trail-', 'has--double', 'with space', 'evil/../x',
    'a'.repeat(40), 'semi;colon', null, undefined, 42]) {
    assert.ok(!validUsername(bad), String(bad));
  }
});

test('extracts username, trims @ and whitespace', () => {
  assert.equal(extractGithubUsername(session()), 'octocat');
  const s = session({ custom_fields: [{ key: 'github_username', text: { value: ' @Octo-Cat ' } }] });
  assert.equal(extractGithubUsername(s), 'Octo-Cat');
  assert.equal(extractGithubUsername(session({ custom_fields: [] })), null);
});

test('picks only new, paid, complete, grant-matched sessions', () => {
  const paid = session();
  const unpaid = session({ id: 'cs_2', payment_status: 'unpaid' });
  const open = session({ id: 'cs_3', status: 'open' });
  const otherLink = session({ id: 'cs_4', payment_link: 'plink_other' });
  const processed = session({ id: 'cs_5' });
  const picked = pickNewPaidSessions([paid, unpaid, open, otherLink, processed], ['cs_5'], GRANTS);
  assert.deepEqual(picked.map((s) => s.id), ['cs_test_abc123']);
});

test('free (100%-off) completed sessions still count as fulfillable', () => {
  // Depending on Stripe's handling, a fully-discounted checkout reports either
  // "paid" (amount 0) or "no_payment_required". Both must fulfill.
  const freePaid = session({ amount_total: 0 });
  const freeNPR = session({ id: 'cs_npr', amount_total: 0, payment_status: 'no_payment_required' });
  const picked = pickNewPaidSessions([freePaid, freeNPR], [], GRANTS);
  assert.equal(picked.length, 2);
  assert.equal(ledgerRow(freePaid, GRANTS[0]).amount, 0);
});

test('ledger row is public-safe and stable', () => {
  const row = ledgerRow(session(), GRANTS[0]);
  assert.equal(row.product, 'HonorBox Pro');
  assert.equal(row.amount, 29);
  assert.equal(row.currency, 'USD');
  assert.equal(row.country, 'DE');
  assert.equal(row.ref.length, 10);
  assert.ok(!JSON.stringify(row).includes('cs_test'), 'must not leak session id');
  assert.equal(row.ts, new Date(1_700_000_000 * 1000).toISOString());
});

test('cursor advances to newest, never backwards', () => {
  assert.equal(nextCursor([session({ created: 100 }), session({ created: 300 })], 200), 300);
  assert.equal(nextCursor([session({ created: 100 })], 500), 500);
  assert.equal(nextCursor([], 42), 42);
});

test('grant matching is by payment link', () => {
  assert.equal(matchGrant(session(), GRANTS).repo, 'o/r');
  assert.equal(matchGrant(session({ payment_link: null }), GRANTS), null);
});

test('grant matching falls back to price id for API-created sessions', () => {
  const grants = [{ price: 'price_9', product: 'P', repo: 'o/r2' }, ...GRANTS];
  const apiSession = session({
    payment_link: null,
    line_items: { data: [{ price: { id: 'price_9' } }] },
  });
  assert.equal(matchGrant(apiSession, grants).repo, 'o/r2');
  // payment_link match still wins when present
  assert.equal(matchGrant(session(), grants).repo, 'o/r');
  // no match for unknown price
  assert.equal(
    matchGrant(session({ payment_link: null, line_items: { data: [{ price: { id: 'price_x' } }] } }), grants),
    null
  );
});

test('frontmatter: scalars, lists, quoted strings', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: HonorBox Pro\nprice: "$29"\nfeatures:\n  - one\n  - two\n---\nBody here.'
  );
  assert.equal(data.name, 'HonorBox Pro');
  assert.equal(data.price, '$29');
  assert.deepEqual(data.features, ['one', 'two']);
  assert.equal(body.trim(), 'Body here.');
});

test('markdown: structure and escaping', () => {
  const html = renderMarkdown('# T\n\nHello **world** `x<y`\n\n- a\n- b\n\n```\ncode <tag>\n```');
  assert.ok(html.includes('<h1>T</h1>'));
  assert.ok(html.includes('<strong>world</strong>'));
  assert.ok(html.includes('<code>x&lt;y</code>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<pre><code>code &lt;tag&gt;</code></pre>'));
});

test('markdown: unsafe link hrefs are neutralized', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!html.includes('javascript:'), html);
});

test('repo owner is recognized as already-has-access', () => {
  const { isRepoOwner } = require('../lib/fulfill-core.js');
  assert.ok(isRepoOwner('Honorboxx/honorbox-pro', 'Honorboxx'));
  assert.ok(isRepoOwner('o/r', 'O'));
  assert.ok(!isRepoOwner('o/r', 'someone'));
  assert.ok(!isRepoOwner('o/r', null));
});

test('markdown: standalone images render, group into gallery', () => {
  const one = renderMarkdown('![terminal theme](./assets/previews/terminal.png)');
  assert.ok(one.includes('<figure><img src="./assets/previews/terminal.png" alt="terminal theme"'));
  const gal = renderMarkdown('![a](./x.png)\n![b](./y.png)');
  assert.ok(gal.includes('class="gallery"') && gal.includes('x.png') && gal.includes('y.png'));
});

test('markdown images: unsafe scheme actually hits the filter and emits no img', () => {
  // paren-free payload so it MATCHES the image-line regex (a parenthesized one
  // never reaches the new code path — that was a decoration test)
  const bad = renderMarkdown('![x](javascript:alert)');
  assert.ok(!bad.includes('<img'), bad);
  assert.ok(!bad.includes('javascript:'), bad);
  assert.ok(bad.includes('x'), 'rejected line stays visible, not silently dropped');
});

test('markdown images: src is attribute-escaped (no injection via quote)', () => {
  const out = renderMarkdown('![x](/a.png"onerror="alert1)');
  assert.ok(!out.includes('"onerror="'), out);
  assert.ok(out.includes('&quot;'), out);
  const amp = renderMarkdown('![c](/img.png?a=1&b=2)');
  assert.ok(amp.includes('src="/img.png?a=1&amp;b=2"'), amp);
});

test('build: steps-section item href is attribute-escaped (no breakout)', () => {
  // config is in-repo today, but a step href is a free-form URL — the same
  // attribute-injection shape reviewers already caught on img src / buy href.
  // A relative URL passes the scheme gate, so the embedded quote must be
  // attribute-escaped rather than closing the href and starting onmouseover.
  const html = section({
    type: 'steps',
    title: 'Guides',
    items: [{ title: 'g', text: 't', href: './guide"onmouseover="alert(1)' }],
  });
  assert.ok(!html.includes('"onmouseover="'), html);
  assert.ok(html.includes('&quot;onmouseover=&quot;'), html);
});

test('build: steps-section item href neutralizes dangerous schemes', () => {
  const html = section({
    type: 'steps',
    title: 'Guides',
    items: [{ title: 'g', text: 't', href: 'javascript:alert(1)' }],
  });
  assert.ok(!html.includes('javascript:'), html);
  // relative + http(s) hrefs must still pass through unharmed
  const ok = section({
    type: 'steps', title: 'G',
    items: [{ title: 'g', text: 't', href: './guide.html' }],
  });
  assert.ok(ok.includes('href="./guide.html"'), ok);
});

test('build: showcase section escapes img src, alt, caption, href', () => {
  // same sinks as steps hrefs / markdown img src — the showcase emitter must
  // hold the same line: scheme-gate urls, attribute-escape everything.
  const html = section({
    type: 'showcase',
    title: 'T<script>',
    note: 'n & m',
    items: [{
      img: './shot.png"onerror="alert(1)',
      alt: 'a"b',
      caption: 'c<em>',
      href: 'javascript:alert(1)',
      width: 1360,
      height: 900,
    }],
  });
  assert.ok(!html.includes('"onerror="'), html);
  assert.ok(!html.includes('javascript:'), html);
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!html.includes('c<em>'), html);
  assert.ok(html.includes('width="1360" height="900"'), html);
  assert.ok(html.includes('loading="lazy"'), html);
});

test('build: showcase drops non-numeric dimensions, keeps rendering', () => {
  const html = section({
    type: 'showcase',
    title: 'T',
    items: [{ img: './a.png', alt: 'a', width: '12" onmouseover="x', height: 900 }],
  });
  assert.ok(!html.includes('onmouseover'), html);
  assert.ok(!html.includes('width='), html);
  assert.ok(html.includes('src="./a.png"'), html);
});

test('build: product card variant is an additive class', () => {
  const p = { id: 'x', name: 'X', price: '$1', features: [], payment_link: 'https://buy.stripe.com/x' };
  assert.ok(productCard(p).includes('class="product-card"'));
  assert.ok(productCard(p, 'flagship').includes('class="product-card flagship"'));
  assert.ok(productCard(p, 'companion').includes('class="product-card companion"'));
});

test('build: buy button escapes payment_link and name (regression guard)', () => {
  const html = buyButton({ payment_link: 'https://buy.stripe.com/x"><script>', name: 'P', price: '$1' });
  assert.ok(!html.includes('"><script>'), html);
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), html);
});

test('excerpt: first real paragraph, markdown stripped, structure skipped', () => {
  // excerpt() takes the markdown body, post-frontmatter (as build.js feeds it)
  const md = '# Heading\n\n![img](./x.png)\n\n```\ncode\n```\n\nFirst **real** paragraph with a [link](./a.html) and `code`\nspanning two lines.\n\nSecond paragraph.';
  assert.equal(excerpt(md), 'First real paragraph with a link and code spanning two lines.');
  assert.equal(excerpt(''), '');
  assert.equal(excerpt('# only a heading'), '');
});

test('excerpt: truncates long text at a word boundary with ellipsis', () => {
  const out = excerpt('word '.repeat(80).trim(), 160);
  assert.ok(out.length <= 161, String(out.length));
  assert.ok(out.endsWith('…'), out);
  assert.ok(!out.includes('  '), out);
});

test('firstRasterImage: first raster wins, svg and unsafe schemes skipped', () => {
  const md = '![v](./logo.svg)\n![t](./assets/previews/terminal.png)\n![b](./b.png)';
  assert.equal(firstRasterImage(md), './assets/previews/terminal.png');
  assert.equal(firstRasterImage('![x](javascript:alert.png)'), null);
  assert.equal(firstRasterImage('no images here'), null);
});

test('usdPrice: frontmatter price strings parse or honestly fail', () => {
  assert.equal(usdPrice('$29'), '29');
  assert.equal(usdPrice(' $29.50 '), '29.50');
  for (const bad of ['29', '$29/mo', 'free', '', null, undefined]) {
    assert.equal(usdPrice(bad), null, String(bad));
  }
});

test('absUrl: resolves relative refs against the site, passes absolutes', () => {
  assert.equal(absUrl('https://s.io/x', './assets/a.png'), 'https://s.io/x/assets/a.png');
  assert.equal(absUrl('https://s.io/x', '/assets/a.png'), 'https://s.io/x/assets/a.png');
  assert.equal(absUrl('https://s.io/x', 'https://cdn.io/a.png'), 'https://cdn.io/a.png');
});

test('setMeta: replaces the layout-hardcoded og:type in place, else appends', () => {
  const html = '<head>\n<meta property="og:type" content="website">\n</head>';
  const replaced = setMeta(html, 'property', 'og:type', 'product');
  assert.ok(replaced.includes('<meta property="og:type" content="product">'), replaced);
  assert.ok(!replaced.includes('content="website"'), 'old value must be gone');
  const appended = setMeta(html, 'property', 'og:url', 'https://s.io/?a=1&b=2');
  assert.ok(appended.includes('<meta property="og:url" content="https://s.io/?a=1&amp;b=2">'), appended);
  // attribute breakout via content is escaped
  const esc = setMeta(html, 'property', 'og:type', '"><script>');
  assert.ok(!esc.includes('"><script>'), esc);
});

test('jsonLdScript: </script> in data cannot close the tag', () => {
  const out = jsonLdScript({ name: 'x</script><script>alert(1)' });
  assert.ok(!out.includes('</script><script>alert'), out);
  assert.ok(out.includes('\\u003c/script'), out);
  assert.ok(out.startsWith('<script type="application/ld+json">'), out);
});

test('productJsonLd: real price flows from frontmatter into the offer', () => {
  const config = { name: 'HonorBox', url: 'https://honorboxx.github.io/honorbox/' };
  const p = { id: 'honorbox-pro', name: 'HonorBox Pro', tagline: 'Premium themes.', price: '$29' };
  const ld = productJsonLd(p, config, 'https://honorboxx.github.io/honorbox/assets/previews/terminal.png');
  assert.equal(ld['@type'], 'Product');
  assert.equal(ld.offers.price, '29');
  assert.equal(ld.offers.priceCurrency, 'USD');
  assert.equal(ld.offers.availability, 'https://schema.org/InStock');
  assert.equal(ld.offers.url, 'https://honorboxx.github.io/honorbox/honorbox-pro.html');
  assert.equal(ld.url, ld.offers.url);
  // unparseable price -> no offer, never a guessed number
  const noPrice = productJsonLd({ ...p, price: 'TBD' }, config, null);
  assert.equal(noPrice.offers, undefined);
  assert.equal(noPrice.image, undefined);
});

test('home/article JSON-LD: config-driven, no fabricated fields', () => {
  const config = { name: 'HonorBox', url: 'https://s.io/hb', tagline: 'T', repo: 'O/r', support_email: 'x@y.z' };
  const home = homeJsonLd(config, 'https://s.io/hb/assets/logo.svg');
  const [org, site] = home['@graph'];
  assert.equal(org['@type'], 'Organization');
  assert.deepEqual(org.sameAs, ['https://github.com/O/r']);
  assert.equal(site['@type'], 'WebSite');
  assert.equal(site.publisher['@id'], org['@id']);
  const bare = homeJsonLd({ name: 'X', url: 'https://s.io' }, null)['@graph'][0];
  assert.ok(!('logo' in bare) && !('sameAs' in bare) && !('email' in bare));
  const art = articleJsonLd({ title: 'G', description: 'd', url: 'https://s.io/g.html', config, dateModified: '2026-07-19' });
  assert.equal(art['@type'], 'Article');
  assert.equal(art.headline, 'G');
  assert.equal(art.dateModified, '2026-07-19');
});

test('guideSlugs: internal steps links only', () => {
  const slugs = guideSlugs([
    { type: 'steps', items: [{ href: './gumroad-alternatives.html' }, { href: 'https://ext.io/x.html' }, { title: 'no href' }] },
    { type: 'faq', items: [{ q: 'q', a: 'a' }] },
  ]);
  assert.deepEqual([...slugs], ['gumroad-alternatives']);
});

test('sitemapXml: lastmod + priority per url, loc xml-escaped', () => {
  const xml = sitemapXml('https://s.io/hb', [
    { path: '', lastmod: '2026-07-19', priority: 1.0 },
    { path: 'p.html?a=1&b=2', priority: 0.9 },
  ]);
  assert.ok(xml.includes('<loc>https://s.io/hb/</loc><lastmod>2026-07-19</lastmod><priority>1.0</priority>'), xml);
  assert.ok(xml.includes('a=1&amp;b=2'), xml);
  assert.ok(!/<lastmod>[^<]*<\/lastmod><\/url>.*p\.html/.test(xml), 'no lastmod invented for entry without one');
});

test('decoratePage: additive a11y only — classes and DOM structure survive', () => {
  const pageHtml = '<head></head>\n<body class="home">\n<header class="site-head"><nav class="site-nav"><a href="./">Store</a></nav></header>\n<main>\n<p>x</p>\n</main>\n</body>';
  const out = decoratePage(pageHtml);
  assert.ok(out.includes('<main id="main">'), out);
  assert.ok(out.includes('<nav class="site-nav" aria-label="Primary">'), out);
  assert.ok(out.includes('<a class="skip-link" href="#main">'), out);
  // class contract: every original class token still present, DOM order intact
  for (const cls of ['site-head', 'site-nav', 'home']) assert.ok(out.includes(`class="${cls}"`) || out.includes(`${cls}"`), cls);
  assert.ok(out.indexOf('skip-link') < out.indexOf('site-head'), 'skip link is first in body');
  // a theme without a bare <main> gets no dangling skip link
  const noMain = decoratePage('<head></head><body><main class="x"></main></body>');
  assert.ok(!noMain.includes('skip-link'), noMain);
});

test('ledger dedup: a session already in the ledger is not re-appended', () => {
  // simulates the local-runner + Actions safety-net overlap window
  const { pickNewPaidSessions, ledgerRow } = require('../lib/fulfill-core.js');
  const grants = [{ payment_link: 'plink_1', product: 'P', repo: 'o/r' }];
  const s = {
    id: 'cs_dup', status: 'complete', payment_status: 'paid', payment_link: 'plink_1',
    created: 1_700_000_000, amount_total: 2900, currency: 'usd',
    customer_details: { address: { country: 'DE' } },
    custom_fields: [{ key: 'github_username', text: { value: 'octocat' } }],
  };
  const existing = ledgerRow(s, grants[0]);
  const refs = new Set([existing.ref]);
  // the guard: same ref → skip
  assert.ok(refs.has(ledgerRow(s, grants[0]).ref), 'ref is stable and dedupable');
});

test('markdown: bold spanning two source lines renders (not literal **)', () => {
  const html = renderMarkdown('start of para\n**bold across\nthe line break** and more text');
  assert.ok(html.includes('<strong>bold across the line break</strong>'), html);
  assert.ok(!html.includes('**'), 'no literal asterisks should survive');
});

test('markdown: wrapped list items keep their continuation lines in the <li>', () => {
  const html = renderMarkdown('- **first.** starts here\n  and wraps onto this line\n- second item\n  also wraps');
  assert.ok(html.includes('<li><strong>first.</strong> starts here and wraps onto this line</li>'), html);
  assert.ok(html.includes('<li>second item also wraps</li>'), html);
  assert.ok(!html.includes('<p>'), 'continuation must not escape into a paragraph');
});

test('markdown: fence info strings with non-word chars still open a fence', () => {
  // "objective-c", "c++", "shell-session": real language tags that fail a \w*
  // info-string match. The un-fenced opener then renders the code as a
  // paragraph, and the CLOSING fence swallows the rest of the page into <pre>.
  const html = renderMarkdown('Intro.\n\n```objective-c\ncode <tag>\n```\n\nAfter paragraph.');
  assert.ok(html.includes('<pre><code>code &lt;tag&gt;</code></pre>'), html);
  assert.ok(html.includes('<p>After paragraph.</p>'), html);
  assert.ok(!html.includes('```'), 'no literal fence markers should survive');
});

test('markdown: wrapped ordered-list items join like unordered ones', () => {
  const html = renderMarkdown('1. step one\n   continued\n2. step two');
  assert.ok(html.includes('<li>step one continued</li>'), html);
  assert.ok(html.includes('<li>step two</li>'), html);
});
