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
  // waits instead of serving them. `slept` is then assertable — a test can
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
  // been lost. It must warn — once, on the loud channel the watchdog reads.
  const dir = tmp();
  const s = paidSession('cs_orphan_1', 1_700_000_000, { payment_link: 'plink_NOT_IN_CONFIG' });
  const stripe = { match: 'api.stripe.com', res: () => jsonRes({ data: [s], has_more: false }) };
  const github = { match: 'api.github.com', res: () => jsonRes({}, 201) };

  const err1 = captureErr();
  let first;
  try { first = await runMain(dir, [stripe, github]); } finally { err1.restore(); }

  const warn = err1.lines.find((l) => l.includes('cs_orphan_1'));
  assert.ok(warn, `expected a warning, got:\n${err1.lines.join('\n')}`);
  assert.match(warn, /^WARN:/, 'the watchdog greps for "WARN:" — the prefix is load-bearing');
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
  // 120s poll. Every one of them must be invited, ledgered, and processed —
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
  // A single typo'd username 404s. If that aborted the loop — or quietly ate
  // the rest — the buyers after it in the same poll would pay and get
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
    assert.ok(call.init.signal, `${host} call has no abort signal — an unanswered socket would stall the cycle`);
    assert.equal(typeof call.init.signal.aborted, 'boolean', `${host} signal is not an AbortSignal`);
  }
});

// A throttled response whose BODY says nothing useful: only the header marks
// it as a rate limit. That is deliberate — GitHub's wording is not a contract,
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
  // reconciliation poll — up to ~60 minutes for a throttle that clears in
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
  // it fall back to exactly the old behaviour — unprocessed, retried by the
  // next poll — rather than each buying another wait.
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
