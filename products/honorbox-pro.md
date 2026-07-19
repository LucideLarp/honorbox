---
id: honorbox-pro
order: 1
name: HonorBox Pro
tagline: An offline license-key module, four premium themes, ops bots, tracker-free sales stats, and multi-product patterns for your HonorBox store.
price: $29
price_note: one-time · lifetime access & updates
badge: Launch price
payment_link: https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00
features:
  - License-key module: ed25519 keys signed in CI, verified offline in your app (JS + Python)
  - 4 premium storefront themes; the terminal theme is published in the free repo as a full code sample
  - Store doctor: preflight your config, payment links, and fulfillment permissions before launch
  - Ops bots: auto-acknowledge new support issues, auto-revoke repo access when Stripe refunds
  - Stats: tracker-free sales analytics rendered from your Stripe data, one command
  - Multi-product catalog patterns and a launch-pricing & EU-VAT playbook
  - Priority support label on the issue tracker
---

## What Pro is

The free HonorBox core sells one product with one theme, and does it well.
**Pro is for the moment your stand becomes a shop**: license keys for the
software you sell, more products, and a storefront that doesn't look like
anyone else's.

## What's inside

**The license-key module.** If you sell software, you need keys. Pro ships a
GitHub Action that signs an ed25519 license for each buyer at fulfillment time,
plus drop-in verification snippets for JavaScript and Python. Your app checks
licenses **offline**: no license server, no phoning home, nothing to keep
running. Signing happens in CI with the private key held as an Actions secret,
and keys are delivered through the same private-repo channel as everything
else. Getting signature crypto right takes days; this is that work, done and
tested.

**Four premium themes.** Each one is a complete, hand-tuned design with fluid
type and dark-mode awareness: `terminal` (phosphor-on-black for CLI tools),
`brutalist` (loud, typographic), `editorial` (serif, magazine-calm), and
`midnight` (deep-blue product-launch look). Switch with one config line.

![terminal theme, phosphor CRT](./assets/previews/terminal.png)
![brutalist theme, loud type and hard shadows](./assets/previews/brutalist.png)
![editorial theme, serif calm](./assets/previews/editorial.png)
![midnight theme, deep blue](./assets/previews/midnight.png)

**The store doctor.** One read-only command that checks your whole pipe:
config shape, the pasted-URL-instead-of-id mistake, whether your payment links
are live, whether your fulfillment token can actually invite buyers, whether
your product repo is accidentally public. Run it before launch; sleep after.

**Ops bots.** Two workflows for the unattended hours. One acknowledges and
labels every new support issue within minutes. The other watches Stripe for
refunds and revokes the buyer's repo access and pending invites the moment one
lands.

**Stats without trackers.** One command renders gross, net, AOV, refund rate,
revenue by week, and buyers by country into a single offline HTML report,
computed from your Stripe account. Your storefront never loads an analytics
script.

**Multi-product patterns.** Catalog layout, per-product payment links,
per-product private repos, and a fulfillment config that routes each sale to
the right grant.

**The commerce playbook.** Launch pricing with Stripe coupons, cross-sell
placement that doesn't feel gross, and a plain-language EU VAT primer: what a
self-serve seller actually owes, when registration thresholds bite, and when
to turn on Stripe Tax.

## Who should buy this (and who shouldn't)

**Buy Pro if** you sell software that needs license keys, you sell or plan
multiple products (templates, courses, tools, a whole catalog), or you want a
storefront that doesn't look like every other fork.

Before buying you can audit a full Pro theme
([`terminal`, public in the free repo](https://github.com/Honorboxx/honorbox/tree/main/themes/terminal))
and the [production evidence](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md)
for every Pro module. The private repo is the delivery channel, not a blindfold.

**Skip Pro if** you're selling one PDF or template. The free core is already a
complete store, and Pro adds little you'd use. Skip it too if you're happy in
CSS (the theme contract is simple; restyle the free theme yourself) or you're
still experimenting. Get a real sale through the free core first: Pro solves
scaling problems you may not have yet.

Either way, the 30-day refund makes trying it nearly risk-free. That's
deliberate.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that
account to the private `Honorboxx/honorbox-pro` repository, usually within
minutes and always within a few hours. You keep access permanently; updates
land in the same repo. It's the same private-repo delivery we recommend in
[the GitHub delivery guide](./deliver-digital-products-github.html), so you're
watching the engine you'd be buying.

## Terms

- $29, one-time. No subscription, no upsell treadmill.
- Licensed per developer. Use it in any number of your own stores.
- Don't republish or resell the Pro content itself.
- 30-day refunds, no questions asked, via Stripe.
- Support through GitHub issues; Pro buyers get the priority label.
