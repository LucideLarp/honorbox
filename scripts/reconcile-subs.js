#!/usr/bin/env node
// HonorBox subscription reconciler.
//
// Keeps repo access in step with subscription status: invites customers whose
// subscription entitles them, and removes those whose subscription has ended
// and whose grace period has run out. Opt-in, and reporting-only until armed.
//
// This is deliberately a SEPARATE program from fulfill.js. Delivery and
// enforcement have opposite risk profiles: delivery must be fast and can safely
// repeat, enforcement must be slow and must never repeat a mistake. Keeping
// them apart means a crash, a hang or a bug in here cannot delay a single
// delivery, and it means "one-time selling is completely unaffected" is
// provable with `git diff --exit-code scripts/fulfill.js` rather than argued.
//
// Env:  STRIPE_SECRET_KEY  (required)
//       GH_FULFILL_TOKEN   (required: token with admin on the product repos)
// Usage: node scripts/reconcile-subs.js --config store.config.json \
//          --state state/subscriptions.json
'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_GRACE_DAYS,
  desiredEntitlements,
  diffEntitlements,
  breakerVerdict,
  revokeLine,
  breakerLine,
  sweepLine,
  upcomingRevocations,
  upcomingLine,
  subscriptionConfigProblems,
  grantKey,
  normalizeUser,
} = require('./lib/subs-core.js');
const { recordRevocation, revocationFor, revocationSource, clearLapse, inviteKey } = require('./lib/access-record.js');
const { REQUEST_TIMEOUT_MS, validUsername, extractGithubUsername, inviteStatusHint } = require('./lib/fulfill-core.js');

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STRIPE_RETRY_DELAYS_MS = [500, 2_000];

// Sessions are re-scanned from a cursor so the subscription-to-username map
// fills in incrementally instead of walking every session ever sold on each
// pass. Same 25h overlap reasoning as the engine: wider than a session's 24h
// life, and a re-scan is free because the map is keyed by subscription id.
const OVERLAP_SECONDS = 25 * 3600;

// Reconciliation must not run at delivery cadence. A full enumeration of every
// subscription every two minutes is wasteful at ten customers and a rate-limit
// problem at five thousand, and there is nothing to gain: grace is measured in
// days, so a revocation is never urgent. Enforced from state rather than by
// trusting the scheduler, so a misconfigured cron cannot make this a hot loop.
const MIN_PASS_INTERVAL_MS = 60 * 60 * 1000;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// --- one runner at a time ----------------------------------------------------
// The scheduled pass and a hand-run --force can start in the same second. Both
// would then read the same state, compute the same revocations, act on both of
// them, and write the SHARED revocation record: whichever finishes last
// overwrites the other's entry, so somebody we removed has no record saying so.
// The invitation renewal sweep treats that record as absolute, so it invites
// them straight back in. The two lanes are each correct and the pair is not,
// which is precisely the class of bug that only shows up in production.
//
// `wx` makes the create atomic, so the winner is decided by the filesystem
// rather than by a read-then-write nobody can make safe. Age comes from mtime
// rather than the file's contents, because a corrupt lock must not be able to
// wedge enforcement shut: a lock is evidence of a live pass only while it is
// young enough to be one.
const LOCK_MAX_AGE_MS = 30 * 60 * 1000;

function acquireLock(lockPath, now) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + '\n', { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try { age = now - fs.statSync(lockPath).mtimeMs; } catch { continue; } // released under us, retry
      if (age < LOCK_MAX_AGE_MS) return false;
      // Read defensively and never through readJson, which throws on unparseable
      // content by design. The pid is a courtesy to whoever reads the log; a
      // truncated lock file must not be able to crash the pass that is trying to
      // clear it, which is the wedge this whole branch exists to prevent.
      let pid = 'unknown';
      try { pid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid ?? 'unknown'; } catch { /* informational only */ }
      console.error(
        `WARN: breaking a subscription reconciler lock ${Math.round(age / 60000)}m old ` +
          `(pid ${pid}). A pass was killed before it could finish, or one has hung. ` +
          `Nothing was lost: the next pass recomputes everything from Stripe`
      );
      try { fs.unlinkSync(lockPath); } catch { /* another runner broke it first */ }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone, nothing to undo */ }
}

async function stripeGet(pathname, params, key, sleep = defaultSleep) {
  const url = new URL(`https://api.stripe.com${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(key + ':').toString('base64')}`, 'Stripe-Version': '2024-06-20' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= STRIPE_RETRY_DELAYS_MS.length) throw err;
      console.error(`RETRY Stripe ${pathname} after ${err.name}: ${err.message}`);
      await sleep(STRIPE_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= STRIPE_RETRY_DELAYS_MS.length) {
      throw new Error(`Stripe ${pathname} -> ${res.status}: ${await res.text()}`);
    }
    console.error(`RETRY Stripe ${pathname} -> ${res.status} (attempt ${attempt + 1})`);
    await sleep(STRIPE_RETRY_DELAYS_MS[attempt]);
  }
}

// Enumerate EVERY subscription, in every state.
//
// `status=all` is mandatory and is the trap in this endpoint: Stripe's
// documented default is "all subscriptions that have not been canceled", which
// silently omits exactly the population we need to see. Without it the
// reconciler would find nothing to revoke and report a clean pass forever.
//
// Any error at all propagates and aborts the pass. Partial data is
// indistinguishable from cancellation: half a page missing looks exactly like
// half the customers having quit. Grants may proceed on partial data because
// granting is safe. Revocation may not.
async function listAllSubscriptions(key, sleep = defaultSleep) {
  const subs = [];
  let startingAfter = null;
  for (;;) {
    const params = { limit: '100', status: 'all' };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeGet('/v1/subscriptions', params, key, sleep);
    if (!Array.isArray(page.data)) {
      throw new Error('Stripe /v1/subscriptions returned no data array, refusing to reconcile on an unreadable response');
    }
    subs.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = nextCursor(page, '/v1/subscriptions');
  }
  return subs;
}

// The id to page from, or an error.
//
// Cursor pagination asks for "everything after this id". If the last row of a
// page carries no id there is nothing to ask from, and the natural shape of the
// loop is to send the same request again, receive the same page, and do it
// forever: a reconciler that never exits, holds its lock, and enumerates the
// payment processor in a tight loop while looking like a long-running pass.
// A response we cannot page through is a response we do not understand, and the
// only safe reading of that is to stop.
function nextCursor(page, label) {
  const last = page.data[page.data.length - 1];
  const id = last && last.id;
  if (typeof id !== 'string' || !id) {
    throw new Error(`Stripe ${label} says there are more pages but the last row has no id, so it cannot be paged; refusing to loop`);
  }
  return id;
}

// Learn which GitHub username belongs to which subscription. The username is
// buyer-supplied text on the Checkout Session, so this walks sessions created
// since the cursor and remembers the mapping. A pass that cannot read sessions
// still reconciles from what it already knows.
async function learnUsernames(sinceTs, key, sleep = defaultSleep) {
  const map = {};
  let newest = sinceTs;
  let startingAfter = null;
  for (;;) {
    const params = { limit: '100', 'created[gt]': String(Math.max(0, sinceTs - OVERLAP_SECONDS)) };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeGet('/v1/checkout/sessions', params, key, sleep);
    // Refused for the same reason the subscription list refuses: a response we
    // cannot read is not a store with no new customers. Reading it as one means
    // somebody who subscribed a minute ago is never matched to their GitHub
    // username, never gets access, and the pass reports a clean run over it.
    if (!Array.isArray(page.data)) {
      throw new Error('Stripe /v1/checkout/sessions returned no data array, refusing to reconcile on an unreadable response');
    }
    for (const s of page.data) {
      newest = Math.max(newest, s.created || 0);
      if (!s.subscription) continue;
      const u = extractGithubUsername(s);
      if (validUsername(u)) map[s.subscription] = u;
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = nextCursor(page, '/v1/checkout/sessions');
  }
  return { map, cursor: newest };
}

async function gh(method, pathname, token, body) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'honorbox-subs',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res;
}

async function invite(repo, user, token) {
  const res = await gh('PUT', `/repos/${repo}/collaborators/${encodeURIComponent(user)}`, token, { permission: 'pull' });
  if (res.status === 201 || res.status === 204) return res.status;
  throw new Error(`invite ${repo} <- ${user} -> ${res.status}${inviteStatusHint(res.status)}`);
}

// Every pending invitation on a repo, not just the first page.
//
// GitHub returns 30 per page and paginates the rest. Removing a collaborator
// does not cancel an invitation they have not accepted, so an invitation this
// sweep fails to see stays live and acceptable: the customer we just revoked
// clicks the email a week later and is back in. A store holding more than one
// page of unaccepted invitations is ordinary, which puts the lapsed customer
// past the boundary on nothing more than alphabetical luck.
//
// Reading one page and calling it the whole list is the same mistake that has
// now bitten this codebase three times: absent from the part we looked at is
// not absent. Returns null when the list could not be read, so the caller can
// say so rather than treat a failure as "no invitations pending".
const INVITE_PER_PAGE = 100;

async function listInvitations(repo, token) {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await gh('GET', `/repos/${repo}/invitations?per_page=${INVITE_PER_PAGE}&page=${page}`, token);
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    all.push(...rows);
    if (rows.length < INVITE_PER_PAGE) break;
  }
  return all;
}

// Remove a collaborator and every invitation they have not accepted yet.
//
// A 404 on the removal is not an error to retry: nobody by that name is a
// collaborator. It is reported as unconfirmed rather than as a completed
// revocation, because it is also what a renamed GitHub account looks like.
// Returns { confirmed } so the caller can log the difference.
async function revoke(repo, user, token) {
  const res = await gh('DELETE', `/repos/${repo}/collaborators/${encodeURIComponent(user)}`, token);
  if (!res.ok && res.status !== 404) {
    throw new Error(`revoke ${repo} -> ${user} -> ${res.status}${inviteStatusHint(res.status)}`);
  }
  const invitations = await listInvitations(repo, token);
  if (invitations == null) {
    console.error(
      `WARN: removed ${user} from ${repo} but could not read its invitation list, so a pending ` +
        `invitation may still be live and acceptable. Check: gh api repos/${repo}/invitations`
    );
  } else {
    for (const inv of invitations) {
      if (inv && inv.invitee && normalizeUser(inv.invitee.login) === normalizeUser(user)) {
        await gh('DELETE', `/repos/${repo}/invitations/${inv.id}`, token);
      }
    }
  }
  return { status: res.status, confirmed: res.status !== 404 };
}

async function main(sleep = defaultSleep) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const ghToken = process.env.GH_FULFILL_TOKEN;
  if (!stripeKey || !ghToken) {
    console.error('Missing STRIPE_SECRET_KEY or GH_FULFILL_TOKEN');
    process.exit(2);
  }

  const configPath = arg('config', 'store.config.json');
  const statePath = arg('state', 'state/subscriptions.json');
  // The revocation denylist is NOT kept in this program's own state file. It
  // lives with the refund guard's, because "has this person's access been
  // deliberately removed" must have exactly one answer: the invitation renewal
  // sweep reads that one list, and a second list it did not know about would be
  // a lapsed customer getting cheerfully re-invited by the other lane.
  const botsStatePath = arg('bots-state', 'state/bots-state.json');
  const config = readJson(configPath, null) || {};
  const subsConfig = config.subscriptions;

  // Off by default, and off means genuinely nothing: no Stripe call, no state
  // file, no behaviour change of any kind for a store that sells one-time.
  if (subsConfig == null) {
    console.log('subscriptions: not configured, nothing to reconcile');
    return;
  }
  for (const problem of subscriptionConfigProblems(subsConfig)) console.error(`CONFIG ${problem}`);

  const grants = Array.isArray(config.fulfillment) ? config.fulfillment : [];
  const knownRepos = new Set(grants.map((g) => g && g.repo).filter(Boolean).map((r) => String(r).toLowerCase()));
  const enforce = subsConfig.enforce === true;
  const graceDays = typeof subsConfig.grace_days === 'number' && subsConfig.grace_days >= 0 && subsConfig.grace_days <= 90
    ? subsConfig.grace_days
    : DEFAULT_GRACE_DAYS;

  const state = readJson(statePath, null) || { version: 1, cursor: 0, grants: {}, breaker: { tripped_at: null, would_revoke: [] } };
  state.grants = state.grants || {};
  state.breaker = state.breaker || { tripped_at: null, would_revoke: [] };
  state.users = state.users || {};

  const now = Date.now();
  // The later of the two, because a pass that FAILED still cost a full
  // enumeration and still must back off. Gating on success alone means a
  // persistently failing pass never advances the clock and runs on every tick.
  const lastTouch = Math.max(Date.parse(state.last_pass || 0) || 0, Date.parse(state.last_attempt || 0) || 0);
  const sinceLast = lastTouch ? now - lastTouch : Infinity;
  if (sinceLast < MIN_PASS_INTERVAL_MS && !process.argv.includes('--force')) {
    console.log(`subscriptions: last pass ${Math.round(sinceLast / 60000)}m ago, skipping (min interval 60m; --force overrides)`);
    return;
  }

  // Nothing below this point may run twice at once. See acquireLock.
  const lockPath = `${statePath}.lock`;
  if (!acquireLock(lockPath, now)) {
    console.log('subscriptions: another reconciler pass is already running, skipping this one');
    return;
  }

  // The attempt is recorded BEFORE any network call, and the interval gate
  // above reads it. Without this a pass that throws every time never advances
  // last_pass, so a persistent Stripe failure turns the scheduler into a hot
  // loop: a full enumeration of every subscription on every tick, each one
  // failing. Grace is measured in days, so backing a broken pass off by an
  // hour costs nothing and a retry storm against the payment processor does.
  state.last_attempt = new Date(now).toISOString();
  writeJson(statePath, state);

  try {
    const subs = await listAllSubscriptions(stripeKey, sleep);
    const learned = await learnUsernames(state.cursor || 0, stripeKey, sleep);
    Object.assign(state.users, learned.map);
    state.cursor = Math.max(state.cursor || 0, learned.cursor || 0);

    const { desired, heldSubs, heldPairs, notes } = desiredEntitlements(subs, state.users, grants);
    for (const n of notes) console.error(`WARN: subscription ${n.sub}: ${n.message}`);

    // Stripe's dunning can be set to leave a failed subscription past_due
    // forever. past_due is a permanent HOLD for us, correctly, but that means a
    // seller on that setting never sees a single revocation. Detect the symptom
    // rather than the setting: past due beyond the longest possible retry window
    // (2 months) proves Stripe has stopped retrying. Say so. Never revoke on it.
    const PAST_DUE_MAX_RETRY_MS = 62 * 86_400_000;
    for (const s of subs) {
      if (s.status !== 'past_due') continue;
      const started = (s.current_period_end || s.created || 0) * 1000;
      if (started && now - started > PAST_DUE_MAX_RETRY_MS) {
        console.error(
          `WARN: subscription ${s.id} has been past_due for over two months, so Stripe has stopped retrying it. ` +
            `Access is being KEPT because a past-due customer is never treated as cancelled. If you want these to ` +
            `end, set your Stripe Billing failed-payment setting to cancel or mark unpaid instead of "leave past-due"`
        );
      }
    }

    const diff = diffEntitlements(desired, state.grants, { graceDays, now, knownRepos, heldSubs, heldPairs });

    // Grants first, and never gated by the breaker. A tripped breaker means "do
    // not take anything away". It must never mean "stop letting customers in".
    for (const g of diff.grants) {
      try {
        const code = await invite(g.repo, g.user, ghToken);

        // They are back in, so stop blocking their invitation renewals, but only
        // if the block was ours. A 'lapse' is a subscription we enforced and a
        // new subscription answers it. A 'refund' is not ours to reverse: a
        // refunded buyer whose subscription is live again gets their invitation
        // and it works, it simply is not auto-renewed. The asymmetry is
        // deliberate, because the two costs are not comparable. Cleared AFTER the
        // invite, so a failed invite leaves the block intact.
        const botsNow = readJson(botsStatePath, null) || {};
        const existing = revocationFor(botsNow.revoked_access, inviteKey(g.repo, g.user));
        if (existing && revocationSource(existing) === 'lapse') {
          botsNow.revoked_access = clearLapse(botsNow.revoked_access, g.repo, g.user);
          writeJson(botsStatePath, botsNow);
          console.log(`restored ${g.user} on ${g.repo}: subscribed again, the lapse block is cleared`);
        } else if (existing) {
          console.error(
            `WARN: ${g.user} is entitled again on ${g.repo} (subscription ${g.sub}) but was previously ` +
              `revoked after a REFUND, so that block stays. Their invitation works, it just will not be ` +
              `auto-renewed if it expires unaccepted. If this is a legitimate return, clear their entry ` +
              `from revoked_access in ${botsStatePath}`
          );
        }
        state.grants[grantKey(g.repo, g.user)] = {
          sub: g.sub, repo: g.repo, user: g.user,
          granted_at: new Date(now).toISOString(),
          invited_at: new Date(now).toISOString(),
          lapsed_since: null, suppressed: null,
        };
        console.log(`granted ${g.user} -> ${g.repo} (subscription ${g.sub} ${g.reason}, HTTP ${code})`);
      } catch (err) {
        console.error(`FAILED grant ${g.user} -> ${g.repo}: ${err.message}`);
      }
    }

    // Someone entitled again: clear the clock rather than leaving it to expire.
    for (const k of diff.keep) {
      state.grants[k.key].lapsed_since = null;
      console.log(`recovered ${k.user} on ${k.repo}: entitled again, lapse cleared`);
    }

    // A customer who re-subscribed is entitled by a different subscription than
    // the one on their record. Re-point the record so later logs name the
    // subscription the seller can actually look up.
    for (const r of diff.refresh) {
      state.grants[r.key].sub = r.sub;
      console.log(`re-pointed ${r.user} on ${r.repo}: now entitled by ${r.sub} (was ${r.from})`);
    }

    // Start or continue the grace clock. Nothing is removed here.
    for (const l of diff.lapsing) {
      if (!state.grants[l.key].lapsed_since) {
        // Dated from OUR FIRST OBSERVATION, not Stripe's cancellation timestamp.
        // If this job is down for ten days, Stripe's timestamp would say grace
        // expired long ago and we would revoke a whole cohort the moment we came
        // back. Observation time starts the clock now instead, so an outage can
        // never cause a revocation spike, and losing this state file entirely
        // degrades to "too generous" rather than "locked out".
        state.grants[l.key].lapsed_since = new Date(now).toISOString();
        console.log(`lapsing ${l.user} on ${l.repo}: grace of ${graceDays} days starts now`);
      }
    }

    // Revocations, gated.
    const entitledPairs = [...desired.values()];
    // Deliberately a command-line flag and never a config key. A seller who has
    // decided that one particular exodus is real has decided it about that pass,
    // not about every pass from now on; a config key would be set once during an
    // incident and left on, quietly disarming the breaker for good.
    const override = process.argv.includes('--allow-mass-revocation');
    const verdict = breakerVerdict(diff.due, entitledPairs, {
      percent: subsConfig.revoke_limit_percent,
      floor: subsConfig.revoke_limit_floor,
      enumeratedSubs: subs.length,
      override,
    });

    if (!verdict.allowed) {
      console.error(breakerLine(verdict, diff.due));
      state.breaker = { tripped_at: new Date(now).toISOString(), would_revoke: diff.due.map((p) => p.key) };
    } else {
      // An overridden breaker always announces itself, sweep or not. The whole
      // value of the control is that going past it leaves a mark in the log.
      if (verdict.overridden) {
        console.error(
          `WARN: SAFETY LIMIT OVERRIDDEN by --allow-mass-revocation: ${verdict.reason}. ` +
            `This flag applies to this run only and is not remembered`
        );
      }
      if (verdict.sweep && verdict.people > 0) console.error(sweepLine(verdict));
      state.breaker = { tripped_at: null, would_revoke: [] };
      for (const p of diff.due) {
        if (!enforce) { console.error(revokeLine(p, { dryRun: true })); continue; }
        try {
          // Write the revocation down BEFORE acting on it, exactly as the refund
          // guard does, and for the same reason. The renewal sweep treats this
          // list as absolute, so recording first means the worst a crash
          // mid-revocation can leave behind is a customer who still has access
          // and will never be auto-renewed. Recording last would leave the
          // opposite: access removed, no record, and the next sweep cheerfully
          // re-inviting somebody we just cut off.
          const bots = readJson(botsStatePath, null) || {};
          bots.revoked_access = recordRevocation(
            Array.isArray(bots.revoked_access) ? bots.revoked_access : [],
            p.repo,
            p.user,
            Date.now(),
            'lapse' // ours, and therefore the only kind we may later clear
          );
          writeJson(botsStatePath, bots);
          const { confirmed } = await revoke(p.repo, p.user, ghToken);
          console.error(revokeLine(p, { confirmed }));
          // The record goes either way. We have done everything we can do from
          // here, and keeping it would re-attempt the same removal every pass
          // while inflating the breaker's numerator with a person who is already
          // gone, eventually refusing revocations that are genuine.
          delete state.grants[p.key];
        } catch (err) {
          console.error(`FAILED revoke ${p.user} from ${p.repo}: ${err.message}`);
        }
      }
    }

    // Everyone whose clock is running, not only the ones it started this pass.
    // Printed in both modes: before arming, it is the list a seller is deciding
    // about; after arming, it is the warning that arrives while there is still
    // time to do something about it.
    const upcoming = upcomingLine(upcomingRevocations(diff.lapsing, graceDays, now), { enforce });
    if (upcoming) console.log(upcoming);

    state.last_pass = new Date(now).toISOString();
    writeJson(statePath, state);
    if (!enforce && diff.due.length) {
      console.log(
        `subscriptions: REPORTING ONLY. ${diff.due.length} revocation(s) were listed above and NONE were performed. ` +
          `Set subscriptions.enforce to true in ${configPath} once the list looks right`
      );
    }
    console.log(
      `subscriptions done. subscriptions=${subs.length} entitled=${desired.size} granted=${diff.grants.length} ` +
        `lapsing=${diff.lapsing.length} due=${diff.due.length} enforce=${enforce}`
    );
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = { readJson, stripeGet, listAllSubscriptions, learnUsernames, invite, revoke, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
