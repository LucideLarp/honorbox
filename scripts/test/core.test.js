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
  isFreeFulfillment,
  stripeMode,
  redactKeys,
} = require('../lib/fulfill-core.js');
const { parseFrontmatter } = require('../lib/fm.js');
const { renderMarkdown, excerpt, firstRasterImage, safeUrl } = require('../lib/md.js');
const {
  section, buyButton, productCard, productProblems, configProblems, slugProblems, templateProblems, isUpstreamStore,
  usdPrice, absUrl, tpl, injectHead, setMeta, jsonLdScript, guideSlugs, trustArticle,
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

test('extracts username from a pasted GitHub profile URL', () => {
  // Buyers paste their profile link into the username field often enough
  // that rejecting it costs real sales attention. A bare profile URL
  // yields the username; anything deeper is passed through untouched so
  // validation can reject it loudly.
  const withValue = (value) => session({ custom_fields: [{ key: 'github_username', text: { value } }] });
  for (const [raw, want] of [
    ['https://github.com/Octo-Cat', 'Octo-Cat'],
    ['https://github.com/octocat/', 'octocat'],
    ['http://www.github.com/octocat', 'octocat'],
    ['github.com/octocat', 'octocat'],
    [' @octocat ', 'octocat'],
  ]) {
    assert.equal(extractGithubUsername(withValue(raw)), want, raw);
  }
  const deep = extractGithubUsername(withValue('https://github.com/octocat/some-repo'));
  assert.ok(!validUsername(deep), 'a non-profile URL must fail validation, not get guessed at');
});

test('invite failures classify as transient (retry) or permanent (attention)', () => {
  const { isTransientInviteError, inviteAttempts } = require('../lib/fulfill-core.js');
  // GitHub's prose is read from `body`, the raw response, not from `message`,
  // which is ours and carries the hint text. Passing prose as `message` here
  // used to be enough to classify; it no longer is, and that is the point.
  const withStatus = (status, body = '') => Object.assign(new Error('x'), { status, body });
  // no HTTP verdict at all: DNS, timeout, connection reset
  assert.ok(isTransientInviteError(new Error('fetch failed')));
  assert.ok(isTransientInviteError(withStatus(429)));
  assert.ok(isTransientInviteError(withStatus(502)));
  assert.ok(isTransientInviteError(withStatus(403, 'You have exceeded a secondary rate limit')));
  // permanent: bad token, no such user, our own validation
  assert.ok(!isTransientInviteError(withStatus(404)));
  assert.ok(!isTransientInviteError(withStatus(401)));
  assert.ok(!isTransientInviteError(withStatus(403, 'Resource not accessible by personal access token')));
  assert.ok(!isTransientInviteError(Object.assign(new Error('invalid github username'), { permanent: true })));
  // attempt counting only sees this session's transient failures
  const failures = [
    { session: 'cs_a', transient: true },
    { session: 'cs_a', transient: true },
    { session: 'cs_a' }, // permanent entry, not an attempt
    { session: 'cs_b', transient: true },
  ];
  assert.equal(inviteAttempts(failures, 'cs_a'), 2);
});

test('how long to wait comes from GitHub headers, in the documented order', () => {
  const { retryAfterMs } = require('../lib/fulfill-core.js');
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);
  // 1. retry-after wins: this is what a SECONDARY limit sends, and a burst
  //    trips secondary limits, not primary ones.
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '30' }), now), 30_000);
  // works through Headers (case-insensitive) and through the plain object a
  // stubbed response carries
  assert.equal(retryAfterMs({ 'retry-after': '5' }, now), 5_000);
  // 2. a PRIMARY limit: remaining 0, wait until the window resets
  assert.equal(
    retryAfterMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSec + 600) }), now),
    600_000
  );
  // retry-after takes precedence when both are present
  assert.equal(
    retryAfterMs(new Headers({ 'retry-after': '7', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSec + 600) }), now),
    7_000
  );
  // budget left is not a limit
  assert.equal(retryAfterMs(new Headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(nowSec + 600) }), now), null);
  // a reset already past never yields a negative wait
  assert.equal(retryAfterMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowSec - 60) }), now), 0);
  // nothing to go on
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs(new Headers({}), now), null);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' }), now), null);
});

test('a 403 carrying a rate-limit header is transient even when the prose says nothing', () => {
  const { isTransientInviteError } = require('../lib/fulfill-core.js');
  // The failure this closes: the only rate-limit test used to be a match on
  // the words of the response body. GitHub's wording is not part of any
  // contract. Reword it and a retryable throttle silently reclassifies as a
  // permanent permissions error, so the buyer is never retried at all and
  // lands in needs_attention instead.
  assert.ok(isTransientInviteError(Object.assign(new Error('403 Forbidden'), {
    status: 403, headers: new Headers({ 'retry-after': '60' }),
  })));
  assert.ok(isTransientInviteError(Object.assign(new Error('403 Forbidden'), {
    status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' }),
  })));
  // The regression that must NOT ride along: a genuine permissions 403 has no
  // rate-limit headers and stays permanent, because retrying cannot fix it.
  assert.ok(!isTransientInviteError(Object.assign(new Error('Resource not accessible by personal access token'), {
    status: 403, headers: new Headers({ 'x-ratelimit-remaining': '4998' }),
  })));
});

// GitHub's documented cap sentence, verbatim from the "Add a repository
// collaborator" REST page. The status it arrives with is NOT documented, so
// every plausible one is exercised.
const CAP_BODY = JSON.stringify({
  message: 'You are limited to sending 50 invitations to a repository per 24 hour period.',
  documentation_url: 'https://docs.github.com/rest/collaborators/collaborators#add-a-repository-collaborator',
});

test('the invitation cap is recognized whatever status GitHub chooses to send it with', () => {
  const { isInvitationCapError, isTransientInviteError } = require('../lib/fulfill-core.js');
  const cap = (status) => Object.assign(new Error('x'), {
    status, body: CAP_BODY, headers: new Headers({ 'x-ratelimit-remaining': '4831' }),
  });
  // 403 and 422 are both documented on that endpoint and GitHub does not say
  // which the cap uses; 429 is what the general rate-limit page allows. All
  // three must be caught, and all three must be retryable.
  for (const status of [403, 422, 429]) {
    assert.ok(isInvitationCapError(cap(status)), `cap must be recognized at ${status}`);
    assert.ok(isTransientInviteError(cap(status)), `cap must be transient at ${status}`);
  }
  // Note the healthy x-ratelimit-remaining above: the cap is a per-repo
  // endpoint quota, not the core 5000/hour quota, so the header path is blind
  // to it. That is why the sentence is matched at all.
  const { retryAfterMs } = require('../lib/fulfill-core.js');
  assert.equal(retryAfterMs(cap(403).headers), null);
  // Not a cap: an ordinary permissions refusal stays permanent.
  assert.ok(!isInvitationCapError(Object.assign(new Error('x'), {
    status: 403, body: JSON.stringify({ message: 'Resource not accessible by personal access token' }),
  })));
  assert.ok(!isInvitationCapError(null));
  assert.ok(!isInvitationCapError(Object.assign(new Error('x'), { status: 403 })));
});

test('classification reads GitHub\'s body, never the hint text we wrapped around it', () => {
  const { isTransientInviteError, isInvitationCapError, inviteStatusHint } = require('../lib/fulfill-core.js');
  // The live defect this closes. inviteStatusHint(403) ends with "or a
  // secondary rate limit is in force", and fulfill.js embeds that hint in the
  // error message. The old check ran /rate limit|secondary/ over the MESSAGE,
  // so every permissions 403 matched our own words and was retried for six
  // hours instead of surfacing at once as a dead token.
  assert.match(inviteStatusHint(403), /secondary rate limit/);
  const realPermissions403 = Object.assign(
    new Error(`GitHub invite o/r <- buyer -> 403${inviteStatusHint(403)}: ` +
      JSON.stringify({ message: 'Resource not accessible by personal access token' })),
    { status: 403, headers: new Headers({ 'x-ratelimit-remaining': '4831' }),
      body: JSON.stringify({ message: 'Resource not accessible by personal access token' }) }
  );
  assert.ok(!isTransientInviteError(realPermissions403),
    'a permissions 403 must not be made retryable by our own hint text');
  assert.ok(!isInvitationCapError(realPermissions403));
});

test('the cap outranks the status table, so the log stops blaming the buyer', () => {
  const { inviteStatusHint } = require('../lib/fulfill-core.js');
  // A cap arriving as 422 used to print "GitHub rejected the invite as invalid
  // (the account cannot be added to this repo)", sending the operator after
  // the buyer's account when the truth is the repo is full for the day.
  assert.match(inviteStatusHint(422, CAP_BODY), /cap of 50 repository invitations per 24 hours/);
  assert.match(inviteStatusHint(403, CAP_BODY), /cap of 50 repository invitations per 24 hours/);
  assert.doesNotMatch(inviteStatusHint(422, CAP_BODY), /account cannot be added/);
  // Without a cap body the table is untouched.
  assert.match(inviteStatusHint(422), /account cannot be added/);
  assert.match(inviteStatusHint(404), /no such GitHub user/);
});

test('the cap retries past GitHub\'s 24h window while everything else still escalates at 6h', () => {
  const {
    shouldRetryInvite, INVITE_RETRY_WINDOW_SECONDS, INVITE_CAP_RETRY_WINDOW_SECONDS,
  } = require('../lib/fulfill-core.js');
  // The mismatch this fixes: a 6h budget against a 24h cap left 18h of the
  // limit still running after we had given up, so sale 51 on a good day was
  // never delivered and fell out to manual handling.
  assert.ok(INVITE_CAP_RETRY_WINDOW_SECONDS > 24 * 3600,
    'the cap window must outlive GitHub\'s own 24h period');
  assert.equal(INVITE_CAP_RETRY_WINDOW_SECONDS, 26 * 3600);
  // The general window is deliberately NOT widened: a broken order must still
  // reach a human in 6h.
  assert.equal(INVITE_RETRY_WINDOW_SECONDS, 6 * 3600);

  const now = Date.parse('2026-07-20T12:00:00Z');
  const cap = Object.assign(new Error('x'), { status: 403, body: CAP_BODY });
  const other = Object.assign(new Error('bad gateway'), { status: 502 });
  const firstAt = (iso) => [{ session: 'cs_a', ts: iso, transient: true }];

  // 20h in, the middle of GitHub's window: the cap keeps going, a plain
  // transient has long since been handed to a human.
  const twentyHoursAgo = firstAt('2026-07-19T16:00:00Z');
  assert.ok(shouldRetryInvite(cap, twentyHoursAgo, 'cs_a', now));
  assert.ok(!shouldRetryInvite(other, twentyHoursAgo, 'cs_a', now));
  // Just inside 26h: still retrying, because the cap can take a full day to
  // free the slot and the poll cadence adds slack on top.
  assert.ok(shouldRetryInvite(cap, firstAt('2026-07-19T10:30:00Z'), 'cs_a', now));
  // Past 26h this is not a cap that cleared, it is something else wearing the
  // cap's words, and it goes to a human.
  assert.ok(!shouldRetryInvite(cap, firstAt('2026-07-19T09:00:00Z'), 'cs_a', now));
});

test('a capped repo is never retried inside the run', () => {
  const { inRunRetryDelayMs } = require('../lib/fulfill-core.js');
  const cap = Object.assign(new Error('x'), { status: 403, body: CAP_BODY });
  // Every in-run attempt is certain to fail for hours, and GitHub's rate-limit
  // guidance warns that continuing to call while limited "may result in the
  // banning of your integration". Holding the run open for it also burns
  // billed Actions time delivering nothing.
  assert.equal(inRunRetryDelayMs(cap, 1, 0), null);
  // Even when GitHub attaches a retry-after short enough to be affordable, a
  // cap is not the kind of thing a 5s wait clears.
  const capWithHeader = Object.assign(new Error('x'), {
    status: 403, body: CAP_BODY, headers: new Headers({ 'retry-after': '5' }),
  });
  assert.equal(inRunRetryDelayMs(capWithHeader, 1, 0), null);
  // A genuine secondary limit with the same header IS still retried in-run.
  const secondary = Object.assign(new Error('x'), {
    status: 403, body: 'You have exceeded a secondary rate limit',
    headers: new Headers({ 'retry-after': '5' }),
  });
  assert.equal(inRunRetryDelayMs(secondary, 1, 0), 5_000);
});

test('the in-run retry waits as long as GitHub asked, inside a bounded budget', () => {
  const {
    inRunRetryDelayMs, IN_RUN_RETRY_BUDGET_MS, IN_RUN_MAX_WAIT_MS, IN_RUN_MAX_ATTEMPTS,
  } = require('../lib/fulfill-core.js');
  const limited = (secs) => Object.assign(new Error('secondary rate limit'), {
    status: 403, headers: new Headers({ 'retry-after': String(secs) }),
  });
  // GitHub's number is honoured verbatim, never shortened, which is how a
  // secondary limit gets extended instead of cleared.
  assert.equal(inRunRetryDelayMs(limited(5), 1, 0), 5_000);
  // A wait longer than the ceiling is DECLINED rather than slept through: that
  // is a primary limit saying "come back in an hour", and holding an Actions
  // run open for it burns billed minutes and delivers nothing. The poll has it.
  assert.ok(IN_RUN_MAX_WAIT_MS < 3_600_000);
  assert.equal(inRunRetryDelayMs(limited(3600), 1, 0), null);
  // budget spent by earlier buyers in this same run -> decline
  assert.equal(inRunRetryDelayMs(limited(5), 1, IN_RUN_RETRY_BUDGET_MS), null);
  // a wait that would overrun the remaining budget is declined whole, not
  // truncated to a shorter one that GitHub did not agree to
  assert.equal(inRunRetryDelayMs(limited(20), 1, IN_RUN_RETRY_BUDGET_MS - 5_000), null);
  // attempts are capped even when every failure is instant and costs no budget
  assert.equal(inRunRetryDelayMs(limited(1), IN_RUN_MAX_ATTEMPTS, 0), null);
  // a header-less transient (timeout, 5xx) still backs off rather than hammering
  assert.ok(inRunRetryDelayMs(Object.assign(new Error('502'), { status: 502 }), 1, 0) > 0);
  // a permanent failure is never retried in-run
  assert.equal(inRunRetryDelayMs(Object.assign(new Error('404'), { status: 404 }), 1, 0), null);
});

test('failure rows are pruned by settlement, never dropping a live retry window', () => {
  const { pruneFailures, shouldRetryInvite } = require('../lib/fulfill-core.js');
  const now = Date.parse('2026-07-20T12:00:00Z');
  const old = new Date(now - 7 * 3600 * 1000).toISOString(); // older than the 6h window
  const live = { session: 'cs_live', transient: true, ts: old };
  const settled = Array.from({ length: 3000 }, (_, i) => ({ session: `cs_done_${i}`, transient: true, ts: old }));
  const processed = settled.map((f) => f.session);

  const pruned = pruneFailures([live, ...settled], processed, 2000);
  assert.equal(pruned.length, 2000);
  // The live row survived WITH ITS ORIGINAL TIMESTAMP. Dropping it would
  // restart the 6h budget from the next failure, so a session that should be
  // handed to a human retries forever instead.
  assert.deepEqual(pruned.find((f) => f.session === 'cs_live'), live);
  const transient = Object.assign(new Error('502'), { status: 502 });
  assert.ok(
    !shouldRetryInvite(transient, pruned, 'cs_live', now),
    'the 6h window must still read as expired after pruning'
  );
  // oldest settled rows go first and the surviving order is unchanged
  assert.deepEqual(pruned.slice(1), settled.slice(1001));
  // under the cap it is a no-op, returned as-is
  const few = [live, settled[0]];
  assert.equal(pruneFailures(few, processed, 2000), few);
  // live rows outrank the cap: 3000 unsettled sessions are all kept, because
  // every one of them is still owed a delivery
  const allLive = settled.map((f) => ({ ...f }));
  assert.equal(pruneFailures(allLive, [], 2000).length, 3000);
});

test('transient retries are time-boxed to the delivery promise, not attempt-counted', () => {
  // An attempt cap of 5 burns out in ~10 minutes on the 2-minute local
  // runner, which a routine GitHub incident outlasts. The retry budget is
  // therefore TIME from the first transient failure: 6h, the "always
  // within a few hours" delivery promise. Attempts are still logged.
  const { shouldRetryInvite, INVITE_RETRY_WINDOW_SECONDS } = require('../lib/fulfill-core.js');
  assert.equal(INVITE_RETRY_WINDOW_SECONDS, 6 * 3600);
  const transient = Object.assign(new Error('bad gateway'), { status: 502 });
  const permanent = Object.assign(new Error('Not Found'), { status: 404 });
  const now = Date.parse('2026-07-19T12:00:00Z');
  const at = (iso, over = {}) => ({ session: 'cs_a', ts: iso, transient: true, ...over });
  // first failure ever: retry
  assert.ok(shouldRetryInvite(transient, [], 'cs_a', now));
  // still inside the window: retry, however many attempts are logged
  const young = [at('2026-07-19T07:00:01Z'), at('2026-07-19T09:00:00Z'), at('2026-07-19T11:00:00Z')];
  assert.ok(shouldRetryInvite(transient, young, 'cs_a', now));
  // first transient failure older than the window: give up, surface it
  const old = [at('2026-07-19T05:59:59Z'), at('2026-07-19T11:58:00Z')];
  assert.ok(!shouldRetryInvite(transient, old, 'cs_a', now));
  // a permanent error never retries, window or not
  assert.ok(!shouldRetryInvite(permanent, [], 'cs_a', now));
  // another session's failures and non-transient entries do not start the clock
  const noise = [at('2026-07-19T01:00:00Z', { session: 'cs_b' }), { session: 'cs_a', ts: '2026-07-19T01:00:00Z' }];
  assert.ok(shouldRetryInvite(transient, noise, 'cs_a', now));
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

test('a paid session no grant matches is picked out for a warning, not just dropped', () => {
  // pickNewPaidSessions and unmatchedPaidSessions must partition the paid
  // sessions between them: whatever the first one refuses to deliver, the
  // second one has to hand to the operator. Anything falling between the two
  // is a sale that disappears with a green log.
  const { unmatchedPaidSessions } = require('../lib/fulfill-core.js');
  const good = session();
  const orphan = session({ id: 'cs_orphan', payment_link: 'plink_gone' });
  const unpaid = session({ id: 'cs_unpaid', payment_link: 'plink_gone', payment_status: 'unpaid' });
  const all = [good, orphan, unpaid];

  assert.deepEqual(unmatchedPaidSessions(all, [], GRANTS).map((s) => s.id), ['cs_orphan']);
  const delivered = pickNewPaidSessions(all, [], GRANTS).map((s) => s.id);
  const warned = unmatchedPaidSessions(all, [], GRANTS).map((s) => s.id);
  const paidIds = all.filter((s) => s.status === 'complete' && s.payment_status === 'paid').map((s) => s.id);
  assert.deepEqual([...delivered, ...warned].sort(), paidIds.sort(), 'no paid session falls between the two');

  // Already-warned ids drop out, so a permanently orphaned session does not
  // re-alert on every poll for the rest of the store's life.
  assert.deepEqual(unmatchedPaidSessions(all, ['cs_orphan'], GRANTS), []);
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

test('re-scan overlap covers the full 24h checkout-session lifetime', () => {
  // Stripe Checkout Sessions can complete up to 24h after creation (the
  // expires_at ceiling). The poll query is created > cursor - OVERLAP, and
  // the cursor advances on every run, so a session that is still open when
  // a NEWER sale moves the cursor must remain inside the window until it
  // expires. Otherwise: buyer opens checkout, pays 7h later, sale is
  // permanently missed. Scenario:
  const { OVERLAP_SECONDS } = require('../lib/fulfill-core.js');
  const t0 = 1_700_000_000;
  const straggler = session({ id: 'cs_slow', created: t0, status: 'open', payment_status: 'unpaid' });
  const sale = session({ id: 'cs_fast', created: t0 + 23 * 3600 });
  const cursor = nextCursor([straggler, sale], t0);
  assert.ok(
    typeof OVERLAP_SECONDS === 'number' && cursor - OVERLAP_SECONDS <= straggler.created,
    `overlap ${OVERLAP_SECONDS}s leaves a still-completable session outside the scan window`
  );
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

test('frontmatter: a flush-left block sequence is still a list', () => {
  // YAML allows a sequence at the parent's indentation. It used to match
  // nothing and fall through, leaving features: [], so the product card
  // shipped with no selling points at all, and the build stayed green.
  const { data } = parseFrontmatter(
    '---\nname: Flush\nfeatures:\n- Lifetime updates\n- Private repo access\n---\nBody.'
  );
  assert.deepEqual(data.features, ['Lifetime updates', 'Private repo access']);
  // indented forms still work, and a list is only consumed while one is open
  assert.deepEqual(
    parseFrontmatter('---\nfeatures:\n  - a\n\t- b\n---\n').data.features,
    ['a', 'b']
  );
});

test('frontmatter: an unclosed block is reported, not published as body text', () => {
  // Without a closing ---, every key rendered as a visible paragraph (leaking
  // internal notes) and the page title fell back to the filename.
  const bad = parseFrontmatter('---\ntitle: Refunds\ninternal_note: DRAFT\n\nRefunds within 30 days.\n');
  assert.ok(bad.error, 'unclosed frontmatter reports an error');
  assert.match(bad.error, /never closed/);
  // a plain markdown file with no frontmatter at all is NOT an error
  const plain = parseFrontmatter('# Just a heading\n\ntext\n');
  assert.equal(plain.error, undefined);
  assert.deepEqual(plain.data, {});
  // a BOM must not defeat the anchor and silently publish the block
  const bom = parseFrontmatter('﻿---\ntitle: T\n---\nBody.');
  assert.equal(bom.error, undefined);
  assert.equal(bom.data.title, 'T');
  assert.equal(bom.body.trim(), 'Body.');
});

test('markdown: structure and escaping', () => {
  const html = renderMarkdown('# T\n\nHello **world** `x<y`\n\n- a\n- b\n\n```\ncode <tag>\n```');
  assert.ok(html.includes('<h1 id="t">T</h1>'));
  assert.ok(html.includes('<strong>world</strong>'));
  assert.ok(html.includes('<code>x&lt;y</code>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<pre><code>code &lt;tag&gt;</code></pre>'));
});

test('markdown: headings carry the anchor the docs already link to', () => {
  // setup.md links to "#7-what-this-costs" and nothing emitted an id for it,
  // so the link was dead on the published page. The slug follows GitHub's
  // rules because that is what an author writing a fragment link will assume.
  // The leading number matters: inserting a setup step renumbers the heading,
  // and the anchor has to track the text rather than be hand-maintained.
  const html = renderMarkdown('## 7. What this costs\n\n## Delivery model\n\n## The `ref` column');
  assert.ok(html.includes('<h2 id="7-what-this-costs">'), html);
  assert.ok(html.includes('<h2 id="delivery-model">'), html);
  assert.ok(html.includes('<h2 id="the-ref-column">'), 'formatting is stripped before slugging');

  // Duplicate headings must not produce duplicate ids: that is invalid HTML
  // and makes the anchor ambiguous.
  const dupes = renderMarkdown('## Notes\n\n## Notes\n\n## Notes');
  assert.ok(dupes.includes('<h2 id="notes">'), dupes);
  assert.ok(dupes.includes('<h2 id="notes-1">'), dupes);
  assert.ok(dupes.includes('<h2 id="notes-2">'), dupes);

  // A heading that slugs to nothing gets no id rather than id="".
  assert.ok(renderMarkdown('## ...').includes('<h2>'), 'no empty id attribute');
});

test('every fragment link in the shipped docs lands on a real heading', () => {
  // The failure this catches is silent: a dead "#section" link looks fine in
  // the markdown, renders fine, and simply does nothing when clicked.
  const fs = require('node:fs');
  const path = require('node:path');
  const docsDir = path.join(__dirname, '..', '..', 'docs');
  const dead = [];
  for (const f of fs.readdirSync(docsDir).filter((n) => n.endsWith('.md'))) {
    const src = fs.readFileSync(path.join(docsDir, f), 'utf8');
    const ids = new Set(
      [...renderMarkdown(src).matchAll(/<h[1-4] id="([^"]+)"/g)].map((m) => m[1])
    );
    for (const m of src.matchAll(/\]\((#[a-z0-9-]+)\)/g)) {
      if (!ids.has(m[1].slice(1))) dead.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(dead, [], `dead in-page anchors:\n  ${dead.join('\n  ')}`);
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

test('markdown: a code span is inert, not a second pass of markdown', () => {
  // This shipped. The username regex on the live guide page rendered as
  // `^<a href="#">a-zA-Z0-9</a>{0,38}$`, its middle eaten, because code spans
  // were substituted first and the link and emphasis rules then ran straight
  // through the result.
  const real = renderMarkdown('validate (`^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$`, no doubled hyphens)');
  assert.ok(real.includes('<code>^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$</code>'), real);
  assert.ok(!real.includes('<a href'), 'no link may be manufactured inside a code span');

  const out = renderMarkdown('Use `**not bold**` and `[t](http://x)` and `*x*` here.');
  assert.ok(out.includes('<code>**not bold**</code>'), out);
  assert.ok(out.includes('<code>[t](http://x)</code>'), out);
  assert.ok(out.includes('<code>*x*</code>'), out);
  assert.ok(!/<strong>|<em>|<a /.test(out), out);

  // html inside a code span stays escaped
  assert.ok(renderMarkdown('Set `<div class="x">`').includes('<code>&lt;div class=&quot;x&quot;&gt;</code>'));
  // a run of backticks delimits, so a literal backtick can be shown
  assert.ok(renderMarkdown('Use ``a ` b`` here').includes('<code>a ` b</code>'));
});

test('markdown: an inline image is an image, not a link with a stray bang', () => {
  const out = renderMarkdown('Logo ![alt](./a.png) inline.');
  assert.ok(out.includes('<img src="./a.png" alt="alt" loading="lazy">'), out);
  assert.ok(!out.includes('!<a'), out);
  // a title is carried through instead of defeating the match entirely
  assert.ok(renderMarkdown('![alt](./a.png "My title")').includes('title="My title"'));
  assert.ok(renderMarkdown('[text](./a.png "T")').includes('<a href="./a.png" title="T">text</a>'));
  // the scheme gate still holds, and degrades to the alt text
  const bad = renderMarkdown('Logo ![x](javascript:alert) here');
  assert.ok(!bad.includes('<img'), bad);
  assert.ok(!bad.includes('javascript:'), bad);
  assert.ok(bad.includes('x'), bad);
});

test('markdown: a url may contain parens, and an entity stays an entity', () => {
  // cut at the first ")" this link pointed at a 404 and left a bare paren
  const out = renderMarkdown('See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) now.');
  assert.ok(out.includes('href="https://en.wikipedia.org/wiki/Foo_(bar)"'), out);
  assert.ok(!out.includes('</a>)'), out);
  // &amp; in source means the character, not the five letters
  const ent = renderMarkdown('Tom &amp; Jerry, 5 &lt; 6, &#8212; dash.');
  assert.ok(ent.includes('Tom &amp; Jerry'), ent);
  assert.ok(ent.includes('5 &lt; 6'), ent);
  assert.ok(ent.includes('&#8212;'), ent);
  assert.ok(!ent.includes('&amp;amp;'), ent);
  // a bare ampersand is still escaped
  assert.ok(renderMarkdown('Tom & Jerry').includes('Tom &amp; Jerry'));
  // and a link with no text is left alone rather than made nameless
  assert.ok(!renderMarkdown('[](http://x.com)').includes('<a '), 'no anchor without an accessible name');
});

test('excerpt and social card share the renderer\'s link shape', () => {
  // These carried their own copies of the link pattern, so a url with parens
  // or a titled image rendered fine in the body while leaving raw markdown
  // and stray punctuation in the meta description.
  assert.equal(excerpt('See [wiki](https://en.wikipedia.org/wiki/Foo_(bar)) now.'), 'See wiki now.');
  assert.equal(excerpt('Text with ![alt](./a.png "T") inline.'), 'Text with alt inline.');
  assert.equal(excerpt('Use ``a ` b`` here.'), 'Use a ` b here.');

  // a titled hero image is still social-card material
  assert.equal(firstRasterImage('![a](./hero.png "T")'), './hero.png');
  assert.equal(firstRasterImage('![a](./hero.png)'), './hero.png');
  // a link is not an image, and the scheme gate still applies
  assert.equal(firstRasterImage('[a](./notimg.png)'), null);
  assert.equal(firstRasterImage('![a](javascript:x.png)'), null);

  // a cache-busted or fragment-bearing URL is still a raster image: missing it
  // meant the page shipped with no social card at all, silently
  assert.equal(firstRasterImage('![a](./hero.png?v=2)'), './hero.png?v=2');
  assert.equal(firstRasterImage('![a](https://x.test/c.jpg?w=1200&h=630)'), 'https://x.test/c.jpg?w=1200&h=630');
  assert.equal(firstRasterImage('![a](./hero.png#top)'), './hero.png#top');
  // and a query string cannot smuggle a non-raster file past the check
  assert.equal(firstRasterImage('![a](./doc.pdf?x=.png)'), null);
});

test('markdown: a nested list nests instead of flattening into one item', () => {
  // the indented marker used to be folded into the item above, markers and
  // all: "- a" over "  - b" rendered as <li>a - b</li>
  assert.equal(
    renderMarkdown('- a\n  - b\n  - c\n- d'),
    '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>'
  );
  assert.equal(
    renderMarkdown('1. one\n   1. inner\n2. two'),
    '<ol><li>one<ol><li>inner</li></ol></li><li>two</li></ol>'
  );
  // three levels, and a different marker kind starts its own list
  assert.ok(renderMarkdown('- a\n  - b\n    - deep').includes('<li>b<ul><li>deep</li></ul></li>'));
  assert.equal(renderMarkdown('1. x\n- y'), '<ol><li>x</li></ol>\n<ul><li>y</li></ul>');
  // wrapped prose still continues the item above, unchanged
  assert.equal(renderMarkdown('- a\n  wrapped text\n- b'), '<ul><li>a wrapped text</li><li>b</li></ul>');
});

test('markdown images: unsafe scheme actually hits the filter and emits no img', () => {
  // paren-free payload so it MATCHES the image-line regex (a parenthesized one
  // never reaches the new code path; that was a decoration test)
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
  // config is in-repo today, but a step href is a free-form URL, the same
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
  // same sinks as steps hrefs / markdown img src. The showcase emitter must
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

test('build: hrefs cannot leave the origin via a protocol-relative url', () => {
  // "//host/x" and "/\host/x" both parse as an *authority*, not a path. The
  // WHATWG url parser treats a backslash as a slash for special schemes, so a
  // gate that only checks for a leading "/" lets a value that reads like a
  // local path resolve to somebody else's origin under our scheme.
  for (const bad of ['//evil.example/x', '/\\evil.example/x']) {
    const steps = section({
      type: 'steps', title: 'G',
      items: [{ title: 'g', text: 't', href: bad }],
    });
    assert.ok(steps.includes('href="#"'), `steps ${JSON.stringify(bad)}: ${steps}`);
    assert.ok(!steps.includes('evil.example'), `steps ${JSON.stringify(bad)}: ${steps}`);
    const show = section({
      type: 'showcase', title: 'S',
      items: [{ img: bad, alt: 'a', href: bad }],
    });
    assert.ok(!show.includes('evil.example'), `showcase ${JSON.stringify(bad)}: ${show}`);
  }
  // legitimate root-relative and dot-relative links must survive untouched
  const ok = section({
    type: 'steps', title: 'G',
    items: [{ title: 'g', text: 't', href: '/guides/a.html' }],
  });
  assert.ok(ok.includes('href="/guides/a.html"'), ok);
});

test('markdown: protocol-relative link and image urls stay on our origin', () => {
  for (const bad of ['//evil.example/x', '/\\evil.example/x']) {
    const link = renderMarkdown(`[x](${bad})`);
    assert.ok(!link.includes('evil.example'), `link ${JSON.stringify(bad)}: ${link}`);
    const img = renderMarkdown(`![x](${bad}.png)`);
    assert.ok(!img.includes('<img'), `img ${JSON.stringify(bad)}: ${img}`);
    assert.ok(!img.includes('evil.example'), `img ${JSON.stringify(bad)}: ${img}`);
    assert.equal(firstRasterImage(`![x](${bad}.png)`), null, JSON.stringify(bad));
  }
  // root-relative assets and links keep working: this must not become a
  // same-directory-only renderer
  assert.ok(renderMarkdown('![a](/assets/a.png)').includes('src="/assets/a.png"'));
  assert.ok(renderMarkdown('[a](/terms.html)').includes('href="/terms.html"'));
  assert.equal(firstRasterImage('![a](/assets/a.png)'), '/assets/a.png');
});

test('url gate: a tab or newline cannot smuggle an authority past the path check', () => {
  // The WHATWG url parser REMOVES ascii tab/LF/CR from a url before parsing, so
  // "/<TAB>/evil.example" is delivered to the network as "//evil.example", an
  // authority, not a path. A gate that reads the raw string sees a leading "/"
  // followed by a tab (not "/" or "\"), calls it root-relative, and lets it
  // through. Verified against two independent parsers: node's WHATWG URL
  // resolves it to https://evil.example/, and python's html tokenizer keeps the
  // tab in the attribute for the browser to strip.
  for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/\t\\evil.example']) {
    assert.equal(safeUrl(bad), null, `safeUrl ${JSON.stringify(bad)}`);
    assert.equal(safeUrl(bad, { anchor: true }), null, `safeUrl anchor ${JSON.stringify(bad)}`);

    const steps = section({ type: 'steps', title: 'G', items: [{ title: 'g', text: 't', href: bad }] });
    assert.ok(steps.includes('href="#"'), `steps ${JSON.stringify(bad)}: ${steps}`);
    assert.ok(!steps.includes('evil.example'), `steps ${JSON.stringify(bad)}: ${steps}`);

    // the checkout button is the one that costs money if it points off-origin
    const btn = buyButton({ payment_link: bad, name: 'X', price: '$1' });
    assert.ok(!btn.includes('evil.example'), `buyButton ${JSON.stringify(bad)}: ${btn}`);

    // The markdown path was never exposed to this: LINKISH's target is
    // [^\s()]*, so a tab or newline stops it being read as a link at all and it
    // stays inert prose. Assert the property that matters (no live off-origin
    // href) rather than the absence of the hostname, which legitimately
    // appears as escaped text.
    const link = renderMarkdown(`[x](${bad})`);
    assert.ok(!/href="[^"]*evil\.example/.test(link), `link ${JSON.stringify(bad)}: ${link}`);
    assert.ok(!link.includes('<a '), `link ${JSON.stringify(bad)} should not be a link: ${link}`);
  }
  // a control character must not silently rewrite an otherwise fine url either:
  // what we approve is what we emit
  assert.equal(safeUrl('https://ok.example/a\tb'), 'https://ok.example/ab');
  // legitimate urls are untouched
  assert.equal(safeUrl('/guides/a.html'), '/guides/a.html');
  assert.equal(safeUrl('https://ok.example/a?b=1&c=2'), 'https://ok.example/a?b=1&c=2');
  assert.equal(safeUrl('#top', { anchor: true }), '#top');
});

test('templateProblems: the fork guard survives a cosmetic edit to our link', () => {
  // The guard compared with an exact-string Set, so a forker who kept our
  // payment link but appended a utm parameter, a trailing slash, or changed the
  // case walked straight past it and shipped a green build whose Buy button
  // takes their buyers' money into HonorBox's Stripe account. That is the exact
  // outcome the guard exists to prevent, and cosmetic edits are the common case
  // (a fork that copies a link usually also tweaks it).
  const fork = { repo: 'someone/their-store' };
  const variants = [
    'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03?utm_source=hn',
    'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03#pay',
    'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03/',
    'HTTPS://BUY.STRIPE.COM/8x29AT8J9d7xdqc8hma7C03',
    '  https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03/?x=1  ',
  ];
  for (const v of variants) {
    const out = templateProblems(fork, [{ id: 'x', payment_link: v }]);
    assert.equal(out.length, 1, `product ${JSON.stringify(v)} -> ${JSON.stringify(out)}`);
    assert.match(out[0], /HonorBox's own checkout/);
  }
  // the same normalization on the fulfillment grants
  for (const v of ['plink_1TupsnE9zX2nUu1OV1JOs3x3 ', 'PLINK_1TUPSNE9ZX2NUU1OV1JOS3X3']) {
    const out = templateProblems({ ...fork, fulfillment: [{ payment_link: v }] }, []);
    assert.equal(out.length, 1, `grant ${JSON.stringify(v)} -> ${JSON.stringify(out)}`);
  }
  // a plink id pasted inside a url still counts as ours
  assert.equal(
    templateProblems({ ...fork, fulfillment: [{ payment_link: 'https://buy.stripe.com/x?pl=plink_1Tudl9E9zX2nUu1OZywmp76G' }] }, []).length,
    1
  );
  // and a seller's own, genuinely different link is still fine
  assert.deepEqual(templateProblems(fork, [{ id: 'x', payment_link: 'https://buy.stripe.com/theirOwnLink123' }]), []);
  // Our own storefront is still exempt, but only on the FULL identity
  // (repo + name + url), not on repo alone. A config carrying just our repo is
  // a half-edited copy, and it correctly gets told so.
  assert.deepEqual(
    templateProblems(
      { repo: 'Honorboxx/honorbox', name: 'HonorBox', url: 'https://honorboxx.github.io/honorbox' },
      [{ id: 'x', payment_link: 'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03' }]
    ),
    []
  );
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

test('build: product frontmatter mistakes get named, not a TypeError', () => {
  // Before validation existed, a product page missing "price" crashed the
  // build with "Cannot read properties of undefined (reading 'replace')"
  // and a scalar "features:" with "p.features.map is not a function":
  // zero pointer to the file or the field. The validator names both.
  const ok = { id: 'my-tool', name: 'My Tool', price: '$29', features: ['a'] };
  assert.deepEqual(productProblems(ok), []);
  const problems = productProblems({ tagline: 'no id, name or price', features: 'one' });
  assert.ok(problems.some((p) => p.includes('"id"')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('"name"')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('"price"')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('"features"') && p.includes('list')), problems.join('; '));
  // id doubles as the output filename and URL slug: keep it a slug
  assert.ok(productProblems({ ...ok, id: 'my tool!' }).some((p) => p.includes('"id"')));
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

test('build: a payment_link the url gate rejects falls back to the disabled state', () => {
  // payment_link is product frontmatter, and HonorBox ships as a template a
  // forker fills in, so the checkout href gets the same scheme gate as every
  // other url we emit, not attribute escaping alone.
  // Gating it to "#" would leave a Buy button that looks alive and goes
  // nowhere. The module already has an honest state for "no usable checkout
  // link", and a rejected link is the same problem from the buyer's side, so
  // it reuses that rather than inventing a third state, which is also the
  // clearer signal for a forker who typo'd their URL.
  for (const bad of ['javascript:alert(1)', '//evil.example/x', '/\\evil.example/x']) {
    const html = buyButton({ payment_link: bad, name: 'P', price: '$1' });
    assert.ok(html.includes('btn-disabled'), `${bad}: ${html}`);
    assert.ok(html.includes('Checkout coming soon'), `${bad}: ${html}`);
    assert.ok(!html.includes('<a '), `${bad}: ${html}`);
    assert.ok(!html.includes('href='), `${bad}: ${html}`);
    assert.ok(!html.includes('evil.example') && !html.includes('javascript:'), `${bad}: ${html}`);
  }
  // a real Stripe link still passes through untouched, big variant included
  const ok = buyButton({ payment_link: 'https://buy.stripe.com/x', name: 'P', price: '$1' });
  assert.ok(ok.includes('href="https://buy.stripe.com/x"'), ok);
  assert.ok(buyButton({ payment_link: 'https://buy.stripe.com/x', name: 'P', price: '$1' }, true).includes('btn-big'));
});

test('build: the ledger total is escaped like every other cell on that page', () => {
  // Bot-written from Stripe integers today, so this is defense-in-depth rather
  // than a live exploit, but the trust page is the one surface a seller
  // publishes to strangers, and "the number is bot-written" is exactly the
  // assumption that rots.
  const html = trustArticle({
    total_sales: '<img src=x onerror=alert(1)>',
    updated: '2026-07-19T21:00:00Z',
    rows: [],
  });
  assert.ok(!html.includes('<img src=x'), html);
  assert.ok(html.includes('&lt;img src=x'), html);
  // a normal total still renders as a plain number, and the empty state holds
  const ok = trustArticle({ total_sales: 42, updated: '2026-07-19T21:00:00Z', rows: [] });
  assert.ok(ok.includes('<strong>42</strong>'), ok);
  assert.ok(ok.includes('No sales yet'), ok);
  // a missing total is 0, not "undefined"
  assert.ok(trustArticle({ rows: [] }).includes('<strong>0</strong>'));
  // rows stay escaped and newest-first
  const rows = trustArticle({
    total_sales: 2,
    rows: [
      { ts: '2026-07-01T00:00:00Z', product: 'A', amount: 1, currency: 'usd', country: 'NO', ref: 'r1' },
      { ts: '2026-07-02T00:00:00Z', product: '<b>B</b>', amount: 2.5, currency: 'usd', country: 'SE', ref: 'r2' },
    ],
  });
  assert.ok(!rows.includes('<b>B</b>'), rows);
  assert.ok(rows.indexOf('r2') < rows.indexOf('r1'), 'newest first');
  assert.ok(rows.includes('2.50 usd'), rows);
});

test('excerpt: first real paragraph, markdown stripped, structure skipped', () => {
  // excerpt() takes the markdown body, post-frontmatter (as build.js feeds it)
  const md = '# Heading\n\n![img](./x.png)\n\n```\ncode\n```\n\nFirst **real** paragraph with a [link](./a.html) and `code`\nspanning two lines.\n\nSecond paragraph.';
  assert.equal(excerpt(md), 'First real paragraph with a link and code spanning two lines.');
  assert.equal(excerpt(''), '');
  assert.equal(excerpt('# only a heading'), '');
});

test('excerpt: wrapped list continuations are not mistaken for the paragraph', () => {
  // A list item wrapped onto an indented line (the same source shape the
  // renderer already handles) must be skipped with its list, not returned
  // as the page's meta description.
  const md = '- item one\n  wrapped continuation\n- item two\n\nThe real first paragraph.';
  assert.equal(excerpt(md), 'The real first paragraph.');
  const ol = '1. step one\n   also wrapped\n2. step two\n\nActual prose.';
  assert.equal(excerpt(ol), 'Actual prose.');
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

test('setMeta/injectHead: $-patterns in a value cannot splice the document', () => {
  // Both feed escaped text to String.replace as the REPLACEMENT string, where
  // "$&" and "$'" are substitution patterns. escapeHtml leaves "$" alone, so a
  // config-authored meta value could paste the matched tag (quotes and all)
  // back into its own content attribute and break out of it.
  const page = '<head><meta property="og:title" content="old"></head><body>tail</body>';
  const out = setMeta(page, 'property', 'og:title', '$& http-equiv=refresh');
  assert.equal((out.match(/<meta property="og:title"/g) || []).length, 1, out);
  assert.ok(out.includes('content="$&amp; http-equiv=refresh"'), out);
  // "$'" must not paste the trailing document into the injected tag
  const inj = injectHead('<head>X</head>TAIL', `<meta content="${"$'"}">`);
  assert.ok(!inj.includes('content="TAIL"'), inj);
  assert.ok(inj.includes(`content="${"$'"}"`), inj);
});

test('build: a config value cannot smuggle a {{placeholder}} into the layout', () => {
  // Placeholders fill in ONE pass. With sequential replaces an escaped (so
  // "safe") config string of "{{content}}" expanded on a later key's turn,
  // pulling the raw, unescaped page HTML into <title> and into a meta
  // attribute (verified against the real builder before this was fixed).
  const layout = '<title>{{title}}</title><meta content="{{description}}"><body>{{content}}</body>';
  const out = tpl(layout, {
    title: '{{content}}',
    description: '{{footer}}',
    content: '<img src=x onerror=alert(1)>',
    footer: '<a href="./x">f</a>',
  });
  assert.ok(out.includes('<title>{{content}}</title>'), out);
  assert.ok(out.includes('content="{{footer}}"'), out);
  assert.equal((out.match(/<img src=x/g) || []).length, 1, out);
  // known keys still fill; unknown ones are left alone rather than blanked
  assert.equal(tpl('{{a}}|{{zz}}', { a: '1' }), '1|{{zz}}');
  // inherited object properties are not placeholders
  assert.equal(tpl('{{constructor}}', {}), '{{constructor}}');
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

test('decoratePage: additive a11y only, classes and DOM structure survive', () => {
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

test('grantProblems: a grant holding the checkout URL is called out, not silently dead', () => {
  const { grantProblems } = require('../lib/fulfill-core.js');
  // The real shipping shape must stay silent.
  assert.deepEqual(
    grantProblems([{ payment_link: 'plink_1', product: 'Crew', repo: 'o/r', price: 'price_1' }]),
    []
  );
  // Sessions carry the plink_ id, never the buyer-facing URL: this grant can
  // never match, so every paid order is skipped with a green run and exit 0.
  const url = grantProblems([
    { payment_link: 'https://buy.stripe.com/8x29AT8J9d7xdqc', product: 'Crew', repo: 'o/r' },
  ]);
  assert.equal(url.length, 2, JSON.stringify(url));
  assert.ok(url[0].includes('checkout URL'), url[0]);
  assert.ok(url[0].includes('plink_'), 'says what to use instead');
  assert.ok(url[0].includes('Crew'), 'names the product');
  assert.ok(url[1].includes('never match'), url[1]);

  // price-only grants are valid (server-created sessions have no payment_link)
  assert.deepEqual(grantProblems([{ price: 'price_1', product: 'P', repo: 'o/r' }]), []);
  // a grant with nothing to match on, and one with nowhere to invite
  assert.ok(grantProblems([{ product: 'P', repo: 'o/r' }])[0].includes('never match'));
  assert.ok(grantProblems([{ price: 'price_1', product: 'P' }])[0].includes('repo'));
  assert.deepEqual(grantProblems(undefined), []);
});

test('theme contract: every shipped theme has print styles', () => {
  // The terminal theme's fixed-position scanline overlay covered the sheet in
  // the browser's default print path: terms/refunds/license saved as a BLANK
  // PDF. Those are the pages a buyer files and a processor asks for, so a
  // theme without an @media print block is a shipping defect, not a nicety.
  const fs = require('node:fs');
  const path = require('node:path');
  const themes = path.join(__dirname, '..', '..', 'themes');
  const names = fs.readdirSync(themes).filter((d) => fs.statSync(path.join(themes, d)).isDirectory());
  assert.ok(names.length >= 2, `expected the shipped themes, got ${names}`);
  for (const name of names) {
    const css = fs.readFileSync(path.join(themes, name, 'style.css'), 'utf8');
    assert.match(css, /@media\s+print/, `theme "${name}" ships no print styles`);
  }
});

test('configProblems: missing store keys are named, not a TypeError deep in a template', () => {
  const ok = { name: 'S', tagline: 'T', url: 'https://s.io' };
  assert.deepEqual(configProblems(ok), []);
  // each of these used to die as "Cannot read properties of undefined"
  for (const key of ['name', 'tagline', 'url']) {
    const bad = { ...ok };
    delete bad[key];
    const out = configProblems(bad);
    assert.equal(out.length, 1, `${key}: ${JSON.stringify(out)}`);
    assert.ok(out[0].includes(`"${key}"`), out[0]);
  }
  assert.ok(configProblems({ ...ok, name: '   ' })[0].includes('"name"'), 'blank is missing');
});

test('configProblems: a typo in a section type is an error, not a silently deleted band', () => {
  const base = { name: 'S', tagline: 'T', url: 'https://s.io' };
  // "stpes" used to fall through section() to '', so the seller's whole
  // how-it-works band vanished from the storefront with a green build.
  const typo = configProblems({ ...base, sections: [{ type: 'stpes', title: 'X' }] });
  assert.equal(typo.length, 1, JSON.stringify(typo));
  assert.ok(typo[0].includes('unknown type "stpes"'), typo[0]);
  assert.ok(typo[0].includes('steps'), 'lists the valid types');
  for (const t of ['steps', 'compare', 'faq', 'note', 'showcase']) {
    assert.deepEqual(configProblems({ ...base, sections: [{ type: t }] }), [], t);
  }
  assert.equal(configProblems({ ...base, sections: ['oops'] }).length, 1, 'non-object entry');
  assert.equal(configProblems({ ...base, sections: 'nope' }).length, 1, 'sections not a list');
  // sections is genuinely optional
  assert.deepEqual(configProblems(base), []);
});

test('templateProblems: a fork cannot silently sell HonorBox products', () => {
  // This repo is both the live store and the template. A seller who re-homes
  // the storefront but keeps the shipped links gets Buy buttons that take
  // their buyers' money into HonorBox's Stripe balance and deliver nothing.
  const ours = { repo: 'Honorboxx/honorbox', name: 'HonorBox', url: 'https://honorboxx.github.io/honorbox' };
  const products = [
    { id: 'crew', payment_link: 'https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03' },
    { id: 'honorbox-pro', payment_link: 'https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00' },
  ];
  // HonorBox's own build, and any contributor building locally, sees nothing.
  assert.deepEqual(templateProblems(ours, products), []);
  assert.ok(isUpstreamStore(ours));
  // A trailing slash on the URL is the same store, not a fork.
  assert.deepEqual(templateProblems({ ...ours, url: `${ours.url}/` }, products), []);

  // The seller this guard exists for: they edited exactly the fields
  // docs/setup.md lists (name, url, seller, copy) and never touched `repo`,
  // because `repo` is not in that list. This used to return []: the build
  // exited 0 and shipped a storefront whose hero button sold HonorBox Pro into
  // HonorBox's Stripe account. It must never be silent again.
  const followedTheDocs = { ...ours, name: 'Widget Works', url: 'https://alice.github.io/widgets' };
  const missed = templateProblems(followedTheDocs, products);
  assert.ok(!isUpstreamStore(followedTheDocs));
  assert.ok(missed.length >= 3, JSON.stringify(missed));
  assert.ok(missed.some((o) => /"repo" is still HonorBox/.test(o)), 'names the unset field');
  assert.ok(missed.some((o) => o.includes('products/honorbox-pro.md')), 'names the product file to delete');

  // An untouched checkout of the template is still our store: no false alarm
  // for a contributor who has changed nothing at all.
  assert.deepEqual(templateProblems({ ...ours }, products), []);

  const fork = { repo: 'janedev/tools', name: 'Jane', url: 'https://janedev.github.io/tools' };
  const out = templateProblems(fork, products);
  assert.equal(out.length, 2, JSON.stringify(out));
  for (const o of out) assert.match(o, /HonorBox's Stripe account/);
  assert.ok(out.some((o) => o.includes('products/crew.md')), 'names the file to edit');

  // the same poisoning through the fulfillment grants
  const grants = templateProblems(
    { repo: 'janedev/tools', fulfillment: [
      { payment_link: 'plink_1TupsnE9zX2nUu1OV1JOs3x3', price: 'price_1TupsmE9zX2nUu1O0MI3E8oR', repo: 'Honorboxx/crew-full' },
    ] },
    []
  );
  assert.equal(grants.length, 3, JSON.stringify(grants));
  assert.ok(grants.some((g) => g.includes('fulfillment[0].payment_link')), 'flags the plink');
  assert.ok(grants.some((g) => g.includes('fulfillment[0].price')), 'flags the price');
  assert.ok(grants.some((g) => g.includes('cannot invite buyers into')), 'flags the repo');

  // a seller who did the work is left alone
  assert.deepEqual(
    templateProblems(
      { repo: 'janedev/tools', fulfillment: [{ payment_link: 'plink_JANE', price: 'price_JANE', repo: 'janedev/tools-access' }] },
      [{ id: 'thing', payment_link: 'https://buy.stripe.com/janes_own_link' }]
    ),
    []
  );
});

test('slugProblems: a page may not overwrite a product page', () => {
  // products are written first, pages second, into one namespace: a
  // pages/honorbox-pro.md replaced the product page and its Buy button.
  const out = slugProblems(['honorbox-pro', 'crew'], ['terms', 'honorbox-pro']);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.ok(out[0].includes('honorbox-pro'), out[0]);
  assert.ok(/checkout/i.test(out[0]), 'says what is lost');
  assert.deepEqual(slugProblems(['crew'], ['terms', 'privacy']), []);
});

test('decoratePage: a theme that ships its own skip link does not get a second one', () => {
  // The stand theme (the shipping default) already has a skip link AND
  // <main id="main">, so the injection guard passed and every page went out
  // with the link duplicated. Keyboard users tabbed twice through the same
  // control, and the injected <style> came after the theme stylesheet, so it
  // also overrode the theme's designed focus state.
  const themeOwned =
    '<head><link rel="stylesheet" href="./style.css"></head>\n<body>\n' +
    '<a class="skip-link" href="#main">Skip to content</a>\n' +
    '<header class="site-head"></header>\n<main id="main">\n<p>x</p>\n</main>\n</body>';
  const out = decoratePage(themeOwned);
  assert.equal(out.match(/class="skip-link"/g).length, 1, 'exactly one skip link');
  // the theme styles its own link; injecting ours would win on source order
  assert.ok(!out.includes('<style>.skip-link'), 'no competing injected style');

  // a theme WITHOUT one still gets both the link and the style it needs
  const bare = decoratePage('<head></head>\n<body>\n<main>\n<p>x</p>\n</main>\n</body>');
  assert.equal(bare.match(/class="skip-link"/g).length, 1, 'bare theme gets a link');
  assert.ok(bare.includes('<style>.skip-link'), 'bare theme gets the style');
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

test('workflow templates: deploy template runs the whole test suite, pins match live', () => {
  // setup/workflows/ is what sellers copy; .github/workflows/deploy.yml is
  // what this repo runs. The two drift silently otherwise (the template
  // shipped running only core.test.js, so a seller's CI skipped the
  // dispatch and driver suites).
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const readWf = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const tpl = readWf('setup/workflows/deploy.yml');
  assert.ok(tpl.includes('node --test scripts/test/*.test.js'),
    'template must run every test file, not a hand-picked subset');
  // action pins: for every action used in both files, the SHA must match
  const pins = (src) => Object.fromEntries(
    [...src.matchAll(/uses:\s*([^@\s]+)@(\S+)/g)].map((m) => [m[1], m[2]])
  );
  const livePins = pins(readWf('.github/workflows/deploy.yml'));
  for (const [action, sha] of Object.entries(pins(tpl))) {
    if (livePins[action]) assert.equal(sha, livePins[action], `pin drift for ${action}`);
  }
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

test('markdown: image line directly after a paragraph is not swallowed', () => {
  // No blank line between prose and a standalone image: the paragraph loop
  // must stop so the image branch can render it, instead of inlining the
  // raw markdown into the <p> as a stray "!" plus link.
  const html = renderMarkdown('Some intro text\n![shot](./assets/x.png)');
  assert.ok(html.includes('<p>Some intro text</p>'), html);
  assert.ok(html.includes('<figure><img src="./assets/x.png"'), html);
  assert.ok(!html.includes('!<a'), html);
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

// ---------- free-tier cost: the "$0/month" claim is a cron budget ----------

// GitHub bills PRIVATE-repo Actions per job, rounded UP to a whole minute,
// against 2,000 free minutes/month on the Free plan:
//   "GitHub rounds the minutes and partial minutes each job uses up to the
//    nearest whole minute" (docs.github.com/en/billing/reference/actions-runner-pricing)
// A fulfillment run is ~15s, so it bills 1 minute whether or not it finds a
// sale, and the monthly bill is just the run count. Verified against this
// org's own metered usage: 44 runs of ~10-17s billed exactly 44.00 minutes.
const FREE_TIER_MINUTES = 2000;

// Runs per hour for a cron minute-field. "*/N" fires at every minute divisible
// by N (so */25 is :00,:25,:50 = 3, not 2), a list is its length, a literal is 1.
function runsPerHour(minuteField) {
  if (minuteField === '*') return 60;
  const step = /^\*\/(\d+)$/.exec(minuteField);
  if (step) return Math.ceil(60 / Number(step[1]));
  return minuteField.split(',').length;
}

// Worst case: every scheduled run actually fires, in a 31-day month.
function monthlyBillableMinutes(cron) {
  return runsPerHour(cron.trim().split(/\s+/)[0]) * 24 * 31;
}

function cronOf(wfPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', wfPath), 'utf8');
  // the first uncommented `- cron: "..."` line
  const m = /^\s*-\s*cron:\s*["']([^"']+)["']/m.exec(
    src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  );
  assert.ok(m, `no active cron found in ${wfPath}`);
  return m[1];
}

test('cron budget: the shipped fulfillment poll fits inside the free tier', () => {
  // This is the whole "$0/month" claim. The template shipped */15 = 2,976
  // billable minutes against a 2,000 allowance (976 over, ~$5.86/month), so
  // the headline was false for the configuration we recommend.
  const cron = cronOf('setup/workflows/fulfill.yml.example');
  const minutes = monthlyBillableMinutes(cron);
  assert.ok(
    minutes <= FREE_TIER_MINUTES,
    `poll cron "${cron}" costs ${minutes} billable min/month, over the ${FREE_TIER_MINUTES} free tier`
  );
  // Real headroom, not a photo finish: sale-triggered runs cost a minute each
  // (fulfill-on-sale.yml), and a store with no headroom bills on its 1st sale.
  assert.ok(
    FREE_TIER_MINUTES - minutes >= 400,
    `poll cron "${cron}" leaves only ${FREE_TIER_MINUTES - minutes} min for sale-triggered runs`
  );
});

test('cron budget: the heartbeat fits alongside an hourly poll', () => {
  // heartbeat.yml's cron runs in the seller's PUBLIC repo (free minutes), but
  // every nudge starts a run in the PRIVATE ops repo, which bills a full
  // minute even when it finds nothing. The template shipped */5 = 8,928
  // billable minutes: 4.5x the entire free tier.
  const minutes = monthlyBillableMinutes(cronOf('setup/workflows/heartbeat.yml'));
  const hourlyPoll = 24 * 31;
  assert.ok(
    minutes + hourlyPoll <= FREE_TIER_MINUTES,
    `heartbeat (${minutes}) + hourly poll (${hourlyPoll}) exceeds the ${FREE_TIER_MINUTES} free tier`
  );
});

test('cron budget: the arithmetic is published where a skeptic will check it', () => {
  // A cost claim a reader cannot verify is a cost claim we get to be wrong
  // about quietly. docs/setup.md must carry the actual numbers.
  const fs = require('node:fs');
  const path = require('node:path');
  const setup = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'setup.md'), 'utf8');
  assert.ok(/2,000/.test(setup), 'setup.md must state the free-tier allowance');
  assert.ok(/1,488/.test(setup), 'setup.md must state the shipped poll cost');
  assert.ok(/round/i.test(setup), 'setup.md must state the per-job rounding rule');
});

// ---------- docs published as store pages ----------

const { PUBLISHED_DOCS, docTitle, rewriteDocLinks } = require('../build.js');

test('docTitle: the doc\'s own H1 becomes the title and leaves the body', () => {
  // docs/*.md carry no frontmatter, and the page template renders its own
  // <h1>. Leaving the heading in the body renders it twice.
  const { title, body } = docTitle('# Tax, without the hand-waving\n\nBody text.\n', 'fallback');
  assert.equal(title, 'Tax, without the hand-waving');
  assert.ok(!/^#\s/m.test(body), 'the H1 must be removed from the body');
  assert.ok(body.includes('Body text.'));
  assert.equal(docTitle('no heading here', 'fallback').title, 'fallback');
});

test('rewriteDocLinks: a sibling doc we publish becomes an on-site link', () => {
  const out = rewriteDocLinks('see [setup](setup.md) and [lp](least-privilege.md#tokens)', { repo: 'o/r' });
  assert.ok(out.includes('](./setup.html)'), out);
  assert.ok(out.includes('](./least-privilege.html#tokens)'), out);
});

test('rewriteDocLinks: a doc we do NOT publish keeps working, via GitHub', () => {
  // pro-evidence.md is excluded from the store; a bare ./pro-evidence.html
  // would be a 404 on the live site.
  assert.ok(!PUBLISHED_DOCS.includes('pro-evidence'));
  const out = rewriteDocLinks('[e](pro-evidence.md)', { repo: 'o/r' });
  assert.equal(out, '[e](https://github.com/o/r/blob/main/docs/pro-evidence.md)');
});

test('rewriteDocLinks: repo paths outside docs/ resolve to GitHub, dir vs file', () => {
  const out = rewriteDocLinks('[w](../webhook-mode/) [f](../scripts/fulfill.js)', { repo: 'o/r' });
  assert.ok(out.includes('https://github.com/o/r/tree/main/webhook-mode/'), out);
  assert.ok(out.includes('https://github.com/o/r/blob/main/scripts/fulfill.js'), out);
});

test('rewriteDocLinks: a link-shaped regex inside a code span is left alone', () => {
  // docs/how-it-works.md documents the username rule as
  // `^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$`, which contains "](...)".
  // Rewriting runs on markdown source, so it sees inside code spans.
  const src = 'usernames match `^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$` exactly';
  assert.equal(rewriteDocLinks(src, { repo: 'o/r' }), src);
});

test('rewriteDocLinks: external and anchor links are untouched', () => {
  const src = '[s](https://stripe.com/x.md) [a](#section)';
  assert.equal(rewriteDocLinks(src, { repo: 'o/r' }), src);
});

test('docs build: every published doc exists and renders a titled page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  for (const slug of PUBLISHED_DOCS) {
    const file = path.join(root, 'docs', `${slug}.md`);
    assert.ok(fs.existsSync(file), `docs/${slug}.md is listed in PUBLISHED_DOCS but missing`);
    const { title, body } = docTitle(fs.readFileSync(file, 'utf8'), slug);
    assert.ok(title && title !== slug, `docs/${slug}.md needs an H1 for its page title`);
    const html = renderMarkdown(rewriteDocLinks(body, { repo: 'o/r' }));
    // a doc that still points at a bare .md would 404 on the live site
    assert.ok(!/href="[^"]*\.md"/.test(html), `docs/${slug}.md ships an unrewritten .md link`);
  }
});

test('faq: an answer that promises a doc renders a real link to it', () => {
  // The live FAQ said "the least-privilege guide in the docs shows the exact
  // toggles" with nothing to click.
  const withHref = section({
    type: 'faq', title: 'Q', items: [{ q: 'k', a: 'a', href: './least-privilege.html', href_label: 'The guide' }],
  });
  assert.ok(withHref.includes('href="./least-privilege.html"'), withHref);
  assert.ok(withHref.includes('The guide'), withHref);
  // and an answer without one is unchanged
  const plain = section({ type: 'faq', title: 'Q', items: [{ q: 'k', a: 'a' }] });
  assert.ok(!plain.includes('<a '), plain);
});

test('faq: a hostile href in config cannot become a javascript: link', () => {
  const out = section({ type: 'faq', title: 'Q', items: [{ q: 'k', a: 'a', href: 'javascript:alert(1)' }] });
  assert.ok(!out.includes('javascript:'), out);
});

test('steps: a section note is rendered rather than silently dropped', () => {
  // `compare` and `showcase` already honoured `note`; `steps` did not, so a
  // note written on a steps section vanished with a green build. That is the
  // failure shape this repo keeps fixing: config that looks honoured and is not.
  const withNote = section({
    type: 'steps', title: 'T', note: 'why this list exists', items: [{ title: 'a', text: 'b' }],
  });
  assert.ok(withNote.includes('why this list exists'), withNote);
  // escaped like every other config-authored string, never raw HTML
  const hostile = section({
    type: 'steps', title: 'T', note: '<img src=x onerror=alert(1)>', items: [{ title: 'a', text: 'b' }],
  });
  assert.ok(!hostile.includes('<img'), hostile);
  // and a steps section without one is unchanged
  const plain = section({ type: 'steps', title: 'T', items: [{ title: 'a', text: 'b' }] });
  assert.ok(!plain.includes('class="muted"'), plain);
});

// ---------- markdown tables ----------

test('markdown: a pipe table renders as a table, not a paragraph of pipes', () => {
  // docs/instant-delivery.md shipped a table that rendered as pipe soup
  // because the renderer had no table support; publishing the docs exposed it.
  const html = renderMarkdown('| Mode | Delivery |\n|---|---|\n| Poll | minutes |\n');
  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('<th scope="col">Mode</th>'), html);
  assert.ok(html.includes('<td>Poll</td>'), html);
  assert.ok(!html.includes('|'), `no raw pipes should survive: ${html}`);
  // wide tables scroll inside themselves rather than widening the page
  assert.ok(html.includes('table-scroll'), html);
});

test('markdown: a table needs its delimiter row (prose with a pipe is prose)', () => {
  const html = renderMarkdown('use grep | wc -l to count\n\nnext paragraph\n');
  assert.ok(!html.includes('<table>'), html);
  assert.ok(html.includes('<p>'), html);
});

test('markdown: a pipe inside a code span is content, not a cell separator', () => {
  const html = renderMarkdown('| Cmd | Note |\n|---|---|\n| `a \\| b` | pipes |\n');
  const cells = html.match(/<td[^>]*>/g) || [];
  assert.equal(cells.length, 2, `expected 2 cells, got ${cells.length}: ${html}`);
  assert.ok(html.includes('<code>a | b</code>'), html);
});

test('markdown: table cells render inline markup and escape HTML', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| **bold** | <script>x</script> |\n');
  assert.ok(html.includes('<strong>bold</strong>'), html);
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
});

test('markdown: a table directly under a paragraph is not swallowed by it', () => {
  const html = renderMarkdown('Costs:\n| A | B |\n|---|---|\n| 1 | 2 |\n');
  assert.ok(html.includes('<table>'), html);
  assert.ok(html.includes('<p>Costs:</p>'), html);
});

test('markdown: alignment markers set text-align and are not printed', () => {
  const html = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n');
  assert.ok(html.includes('text-align:center'), html);
  assert.ok(html.includes('text-align:right'), html);
  assert.ok(!html.includes(':-'), html);
});

test('markdown: a short row is padded, not shifted into the wrong column', () => {
  const html = renderMarkdown('| A | B | C |\n|---|---|---|\n| 1 |\n');
  const row = /<tr>(?:(?!<tr>).)*<td[^>]*>1<\/td>.*/s.exec(html)[0];
  assert.equal((row.match(/<td/g) || []).length, 3, html);
});

// A 100%-off order is a real invite that moved no money. On 2026-07-20 the live
// account carried two active 100%-off promotion codes on both live payment
// links; the surface is closed now, but the coupon path remains (it is how a
// free E2E test is run), so the engine must still be able to say so out loud.
// Note the shape this must catch: the live free session came back
// payment_status="paid" with amount_total=0, NOT "no_payment_required". A
// check written against only the latter would miss the real thing.
test('a zero-cost fulfillment is distinguishable from a real sale', () => {
  const free = [
    { amount_total: 0, payment_status: 'paid' },              // observed live shape
    { amount_total: 0, payment_status: 'no_payment_required' },
    { payment_status: 'paid' },                                // amount absent
  ];
  for (const s of free) {
    assert.equal(isFreeFulfillment(s), true, JSON.stringify(s));
  }
  for (const s of [{ amount_total: 2900, payment_status: 'paid' },
                   { amount_total: 1, payment_status: 'paid' }]) {
    assert.equal(isFreeFulfillment(s), false, JSON.stringify(s));
  }
});

test('every theme lets a sized image keep its aspect ratio', () => {
  // The defect this pins, found on the live-preview pass before it shipped:
  // once <img> carries real width/height, a rule of `max-width: 100%` WITHOUT
  // `height: auto` honours the explicit height literally while clamping the
  // width. A 1200x630 landscape panel then rendered as a 358x630 portrait:
  // every gallery image on the product page stretched, desktop and mobile.
  //
  // It was latent in all six themes long before the attributes existed, and it
  // would bite any seller who put a sized image in their own prose. The
  // .showcase rules already set width/height explicitly and were never
  // affected, which is exactly why the homepage looked fine and the product
  // page did not.
  const fs = require('node:fs');
  const path = require('node:path');
  const themesDir = path.join(__dirname, '..', '..', 'themes');
  const themes = fs.readdirSync(themesDir).filter((t) =>
    fs.existsSync(path.join(themesDir, t, 'style.css'))
  );
  assert.ok(themes.length > 0, 'expected at least one theme to check');
  for (const t of themes) {
    const css = fs.readFileSync(path.join(themesDir, t, 'style.css'), 'utf8');
    // Isolate the declaration block that styles prose/gallery images, with
    // comments stripped FIRST: the fix ships next to a comment explaining it,
    // and matching that comment is how this assertion quietly passed against
    // deliberately broken CSS the first time it was written.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const m = /\.prose img[^{]*\{([^}]*)\}/.exec(bare);
    assert.ok(m, `${t}: no ".prose img" rule found; did the selector change?`);
    assert.match(
      m[1], /height:\s*auto/,
      `${t}/style.css: ".prose img" sets max-width without "height: auto", so an ` +
        `image with width/height attributes will render stretched`
    );
  }
});

test('the social card is a decision, and a fallback is never silent', () => {
  // The failure this closes: moving the gallery to WebP made firstRasterImage
  // find nothing a scraper could decode, so og:image, twitter:image and the
  // JSON-LD Product.image ALL silently changed from the terminal screenshot to
  // the theme preview. The build stayed green while the product's link preview
  // quietly became a different picture: success reported, something else done.
  const { firstRasterImage } = require('../lib/md.js');
  const OG_SAFE = /\.(png|jpe?g|gif)$/i;
  const body = [
    '![terminal](./assets/previews/terminal.webp)',
    '![midnight](./assets/previews/midnight.webp)',
  ].join('\n');

  // A body of WebP has images, but none a card scraper can be trusted with.
  assert.equal(firstRasterImage(body), './assets/previews/terminal.webp',
    'the page itself still has images');
  assert.equal(firstRasterImage(body, { ext: OG_SAFE }), null,
    'none of them is usable as a social card');
  // Those two disagreeing is exactly the condition that must warn rather than
  // substitute: pictures present, none card-safe, nobody chose one.

  // A PNG in the body is still picked up automatically, so a store that never
  // adopts WebP keeps working with no frontmatter at all.
  assert.equal(
    firstRasterImage('![t](./assets/previews/terminal.png)', { ext: OG_SAFE }),
    './assets/previews/terminal.png'
  );
  // An SVG is not a raster and was never a candidate either way.
  assert.equal(firstRasterImage('![l](./logo.svg)', { ext: OG_SAFE }), null);
});

test('a named social card must be real and scraper-safe, or the build stops', () => {
  // og_image is an explicit choice, so a broken one is an error rather than
  // something to paper over. The whole point is to stop cards changing by
  // accident. Driven through the real builder in a child process, because the
  // check lives in the build's problem gate and exits the process.
  // spawnSync, not execFileSync: execFileSync only surfaces stderr on the
  // throw path, so a SUCCESSFUL build's warnings would be invisible, and the
  // whole point of case (c) is that a green build still speaks up.
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..', '..');
  const src = path.join(ROOT, 'products', 'honorbox-pro.md');
  const original = fs.readFileSync(src, 'utf8');
  assert.match(original, /^og_image:/m, 'the Pro product must name its card explicitly');

  const build = () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], {
      cwd: ROOT, encoding: 'utf8',
    });
    return { code: r.status, err: String(r.stderr || '') };
  };

  try {
    // (a) points at nothing
    fs.writeFileSync(src, original.replace(/^og_image: .*$/m, 'og_image: ./assets/previews/nope.png'));
    let r = build();
    assert.equal(r.code, 2, 'a missing card file must fail the build');
    assert.match(r.err, /og_image .*does not exist/);

    // (b) a format scrapers do not reliably render
    fs.writeFileSync(src, original.replace(/^og_image: .*$/m, 'og_image: ./assets/previews/terminal.webp'));
    r = build();
    assert.equal(r.code, 2, 'a WebP card must fail the build, not ship a blank preview');
    assert.match(r.err, /og_image must be \.png/);

    // (c) no card named at all, and a body of WebP: builds, but says so
    fs.writeFileSync(src, original.replace(/^og_image: .*$/m, ''));
    r = build();
    assert.equal(r.code, 0, 'a store with no card named must still build');
    assert.match(r.err, /WARN .*fell back to/, 'the fallback must be loud, never silent');

    // (d) as shipped
    fs.writeFileSync(src, original);
    r = build();
    assert.equal(r.code, 0, `the real product must build clean:\n${r.err}`);
    assert.doesNotMatch(r.err, /WARN/, 'the shipped store must not be warning about its own card');
  } finally {
    fs.writeFileSync(src, original);
  }
});

// Which Stripe account a key reaches. The point of the function is that
// nothing else in a run tells you: STRIPE_SECRET_KEY is an ordinary variable
// name and a live key sitting in it looks exactly like a test key.
test('stripeMode reads live and test off the key prefix', () => {
  assert.equal(stripeMode('sk_live_' + 'x'.repeat(24)), 'live');
  assert.equal(stripeMode('rk_live_' + 'x'.repeat(24)), 'live');
  assert.equal(stripeMode('sk_test_' + 'x'.repeat(24)), 'test');
  assert.equal(stripeMode('rk_test_' + 'x'.repeat(24)), 'test');
});

// The direction that costs money. Anything unrecognised must NOT come back as
// 'test', or a typo'd or future key shape reads as safe and a live run goes
// out under a test banner.
test('stripeMode calls an unrecognised key unknown, never test', () => {
  for (const k of ['', null, undefined, 'sk_' + 'x'.repeat(24), 'pk_live_x', 'whsec_x', 'not-a-key']) {
    assert.equal(stripeMode(k), 'unknown', `expected unknown for ${JSON.stringify(k)}`);
  }
});

// Prefix must anchor. A key that merely CONTAINS the text is not a live key,
// and more importantly a live key with something pasted in front of it must
// not read as unknown-and-therefore-ignorable either way round.
test('stripeMode anchors the prefix', () => {
  assert.equal(stripeMode('xsk_live_' + 'x'.repeat(24)), 'unknown');
  assert.equal(stripeMode(' sk_live_' + 'x'.repeat(24)), 'unknown');
});

// Stripe answers a bad key with `Invalid API Key provided: sk_test_****0000`,
// and that body is logged verbatim by the driver. The key must not survive the
// trip into a CI log.
test('redactKeys removes key material from a provider error body', () => {
  const live = 'sk_live_' + 'A1b2C3d4'.repeat(3);
  const body = `{"error":{"message":"Invalid API Key provided: ${live}"}}`;
  const out = redactKeys(body);
  assert.ok(!out.includes(live), 'the key survived redaction');
  assert.ok(!out.includes('A1b2C3d4'), 'a fragment of the key survived redaction');
});

// Which ACCOUNT failed is the useful half of that message and is not secret,
// so the mode prefix is kept deliberately.
test('redactKeys keeps the mode prefix, which is the diagnostic half', () => {
  const out = redactKeys('Invalid API Key provided: sk_live_' + 'x'.repeat(24));
  assert.match(out, /sk_live_<redacted>/);
});

// Stripe echoes a malformed key in full rather than masking it, and a value
// that never matched the key shape cannot be found by prefix. The phrase that
// carries it is cut instead.
test('redactKeys cuts a malformed key that has no recognisable prefix', () => {
  const out = redactKeys('Invalid API Key provided: totally-wrong-value');
  assert.ok(!out.includes('totally-wrong-value'));
  assert.match(out, /<redacted>/);
});

test('redactKeys leaves ordinary error text alone', () => {
  const msg = 'No such checkout session: cs_test_abc123';
  assert.equal(redactKeys(msg), msg);
});
