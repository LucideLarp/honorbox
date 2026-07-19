---
title: Deliver digital products through GitHub — the practical guide
---

If your buyers have GitHub accounts, a private repo is a delivery channel with
properties no download link has: per-buyer access control, revocation, updates
that arrive as `git pull`, and zero hosting to run. This guide covers doing it
well — useful with or without our tooling; the one section selling something
is marked.

## The private-repo delivery model

Put the product in a **private repository**. Delivery = inviting the buyer's
GitHub account as a read-only collaborator. That single move gives you:

- **Access control** — no shareable secret URL. One buyer, one grant.
- **Revocation** — refunds and chargebacks reverse cleanly: remove the
  collaborator, cancel any pending invitation.
- **Updates included** — push to the repo; every buyer has it. "Lifetime
  updates" stops being a fulfillment problem and becomes a `git push`.
- **An audit trail** — the invitation log is your entitlement record.

It works for anything whose buyers are comfortable on GitHub: code and CLI
tools, templates and boilerplates, agent packs, technical courses, design
systems, an OSS project's sponsorware.

## What it costs you, honestly

- **Buyers need GitHub accounts.** For code, templates, tools, and courses
  aimed at technical people — fine, that's where the audience lives. For
  ebooks aimed at lay readers or any general-consumer product: wrong channel,
  use something else.
- **Usernames get typo'd at checkout.** Expect it; label the field clearly
  ("GitHub username, not email"), validate before inviting
  (`^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$`, no doubled hyphens), and route
  failures to a human-visible queue instead of a crash.
- **Repo limits are real.** GitHub caps invitations (~50/repo/24h) — a
  launch spike can queue; that's a good problem, plan the message for it.
- **The token that invites is powerful.** Use a fine-grained PAT scoped to
  the product repos only, stored as a CI secret — never the broad token you
  use daily.

## Wiring GitHub delivery to Stripe checkout

Collect the username as a **custom field** on your
[Stripe Payment Link](./sell-with-stripe-payment-links.html) (or checkout
form). After payment you have a `checkout.session` carrying the username;
something must read it and send the invite:

1. **Webhook + server** — instant, classic, and you now operate an endpoint.
2. **Scheduled poll from CI** — *(the marked section: this is what our
   MIT-licensed [HonorBox](https://github.com/Honorboxx/honorbox) engine
   does)* — a GitHub Action lists recent paid sessions and invites each
   buyer. No server, no webhook secret, delivery in minutes not
   milliseconds. The engine is ~170 dependency-free lines you can read
   before trusting.
3. **By hand** — works for the first sales; does not survive a weekend away.

Whichever you pick: make fulfillment **idempotent** (track processed session
ids — polls overlap, webhooks retry, and double-inviting is harmless only if
you built it that way), and set the delivery expectation at checkout
("usually within minutes, always within a few hours") so minute-4 support
emails don't happen.

## Revocation discipline

Decide the refund flow before the first refund: refund issued → collaborator
removed → pending invitation cancelled. If you sell several products, scope
revocation to the repos *that purchase* granted — a buyer refunding product B
must keep product A. Automate it; refund-fraud babysitting doesn't scale.

## Related

- This store delivers [HonorBox Pro — $29](./honorbox-pro.html) and
  [Crew — $19](./crew.html) exactly this way — buy either and you're watching
  the pipeline run.
- [Sell digital products with Stripe Payment Links — the complete guide](./sell-with-stripe-payment-links.html)
- [Gumroad alternatives (2026) — fees, trade-offs, and when DIY wins](./gumroad-alternatives.html)
