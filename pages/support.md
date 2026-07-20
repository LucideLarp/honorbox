---
title: Support
meta_title: Support, limits and delivery problems · HonorBox
description: How to get help with HonorBox, what the project does not do, and exactly what happens when a delivery does not arrive.
---

Two ways to reach a person, one page describing what this project does not do,
and the recovery path for the one thing that can go wrong after you pay.

## Where this project is

HonorBox is an independent, MIT-licensed project. It is young, and it is
versioned in the open: every change ships as a tagged release with notes, and
the [release history](https://github.com/Honorboxx/honorbox/releases) is the
honest record of how fast it moves and what has changed.

The parts you build a store on top of, `store.config.json`, the product
frontmatter, and the fulfillment grant format, are stable. Breaking changes to
those only land in a major version, and always with an upgrade note.

The engine is public. Before you buy anything, you can read the code that would
take your buyer's money and deliver their goods, because it is the same code
running this store.

## What HonorBox does not do

Worth knowing before you commit, not after.

- **It is not a merchant of record.** You sell on your own Stripe account, so
  sales tax and VAT obligations are yours, not a platform's. The
  [tax guide](./tax.html) covers what a small seller actually owes.
- **Your buyers need GitHub accounts.** Delivery is an invitation to a private
  repository. That is the right channel for code, templates, tools and
  developer courses, and the wrong one for lay-reader ebooks, physical goods,
  or a general consumer audience.
- **There is no instant download link.** Delivery is repo access, granted by a
  scheduled job, usually within minutes. Sellers who need seconds can turn on
  [webhook mode](./instant-delivery.html). A download URL is instant, and then
  uncontrollable.
- **There is no hosted checkout to configure.** Checkout is a Stripe Payment
  Link on Stripe's own page. Nothing about the payment form is ours to style
  or to break.
- **There is no dashboard and no account.** The storefront is static files on
  GitHub Pages. Nothing to log into, and nothing collecting data on your
  visitors.

## If a delivery does not arrive

The invitation is the delivery, so this is the failure that matters. It has a
defined path rather than a hope.

1. **Check the email GitHub sent**, including spam. The invitation goes to the
   address on your GitHub account, not necessarily the one you paid with.
2. **A mistyped username is caught, not lost.** The order is flagged for a
   human, and your checkout email is on the order, so it can be corrected by
   hand.
3. **An unopened invitation is re-sent.** GitHub expires an unaccepted
   invitation after seven days. It is renewed before that happens, up to three
   times, so missing one email does not cost you what you paid for.
4. **After that a person is told, by name.** The run stops and reports which
   buyer never accepted, rather than reporting success and quietly delivering
   nothing.

At any point in that sequence you can skip it and email, and the fix is either
access or a refund. You are never left holding a receipt for nothing.

Every failure mode of the delivery pipeline, and what each one does, is written
down in [how it works](./how-it-works.html).

## Getting help

**[Open an issue](https://github.com/Honorboxx/honorbox/issues)** for anything
about the engine: a bug, a setup problem, a question about the code, a feature
you need. Issues are the preferred channel because they are public, they are
tracked, and the answer helps whoever hits the same thing next.

**Email honorbox@proton.me** for anything to do with your own order: a delivery
that has not arrived, a refund, a billing question, or anything you would
rather not discuss in public.

Both reach the same place. Neither carries a contractual response time, and
this page is not going to pretend otherwise, but delivery problems and refunds
are handled ahead of everything else.

## Refunds

30 days, no questions asked, on everything sold here. Repository access ends
when a refund is issued. The [refund policy](./refunds.html) has the detail,
including what happens after 30 days.

## Reporting a security problem

Email **honorbox@proton.me** rather than opening a public issue, so a problem
that affects sellers running the engine can be fixed before it is described in
public. Include what you did and what you saw. If you would like credit in the
release notes, say so and you will get it.
