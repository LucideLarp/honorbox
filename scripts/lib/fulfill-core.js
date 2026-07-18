// Pure fulfillment logic — no network, fully unit-testable.
// The I/O driver (fulfill.js) feeds it Stripe Checkout Session objects.
'use strict';

const crypto = require('crypto');

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
  return raw.trim().replace(/^@/, '');
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

// A buyer who owns the target repo already has access (sellers test-buying
// their own product) — treat as fulfilled without an invite.
function isRepoOwner(repo, username) {
  const owner = String(repo).split('/')[0];
  return !!username && owner.toLowerCase() === String(username).toLowerCase();
}

module.exports = {
  isRepoOwner,
  validUsername,
  extractGithubUsername,
  isPaidComplete,
  matchGrant,
  pickNewPaidSessions,
  ledgerRow,
  nextCursor,
};
