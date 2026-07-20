// Repository-invitation renewal: pure logic, no network.
//
// fulfill.js's job ends when GitHub answers 201. The buyer's access begins
// when they ACCEPT. Between those two points every system a seller owns reads
// "delivered": Stripe says paid, the ledger has a row, the run is green. If the
// buyer never opens the email, that stays true right up to the moment GitHub
// expires the invitation seven days after it was created. Then they have
// nothing, permanently, with nothing anywhere saying so. They paid.
//
// Re-issuing an invitation restarts the seven-day clock, so an invitation can
// be held open for as long as we are willing to keep emailing. That is the
// whole feature: plan the re-issues here, perform them in
// scripts/renew-invites.js.
//
// A note on where this sits. HonorBox Pro's ops bots sweep invitations too, and
// they carry the reporting: continuous triage of every pending invitation,
// pairing invitations back to the money, watchdog integration. Renewal itself
// belongs here in the free engine, because an invitation that lapses unaccepted
// means the sale was never delivered, and delivering the sale is the free
// engine's entire promise. Do not run both lanes against the same product
// repos: they keep separate state and would each renew, doubling the emails a
// buyer gets.
'use strict';

// GitHub expires a repository invitation SEVEN DAYS after it is created.
// Cited rather than remembered, because the REST reference does not state it
// anywhere: GitHub's changelog "Self-expiring repository and organization
// invitations" (2020-02-05) says "Invitations to join an organization or become
// a collaborator on a repository will expire seven days after they are
// created", and the organization-invitations docs page repeats it.
const INVITE_EXPIRY_HOURS = 7 * 24;

// Renew at six days, a full day before the lapse.
//
// The margin has to cover the worst case for "the renewal step never ran",
// because renewing late is the one failure that costs the buyer everything.
// The step rides the fulfillment poll, which the shipped template schedules
// every 30 minutes: 48 attempts inside a 24-hour margin. GitHub's cron is
// documented as best-effort and drops scheduled runs on quiet repositories, so
// the margin is sized for a scheduler that mostly does not fire. Even at a one
// in five fire rate the chance of no run at all across the margin is 0.79^48,
// about one in eighty thousand, before counting the optional heartbeat and
// on-sale dispatchers.
//
// Renewing earlier would buy margin we do not need and pay for it in buyer
// emails, which is the scarcer resource: every renewal is another message to
// somebody who has already ignored one.
const REINVITE_AFTER_HOURS = 6 * 24;

// Four emails total (the original invite plus three renewals) spread over about
// 24 days, then we stop and say so. A buyer who has ignored four invitations
// across three and a half weeks is not going to be rescued by a fifth; at that
// point the honest move is to put it in front of the seller, who can email them
// properly or refund them.
const MAX_REINVITES = 3;

// A renewal is normally paced by REINVITE_AFTER_HOURS all by itself, because a
// fresh invitation resets the age this planner reads. This floor is the belt to
// that braces: if a re-issued invitation ever came back reading OLD, the age
// test alone would fire again on the very next poll and burn the whole
// allowance in an afternoon. Nothing renews twice inside a day.
const REINVITE_COOLDOWN_HOURS = 24;

// The state fields this module reads, named once, here.
//
// Both the loader in renew-invites.js and the planner below go through these
// constants, so a rename moves both sides together. This is not fussiness. The
// ops lane shipped a planner that destructured `revokedAccess` while the state
// on disk said `revoked_access`; the denylist read as permanently empty and a
// refunded buyer was re-invited. Every unit test passed, because the tests
// handed the planner the name the planner already believed in.
const REVOKED_FIELD = 'revoked_access';
const REINVITES_FIELD = 'reinvites';

function ageHours(inv, now) {
  const created = Date.parse(inv && inv.created_at);
  if (!Number.isFinite(created)) return null; // unparseable: the caller decides
  return (now - created) / 3_600_000;
}

// --- entitlement records ----------------------------------------------------
//
// One key per (repo, buyer). GitHub treats logins and repository names as
// case-insensitive, so the key is lowercased: "Buyer" and "buyer" are the same
// person and must not get two allowances or slip past one revocation.

function inviteKey(repo, login) {
  return `${String(repo == null ? '' : repo).toLowerCase()}#${String(login == null ? '' : login).toLowerCase()}`;
}

function findRecord(rows, key) {
  return (Array.isArray(rows) ? rows : []).find((r) => r && r.key === key) || null;
}

// Newest-first cap, applied to both record lists. These grow one entry per
// buyer per repo and are committed to git on every cycle, so they get the same
// ceiling treatment as processed/failures in the fulfillment state.
function capRecords(rows, cap = 500) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (list.length <= cap) return list;
  return [...list].sort((a, b) => (b.ts || b.last || 0) - (a.ts || a.last || 0)).slice(0, cap);
}

// Access was deliberately taken away from this buyer on this repo. The renewal
// planner treats one of these as absolute.
//
// The record carries a timestamp rather than being a bare membership set for
// two reasons. It lets the planner tell OUR OWN post-revocation re-invite (a
// race it must undo) from an invitation created later by a legitimate
// re-purchase (which it must not touch). And it is the shape a lapse/restore
// lane needs: adding a `state` field later resolves through the same
// latest-record-per-key rule, with no change to how collisions are settled.
function recordRevocation(rows, repo, login, ts = Date.now()) {
  const key = inviteKey(repo, login);
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
  return capRecords([...kept, { key, ts }]);
}

// --- renewal planning -------------------------------------------------------

// What to do about every pending invitation on one repo. Pure: the caller owns
// the HTTP and the clock.
//
//   reinvite    re-issue, the clock is nearly out
//   giveUp      allowance spent; stop, and say so where the seller will see it
//   cleanup     we re-invited somebody whose access was revoked underneath us;
//               undo it (see below)
//   blocked     revoked, and not our doing; leave it entirely alone
//   superseded  litter from a crash between our add and our remove; sweep it
//
// Order matters. Revocation is checked FIRST and has no exceptions, because the
// failure it prevents is the expensive one: an auto-renewal that quietly
// restores a refunded buyer is refund fraud we would have built ourselves.
//
// The narrow case worth spelling out is `cleanup`. Revocation is a separate
// command a seller runs while a scheduled poll may already be in flight, so a
// run can read the invitation list a moment before the revocation lands and
// then re-invite a buyer who is by then refunded. The denylist stops it
// happening again but cannot un-send it, so the invitation has to come back
// off. It is deleted ONLY when our own record shows we created it after the
// revocation. An invitation older than the revocation, or one we never touched,
// belongs to somebody else's decision (most likely fulfillment serving a
// re-purchase) and is left alone. We reverse our own mistakes, not other
// people's choices.
function planInviteActions(repo, invitations, state, { now = Date.now() } = {}) {
  const revokedAccess = state && state[REVOKED_FIELD];
  // Refusing to plan is the correct answer to an unreadable denylist. A
  // guard that cannot read its input must never report that everything is
  // fine, and "no denylist field" is indistinguishable from "nobody is
  // revoked" only if you decide it is. The loader normalizes a fresh install
  // to [], so reaching this means a caller built the state some other way and
  // is one rename away from re-inviting refunded buyers.
  //
  // The asymmetry with `reinvites` below is deliberate: losing the renewal
  // ledger costs a buyer one extra email, losing the denylist costs a refund.
  if (!Array.isArray(revokedAccess)) {
    throw new Error(
      `planInviteActions: state.${REVOKED_FIELD} must be an array, got ${typeof revokedAccess}; ` +
        'refusing to plan renewals against a revocation list I cannot read'
    );
  }
  const reinvites = state[REINVITES_FIELD];
  const plan = { reinvite: [], giveUp: [], cleanup: [], blocked: [], superseded: [] };

  // Group by buyer before deciding anything. One buyer can end up holding two
  // pending invitations (we add before we remove, so a crash in between leaves
  // the spare behind on purpose), and per-invitation decisions would then email
  // them once per duplicate: the exact spam this feature must not become. The
  // newest invitation is the buyer's real one; the rest are litter to sweep up
  // silently, because no buyer needs to hear about our crash.
  const byKey = new Map();
  for (const inv of Array.isArray(invitations) ? invitations : []) {
    const login = inv && inv.invitee && inv.invitee.login;
    if (!inv || inv.id == null || !login) continue;
    const key = inviteKey(repo, login);
    if (!byKey.has(key)) byKey.set(key, { key, login, rows: [] });
    byKey.get(key).rows.push(inv);
  }

  for (const { key, login, rows } of byKey.values()) {
    const rec = findRecord(reinvites, key);

    const revoked = findRecord(revokedAccess, key);
    if (revoked) {
      // Revocation covers every invitation this buyer holds on this repo, not
      // just the newest, or a duplicate would survive the cleanup.
      for (const inv of rows) {
        const entry = { inv, key, login, repo };
        if (rec && Number(rec.last) > Number(revoked.ts)) plan.cleanup.push({ ...entry, revokedAt: revoked.ts });
        else plan.blocked.push(entry);
      }
      continue;
    }

    const dated = rows.map((inv) => ({ inv, at: Date.parse(inv.created_at) }));
    const readable = dated.filter((d) => Number.isFinite(d.at));
    // All unreadable: guessing which of two undated rows is current is exactly
    // the kind of guess that deletes the wrong one.
    if (!readable.length) continue;
    readable.sort((a, b) => b.at - a.at);
    const inv = readable[0].inv;
    for (const d of [...readable.slice(1), ...dated.filter((x) => !Number.isFinite(x.at))]) {
      plan.superseded.push({ inv: d.inv, key, login, repo });
    }
    const entry = { inv, key, login, repo };

    const age = ageHours(inv, now);
    if (inv.expired !== true && age < REINVITE_AFTER_HOURS) continue;

    const n = rec ? Number(rec.n) || 0 : 0;
    if (rec && rec.gave_up) continue; // already reported, stay quiet
    if (n >= MAX_REINVITES) { plan.giveUp.push({ ...entry, n }); continue; }
    if (rec && now - Number(rec.last || 0) < REINVITE_COOLDOWN_HOURS * 3_600_000) continue;

    plan.reinvite.push({ ...entry, attempt: n + 1 });
  }
  return plan;
}

// Write down what just happened to this (repo, buyer).
//
// `n` is the email allowance and only moves when an email was actually sent, so
// a renewal GitHub refused costs the buyer nothing. `last` moves either way,
// which is what stops a permanently failing renewal from retrying on every
// poll forever: a refusal buys a day of quiet, not a spend.
//
// Both live on the (repo, buyer) key rather than the invitation id, because
// re-issuing CHANGES the id. Counting by id would hand every renewal a fresh
// allowance and email the buyer until one of them died.
//
// `gave_up` is sticky, and it is what keeps the give-up line an event rather
// than a thing the log repeats every poll for the rest of the repo's life.
function recordReinvite(rows, key, { now = Date.now(), sent = false, gaveUp = false } = {}) {
  const rec = findRecord(rows, key) || { n: 0, gave_up: false };
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
  return capRecords([
    ...kept,
    {
      key,
      n: (Number(rec.n) || 0) + (sent ? 1 : 0),
      last: now,
      gave_up: !!(rec.gave_up || gaveUp),
    },
  ]);
}

// The buyer is in: drop the allowance so a later purchase of another product,
// or a later lapse and return, starts from a clean sheet.
function forgetReinvites(rows, key) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.key !== key);
}

// The two outcomes that need a person. Giving up is a buyer who paid and is
// about to have nothing; an undone resurrection is somebody holding access they
// refunded. Successful renewals are not alerts and are logged by the caller.
function reinviteAlertLines(repo, plan) {
  const lines = [];
  for (const g of plan.giveUp) {
    lines.push(
      `WARN: giving up on re-inviting ${g.login} to ${repo} after ${g.n} renewals ` +
        `(created ${g.inv.created_at}): they paid, have never accepted, and this invitation will now be ` +
        `allowed to expire; email them or refund them`
    );
  }
  for (const c of plan.cleanup) {
    lines.push(
      `WARN: revoked access reappeared for ${c.login} on ${repo}: a renewal raced this buyer's revocation, ` +
        `deleting invitation ${c.inv.id}`
    );
  }
  return lines;
}

module.exports = {
  INVITE_EXPIRY_HOURS,
  REINVITE_AFTER_HOURS,
  MAX_REINVITES,
  REINVITE_COOLDOWN_HOURS,
  REVOKED_FIELD,
  REINVITES_FIELD,
  ageHours,
  inviteKey,
  capRecords,
  recordRevocation,
  planInviteActions,
  recordReinvite,
  forgetReinvites,
  reinviteAlertLines,
};
