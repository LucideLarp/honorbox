---
title: Sell code without a marketplace: the direct Stripe + GitHub route
description: Sell source code, templates, and dev tools directly: Stripe checkout, GitHub delivery, 0% platform fee. Setup, running costs, and when a marketplace earns its cut.
---

You built something worth paying for: a boilerplate, a CLI tool, a course
repo, a plugin, an agent pack. The default advice is to list it on a
marketplace and hand over a cut of every sale plus the buyer relationship.
This guide covers the direct route instead: checkout on your own Stripe
account, delivery through GitHub, nobody in between. Disclosure up front: we
build [HonorBox](./index.html), a free engine that automates exactly this
pipeline, and this store runs on it. The setup below works with or without
our tool.

## What a marketplace charges for

A marketplace does two jobs: it processes the sale, and it finds buyers. The
finding is the expensive part. Gumroad's own
[fee page](https://gumroad.com/help/article/66-gumroads-fees) (checked July
19, 2026) prices it cleanly: sales from their Discover marketplace cost
**30%**, processing included, while sales from your own traffic cost 10% +
50¢ with card processing (2.9% + 30¢) on top. Lemon Squeezy
([pricing](https://www.lemonsqueezy.com/pricing)) charges 5% + 50¢ as a
merchant of record. Selling direct, the whole fee stack is Stripe's
processing rate ([pricing](https://stripe.com/pricing)); for US domestic
cards that's 2.9% + 30¢, with no monthly fee and no platform percentage.

The catch, stated before the pitch: most code sales come from your own
traffic anyway, your README, your blog, your users. If you're paying 10-30%
on buyers you brought yourself, the marketplace is charging distribution
prices for processing work. Full per-sale math:
[Lemon Squeezy vs Gumroad vs DIY](./lemon-squeezy-vs-gumroad-vs-diy.html).

## The three jobs you take back

Going direct means you own **checkout**, **delivery**, and **tax**. The
first two turn out to be small. The third is real work you should size
before deciding; more on it below.

## Checkout: a Stripe Payment Link

A [Payment Link](./sell-with-stripe-payment-links.html) is a hosted checkout
page you create in the Stripe dashboard in a few minutes: no code, no
server. Two settings matter for selling code:

- **Collect the buyer's GitHub username** as a custom field, labeled
  "GitHub username, not email". That username is your delivery address.
- **Write a confirmation message** that says exactly what happens next:
  "your repo invite usually arrives within minutes, always within a few
  hours", plus a support contact. Vague messages become support tickets.

The [complete Payment Links guide](./sell-with-stripe-payment-links.html)
covers receipts, refunds, and the launch checklist.

## Delivery: a private GitHub repo

Put the product in a private repository. Delivery is a read-only
collaborator invite to the buyer's GitHub account. GitHub's Free plan
includes unlimited private repositories with unlimited collaborators
([their plans doc](https://docs.github.com/en/get-started/learning-about-github/githubs-plans),
checked July 19, 2026), so the delivery channel costs nothing. What the
invite gives you over a download link:

- **Per-buyer access control.** No shareable secret URL.
- **Clean revocation.** Refund issued, collaborator removed, done.
- **Updates included.** Every `git push` reaches every buyer; "lifetime
  updates" stops being a fulfillment task.

The costs are equally concrete: every buyer needs a GitHub account (the
right audience for code, the wrong one for lay-reader ebooks), usernames get
typo'd at checkout, and GitHub caps repo invitations at roughly 50 per repo
per 24 hours. [The practical GitHub delivery guide](./deliver-digital-products-github.html)
covers validation, invite limits, and token discipline.

## The glue between paid and delivered

After checkout, Stripe has your money and a `checkout.session` object
carrying the buyer's username. Something has to read it and send the invite:

1. **By hand.** Stripe emails you per sale; you click invite. Fine for the
   first sales, fragile the first weekend you're away.
2. **Webhook + server.** Instant delivery, and you now operate an endpoint,
   its TLS, and its retries.
3. **A scheduled poll from CI** *(the section where we sell you something:
   this is what [HonorBox](https://github.com/Honorboxx/honorbox) does)*. A
   GitHub Action runs every few minutes, lists recent paid sessions, and
   invites each buyer. The engine is MIT, 870 dependency-free lines of
   Node you can read before trusting it. It also builds the storefront: a static
   site on GitHub Pages with your products, checkout buttons, and this same
   guide layout. Delivery lands in minutes rather than seconds; an opt-in
   webhook mode gets it under a minute if you want it.

## The running costs, added up

- **Hosting**: $0. GitHub Pages serves the storefront from a public repo.
- **Stripe**: $0/month. "Stripe does not charge setup fees, monthly fees, or
  any other hidden fees" ([pricing](https://stripe.com/pricing), checked
  July 19, 2026); you pay processing per sale.
- **Fulfillment compute**: $0 in practice. Actions minutes are free on
  public repos, and the Free plan includes 2,000 CI minutes a month for
  private ones ([github.com/pricing](https://github.com/pricing), checked
  July 19, 2026); an every-half-hour poll bills roughly 1,500 of them.
- **Your time**: the real cost. Checkout and delivery are an afternoon; tax
  is a decision. As the merchant, VAT and sales tax are yours. Most small
  sellers start under registration thresholds, and
  [our tax doc](./tax.html)
  walks through what a small seller actually owes. Not tax advice.

## When a marketplace earns its cut

- **You have no channel to buyers.** If Discover or a marketplace's search
  genuinely finds you customers, 30% of a sale you'd otherwise never make is
  a fair trade. Revisit once your own traffic carries the volume.
- **Your buyers aren't on GitHub.** General consumers, lay-reader ebooks,
  design assets for non-developers: use a platform with hosted downloads.
- **You never want to think about tax.** A merchant of record removes that
  job completely; [the comparison guide](./gumroad-alternatives.html) covers
  which one fits.
- **You need billing machinery beyond access.** Subscriptions themselves work
  on the direct route: HonorBox can enforce them, so a lapsed customer loses
  repo access, and its paid tier issues offline license keys. What is not there
  is seats per subscription, metered billing, and a hosted customer portal.
  Lemon Squeezy ships those assembled.

## Related

- [Lemon Squeezy vs Gumroad vs DIY (2026): fees compared](./lemon-squeezy-vs-gumroad-vs-diy.html)
- [Gumroad alternatives for developers (2026): fees and trade-offs](./gumroad-alternatives.html)
- [Sell digital products with Stripe Payment Links: the complete guide](./sell-with-stripe-payment-links.html)
- [Deliver digital products through GitHub: the practical guide](./deliver-digital-products-github.html)
- What this store sells with its own engine: [HonorBox Pro ($29)](./honorbox-pro.html)
  and [Crew ($19)](./crew.html)
