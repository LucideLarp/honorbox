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
  MAX_INVITE_ATTEMPTS,
  isTransientInviteError,
  inviteAttempts,
  pickNewPaidSessions,
  extractGithubUsername,
  validUsername,
  matchGrant,
  ledgerRow,
  nextCursor,
  isRepoOwner,
} = require('./lib/fulfill-core.js');

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

async function stripeGet(pathname, params, key) {
  const url = new URL(`https://api.stripe.com${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Stripe-Version pinned: the account default may be a broken preview
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(key + ':').toString('base64')}`, 'Stripe-Version': '2024-06-20' },
  });
  if (!res.ok) throw new Error(`Stripe ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listSessionsSince(createdGt, key) {
  const sessions = [];
  let startingAfter = null;
  for (;;) {
    const params = { limit: '100', 'created[gt]': String(createdGt), 'expand[]': 'data.line_items' };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripeGet('/v1/checkout/sessions', params, key);
    sessions.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return sessions;
}

async function inviteCollaborator(repo, username, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/collaborators/${username}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'honorbox-fulfill',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ permission: 'pull' }),
  });
  // 201 = invitation created, 204 = already a collaborator (or invite updated)
  if (res.status === 201 || res.status === 204) return res.status;
  const hint = res.status === 404 ? ' (no such GitHub user, check for a typo in the checkout field)' : '';
  const msg = `GitHub invite ${repo} <- ${username} -> ${res.status}${hint}: ${await res.text()}`;
  throw Object.assign(new Error(msg), { status: res.status });
}

async function main() {
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

  const state = readJson(statePath, { cursor: 0, processed: [], failures: [] });
  const ledger = readJson(ledgerPath, { rows: [] });
  const newSales = []; // usernames fulfilled THIS run (for license issuing etc.)

  const since = Math.max(0, (state.cursor || 0) - OVERLAP_SECONDS);
  const sessions = await listSessionsSince(since, stripeKey);
  const fresh = pickNewPaidSessions(sessions, state.processed, config.fulfillment);
  console.log(`sessions scanned=${sessions.length} new_paid=${fresh.length}`);

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
        const code = await inviteCollaborator(grant.repo, username, ghToken);
        console.log(`fulfilled ${s.id}: invited ${username} -> ${grant.repo} (HTTP ${code})`);
      }
      ledger.rows.push(row);
      ledgerRefs.add(row.ref);
      newSales.push(username);
    } catch (err) {
      const attempt = inviteAttempts(state.failures, s.id) + 1;
      const retry = isTransientInviteError(err) && attempt < MAX_INVITE_ATTEMPTS;
      console.error(`FAILED ${s.id} (attempt ${attempt}${retry ? ', will retry next poll' : ''}): ${err.message}`);
      state.failures.push({ ...entry, error: String(err.message), ...(retry ? { transient: true } : {}) });
      if (retry) continue; // NOT marked processed: the next poll retries it
      ledger.rows.push({ ...row, needs_attention: true });
      ledgerRefs.add(row.ref);
    }
    state.processed.push(s.id);
  }

  state.cursor = nextCursor(sessions, state.cursor);
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

module.exports = { readJson, stripeGet, listSessionsSince, inviteCollaborator, main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || String(err));
    process.exit(1);
  });
}
