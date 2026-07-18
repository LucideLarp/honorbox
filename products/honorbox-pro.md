---
id: honorbox-pro
name: HonorBox Pro
tagline: Premium themes, an offline license-key system, and multi-product power for your HonorBox store.
price: $29
price_note: one-time · lifetime access & updates
badge: Launch price
payment_link: https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00
features:
  - 4 premium storefront themes (dark terminal, brutalist, editorial, midnight)
  - Store doctor — preflight your config, payment links, and fulfillment permissions before launch
  - Ops bots — instant issue acknowledgment + a refund guard that auto-revokes access
  - Stats — tracker-free sales analytics rendered from your Stripe data, one command
  - License-key module — ed25519 keys signed in CI, verified offline in your app (JS + Python)
  - Multi-product catalog patterns and a launch-pricing & EU-VAT playbook
  - Priority support label on the issue tracker
---

## What Pro is

The free HonorBox core sells one product with one theme, and does it well.
**Pro is for the moment your stand becomes a shop**: more products, a storefront
that doesn't look like anyone else's, and license keys for the software you sell.

## What's inside

**Four premium themes.** Each one is a complete, hand-tuned design — fluid type,
dark-mode aware, no template smell: `terminal` (phosphor-on-black for CLI tools),
`brutalist` (loud, typographic), `editorial` (serif, magazine-calm), and
`midnight` (deep-blue product-launch look). Switch with one config line.

![terminal theme — phosphor CRT](./assets/previews/terminal.png)
![brutalist theme — loud type, hard shadows](./assets/previews/brutalist.png)
![editorial theme — serif calm](./assets/previews/editorial.png)
![midnight theme — deep blue](./assets/previews/midnight.png)

**The license-key module.** If you sell software, you need keys. Pro ships a
GitHub Action that signs an ed25519 license for each buyer at fulfillment time,
plus drop-in verification snippets for JavaScript and Python — your app checks
licenses **offline**, no license server, no phoning home. Keys are delivered
through the same private-repo channel as everything else.

**The store doctor.** One command that checks your whole pipe read-only —
config shape, the pasted-URL-instead-of-id mistake, whether your payment links
are live, whether your fulfillment token can actually invite buyers, whether
your product repo is accidentally public. Run it before launch; sleep after.

**Ops bots.** The unattended part of the unattended store: new support issues
get an instant honest acknowledgment and labels, and every Stripe refund
automatically revokes the buyer's repo access and pending invites. No
refund-fraud babysitting.

**Stats without trackers.** One command renders gross, net, AOV, refund rate,
revenue by week, and buyers by country into a single offline HTML report —
computed from your Stripe account. Your storefront never loads an analytics
script.

**Multi-product patterns.** Catalog layout, per-product payment links, per-product
private repos, and a fulfillment config that routes each sale to the right grant.

**The commerce playbook.** Launch pricing with Stripe coupons, cross-sell placement
that doesn't feel gross, and an honest EU VAT primer: what a self-serve seller
actually owes, when registration thresholds bite, and when to turn on Stripe Tax.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that account
to the private `Honorboxx/honorbox-pro` repository — usually within 30 minutes, always
within a few hours. You keep access permanently; updates land in the same repo.

## The honest terms

- $29, one-time. No subscription, no upsell treadmill.
- Licensed per developer. Use it in any number of your own stores.
- Don't republish or resell the Pro content itself.
- 30-day refunds, no questions asked, via Stripe.
- Support through GitHub issues — Pro buyers get the priority label.
