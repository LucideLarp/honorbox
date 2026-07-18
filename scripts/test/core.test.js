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
