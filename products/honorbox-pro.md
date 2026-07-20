---
id: honorbox-pro
order: 1
name: HonorBox Pro
meta_title: HonorBox Pro ($29): never silently lose a sale
description: Reconcile proves every paid order reached its buyer. Plus license keys, five themes, ops bots, and a store doctor for your Stripe + GitHub store. $29 one-time.
tagline: The free engine keeps the invitation open. Pro names which paid order is undelivered, and for how much, plus license keys, five themes, and bots for the unattended hours.
price: $29
price_note: one-time · lifetime access & updates
payment_link: https://buy.stripe.com/aFa9ATaRhaZp3PC1SYa7C00
# Social card, named explicitly. The gallery below is WebP for the browser,
# which link-preview scrapers do not reliably render, so the card keeps a PNG.
# This was previously whatever image happened to be first in the body; naming
# it makes it a decision rather than a side effect of editing the gallery.
og_image: ./assets/previews/terminal.png
features:
  - Reconcile: cross-checks Stripe against GitHub to prove every paid order actually reached its buyer, and names the ones that didn't
  - Store doctor: preflight your config, payment links, and fulfillment permissions before launch
  - License-key module: ed25519 keys signed in CI, verified offline in your app (JS + Python)
  - 5 premium storefront themes; the terminal theme is published in the free repo as a full code sample
  - Ops bots: auto-acknowledge new support issues, auto-revoke repo access when Stripe refunds
  - Stats: tracker-free sales analytics rendered from your Stripe data, one command
  - Commerce playbook: pricing, the first ten sales, EU VAT, multi-product catalogs (table of contents is public)
  - Priority support label on the issue tracker
---

30 days to change your mind, no questions asked, refunded through Stripe.
[The refund policy in full](./refunds.html).

## What Pro is

The free HonorBox core is a complete store, and it is the one you are standing
in. It takes the money, sends the invite, and keeps that invitation open until
the buyer accepts or you are told they never did. What it never does is look at
the money: renewal reads GitHub's pending invitations and holds no Stripe key.

**Pro is the operational half.** Reconcile walks the money and names the paid
order that is still undelivered, the store doctor catches the setup mistakes
before they cost you a launch, and the refund bot revokes what a refund should
revoke without waiting for you to run a command. Themes, license keys, and the
playbook are what Pro *contains*. Not quietly losing a sale you already made is
what it is *for*.

## What's inside

**The license-key module.** If you sell software, you need keys. Pro ships a
GitHub Action that signs an ed25519 license for each buyer at fulfillment time,
plus drop-in verification snippets for JavaScript and Python. Your app checks
licenses **offline**: no license server, no phoning home, nothing to keep
running. Signing happens in CI with the private key held as an Actions secret,
and keys are delivered through the same private-repo channel as everything
else. Getting signature crypto right takes days; this is that work, done and
tested.

**Five premium themes.** Each one is a complete, hand-tuned design with fluid
type, visible focus states and print styles: `atrium` (minimal, gallery-quiet),
`terminal` (phosphor-on-black for CLI tools), `brutalist` (loud, typographic),
`editorial` (serif, book-calm), and `midnight` (indigo night, one amber lamp).
Switch with one config line.

![atrium theme, minimal graphite on plaster](./assets/previews/atrium.webp)
![terminal theme, phosphor CRT](./assets/previews/terminal.webp)
![brutalist theme, loud type and hard shadows](./assets/previews/brutalist.webp)
![editorial theme, serif on book white](./assets/previews/editorial.webp)
![midnight theme, indigo night](./assets/previews/midnight.webp)

**The store doctor.** One read-only command that checks your whole pipe:
config shape, the pasted-URL-instead-of-id mistake, whether your payment links
are live, whether your fulfillment token can actually invite buyers, whether
your product repo is accidentally public. Run it before launch; sleep after.

**Reconcile.** Doctor checks that your store is set up right, which you ask once.
Reconcile answers the question that only starts costing money after launch: for
every order you were *paid* for, does that buyer have the product *right now*?

Those are different questions, and the free engine does not answer the second
one. It writes its ledger row the moment it **sends** an invite, so a buyer who
never clicks accept leaves every system you own reporting success: Stripe says
paid, your ledger says delivered, the run is green. They have nothing.

The engine will not let that invitation lapse quietly. It re-issues an
unaccepted one before GitHub's seven-day expiry, three times, then warns you by
name: about three and a half weeks of open door, and it is part of the free
engine, because a sale that never lands was never delivered
([how that works](https://github.com/Honorboxx/honorbox/blob/main/docs/how-it-works.md#delivery-model)).

That is also where it stops. Renewal works from GitHub's list of pending
invitations and holds
[no Stripe key at all](https://github.com/Honorboxx/honorbox/blob/main/scripts/renew-invites.js),
so it can keep an invitation alive but never tell you which *paid order* it
belongs to, or how much money is sitting undelivered. And it never sees a
failure that left no invitation to renew: an order that matched no grant, a
typo'd username the engine flagged and skipped, a refunded buyer who kept
access.

Reconcile starts from the money instead. It walks every paid Stripe session and
asks GitHub whether that specific buyer holds access to that specific repo: one
verdict per sale with the amount attached, `PAID, NO GRANT` on an order the
engine never fulfilled, a repo it cannot read reported as unreadable rather than
counted clean, and a non-zero exit when anything is lost, so you can schedule it
instead of remembering it. Read-only.

It also separates revenue from fulfillments: a $0 order fulfilled by a coupon
is a delivery, not a sale, and reconcile reports them apart so your revenue line
means money that actually arrived.

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

**Buy Pro if** you are taking real orders and want each one proved delivered
rather than assumed, you sell software that needs license keys, you sell or plan
multiple products (templates, courses, tools, a whole catalog), or you want a
storefront that doesn't look like every other fork.

Delivery is a private repo, so read the box before you buy it. Public and
checkable right now: a complete Pro theme
([`terminal`](https://github.com/Honorboxx/honorbox/tree/main/themes/terminal),
shipped in this repo), the license module's
[full API surface](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md#the-license-module-api-surface)
with the key format and both verify snippets, the playbook's complete table of
contents, and
[what every module prints](https://github.com/Honorboxx/honorbox/blob/main/docs/pro-evidence.md),
in its real format, so you can see the answer each one gives before you pay for
the code behind it.

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

- $29, one-time. No subscription, no upsell treadmill. Every later update is
  included at no extra cost, because updates land in the repo you already have
  access to.
- Licensed per developer. Use it in any number of your own stores.
- Don't republish or resell the Pro content itself.
- 30-day refunds, no questions asked, via Stripe.
- Support through GitHub issues; Pro buyers get the priority label.
