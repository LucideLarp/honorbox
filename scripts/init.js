#!/usr/bin/env node
// HonorBox init — from zero to a sellable product in one command.
//
//   STRIPE_SECRET_KEY=rk_... node scripts/init.js \
//     --name "My Tool" --price 2900 --currency usd --repo you/my-tool-access
//
// Creates on your Stripe account:  Product -> Price -> Payment Link with the
// required github_username field and a delivery confirmation message.
// Promotion codes are OFF by default — see paymentLinkParams. Then wires everything into store.config.json and
// scaffolds products/<id>.md. Idempotent-ish: run once per product.
//
// Optional: --id <slug>  --config <path>  --products <dir>  --dry-run
// Zero dependencies. Read-only on Stripe until you confirm (or pass --yes).
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Both spellings, because half the world types --price=2900 and the other half
// types --price 2900. Accepting only the second produced the worst possible
// error: `--price=2900` was parsed as an unknown token, `--price` came back
// undefined, and init died with "--price is required" at a user who had just
// supplied it. An error that contradicts what the operator can see on their own
// command line sends them hunting through the wrong file.
function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const KNOWN_FLAGS = ['name', 'price', 'currency', 'repo', 'id', 'config', 'products', 'dry-run', 'yes', 'help'];

// Switches take no value. `has()` matches the exact token, so `--dry-run=true`
// evaluated FALSE while passing flag validation: a command that literally says
// dry-run created live Stripe objects on the operator's account. Refuse the
// spelling instead of interpreting it — `--dry-run=false` is the same trap
// pointing the other way, and on a money path an ambiguous switch should stop,
// not guess.
const SWITCHES = ['dry-run', 'yes', 'help'];
function switchesWithValues(argv) {
  return argv
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => a.slice(2).split('=')[0])
    .filter((f) => SWITCHES.includes(f));
}

// A typo'd flag used to be discarded in silence, so `--reppo you/x` died with
// "--repo is required" — technically true and completely unhelpful. Worse, a
// typo'd --repo on a real run would have created live Stripe objects pointing
// at nothing. Name the token we did not understand.
function unknownFlags(argv) {
  return argv
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
    .filter((f) => !KNOWN_FLAGS.includes(f));
}

const SK = process.env.STRIPE_SECRET_KEY;
const name = arg('name');
const priceCents = parseInt(arg('price', ''), 10);
const currency = (arg('currency', 'usd') || 'usd').toLowerCase();
const repo = arg('repo');
const id = arg('id', (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
const configPath = arg('config', 'store.config.json');
const productsDir = arg('products', 'products');

function die(msg) { console.error(`init: ${msg}`); process.exit(2); }

// Node's fetch has no overall timeout, so a connection that opens and then
// never answers hangs this process forever: no output, no error, nothing to
// tell the operator whether Stripe is down or their key is wrong. That is a
// bad failure for the very first command anyone runs against their own
// account. 20s matches the fulfillment path, which carries the same deadline
// for the same reason.
const REQUEST_TIMEOUT_MS = 20_000;

async function stripe(pathname, form) {
  let res;
  try {
    res = await fetch(`https://api.stripe.com${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(SK + ':').toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // No HTTP verdict at all: DNS, a reset, or our own deadline. Name the
    // error class, because "TimeoutError" and "ENOTFOUND" send the reader to
    // different places. Nothing has been created at this point.
    throw new Error(`${pathname}: no response from Stripe (${err.name}: ${err.message}). Nothing was created.`);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`${pathname}: ${body.error ? body.error.message : res.status}`);
  return body;
}

// Payment link form. Pure so the defaults are pinned by a test rather than by
// whoever last read the file.
//
// allow_promotion_codes is OFF deliberately. A link with the promo field open
// is a live discount surface on a money path, and the seller who later makes a
// 100%-off code to test delivery has handed that code's value to anyone who
// guesses it — we did exactly that to ourselves on 2026-07-20 and found two
// live 100%-off codes on our own checkout the day before a launch. Sellers who
// want typed codes can enable it per link in the Stripe Dashboard, which is the
// right direction for a default that costs money when it is wrong.
function paymentLinkParams(priceId, repo) {
  return {
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'custom_fields[0][key]': 'github_username',
    'custom_fields[0][label][type]': 'custom',
    'custom_fields[0][label][custom]': 'GitHub username (for repo access)',
    'custom_fields[0][type]': 'text',
    'after_completion[type]': 'hosted_confirmation',
    'after_completion[hosted_confirmation][custom_message]':
      `You're in. The fulfillment bot will invite your GitHub account to the private ${repo} repository — usually within 30 minutes, always within a few hours. No invite? Reply to your Stripe receipt and it will be fixed or refunded.`,
    allow_promotion_codes: 'false',
  };
}

async function confirm(question) {
  if (has('yes')) return true;
  // Non-interactive stdin — a pipe, CI, a devcontainer task, `| tee init.log` —
  // never delivers an answer. readline's callback simply never fires, the event
  // loop drains, and node exits 0 having created nothing and said nothing. A
  // scripted caller reads that exit 0 as success and carries on. Refuse loudly
  // rather than appearing to ask a question nobody can answer.
  if (!process.stdin.isTTY) {
    die('stdin is not a terminal, so nothing can answer this prompt. Re-run with --yes to create the objects, or --dry-run to see them without creating anything.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const created = []; // Stripe objects made so far, reported if a later step dies

async function main() {
  const unknown = unknownFlags(process.argv.slice(2));
  if (unknown.length) {
    die(`unknown flag${unknown.length > 1 ? 's' : ''} ${unknown.map((f) => `--${f}`).join(', ')}. Known flags: ${KNOWN_FLAGS.map((f) => `--${f}`).join(' ')}`);
  }
  const valued = switchesWithValues(process.argv.slice(2));
  if (valued.length) {
    die(`${valued.map((f) => `--${f}`).join(', ')} ${valued.length > 1 ? 'are switches' : 'is a switch'} and take${valued.length > 1 ? '' : 's'} no value. Write --${valued[0]} on its own, or leave it off.`);
  }
  // --dry-run touches nothing, so demanding a key for it turns away the most
  // sensible first move a stranger can make: seeing what this would do before
  // handing it credentials.
  if (!SK && !has('dry-run')) die('set STRIPE_SECRET_KEY (a restricted key with write on Products and Payment Links; prices are created under Products)');
  if (!name) die('--name is required');
  if (!Number.isInteger(priceCents) || priceCents < 100) die('--price is required, in cents (e.g. 2900 = $29.00)');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die('--repo owner/private-product-repo is required');
  if (!id) die('could not derive an id from --name; pass --id');

  // Read the config BEFORE creating anything: it is written to at the end,
  // and failing only then would leave a live payment link with no
  // fulfillment grant wired (paid orders that never deliver).
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    die(`cannot read ${configPath} (${e.message}); run from your store repo or pass --config`);
  }

  const priceHuman = `${currency === 'usd' ? '$' : ''}${(priceCents / 100).toFixed(priceCents % 100 ? 2 : 0)}${currency === 'usd' ? '' : ' ' + currency.toUpperCase()}`;
  console.log(`\nThis will create LIVE Stripe objects on your account:`);
  console.log(`  product   ${name}`);
  console.log(`  price     ${priceHuman} one-time`);
  console.log(`  link      Payment Link with required "GitHub username" field`);
  console.log(`  delivery  invite to ${repo}\n`);
  if (has('dry-run')) { console.log('dry run — nothing created.'); return; }
  if (!(await confirm('Create them?'))) { console.log('aborted.'); return; }

  const product = await stripe('/v1/products', { name });
  created.push(`product ${product.id}`);
  const price = await stripe('/v1/prices', {
    product: product.id, unit_amount: String(priceCents), currency,
  });
  created.push(`price ${price.id}`);
  const link = await stripe('/v1/payment_links', paymentLinkParams(price.id, repo));
  created.push(`payment link ${link.id}`);
  console.log(`created: ${product.id} / ${price.id} / ${link.id}`);

  // wire config (parsed and validated up front)
  config.fulfillment = config.fulfillment || [];
  config.fulfillment.push({ payment_link: link.id, product: name, repo, price: price.id });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  // scaffold product page
  fs.mkdirSync(productsDir, { recursive: true });
  const mdPath = path.join(productsDir, `${id}.md`);
  if (!fs.existsSync(mdPath)) {
    fs.writeFileSync(mdPath, `---
id: ${id}
name: ${name}
tagline: One sentence on why this is worth buying.
price: ${priceHuman}
price_note: one-time · lifetime access & updates
payment_link: ${link.url}
features:
  - What the buyer gets, concretely
  - Another concrete thing
  - A third one
---

## What this is

Sell it here. What problem it solves, who it's for, what's inside.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that
account to the private repository — usually within 30 minutes. You keep
access permanently; updates land in the same repo.
`);
    console.log(`scaffolded: ${mdPath}`);
  } else {
    // The template ships products/honorbox-pro.md and products/crew.md. A
    // seller whose --name derives one of those ids had their write skipped in
    // silence and was then told to "edit" a page whose Buy button still charges
    // into HonorBox's Stripe account.
    const current = /payment_link:\s*(\S+)/.exec(fs.readFileSync(mdPath, 'utf8'));
    console.log(`NOT scaffolded: ${mdPath} already exists, so it was left untouched.`);
    if (current && current[1] !== link.url) {
      console.log(`  WARNING: that page's payment_link is ${current[1]}`);
      console.log(`  which is NOT the link just created. Until you replace it, this page sells somebody else's product.`);
      console.log(`  Replace it with: ${link.url}`);
    }
  }

  console.log(`\nDone. Next:
  1. Make ${repo} a private repo containing what buyers get
  2. Edit ${mdPath} (tagline, features, pitch)
  3. Delete every products/*.md you are not selling, and set "repo" in
     ${configPath} to your own storefront repo. The build refuses to publish a
     store that still carries HonorBox's checkout links, and will list them.
  4. Copy the updated ${configPath} into your private ops repo — the fulfillment
     engine reads its grants from THAT copy, so a grant added here is not live
     until it is copied across
  5. node scripts/build.js && deploy
  6. Set up the fulfillment cron (docs/setup.md §5) if you haven't\n
Checkout URL: ${link.url}`);
}

module.exports = { paymentLinkParams };

if (require.main === module) main().catch((e) => {
  if (created.length) {
    console.error(`init: FAILED PARTWAY. Already live on Stripe (archive in the Dashboard, or re-run and reuse): ${created.join(', ')}`);
  }
  die(e.message);
});
