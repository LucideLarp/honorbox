#!/usr/bin/env node
// HonorBox fulfillment engine.
//
// Polls Stripe Checkout Sessions and, for each new paid session matching a
// configured grant, invites the buyer's GitHub username (checkout custom
// field) to the product's private repo. Appends an anonymized ledger row.
// State (cursor + processed ids + failures) is written to disk; committing
// is the calling workflow's job. No webhooks, no server, no dependencies.
//
// Env:  STRIPE_SECRET_KEY  (required)
//       GH_FULFILL_TOKEN   (required: token with admin on the product repos)
// Usage: node scripts/fulfill.js --config store.config.json \
//          --state state/fulfill-state.json --ledger ledger/ledger.json
'use strict';

const fs = require('fs');
const path = require('path');
const {
  OVERLAP_SECONDS, // re-scan window: outlives a session's 24h lifetime
  shouldRetryInvite,
  inviteAttempts,
  pickNewPaidSessions,
  extractGithubUsername,
  validUsername,
  matchGrant,
  ledgerRow,
  nextCursor,
  isRepoOwner,
  isFreeFulfillment,
  grantProblems,
  unmatchedPaidSessions,
  REQUEST_TIMEOUT_MS,
  inviteStatusHint,
  inRunRetryDelayMs,
  retryAfterMs,
  pruneFailures,
  IN_RUN_MAX_ATTEMPTS,
} = require('./lib/fulfill-core.js');

// Injectable so tests exercise the real retry paths without real waiting.
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; } // no file yet: fresh install
  // a corrupt file must stop the run, not silently reset cursor/processed
  try { return JSON.parse(raw); } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Stripe is read-only here and every failure is fatal to the WHOLE run: the
// session list is the first thing main() does, so one 500 or one 429 from
// Stripe means nobody gets delivered this cycle, not just one buyer. That is
// the widest blast radius in the engine, so the read gets a short retry.
// Retries are safe because the call is a GET. Permanent verdicts (401 bad
// key, 400 bad params) are not retried — they cannot come good, and burning
// the run's time on them delays the failure a human needs to see.
const STRIPE_RETRY_DELAYS_MS = [500, 2_000];

async function stripeGet(pathname, params, key, sleep = defaultSleep) {
  const url = new URL(`https://api.stripe.com${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      // Stripe-Version pinned: the account default may be a broken preview
      res = await fetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(key + ':').toString('base64')}`, 'Stripe-Version': '2024-06-20' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // No verdict at all (DNS, reset, our own deadline) — retryable.
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

async function listSessionsSince(createdGt, key, sleep = defaultSleep) {
  const sessions = [];
  let startingAfter = null;
  for (;;) {
    const params = { limit: '100', 'created[gt]': String(createdGt), 'expand[]': 'data.line_items' };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeGet('/v1/checkout/sessions', params, key, sleep);
    sessions.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return sessions;
}

async function inviteCollaborator(repo, username, token) {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/collaborators/${username}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'honorbox-fulfill',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ permission: 'pull' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // No HTTP verdict at all: DNS, connection reset, or our own deadline. The
    // rethrow deliberately carries NO .status, which is what puts it in the
    // transient bucket for a retry on the next poll. Naming the error class
    // matters at 3am: "TimeoutError" and "ENOTFOUND" want different humans.
    throw new Error(`GitHub invite ${repo} <- ${username} -> no response from GitHub (${err.name}: ${err.message})`);
  }
  // The ONLY two statuses that mean the buyer has their access:
  //   201 = invitation created (a real stranger being let in)
  //   204 = already a collaborator
  // Everything else is a failure, including anything unrecognized. Widening
  // this set is how a delivery failure starts reading like a delivery.
  if (res.status === 201 || res.status === 204) return res.status;
  const msg = `GitHub invite ${repo} <- ${username} -> ${res.status}${inviteStatusHint(res.status)}: ${await res.text()}`;
  // Headers ride along on the error: retry-after / x-ratelimit-* are how a
  // rate limit is told apart from a permissions 403, and how long to wait is
  // GitHub's call, not ours. Discarding them was why the old code had to guess
  // from the prose of the message.
  throw Object.assign(new Error(msg), { status: res.status, headers: res.headers });
}

// Retry the invite INSIDE this run while the budget allows, instead of leaving
// a transient failure to the next poll an hour away. Safe to repeat: the call
// is a PUT, so a replay either creates the one invitation or reports the
// collaborator already has access — GitHub does not stack duplicate invites,
// and nothing is written to the ledger until one of those two verdicts lands.
async function inviteWithRetry(repo, username, token, budget, sleep) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inviteCollaborator(repo, username, token);
    } catch (err) {
      const delay = inRunRetryDelayMs(err, attempt, budget.spentMs);
      if (delay === null) throw err; // out of budget/attempts, or not transient
      const stated = retryAfterMs(err.headers);
      console.error(
        `RETRY ${repo} <- ${username} in ${Math.round(delay / 1000)}s ` +
          `(attempt ${attempt}/${IN_RUN_MAX_ATTEMPTS}, ` +
          `${stated === null ? 'no retry-after header, backing off' : 'GitHub asked for this delay'}): ${err.message}`
      );
      budget.spentMs += delay;
      await sleep(delay);
    }
  }
}

async function main(sleep = defaultSleep) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const ghToken = process.env.GH_FULFILL_TOKEN;
  if (!stripeKey || !ghToken) {
    console.error('Missing STRIPE_SECRET_KEY or GH_FULFILL_TOKEN');
    process.exit(2);
  }

  const configPath = arg('config', 'store.config.json');
  const statePath = arg('state', 'state/fulfill-state.json');
  const ledgerPath = arg('ledger', 'ledger/ledger.json');

  const config = readJson(configPath, null);
  if (!config || !Array.isArray(config.fulfillment) || config.fulfillment.length === 0) {
    console.error(`No fulfillment grants configured in ${configPath}`);
    process.exit(2);
  }

  // A grant that can never match loses every sale of that product silently.
  for (const problem of grantProblems(config.fulfillment)) console.error(`CONFIG ${problem}`);

  const state = readJson(statePath, { cursor: 0, processed: [], failures: [] });
  const ledger = readJson(ledgerPath, { rows: [] });
  const newSales = []; // usernames fulfilled THIS run (for license issuing etc.)

  // One shared in-run retry budget for the whole cycle. Per-session budgets
  // would let ten failing buyers serialize into ten separate waits and stretch
  // the run without bound; this caps the total wait no matter how many fail.
  const budget = { spentMs: 0 };

  const since = Math.max(0, (state.cursor || 0) - OVERLAP_SECONDS);
  const sessions = await listSessionsSince(since, stripeKey, sleep);
  const fresh = pickNewPaidSessions(sessions, state.processed, config.fulfillment);
  console.log(`sessions scanned=${sessions.length} new_paid=${fresh.length}`);

  // Money came in that this store cannot deliver on. Say so on the run that
  // sees it, once, in the shape the watchdog already greps for ("WARN:").
  state.unmatched = Array.isArray(state.unmatched) ? state.unmatched : [];
  for (const s of unmatchedPaidSessions(sessions, state.unmatched, config.fulfillment)) {
    const paid = `${((s.amount_total ?? 0) / 100).toFixed(2)} ${(s.currency || '').toUpperCase()}`;
    console.error(
      `WARN: paid session ${s.id} (${paid}) matches no fulfillment grant — nothing was delivered. ` +
        `Check the payment_link/price ids in the config. (Expected once per sale if this Stripe ` +
        `account also sells products this store does not fulfill.)`
    );
    state.unmatched.push(s.id);
  }
  if (state.unmatched.length > 5000) state.unmatched = state.unmatched.slice(-5000);

  // Ledger dedup key: two runners (local 2-min + Actions safety net) can overlap;
  // the processed-set stops sequential re-processing, but a same-window collision
  // could append a row twice. Guard by the ledger's own ref so a row is unique.
  const ledgerRefs = new Set(ledger.rows.map((r) => r.ref));

  for (const s of fresh) {
    const grant = matchGrant(s, config.fulfillment);
    const username = extractGithubUsername(s);
    const entry = { session: s.id, ts: new Date().toISOString() };
    const row = ledgerRow(s, grant);
    if (ledgerRefs.has(row.ref)) { state.processed.push(s.id); continue; }
    try {
      if (!validUsername(username)) {
        throw Object.assign(new Error(`invalid github username: ${JSON.stringify(username)}`), { permanent: true });
      }
      if (isRepoOwner(grant.repo, username)) {
        console.log(`fulfilled ${s.id}: ${username} owns ${grant.repo}, no invite needed`);
      } else {
        const code = await inviteWithRetry(grant.repo, username, ghToken, budget, sleep);
        // 201 created an invitation; 204 means the account was already a
        // collaborator. Reporting both as "invited" made a seller's own
        // test-buy read like a real delivery and hid the difference that
        // matters when a buyer says no invite arrived.
        const outcome = code === 201 ? `invited ${username} to` : `${username} already had access to`;
        console.log(`fulfilled ${s.id}: ${outcome} ${grant.repo} (HTTP ${code})`);
      }
      if (isFreeFulfillment(s)) {
        console.error(
          `WARN: ${s.id} fulfilled at ZERO cost — ${row.product} -> ${username} ` +
            `(payment_status=${s.payment_status}, amount_total=${s.amount_total ?? 0}). ` +
            `A coupon or discount covered it in full. Confirm this was intended.`
        );
      }
      ledger.rows.push(row);
      ledgerRefs.add(row.ref);
      newSales.push(username);
    } catch (err) {
      const attempt = inviteAttempts(state.failures, s.id) + 1;
      // retry budget is 6h from the first transient failure, then a human
      const retry = shouldRetryInvite(err, state.failures, s.id);
      console.error(`FAILED ${s.id} (attempt ${attempt}${retry ? ', will retry next poll' : ''}): ${err.message}`);
      state.failures.push({ ...entry, error: String(err.message), ...(retry ? { transient: true } : {}) });
      if (retry) continue; // NOT marked processed: the next poll retries it
      ledger.rows.push({ ...row, needs_attention: true });
      ledgerRefs.add(row.ref);
    }
    state.processed.push(s.id);
  }

  state.cursor = nextCursor(sessions, state.cursor);
  // Prune BEFORE trimming processed, so the settled set is at its largest and
  // the prune is as effective as it can be. Rows for sessions still awaiting a
  // retry are kept at any size — they date the 6h window.
  state.failures = pruneFailures(state.failures, state.processed);
  // Bound growth: processed ids older than the overlap window can never recur.
  if (state.processed.length > 5000) state.processed = state.processed.slice(-5000);

  ledger.updated = new Date().toISOString();
  ledger.total_sales = ledger.rows.filter((r) => !r.needs_attention).length;

  writeJson(statePath, state);
  writeJson(ledgerPath, ledger);
  writeJson(path.join(path.dirname(statePath), 'new-sales.json'), newSales);
  console.log(`done. ledger_rows=${ledger.rows.length} failures_total=${state.failures.length}`);
  // Signal "attention needed" to the workflow without failing the run. The
  // flag reflects THIS run only: state/ gets committed, so a stale flag from
  // the last sale would hold the publish gate open forever.
  const flagPath = path.join(path.dirname(statePath), 'HAD_ACTIVITY');
  if (fresh.length > 0) fs.writeFileSync(flagPath, '1');
  else fs.rmSync(flagPath, { force: true });
}

module.exports = { readJson, stripeGet, listSessionsSince, inviteCollaborator, inviteWithRetry, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
