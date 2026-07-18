#!/usr/bin/env node
// HonorBox init — from zero to a sellable product in one command.
//
//   STRIPE_SECRET_KEY=sk_... node scripts/init.js \
//     --name "My Tool" --price 2900 --currency usd --repo you/my-tool-access
//
// Creates on your Stripe account:  Product -> Price -> Payment Link with the
// required github_username field, promo codes enabled, and a delivery
// confirmation message. Then wires everything into store.config.json and
// scaffolds products/<id>.md. Idempotent-ish: run once per product.
//
// Optional: --id <slug>  --config <path>  --products <dir>  --dry-run
// Zero dependencies. Read-only on Stripe until you confirm (or pass --yes).
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const SK = process.env.STRIPE_SECRET_KEY;
const name = arg('name');
const priceCents = parseInt(arg('price', ''), 10);
const currency = (arg('currency', 'usd') || 'usd').toLowerCase();
const repo = arg('repo');
const id = arg('id', (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
const configPath = arg('config', 'store.config.json');
const productsDir = arg('products', 'products');

function die(msg) { console.error(`init: ${msg}`); process.exit(2); }

async function stripe(pathname, form) {
  const res = await fetch(`https://api.stripe.com${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(SK + ':').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${pathname}: ${body.error ? body.error.message : res.status}`);
  return body;
}

async function confirm(question) {
  if (has('yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  if (!SK) die('set STRIPE_SECRET_KEY (a restricted key with write on Products, Prices, Payment Links works)');
  if (!name) die('--name is required');
  if (!Number.isInteger(priceCents) || priceCents < 100) die('--price is required, in cents (e.g. 2900 = $29.00)');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) die('--repo owner/private-product-repo is required');
  if (!id) die('could not derive an id from --name; pass --id');

  const priceHuman = `${currency === 'usd' ? '$' : ''}${(priceCents / 100).toFixed(priceCents % 100 ? 2 : 0)}${currency === 'usd' ? '' : ' ' + currency.toUpperCase()}`;
  console.log(`\nThis will create LIVE Stripe objects on your account:`);
  console.log(`  product   ${name}`);
  console.log(`  price     ${priceHuman} one-time`);
  console.log(`  link      Payment Link with required "GitHub username" field`);
  console.log(`  delivery  invite to ${repo}\n`);
  if (has('dry-run')) { console.log('dry run — nothing created.'); return; }
  if (!(await confirm('Create them?'))) { console.log('aborted.'); return; }

  const product = await stripe('/v1/products', { name });
  const price = await stripe('/v1/prices', {
    product: product.id, unit_amount: String(priceCents), currency,
  });
  const link = await stripe('/v1/payment_links', {
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    'custom_fields[0][key]': 'github_username',
    'custom_fields[0][label][type]': 'custom',
    'custom_fields[0][label][custom]': 'GitHub username (for repo access)',
    'custom_fields[0][type]': 'text',
    'after_completion[type]': 'hosted_confirmation',
    'after_completion[hosted_confirmation][custom_message]':
      `You're in. The fulfillment bot will invite your GitHub account to the private ${repo} repository — usually within 30 minutes, always within a few hours. No invite? Reply to your Stripe receipt and it will be fixed or refunded.`,
    allow_promotion_codes: 'true',
  });
  console.log(`created: ${product.id} / ${price.id} / ${link.id}`);

  // wire config
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
  }

  console.log(`\nDone. Next:
  1. Make ${repo} a private repo containing what buyers get
  2. Edit ${mdPath} (tagline, features, pitch)
  3. node scripts/build.js && deploy — the buy button is already wired
  4. Set up the fulfillment cron (docs/setup.md §5) if you haven't\n
Checkout URL: ${link.url}`);
}

main().catch((e) => die(e.message));
