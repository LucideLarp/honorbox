'use strict';
// Driver-level tests for scripts/fulfill.js with a stubbed fetch: no
// network, no live keys. Covers the HTTP call shapes and the state files
// the fulfillment workflows depend on.
//
// Run: node --test scripts/test/fulfill-driver.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Requiring the driver must not run main(); build.js sets the precedent
// (module.exports + require.main guard).
const driver = require('../fulfill.js');

function stubFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
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

function paidSession(id, created, over = {}) {
  return {
    id,
    status: 'complete',
    payment_status: 'paid',
    payment_link: 'plink_1',
    created,
    amount_total: 2900,
    currency: 'usd',
    customer_details: { address: { country: 'DE' } },
    custom_fields: [{ key: 'github_username', text: { value: 'octocat' } }],
    ...over,
  };
}

// Run main() against a temp working set: config + state + ledger paths in
// their own directory, argv and env staged and restored around the call.
async function runMain(dir, routes) {
  const cfg = path.join(dir, 'store.config.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({
      fulfillment: [{ payment_link: 'plink_1', product: 'P', repo: 'o/r' }],
    }));
  }
  const savedArgv = process.argv;
  const savedEnv = { key: process.env.STRIPE_SECRET_KEY, tok: process.env.GH_FULFILL_TOKEN };
  process.argv = [savedArgv[0], 'fulfill.js',
    '--config', cfg,
    '--state', path.join(dir, 'state', 'fulfill-state.json'),
    '--ledger', path.join(dir, 'ledger', 'ledger.json')];
  process.env.STRIPE_SECRET_KEY = 'rk_test_stub';
  process.env.GH_FULFILL_TOKEN = 'ghp_test_stub';
  const { calls, restore } = stubFetch(routes);
  // Retries are real in main() but must not cost real seconds here: record the
  // waits instead of serving them. `slept` is then assertable: a test can
  // prove the engine waited the number of seconds GitHub asked for.
  const slept = [];
  const fakeSleep = async (ms) => { slept.push(ms); };
  try {
    await driver.main(fakeSleep);
  } finally {
    restore();
    process.argv = savedArgv;
    if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedEnv.key;
    if (savedEnv.tok === undefined) delete process.env.GH_FULFILL_TOKEN;
    else process.env.GH_FULFILL_TOKEN = savedEnv.tok;
  }
  return { calls, slept, readState: (f) => JSON.parse(fs.readFileSync(path.join(dir, 'state', f), 'utf8')) };
}

// console.log capture: the fulfillment log IS the operator interface, so
// what it claims about a delivery is worth asserting.
function captureLog() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.log = orig; } };
}

// Same, for the loud channel. The watchdog greps this stream for FAILED and
// WARN:, so "did it warn" is a testable property, not a matter of taste.
function captureErr() {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.error = orig; } };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fulfill-'));

test('stripe requests pin Stripe-Version 2024-06-20', async () => {
  // The account default is a broken preview API version; init.js pins every
  // call and fulfill.js must hold the same line.
  const { calls, restore } = stubFetch([
    { match: 'api.stripe.com', res: () => jsonRes({ data: [], has_more: false }) },
  ]);
  try {
    await driver.listSessionsSince(0, 'rk_test_stub');
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Stripe-Version'], '2024-06-20', JSON.stringify(calls[0].init.headers));
});

test('happy path end to end: session fulfilled, ledger row, state advanced', async () => {
  const dir = tmp();
  const s = paidSession('cs_e2e_1', 1_700_000_000);
  const { calls, readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({}, 201) },
  ]);
  const invite = calls.find((c) => c.url.includes('api.github.com'));
  assert.ok(invite, 'GitHub invite must be called');
  assert.equal(invite.url, 'https://api.github.com/repos/o/r/collaborators/octocat');
  assert.equal(invite.init.method, 'PUT');
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_e2e_1']);
  assert.equal(state.failures.length, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.total_sales, 1);
  assert.deepEqual(readState('new-sales.json'), ['octocat']);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'activity flag set on a run with sales');
});

test('transient invite failure retries on the next poll; success then fulfills', async () => {
  // A GitHub 502 is not the buyer's fault: the session must NOT be marked
  // processed (so the next poll retries) and must NOT burn a
  // needs_attention ledger row.
  const dir = tmp();
  const s = paidSession('cs_retry_1', 1_700_000_000);
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const first = await runMain(dir, [stripe, { match: 'api.github.com', res: () => jsonRes({ message: 'bad gateway' }, 502) }]);
  let state = first.readState('fulfill-state.json');
  assert.deepEqual(state.processed, [], 'transient failure must stay unprocessed');
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].transient, true);
  let ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 0, 'no ledger row for a retryable failure');
  // GitHub recovers: the next poll picks the same session up and fulfills
  const second = await runMain(dir, [stripe, { match: 'api.github.com', res: () => jsonRes({}, 201) }]);
  state = second.readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_retry_1']);
  ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 1);
  assert.ok(!ledger.rows[0].needs_attention);
});

test('permanent invite failure (404 user) goes straight to needs_attention with a hint', async () => {
  const dir = tmp();
  const s = paidSession('cs_perm_1', 1_700_000_000);
  const { readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({ message: 'Not Found' }, 404) },
  ]);
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_perm_1'], 'permanent failure is processed, humans take over');
  assert.match(state.failures[0].error, /no such GitHub user/);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows[0].needs_attention, true);
});

test('transient retries are time-boxed: past the 6h window they convert to needs_attention', async () => {
  const dir = tmp();
  const s = paidSession('cs_cap_1', 1_700_000_000);
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const flaky = { match: 'api.github.com', res: () => jsonRes({ message: 'bad gateway' }, 502) };
  // failures 1..3 inside the window: still retrying, attempts logged
  for (let i = 0; i < 3; i++) await runMain(dir, [stripe, flaky]);
  const statePath = path.join(dir, 'state', 'fulfill-state.json');
  let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.processed, [], 'still inside the retry window');
  assert.equal(state.failures.length, 3, 'every attempt is logged');
  // age the FIRST transient failure past the window and fail once more
  state.failures[0].ts = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  await runMain(dir, [stripe, flaky]);
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.processed, ['cs_cap_1'], 'window exhausted: stop retrying, surface it');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.filter((r) => r.needs_attention).length, 1);
});

test('readJson: missing file falls back, corrupt file fails loud', () => {
  // A missing state file is a fresh install; a CORRUPT one (truncated
  // commit, bad merge) silently resetting cursor=0 and processed=[] is a
  // silent-failure hazard on money-adjacent state. Parse errors must throw
  // and name the file.
  const dir = tmp();
  const missing = path.join(dir, 'nope.json');
  assert.deepEqual(driver.readJson(missing, { cursor: 0 }), { cursor: 0 });
  const corrupt = path.join(dir, 'state.json');
  fs.writeFileSync(corrupt, '{"cursor": 12, "processed": [truncated');
  assert.throws(() => driver.readJson(corrupt, { cursor: 0 }), new RegExp('state\\.json'));
});

test('HAD_ACTIVITY is cleared again on a quiet run', async () => {
  // The workflows commit state/ wholesale and gate the ledger-publish step
  // on this file. If a run with no new sales leaves last run's flag on
  // disk, the gate is permanently open after the first sale ever.
  const dir = tmp();
  const s = paidSession('cs_flag_1', 1_700_000_000);
  const stripe = (sessions) => ({ match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) });
  const github = { match: 'api.github.com', res: () => jsonRes({}, 201) };
  await runMain(dir, [stripe([s]), github]);
  assert.ok(fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'flag set by the active run');
  // second run: same session comes back inside the overlap window, already processed
  await runMain(dir, [stripe([s]), github]);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'HAD_ACTIVITY')), 'quiet run must clear the flag');
});

test('the log distinguishes a real invite from an account that already had access', async () => {
  // GitHub answers PUT /collaborators with 201 (invitation created) or 204
  // (already a collaborator). Both used to print "invited", so a seller
  // test-buying their own product saw a line that read like a real delivery,
  // and a buyer reporting "no invite arrived" could not be told apart from a
  // buyer who already had the repo.
  const dir1 = tmp();
  const cap1 = captureLog();
  try {
    await runMain(dir1, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: [paidSession('cs_201', 1_700_000_000)], has_more: false }) },
      { match: 'api.github.com', res: () => jsonRes({}, 201) },
    ]);
  } finally { cap1.restore(); }
  const line201 = cap1.lines.find((l) => l.includes('cs_201'));
  assert.ok(line201, cap1.lines.join('\n'));
  assert.match(line201, /invited octocat to o\/r \(HTTP 201\)/);

  const dir2 = tmp();
  const cap2 = captureLog();
  try {
    await runMain(dir2, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: [paidSession('cs_204', 1_700_000_000)], has_more: false }) },
      { match: 'api.github.com', res: () => jsonRes({}, 204) },
    ]);
  } finally { cap2.restore(); }
  const line204 = cap2.lines.find((l) => l.includes('cs_204'));
  assert.ok(line204, cap2.lines.join('\n'));
  assert.match(line204, /octocat already had access to o\/r \(HTTP 204\)/);
  assert.ok(!/invited/.test(line204), `204 must not claim an invite: ${line204}`);
});

test('a paid session that matches no grant is reported, not swallowed', async () => {
  // The worst shape of failure on the money path: the buyer paid, the grant
  // ids are wrong or missing, pickNewPaidSessions drops the session, and the
  // run prints new_paid=0 and exits 0. Nothing in the log said a sale had
  // been lost. It must warn once, on the loud channel the watchdog reads.
  const dir = tmp();
  const s = paidSession('cs_orphan_1', 1_700_000_000, { payment_link: 'plink_NOT_IN_CONFIG' });
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const github = { match: 'api.github.com', res: () => jsonRes({}, 201) };

  const err1 = captureErr();
  let first;
  try { first = await runMain(dir, [stripe, github]); } finally { err1.restore(); }

  const warn = err1.lines.find((l) => l.includes('cs_orphan_1'));
  assert.ok(warn, `expected a warning, got:\n${err1.lines.join('\n')}`);
  assert.match(warn, /^WARN:/, 'the watchdog greps for "WARN:"; the prefix is load-bearing');
  assert.match(warn, /matches no fulfillment grant/);
  assert.match(warn, /29\.00 USD/, 'the operator needs to know how much went undelivered');
  assert.ok(!first.calls.some((c) => c.url.includes('api.github.com')), 'nothing to deliver, so no invite');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 0, 'an undeliverable session is not a sale');

  // Second poll, same session: already reported. A session that can never
  // match would otherwise re-alert every 2 minutes forever.
  const err2 = captureErr();
  try { await runMain(dir, [stripe, github]); } finally { err2.restore(); }
  assert.ok(
    !err2.lines.some((l) => l.includes('cs_orphan_1')),
    `warned twice about the same session:\n${err2.lines.join('\n')}`
  );
});

test('a burst of checkouts in one poll window all get delivered', async () => {
  // HN traffic arrives in clumps: several sessions complete inside a single
  // 120s poll. Every one of them must be invited, ledgered, and processed:
  // the loop must not stop at the first, and the cursor must land on the
  // newest session seen, not the last one iterated.
  const dir = tmp();
  const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const sessions = names.map((n, i) =>
    paidSession(`cs_burst_${i}`, 1_700_000_000 + i, {
      custom_fields: [{ key: 'github_username', text: { value: n } }],
    })
  );
  const { calls, readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({}, 201) },
  ]);

  const invited = calls
    .filter((c) => c.url.includes('api.github.com'))
    .map((c) => c.url.split('/').pop());
  assert.deepEqual(invited, names, 'every buyer in the burst gets exactly one invite');
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, sessions.map((s) => s.id));
  assert.equal(state.failures.length, 0);
  assert.equal(state.cursor, 1_700_000_004, 'cursor lands on the newest session in the burst');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 5);
  assert.equal(ledger.total_sales, 5);
  assert.equal(new Set(ledger.rows.map((r) => r.ref)).size, 5, 'one distinct ledger ref per sale');
  assert.deepEqual(readState('new-sales.json'), names);
});

test('one undeliverable buyer in a burst does not block the buyers behind them', async () => {
  // A single typo'd username 404s. If that aborted the loop (or quietly ate
  // the rest), the buyers after it in the same poll would pay and get
  // nothing, and the log would show one failure instead of four deliveries.
  const dir = tmp();
  const names = ['alice', 'ghost-user', 'carol'];
  const sessions = names.map((n, i) =>
    paidSession(`cs_mixed_${i}`, 1_700_000_000 + i, {
      custom_fields: [{ key: 'github_username', text: { value: n } }],
    })
  );
  const err = captureErr();
  let run;
  try {
    run = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
      {
        match: 'api.github.com',
        res: (url) =>
          url.endsWith('/ghost-user')
            ? jsonRes({ message: 'Not Found' }, 404)
            : jsonRes({}, 201),
      },
    ]);
  } finally { err.restore(); }

  const state = run.readState('fulfill-state.json');
  assert.deepEqual(state.processed, sessions.map((s) => s.id), 'all three are accounted for');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 3);
  assert.equal(ledger.total_sales, 2, 'the failed one must not inflate the sales count');
  const flagged = ledger.rows.filter((r) => r.needs_attention);
  assert.equal(flagged.length, 1);
  const loud = err.lines.find((l) => l.includes('cs_mixed_1'));
  assert.ok(loud, `the failure must be loud:\n${err.lines.join('\n')}`);
  assert.match(loud, /FAILED/);
  assert.match(loud, /no such GitHub user/);
  assert.deepEqual(run.readState('new-sales.json'), ['alice', 'carol']);
});

test('buyers type their username dirty: @, case, and profile URLs still reach GitHub', async () => {
  // Whatever the buyer pastes into the Stripe field, the invite has to go to
  // the right account. GitHub matches usernames case-insensitively, so case
  // is passed through untouched rather than guessed at.
  const dir = tmp();
  const typed = ['@octocat', '  OctoCat  ', 'https://github.com/Octo-Cat', 'github.com/octocat/'];
  const sessions = typed.map((v, i) =>
    paidSession(`cs_dirty_${i}`, 1_700_000_000 + i, {
      custom_fields: [{ key: 'github_username', text: { value: v } }],
    })
  );
  const { calls, readState } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({}, 201) },
  ]);
  const invited = calls
    .filter((c) => c.url.includes('api.github.com'))
    .map((c) => c.url.split('/').pop());
  assert.deepEqual(invited, ['octocat', 'OctoCat', 'Octo-Cat', 'octocat']);
  assert.equal(readState('fulfill-state.json').failures.length, 0);
});

test('every GitHub invite outcome is distinguishable in the log, and none of them reads like success', async () => {
  // The full matrix. For each status the fulfillment log must say which
  // buyer, which repo, and what happened -- and only 201/204 may ever appear
  // as a delivery. An unrecognized status falling through to something that
  // reads like success is the failure mode this test exists to prevent.
  const cases = [
    { status: 201, delivered: true, log: /invited buyer-x to o\/r \(HTTP 201\)/ },
    { status: 204, delivered: true, log: /buyer-x already had access to o\/r \(HTTP 204\)/ },
    { status: 404, delivered: false, log: /no such GitHub user/ },
    { status: 403, delivered: false, log: /forbidden — the token lacks admin/ },
    { status: 422, delivered: false, log: /GitHub rejected the invite as invalid/ },
    { status: 401, delivered: false, log: /token is bad or expired/ },
    { status: 500, delivered: false, log: /GitHub server error/ },
    { status: 429, delivered: false, log: /rate limited/ },
    { status: 418, delivered: false, log: /UNRECOGNIZED status — treated as NOT delivered/ },
    { status: 200, delivered: false, log: /UNRECOGNIZED status — treated as NOT delivered/ },
  ];

  for (const c of cases) {
    const dir = tmp();
    const s = paidSession(`cs_matrix_${c.status}`, 1_700_000_000, {
      custom_fields: [{ key: 'github_username', text: { value: 'buyer-x' } }],
    });
    const out = captureLog();
    const err = captureErr();
    try {
      await runMain(dir, [
        { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
        { match: 'api.github.com', res: () => jsonRes({ message: 'x' }, c.status) },
      ]);
    } finally { err.restore(); out.restore(); }

    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
    if (c.delivered) {
      const line = out.lines.find((l) => l.includes(`cs_matrix_${c.status}`));
      assert.ok(line, `${c.status}: expected a delivery line, got:\n${out.lines.join('\n')}`);
      assert.match(line, c.log);
      assert.equal(ledger.total_sales, 1, `${c.status} should count as a sale`);
    } else {
      const line = err.lines.find((l) => l.includes(`cs_matrix_${c.status}`));
      assert.ok(line, `${c.status}: expected a loud failure, got:\n${err.lines.join('\n')}`);
      assert.match(line, /^FAILED/, `${c.status} must be greppable as FAILED`);
      assert.match(line, c.log);
      assert.match(line, new RegExp(`-> ${c.status}`), `${c.status} must name the status`);
      assert.equal(ledger.total_sales, 0, `${c.status} must NOT count as a sale`);
      assert.ok(
        !out.lines.some((l) => /invited|already had access/.test(l)),
        `${c.status} must never print a delivery line: ${out.lines.join('\n')}`
      );
    }
  }
});

test('a GitHub call that never answers is aborted, blamed by name, and retried', async () => {
  // Node's fetch has no overall request timeout. Without a deadline one
  // unresponsive socket holds the single launchd cycle open and every buyer
  // behind that one waits. The abort must (a) be loud, (b) name the error
  // class, and (c) count as TRANSIENT so the next poll picks the buyer up
  // rather than writing them off as undeliverable.
  const dir = tmp();
  const s = paidSession('cs_hang_1', 1_700_000_000);
  const err = captureErr();
  let run;
  try {
    run = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
      {
        match: 'api.github.com',
        res: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
      },
    ]);
  } finally { err.restore(); }

  const line = err.lines.find((l) => l.includes('cs_hang_1'));
  assert.ok(line, `expected a loud failure, got:\n${err.lines.join('\n')}`);
  assert.match(line, /^FAILED/);
  assert.match(line, /no response from GitHub/);
  assert.match(line, /TimeoutError/, 'the error class is the difference between a network blip and a dead token');
  assert.match(line, /will retry next poll/);

  const state = run.readState('fulfill-state.json');
  assert.deepEqual(state.processed, [], 'a hung call must not write the buyer off');
  assert.equal(state.failures[0].transient, true);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 0, 'no needs_attention row while retries are still owed');
});

test('both APIs are called with a deadline attached', async () => {
  // Belt and braces: the timeout is only real if it is actually passed to
  // fetch. Assert the signal reaches BOTH the Stripe poll and the GitHub
  // invite, so a future refactor that drops one gets caught here.
  const dir = tmp();
  const s = paidSession('cs_deadline_1', 1_700_000_000);
  const { calls } = await runMain(dir, [
    { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) },
    { match: 'api.github.com', res: () => jsonRes({}, 201) },
  ]);
  for (const host of ['api.stripe.com', 'api.github.com']) {
    const call = calls.find((c) => c.url.includes(host));
    assert.ok(call, `${host} was never called`);
    assert.ok(call.init.signal, `${host} call has no abort signal: an unanswered socket would stall the cycle`);
    assert.equal(typeof call.init.signal.aborted, 'boolean', `${host} signal is not an AbortSignal`);
  }
});

// A throttled response whose BODY says nothing useful: only the header marks
// it as a rate limit. That is deliberate: GitHub's wording is not a contract,
// and matching on prose was the old, brittle test.
const throttledRes = (retryAfterSeconds) => ({
  ok: false,
  status: 403,
  headers: new Headers({ 'retry-after': String(retryAfterSeconds) }),
  json: async () => ({}),
  text: async () => 'Forbidden',
});

test('a secondary rate limit is retried inside the run, not left to the next poll', async () => {
  // The failure this closes: the relay returns 200 to Stripe the moment the
  // DISPATCH lands, which says nothing about whether the INVITE succeeded, so
  // Stripe never retries a failed invite. Before this, a burst that tripped
  // GitHub's secondary limit left the buyer waiting for the hourly
  // reconciliation poll, up to ~60 minutes for a throttle that clears in
  // seconds.
  const dir = tmp();
  let attempts = 0;
  const github = {
    match: 'api.github.com',
    res: () => (++attempts === 1 ? throttledRes(3) : jsonRes({}, 201)),
  };
  const stripe = {
    match: 'api.stripe.com',
    res: () => jsonRes({ data: [paidSession('cs_rl_1', 1_700_000_000)], has_more: false }),
  };
  const err = captureErr();
  let out;
  try { out = await runMain(dir, [stripe, github]); } finally { err.restore(); }

  assert.equal(attempts, 2, 'the invite was retried inside the same run');
  assert.deepEqual(out.slept, [3000], 'waited exactly the 3s GitHub asked for, no more and no less');
  const state = out.readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_rl_1'], 'delivered in this run, not deferred to the poll');
  assert.equal(state.failures.length, 0, 'a throttle that cleared is not a failure worth keeping');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.length, 1);
  assert.ok(!ledger.rows[0].needs_attention);
  assert.ok(err.lines.some((l) => l.includes('RETRY')), 'the wait is visible in the log the watchdog reads');
});

test('the in-run retry budget is shared across a burst, so it cannot stretch without bound', async () => {
  // Ten throttled buyers must not serialize into ten separate waits and hold
  // the Actions job open. The budget is per-RUN: once spent, the buyers behind
  // it fall back to exactly the old behaviour (unprocessed, retried by the
  // next poll) rather than each buying another wait.
  const dir = tmp();
  const sessions = Array.from({ length: 10 }, (_, i) =>
    paidSession(`cs_rl_${i}`, 1_700_000_000 + i, {
      custom_fields: [{ key: 'github_username', text: { value: `buyer${i}` } }],
    })
  );
  const err = captureErr();
  let out;
  try {
    out = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
      { match: 'api.github.com', res: () => throttledRes(25) },
    ]);
  } finally { err.restore(); }

  const { IN_RUN_RETRY_BUDGET_MS } = require('../lib/fulfill-core.js');
  const total = out.slept.reduce((a, b) => a + b, 0);
  assert.ok(total <= IN_RUN_RETRY_BUDGET_MS, `run-wide wait must stay inside the budget, got ${total}ms`);
  const state = out.readState('fulfill-state.json');
  assert.deepEqual(state.processed, [], 'still throttled: all ten stay for the next poll');
  assert.equal(state.failures.length, 10, 'every buyer recorded one transient failure');
  assert.ok(state.failures.every((f) => f.transient), 'a throttle is transient, never needs_attention');
});

test('a transient Stripe error retries instead of killing the whole cycle', async () => {
  // The session list is the FIRST thing the run does, so before this a single
  // 500 from Stripe meant nobody was delivered that cycle. That is the widest
  // blast radius in the engine: one bad minute at Stripe during a launch burst
  // would have taken out every buyer in it, not one.
  const dir = tmp();
  let hits = 0;
  const stripe = {
    match: 'api.stripe.com',
    res: () => (++hits === 1
      ? { ok: false, status: 500, json: async () => ({}), text: async () => 'server error' }
      : jsonRes({ data: [paidSession('cs_sr_1', 1_700_000_000)], has_more: false })),
  };
  const err = captureErr();
  let out;
  try {
    out = await runMain(dir, [stripe, { match: 'api.github.com', res: () => jsonRes({}, 201) }]);
  } finally { err.restore(); }
  assert.equal(hits, 2, 'the failed list call was retried');
  assert.deepEqual(out.readState('fulfill-state.json').processed, ['cs_sr_1'], 'the sale still got delivered');

  // ...and a permanent verdict is NOT retried: a bad key must fail fast and
  // loudly, because every extra attempt delays the human who has to fix it.
  const dir2 = tmp();
  let authHits = 0;
  const err2 = captureErr();
  try {
    await assert.rejects(
      () => runMain(dir2, [{
        match: 'api.stripe.com',
        res: () => { authHits++; return { ok: false, status: 401, json: async () => ({}), text: async () => 'Invalid API Key' }; },
      }]),
      /401/
    );
  } finally { err2.restore(); }
  assert.equal(authHits, 1, 'a bad key fails on the first call, not after retries');
});

// GitHub's documented cap sentence, verbatim from the "Add a repository
// collaborator" REST page. Which status carries it is undocumented, so the
// tests below pin the behaviour for each status it could plausibly wear.
const capRes = (status) => ({
  ok: false,
  status,
  headers: new Headers({ 'x-ratelimit-remaining': '4831' }),
  json: async () => ({}),
  text: async () => JSON.stringify({
    message: 'You are limited to sending 50 invitations to a repository per 24 hour period.',
    documentation_url: 'https://docs.github.com/rest/collaborators/collaborators#add-a-repository-collaborator',
  }),
});

for (const status of [403, 422]) {
  test(`a burst past the invitation cap (as ${status}) queues calmly and tells the operator`, async () => {
    // The launch-day case. GitHub allows 50 invitations per repo per 24h, so
    // on the day a store does well the 51st sale is refused. What must NOT
    // happen: 10 pointless calls to an endpoint GitHub has asked us to stop
    // calling, 10 FAILED lines burying the one fact that matters, or any of
    // those buyers being written off as permanently undeliverable.
    const dir = tmp();
    const sessions = ['cs_burst_1', 'cs_burst_2', 'cs_burst_3'].map((id, i) =>
      paidSession(id, 1_700_000_000 + i, {
        custom_fields: [{ key: 'github_username', text: { value: `buyer-${i}` } }],
      })
    );
    let ghCalls = 0;
    const out = captureLog();
    const err = captureErr();
    let res;
    try {
      res = await runMain(dir, [
        { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
        { match: 'api.github.com', res: () => { ghCalls++; return capRes(status); } },
      ]);
    } finally { err.restore(); out.restore(); }

    // One call, not three: the first cap verdict pauses the repo for the run.
    assert.equal(ghCalls, 1, 'a capped repo must not be called again in the same run');
    // No in-run sleeping either: the cap does not clear in seconds.
    assert.deepEqual(res.slept, [], 'a cap must not be waited on inside the run');

    const state = res.readState('fulfill-state.json');
    // Nothing is written off. Every buyer stays unprocessed so the next poll
    // delivers them once the window frees a slot.
    assert.deepEqual(state.processed, [], 'no capped buyer may be marked processed');
    assert.equal(state.failures.length, 3);
    assert.ok(state.failures.every((f) => f.transient === true),
      'every capped buyer must stay in the retry queue, not become a permanent failure');

    const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
    assert.equal(ledger.rows.filter((r) => r.needs_attention).length, 0,
      'a cap is not a needs_attention row: it clears by itself');
    assert.equal(ledger.rows.length, 0, 'nothing may be logged as delivered');

    // The operator learns it from their own log, in the shape the watchdog
    // greps, on the run that saw it -- not from the buyer.
    const warns = err.lines.filter((l) => l.startsWith('WARN:'));
    assert.equal(warns.length, 2, 'one warning that the cap is in force, one for what it is costing');
    assert.match(warns[0], /reached GitHub's cap of 50 repository invitations per 24 hours/);
    assert.match(warns[0], /NOTHING is lost/);
    // There is no way out of this cap, and we used to promise one. GitHub's
    // "no limit for org members" note covers people who are ALREADY members;
    // creating that membership for a buyer is itself capped. So the warning
    // must not send a seller off to do a pre-launch migration that buys them
    // nothing, and must not hide that the org path leaks the buyer list.
    assert.match(warns[0], /cannot be removed/, 'the warning must not promise a fix that does not exist');
    assert.doesNotMatch(warns[0], /To remove the ceiling/, 'the old false advice must not come back');
    assert.match(warns[1], /3 paid buyers are waiting behind the invitation cap on o\/r/);
    // The queued ones say so plainly, and do not read as failures.
    assert.equal(out.lines.filter((l) => /^queued cs_burst_/.test(l)).length, 2);
    // And the one line that did report the refusal must not blame the buyer.
    const failed = err.lines.filter((l) => l.startsWith('FAILED'));
    assert.equal(failed.length, 1);
    assert.match(failed[0], /cap of 50 repository invitations per 24 hours/);
    assert.doesNotMatch(failed[0], /account cannot be added/,
      'a cap must never be reported as a bad buyer account');
  });
}

test('the watchdog would actually alert on a capped repo', async () => {
  // Guards the seam between what fulfill.js prints and what ops greps. The
  // ops watchdog matches /FAILED|WARN:|BOTS FAILED|^CONFIG /; a cap warning
  // worded outside that vocabulary would be invisible no matter how clear it
  // reads to a person.
  const ALERT_RE = /FAILED|WARN:|BOTS FAILED|^CONFIG /;
  const dir = tmp();
  const err = captureErr();
  const out = captureLog();
  try {
    await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: [paidSession('cs_wd', 1_700_000_000)], has_more: false }) },
      { match: 'api.github.com', res: () => capRes(422) },
    ]);
  } finally { err.restore(); out.restore(); }
  const alerting = err.lines.filter((l) => ALERT_RE.test(l.trim()));
  assert.ok(alerting.some((l) => /cap of 50 repository invitations/.test(l)),
    'the cap must reach the operator through a line the watchdog already greps');
});

test('a permissions 403 is still permanent, and our own hint text cannot disguise it', async () => {
  // The regression a unit test misses. isTransientInviteError was fed the
  // decorated MESSAGE, which embeds inviteStatusHint(403) -- and that hint
  // says "or a secondary rate limit is in force". So the prose check matched
  // our own words on every permissions 403 and quietly retried a token that
  // had lost admin, for six hours, instead of surfacing it at once. The unit
  // tests passed throughout because they built errors from bare strings that
  // never carried the hint. Only the driver builds the real message.
  const dir = tmp();
  const err = captureErr();
  let res;
  try {
    res = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: [paidSession('cs_perm', 1_700_000_000)], has_more: false }) },
      { match: 'api.github.com', res: () => ({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-ratelimit-remaining': '4831' }),
        json: async () => ({}),
        text: async () => JSON.stringify({ message: 'Resource not accessible by personal access token' }),
      }) },
    ]);
  } finally { err.restore(); }

  const state = res.readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_perm'], 'a permissions 403 is settled, not queued forever');
  assert.equal(state.failures.length, 1);
  assert.ok(!state.failures[0].transient,
    'a token that lacks admin must NOT be classified transient: retrying cannot fix it');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.filter((r) => r.needs_attention).length, 1,
    'it must reach a human on the first run, not after six hours of silence');
  assert.ok(err.lines.some((l) => /FAILED cs_perm/.test(l) && !/will retry/.test(l)));
});

test('a queue behind the cap still ends: past the window it escalates to a human', async () => {
  // The trap in the short-circuit. Deferring a buyer without consulting the
  // retry window would queue them on every poll forever, so a repo that is
  // "capped" for a reason that never clears (or a cap that is really
  // something else wearing its words) would keep paying customers waiting
  // silently and indefinitely. The queue must have an end.
  const dir = tmp();
  const sessions = ['cs_old_1', 'cs_old_2'].map((id, i) =>
    paidSession(id, 1_700_000_000 + i, {
      custom_fields: [{ key: 'github_username', text: { value: `buyer-${i}` } }],
    })
  );
  // Both buyers first failed 30h ago, past the 26h cap window.
  const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'fulfill-state.json'), JSON.stringify({
    cursor: 0,
    processed: [],
    failures: sessions.map((s) => ({ session: s.id, ts: thirtyHoursAgo, transient: true })),
  }));

  let ghCalls = 0;
  const err = captureErr();
  const out = captureLog();
  let res;
  try {
    res = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
      { match: 'api.github.com', res: () => { ghCalls++; return capRes(403); } },
    ]);
  } finally { err.restore(); out.restore(); }

  // Still only one call: knowing the repo is full is not a reason to re-ask.
  assert.equal(ghCalls, 1);
  const state = res.readState('fulfill-state.json');
  assert.deepEqual(state.processed.sort(), ['cs_old_1', 'cs_old_2'],
    'a queue past its window must settle, not roll forward another day');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'ledger', 'ledger.json'), 'utf8'));
  assert.equal(ledger.rows.filter((r) => r.needs_attention).length, 2,
    'both buyers must reach a human once the cap can no longer explain the wait');
  assert.equal(out.lines.filter((l) => /^queued /.test(l)).length, 0,
    'nothing may be reported as calmly queued once the window has expired');
});

test('a cap on one repo does not stop a different repo from delivering', async () => {
  // A multi-product store. The cap is per repository, so one full repo must
  // not become an outage for the others: pausing the whole run on the first
  // cap would turn one product's ceiling into every product's.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'store.config.json'), JSON.stringify({
    fulfillment: [
      { payment_link: 'plink_full', product: 'Full', repo: 'o/full' },
      { payment_link: 'plink_ok', product: 'Ok', repo: 'o/ok' },
    ],
  }));
  const sessions = [
    paidSession('cs_full_1', 1_700_000_000, { payment_link: 'plink_full',
      custom_fields: [{ key: 'github_username', text: { value: 'buyer-a' } }] }),
    paidSession('cs_ok_1', 1_700_000_001, { payment_link: 'plink_ok',
      custom_fields: [{ key: 'github_username', text: { value: 'buyer-b' } }] }),
    paidSession('cs_full_2', 1_700_000_002, { payment_link: 'plink_full',
      custom_fields: [{ key: 'github_username', text: { value: 'buyer-c' } }] }),
  ];
  const err = captureErr();
  const out = captureLog();
  let res;
  try {
    res = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
      { match: 'api.github.com', res: (url) => (url.includes('/o/full/') ? capRes(403) : jsonRes({}, 201)) },
    ]);
  } finally { err.restore(); out.restore(); }

  assert.deepEqual(res.readState('fulfill-state.json').processed, ['cs_ok_1'],
    'the healthy repo must still deliver while the other is capped');
  assert.ok(out.lines.some((l) => /fulfilled cs_ok_1: invited buyer-b to o\/ok/.test(l)));
  // Only the capped repo is warned about, and only once.
  const warns = err.lines.filter((l) => l.startsWith('WARN:'));
  assert.equal(warns.filter((l) => /o\/full/.test(l)).length, 2);
  assert.equal(warns.filter((l) => /o\/ok/.test(l)).length, 0);
});

test('the cap gates invitations only, not the orders that never needed one', async () => {
  // Two orders that reach a capped repo but ask nothing of the invitations
  // endpoint. Parking either behind the cap would be wrong: a typo is broken
  // whether or not the repo is full, and the seller test-buying their own
  // product needs no invitation at all.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'store.config.json'), JSON.stringify({
    fulfillment: [{ payment_link: 'plink_1', product: 'P', repo: 'octo/product' }],
  }));
  const sessions = [
    paidSession('cs_cap', 1_700_000_000, {
      custom_fields: [{ key: 'github_username', text: { value: 'buyer-real' } }] }),
    paidSession('cs_typo', 1_700_000_001, {
      custom_fields: [{ key: 'github_username', text: { value: 'not a username!' } }] }),
    paidSession('cs_owner', 1_700_000_002, {
      custom_fields: [{ key: 'github_username', text: { value: 'octo' } }] }),
  ];
  const err = captureErr();
  const out = captureLog();
  let res;
  try {
    res = await runMain(dir, [
      { match: 'api.stripe.com', res: () => jsonRes({ data: sessions, has_more: false }) },
      { match: 'api.github.com', res: () => capRes(422) },
    ]);
  } finally { err.restore(); out.restore(); }

  const state = res.readState('fulfill-state.json');
  // The typo settles now, as a permanent needs_attention, not "queued".
  assert.ok(state.processed.includes('cs_typo'), 'a bad username is broken regardless of the cap');
  // The repo owner is fulfilled outright: no invitation, so no cap.
  assert.ok(state.processed.includes('cs_owner'), 'an owner needs no invitation, so no cap applies');
  assert.ok(out.lines.some((l) => /fulfilled cs_owner: octo owns octo\/product, no invite needed/.test(l)));
  // Only the real buyer is queued.
  assert.ok(!state.processed.includes('cs_cap'));
  const warns = err.lines.filter((l) => l.startsWith('WARN:'));
  assert.ok(warns.some((l) => /1 paid buyer is waiting behind the invitation cap/.test(l)),
    'the queue count must count only buyers who actually need an invitation');
});

// ---- which Stripe account a run reaches -------------------------------
//
// These spawn the REAL script rather than calling main(), because the thing
// under test is what an operator sees on their terminal and what exit code
// the workflow gets. Both land before the first Stripe call, so no network
// and no key beyond an obviously fake one are involved.
const { execFileSync } = require('node:child_process');

// `--config` points at a path that does not exist, on purpose. The banner and
// the mode gate both land before the config is read, so the run prints what is
// under test here and then stops at "no config" WITHOUT ever calling Stripe.
// Without this the run reaches the real API, and Stripe's 401 body quotes the
// key back at you: a test of what gets printed must not itself go and print
// something.
function runCli(env, extraArgs = []) {
  const script = path.join(__dirname, '..', 'fulfill.js');
  const args = extraArgs.includes('--config')
    ? [script, ...extraArgs]
    : [script, '--config', path.join(os.tmpdir(), 'honorbox-no-such-config.json'), ...extraArgs];
  try {
    const out = execFileSync(process.execPath, args, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

const FAKE_TEST_KEY = 'sk_test_' + '0'.repeat(24);
const FAKE_LIVE_KEY = 'sk_live_' + '0'.repeat(24);

test('a run says which Stripe account it reaches, before it reaches it', () => {
  const r = runCli({ STRIPE_SECRET_KEY: FAKE_TEST_KEY, GH_FULFILL_TOKEN: 'x' });
  assert.match(r.out, /stripe mode=test/);
});

// The whole point: a live key must announce itself, so `node scripts/fulfill.js`
// with a live key exported cannot look like a rehearsal.
test('a live key announces live', () => {
  const r = runCli({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, GH_FULFILL_TOKEN: 'x' });
  assert.match(r.out, /stripe mode=live/);
  assert.doesNotMatch(r.out, /stripe mode=test/);
});

test('a key of unrecognised shape warns rather than claiming test', () => {
  const r = runCli({ STRIPE_SECRET_KEY: 'not-a-key', GH_FULFILL_TOKEN: 'x' });
  assert.match(r.out, /stripe mode=unknown/);
  assert.match(r.err, /WARN: STRIPE_SECRET_KEY does not look like/);
});

test('--require-mode test refuses to run against a live key', () => {
  const r = runCli({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, GH_FULFILL_TOKEN: 'x' }, ['--require-mode', 'test']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Refusing to run/);
  assert.match(r.err, /is a live key/);
});

test('--require-mode live refuses to run against a test key', () => {
  const r = runCli({ STRIPE_SECRET_KEY: FAKE_TEST_KEY, GH_FULFILL_TOKEN: 'x' }, ['--require-mode', 'live']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Refusing to run/);
});

// Opt-in: a store that never passes the flag must behave exactly as before.
test('--require-mode matching the key does not stop the run', () => {
  const r = runCli({ STRIPE_SECRET_KEY: FAKE_TEST_KEY, GH_FULFILL_TOKEN: 'x' }, ['--require-mode', 'test']);
  // The run still stops, at the deliberately absent config, which is what keeps
  // this test off the network. What must NOT happen is the mode gate refusing.
  assert.doesNotMatch(r.err, /Refusing to run/, 'a matching mode must not be the thing that stops the run');
  assert.match(r.out, /stripe mode=test/);
});

// Never, under any of these paths, may the key itself reach the output.
test('no part of the key is ever printed', () => {
  for (const key of [FAKE_LIVE_KEY, FAKE_TEST_KEY, 'not-a-key']) {
    for (const args of [[], ['--require-mode', 'live'], ['--require-mode', 'test']]) {
      const r = runCli({ STRIPE_SECRET_KEY: key, GH_FULFILL_TOKEN: 'x' }, args);
      const all = r.out + r.err;
      assert.ok(!all.includes(key), `whole key leaked with args ${JSON.stringify(args)}`);
      // and not a fragment either: the tail is the secret part
      assert.ok(!all.includes(key.slice(-12)), `key tail leaked with args ${JSON.stringify(args)}`);
    }
  }
});

test('a deferred session holds the cursor so the next poll can still see it', async () => {
  // The invite fails transiently, so the session is deferred to the next
  // poll. If a newer sale in the same scan were allowed to advance the
  // cursor past created + OVERLAP, the deferred session would leave the
  // scan window and no poll would ever retry OR escalate it: a paid order,
  // lost in silence. The cursor must hold just inside the window instead.
  const { OVERLAP_SECONDS } = require('../lib/fulfill-core.js');
  const dir = tmp();
  const t0 = 1_700_000_000;
  const stuck = paidSession('cs_stuck', t0); // invites octocat -> 502
  const fresh = paidSession('cs_fresh', t0 + 26 * 3600, {
    custom_fields: [{ key: 'github_username', text: { value: 'goodbuyer' } }],
  });
  const { readState } = await runMain(dir, [
    { match: 'collaborators/octocat', res: () => jsonRes({ message: 'bad gateway' }, 502) },
    { match: 'collaborators/goodbuyer', res: () => jsonRes({}, 201) },
    { match: 'api.stripe.com', res: () => jsonRes({ data: [stuck, fresh], has_more: false }) },
  ]);
  const state = readState('fulfill-state.json');
  assert.deepEqual(state.processed, ['cs_fresh'], 'the healthy sale still settles');
  assert.ok(state.failures.some((f) => f.session === 'cs_stuck' && f.transient), 'the stuck one is deferred');
  assert.ok(
    state.cursor - OVERLAP_SECONDS < t0,
    `cursor ${state.cursor} pushes the deferred session out of the created > cursor - ${OVERLAP_SECONDS} scan window`
  );
});
