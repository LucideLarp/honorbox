// Pure fulfillment logic — no network, fully unit-testable.
// The I/O driver (fulfill.js) feeds it Stripe Checkout Session objects.
'use strict';

const crypto = require('crypto');

// Poll re-scan window. Checkout Sessions can complete up to 24h after
// creation (Stripe's expires_at ceiling), and the cursor tracks creation
// time, so the window must outlive a session: 24h + 1h slack. Re-scans are
// free (processed-id set), a missed sale is not.
const OVERLAP_SECONDS = 25 * 3600;

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

module.exports = {
  OVERLAP_SECONDS,
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
  ledgerRow,
  nextCursor,
};
