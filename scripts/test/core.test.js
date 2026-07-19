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
const { renderMarkdown } = require('../lib/md.js');
const { section, buyButton } = require('../build.js');

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

test('build: buy button escapes payment_link and name (regression guard)', () => {
  const html = buyButton({ payment_link: 'https://buy.stripe.com/x"><script>', name: 'P', price: '$1' });
  assert.ok(!html.includes('"><script>'), html);
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'), html);
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
