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
  try {
    await driver.main();
  } finally {
    restore();
    process.argv = savedArgv;
    if (savedEnv.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedEnv.key;
    if (savedEnv.tok === undefined) delete process.env.GH_FULFILL_TOKEN;
    else process.env.GH_FULFILL_TOKEN = savedEnv.tok;
  }
  return { calls, readState: (f) => JSON.parse(fs.readFileSync(path.join(dir, 'state', f), 'utf8')) };
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
