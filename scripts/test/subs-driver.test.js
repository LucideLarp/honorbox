'use strict';
// Driver-level tests for scripts/reconcile-subs.js with a stubbed fetch: no
// network, no live keys. These cover the properties that only show up once the
// I/O is wired: that the feature is genuinely off by default, that a tripped
// breaker performs no HTTP DELETE at all, and that reporting-only means what
// it says.
//
// Run: node --test scripts/test/subs-driver.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../reconcile-subs.js');

// The lock lives beside the state file as a dotfile so ops runners that commit
// state/ wholesale cannot sweep it into git. Tests derive it the same way.
const lockPathFor = (statePath) =>
  path.join(path.dirname(statePath), `.${path.basename(statePath)}.lock`);

// A test must never write into the repository's own state/. The reconciler
// defaults --state and --bots-state to paths under the working directory, so a
// harness that forgets to redirect them silently commits test data, or worse,
// edits live ops state. This asserts the repo's state/ is untouched by the run.
const REPO_STATE = path.join(__dirname, '..', '..', 'state');
function repoStateFingerprint() {
  if (!fs.existsSync(REPO_STATE)) return 'absent';
  return fs.readdirSync(REPO_STATE).sort().map((f) => {
    const p = path.join(REPO_STATE, f);
    return `${f}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').length : 'dir'}`;
  }).join('|');
}
const STATE_BEFORE = repoStateFingerprint();

test.after(() => {
  assert.equal(repoStateFingerprint(), STATE_BEFORE, 'a test wrote into the repository state/ directory');
});

function stubFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', init });
    for (const r of routes) if (String(url).includes(r.match)) return r.res(String(url), init);
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const jsonRes = (obj, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function subscription(id, status, user, over = {}) {
  return { id, status, items: { data: [{ price: { id: 'price_sub' }, quantity: 1 }] }, ...over };
}

function session(id, subId, user) {
  return {
    id, created: 1_700_000_000, subscription: subId,
    custom_fields: [{ key: 'github_username', text: { value: user } }],
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subs-'));
}

async function runMain(dir, routes, config, stateSeed, extraArgs = []) {
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify(config));
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  if (stateSeed) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(stateSeed));
  }
  const savedArgv = process.argv;
  const savedEnv = { key: process.env.STRIPE_SECRET_KEY, tok: process.env.GH_FULFILL_TOKEN };
  const logs = [];
  const savedLog = console.log;
  const savedErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.GH_FULFILL_TOKEN = 'ghp_x';
  // --bots-state MUST be pointed into the temp dir. Without it the reconciler
  // falls back to its default, state/bots-state.json relative to the working
  // directory, and a test run writes a fake revocation into the repository's
  // real state file. That happened once: it polluted live ops state with a
  // revocation for a repo that does not exist.
  const botsStatePath = path.join(dir, 'state', 'bots-state.json');
  // --force is on by default so tests are not gated by the 60m interval. A test
  // that wants to exercise the interval itself passes --no-force to drop it.
  const forced = extraArgs.includes('--no-force') ? [] : ['--force'];
  process.argv = ['node', 'reconcile-subs.js', '--config', cfg, '--state', statePath,
    '--bots-state', botsStatePath, ...forced, ...extraArgs.filter((a) => a !== '--no-force')];
  const f = stubFetch(routes);
  try {
    await driver.main(async () => {});
  } finally {
    f.restore();
    process.argv = savedArgv;
    process.env.STRIPE_SECRET_KEY = savedEnv.key;
    process.env.GH_FULFILL_TOKEN = savedEnv.tok;
    console.log = savedLog;
    console.error = savedErr;
  }
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  return { calls: f.calls, logs: logs.join('\n'), state, statePath };
}

const FULFILLMENT = [{ price: 'price_sub', product: 'Widget', repo: 'acme/widget' }];

// --- binding property 1: off by default -------------------------------------

test('a store with no subscriptions config makes no calls and writes no state', async () => {
  const dir = tmpdir();
  // Every route throws. If the reconciler touches the network at all, this
  // test fails loudly rather than passing on a stub that happened to answer.
  const { calls, logs, state } = await runMain(dir, [], { fulfillment: FULFILLMENT });
  assert.equal(calls.length, 0, 'no HTTP call may be made when the feature is off');
  assert.equal(state, null, 'no state file may be created when the feature is off');
  assert.match(logs, /not configured/);
});

// --- reporting only ---------------------------------------------------------

test('enforce false lists revocations and performs none', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: false, grace_days: 7 } },
    {
      version: 1, cursor: 1, last_pass: null, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  const deletes = calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 0, 'reporting only must issue no DELETE');
  assert.match(logs, /WOULD REVOKE \(reporting only, nothing was changed\)/);
  assert.match(logs, /REPORTING ONLY/);
  assert.ok(state.grants['acme/widget|alice'], 'the grant record survives a dry run');
});

// --- the breaker, at the driver level ---------------------------------------

test('a tripped breaker issues no DELETE at all and records what it held back', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Ten subscribers on record, all cancelled at once. That is 100%, far over
  // the limit, and is what a config typo or a wrong key looks like.
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
    users[`sub_${i}`] = `u${i}`;
    subs.push(subscription(`sub_${i}`, 'canceled'));
  }
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'a tripped breaker must remove nobody');
  assert.match(logs, /REVOCATION REFUSED, nothing was changed/);
  assert.equal(state.breaker.would_revoke.length, 10, 'and it records exactly what it wanted to do');
  assert.ok(state.breaker.tripped_at);
  assert.equal(Object.keys(state.grants).length, 10, 'every grant record survives');
});

test('an armed reconciler within the limit does revoke, loudly', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Ten on record, one cancelled and nine still active: routine churn.
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: i === 0 ? long_ago : null };
    users[`sub_${i}`] = `u${i}`;
    subs.push(subscription(`sub_${i}`, i === 0 ? 'canceled' : 'active'));
  }
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
  );
  const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/collaborators/'));
  assert.equal(deletes.length, 1, 'exactly the one lapsed customer');
  assert.match(deletes[0].url, /acme\/widget\/collaborators\/u0/);
  assert.match(logs, /WARN: REVOKED u0 from acme\/widget/);
  assert.match(logs, /Undo: gh api -X PUT/);
  assert.equal(state.grants['acme/widget|u0'], undefined, 'the record is cleared');
  assert.ok(state.grants['acme/widget|u1'], 'and the active customers are untouched');
});

// --- what a seller sees before arming enforcement ----------------------------

test('customers already in grace are reported every pass, not only on the day they started', async () => {
  const dir = tmpdir();
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  // Three people at different points in a seven day grace, all started on
  // earlier passes. Before this, a pass printed nothing at all about them: the
  // start was logged days ago and the removal is days away, so a seller reading
  // a quiet log would conclude nothing was pending and arm enforcement blind.
  const grants = {
    'acme/widget|carol': { sub: 'sub_c', repo: 'acme/widget', user: 'carol', lapsed_since: daysAgo(1) },
    'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: daysAgo(5) },
    'acme/widget|bob': { sub: 'sub_b', repo: 'acme/widget', user: 'bob', lapsed_since: daysAgo(3) },
  };
  const subs = ['sub_a', 'sub_b', 'sub_c'].map((id) => subscription(id, 'canceled'));
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: false, grace_days: 7 } },
    { version: 1, cursor: 1, users: { sub_a: 'alice', sub_b: 'bob', sub_c: 'carol' }, grants, breaker: {} }
  );
  assert.match(logs, /3 customer\(s\) in grace/);
  assert.match(logs, /would be removed if enforcement were on/);
  // Soonest first: alice has served five of seven days, carol only one.
  assert.match(logs, /Soonest: alice@acme\/widget in 2d, bob@acme\/widget in 4d, carol@acme\/widget in 6d/);
});

test('the grace line is right on the pass where the clock starts', async () => {
  const dir = tmpdir();
  // The commonest case of all: somebody cancelled and this is the first pass to
  // notice. The plan entries are snapshots taken before the clock is written,
  // so reading the date off the snapshot reported every brand new lapse as
  // "never (its lapse date is unreadable)" while the state file was correct.
  const { logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: false, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: null } },
      breaker: {},
    }
  );
  assert.match(logs, /Soonest: alice@acme\/widget in 7d/);
  assert.doesNotMatch(logs, /unreadable/);
  assert.ok(state.grants['acme/widget|alice'].lapsed_since, 'and the clock really did start');
});

test('customers mid-dunning are counted as the subscribers they are', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Eight past_due and two genuine cancellations. past_due customers are
  // deliberately absent from `desired`, so counting only what is entitled told
  // the seller this pass "leaves NOBODY entitled on this store", on a store
  // with eight subscribers whose cards Stripe is still retrying.
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    const dunning = i < 8;
    grants[`acme/widget|u${i}`] = {
      sub: `sub_${i}`, customer: `cus_${i}`, repo: 'acme/widget', user: `u${i}`,
      lapsed_since: dunning ? null : long_ago,
    };
    users[`sub_${i}`] = `u${i}`;
    subs.push({
      id: `sub_${i}`, status: dunning ? 'past_due' : 'canceled', customer: `cus_${i}`,
      items: { data: [{ price: { id: 'price_sub' } }] },
    });
  }
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: {} }
  );
  assert.doesNotMatch(logs, /leaves NOBODY entitled/,
    'eight subscribers mid-dunning are not nobody');
});

test('a re-subscribed customer has their record re-pointed at the live subscription', async () => {
  const dir = tmpdir();
  // Nothing covered diff.refresh. Without it a record keeps a dead subscription
  // id for good and every later log line names one the seller cannot look up.
  const { logs, state } = await runMain(
    dir,
    [
      {
        match: '/v1/subscriptions',
        res: () => jsonRes({
          data: [
            { id: 'sub_old', status: 'canceled', customer: 'cus_alice', items: { data: [{ price: { id: 'price_sub' } }] } },
            { id: 'sub_new', status: 'active', customer: 'cus_alice', items: { data: [{ price: { id: 'price_sub' } }] } },
          ],
          has_more: false,
        }),
      },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_old: 'alice', sub_new: 'alice' },
      // No customer id on the record: written before they were stored.
      grants: { 'acme/widget|alice': { sub: 'sub_old', repo: 'acme/widget', user: 'alice', lapsed_since: null } },
      breaker: {},
    }
  );
  assert.match(logs, /re-pointed alice on acme\/widget: now entitled by sub_new \(was sub_old\)/);
  assert.equal(state.grants['acme/widget|alice'].sub, 'sub_new');
  assert.equal(state.grants['acme/widget|alice'].customer, 'cus_alice',
    'and the customer id is backfilled, which is what protects them next time');
});

test('a pass that failed still holds the scheduler off', async () => {
  const dir = tmpdir();
  // Every other test passes --force, so the interval gate was never exercised
  // and would have passed even if it ignored last_attempt entirely.
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1, cursor: 1, users: {}, grants: {}, breaker: {},
    last_pass: null,
    last_attempt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // failed 5m ago
  }));
  const { calls, logs } = await runMain(
    dir,
    [], // any network call fails the test
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    null,
    ['--no-force'] // placeholder arg; the point is that --force is absent
  );
  assert.equal(calls.length, 0, 'a pass that failed minutes ago must not immediately enumerate Stripe again');
  assert.match(logs, /skipping \(min interval/);
});

// --- the page boundary -------------------------------------------------------

test('an unreadable page of sessions is refused, not read as no new customers', async () => {
  const dir = tmpdir();
  // The subscription list is fine; the session list comes back unreadable.
  // Reading that as "nobody new" means a customer who just subscribed is never
  // matched to their GitHub username and never gets access, and the pass
  // reports a clean run over the top of it.
  await assert.rejects(
    runMain(
      dir,
      [
        { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'active')], has_more: false }) },
        { match: '/v1/checkout/sessions', res: () => jsonRes({ data: null, has_more: false }) },
      ],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
    ),
    /unreadable response/
  );
});

test('a page cursor Stripe did not supply stops the pass instead of looping forever', async () => {
  const dir = tmpdir();
  // has_more says there is another page, but the last row carries no id to page
  // from. Asking again with the same parameters returns the same page, so the
  // reconciler would fetch it for ever, holding its lock and never exiting.
  await assert.rejects(
    runMain(
      dir,
      [
        {
          match: '/v1/subscriptions',
          res: () => jsonRes({ data: [{ status: 'active', items: { data: [] } }], has_more: true }),
        },
        { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      ],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
    ),
    /cannot be paged|no id/
  );
});

// --- two runners, and a pass that dies halfway -------------------------------

test('a second runner does not start while the first is mid-pass', async () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // A lock left by a pass that is still running. The second runner must not
  // reconcile: two passes acting on the same state both write the shared
  // revocation record, and the loser's entry is overwritten, which leaves a
  // person removed with nothing on record saying so.
  fs.writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: 4242, at: new Date().toISOString() }) + '\n');
  const { calls, logs } = await runMain(
    dir,
    [], // every route throws: touching the network at all fails this test
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  assert.equal(calls.length, 0, 'a locked-out runner must make no calls at all');
  assert.match(logs, /another reconciler pass is already running/);
});

test('a lock left by a killed pass is broken rather than wedging enforcement shut', async () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const lockPath = lockPathFor(statePath);
  // Deliberately corrupt AND old. Age is read from mtime, so a lock whose
  // contents cannot be parsed still expires: a store must never stop enforcing
  // forever because a file got truncated.
  fs.writeFileSync(lockPath, '{ this is not json');
  const old = Date.now() - 45 * 60 * 1000;
  fs.utimesSync(lockPath, old / 1000, old / 1000);
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  assert.match(logs, /breaking a subscription reconciler lock/);
  assert.match(logs, /subscriptions done/, 'and the pass then runs normally');
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released when the pass finishes');
});

test('a pass that throws still releases its lock and still backs off', async () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'state', 'subscriptions.json');
  await assert.rejects(runMain(
    dir,
    [{ match: '/v1/subscriptions', res: () => jsonRes({ error: 'boom' }, 500) }],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  ));
  assert.equal(fs.existsSync(lockPathFor(statePath)), false,
    'a crashed pass must not leave a lock that blocks the next one');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(state.last_attempt,
    'the attempt is recorded, or a permanently failing pass enumerates Stripe on every scheduler tick');
});

// --- the breaker under adversarial conditions --------------------------------
// These run at the driver level on purpose. The unit tests hand breakerVerdict
// a denominator directly; here the denominator is whatever the real pass
// computed, which is the number that actually gates a revocation. The two are
// not the same: people who are due are by definition no longer entitled, so a
// store losing everybody has a denominator of ZERO, not of its former size.

// Whole-store cancellation at each size that straddles the floor. This is the
// documented cost of having a floor at all, and it is asserted rather than
// assumed so that nobody changes the floor without seeing what it permits.
for (const [size, allowed] of [[1, true], [2, true], [3, true], [4, false]]) {
  test(`a store of ${size} losing every subscriber is ${allowed ? 'allowed under the floor' : 'refused'}`, async () => {
    const dir = tmpdir();
    const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
    const grants = {};
    const users = {};
    const subs = [];
    for (let i = 0; i < size; i++) {
      grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
      users[`sub_${i}`] = `u${i}`;
      subs.push(subscription(`sub_${i}`, 'canceled'));
    }
    const { calls, logs } = await runMain(
      dir,
      [
        { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
        { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
        { match: '/invitations', res: () => jsonRes([]) },
        { match: '/collaborators/', res: () => jsonRes({}, 204) },
      ],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
      { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
    );
    const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.includes('/collaborators/'));
    assert.equal(deletes.length, allowed ? size : 0);
    if (allowed) {
      // Permitted, and never quietly: emptying the store is the most
      // consequential thing this program can do at any size.
      assert.match(logs, /leaves NOBODY entitled on this store/);
    } else {
      assert.match(logs, /REVOCATION REFUSED/);
    }
  });
}

test('an entitled set emptied by a Stripe error can never reach the breaker', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const grants = {};
  const users = {};
  for (let i = 0; i < 40; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
    users[`sub_${i}`] = `u${i}`;
  }
  // The failure is on the SECOND page. The first page succeeded, so a pager
  // that returned what it had would hand the breaker a plausible-looking
  // partial set rather than an obviously empty one, and forty people would be
  // measured against a denominator built from half the truth.
  let page = 0;
  await assert.rejects(
    runMain(
      dir,
      [
        {
          match: '/v1/subscriptions',
          res: () => (page++ === 0
            ? jsonRes({ data: [subscription('sub_0', 'active')], has_more: true })
            : jsonRes({ error: { message: 'gateway' } }, 500)),
        },
        { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      ],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
      { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
    ),
    /Stripe \/v1\/subscriptions/,
    'a half-read customer list must abort the pass, not be reconciled against'
  );
});

test('zero subscriptions from Stripe is refused and cannot be overridden', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const savedArgv = process.argv;
  const { calls, logs } = await runMain(
    dir,
    [
      // A well-formed empty list: the signature of a wrong key or wrong
      // account, not of every customer leaving in the same hour.
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    },
    ['--allow-mass-revocation']
  );
  process.argv = savedArgv;
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.match(logs, /ZERO subscriptions/);
  // The override must not even be advertised here: this guard is never wrong.
  assert.doesNotMatch(logs, /--allow-mass-revocation/);
});

test('a key for the wrong Stripe account cannot empty a store', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // The nastiest shape of this failure. The key is valid and the account is
  // busy, so Stripe returns plenty of subscriptions and the zero guard never
  // fires. None of them are ours: they carry prices this store does not sell,
  // so nothing protects our grants and every customer looks cancelled.
  //
  // With three subscribers the percentage breaker gives no protection either,
  // because the floor of 3 exists so that small stores can enforce at all. That
  // combination is the one case where a single wrong environment variable could
  // remove every paying customer, and it needs a guard of its own.
  const otherAccountSubs = Array.from({ length: 8 }, (_, i) => ({
    id: `sub_stranger_${i}`,
    status: 'active',
    items: { data: [{ price: { id: 'price_someone_elses_product' }, quantity: 1 }] },
  }));
  const grants = {};
  const users = {};
  for (let i = 0; i < 3; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
    users[`sub_${i}`] = `u${i}`;
  }
  const { calls, logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: otherAccountSubs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    { version: 1, cursor: 1, users, grants, breaker: { tripped_at: null, would_revoke: [] } }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
    'not one customer may be removed on a subscription list that contains nothing this store sells');
  assert.match(logs, /price this store sells/);
});

test('the wrong-account guard cannot be waved through with the override', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const otherAccountSubs = Array.from({ length: 8 }, (_, i) => ({
    id: `sub_stranger_${i}`, status: 'active',
    items: { data: [{ price: { id: 'price_someone_elses_product' }, quantity: 1 }] },
  }));
  const { calls } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: otherAccountSubs, has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_0: 'u0' },
      grants: { 'acme/widget|u0': { sub: 'sub_0', repo: 'acme/widget', user: 'u0', lapsed_since: long_ago } },
      breaker: {},
    },
    ['--allow-mass-revocation']
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
    'deciding one exodus is real is not deciding to trust a response you never saw');
});

test('a real mass cancellation can be enforced, once, on purpose', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  const grants = {};
  const users = {};
  const subs = [];
  for (let i = 0; i < 10; i++) {
    grants[`acme/widget|u${i}`] = { sub: `sub_${i}`, repo: 'acme/widget', user: `u${i}`, lapsed_since: long_ago };
    users[`sub_${i}`] = `u${i}`;
    subs.push(subscription(`sub_${i}`, 'canceled'));
  }
  const routes = [
    { match: '/v1/subscriptions', res: () => jsonRes({ data: subs, has_more: false }) },
    { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    { match: '/invitations', res: () => jsonRes([]) },
    { match: '/collaborators/', res: () => jsonRes({}, 204) },
  ];
  const config = { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } };
  const seed = () => ({ version: 1, cursor: 1, users, grants: JSON.parse(JSON.stringify(grants)), breaker: {} });

  // Refused by default, and the refusal tells the seller how to proceed.
  const refused = await runMain(dir, routes, config, seed());
  assert.equal(refused.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.match(refused.logs, /re-run once with --allow-mass-revocation/);

  // Asked for explicitly, it goes through, and still says what it did.
  const forced = await runMain(tmpdir(), routes, config, seed(), ['--allow-mass-revocation']);
  const deletes = forced.calls.filter((c) => c.method === 'DELETE' && c.url.includes('/collaborators/'));
  assert.equal(deletes.length, 10, 'the seller asked for this one');
  assert.match(forced.logs, /leaves NOBODY entitled on this store/);
  assert.match(forced.logs, /allowed for this run only/);
});

// --- the enumeration contract -----------------------------------------------

test('subscriptions are listed with status=all, or cancellations are invisible', async () => {
  const dir = tmpdir();
  const { calls } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  const listCall = calls.find((c) => c.url.includes('/v1/subscriptions'));
  assert.match(listCall.url, /status=all/);
  assert.match(listCall.init.headers['Stripe-Version'], /2024-06-20/);
});

test('a Stripe failure aborts the pass rather than revoking on partial data', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  await assert.rejects(
    runMain(
      dir,
      [{ match: '/v1/subscriptions', res: () => jsonRes({ error: 'boom' }, 500) }],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      {
        version: 1, cursor: 1, users: { sub_a: 'alice' },
        grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
        breaker: {},
      }
    ),
    /Stripe \/v1\/subscriptions/
  );
});

test('a Stripe error body has key material redacted before it can reach a log', async () => {
  // Stripe answers a bad key with `Invalid API Key provided: sk_live_...` in
  // the body, and stripeGet's error message carries that body into the log.
  // fulfill.js redacts it; this pins that the reconciler's copy does too,
  // because the two drifting apart is exactly how one lane leaks what the
  // other scrubs.
  const key = 'sk_live_' + 'A1b2C3d4'.repeat(3);
  const f = stubFetch([{
    match: '/v1/subscriptions',
    res: () => ({ ok: false, status: 401, text: async () => `{"error":{"message":"Invalid API Key provided: ${key}"}}` }),
  }]);
  try {
    await assert.rejects(
      driver.stripeGet('/v1/subscriptions', {}, key),
      (err) => {
        assert.ok(!err.message.includes(key), 'the key survived into the error message');
        assert.match(err.message, /sk_live_<redacted>/);
        return true;
      }
    );
  } finally {
    f.restore();
  }
});

test('an unreadable subscriptions response is refused, not read as an empty store', async () => {
  const dir = tmpdir();
  await assert.rejects(
    runMain(
      dir,
      [{ match: '/v1/subscriptions', res: () => jsonRes({ data: null }) }],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
      { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
    ),
    /refusing to reconcile on an unreadable response/
  );
});

// --- granting ---------------------------------------------------------------

test('an active subscription with a known username is invited', async () => {
  const dir = tmpdir();
  const { calls, logs, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'active')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [session('cs_1', 'sub_a', 'alice')], has_more: false }) },
      { match: '/collaborators/', res: () => jsonRes({}, 201) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true } },
    { version: 1, cursor: 1, users: {}, grants: {}, breaker: {} }
  );
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /acme\/widget\/collaborators\/alice/);
  assert.ok(state.grants['acme/widget|alice']);
  assert.match(logs, /granted alice -> acme\/widget/);
});

// --- absence as evidence, the third instance -------------------------------
// Both bugs this code has already had came from reading "missing from a set" as
// "does not exist". These are the same shape in two new places.

test('a pending invitation past the first page is still cancelled on revocation', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // GitHub returns 30 invitations per page by default and paginates the rest.
  // A store holding more than one page of unaccepted invitations puts the
  // lapsed customer's invitation somewhere past page one, where a single-page
  // read cannot see it. Absent from page one is not absent.
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, invitee: { login: `other${i}` } }));
  const { calls, logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      {
        match: '/invitations',
        res: (url) => {
          if (url.includes('/invitations/')) return jsonRes({}, 204); // the delete
          return jsonRes(url.includes('page=2') ? [{ id: 77, invitee: { login: 'alice' } }] : filler);
        },
      },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.match(logs, /REVOKED alice from acme\/widget/);
  const invDeletes = calls.filter((c) => c.method === 'DELETE' && /\/invitations\/77$/.test(c.url));
  assert.equal(invDeletes.length, 1,
    'the revoked customer keeps a live invitation they can still accept if only page one is read');
});

test('a customer whose new subscription is past_due is not revoked over their old one', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // Alice re-subscribed, so Stripe cancelled sub_old and opened sub_new. Our
  // grant record still names sub_old, because that is the subscription it was
  // written from and nothing ever refreshes it. sub_new is past_due: Stripe is
  // still retrying her card and she has not left. Protection is looked up by
  // the recorded subscription id, so the hold on sub_new never reaches her
  // grant, and the most important rule in this engine (past_due is never a
  // lapse) is defeated by a stale id.
  const { calls, logs, state } = await runMain(
    dir,
    [
      {
        match: '/v1/subscriptions',
        res: () => jsonRes({
          data: [subscription('sub_old', 'canceled'), subscription('sub_new', 'past_due')],
          has_more: false,
        }),
      },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_old: 'alice', sub_new: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_old', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
    'a customer with a live past_due subscription must never be revoked');
  assert.doesNotMatch(logs, /REVOKED alice/);
  assert.ok(state.grants['acme/widget|alice'], 'and her grant record survives');
});

test('an invitation list that cannot be read is reported, not read as empty', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // The collaborator was removed but the invitation list 500s. Treating that
  // failure as "no invitations pending" leaves a live invitation the customer
  // can still accept, and reports a clean revocation over the top of it.
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes({ message: 'server error' }, 500) },
      { match: '/collaborators/', res: () => jsonRes({}, 204) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.match(logs, /could not read its invitation list/);
});

// Holding by (repo, user) pair closes the case where the new subscription
// resolves. It cannot close the cases where it does not, and a subscription can
// fail to resolve while being perfectly alive and paid for. In both of these
// the customer is ACTIVE, not past_due: they are paying right now.
for (const [label, newSub, users] of [
  [
    'whose username we have not learned yet',
    { id: 'sub_new', status: 'active', customer: 'cus_alice', items: { data: [{ price: { id: 'price_sub' } }] } },
    { sub_old: 'alice' }, // sub_new is missing: created outside Checkout, or the custom field was blank
  ],
  [
    'whose price the config no longer names',
    { id: 'sub_new', status: 'active', customer: 'cus_alice', items: { data: [{ price: { id: 'price_rotated' } }] } },
    { sub_old: 'alice', sub_new: 'alice' },
  ],
]) {
  test(`an active customer ${label} is not revoked over an old subscription`, async () => {
    const dir = tmpdir();
    const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
    const { calls, logs } = await runMain(
      dir,
      [
        {
          match: '/v1/subscriptions',
          res: () => jsonRes({
            data: [
              { id: 'sub_old', status: 'canceled', customer: 'cus_alice', items: { data: [{ price: { id: 'price_sub' } }] } },
              newSub,
            ],
            has_more: false,
          }),
        },
        { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
        { match: '/invitations', res: () => jsonRes([]) },
        { match: '/collaborators/', res: () => jsonRes({}, 204) },
      ],
      { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
      {
        version: 1, cursor: 1, users,
        grants: {
          'acme/widget|alice': {
            sub: 'sub_old', customer: 'cus_alice', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago,
          },
        },
        breaker: {},
      }
    );
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
      'this customer is ACTIVE and paying, and a name we failed to resolve is not evidence they left');
    assert.doesNotMatch(logs, /REVOKED alice/);
  });
}

test('a grant record with no customer id still falls back to the older protections', async () => {
  const dir = tmpdir();
  // Records written before customer ids were stored carry none. Absence must
  // not be read as "no live customer", and it must not crash the pass either.
  const { calls } = await runMain(
    dir,
    [
      {
        match: '/v1/subscriptions',
        res: () => jsonRes({
          data: [{ id: 'sub_a', status: 'past_due', customer: 'cus_alice', items: { data: [{ price: { id: 'price_sub' } }] } }],
          has_more: false,
        }),
      },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: null } },
      breaker: {},
    }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('a revocation GitHub could not confirm is not reported as done', async () => {
  const dir = tmpdir();
  const long_ago = new Date(Date.now() - 99 * 86_400_000).toISOString();
  // She renamed her GitHub account, so the old login 404s. The person is still
  // a collaborator under the new name. Reporting a clean REVOKED here tells the
  // seller enforcement worked when nothing was taken away.
  const { logs } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'canceled')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
      { match: '/invitations', res: () => jsonRes([]) },
      { match: '/collaborators/', res: () => jsonRes({ message: 'Not Found' }, 404) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: long_ago } },
      breaker: { tripped_at: null, would_revoke: [] },
    }
  );
  assert.match(logs, /could not be confirmed|was not a collaborator/,
    'a 404 must be reported as unconfirmed, not as a completed revocation');
});

test('a past_due customer is neither granted nor revoked', async () => {
  const dir = tmpdir();
  const { calls, state } = await runMain(
    dir,
    [
      { match: '/v1/subscriptions', res: () => jsonRes({ data: [subscription('sub_a', 'past_due')], has_more: false }) },
      { match: '/v1/checkout/sessions', res: () => jsonRes({ data: [], has_more: false }) },
    ],
    { fulfillment: FULFILLMENT, subscriptions: { enforce: true, grace_days: 7 } },
    {
      version: 1, cursor: 1, users: { sub_a: 'alice' },
      grants: { 'acme/widget|alice': { sub: 'sub_a', repo: 'acme/widget', user: 'alice', lapsed_since: null } },
      breaker: {},
    }
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(state.grants['acme/widget|alice'].lapsed_since, null, 'no grace clock may start for past_due');
});

// --- the lock primitives, directly ------------------------------------------
// These two failure modes cannot be reached through main(): one needs a pass
// that overran the staleness window, the other needs a clock that disagrees
// with the file system. Both are real and both silently defeat the guard, so
// they are exercised against the functions themselves.

test('a runner never releases a lock that now belongs to somebody else', async () => {
  const dir = tmpdir();
  const lock = path.join(dir, 'x.lock');
  // Runner A overran, runner B broke its lock and took its own. A now finishes
  // and must not delete B's: that would let a third runner start alongside B,
  // creating the exact overlap the lock exists to prevent.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString() }));
  const errs = [];
  const saved = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try { driver.releaseLock(lock); } finally { console.error = saved; }
  assert.equal(fs.existsSync(lock), true, "another runner's lock must survive our release");
  assert.match(errs.join('\n'), /now belongs to pid/);

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  driver.releaseLock(lock);
  assert.equal(fs.existsSync(lock), false, 'but our own lock is cleared normally');
});

test('a lock dated in the future does not wedge enforcement shut', async () => {
  const dir = tmpdir();
  const lock = path.join(dir, 'y.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999, at: new Date().toISOString() }));
  // Clock skew between two runners, or a corrected clock. A negative age is
  // always below the limit, so read literally the lock never goes stale.
  const future = (Date.now() + 6 * 3600 * 1000) / 1000;
  fs.utimesSync(lock, future, future);
  const errs = [];
  const saved = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let got;
  try { got = driver.acquireLock(lock, Date.now()); } finally { console.error = saved; }
  assert.equal(got, true, 'a timestamp we cannot place relative to now is not evidence of a live pass');
  driver.releaseLock(lock);
});
