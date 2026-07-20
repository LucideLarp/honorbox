'use strict';
// INTEGRATION rehearsal of the whole delivery path, against the REAL Stripe and
// GitHub APIs, in Stripe test mode, driving the REAL scripts/fulfill.js.
//
// Why this exists. Every other test of the fulfillment lane stubs `fetch` and
// feeds the driver a Checkout Session that WE wrote. That proves the code
// agrees with our idea of Stripe, which is worth nothing precisely when that
// idea is wrong: a fixture cannot tell you that a buyer's answer really lands
// at `custom_fields[].text.value`, that a server-created session really carries
// no `payment_link` so the grant has to match on price, or that the version we
// pin still returns the fields we read. A delivery run that finds no sales is a
// no-op, and a successful no-op proves nothing. This buys a real product with a
// real test card and watches a real invite go out.
//
// It is SKIPPED unless the credentials below are set, so it never runs in CI and
// never blocks a push. It is not optional in the sense of being unimportant. It
// is optional in the sense of needing credentials and creating real objects.
//
//   HONORBOX_STRIPE_TEST_KEY=sk_test_...   secret key, test mode only
//   HONORBOX_STRIPE_TEST_PUB_KEY=pk_test_... publishable key, same account
//   HONORBOX_GH_TEST_TOKEN=...             token with admin on the scratch repo
//   HONORBOX_GH_TEST_OWNER=...             org or user to create the repo under
//   HONORBOX_GH_TEST_USERNAME=...          identity to invite (never a customer)
//   HONORBOX_GH_TEST_REPO=owner/name       optional: reuse this repo, do not
//                                          create or delete one
//
//   node --test scripts/test/fulfill-stripe-integration.test.js
//
// The key MUST be a test-mode key. A live key FAILS the run rather than skipping
// it, because the failure it prevents is charging a real card on a production
// account, and a run that quietly did nothing would look identical to a run that
// passed.
//
// HOW A BUYER IS SIMULATED, and the one caveat in this file. Stripe publishes no
// API for completing a Checkout Session: the documented path is a human on the
// hosted page. So this drives the same two calls the hosted page itself makes,
// with the publishable key, exactly as a browser would:
//
//   GET  /v1/payment_pages/{cs_id}          read the page, including the
//                                           cstm_fld_ id for each custom field
//   POST /v1/payment_pages/{cs_id}/confirm  submit the form
//
// Those two endpoints are NOT in Stripe's published API reference. They are the
// real buyer path rather than a shortcut around it, which is why they are used
// here, but Stripe may change them without notice. If this file starts failing
// at `confirm`, suspect that before you suspect fulfillment: everything after
// the confirm is ordinary documented API. `confirmCheckout` says so on failure.
//
// No raw card numbers. Stripe's testing guide says plainly, "When writing test
// code, use a PaymentMethod such as pm_card_visa instead of a card number. We
// don't recommend using card numbers directly in API calls or server-side code,
// even in testing environments." Only the `tok_visa` test token is used here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Requiring the driver must not run main(); the driver's require.main guard is
// what makes this possible, and this test is the reason it has to keep working.
const driver = require('../fulfill.js');

const KEY = process.env.HONORBOX_STRIPE_TEST_KEY;
const PUB = process.env.HONORBOX_STRIPE_TEST_PUB_KEY;
const GH_TOKEN = process.env.HONORBOX_GH_TEST_TOKEN;
const GH_OWNER = process.env.HONORBOX_GH_TEST_OWNER;
const GH_USER = process.env.HONORBOX_GH_TEST_USERNAME;
const GH_REPO = process.env.HONORBOX_GH_TEST_REPO;

const LIVE_KEY_GIVEN = !!KEY && !KEY.startsWith('sk_test_');
const SKIP = !KEY || LIVE_KEY_GIVEN || !PUB || !GH_TOKEN || !GH_USER || !(GH_REPO || GH_OWNER)
  ? 'set HONORBOX_STRIPE_TEST_KEY, HONORBOX_STRIPE_TEST_PUB_KEY, HONORBOX_GH_TEST_TOKEN, ' +
    'HONORBOX_GH_TEST_USERNAME and either HONORBOX_GH_TEST_REPO or HONORBOX_GH_TEST_OWNER to run this'
  : false;

// A real card charge, two real API round trips per run, and a repo create and
// delete. Slow by nature, but bounded.
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

const PRICE_MINOR = 2900;
const CURRENCY = 'usd';

// Form-encode the way Stripe expects: line_items[0][price]=price_x.
function encode(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') out.push(encode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

// Stripe-Version pinned to match the engine: the account default may be a
// broken preview, and a rehearsal on a different version rehearses nothing.
async function stripe(method, pathname, params, key = KEY) {
  const body = params ? encode(params) : undefined;
  const url = `https://api.stripe.com${pathname}`;
  const res = await fetch(method === 'GET' && body ? `${url}?${body}` : url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(key + ':').toString('base64')}`,
      'Stripe-Version': '2024-06-20',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json();
  if (!res.ok) {
    const m = (json.error && json.error.message) || JSON.stringify(json);
    throw new Error(`Stripe ${method} ${pathname} -> ${res.status}: ${m}`);
  }
  return json;
}

async function github(method, pathname, body) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'honorbox-rehearsal',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Drive the hosted checkout page the way a browser does. See the header note:
// these two endpoints are undocumented, so the failure message has to point at
// that rather than let it read as a fulfillment bug.
async function confirmCheckout(sessionId, username) {
  let page;
  try {
    page = await stripe('GET', `/v1/payment_pages/${sessionId}`, null, PUB);
  } catch (err) {
    throw new Error(
      `could not read the hosted checkout page for ${sessionId}. This test drives ` +
        `the undocumented /v1/payment_pages endpoints to simulate a buyer, and Stripe ` +
        `may have changed them. Fulfillment itself is not implicated. Original: ${err.message}`
    );
  }
  const field = (page.custom_fields || []).find((f) => f.key === 'github_username');
  assert.ok(field && field.id, 'hosted page must expose the github_username custom field id');

  try {
    await stripe('POST', `/v1/payment_pages/${sessionId}/confirm`, {
      custom_fields: [{ custom_field_id: field.id, text: username }],
      payment_method_data: {
        type: 'card',
        card: { token: 'tok_visa' },
        billing_details: { name: 'Rehearsal Buyer', email: 'rehearsal@example.com' },
      },
      expected_amount: PRICE_MINOR,
    }, PUB);
  } catch (err) {
    throw new Error(
      `could not submit the hosted checkout page for ${sessionId}. This test drives ` +
        `the undocumented /v1/payment_pages endpoints to simulate a buyer, and Stripe ` +
        `may have changed them. Fulfillment itself is not implicated. Original: ${err.message}`
    );
  }
}

// Pass through to the real network, but record what the delivery path actually
// did. This observes fulfill.js, it does not replace any part of it.
function observeFetch() {
  const orig = globalThis.fetch;
  const invites = [];
  globalThis.fetch = async (url, init = {}) => {
    const res = await orig(url, init);
    if (init.method === 'PUT' && /\/repos\/[^/]+\/[^/]+\/collaborators\//.test(String(url))) {
      invites.push({ url: String(url), status: res.status });
    }
    return res;
  };
  return { invites, restore: () => { globalThis.fetch = orig; } };
}

// Run the REAL driver against a temp working set, with argv and env staged and
// restored around the call, exactly as the workflow invokes it.
async function runFulfill(dir) {
  const savedArgv = process.argv;
  const saved = { key: process.env.STRIPE_SECRET_KEY, tok: process.env.GH_FULFILL_TOKEN };
  process.argv = [savedArgv[0], 'fulfill.js',
    '--config', path.join(dir, 'store.config.json'),
    '--state', path.join(dir, 'state', 'fulfill-state.json'),
    '--ledger', path.join(dir, 'ledger', 'ledger.json')];
  // The engine reads STRIPE_SECRET_KEY. On a machine that also has the live key
  // exported, this override is the only thing standing between a rehearsal and
  // a live-mode run, so it is set explicitly rather than inherited.
  process.env.STRIPE_SECRET_KEY = KEY;
  process.env.GH_FULFILL_TOKEN = GH_TOKEN;

  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  const seen = observeFetch();
  try {
    await driver.main();
  } catch (err) {
    // The captured log is the only account of how far the run got, and losing
    // it to the throw is losing the diagnosis.
    err.message = `${err.message}\n--- fulfillment log ---\n${logs.join('\n')}`;
    throw err;
  } finally {
    seen.restore();
    console.log = origLog;
    console.error = origErr;
    process.argv = savedArgv;
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.tok === undefined) delete process.env.GH_FULFILL_TOKEN;
    else process.env.GH_FULFILL_TOKEN = saved.tok;
  }
  const read = (p, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')); } catch { return fallback; }
  };
  return {
    logs,
    invites: seen.invites,
    state: read(path.join('state', 'fulfill-state.json'), {}),
    ledger: read(path.join('ledger', 'ledger.json'), { rows: [] }),
  };
}

// Always runs, even when the rehearsal is skipped for want of credentials: a
// live key must FAIL the run, not skip it. A run that quietly did nothing would
// look identical to a run that passed.
test('the rehearsal key is a test-mode key', () => {
  assert.equal(
    LIVE_KEY_GIVEN,
    false,
    'HONORBOX_STRIPE_TEST_KEY is not an sk_test_ key. This rehearsal charges a card and ' +
      'creates products, prices and sessions; pointed at a live key it would create them on ' +
      'the real account. Refusing to run.'
  );
});

test('a paid test-mode checkout becomes a real GitHub invite, once', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const tag = crypto.randomBytes(4).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honorbox-rehearsal-'));
  const created = { product: null, price: null, session: null, repo: null, repoIsOurs: false };

  try {
    // 1. A private repo to deliver into. Never a real product repo.
    if (GH_REPO) {
      created.repo = GH_REPO;
    } else {
      const name = `honorbox-rehearsal-${tag}`;
      // Resolve the owner before creating anything. A typo here used to 404 and
      // fall through to "not an organisation", which quietly created the repo
      // under the authenticated user instead of where it was asked to go.
      const owner = await github('GET', `/users/${GH_OWNER}`);
      assert.strictEqual(owner.status, 200,
        `HONORBOX_GH_TEST_OWNER "${GH_OWNER}" does not resolve on GitHub -> ${owner.status}`);
      const isOrg = owner.body.type === 'Organization';
      const mk = await github('POST', isOrg ? `/orgs/${GH_OWNER}/repos` : '/user/repos', {
        name,
        private: true,
        description: 'Scratch repo for a fulfillment rehearsal. Safe to delete.',
      });
      assert.strictEqual(mk.status, 201, `create scratch repo -> ${mk.status}: ${JSON.stringify(mk.body)}`);
      assert.strictEqual(mk.body.private, true, 'the scratch repo must be private');
      created.repo = mk.body.full_name;
      created.repoIsOurs = true;
    }
    t.diagnostic(`scratch repo: ${created.repo}`);

    // The engine treats a buyer who owns the repo as already having access and
    // never calls GitHub at all. That is correct for a seller test-buying their
    // own product, and useless as a rehearsal: the run would go green having
    // proved nothing about delivery. Refuse it rather than report it as cover.
    assert.notStrictEqual(
      created.repo.split('/')[0].toLowerCase(), GH_USER.toLowerCase(),
      `HONORBOX_GH_TEST_USERNAME (${GH_USER}) owns the scratch repo, so the engine ` +
        `skips the invite entirely and this rehearsal would prove nothing. Use a different identity.`
    );

    // 2. A product and price to sell, unique to this run so the grant can only
    //    match this run's session.
    const product = await stripe('POST', '/v1/products', { name: `HonorBox rehearsal ${tag}` });
    created.product = product.id;
    const price = await stripe('POST', '/v1/prices', {
      product: product.id, unit_amount: PRICE_MINOR, currency: CURRENCY,
    });
    created.price = price.id;

    // 3. A Checkout Session carrying the github_username custom field exactly as
    //    the store configures it. Server-created, so it has no payment_link and
    //    the grant has to match on price: the harder of the two match paths.
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: 'https://example.com/ok?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://example.com/cancelled',
      custom_fields: [{
        key: 'github_username',
        label: { type: 'custom', custom: 'GitHub username' },
        type: 'text',
      }],
    });
    created.session = session.id;
    assert.strictEqual(session.status, 'open');
    assert.strictEqual(session.payment_status, 'unpaid');

    // 4. Pay it, as a buyer would.
    await confirmCheckout(session.id, GH_USER);

    const paid = await stripe('GET', `/v1/checkout/sessions/${session.id}`);
    assert.strictEqual(paid.status, 'complete', 'session must be complete after payment');
    assert.strictEqual(paid.payment_status, 'paid', 'session must be paid, not merely complete');
    assert.strictEqual(paid.amount_total, PRICE_MINOR);
    const answered = (paid.custom_fields || []).find((f) => f.key === 'github_username');
    assert.strictEqual(answered && answered.text && answered.text.value, GH_USER,
      'the buyer answer must survive to the session Stripe hands the engine');
    t.diagnostic(`session ${session.id}: status=${paid.status} payment_status=${paid.payment_status}`);

    // 5. The store config the engine will read. Cursor seeded just before the
    //    sale so the run scans a realistic window instead of all history.
    fs.writeFileSync(path.join(dir, 'store.config.json'), JSON.stringify({
      fulfillment: [{ price: price.id, product: `Rehearsal ${tag}`, repo: created.repo }],
    }, null, 2));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'fulfill-state.json'), JSON.stringify({
      cursor: paid.created - 5, processed: [], failures: [],
    }, null, 2));

    // ---- Run 1: the delivery ------------------------------------------------
    const run1 = await runFulfill(dir);
    t.diagnostic(`run 1 log:\n${run1.logs.join('\n')}`);

    assert.strictEqual(run1.invites.length, 1,
      `exactly one collaborator call expected, saw ${run1.invites.length}`);
    const code = run1.invites[0].status;

    // 201 and 204 are DIFFERENT outcomes and the engine must not collapse them.
    // The status here is the one the real GitHub response carried, so this
    // checks the engine's claim against what actually happened rather than
    // against another copy of our own assumptions.
    assert.ok(code === 201 || code === 204,
      `GitHub answered ${code}; only 201 (invitation created) or 204 (already a collaborator) mean delivered`);
    const line = run1.logs.find((l) => l.includes(`fulfilled ${created.session}`));
    assert.ok(line, `no fulfilled line for ${created.session} in:\n${run1.logs.join('\n')}`);
    assert.match(line, new RegExp(`\\(HTTP ${code}\\)`), 'the log must report the status GitHub actually returned');

    if (code === 201) {
      assert.match(line, new RegExp(`invited ${GH_USER} to ${created.repo}`));
      const invitations = await github('GET', `/repos/${created.repo}/invitations`);
      assert.ok(invitations.body.some((i) => i.invitee && i.invitee.login === GH_USER),
        '201 must leave a real pending invitation on the repo');
      t.diagnostic('OBSERVED 201: a real invitation was created and found on the repo.');
    } else {
      assert.match(line, new RegExp(`${GH_USER} already had access to ${created.repo}`));
      assert.ok(!/invited/.test(line), `204 must never claim an invite: ${line}`);
      t.diagnostic(
        'OBSERVED 204: this identity was ALREADY a collaborator, so GitHub created no ' +
        'invitation. The 201 invitation-created path was NOT exercised by this run. ' +
        'An account that is an owner or member of the repo owner organisation can never ' +
        'produce 201; use an identity with no existing access to cover that path.'
      );
    }

    // The sale is on the ledger, once, and the row carries no buyer identity.
    assert.strictEqual(run1.ledger.rows.length, 1, 'exactly one ledger row after one sale');
    const row = run1.ledger.rows[0];
    assert.strictEqual(row.product, `Rehearsal ${tag}`);
    assert.strictEqual(row.amount, PRICE_MINOR / 100);
    assert.strictEqual(row.currency, CURRENCY.toUpperCase());
    assert.ok(!row.needs_attention, 'a delivered sale must not be flagged for attention');
    assert.ok(!JSON.stringify(row).includes(GH_USER), 'the ledger must not carry the buyer username');
    assert.ok(!JSON.stringify(row).includes(created.session), 'the ledger must not carry the session id');
    assert.ok(run1.state.processed.includes(created.session), 'the session must be marked processed');

    // ---- Run 2: idempotency, the ordinary way -------------------------------
    // State survives, so the processed-id set is what stops the re-invite.
    const run2 = await runFulfill(dir);
    assert.strictEqual(run2.invites.length, 0,
      `a second run must not touch GitHub again, saw ${run2.invites.length} call(s)`);
    assert.strictEqual(run2.ledger.rows.length, 1, 'a second run must not append a second ledger row');
    assert.ok(run2.logs.some((l) => /new_paid=0/.test(l)), 'the second run must find no new paid work');

    // ---- Run 3: idempotency when the state file is lost ----------------------
    // The processed set is gone, so the ledger's own ref is the only guard left.
    // This is the one that silently breaks: it is a different mechanism, and a
    // restored-from-backup or wiped state directory is exactly when it matters.
    const wiped = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'fulfill-state.json'), 'utf8'));
    wiped.processed = [];
    fs.writeFileSync(path.join(dir, 'state', 'fulfill-state.json'), JSON.stringify(wiped, null, 2));

    const run3 = await runFulfill(dir);
    assert.strictEqual(run3.invites.length, 0,
      `losing the processed set must not re-invite a paid buyer, saw ${run3.invites.length} call(s)`);
    assert.strictEqual(run3.ledger.rows.length, 1,
      'losing the processed set must not double the ledger row');
    assert.ok(run3.state.processed.includes(created.session),
      'the ledger guard must put the session back in the processed set');

    t.diagnostic(`PASS. GitHub answered HTTP ${code}. Ledger rows: 1 after three runs.`);
  } finally {
    // Cleanup runs whatever happened above. Each step reports rather than
    // throws, so one failure cannot strand the rest.
    const note = (s) => t.diagnostic(`cleanup: ${s}`);
    if (created.repo) {
      const rm = await github('DELETE', `/repos/${created.repo}/collaborators/${GH_USER}`);
      note(`remove collaborator ${GH_USER} -> ${rm.status}`);
      const inv = await github('GET', `/repos/${created.repo}/invitations`);
      for (const i of Array.isArray(inv.body) ? inv.body : []) {
        const d = await github('DELETE', `/repos/${created.repo}/invitations/${i.id}`);
        note(`cancel invitation -> ${d.status}`);
      }
    }
    if (created.repoIsOurs) {
      const del = await github('DELETE', `/repos/${created.repo}`);
      note(`delete repo ${created.repo} -> ${del.status}`);
      if (del.status !== 204) {
        note(
          `SCRATCH REPO ${created.repo} IS STILL THERE. Deleting a repository needs the ` +
          `delete_repo scope, which a fulfillment token deliberately does not carry. ` +
          `Grant it once with: gh auth refresh -h github.com -s delete_repo`
        );
      }
    }
    // A Checkout Session cannot be deleted. A completed one is a permanent
    // record of a test-mode charge; only an unpaid one can be expired.
    if (created.session) {
      const s = await stripe('GET', `/v1/checkout/sessions/${created.session}`).catch(() => null);
      if (s && s.status === 'open') {
        await stripe('POST', `/v1/checkout/sessions/${created.session}/expire`).catch(() => {});
        note(`expired unpaid session ${created.session}`);
      }
    }
    // Prices can never be deleted, and a product that has one can only be
    // archived. Archiving both is as clean as the API allows.
    if (created.price) {
      await stripe('POST', `/v1/prices/${created.price}`, { active: false }).catch(() => {});
      note('price archived');
    }
    if (created.product) {
      await stripe('POST', `/v1/products/${created.product}`, { active: false }).catch(() => {});
      note('product archived');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
