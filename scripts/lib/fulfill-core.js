// Pure fulfillment logic — no network, fully unit-testable.
// The I/O driver (fulfill.js) feeds it Stripe Checkout Session objects.
'use strict';

const crypto = require('crypto');

// Poll re-scan window. Checkout Sessions can complete up to 24h after
// creation (Stripe's expires_at ceiling), and the cursor tracks creation
// time, so the window must outlive a session: 24h + 1h slack. Re-scans are
// free (processed-id set), a missed sale is not.
const OVERLAP_SECONDS = 25 * 3600;

// Every outbound call gets a deadline. Node's fetch has no overall request
// timeout, and undici's header/body defaults are 300s each: an accepted-but-
// unanswered socket stalls the whole poll. Measured on Node 24 — a bare fetch
// against a server that accepts and never replies had still not settled after
// 8s, while AbortSignal.timeout aborts on the dot. That matters because the
// runner is a single launchd job: while one cycle is stuck on one buyer's
// invite, no other cycle starts and EVERY buyer behind them waits. An abort
// carries no .status, so it lands in the transient bucket and simply retries.
const REQUEST_TIMEOUT_MS = 20_000;

// GitHub username: 1-39 chars, alphanumeric + hyphen, no leading/trailing
// hyphen, no consecutive hyphens.
const USERNAME_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u) && !u.includes('--');
}

function extractGithubUsername(session, fieldKey = 'github_username') {
  const fields = session.custom_fields || [];
  const f = fields.find((x) => x.key === fieldKey);
  const raw = f && f.text && f.text.value;
  if (!raw) return null;
  let u = raw.trim().replace(/^@/, '');
  // Buyers paste their profile URL often enough to accept it. Only a BARE
  // profile link yields a username; anything deeper passes through so
  // validation rejects it instead of guessing.
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/?$/i.exec(u);
  if (m) u = m[1].replace(/^@/, '');
  return u;
}

// Invite failures split two ways. Transient (no HTTP verdict at all, 429,
// 5xx, or a rate-limited 403): worth retrying on the next poll, so the
// session is NOT marked processed. Everything else (no such user, bad
// token) is a permanent needs_attention row for a human.
function isTransientInviteError(err) {
  if (!err || err.permanent) return false;
  if (err.status == null) return true; // fetch threw: DNS, timeout, reset
  if (err.status === 429 || err.status >= 500) return true;
  return err.status === 403 && /rate limit|secondary/i.test(String(err.message));
}

// The retry budget is TIME, not attempts: an attempt cap burns out in
// minutes on a fast poll cadence, which a routine GitHub incident
// outlasts. Retries run for 6h from the FIRST transient failure (the
// "always within a few hours" delivery promise), then surface to a human.
const INVITE_RETRY_WINDOW_SECONDS = 6 * 3600;

function shouldRetryInvite(err, failures, sessionId, now = Date.now()) {
  if (!isTransientInviteError(err)) return false;
  const first = failures.find((f) => f.session === sessionId && f.transient);
  return !first || now - Date.parse(first.ts) < INVITE_RETRY_WINDOW_SECONDS * 1000;
}

function inviteAttempts(failures, sessionId) {
  return failures.filter((f) => f.session === sessionId && f.transient).length;
}

function isPaidComplete(session) {
  // "no_payment_required" covers fully-discounted (100% promo) checkouts.
  return (
    session.status === 'complete' &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
  );
}

// Match a session to a fulfillment grant by payment link id, or by price id
// (covers server-created Checkout Sessions, which have no payment_link —
// requires the session list to expand data.line_items).
function sessionPrices(session) {
  const items = (session.line_items && session.line_items.data) || [];
  return items.map((li) => li.price && li.price.id).filter(Boolean);
}

function matchGrant(session, grants) {
  const byLink = session.payment_link
    ? grants.find((g) => g.payment_link && g.payment_link === session.payment_link)
    : null;
  if (byLink) return byLink;
  const prices = sessionPrices(session);
  return grants.find((g) => g.price && prices.includes(g.price)) || null;
}

function pickNewPaidSessions(sessions, processedIds, grants) {
  const seen = new Set(processedIds);
  return sessions.filter(
    (s) => isPaidComplete(s) && !seen.has(s.id) && matchGrant(s, grants) !== null
  );
}

// The one failure the engine used to swallow whole: a session the buyer PAID
// for that matches no grant. pickNewPaidSessions drops it, so the run prints
// "new_paid=0", exits 0, and looks perfectly healthy while the money sits in
// the account and the buyer waits for access that is never coming. grantProblems
// catches a grant that is malformed; this catches a grant that is merely wrong
// (right shape, wrong id) or absent. Warn once per session — the caller
// remembers which ids it has already reported, so a permanently unmatchable
// session doesn't re-alert on every poll forever.
function unmatchedPaidSessions(sessions, warnedIds, grants) {
  const seen = new Set(warnedIds);
  return sessions.filter(
    (s) => isPaidComplete(s) && !seen.has(s.id) && matchGrant(s, grants) === null
  );
}

// Public-safe ledger row: no names, no emails, no session ids in the clear.
function ledgerRow(session, grant) {
  return {
    ts: new Date(session.created * 1000).toISOString(),
    product: grant.product,
    amount: (session.amount_total ?? 0) / 100,
    currency: (session.currency || '').toUpperCase(),
    country:
      (session.customer_details &&
        session.customer_details.address &&
        session.customer_details.address.country) ||
      null,
    ref: crypto.createHash('sha256').update(session.id).digest('hex').slice(0, 10),
  };
}

// Advance the poll cursor to the newest session seen, never backwards.
function nextCursor(sessions, prevCursor) {
  const newest = sessions.reduce((acc, s) => Math.max(acc, s.created || 0), 0);
  return Math.max(prevCursor || 0, newest);
}

// A grant matches a session by payment link ID (plink_...) or price ID
// (price_...), never by the buyer-facing checkout URL. Pasting the URL is an
// easy mistake and the worst kind: the grant simply never matches, so every
// paid order is skipped with a green run and exit 0. Surface it on every poll
// instead of losing sales quietly. Warnings, not a hard exit: one bad grant
// must not stop a working product from delivering.
function grantProblems(grants) {
  const out = [];
  (Array.isArray(grants) ? grants : []).forEach((g, i) => {
    const where = `fulfillment[${i}]${g && g.product ? ` ("${g.product}")` : ''}`;
    if (!g || typeof g !== 'object') { out.push(`${where} is not an object`); return; }
    const link = typeof g.payment_link === 'string' ? g.payment_link : '';
    const price = typeof g.price === 'string' ? g.price : '';
    if (/^https?:\/\//i.test(link)) {
      out.push(`${where} payment_link is a checkout URL, which never matches a session; use the link's id (plink_...) from the Stripe dashboard`);
    } else if (link && !link.startsWith('plink_')) {
      out.push(`${where} payment_link "${link}" is not a plink_ id`);
    }
    if (price && !price.startsWith('price_')) out.push(`${where} price "${price}" is not a price_ id`);
    const matchable = link.startsWith('plink_') || price.startsWith('price_');
    if (!matchable) out.push(`${where} can never match a sale: set payment_link (plink_...) or price (price_...)`);
    if (!g.repo) out.push(`${where} has no "repo": a matched sale would have nowhere to invite the buyer`);
  });
  return out;
}

// A buyer who owns the target repo already has access (sellers test-buying
// their own product) — treat as fulfilled without an invite.
function isRepoOwner(repo, username) {
  const owner = String(repo).split('/')[0];
  return !!username && owner.toLowerCase() === String(username).toLowerCase();
}

// What a GitHub invite status MEANS, in the operator's words. Anything not
// listed is unrecognized, and unrecognized must never read like success: the
// engine treats it as an outright failure and says so in the log line.
const INVITE_STATUS_HINT = {
  404: 'no such GitHub user, check for a typo in the checkout field',
  403: 'forbidden — the token lacks admin on this repo, org policy blocks the invite, or a secondary rate limit is in force',
  422: 'GitHub rejected the invite as invalid (the account cannot be added to this repo)',
  401: 'the fulfillment token is bad or expired — NOTHING is being delivered until it is replaced',
};

function inviteStatusHint(status) {
  if (INVITE_STATUS_HINT[status]) return ` (${INVITE_STATUS_HINT[status]})`;
  if (status >= 500) return ' (GitHub server error — transient, will retry)';
  if (status === 429) return ' (rate limited — transient, will retry)';
  return ' (UNRECOGNIZED status — treated as NOT delivered)';
}

module.exports = {
  OVERLAP_SECONDS,
  REQUEST_TIMEOUT_MS,
  INVITE_STATUS_HINT,
  inviteStatusHint,
  INVITE_RETRY_WINDOW_SECONDS,
  isTransientInviteError,
  shouldRetryInvite,
  inviteAttempts,
  isRepoOwner,
  grantProblems,
  validUsername,
  extractGithubUsername,
  isPaidComplete,
  matchGrant,
  pickNewPaidSessions,
  unmatchedPaidSessions,
  ledgerRow,
  nextCursor,
};
