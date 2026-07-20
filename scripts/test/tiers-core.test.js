'use strict';
// Tests for the seat-tier logic. The two functions under test are the ones a
// re-run of add-tier.js can lose money with, so both are exercised on the
// refusal path as well as the happy one: a guard that has only ever been seen
// to pass is a guard nobody has tested.
//
// Run: node --test scripts/test/tiers-core.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lookupKeyFor, reusablePrice, mergeGrants, tierLinkParams } = require('../lib/tiers-core.js');

const ADD_TIER = path.join(__dirname, '..', 'add-tier.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-tier-'));

// --- lookup keys ------------------------------------------------------------

test('a tier lookup key is deterministic and safe to put in a URL', () => {
  assert.equal(lookupKeyFor('prod_ABC123', 'team'), 'prod_abc123__team');
  assert.equal(lookupKeyFor('prod_ABC123', 'team'), lookupKeyFor('prod_ABC123', 'team'),
    'a second run must derive the same key or it will create a parallel price');
  assert.equal(lookupKeyFor('prod_A', 'Company Wide'), 'prod_a__company-wide');
});

// --- reusablePrice: never sell at a number nobody asked for -----------------

test('an existing tier price at the same amount is reused, not duplicated', () => {
  const existing = { id: 'price_1', unit_amount: 9900, currency: 'usd', active: true };
  const v = reusablePrice(existing, { unit_amount: 9900, currency: 'usd' });
  assert.equal(v.error, undefined);
  assert.equal(v.use.id, 'price_1');
});

test('no price yet is not an error, it is the first run', () => {
  assert.deepEqual(reusablePrice(undefined, { unit_amount: 9900, currency: 'usd' }), { use: null });
});

test('a tier price at a DIFFERENT amount stops the run instead of selling either number', () => {
  // A Stripe price is immutable. Reusing this would sell the tier at 9900
  // forever behind a page advertising 12900; creating a second price under one
  // lookup key would make every later run ambiguous. Both are worse than a stop.
  const existing = { id: 'price_1', unit_amount: 9900, currency: 'usd', active: true };
  const v = reusablePrice(existing, { unit_amount: 12900, currency: 'usd' });
  assert.equal(v.use, undefined);
  assert.match(v.error, /cannot be repriced/);
  assert.match(v.error, /price_1/, 'the operator needs the id to go look at it');
});

test('a tier price in a different currency is the same refusal', () => {
  const existing = { id: 'price_1', unit_amount: 9900, currency: 'usd', active: true };
  const v = reusablePrice(existing, { unit_amount: 9900, currency: 'eur' });
  assert.match(v.error, /cannot be repriced/);
});

test('an archived tier price is reported, never silently replaced', () => {
  const existing = { id: 'price_1', unit_amount: 9900, currency: 'usd', active: false };
  const v = reusablePrice(existing, { unit_amount: 9900, currency: 'usd' });
  assert.match(v.error, /archived/);
});

// --- mergeGrants: never duplicate, never silently re-point ------------------

test('a new tier grant is appended', () => {
  const before = [{ payment_link: 'plink_a', repo: 'o/a' }];
  const r = mergeGrants(before, { payment_link: 'plink_b', repo: 'o/b' });
  assert.equal(r.added, true);
  assert.equal(r.grants.length, 2);
});

test('re-running leaves the config byte-identical', () => {
  // This is what makes the command safe to run from a script. A second grant
  // carrying the same link is not untidy, it is dead config: matchGrant()
  // returns the first and the second reads as if it were doing something.
  const before = [{ payment_link: 'plink_a', repo: 'o/a', product: 'A' }];
  const r = mergeGrants(before, { payment_link: 'plink_a', repo: 'o/a', product: 'A' });
  assert.equal(r.added, false);
  assert.strictEqual(r.grants, before, 'the untouched array is handed straight back');
  assert.equal(r.grants.length, 1);
});

test('re-pointing a live grant at another repo is refused', () => {
  // Almost always a typo'd --repo, and if it is not, it stops delivering what
  // this tier's existing buyers already paid for.
  const before = [{ payment_link: 'plink_a', repo: 'o/a' }];
  const r = mergeGrants(before, { payment_link: 'plink_a', repo: 'o/typo' });
  assert.equal(r.grants, undefined);
  assert.match(r.error, /already grants o\/a/);
});

test('a missing fulfillment array is a first tier, not a crash', () => {
  const r = mergeGrants(undefined, { payment_link: 'plink_a', repo: 'o/a' });
  assert.equal(r.added, true);
  assert.deepEqual(r.grants, [{ payment_link: 'plink_a', repo: 'o/a' }]);
});

// --- the link the buyer actually meets --------------------------------------

test('a tier link carries the field fulfillment reads, and no open discount surface', () => {
  const p = tierLinkParams('price_1', 'o/thing', 'team', 'up to 5 developers');
  assert.equal(p['custom_fields[0][key]'], 'github_username',
    'fulfillment matches buyers on this field; without it every sale is unmatchable');
  assert.equal(p.allow_promotion_codes, 'false',
    'an open promo field is a live discount surface on a money path');
  assert.equal(p['metadata[honorbox_tier]'], 'team',
    'the tier must be legible on the Stripe object, or a re-run cannot find this link');
  assert.match(p['after_completion[hosted_confirmation][custom_message]'], /up to 5 developers/,
    'the buyer is told what they just bought the right to');
});

test('invoicing is off unless asked for, and turns on the tax ID with it', () => {
  const plain = tierLinkParams('price_1', 'o/thing', 'team', 'up to 5 developers');
  assert.equal(plain['invoice_creation[enabled]'], undefined,
    'collecting a buyer\'s VAT number changes the seller\'s filing, so it is never a default');
  assert.equal(plain['tax_id_collection[enabled]'], undefined);

  const invoiced = tierLinkParams('price_1', 'o/thing', 'company', 'every developer', { invoice: true });
  assert.equal(invoiced['invoice_creation[enabled]'], 'true');
  assert.equal(invoiced['tax_id_collection[enabled]'], 'true',
    'without the tax ID the invoice carries no company name or number, which is the point of it');
});

// --- the driver refuses to touch Stripe on a bad command --------------------

function runAddTier(args) {
  return spawnSync(process.execPath, [ADD_TIER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_never_used' },
  });
}

test('add-tier: a corrupt config stops before anything could be created', () => {
  // Same ordering rule as init.js: the config is written after the Stripe
  // objects exist, so a config that cannot be read must fail up front. Failing
  // afterwards leaves a live payment link with no grant behind it.
  const dir = tmp();
  const bad = path.join(dir, 'store.config.json');
  fs.writeFileSync(bad, '{ not json');
  const r = runAddTier(['--product', 'prod_x', '--tier', 'team', '--price', '9900',
    '--seats', 'up to 5 developers', '--repo', 'o/r', '--config', bad, '--dry-run']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /store\.config\.json/);
});

test('add-tier: --dry-run=false is refused rather than read as off', () => {
  // has() matches the exact token, so `--dry-run=false` is FALSE to the switch
  // and would have created live objects from a command that says dry-run.
  const r = runAddTier(['--product', 'prod_x', '--tier', 'team', '--price', '9900',
    '--seats', 's', '--repo', 'o/r', '--dry-run=false']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /switch and takes no value/);
});

test('add-tier: creating requires --yes, so a bare command cannot make objects', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ fulfillment: [] }));
  const r = runAddTier(['--product', 'prod_x', '--tier', 'team', '--price', '9900',
    '--seats', 's', '--repo', 'o/r', '--config', cfg]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--yes/);
});

test('add-tier: a typo\'d flag names the token rather than the field it left empty', () => {
  const r = runAddTier(['--prodcut', 'prod_x', '--tier', 'team', '--price', '9900',
    '--seats', 's', '--repo', 'o/r', '--dry-run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--prodcut/);
});
