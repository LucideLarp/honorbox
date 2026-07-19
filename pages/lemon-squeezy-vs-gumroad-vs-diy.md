---
title: Lemon Squeezy vs Gumroad vs DIY (2026) — the fee math, verified
---

Lemon Squeezy, Gumroad, or doing it yourself on your own Stripe account — the
three realistic ways to sell a digital product in 2026, with fees taken from
each platform's live pricing page (checked July 19, 2026) and the per-sale math
shown. Honest disclosure up front: we build [HonorBox](./index.html), one of
the DIY routes. The numbers are real either way — recheck them against the
linked pricing pages before deciding.

## The choice underneath the logos

Both platforms are **merchants of record**: legally, they sell to your buyer
and you invoice them. That's why they can handle VAT and sales tax for you —
and why the fee is what it is. DIY means *you* are the merchant: you keep the
platform's cut and you inherit the platform's jobs — delivery and tax.

## What each one charges (as published, July 19, 2026)

**Gumroad** ([pricing](https://gumroad.com/pricing)) — **10% + 50¢** per sale
on your own traffic, and that does **not** include payment processing:
Gumroad's [fee page](https://gumroad.com/help/article/66-gumroads-fees) lists
credit card processing (2.9% + 30¢) and PayPal fees separately, on top. Sales
that come through Gumroad's Discover marketplace cost **30%**, processing
included. No monthly fee.

**Lemon Squeezy** ([pricing](https://www.lemonsqueezy.com/pricing)) —
**5% + 50¢** per transaction, processing included. The
[fee schedule](https://docs.lemonsqueezy.com/help/getting-started/fees) adds
**+1.5%** for international (non-US) cards, **+1.5%** for PayPal, and
**+0.5%** for subscription payments. Two prints most people miss: the fee is
calculated on the tax-inclusive total (their own example: a $20 product with
20% VAT is charged at $24, and the fee comes out of $24), and payouts outside
the US cost 1% via Stripe or 3% (capped at $30) via PayPal. No monthly fee.
Owned by Stripe since 2024.

**DIY on Stripe** ([pricing](https://stripe.com/pricing)) — Stripe's standard
processing rate for your country and nothing else; for US domestic cards
that's the familiar 2.9% + 30¢. No platform percentage, no monthly fee — and
no delivery, no tax handling, nobody between you and your money.

## The math on one sale

A $29 product, one-off purchase, US domestic card, your own traffic:

- **Gumroad** — $3.40 platform + $1.14 processing = **$4.54 in fees (15.7%)**. You keep $24.46.
- **Lemon Squeezy** — **$1.95 in fees (6.7%)**. You keep $27.05.
- **DIY on Stripe** — **$1.14 in fees (3.9%)**. You keep $27.86.

The 50¢ fixed fees bite hardest at low prices: on a $5 product Gumroad takes
~29%, Lemon Squeezy 15%, plain Stripe ~9%. On a $100 product the gap
narrows to 13.7% vs 5.5% vs 3.2%. At 50 sales of a $29 product a month
($1,450), the totals are roughly **$227** (Gumroad), **$97** (Lemon Squeezy),
**$57** (DIY) — every month.

## What the platform fee actually buys

Not nothing. Gumroad is the fastest possible start — upload a file, share a
link — plus a marketplace that can find you buyers (at 30% for the ones it
finds). Lemon Squeezy buys the merchant-of-record umbrella at half Gumroad's
cut, with developer polish: license keys, checkout overlays, an API, real
subscription support. If those jobs would otherwise eat your evenings, the
fee is cheaper than your time.

## When NOT to DIY

Honesty from a DIY vendor:

- **Your buyers aren't technical.** HonorBox delivers by inviting the buyer's
  GitHub account to a private repo — the wrong channel for lay-reader ebooks
  or general consumers. Full DIY with your own server avoids that, but then
  you're running a server.
- **You never want to think about VAT or sales tax.** A merchant of record
  genuinely removes that job; Lemon Squeezy is the strongest pick here. DIY
  means tax is yours — under most registration thresholds that's simpler than
  it sounds ([our tax doc](https://github.com/Honorboxx/honorbox/blob/main/docs/tax.md)
  covers it without hand-waving), but it is never zero thought.
- **Subscriptions and license keys at volume.** You can build both on plain
  Stripe, but Lemon Squeezy ships them today.
- **You want instant-download delivery** and won't deploy anything: platforms
  hand you a hosted download; DIY makes delivery your problem.

## When DIY wins

You sell code, templates, courses, or tools to people who have GitHub
accounts, and you'd rather keep the 5–15%. The checkout half takes minutes —
[Stripe Payment Links](./sell-with-stripe-payment-links.html) — and the
delivery half is the actual gap. [HonorBox](./index.html) fills it without a
server: a static storefront on GitHub Pages and a scheduled GitHub Action
that polls your Stripe account and invites each buyer to a private repo —
[through GitHub, done right](./deliver-digital-products-github.html). 0%
platform fee, $0/month, MIT-licensed and
[open to read](https://github.com/Honorboxx/honorbox). The honest costs:
buyers need GitHub accounts, delivery is an invite that usually lands in
minutes (opt-in webhook mode brings it to seconds), and you are the merchant.

## Related

- [Gumroad alternatives (2026) — the wider field](./gumroad-alternatives.html)
- [Sell digital products with Stripe Payment Links — the complete guide](./sell-with-stripe-payment-links.html)
- [Deliver digital products through GitHub — the practical guide](./deliver-digital-products-github.html)
- What this store sells with its own engine: [HonorBox Pro — $29](./honorbox-pro.html)
  and [Crew — $19](./crew.html)
