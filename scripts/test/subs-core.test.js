'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  GRANT,
  HOLD,
  LAPSE,
  DEFAULT_GRACE_DAYS,
  subscriptionAction,
  normalizeUser,
  grantKey,
  seatUsernames,
  subscriptionRepos,
  desiredEntitlements,
  graceExpired,
  diffEntitlements,
  distinctUsers,
  breakerVerdict,
  revokeLine,
  breakerLine,
  subscriptionConfigProblems,
} = require('../lib/subs-core.js');
const { recordRevocation, revocationSource, clearLapse } = require('../lib/access-record.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const GRANTS = [
  { price: 'price_sub', product: 'Widget', repo: 'acme/widget' },
  { price: 'price_other', product: 'Gadget', repo: 'acme/gadget' },
];

function sub(over = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    items: { data: [{ price: { id: 'price_sub' }, quantity: 1 } ] },
    ...over,
  };
}

// --- the status table -------------------------------------------------------
// This is the table from the spec, asserted. If someone edits the mapping, the
// row they changed names itself in the failure.

test('every Stripe subscription status maps to its documented action', () => {
  const table = [
    ['active', GRANT],
    ['trialing', GRANT],
    ['past_due', HOLD],
    ['incomplete', HOLD],
    ['incomplete_expired', LAPSE],
    ['canceled', LAPSE],
    ['unpaid', LAPSE],
  ];
  for (const [status, expected] of table) {
    assert.equal(subscriptionAction(sub({ status })).action, expected, status);
  }
});

test('past_due is NEVER a lapse, however long it lasts', () => {
  // The single most important assertion in this file. Stripe retries failed
  // cards for weeks; treating that window as a cancellation locks out a
  // customer whose bank declined once.
  const a = subscriptionAction(sub({ status: 'past_due' }));
  assert.equal(a.action, HOLD);
  assert.notEqual(a.action, LAPSE);
});

test('an unrecognized or missing status holds access and asks to be told', () => {
  for (const status of ['some_future_status', '', null, undefined, 42]) {
    const a = subscriptionAction(sub({ status }));
    assert.equal(a.action, HOLD, String(status));
    assert.ok(a.warn, 'must warn: ' + String(status));
  }
});

test('paused splits by cause instead of picking one action', () => {
  // A trial that fizzled: nobody is paying, so holding would give the product
  // away on every failed trial.
  const trial = sub({
    status: 'paused',
    status_details: { paused: { subscription: { type: 'trial_end_without_payment_method' } } },
  });
  assert.equal(subscriptionAction(trial).action, LAPSE);

  // A seller who deliberately paused their own customer means to keep them.
  assert.equal(subscriptionAction(sub({ status: 'paused', pause_collection: { behavior: 'void' } })).action, HOLD);
  const requested = sub({ status: 'paused', status_details: { paused: { subscription: { type: 'pause_requested' } } } });
  assert.equal(subscriptionAction(requested).action, HOLD);

  // Cause undeterminable: take the recoverable error and surface it.
  const vague = subscriptionAction(sub({ status: 'paused' }));
  assert.equal(vague.action, HOLD);
  assert.ok(vague.warn);
  assert.match(vague.reason, /undeterminable/);
});

test('pause_collection wins over a stale status_details cause', () => {
  // An explicit seller statement of intent outranks an inferred cause.
  const s = sub({
    status: 'paused',
    pause_collection: { behavior: 'void' },
    status_details: { paused: { subscription: { type: 'trial_end_without_payment_method' } } },
  });
  assert.equal(subscriptionAction(s).action, HOLD);
});

test('a malformed status_details cannot crash the mapping', () => {
  for (const bad of [{}, { paused: null }, { paused: {} }, { paused: { subscription: null } }]) {
    const a = subscriptionAction(sub({ status: 'paused', status_details: bad }));
    assert.equal(a.action, HOLD);
  }
});

// --- identity and seats -----------------------------------------------------

test('usernames compare case-insensitively, so one person is one person', () => {
  assert.equal(normalizeUser('OctoCat'), 'octocat');
  assert.equal(normalizeUser('  octocat '), 'octocat');
  assert.equal(grantKey('Acme/Widget', 'OctoCat'), grantKey('acme/widget', 'octocat'));
  for (const junk of [null, undefined, 42, {}]) assert.equal(normalizeUser(junk), '');
});

test('a seat roster is a list from the first commit, never a bare string', () => {
  // Multi-seat behaviour is phase 2, but nothing may assume one username per
  // order or adding it later becomes a schema migration.
  const seats = seatUsernames('OctoCat');
  assert.ok(Array.isArray(seats));
  assert.deepEqual(seats, ['octocat']);
  assert.deepEqual(seatUsernames(''), []);
  assert.deepEqual(seatUsernames(null), []);
});

test('a subscription grants the repos its price is configured for', () => {
  assert.deepEqual(subscriptionRepos(sub(), GRANTS), ['acme/widget']);
  const both = sub({ items: { data: [{ price: { id: 'price_sub' } }, { price: { id: 'price_other' } }] } });
  assert.deepEqual(subscriptionRepos(both, GRANTS), ['acme/widget', 'acme/gadget']);
  // A subscription for something this store does not fulfill is not ours.
  assert.deepEqual(subscriptionRepos(sub({ items: { data: [{ price: { id: 'price_x' } }] } }), GRANTS), []);
  for (const bad of [null, {}, { items: null }, { items: { data: null } }]) {
    assert.deepEqual(subscriptionRepos(bad, GRANTS), []);
  }
});

// --- desired state ----------------------------------------------------------

test('desired entitlements cover only granting statuses', () => {
  const subs = [
    sub({ id: 'sub_a', status: 'active' }),
    sub({ id: 'sub_b', status: 'trialing' }),
    sub({ id: 'sub_c', status: 'canceled' }),
    sub({ id: 'sub_d', status: 'past_due' }),
  ];
  const users = { sub_a: 'alice', sub_b: 'bob', sub_c: 'carol', sub_d: 'dave' };
  const { desired } = desiredEntitlements(subs, users, GRANTS);
  assert.deepEqual([...desired.keys()].sort(), ['acme/widget|alice', 'acme/widget|bob']);
});

test('a held subscription is carried explicitly, not left to look like a lapse', () => {
  // Regression. HOLD and LAPSE are both simply absent from `desired`, so
  // without a held set a past_due customer starts a grace clock and is
  // eventually revoked, which is the exact failure this design exists to
  // prevent. Found by the driver test; asserted here at the cheap layer too.
  const subs = [sub({ id: 'sub_a', status: 'past_due' }), sub({ id: 'sub_b', status: 'incomplete' })];
  const { desired, heldSubs } = desiredEntitlements(subs, { sub_a: 'alice', sub_b: 'bob' }, GRANTS);
  assert.equal(desired.size, 0, 'held subscriptions are not entitled');
  assert.deepEqual([...heldSubs].sort(), ['sub_a', 'sub_b']);
});

test('a past_due customer never starts a grace clock', () => {
  const subs = [sub({ id: 'sub_a', status: 'past_due' })];
  const { desired, heldSubs } = desiredEntitlements(subs, { sub_a: 'alice' }, GRANTS);
  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: null } };
  const d = diffEntitlements(desired, records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']), heldSubs });
  assert.deepEqual(d.lapsing, [], 'no clock may start');
  assert.deepEqual(d.due, [], 'and nothing may be revoked');
});

test('a paused subscription held for an unknown reason keeps access', () => {
  const subs = [sub({ id: 'sub_a', status: 'paused' })];
  const { desired, heldSubs } = desiredEntitlements(subs, { sub_a: 'alice' }, GRANTS);
  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: null } };
  const d = diffEntitlements(desired, records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']), heldSubs });
  assert.deepEqual(d.due, []);
  assert.deepEqual(d.lapsing, []);
});

test('losing a customer username must never cost them access', () => {
  // The hole this closes: a live subscription whose username we cannot resolve
  // produced no desired pair, so its existing grant looked unwanted, lapsed,
  // and was eventually revoked. A paying customer would have lost access
  // because WE lost track of their username. Protection is per subscription and
  // is recorded before any of that resolution can fail.
  const subs = [sub({ id: 'sub_a', status: 'active' })];
  const { desired, heldSubs } = desiredEntitlements(subs, {} /* no username known */, GRANTS);
  assert.equal(desired.size, 0);
  assert.ok(heldSubs.has('sub_a'), 'the subscription still protects its grants');

  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: null } };
  const d = diffEntitlements(desired, records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']), heldSubs });
  assert.deepEqual(d.lapsing, []);
  assert.deepEqual(d.due, []);
});

test('a plan moving to an unconfigured price does not evict the customer', () => {
  // Same shape: the subscription is alive, we just cannot map it to a repo.
  // That is a config question for a human, not grounds for removing anyone.
  const subs = [sub({ id: 'sub_a', status: 'active', items: { data: [{ price: { id: 'price_unknown' } }] } })];
  const { desired, heldSubs, notes } = desiredEntitlements(subs, { sub_a: 'alice' }, GRANTS);
  assert.equal(desired.size, 0);
  assert.ok(heldSubs.has('sub_a'));
  assert.match(notes[0].message, /matches no configured product/);

  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: null } };
  const d = diffEntitlements(desired, records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']), heldSubs });
  assert.deepEqual(d.due, []);
  assert.deepEqual(d.lapsing, []);
});

test('a genuinely cancelled subscription is still not protected', () => {
  // The counterweight: heldSubs must not become a blanket amnesty, or
  // enforcement stops working entirely.
  const subs = [sub({ id: 'sub_a', status: 'canceled' })];
  const { heldSubs } = desiredEntitlements(subs, { sub_a: 'alice' }, GRANTS);
  assert.equal(heldSubs.has('sub_a'), false);
  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: new Date(NOW - 9 * DAY).toISOString() } };
  const d = diffEntitlements(new Map(), records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']), heldSubs });
  assert.deepEqual(d.due.map((p) => p.user), ['alice']);
});

test('an entitled subscription with no known username is reported, never guessed', () => {
  const { desired, notes } = desiredEntitlements([sub({ id: 'sub_a' })], {}, GRANTS);
  assert.equal(desired.size, 0);
  assert.match(notes[0].message, /no GitHub username/);
});

// --- grace ------------------------------------------------------------------

test('grace holds access for the configured window and not a moment less', () => {
  const since = new Date(NOW - 6 * DAY).toISOString();
  assert.equal(graceExpired(since, 7, NOW), false, 'day 6 of 7 keeps access');
  assert.equal(graceExpired(new Date(NOW - 7 * DAY).toISOString(), 7, NOW), true);
  assert.equal(graceExpired(new Date(NOW - 30 * DAY).toISOString(), 0, NOW), true, 'zero grace is allowed');
});

test('an unparseable grace clock never expires', () => {
  // Corrupt state must not be able to revoke anyone.
  for (const bad of [null, undefined, '', 'not-a-date', 42]) {
    assert.equal(graceExpired(bad, 7, NOW), false, String(bad));
  }
});

test('grace defaults to the generous value when the config is nonsense', () => {
  const since = new Date(NOW - 5 * DAY).toISOString();
  assert.equal(graceExpired(since, NaN, NOW), false);
  assert.equal(graceExpired(since, -1, NOW), false);
  assert.equal(DEFAULT_GRACE_DAYS, 7);
});

// --- the diff, and the property that makes this safe ------------------------

test('we never revoke a pair we did not record granting ourselves', () => {
  // The seller, their team, contributors, one-time buyers and everyone from
  // before this feature existed are simply not in the records, so they cannot
  // be touched. Safe by construction, not by a check.
  const desired = new Map();
  const records = {}; // nobody was ever subscription-granted
  const d = diffEntitlements(desired, records, { now: NOW });
  assert.deepEqual(d.due, []);
  assert.deepEqual(d.lapsing, []);
});

test('a lapsed grant serves its grace before it is due', () => {
  const records = {
    'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: new Date(NOW - 2 * DAY).toISOString() },
    'acme/widget|bob': { repo: 'acme/widget', user: 'bob', sub: 'sub_b', lapsed_since: new Date(NOW - 9 * DAY).toISOString() },
  };
  const d = diffEntitlements(new Map(), records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']) });
  assert.deepEqual(d.lapsing.map((p) => p.user), ['alice']);
  assert.deepEqual(d.due.map((p) => p.user), ['bob']);
});

test('a repo that has left the config is out of scope, not a mass cancellation', () => {
  const records = {
    'acme/old|alice': { repo: 'acme/old', user: 'alice', sub: 'sub_a', lapsed_since: new Date(NOW - 99 * DAY).toISOString() },
  };
  const d = diffEntitlements(new Map(), records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']) });
  assert.deepEqual(d.due, [], 'removing a product from config must not evict its customers');
});

test('a suppressed grant is never re-granted and never revoked again', () => {
  // Set when a refund or dispute already removed someone. Without it the
  // reconciler re-invites the customer the refund guard just removed, forever.
  const records = {
    'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: new Date(NOW - 99 * DAY).toISOString(), suppressed: 'refund' },
  };
  const d = diffEntitlements(new Map(), records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']) });
  assert.deepEqual(d.due, []);
});

test('an entitled pair with no record is granted', () => {
  const desired = new Map([['acme/widget|alice', { repo: 'acme/widget', user: 'alice', sub: 'sub_a' }]]);
  const d = diffEntitlements(desired, {}, { now: NOW });
  assert.deepEqual(d.grants.map((p) => p.user), ['alice']);
});

test('a customer entitled by a second subscription is never revoked for the first', () => {
  // Two subscriptions to the same repo, one cancels. Entitlement is a union,
  // so the one still standing keeps them in.
  const subs = [sub({ id: 'sub_a', status: 'canceled' }), sub({ id: 'sub_b', status: 'active' })];
  const { desired } = desiredEntitlements(subs, { sub_a: 'alice', sub_b: 'alice' }, GRANTS);
  const records = { 'acme/widget|alice': { repo: 'acme/widget', user: 'alice', sub: 'sub_a', lapsed_since: new Date(NOW - 99 * DAY).toISOString() } };
  const d = diffEntitlements(desired, records, { graceDays: 7, now: NOW, knownRepos: new Set(['acme/widget']) });
  assert.deepEqual(d.due, [], 'still paying through another subscription');
  assert.deepEqual(d.keep.map((p) => p.user), ['alice'], 'and their lapse clock is cleared');
});

// --- the revocation record's source ----------------------------------------

test('a revocation record says who wrote it', () => {
  const lapse = recordRevocation([], 'acme/widget', 'alice', 100, 'lapse');
  assert.equal(lapse[0].source, 'lapse');
  const refund = recordRevocation([], 'acme/widget', 'alice', 100, 'refund');
  assert.equal(refund[0].source, 'refund');
});

test('a caller that forgets the source gets the safe one', () => {
  // Defaulting to 'lapse' would make a forgotten argument auto-clearable,
  // which is the dangerous direction.
  const rows = recordRevocation([], 'acme/widget', 'alice', 100);
  assert.equal(rows[0].source, 'refund');
  assert.equal(recordRevocation([], 'a/b', 'c', 1, 'nonsense')[0].source, 'refund');
});

test('a record written before the source field existed reads as a refund', () => {
  // "Absence is not evidence" again. A missing source tells us nothing about
  // provenance, so it takes the branch where being wrong is survivable.
  assert.equal(revocationSource({ key: 'a/b#c', ts: 1 }), 'refund');
  assert.equal(revocationSource({ key: 'a/b#c', ts: 1, source: undefined }), 'refund');
  assert.equal(revocationSource(null), 'refund');
  assert.equal(revocationSource({ key: 'a/b#c', ts: 1, source: 'lapse' }), 'lapse');
});

test('a returning customer clears a lapse block', () => {
  const rows = recordRevocation([], 'acme/widget', 'alice', 100, 'lapse');
  assert.deepEqual(clearLapse(rows, 'acme/widget', 'alice'), []);
  // Case folds, because Octocat and octocat are one person.
  assert.deepEqual(clearLapse(rows, 'Acme/Widget', 'Alice'), []);
});

test('a returning customer does NOT clear a refund block', () => {
  // The dangerous half. Clearing this would hand a refunded buyer their access
  // back automatically, which is refund fraud we would have built ourselves.
  const rows = recordRevocation([], 'acme/widget', 'alice', 100, 'refund');
  assert.deepEqual(clearLapse(rows, 'acme/widget', 'alice'), rows);
  // And neither does a legacy record with no source at all.
  const legacy = [{ key: 'acme/widget#alice', ts: 100 }];
  assert.deepEqual(clearLapse(legacy, 'acme/widget', 'alice'), legacy);
});

test('clearing one person leaves everybody else alone', () => {
  let rows = recordRevocation([], 'acme/widget', 'alice', 100, 'lapse');
  rows = recordRevocation(rows, 'acme/widget', 'bob', 200, 'lapse');
  rows = recordRevocation(rows, 'acme/gadget', 'alice', 300, 'lapse');
  const after = clearLapse(rows, 'acme/widget', 'alice');
  assert.deepEqual(after.map((r) => r.key).sort(), ['acme/gadget#alice', 'acme/widget#bob']);
});

test('a later revocation replaces an earlier one, keeping one row per person', () => {
  // Latest-record-per-key, so a future state field composes through the same
  // merge instead of needing new collision rules.
  let rows = recordRevocation([], 'acme/widget', 'alice', 100, 'lapse');
  rows = recordRevocation(rows, 'acme/widget', 'alice', 200, 'refund');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'refund');
  assert.equal(rows[0].ts, 200);
  // A refund landing on top of a lapse must make it unclearable.
  assert.deepEqual(clearLapse(rows, 'acme/widget', 'alice'), rows);
});

// --- the circuit breaker ----------------------------------------------------

test('the breaker counts people, not repo pairs', () => {
  const pairs = [
    { user: 'alice', repo: 'a/one' },
    { user: 'alice', repo: 'a/two' },
    { user: 'alice', repo: 'a/three' },
  ];
  assert.equal(distinctUsers(pairs), 1, 'one person losing three repos is one revocation');
});

test('routine churn passes, a mass revocation is refused', () => {
  const entitled = Array.from({ length: 100 }, (_, i) => ({ user: `u${i}`, repo: 'a/r' }));
  const few = entitled.slice(0, 5).map((p) => ({ ...p }));
  assert.equal(breakerVerdict(few, entitled, { enumeratedSubs: 100 }).allowed, true);

  const many = entitled.slice(0, 40).map((p) => ({ ...p }));
  const v = breakerVerdict(many, entitled, { enumeratedSubs: 100 });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /over the safety limit/);
});

test('the breaker is all or nothing, never a partial drain', () => {
  // Revoking up to the limit and stopping would be mass revocation in slow
  // motion: each pass takes its three, alarms, and empties the store in a day.
  const entitled = Array.from({ length: 100 }, (_, i) => ({ user: `u${i}`, repo: 'a/r' }));
  const v = breakerVerdict(entitled.slice(0, 40), entitled, { enumeratedSubs: 100 });
  assert.equal(v.allowed, false);
  assert.equal(typeof v.limit, 'number');
  // The verdict carries no "revoke this many anyway" affordance at all.
  assert.ok(!('partial' in v) && !('allowedCount' in v));
});

test('a small store can still enforce, via the floor', () => {
  // Percentage alone would refuse every real revocation for a store with five
  // subscribers, which makes enforcement theatre.
  const entitled = Array.from({ length: 5 }, (_, i) => ({ user: `u${i}`, repo: 'a/r' }));
  assert.equal(breakerVerdict(entitled.slice(0, 1), entitled, { enumeratedSubs: 5 }).allowed, true);
  assert.equal(breakerVerdict(entitled.slice(0, 3), entitled, { enumeratedSubs: 5 }).allowed, true);
  assert.equal(breakerVerdict(entitled.slice(0, 4), entitled, { enumeratedSubs: 5 }).allowed, false);
});

test('an empty Stripe response is refused on its own terms', () => {
  const entitled = [{ user: 'alice', repo: 'a/r' }];
  const v = breakerVerdict(entitled, entitled, { enumeratedSubs: 0 });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /ZERO subscriptions/);
  assert.match(v.reason, /wrong API key|wrong account/);
});

test('a pass with nothing to revoke is always allowed', () => {
  assert.equal(breakerVerdict([], [], { enumeratedSubs: 0 }).allowed, true);
});

test('the limits are configurable and still defended by the floor', () => {
  const entitled = Array.from({ length: 100 }, (_, i) => ({ user: `u${i}`, repo: 'a/r' }));
  assert.equal(breakerVerdict(entitled.slice(0, 30), entitled, { enumeratedSubs: 100, percent: 50 }).allowed, true);
  assert.equal(breakerVerdict(entitled.slice(0, 2), entitled, { enumeratedSubs: 100, percent: 0, floor: 3 }).allowed, true);
});

// --- logging ----------------------------------------------------------------

test('a revocation is loud, greppable and reversible from the line itself', () => {
  const line = revokeLine({
    user: 'alice', repo: 'acme/widget', sub: 'sub_a', reason: 'canceled',
    lapsed_since: '2026-07-01T00:00:00.000Z',
  });
  // The watchdog's ALERT_RE is /FAILED|WARN:|BOTS FAILED|^CONFIG /.
  assert.match(line, /^WARN: /);
  assert.match(line, /alice/);
  assert.match(line, /acme\/widget/);
  assert.match(line, /sub_a/);
  assert.match(line, /canceled/);
  // Reversible by hand in seconds: the undo command is in the line.
  assert.match(line, /Undo: gh api -X PUT repos\/acme\/widget\/collaborators\/alice/);
});

test('a dry run says plainly that nothing changed', () => {
  const line = revokeLine({ user: 'alice', repo: 'acme/widget', sub: 'sub_a', lapsed_since: '2026-07-01T00:00:00.000Z' }, { dryRun: true });
  assert.match(line, /^WARN: WOULD REVOKE \(reporting only, nothing was changed\)/);
});

test('a tripped breaker names everyone it held back', () => {
  const due = [{ user: 'alice', repo: 'a/r' }, { user: 'bob', repo: 'a/r' }];
  const line = breakerLine({ reason: 'over the safety limit of 3' }, due);
  assert.match(line, /^WARN: REVOCATION REFUSED, nothing was changed/);
  assert.match(line, /alice@a\/r/);
  assert.match(line, /bob@a\/r/);
});

// --- config -----------------------------------------------------------------

test('no subscriptions config is silent, because off is the default', () => {
  assert.deepEqual(subscriptionConfigProblems(undefined), []);
  assert.deepEqual(subscriptionConfigProblems(null), []);
});

test('a valid subscriptions config is silent', () => {
  assert.deepEqual(subscriptionConfigProblems({ enforce: true, grace_days: 7 }), []);
});

test('a nonsense subscriptions config is reported, not obeyed and not fatal', () => {
  assert.match(subscriptionConfigProblems([])[0], /must be an object/);
  assert.match(subscriptionConfigProblems({ enforce: 'yes' })[0], /must be true or false/);
  assert.match(subscriptionConfigProblems({ grace_days: '7' })[0], /must be a number/);
  assert.match(subscriptionConfigProblems({ grace_days: 500 })[0], /0 to 90/);
  assert.match(subscriptionConfigProblems({ revoke_limit_percent: 0 })[0], /percentage/);
});

test('a dangerously short grace period is allowed but named', () => {
  const problems = subscriptionConfigProblems({ grace_days: 0 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lose access almost immediately/);
});
