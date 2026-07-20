'use strict';
// Driver-level tests for scripts/renew-invites.js with a stubbed fetch: no
// network, no live token.
//
// The one that matters most is the first. Every other test in this repo that
// touches the revocation denylist builds a state object in memory and hands it
// straight to the planner, which can only prove the planner agrees with the
// test. The ops lane shipped a planner that read `revokedAccess` while the file
// on disk said `revoked_access`: the denylist was silently empty, a refunded
// buyer was re-invited, and every unit test passed. The only thing that catches
// that is running the writer and the reader against the same real file, which
// is what the first test does.
//
// Run: node --test scripts/test/renew-invites-driver.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../renew-invites.js');
const { REINVITE_AFTER_HOURS, MAX_REINVITES, inviteKey } = require('../lib/invite-core.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-renew-'));
const REPO = 'o/r';
const stale = () => new Date(Date.now() - (REINVITE_AFTER_HOURS + 1) * 3_600_000).toISOString();

const res = (status, body = null) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// A GitHub good enough to be worth asserting against: it holds a real list of
// pending invitations and mutates it, so "the invitation was replaced" is a
// fact about the fake's state rather than a call we hoped happened.
function fakeGitHub(initial = []) {
  let invitations = [...initial];
  let nextId = 1000;
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ method, url: u });
    const inviteList = u.match(/\/repos\/([^/]+\/[^/]+)\/invitations$/);
    const inviteOne = u.match(/\/repos\/[^/]+\/[^/]+\/invitations\/(\d+)$/);
    const collab = u.match(/\/repos\/[^/]+\/[^/]+\/collaborators\/(.+)$/);
    if (method === 'GET' && inviteList) return res(200, invitations);
    if (method === 'DELETE' && inviteOne) {
      invitations = invitations.filter((i) => String(i.id) !== inviteOne[1]);
      return res(204);
    }
    if (method === 'PUT' && collab) {
      const login = decodeURIComponent(collab[1]);
      const fresh = { id: ++nextId, invitee: { login }, created_at: new Date().toISOString() };
      invitations = [...invitations, fresh];
      return res(201, fresh);
    }
    if (method === 'DELETE' && collab) return res(204);
    throw new Error(`unstubbed fetch: ${method} ${u}`);
  };
  return {
    calls,
    invitations: () => invitations,
    restore: () => { globalThis.fetch = orig; },
    putsTo: (repo = REPO) => calls
      .filter((c) => c.method === 'PUT' && c.url.includes(`/repos/${repo}/collaborators/`))
      .map((c) => decodeURIComponent(c.url.split('/collaborators/')[1])),
  };
}

// Run main() the way the workflow does: real argv, real config file, real state
// file on disk. Nothing is injected past the network boundary.
async function runMain(dir, extraArgv = [], { fetchStub = null, config = null } = {}) {
  const cfg = path.join(dir, 'store.config.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify(config || { fulfillment: [{ payment_link: 'plink_1', product: 'P', repo: REPO }] }));
  }
  const savedArgv = process.argv;
  const savedTok = process.env.GH_FULFILL_TOKEN;
  process.argv = [savedArgv[0], 'renew-invites.js',
    '--config', cfg,
    '--state', path.join(dir, 'state', 'invite-state.json'),
    ...extraArgv];
  process.env.GH_FULFILL_TOKEN = 'ghp_test_stub';
  try {
    await driver.main();
  } finally {
    process.argv = savedArgv;
    if (savedTok === undefined) delete process.env.GH_FULFILL_TOKEN;
    else process.env.GH_FULFILL_TOKEN = savedTok;
    if (fetchStub) fetchStub.restore();
  }
}

const statePath = (dir) => path.join(dir, 'state', 'invite-state.json');
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));

function captureLog() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.log = orig; } };
}
function captureErr() {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.error = orig; } };
}

test('INTEGRATION: the revocation one command writes is the one the next sweep reads, through the file', async () => {
  // This is the feature's licence to run unattended. A renewal loop that undoes
  // a refund revocation is refund fraud we would have built ourselves, and the
  // way that bug actually happens is not bad logic, it is two halves of the
  // system disagreeing about what the denylist is called. So: revoke with the
  // real command, let it write the real file, then sweep in a SEPARATE run that
  // loads that file from disk. Nothing is passed between them in memory.
  const dir = tmp();

  const gh1 = fakeGitHub([{ id: 1, invitee: { login: 'refunded' }, created_at: stale() }]);
  const out1 = captureLog();
  try {
    await runMain(dir, ['--revoke', `${REPO}:refunded`], { fetchStub: gh1 });
  } finally { out1.restore(); }
  assert.ok(out1.lines.some((l) => /revoked refunded from o\/r/.test(l)), out1.lines.join('\n'));

  // It reached disk, under a name chosen by the writer alone.
  const persisted = readState(dir);
  assert.equal(persisted.revoked_access.length, 1, `nothing was written: ${JSON.stringify(persisted)}`);
  assert.equal(persisted.revoked_access[0].key, inviteKey(REPO, 'refunded'));

  // A fresh process-equivalent run, reading only that file. Both buyers are
  // stale enough to renew; only one of them is entitled to.
  const gh2 = fakeGitHub([
    { id: 2, invitee: { login: 'waiting' }, created_at: stale() },
    { id: 3, invitee: { login: 'refunded' }, created_at: stale() },
  ]);
  const err2 = captureErr();
  const out2 = captureLog();
  try {
    await runMain(dir, [], { fetchStub: gh2 });
  } finally { out2.restore(); err2.restore(); }

  assert.deepEqual(gh2.putsTo(), ['waiting'], 'a refunded buyer must never be re-invited');
  assert.ok(
    !gh2.calls.some((c) => c.method === 'PUT' && /refunded/.test(c.url)),
    `the refunded buyer was contacted: ${JSON.stringify(gh2.calls)}`
  );
  // Held back, and visible as held back: a silent skip is how this stops being
  // auditable the day somebody asks why a buyer got nothing.
  assert.ok(out2.lines.some((l) => /1 held back \(access revoked\)/.test(l)), out2.lines.join('\n'));
  // The revocation is still on file afterwards. A one-shot denylist would let
  // the next poll through.
  assert.equal(readState(dir).revoked_access.length, 1, 'the revocation must outlive the sweep that honoured it');
});

test('INTEGRATION: revoking one product does not stop renewal on another the buyer still owns', async () => {
  const dir = tmp();
  const config = {
    fulfillment: [
      { payment_link: 'plink_1', product: 'One', repo: 'o/one' },
      { payment_link: 'plink_2', product: 'Two', repo: 'o/two' },
    ],
  };
  const gh1 = fakeGitHub([]);
  const out1 = captureLog();
  try {
    await runMain(dir, ['--revoke', 'o/one:buyer'], { fetchStub: gh1, config });
  } finally { out1.restore(); }

  const gh2 = fakeGitHub([{ id: 5, invitee: { login: 'buyer' }, created_at: stale() }]);
  const out2 = captureLog();
  try {
    await runMain(dir, [], { fetchStub: gh2, config });
  } finally { out2.restore(); }

  assert.deepEqual(gh2.putsTo('o/one'), [], 'the refunded product stays revoked');
  assert.deepEqual(gh2.putsTo('o/two'), ['buyer'], 'the product they still own is still renewed');
});

test('a stale invitation is replaced and the superseded one deleted, in that order', async () => {
  // The order is the safety argument: add first, remove second, so a crash
  // leaves a spare invitation and never a buyer with nothing.
  const dir = tmp();
  const gh = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const out = captureLog();
  try {
    await runMain(dir, [], { fetchStub: gh });
  } finally { out.restore(); }

  const mutations = gh.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}`);
  assert.deepEqual(mutations, [
    `PUT /repos/${REPO}/collaborators/buyer`,
    `DELETE /repos/${REPO}/invitations/1`,
  ], 'the new invitation must exist before the old one is removed');

  // The fake GitHub's own list is the evidence: one invitation, and not the old one.
  assert.equal(gh.invitations().length, 1);
  assert.notEqual(gh.invitations()[0].id, 1);

  const state = readState(dir);
  assert.equal(state.reinvites.length, 1);
  assert.equal(state.reinvites[0].n, 1, 'one email spent');
  assert.equal(state.reinvites[0].key, inviteKey(REPO, 'buyer'));
  assert.ok(out.lines.some((l) => /invite RENEWED for buyer on o\/r \(1\/3, invitation 1 -> \d+\); 7-day clock restarted/.test(l)), out.lines.join('\n'));
});

test('a second poll minutes later does not email the buyer again', async () => {
  // The renewed invitation reads young, so the age test alone stops it. Belt
  // and braces are both worth having here: this is the difference between a
  // rescue and a mail-bomb.
  const dir = tmp();
  const gh1 = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const out1 = captureLog();
  try { await runMain(dir, [], { fetchStub: gh1 }); } finally { out1.restore(); }
  const renewed = gh1.invitations();

  const gh2 = fakeGitHub(renewed);
  const out2 = captureLog();
  try { await runMain(dir, [], { fetchStub: gh2 }); } finally { out2.restore(); }
  assert.deepEqual(gh2.putsTo(), [], 'a freshly renewed invitation is not renewed again');
  assert.equal(readState(dir).reinvites[0].n, 1, 'still one email total');
});

test('the allowance runs out loudly, then stays quiet', async () => {
  const dir = tmp();
  const key = inviteKey(REPO, 'buyer');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify({
    revoked_access: [],
    reinvites: [{ key, n: MAX_REINVITES, last: Date.now() - 48 * 3_600_000, gave_up: false }],
  }));

  const gh = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const err = captureErr();
  try { await runMain(dir, [], { fetchStub: gh }); } finally { err.restore(); }
  assert.deepEqual(gh.putsTo(), [], 'four contacts is where we stop');
  const warn = err.lines.find((l) => l.includes('giving up'));
  assert.ok(warn, err.lines.join('\n'));
  assert.match(warn, /^WARN:/);
  assert.equal(readState(dir).reinvites[0].gave_up, true);

  const gh2 = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const err2 = captureErr();
  try { await runMain(dir, [], { fetchStub: gh2 }); } finally { err2.restore(); }
  assert.ok(!err2.lines.some((l) => l.includes('giving up')), `warned twice:\n${err2.lines.join('\n')}`);
});

test('a corrupt state file stops the run instead of reading as an empty denylist', async () => {
  // The nastiest silent failure available here: a truncated commit or a bad
  // merge leaves unparseable JSON, the loader shrugs and returns {}, and every
  // revoked buyer is renewable again. It must throw and name the file.
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(statePath(dir), '{"revoked_access": [{"key": "o/r#refunded", tru');
  const gh = fakeGitHub([{ id: 1, invitee: { login: 'refunded' }, created_at: stale() }]);
  await assert.rejects(() => runMain(dir, [], { fetchStub: gh }), /invite-state\.json/);
  assert.deepEqual(gh.putsTo(), [], 'nothing may be renewed on a state file we could not read');
});

test('an invitation accepted between the read and the renewal is not double counted', async () => {
  const dir = tmp();
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ method, url: u });
    if (method === 'GET') return res(200, [{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
    if (method === 'PUT') return res(204); // already a collaborator
    return res(204);
  };
  const out = captureLog();
  try {
    await runMain(dir, [], { fetchStub: { restore: () => { globalThis.fetch = orig; } } });
  } finally { out.restore(); }
  assert.ok(out.lines.some((l) => /already a collaborator, nothing to renew/.test(l)), out.lines.join('\n'));
  assert.deepEqual(readState(dir).reinvites, [], 'a buyer who got in starts from a clean sheet');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'nothing to delete: we did not create an invitation');
});

test('a GitHub refusal costs no allowance but does buy a day of quiet', async () => {
  const dir = tmp();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET') return res(200, [{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
    return res(403, { message: 'Forbidden' });
  };
  const err = captureErr();
  try {
    await runMain(dir, [], { fetchStub: { restore: () => { globalThis.fetch = orig; } } });
  } finally { err.restore(); }
  const warn = err.lines.find((l) => l.includes('failed'));
  assert.ok(warn, err.lines.join('\n'));
  assert.match(warn, /^WARN:/);
  assert.match(warn, /GitHub returned 403/);
  assert.match(warn, /still expires on its original schedule/, 'do not imply the buyer is fine');
  const rec = readState(dir).reinvites[0];
  assert.equal(rec.n, 0, 'no email went out, so nothing was spent');
  assert.ok(rec.last > 0, 'but a repo that refuses us must not be retried on every poll');
});

test('a deleted GitHub account is terminal, not retried daily forever', async () => {
  const dir = tmp();
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET') return res(200, [{ id: 1, invitee: { login: 'ghost' }, created_at: stale() }]);
    return res(404, { message: 'Not Found' });
  };
  const err = captureErr();
  try {
    await runMain(dir, [], { fetchStub: { restore: () => { globalThis.fetch = orig; } } });
  } finally { err.restore(); }
  const warn = err.lines.find((l) => l.includes('giving up'));
  assert.ok(warn, err.lines.join('\n'));
  assert.match(warn, /GitHub no longer knows that account/);
  assert.equal(readState(dir).reinvites[0].gave_up, true);
});

test('state survives a repo that throws halfway through the sweep', async () => {
  // Two product repos, the second one broken. The emails already sent against
  // the first must be on disk afterwards, or the next poll sends them again.
  const dir = tmp();
  const config = {
    fulfillment: [
      { payment_link: 'plink_1', product: 'One', repo: 'o/one' },
      { payment_link: 'plink_2', product: 'Two', repo: 'o/two' },
    ],
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/repos/o/two/')) throw new Error('network is on fire');
    if (method === 'GET') return res(200, [{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
    if (method === 'PUT') return res(201, { id: 77, invitee: { login: 'buyer' }, created_at: new Date().toISOString() });
    return res(204);
  };
  const err = captureErr();
  const out = captureLog();
  try {
    await assert.rejects(() => runMain(dir, [], { fetchStub: { restore: () => { globalThis.fetch = orig; } }, config }), /on fire/);
  } finally { out.restore(); err.restore(); }
  const state = readState(dir);
  assert.equal(state.reinvites.length, 1, 'the email sent before the failure must be recorded');
  assert.equal(state.reinvites[0].key, inviteKey('o/one', 'buyer'));
  assert.equal(state.reinvites[0].n, 1);
});

test('--dry-run reports what it would do and touches nothing', async () => {
  const dir = tmp();
  const gh = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const out = captureLog();
  try { await runMain(dir, ['--dry-run'], { fetchStub: gh }); } finally { out.restore(); }
  assert.ok(out.lines.some((l) => /DRY RUN: would renew buyer on o\/r \(attempt 1\/3\)/.test(l)), out.lines.join('\n'));
  assert.ok(!gh.calls.some((c) => c.method !== 'GET'), `a dry run must not mutate: ${JSON.stringify(gh.calls)}`);
  assert.deepEqual(readState(dir).reinvites, [], 'and must not spend the allowance');
});

test('renewal needs the GitHub token and nothing else', async () => {
  // Least privilege is a shipped promise: this step never reads money, so a
  // seller must not have to hand it a Stripe key. If that ever changes, the
  // secrets in the workflow template and least-privilege.md go stale with it.
  const dir = tmp();
  const savedStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const gh = fakeGitHub([{ id: 1, invitee: { login: 'buyer' }, created_at: stale() }]);
  const out = captureLog();
  try {
    await runMain(dir, [], { fetchStub: gh });
  } finally {
    out.restore();
    if (savedStripe !== undefined) process.env.STRIPE_SECRET_KEY = savedStripe;
  }
  assert.deepEqual(gh.putsTo(), ['buyer']);
  assert.ok(!gh.calls.some((c) => c.url.includes('stripe.com')), 'renewal must never call Stripe');
});

test('--revoke refuses anything it cannot parse rather than guessing', async () => {
  for (const bad of ['nocolon', 'notarepo:buyer', 'o/r:has--double', 'o/r:', 'o/r:-lead', '../../etc:buyer']) {
    assert.throws(() => driver.parseRevokeTarget(bad), /--revoke/, bad);
  }
  assert.deepEqual(driver.parseRevokeTarget('o/r:octocat'), { repo: 'o/r', login: 'octocat' });
  assert.deepEqual(driver.parseRevokeTarget('Honorboxx/honorbox-pro:Octo-Cat'), { repo: 'Honorboxx/honorbox-pro', login: 'Octo-Cat' });
});
