---
id: honorbox-pro
order: 1
name: HonorBox Pro
meta_title: HonorBox Pro ($29): license keys, 4 themes, ops bots for your Stripe + GitHub store
description: An offline license-key module, four premium themes, ops bots, and tracker-free sales stats for your Stripe + GitHub store. $29 one-time, lifetime updates.
tagline: An offline license-key module, four premium themes, ops bots, tracker-free sales stats, and multi-product patterns for your HonorBox store.
price: $29
price_note: one-time · lifetime access & updates · $29 for the first 25 copies, then $39
payment_link: https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00
features:
  - License-key module: ed25519 keys signed in CI, verified offline in your app (JS + Python)
  - 4 premium storefront themes; the terminal theme is published in the free repo as a full code sample
  - Store doctor: preflight your config, payment links, and fulfillment permissions before launch
  - Ops bots: auto-acknowledge new support issues, auto-revoke repo access when Stripe refunds
  - Stats: tracker-free sales analytics rendered from your Stripe data, one command
  - Commerce playbook: pricing, the first ten sales, EU VAT, multi-product catalogs (table of contents is public)
  - Priority support label on the issue tracker
---

30 days to change your mind, no questions asked, refunded through Stripe.
[The refund policy in full](./refunds.html).

## What Pro is

The free HonorBox core is a complete store, and it is the one you are standing
in. **Pro is for the moment your stand becomes a shop**: license keys for the
software you sell, a catalog that stays coherent as it grows, and a storefront
that doesn't look like anyone else's.

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

**Multi-product patterns.** The engine sells several products out of the box.
The playbook chapter covers what breaks after that: why each product wants its
own private repo, how to build a bundle that grants several repos from one
payment link, how a refund revokes what that purchase granted and nothing
else, and the order you retire a product in so a checkout completed a minute
before deactivation still gets fulfilled.

**The commerce playbook.** Four documents: picking your number against real
comparables, running a launch price you can honor, the first ten sales of a
store nobody has heard of, and an EU VAT primer with two worked registration
examples. Every chapter title and a one-line summary of each is
[published](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-commerce-playbook)
so you can see the shape of it before paying.

## Who should buy this (and who shouldn't)

**Buy Pro if** you sell software that needs license keys, you sell or plan
multiple products (templates, courses, tools, a whole catalog), or you want a
storefront that doesn't look like every other fork.

Delivery is a private repo, so read the box before you buy it. Public and
checkable right now: a complete Pro theme
([`terminal`](https://github.com/Honorboxx/honorbox/tree/main/themes/terminal),
shipped in this repo), the license module's
[full API surface](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-license-module-api-surface)
with the key format and both verify snippets, the playbook's complete table of
contents, and
[transcripts](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md)
of every module run against the live store.

**Skip Pro if** you're selling one PDF or template. The free core is already a
complete store, and Pro adds little you'd use. Skip it too if you're happy in
CSS (the theme contract is simple; restyle the free theme yourself) or you're
still experimenting. Get a real sale through the free core first: Pro solves
scaling problems you may not have yet.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that
account to the private `Honorboxx/honorbox-pro` repository, usually within
minutes and always within a few hours. You keep access permanently; updates
land in the same repo. It's the same private-repo delivery we recommend in
[the GitHub delivery guide](./deliver-digital-products-github.html), so you're
watching the engine you'd be buying.

## Terms

- $29, one-time, for the first 25 copies; $39 after those are sold. No
  subscription, no upsell treadmill. Buyers at $29 keep every later update at
  no extra cost, because updates land in the repo you already have access to.
- Licensed per developer. Use it in any number of your own stores.
- Don't republish or resell the Pro content itself.
- 30-day refunds, no questions asked, via Stripe.
- Support through GitHub issues; Pro buyers get the priority label.
