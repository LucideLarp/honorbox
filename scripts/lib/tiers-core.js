// Seat tiers: the same product sold at more than one price, each tier granting
// the same repo to a different number of developers.
//
// Pure logic only, so the two decisions that can cost money are pinned by tests
// rather than by whoever last read the driver:
//
//   reusablePrice  never sells at a price the operator did not ask for
//   mergeGrants    never duplicates or silently re-points a fulfillment grant
//
// The driver (scripts/add-tier.js) does the IO around these and nothing else.
'use strict';

// A price is looked up by a deterministic key rather than by amount, so a
// second run finds the price it made the first time instead of creating a
// parallel one. Stripe requires lookup keys to be unique per account.
function lookupKeyFor(productId, tier) {
  return `${productId}__${tier}`.toLowerCase().replace(/[^a-z0-9_]+/g, '-');
}

// Reuse an existing price ONLY if it still means what the operator just asked
// for. A price is immutable in Stripe: its amount cannot be corrected in place.
// So a lookup key that already points at a different amount is not a price to
// reuse, it is a contradiction between the command and the account, and the
// only safe answer is to stop.
//
// Silently reusing it would sell the tier at yesterday's number forever, with a
// store page advertising today's. Silently creating a second price would leave
// two live prices under one key and make the next run ambiguous. Both are worse
// than refusing.
function reusablePrice(existing, want) {
  if (!existing) return { use: null };
  if (existing.active === false) {
    return { error: `price ${existing.id} for this tier is archived in Stripe. Restore it, or remove its lookup key, then re-run.` };
  }
  if (existing.unit_amount !== want.unit_amount || existing.currency !== want.currency) {
    return {
      error: `this tier already has price ${existing.id} at `
        + `${existing.unit_amount} ${String(existing.currency).toUpperCase()}, and you asked for `
        + `${want.unit_amount} ${String(want.currency).toUpperCase()}. A Stripe price cannot be repriced. `
        + 'Create a new tier id for the new number, and archive the old link when nobody is mid-checkout.',
    };
  }
  return { use: existing };
}

// Fulfillment grants are matched by payment link id, so two grants carrying the
// same link is not a tidiness problem: matchGrant() returns the first, and the
// second is dead config that reads as if it were doing something.
//
// Re-pointing an existing grant at a different repo is refused rather than
// applied. That edit means paid customers of this tier stop receiving what they
// bought, and it is far more often a typo'd --repo than an intention.
function mergeGrants(grants, grant) {
  const list = Array.isArray(grants) ? grants : [];
  const at = list.findIndex((g) => g && g.payment_link === grant.payment_link);
  if (at === -1) return { grants: [...list, grant], added: true };

  const held = list[at];
  if (held.repo !== grant.repo) {
    return {
      error: `payment link ${grant.payment_link} already grants ${held.repo} and you asked for ${grant.repo}. `
        + 'Re-pointing a live grant stops delivering what this tier\'s existing buyers paid for. '
        + 'Edit store.config.json by hand if that is really what you want.',
    };
  }
  // Same link, same repo: the run is a repeat. Keep the file byte-stable so a
  // re-run produces no diff at all, which is what makes this safe to schedule.
  return { grants: list, added: false };
}

// One tier's payment link. Extends the engine's standard link shape (the
// github_username field fulfillment reads) with the seat count, so the tier a
// buyer chose is legible on the Stripe object itself and not only in our config.
//
// allow_promotion_codes stays off for the reason init.js documents: an open
// promo field is a live discount surface on a money path.
// `invoice` turns on a post-purchase invoice and business tax ID collection.
// It is off by default and deliberately a decision rather than a default: a
// company buyer usually cannot expense a receipt, but collecting a customer's
// VAT number changes what the SELLER has to do at filing time, and that is not
// a choice a tool should make for them. Stripe pairs the two on purpose, and
// the tax ID is what puts the company's name and number on the invoice.
function tierLinkParams(priceId, repo, tier, seatsLabel, opts = {}) {
  const invoice = opts.invoice
    ? {
      'invoice_creation[enabled]': 'true',
      'tax_id_collection[enabled]': 'true',
    }
    : {};
  return {
    ...invoice,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'custom_fields[0][key]': 'github_username',
    'custom_fields[0][label][type]': 'custom',
    'custom_fields[0][label][custom]': 'GitHub username (for repo access)',
    'custom_fields[0][type]': 'text',
    'metadata[honorbox_tier]': tier,
    'after_completion[type]': 'hosted_confirmation',
    'after_completion[hosted_confirmation][custom_message]':
      `You're in. The fulfillment bot will invite your GitHub account to the private ${repo} repository, `
      + `usually within 30 minutes, always within a few hours. This licence covers ${seatsLabel}: `
      + 'reply to your Stripe receipt with your teammates\' GitHub usernames and they will be added. '
      + 'No invite? Reply to the receipt and it will be fixed or refunded.',
    allow_promotion_codes: 'false',
  };
}

module.exports = { lookupKeyFor, reusablePrice, mergeGrants, tierLinkParams };
