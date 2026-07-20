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
    startingAfter = page.data[page.data.length - 1].id;
  }
  return subs;
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
    for (const s of page.data || []) {
      newest = Math.max(newest, s.created || 0);
      if (!s.subscription) continue;
      const u = extractGithubUsername(s);
      if (validUsername(u)) map[s.subscription] = u;
    }
    if (!page.has_more || (page.data || []).length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
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

// Remove a collaborator and any invitation they have not accepted yet. A 404 is
// the desired end state, not an error: the account was renamed, or was never
// there. It is logged and never retried.
async function revoke(repo, user, token) {
  const res = await gh('DELETE', `/repos/${repo}/collaborators/${encodeURIComponent(user)}`, token);
  if (!res.ok && res.status !== 404 && res.status !== 204) {
    throw new Error(`revoke ${repo} -> ${user} -> ${res.status}${inviteStatusHint(res.status)}`);
  }
  const invRes = await gh('GET', `/repos/${repo}/invitations`, token);
  if (invRes.ok) {
    const invites = await invRes.json();
    for (const inv of Array.isArray(invites) ? invites : []) {
      if (inv.invitee && normalizeUser(inv.invitee.login) === normalizeUser(user)) {
        await gh('DELETE', `/repos/${repo}/invitations/${inv.id}`, token);
      }
    }
  }
  return res.status;
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
  const sinceLast = now - Date.parse(state.last_pass || 0);
  if (Number.isFinite(sinceLast) && sinceLast < MIN_PASS_INTERVAL_MS && !process.argv.includes('--force')) {
    console.log(`subscriptions: last pass ${Math.round(sinceLast / 60000)}m ago, skipping (min interval 60m; --force overrides)`);
    return;
  }

  const subs = await listAllSubscriptions(stripeKey, sleep);
  const learned = await learnUsernames(state.cursor || 0, stripeKey, sleep);
  Object.assign(state.users, learned.map);
  state.cursor = Math.max(state.cursor || 0, learned.cursor || 0);

  const { desired, heldSubs, notes } = desiredEntitlements(subs, state.users, grants);
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

  const diff = diffEntitlements(desired, state.grants, { graceDays, now, knownRepos, heldSubs });

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
  const verdict = breakerVerdict(diff.due, entitledPairs, {
    percent: subsConfig.revoke_limit_percent,
    floor: subsConfig.revoke_limit_floor,
    enumeratedSubs: subs.length,
  });

  if (!verdict.allowed) {
    console.error(breakerLine(verdict, diff.due));
    state.breaker = { tripped_at: new Date(now).toISOString(), would_revoke: diff.due.map((p) => p.key) };
  } else {
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
        await revoke(p.repo, p.user, ghToken);
        console.error(revokeLine(p));
        delete state.grants[p.key];
      } catch (err) {
        console.error(`FAILED revoke ${p.user} from ${p.repo}: ${err.message}`);
      }
    }
  }

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
}

module.exports = { readJson, stripeGet, listAllSubscriptions, learnUsernames, invite, revoke, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
