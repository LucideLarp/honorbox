#!/usr/bin/env node
// HonorBox add-tier: sell a product you already sell at a second seat price.
//
//   STRIPE_SECRET_KEY=sk_... node scripts/add-tier.js \
//     --product prod_123 --tier team --price 9900 --seats "up to 5 developers" \
//     --repo you/my-tool-access
//
// Creates, on your Stripe account: a Price under an existing Product, and a
// Payment Link carrying the github_username field fulfillment reads. Then wires
// the fulfillment grant into store.config.json.
//
// SAFE TO RE-RUN. The price is found by a deterministic lookup key and the link
// by its tier metadata, so a second run reports what already exists and creates
// nothing. That is what makes this usable from a script, and it is why the two
// refusals in lib/tiers-core.js exist: a re-run that quietly created a parallel
// price, or quietly re-pointed a grant, would be worse than one that stopped.
//
// Optional: --currency usd  --config <path>  --dry-run  --yes
// Zero dependencies. Node >= 20.
'use strict';

const fs = require('fs');
const { lookupKeyFor, reusablePrice, mergeGrants, tierLinkParams } = require('./lib/tiers-core.js');

const SK = process.env.STRIPE_SECRET_KEY;
const REQUEST_TIMEOUT_MS = 20_000;

const KNOWN_FLAGS = ['product', 'tier', 'price', 'seats', 'repo', 'currency', 'config', 'invoice', 'dry-run', 'yes', 'help'];
const SWITCHES = ['invoice', 'dry-run', 'yes', 'help'];

function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);
function die(msg) { console.error(`add-tier: ${msg}`); process.exit(1); }

// Same argument hygiene as init.js, and for the same reason: on a money path an
// ambiguous switch must stop rather than guess. `--dry-run=false` reads as
// "off" to a human and as "absent" to has(), which would create live objects
// from a command that says dry-run.
function badFlags(argv) {
  const named = argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]);
  return {
    unknown: named.filter((f) => !KNOWN_FLAGS.includes(f)),
    valued: argv.filter((a) => a.startsWith('--') && a.includes('='))
      .map((a) => a.slice(2).split('=')[0]).filter((f) => SWITCHES.includes(f)),
  };
}

async function stripe(pathname, form, method = 'POST') {
  const url = `https://api.stripe.com${pathname}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(SK + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // The account default is a preview version whose shapes differ. Pinned
        // here for the same reason every other call in this engine pins it.
        'Stripe-Version': '2024-06-20',
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${pathname}: no response from Stripe (${err.name}: ${err.message}). Nothing was created.`);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`${pathname}: ${body.error ? body.error.message : res.status}`);
  return body;
}

const get = (pathname) => stripe(pathname, null, 'GET');

// Payment links cannot be queried by metadata, so the tier's link is found by
// walking the list. Bounded and paged: an account with hundreds of links must
// not silently examine only the first hundred and then create a duplicate.
async function findLinkByTier(tier) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('starting_after', cursor);
    const body = await get(`/v1/payment_links?${qs}`);
    const data = body.data || [];
    const hit = data.find((l) => l.metadata && l.metadata.honorbox_tier === tier);
    if (hit) return hit;
    if (!body.has_more || !data.length) return null;
    cursor = data[data.length - 1].id;
  }
  throw new Error('more payment links than this can page through; find the tier link by hand and wire it into store.config.json');
}

async function main() {
  const { unknown, valued } = badFlags(process.argv.slice(2));
  if (unknown.length) die(`unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((f) => `--${f}`).join(', ')}. Known: ${KNOWN_FLAGS.map((f) => `--${f}`).join(' ')}`);
  if (valued.length) die(`--${valued[0]} is a switch and takes no value. Write it on its own, or leave it off.`);

  const productId = arg('product');
  const tier = arg('tier');
  const cents = Number(arg('price'));
  const seats = arg('seats');
  const repo = arg('repo');
  const currency = (arg('currency', 'usd') || '').toLowerCase();
  const configPath = arg('config', 'store.config.json');

  if (!SK && !has('dry-run')) die('set STRIPE_SECRET_KEY (write on Products and Payment Links)');
  if (!productId || !/^prod_/.test(productId)) die('--product prod_... is required (the Stripe product this tier belongs to)');
  if (!tier || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(tier)) die('--tier is required: lowercase id such as team or company');
  if (!Number.isInteger(cents) || cents < 100) die('--price is required, in cents (9900 = $99.00)');
  if (!seats) die('--seats is required: what the buyer is told this tier covers, e.g. "up to 5 developers"');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die('--repo owner/private-product-repo is required');

  // Read and validate the config BEFORE creating anything. Failing after would
  // leave a live payment link with no grant behind it: paid orders that never
  // deliver, which is the single worst outcome this engine has.
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {
    die(`cannot read ${configPath} (${e.message}); run from your store repo or pass --config`);
  }

  console.log(`\ntier      ${tier} (${seats})`);
  console.log(`price     ${(cents / 100).toFixed(cents % 100 ? 2 : 0)} ${currency.toUpperCase()} one-time`);
  console.log(`product   ${productId}`);
  console.log(`delivery  invite to ${repo}`);
  console.log(`invoice   ${has('invoice') ? 'yes: post-purchase invoice + business tax ID' : 'no (receipt only)'}`);
  console.log(`config    ${configPath}\n`);
  if (has('dry-run')) { console.log('dry run: nothing created, nothing written.'); return; }
  if (!has('yes')) die('re-run with --yes to create these objects, or --dry-run to see them without creating anything.');

  const product = await get(`/v1/products/${productId}`);
  if (product.active === false) die(`product ${productId} is archived; a link on it cannot take money.`);

  // --- price: deterministic key, reused or refused, never duplicated --------
  const lookupKey = lookupKeyFor(productId, tier);
  const found = await get(`/v1/prices?limit=1&lookup_keys[]=${encodeURIComponent(lookupKey)}`);
  const verdict = reusablePrice((found.data || [])[0], { unit_amount: cents, currency });
  if (verdict.error) die(verdict.error);

  let price = verdict.use;
  if (price) {
    console.log(`price     reusing ${price.id} (lookup key ${lookupKey})`);
  } else {
    price = await stripe('/v1/prices', {
      product: productId,
      unit_amount: String(cents),
      currency,
      lookup_key: lookupKey,
      'metadata[honorbox_tier]': tier,
    });
    console.log(`price     created ${price.id}`);
  }

  // --- payment link: one per tier ------------------------------------------
  let link = await findLinkByTier(tier);
  if (link) {
    console.log(`link      reusing ${link.id}`);
    if (!link.active) {
      die(`payment link ${link.id} for tier "${tier}" is deactivated, so its buy button takes nobody's money. `
        + 'Reactivate it in the Stripe dashboard, or remove its honorbox_tier metadata and re-run to make a new one.');
    }
  } else {
    link = await stripe('/v1/payment_links', tierLinkParams(price.id, repo, tier, seats, { invoice: has('invoice') }));
    console.log(`link      created ${link.id}`);
  }

  // --- wire the grant, without duplicating it ------------------------------
  const merged = mergeGrants(config.fulfillment, {
    payment_link: link.id, product: `${product.name} (${tier})`, repo, price: price.id,
  });
  if (merged.error) die(merged.error);
  if (merged.added) {
    config.fulfillment = merged.grants;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`config    grant added for ${link.id}`);
  } else {
    console.log('config    grant already present, file unchanged');
  }

  console.log(`\ncheckout  ${link.url}`);
  console.log('Put that URL in the tier\'s product page (payment_link:) and rebuild.');
}

main().catch((err) => { console.error(`add-tier: ${err.message}`); process.exit(1); });
