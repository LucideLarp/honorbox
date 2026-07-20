'use strict';
// Tests for scripts/init.js argument/config validation, via spawn. Every
// case here exits before any Stripe call is attempted: no network, no keys.
//
// Run: node --test scripts/test/init.test.js
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INIT = path.join(__dirname, '..', 'init.js');

function runInit(args, env = {}) {
  return spawnSync(process.execPath, [INIT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: 'rk_test_never_used', ...env },
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-init-'));

test('init: missing or corrupt config dies BEFORE anything would be created', () => {
  // The config is written AFTER the Stripe objects exist. If it cannot be
  // read, a real run would leave a live, buyer-visible payment link with no
  // fulfillment grant wired: paid orders that never deliver. So the config
  // must be validated up front, which also makes --dry-run catch it.
  const missing = runInit(['--name', 'T', '--price', '2900', '--repo', 'o/r',
    '--config', path.join(tmp(), 'nope.json'), '--dry-run']);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /nope\.json/, missing.stderr);

  const dir = tmp();
  const corrupt = path.join(dir, 'store.config.json');
  fs.writeFileSync(corrupt, '{ not json');
  const bad = runInit(['--name', 'T', '--price', '2900', '--repo', 'o/r',
    '--config', corrupt, '--dry-run']);
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /store\.config\.json/, bad.stderr);
});

test('init: --dry-run with a valid config previews and creates nothing', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  const before = JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2) + '\n';
  fs.writeFileSync(cfg, before);
  const res = runInit(['--name', 'My Tool', '--price', '2900', '--repo', 'o/r',
    '--config', cfg, '--products', path.join(dir, 'products'), '--dry-run']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /dry run/);
  assert.match(res.stdout, /\$29 one-time/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before, 'dry run must not touch the config');
  assert.ok(!fs.existsSync(path.join(dir, 'products')), 'dry run must not scaffold');
});

test('init: missing required args die with exit 2', () => {
  for (const args of [
    [], // no name
    ['--name', 'T'], // no price
    ['--name', 'T', '--price', '50'], // price below 100 cents
    ['--name', 'T', '--price', '2900'], // no repo
    ['--name', 'T', '--price', '2900', '--repo', 'not-a-repo'],
  ]) {
    const res = runInit(args);
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
  }
});

// The payment link init generates is a money path, so its defaults are pinned
// here rather than left to whoever last edited the file.
//
// allow_promotion_codes must stay 'false'. A link with the promo field open is
// a live discount surface: the seller who later makes a 100%-off code to test
// delivery has handed that code's value to anyone who guesses it. We did this
// to ourselves — on 2026-07-20 two live 100%-off codes were found on our own
// checkout the day before a launch. If this assertion is failing because
// someone flipped the default back, that is the bug, not the test.
test('init: generated payment links have promotion codes OFF by default', () => {
  const { paymentLinkParams } = require('../init.js');
  const params = paymentLinkParams('price_abc', 'you/my-tool-access');
  assert.equal(params.allow_promotion_codes, 'false');
});

// The params were extracted from main() to make the above testable; this pins
// that the extraction stayed faithful, so a refactor cannot quietly drop the
// field fulfillment depends on.
test('init: payment link still carries the github_username field and the price', () => {
  const { paymentLinkParams } = require('../init.js');
  const params = paymentLinkParams('price_abc', 'you/my-tool-access');
  assert.equal(params['line_items[0][price]'], 'price_abc');
  assert.equal(params['line_items[0][quantity]'], '1');
  // fulfill.js reads the buyer's username out of this exact custom field key.
  assert.equal(params['custom_fields[0][key]'], 'github_username');
  assert.equal(params['custom_fields[0][type]'], 'text');
  assert.equal(params['after_completion[type]'], 'hosted_confirmation');
  assert.match(
    params['after_completion[hosted_confirmation][custom_message]'],
    /you\/my-tool-access/
  );
});

test('init: --flag=value is accepted, not silently discarded', () => {
  // `--price=2900` used to parse as an unknown token, so --price came back
  // undefined and init died with "--price is required" at someone who had just
  // supplied it. An error that contradicts the user's own command line is worse
  // than no error: it sends them looking in the wrong place.
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2));
  const res = runInit([`--name=My Tool`, '--price=2900', '--repo=o/r', `--config=${cfg}`,
    `--products=${path.join(dir, 'products')}`, '--dry-run']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /\$29 one-time/);
  assert.match(res.stdout, /My Tool/);
});

test('init: a typo\'d flag is named, instead of blamed on the flag it hid', () => {
  const res = runInit(['--name', 'T', '--price', '2900', '--reppo', 'o/r', '--dry-run']);
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /--reppo/, res.stderr);
  assert.doesNotMatch(res.stderr, /--repo owner\/private-product-repo is required/, res.stderr);
});

test('init: non-interactive stdin refuses loudly instead of exiting 0 having done nothing', () => {
  // spawnSync gives the child a pipe, not a TTY — the same shape as CI, a
  // devcontainer task, or `| tee init.log`. readline's callback never fires
  // there, so this used to print the prompt and exit 0 with nothing created,
  // which a scripted caller reads as success.
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2));
  const res = runInit(['--name', 'My Tool', '--price', '2900', '--repo', 'o/r',
    '--config', cfg, '--products', path.join(dir, 'products')]);
  assert.equal(res.status, 2, `expected a loud refusal, got ${res.status}: ${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /--yes|--dry-run/, res.stderr);
});

test('init: --dry-run does not demand a Stripe key it will never use', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2));
  const res = runInit(['--name', 'My Tool', '--price', '2900', '--repo', 'o/r',
    '--config', cfg, '--products', path.join(dir, 'products'), '--dry-run'],
    { STRIPE_SECRET_KEY: '' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /dry run/);
});

test('init: --dry-run=true is refused, not silently ignored', () => {
  // has() matched the exact token `--dry-run` while KNOWN_FLAGS blessed
  // `--dry-run=true` as valid, so the = spelling passed validation, evaluated
  // FALSE, and reached the live Stripe create path. A command that literally
  // says dry-run created real Products and Payment Links on the operator's
  // account; only a fake key stopped the reproduction. Found by crew-reviewer.
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2));
  for (const spelling of ['--dry-run=true', '--dry-run=false']) {
    const res = runInit(['--name', 'My Tool', '--price', '2900', '--repo', 'o/r',
      '--config', cfg, '--products', path.join(dir, 'products'), spelling, '--yes']);
    assert.equal(res.status, 2, `${spelling} should refuse, got ${res.status}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /switch and takes no value/, res.stderr);
    // The point of the test: nothing reached Stripe.
    assert.doesNotMatch(res.stderr, /v1\/products/, `${spelling} reached the Stripe API: ${res.stderr}`);
  }
});

test('init: a value flag may still use = (the switch rule is not a blanket ban)', () => {
  const dir = tmp();
  const cfg = path.join(dir, 'store.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'S', url: 'https://s.io', fulfillment: [] }, null, 2));
  const res = runInit(['--name=My Tool', '--price=2900', '--repo=o/r',
    '--config', cfg, '--products', path.join(dir, 'products'), '--dry-run'],
    { STRIPE_SECRET_KEY: '' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /dry run/);
});

test('init: a Stripe call that never answers fails with a named error, not a hang', () => {
  // Node's fetch has no overall timeout. Before this, a socket that accepted
  // the connection and then went silent left init hanging forever: no output,
  // no error, nothing telling the operator whether Stripe was down or their
  // key was wrong, on the very first command they run against their account.
  const src = fs.readFileSync(path.join(__dirname, '..', 'init.js'), 'utf8');
  const call = src.slice(src.indexOf('async function stripe('), src.indexOf('const body = await res.json()'));
  assert.match(call, /signal:\s*AbortSignal\.timeout\(/, 'the Stripe call must carry a deadline');
  assert.match(src, /no response from Stripe/, 'an aborted call must say so by name');
  // and it must not have been "fixed" by swallowing the failure
  assert.doesNotMatch(call, /catch\s*\([^)]*\)\s*\{\s*\}/, 'the catch must not be empty');
});
