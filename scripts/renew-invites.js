#!/usr/bin/env node
// HonorBox invitation renewal.
//
// GitHub expires an unaccepted repository invitation seven days after it is
// created. A buyer who paid, got the invite, and never opened the email is
// indistinguishable from a delivered sale until that moment, and then they have
// nothing. This re-issues the invitation before the clock runs out, which
// restarts it, so the door stays open until the buyer walks through it or we
// run out of polite ways to ask (three renewals, then it says so and stops).
//
// Runs as a step inside the fulfillment workflow rather than on a schedule of
// its own: a private-repo Actions job is billed rounded up to a whole minute,
// so sharing the poll's job costs nothing at all, while a second cron would
// cost a minute every time it fired. See docs/setup.md section 6.
//
// It is deliberately separate from fulfill.js. Fulfillment's contract is
// "one paid session, one invite, exactly once" and its state is a session
// cursor; renewal's contract is "a pending invitation stays alive" and its
// state is a per-buyer email allowance. Different clocks, different state, and
// keeping them in different files means a change here can never regress
// one-time delivery.
//
// Env:  GH_FULFILL_TOKEN  (required: token with admin on the product repos)
//       No Stripe key. Renewal never looks at money, so it never holds the key.
//
// Usage: node scripts/renew-invites.js --config store.config.json \
//          --state state/invite-state.json
//        node scripts/renew-invites.js --revoke owner/repo:username
//        (add --dry-run to see what it would do without emailing anyone)
'use strict';

const fs = require('fs');
const path = require('path');
const { validUsername, REQUEST_TIMEOUT_MS } = require('./lib/fulfill-core.js');
const {
  REVOKED_FIELD,
  REINVITES_FIELD,
  MAX_REINVITES,
  REINVITE_AFTER_HOURS,
  inviteKey,
  recordRevocation,
  planInviteActions,
  recordReinvite,
  forgetReinvites,
  reinviteAlertLines,
} = require('./lib/invite-core.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; } // no file yet: fresh install
  // A corrupt state file must stop the run, not silently reset. An empty
  // reinvites list costs a buyer a duplicate email; an empty revocation list
  // re-invites somebody who was refunded.
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Fresh install shape. Named through the lib's constants so the loader and the
// planner cannot drift apart on a rename.
function emptyState() {
  return { [REVOKED_FIELD]: [], [REINVITES_FIELD]: [] };
}

function loadState(file) {
  const state = readJson(file, emptyState());
  for (const k of [REVOKED_FIELD, REINVITES_FIELD]) {
    if (!Array.isArray(state[k])) state[k] = [];
  }
  return state;
}

async function ghRequest(method, pathname, token, body) {
  return fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'honorbox-renew',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    // Node's fetch has no overall request timeout; without a deadline one
    // unresponsive socket holds the whole Actions job open.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function gh(method, pathname, token, body) {
  const res = await ghRequest(method, pathname, token, body);
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`GitHub ${method} ${pathname} -> ${res.status}`);
  return res.json();
}

// Re-issue one buyer's invitation, restarting GitHub's seven-day clock.
//
// The order is the whole safety argument. We ADD first and only then remove the
// invitation we superseded, never the other way round. Deleting first would
// open a window, however short, in which the buyer has no invitation and
// nothing on GitHub or in our state says they should: a crash there would turn
// the silent permanent loss this exists to prevent into one we caused
// ourselves. With this order the worst a crash can leave behind is a spare
// pending invitation, which is untidy, harmless, and swept up next run.
//
// It also means we do not have to know in advance what GitHub does when you
// re-add a collaborator who already has an invitation pending. We read the
// answer out of the response instead: a different id means a new invitation, a
// later created_at means it was refreshed in place, and neither means the call
// did nothing and a human needs to know.
async function renewInvite(state, r, token, flush) {
  // The login comes from GitHub's own payload, so this should never fire. It is
  // here because the value is about to be interpolated into a URL path and
  // "should never" is not an access-control argument.
  if (!validUsername(r.login)) {
    state[REINVITES_FIELD] = recordReinvite(state[REINVITES_FIELD], r.key, { gaveUp: true });
    console.error(
      `WARN: refusing to re-invite ${JSON.stringify(r.login)} on ${r.repo}: not a valid GitHub username; ` +
        'invite them by hand or refund them'
    );
    return;
  }
  const wasCreated = Date.parse(r.inv.created_at);
  const res = await ghRequest('PUT', `/repos/${r.repo}/collaborators/${encodeURIComponent(r.login)}`, token, { permission: 'pull' });

  // 204: they accepted between our read of the list and this call. Nothing to
  // renew, and the allowance is dropped so a later product or a later lapse
  // starts fresh.
  if (res.status === 204) {
    state[REINVITES_FIELD] = forgetReinvites(state[REINVITES_FIELD], r.key);
    console.log(`invite ${r.login} on ${r.repo}: already a collaborator, nothing to renew`);
    return;
  }

  // 404: there is no such account any more, so this buyer cannot be reached at
  // this username by us or by anyone. Retrying that daily forever is noise, so
  // it is terminal and goes straight to the seller.
  if (res.status === 404) {
    state[REINVITES_FIELD] = recordReinvite(state[REINVITES_FIELD], r.key, { gaveUp: true });
    console.error(
      `WARN: giving up on re-inviting ${r.login} to ${r.repo}: GitHub no longer knows that account ` +
        '(renamed or deleted); check the username they gave at checkout, or refund them'
    );
    return;
  }

  if (res.status !== 201) {
    // Transient or fixable (a rate limit, a token that lost admin). No email
    // went out, so the allowance is untouched; `last` still moves, so a repo
    // that refuses us costs one call a day rather than one per poll. There is
    // no in-run retry here on purpose: renewal has a 24-hour margin and dozens
    // of polls left to succeed in, so waiting inside the job would spend the
    // seller's Actions minutes to buy time we already have.
    state[REINVITES_FIELD] = recordReinvite(state[REINVITES_FIELD], r.key);
    console.error(
      `WARN: re-invite of ${r.login} on ${r.repo} failed: GitHub returned ${res.status}; ` +
        'their invitation still expires on its original schedule'
    );
    return;
  }

  const fresh = await res.json().catch(() => null);
  state[REINVITES_FIELD] = recordReinvite(state[REINVITES_FIELD], r.key, { sent: true });
  if (flush) flush(); // an email has now been sent; make that survive a crash
  const newId = fresh && fresh.id;
  const newCreated = Date.parse(fresh && fresh.created_at);

  if (newId != null && newId !== r.inv.id) {
    // Best effort: a 404 here just means GitHub already retired the old row.
    await gh('DELETE', `/repos/${r.repo}/invitations/${r.inv.id}`, token).catch(() => {});
    console.log(`invite RENEWED for ${r.login} on ${r.repo} (${r.attempt}/${MAX_REINVITES}, invitation ${r.inv.id} -> ${newId}); 7-day clock restarted`);
    return;
  }
  if (Number.isFinite(newCreated) && Number.isFinite(wasCreated) && newCreated > wasCreated) {
    console.log(`invite RENEWED in place for ${r.login} on ${r.repo} (${r.attempt}/${MAX_REINVITES}); 7-day clock restarted`);
    return;
  }
  if (newId == null && !Number.isFinite(newCreated)) {
    // 201 with a body we could not read. GitHub documents 201 as "Response when
    // a new invitation is created", so this is far more likely a renewal that
    // worked than one that did nothing, and it is logged rather than alerted: a
    // warning nobody can act on is how a log stops being read.
    console.log(`invite renewed for ${r.login} on ${r.repo} (${r.attempt}/${MAX_REINVITES}); GitHub returned 201 with no readable invitation body`);
    return;
  }
  // GitHub accepted the call and changed nothing. Renewal does not work the way
  // this code believes it does, which is worth saying loudly exactly once per
  // attempt rather than reporting a renewal that did not happen.
  console.error(
    `WARN: re-invite of ${r.login} on ${r.repo} did not restart the clock ` +
      `(invitation ${r.inv.id} still reads created ${r.inv.created_at}); invite them by hand before it expires`
  );
}

// Take access away and write it down so renewal can never hand it back.
//
// The free engine has no refund guard (that is Pro's), so a seller refunding a
// buyer does it here. Recording BEFORE acting is the same argument the record
// itself exists for: the worst a crash mid-revocation can leave behind is a
// buyer who still has access and will never be auto-renewed. Recording last
// would leave the opposite, access removed with no record, and the next poll
// cheerfully re-inviting them.
async function revokeAccess(state, repo, login, token, { dryRun = false } = {}) {
  state[REVOKED_FIELD] = recordRevocation(state[REVOKED_FIELD], repo, login);
  state[REINVITES_FIELD] = forgetReinvites(state[REINVITES_FIELD], inviteKey(repo, login));
  if (dryRun) {
    console.log(`DRY RUN: would revoke ${login} from ${repo} and delete their pending invitations`);
    return;
  }
  await gh('DELETE', `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, token);
  const invitations = (await gh('GET', `/repos/${repo}/invitations`, token)) || [];
  for (const inv of Array.isArray(invitations) ? invitations : []) {
    if (inv && inv.invitee && String(inv.invitee.login).toLowerCase() === login.toLowerCase()) {
      await gh('DELETE', `/repos/${repo}/invitations/${inv.id}`, token);
    }
  }
  console.log(`revoked ${login} from ${repo}: collaborator removed, pending invitations deleted, renewal blocked`);
}

// "owner/repo:username". Both halves are validated before either reaches a URL
// path, and an unparseable argument is refused rather than guessed at: this
// command removes somebody's access.
function parseRevokeTarget(raw) {
  const at = String(raw).lastIndexOf(':');
  if (at === -1) throw new Error(`--revoke wants "owner/repo:username", got ${JSON.stringify(raw)}`);
  const repo = String(raw).slice(0, at);
  const login = String(raw).slice(at + 1);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`--revoke: ${JSON.stringify(repo)} is not a valid "owner/repo"`);
  }
  if (!validUsername(login)) {
    throw new Error(`--revoke: ${JSON.stringify(login)} is not a valid GitHub username`);
  }
  return { repo, login };
}

async function sweepRepo(state, repo, token, { now = Date.now(), dryRun = false, flush = null } = {}) {
  const invitations = (await gh('GET', `/repos/${repo}/invitations`, token)) || [];
  // If this ever stops being a list, the planner would quietly see "no
  // invitations" and report a clean sweep forever. Say so instead: a guard that
  // cannot read its input must not claim everything is fine.
  if (!Array.isArray(invitations)) {
    console.error(`WARN: renewal read a non-list of invitations for ${repo} (${typeof invitations}); nothing was renewed on this repo`);
    return;
  }

  const plan = planInviteActions(repo, invitations, state, { now });
  for (const line of reinviteAlertLines(repo, plan)) console.error(line);
  for (const g of plan.giveUp) {
    state[REINVITES_FIELD] = recordReinvite(state[REINVITES_FIELD], g.key, { gaveUp: true });
  }

  if (dryRun) {
    for (const r of plan.reinvite) console.log(`DRY RUN: would renew ${r.login} on ${repo} (attempt ${r.attempt}/${MAX_REINVITES})`);
    for (const c of plan.cleanup) console.log(`DRY RUN: would delete resurrected invitation ${c.inv.id} for ${c.login} on ${repo}`);
    for (const s of plan.superseded) console.log(`DRY RUN: would delete superseded duplicate invitation ${s.inv.id} for ${s.login} on ${repo}`);
  } else {
    // Undo our own resurrection of revoked access before doing anything else
    // that might add more of it.
    for (const c of plan.cleanup) {
      await gh('DELETE', `/repos/${repo}/invitations/${c.inv.id}`, token).catch((e) =>
        console.error(`WARN: could not delete resurrected invitation ${c.inv.id} on ${repo}: ${e.message}`)
      );
      state[REINVITES_FIELD] = forgetReinvites(state[REINVITES_FIELD], c.key);
    }
    // Litter from a crash between our add and our remove. Deleting it sends no
    // email and costs the buyer nothing; leaving it would double every future
    // renewal for that buyer.
    for (const s of plan.superseded) {
      await gh('DELETE', `/repos/${repo}/invitations/${s.inv.id}`, token).catch(() => {});
      console.log(`invites ${repo}: removed superseded duplicate invitation ${s.inv.id} for ${s.login}`);
    }
    for (const r of plan.reinvite) {
      // One buyer's renewal must never take out the buyers behind them.
      await renewInvite(state, r, token, flush).catch((e) =>
        console.error(`WARN: re-invite of ${r.login} on ${repo} failed: ${e.message}`)
      );
    }
  }

  // Inventory, not an alert: a quiet count so the log shows what is in flight
  // without waking anyone for a buyer who is simply still asleep.
  if (invitations.length) {
    const held = plan.blocked.length ? `, ${plan.blocked.length} held back (access revoked)` : '';
    console.log(`invites ${repo}: ${invitations.length} pending, renewal at ${REINVITE_AFTER_HOURS}h${held}`);
  }
}

async function main() {
  const token = process.env.GH_FULFILL_TOKEN;
  if (!token) {
    console.error('Missing GH_FULFILL_TOKEN');
    process.exit(2);
  }

  const configPath = arg('config', 'store.config.json');
  const statePath = arg('state', 'state/invite-state.json');
  const dryRun = flag('dry-run');

  const config = readJson(configPath, null);
  if (!config || !Array.isArray(config.fulfillment) || config.fulfillment.length === 0) {
    console.error(`No fulfillment grants configured in ${configPath}`);
    process.exit(2);
  }
  const repos = [...new Set(config.fulfillment.map((g) => g && g.repo).filter(Boolean))];

  const state = loadState(statePath);
  // An email that went out is a fact about the world. Get it onto disk the
  // moment it happens, so a crash on the next repo cannot make us send it again.
  const flush = () => writeJson(statePath, state);

  try {
    const revoke = arg('revoke', null);
    if (revoke) {
      const { repo, login } = parseRevokeTarget(revoke);
      if (!repos.includes(repo)) {
        console.error(`WARN: ${repo} is not a product repo in ${configPath}; revoking anyway, but check the spelling`);
      }
      await revokeAccess(state, repo, login, token, { dryRun });
      return;
    }

    for (const repo of repos) {
      await sweepRepo(state, repo, token, { dryRun, flush });
    }
    console.log(`renewal done. repos=${repos.length} tracked=${state[REINVITES_FIELD].length} revoked=${state[REVOKED_FIELD].length}${dryRun ? ' (dry run)' : ''}`);
  } finally {
    // Always, including on the way out of a failure: state that records emails
    // already sent and access already revoked must not be lost because a later
    // repo threw.
    writeJson(statePath, state);
  }
}

module.exports = { readJson, loadState, gh, ghRequest, renewInvite, revokeAccess, parseRevokeTarget, sweepRepo, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
