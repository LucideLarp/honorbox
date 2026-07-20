// Subscription entitlement: pure logic, no network, fully unit-testable.
// The I/O driver (reconcile-subs.js) feeds it Stripe Subscription objects.
//
// This file exists because of one asymmetry. When the engine sells one-time,
// the worst bug makes a buyer WAIT. When it sells subscriptions, the worst bug
// TAKES ACCESS FROM SOMEONE WHO IS PAYING, which does not read as a delay, it
// reads as theft. Every default here leans toward keeping a person in, and
// every place where that costs a seller money says so out loud instead of
// quietly deciding for them.
//
// Note also what a lapse actually does. Delivery is a repo invitation, so
// removing a collaborator stops future `git pull`; it does not claw back what
// was already cloned. A HonorBox subscription sells continued access and
// future updates, not use of the product. That is the honest description and
// the docs use it.
'use strict';

// --- actions ----------------------------------------------------------------
// Three, deliberately not two. The middle one is the whole point: a status that
// is neither entitled nor a lapse must be able to say so, rather than being
// forced into a bucket where the wrong guess either gives the product away or
// takes it from someone who is paying.
const GRANT = 'grant'; // ensure the entitlement exists. Safe, idempotent, never gated.
const HOLD = 'hold';   // change nothing. Do not grant, do not revoke, do not start a clock.
const LAPSE = 'lapse'; // not entitled. Start the grace clock; revoke only after it expires.

// Statuses that mean "this person is entitled right now".
// `trialing` is here because a running trial is entitled while it runs. We do
// not SELL trials (a trial of a git repo hands over the product permanently on
// day one), but a seller can configure one on their own Stripe price and must
// not get broken behaviour from us.
const ENTITLED = new Set(['active', 'trialing']);

// Statuses that end entitlement. `unpaid` is here on Stripe's own instruction
// ("Revoke access to your product when the subscription is unpaid because
// payments were already attempted and retried while past_due"), and note it is
// NOT terminal: paying the latest invoice moves it back to active. Only
// `canceled` and `incomplete_expired` are truly terminal. That recoverability
// is exactly what the grace window is for.
const LAPSED = new Set(['canceled', 'unpaid', 'incomplete_expired']);

// Statuses that change nothing.
//   past_due  - Stripe is still retrying the card. A customer with a declined
//               payment is not a former customer. NEVER a lapse. This is the
//               single most important entry in this file.
//   incomplete - inside the 23h first-payment window; not yet entitled, but
//               there is nothing to take away either.
const HELD = new Set(['past_due', 'incomplete']);

// --- paused, which is three different situations wearing one word ------------
// On our pinned API version (2024-06-20) the only documented way to reach
// status=paused is a trial ending with no payment method. But a newer,
// seller-initiated pause also sets it, and those two want opposite treatment:
// a fizzled trial should lapse (nobody is paying, and holding gives the product
// away on every failed trial), while a seller who deliberately paused their own
// customer means to keep them, and overriding that would be us making a
// decision about someone else's customer.
//
// So split by cause instead of picking one action. When the cause cannot be
// determined we HOLD and warn: wrongly revoking a paying customer is the
// failure that ends this product, wrongly retaining one costs a seller some
// revenue and is visible in the warning. Given ambiguous evidence, take the
// recoverable error and surface it for a human.
//
// The cost of that choice, stated so nobody is surprised by it: on 2024-06-20
// `status_details` may be absent entirely, so a genuinely fizzled trial can land
// in the undeterminable branch and be held rather than lapsed. The seller gets a
// WARN naming the subscription and can revoke by hand. That is the recoverable
// direction, which is the point.
function pausedAction(sub) {
  // pause_collection is the classic, seller-initiated pause and exists on our
  // pinned version. Its presence is an explicit statement of intent.
  if (sub && sub.pause_collection) {
    return { action: HOLD, reason: 'paused: seller set pause_collection, keeping access' };
  }
  const type =
    sub && sub.status_details && sub.status_details.paused && sub.status_details.paused.subscription
      ? sub.status_details.paused.subscription.type
      : null;
  if (type === 'trial_end_without_payment_method' || type === 'system') {
    return { action: LAPSE, reason: `paused: ${type}` };
  }
  if (type === 'pause_requested') {
    return { action: HOLD, reason: 'paused: seller requested the pause, keeping access' };
  }
  return {
    action: HOLD,
    warn: true,
    reason:
      'paused for an undeterminable reason, so access is being KEPT. If this is a trial that ' +
      'ended without a payment method, remove the collaborator by hand',
  };
}

// What a subscription's status means for entitlement.
// Returns { action, reason, warn? }. `warn` asks the caller to log it loudly.
function subscriptionAction(sub) {
  const status = sub && typeof sub.status === 'string' ? sub.status : null;
  if (status === 'paused') return pausedAction(sub);
  if (ENTITLED.has(status)) return { action: GRANT, reason: status };
  if (LAPSED.has(status)) return { action: LAPSE, reason: status };
  if (HELD.has(status)) return { action: HOLD, reason: status };
  // Forward compatibility, and it is a safety control rather than a formality.
  // If Stripe adds a status in 2027 the failure mode must be "we kept paying
  // customers in", never "we removed everyone whose status we could not parse".
  return {
    action: HOLD,
    warn: true,
    reason: `unrecognized subscription status ${JSON.stringify(status)}, access is being KEPT`,
  };
}

// --- identity ---------------------------------------------------------------
// GitHub usernames are case-insensitive: Octocat and octocat are one person.
// Every comparison and every state key normalizes, or the reconciler manages to
// both double-invite someone and then fail to revoke them.
function normalizeUser(u) {
  return typeof u === 'string' ? u.trim().toLowerCase() : '';
}

function grantKey(repo, user) {
  return `${String(repo).toLowerCase()}|${normalizeUser(user)}`;
}

// --- seats ------------------------------------------------------------------
// A team subscription is one purchase and N GitHub usernames. Multi-seat
// BEHAVIOUR is not built yet, but the shape is a list from the first commit so
// that adding it later is a feature, not a schema migration. Nothing downstream
// may assume one username per subscription.
//
// Phase 2 will union in a seller-maintained roster from subscription metadata
// and cap it at items.data[].quantity. Until then the list is exactly the
// person who checked out, which is why this returns an array of one rather than
// a string.
function seatUsernames(primaryUser) {
  const u = normalizeUser(primaryUser);
  return u ? [u] : [];
}

// Which configured repos a subscription grants. Matched by price id, the same
// way a one-time grant matches: a subscription's items carry the recurring
// price, so `price` in the config is the join. A subscription matching no grant
// is not ours to enforce and is skipped entirely.
function subscriptionRepos(sub, grants) {
  const prices = new Set(
    ((sub && sub.items && sub.items.data) || []).map((i) => i && i.price && i.price.id).filter(Boolean)
  );
  const repos = (Array.isArray(grants) ? grants : [])
    .filter((g) => g && g.price && prices.has(g.price) && g.repo)
    .map((g) => g.repo);
  return [...new Set(repos)];
}

// --- desired state ----------------------------------------------------------
// Entitlement is a COMPUTED SET, not an event: desired = f(subscriptions,
// config). Every pass recomputes it and diffs against what we granted, so plan
// upgrades, downgrades, seat changes and repo changes all fall out of one diff
// instead of each needing its own code path and its own bug.
//
// `subUsers` maps subscription id -> the username that checked out, learned
// from the Checkout Session. A subscription we have no username for cannot be
// acted on in either direction and is reported, never guessed at.
// Returns:
//   desired - pairs that should have access right now.
//   held    - pairs whose subscription says "change nothing". These are NOT in
//             desired, and the difference matters enormously: without this set
//             a HOLD would be indistinguishable from a lapse, because both are
//             simply absent from `desired`, and a past_due customer would start
//             a grace clock and eventually be revoked. That is the exact
//             failure this whole design exists to prevent, so HOLD is carried
//             explicitly rather than inferred from an absence.
//
// Protection is carried TWICE, by subscription id and by (repo, user) pair,
// because neither covers the other. See the two comments inside.
function desiredEntitlements(subs, subUsers, grants) {
  const desired = new Map(); // grantKey -> { repo, user, sub, reason }
  const heldSubs = new Set(); // subscription ids that must not lapse
  const heldPairs = new Set(); // grantKeys that must not lapse
  const notes = [];
  for (const sub of Array.isArray(subs) ? subs : []) {
    if (!sub || !sub.id) continue;
    const { action, reason, warn } = subscriptionAction(sub);
    if (warn) notes.push({ sub: sub.id, message: reason });
    if (action === LAPSE) continue;

    // Protection is recorded per SUBSCRIPTION, before anything else can go
    // wrong, and this is deliberate. Everything below can fail to resolve: the
    // username may not be known yet, the price may have moved to a plan this
    // config does not name. If protection were recorded ONLY per (repo, user)
    // pair, every one of those failures would leave an existing grant looking
    // unwanted, and an unwanted grant lapses and is eventually revoked. That
    // would mean a paying customer loses access because WE lost track of their
    // username, which is precisely the failure this file exists to prevent.
    // A subscription that is not lapsed protects its grants, full stop.
    heldSubs.add(sub.id);

    const repos = subscriptionRepos(sub, grants);
    const users = seatUsernames(subUsers[sub.id]);

    // And protection is ALSO recorded per pair, for the case the id cannot
    // reach. A grant record names the one subscription it was written from, and
    // nothing refreshes it. When a customer re-subscribes, Stripe cancels the
    // old subscription and opens a new one, so the id on the record is dead and
    // a hold on the live subscription never finds their grant. Held pairs close
    // that gap: whoever a non-lapsed subscription resolves to is protected by
    // name, whichever subscription happened to be recorded. This is computed
    // for every non-lapsed subscription and not only for granting ones, because
    // past_due is precisely the status that must protect without granting.
    for (const repo of repos) for (const user of users) heldPairs.add(grantKey(repo, user));

    if (action !== GRANT) continue;
    if (repos.length === 0) {
      notes.push({ sub: sub.id, message: `is ${reason} but its price matches no configured product, so it cannot be granted` });
      continue;
    }
    if (users.length === 0) {
      notes.push({ sub: sub.id, message: `is ${reason} but no GitHub username is known for it, so it cannot be granted` });
      continue;
    }
    for (const repo of repos) {
      for (const user of users) {
        desired.set(grantKey(repo, user), { repo, user, sub: sub.id, reason });
      }
    }
  }
  return { desired, heldSubs, heldPairs, notes };
}

// --- grace ------------------------------------------------------------------
const DEFAULT_GRACE_DAYS = 7;

// After Stripe's own dunning has already run its course (weeks: the default
// Smart Retry policy is 8 tries over 2 weeks, configurable up to 2 months, and
// past_due is a HOLD for us throughout), the customer gets another full week.
// A card that failed while someone was on holiday does not cost them access.
function graceExpired(lapsedSince, graceDays, now) {
  const started = Date.parse(lapsedSince);
  if (!Number.isFinite(started)) return false; // unparseable: never revoke on it
  const days = Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : DEFAULT_GRACE_DAYS;
  return now - started >= days * 86_400_000;
}

// --- the diff ---------------------------------------------------------------
// THE central safety property: we only ever revoke a pair that WE recorded
// ourselves as having granted from a subscription. This never derives "who
// belongs here" from the repo's collaborator list, which means the seller,
// their team, contributors, one-time buyers, manually added collaborators and
// every customer from before this feature existed are safe by construction
// rather than by a check somebody could forget. Most mass-revocation disasters
// come from a reconciler that treats the remote system as the thing to be
// corrected; this one treats only its own records as authoritative.
//
// Returns:
//   grants   - pairs to invite now. Always safe, never gated by the breaker.
//   lapsing  - pairs whose grace clock should start (or keep running).
//   due      - pairs whose grace has expired and which may now be revoked.
//   keep     - pairs still entitled, whose clock must be cleared.
//   refresh  - pairs whose record names a subscription that is no longer the
//              one entitling them, so the record can be re-pointed at the live
//              one. Without this a record keeps a dead id for good, and every
//              log line about that customer names a subscription the seller
//              will not find in their dashboard.
function diffEntitlements(desired, records, { graceDays = DEFAULT_GRACE_DAYS, now = Date.now(), knownRepos = null, heldSubs = null, heldPairs = null } = {}) {
  const out = { grants: [], lapsing: [], due: [], keep: [], refresh: [] };

  for (const [key, want] of desired) {
    const rec = records[key];
    if (!rec) { out.grants.push(want); continue; }
    if (rec.lapsed_since) out.keep.push({ key, ...rec });
    if (rec.sub !== want.sub) out.refresh.push({ key, from: rec.sub, sub: want.sub, repo: want.repo, user: want.user });
  }

  for (const [key, rec] of Object.entries(records || {})) {
    if (desired.has(key)) continue;
    // Suppressed means something other than a lapse already removed this
    // person, in practice a refund or a dispute. Without this the reconciler
    // sees an entitled subscription with no grant and helpfully re-invites the
    // customer the refund guard just removed, forever.
    if (rec.suppressed) continue;
    // The subscription behind this grant is alive and not lapsed: entitled,
    // held, or entitled-but-unresolvable. past_due is the case that matters
    // most, and it must not even START a clock, because Stripe is still
    // retrying the card and this person has not left.
    if (heldSubs && heldSubs.has(rec.sub)) continue;
    // The same protection reached by name rather than by id, for the customer
    // whose live subscription is not the one on their record.
    if (heldPairs && heldPairs.has(key)) continue;
    // A repo that has left the config is OUT OF SCOPE, not a mass cancellation.
    // "The seller removed a product from config" and "the seller wants every
    // customer of that product kicked out" are indistinguishable from here, and
    // the first is far more common. This kills the largest mass-revocation
    // vector at the source rather than leaving the circuit breaker to catch it.
    if (knownRepos && !knownRepos.has(String(rec.repo).toLowerCase())) continue;
    if (rec.lapsed_since && graceExpired(rec.lapsed_since, graceDays, now)) {
      out.due.push({ key, ...rec });
    } else {
      out.lapsing.push({ key, ...rec });
    }
  }
  return out;
}

// --- the circuit breaker ----------------------------------------------------
// A pass that would revoke more than a small fraction of currently entitled
// PEOPLE revokes nobody, records what it wanted to do, and alarms.
//
// Denominator is distinct people, not (repo, user) pairs. A customer entitled
// to three repos who lapses is one person losing access, not three
// revocations; counting pairs would inflate every multi-product store's
// numerator by its product count and trip on routine churn.
//
// Threshold, defended: healthy churn for a dev tool subscription is a few
// percent a month, and the worst LEGITIMATE bunching is a cohort whose grace
// expires together after a reconciler outage, bounded by roughly one month of
// churn arriving at once, so around 5%. Ten percent leaves 2x headroom over
// that. Meanwhile the failures this guards against are not in the 10-100 band
// at all: a config typo, an auth failure, a repo rename or a changed API shape
// produce something very near 100%. The gap is close to an order of magnitude,
// so the exact number is not delicate; anything from 5 to 20 works.
const DEFAULT_REVOKE_LIMIT_PERCENT = 10;

// Percentage alone breaks small stores, and small stores are most stores. With
// five subscribers one honest cancellation is 20%, and a percentage-only
// breaker would refuse every real revocation forever, which makes enforcement
// theatre. Three is the largest floor that still cannot meaningfully hurt a
// store: if a four-person store genuinely loses three subscribers in an hour, a
// human being told about it is the right outcome anyway.
const DEFAULT_REVOKE_LIMIT_FLOOR = 3;

function distinctUserSet(pairs) {
  return new Set((pairs || []).map((p) => normalizeUser(p.user)));
}

function distinctUsers(pairs) {
  return distinctUserSet(pairs).size;
}

// Verdict on whether this pass may revoke at all. All or nothing: the breaker
// does NOT revoke up to the limit and stop. Partial application under a
// suspected bug is mass revocation in slow motion, each pass taking its three,
// alarming, and draining the store over a day while looking like it is
// behaving. Refuse the entire pass.
//
// `opts.override` is the seller saying "this mass cancellation is real, do it".
// It relaxes the size limit and NOTHING ELSE: the zero-subscriptions guard
// below is not overridable by anything, because "Stripe returned nothing" is
// never what a genuine mass cancellation looks like, it is what a broken key
// looks like, and a seller who has decided to enforce a real exodus has not
// thereby decided to trust a response they never saw.
//
// Returns `sweep` when a pass leaves nobody entitled at all. That can be
// perfectly correct for a small store under the floor, and it is still the
// single most consequential thing this program can do, so it is flagged for the
// caller to say out loud rather than performed in the same tone as routine churn.
function breakerVerdict(due, entitledPairs, opts = {}) {
  const percent = Number.isFinite(opts.percent) ? opts.percent : DEFAULT_REVOKE_LIMIT_PERCENT;
  const floor = Number.isFinite(opts.floor) ? opts.floor : DEFAULT_REVOKE_LIMIT_FLOOR;
  const dueSet = distinctUserSet(due);
  const people = dueSet.size;
  if (people === 0) return { allowed: true, people, limit: 0, sweep: false, reason: 'nothing to revoke' };

  // Independent guard, checked first because its CAUSE is different and the
  // operator should be told which of the two happened. Stripe returning zero
  // subscriptions while we hold grants is the signature of a wrong API key, a
  // wrong account, or a changed response shape, not of every customer quitting
  // at the same moment.
  if (opts.enumeratedSubs === 0) {
    return {
      allowed: false,
      people,
      limit: 0,
      sweep: false,
      overridable: false,
      reason:
        'Stripe returned ZERO subscriptions while this store still holds active grants. That is a ' +
        'wrong API key, the wrong account, or a changed API response, not every customer leaving at once',
    };
  }

  const entitledSet = distinctUserSet(entitledPairs);
  const entitled = entitledSet.size;
  const limit = Math.max(floor, Math.floor((entitled * percent) / 100));
  const sweep = entitled === 0;
  // The population this pass started from, counted as a union rather than a
  // sum: somebody entitled on one repo and lapsed on another is one person, and
  // adding the two counts would report more subscribers than the store has.
  //
  // Reported as "N of TOTAL" and never "N of entitled". Once everyone has
  // lapsed the entitled count is zero, and "would revoke 12 of 0 subscribers"
  // is a sentence that makes a worried seller trust the tool less, which is the
  // opposite of what the most important line in this program should do.
  const total = new Set([...entitledSet, ...dueSet]).size;
  if (people > limit) {
    if (opts.override) {
      return {
        allowed: true,
        people,
        limit,
        total,
        sweep,
        overridden: true,
        reason: `${people} of ${total} subscribers, over the safety limit of ${limit}, allowed for this run only`,
      };
    }
    return {
      allowed: false,
      people,
      limit,
      total,
      sweep,
      overridable: true,
      reason:
        `this pass would revoke ${people} of ${total} subscribers, over the safety limit of ${limit} ` +
        `(the larger of ${floor} people or ${percent}% of subscribers)`,
    };
  }
  return { allowed: true, people, limit, total, sweep, reason: 'within the safety limit' };
}

// --- logging ----------------------------------------------------------------
// Every revocation is loud and reversible. The line lands in the vocabulary the
// watchdog already greps (ALERT_RE matches /FAILED|WARN:|BOTS FAILED|^CONFIG /)
// and carries everything needed to undo it by hand in seconds, including the
// literal command. A seller reading this at 3am should not have to work
// anything out.
// `confirmed` is false when GitHub answered 404: the account is not a
// collaborator under THAT name, which is usually because it never was, but is
// also what a renamed GitHub account looks like. Saying "REVOKED" there would
// report that access was taken away when possibly nothing was, so the two cases
// get different words and the uncertain one says what to check.
function revokeLine(pair, { dryRun = false, confirmed = true } = {}) {
  const verb = dryRun
    ? 'WOULD REVOKE (reporting only, nothing was changed)'
    : confirmed
      ? 'REVOKED'
      : 'REVOKED, UNCONFIRMED:';
  const tail = confirmed || dryRun
    ? `Undo: gh api -X PUT repos/${pair.repo}/collaborators/${pair.user} -f permission=pull`
    : `GitHub answered 404, so nobody by that name is a collaborator and the removal could not be ` +
      `confirmed. If they renamed their GitHub account they may still have access under the new name. ` +
      `Check: gh api repos/${pair.repo}/collaborators`;
  return (
    `WARN: ${verb} ${pair.user} from ${pair.repo} ` +
    `(subscription ${pair.sub} ${pair.reason || 'lapsed'}, grace expired; lapsed since ${pair.lapsed_since}). ` +
    tail
  );
}

// Capped, because the whole point of this line is that it gets read. A store
// that loses two hundred people at once produces two hundred names, and a wall
// of text is skimmed exactly as fast as no text at all. The state file keeps the
// full list in `breaker.would_revoke` for anyone who needs every name.
const HELD_BACK_SHOWN = 10;

function breakerLine(verdict, due) {
  const names = due.map((p) => `${p.user}@${p.repo}`);
  const who = names.length > HELD_BACK_SHOWN
    ? `${names.slice(0, HELD_BACK_SHOWN).join(', ')}, and ${names.length - HELD_BACK_SHOWN} more`
    : names.join(', ');
  // Only a size refusal can be overridden, so only a size refusal is told about
  // the flag. Naming it on the zero-subscriptions refusal would invite a seller
  // to force their way past the one guard that is never wrong.
  const next = verdict.overridable
    ? `Check the store config and the Stripe key first. If this really is a mass cancellation and you ` +
      `want it enforced, re-run once with --allow-mass-revocation.`
    : `Check the store config and the Stripe key, then re-run.`;
  return (
    `WARN: REVOCATION REFUSED, nothing was changed. ${verdict.reason}. ` +
    `Held back: ${who}. ${next} ` +
    `This is the safety limit doing its job, not a delivery failure`
  );
}

// Said before a pass that empties the store, whether it got there under the
// floor or under an explicit override. A seller should never discover that
// their last subscriber was removed by noticing nobody is left.
function sweepLine(verdict) {
  return (
    `WARN: this pass removes ${verdict.people} subscriber(s) and leaves NOBODY entitled on this store. ` +
    (verdict.overridden
      ? 'It was allowed because --allow-mass-revocation was passed for this run.'
      : 'It was allowed because the store is small enough to sit under the safety floor.') +
    ' If that is not what you expected, check the Stripe key and the store config now'
  );
}

// --- what is about to happen -------------------------------------------------
// The question a seller actually has before arming enforcement is not "what did
// this pass do", it is "what is this about to do to my customers". Nothing
// answered that. A person three days into a seven day grace produces no output
// at all: their clock started on an earlier pass, the start was logged then, and
// nothing is printed again until the day they are removed. A seller reading a
// quiet log would reasonably conclude there was nothing pending, arm
// enforcement, and be surprised.
//
// Sorted soonest first, because the only one that needs a decision today is the
// one at the top.
function upcomingRevocations(lapsing, graceDays, now) {
  return (Array.isArray(lapsing) ? lapsing : [])
    .map((p) => {
      const started = Date.parse(p.lapsed_since);
      const dueAt = Number.isFinite(started) ? started + graceDays * 86_400_000 : null;
      return {
        user: p.user,
        repo: p.repo,
        sub: p.sub,
        dueAt,
        // Rounded up, so "in 1 day" never means "in a few minutes".
        days: dueAt == null ? null : Math.max(0, Math.ceil((dueAt - now) / 86_400_000)),
      };
    })
    .sort((a, b) => (a.dueAt == null ? Infinity : a.dueAt) - (b.dueAt == null ? Infinity : b.dueAt));
}

// One line, capped. A store with two hundred people in grace must not print two
// hundred lines nobody reads; the soonest few and a count carry the same
// decision.
const UPCOMING_SHOWN = 5;

function upcomingLine(rows, { enforce = false } = {}) {
  if (!rows || rows.length === 0) return null;
  const shown = rows
    .slice(0, UPCOMING_SHOWN)
    .map((r) => (r.days == null ? `${r.user}@${r.repo} never (its lapse date is unreadable)` : `${r.user}@${r.repo} in ${r.days}d`))
    .join(', ');
  const more = rows.length > UPCOMING_SHOWN ? `, and ${rows.length - UPCOMING_SHOWN} more` : '';
  return (
    `subscriptions: ${rows.length} customer(s) in grace, ` +
    `${enforce ? 'and will be removed when it runs out' : 'and would be removed if enforcement were on'}. ` +
    `Soonest: ${shown}${more}`
  );
}

// --- config -----------------------------------------------------------------
// Reported in the same shape as grantProblems: a CONFIG line a human can act
// on, never a crash and never a silent default that hides a typo.
function subscriptionConfigProblems(subs) {
  const out = [];
  if (subs == null) return out; // absent is the supported default: feature off
  if (typeof subs !== 'object' || Array.isArray(subs)) {
    return ['subscriptions must be an object, so subscription enforcement is OFF'];
  }
  if ('enforce' in subs && typeof subs.enforce !== 'boolean') {
    out.push(`subscriptions.enforce must be true or false, not ${JSON.stringify(subs.enforce)}; treating it as false`);
  }
  if ('grace_days' in subs) {
    const g = subs.grace_days;
    if (typeof g !== 'number' || !Number.isFinite(g) || g < 0 || g > 90) {
      out.push(
        `subscriptions.grace_days must be a number of days from 0 to 90, not ${JSON.stringify(g)}; ` +
          `using the default of ${DEFAULT_GRACE_DAYS}`
      );
    } else if (g < 3) {
      // Allowed, because it is the seller's business, but a seller typing this
      // is more likely to be guessing than to have decided.
      out.push(
        `subscriptions.grace_days is ${g}: a customer whose card fails will lose access almost immediately ` +
          `after Stripe stops retrying. ${DEFAULT_GRACE_DAYS} is the default for a reason`
      );
    }
  }
  for (const [key, label] of [['revoke_limit_percent', 'a percentage from 1 to 100'], ['revoke_limit_floor', 'a whole number of people, 1 or more']]) {
    if (!(key in subs)) continue;
    const v = subs[key];
    const ok = typeof v === 'number' && Number.isFinite(v) && v >= 1 && (key === 'revoke_limit_percent' ? v <= 100 : true);
    if (!ok) out.push(`subscriptions.${key} must be ${label}, not ${JSON.stringify(v)}; using the default`);
  }
  return out;
}

module.exports = {
  GRANT,
  HOLD,
  LAPSE,
  DEFAULT_GRACE_DAYS,
  DEFAULT_REVOKE_LIMIT_PERCENT,
  DEFAULT_REVOKE_LIMIT_FLOOR,
  subscriptionAction,
  normalizeUser,
  grantKey,
  seatUsernames,
  subscriptionRepos,
  desiredEntitlements,
  graceExpired,
  diffEntitlements,
  distinctUsers,
  breakerVerdict,
  revokeLine,
  breakerLine,
  sweepLine,
  upcomingRevocations,
  upcomingLine,
  subscriptionConfigProblems,
};
