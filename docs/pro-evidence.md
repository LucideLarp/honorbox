# HonorBox Pro: production evidence (public copy)

Pro is delivered as a private repo, which fairly reads as "blind purchase."
This public copy of the buyers' evidence doc + the full `terminal` theme
published in this repo (`themes/terminal/`) are the audit surface: the same
code standards, verifiable before paying.


Fair question from a skeptical reviewer: *"ops bots and stats are plausible
but I couldn't execute them without live keys."* Correct, so here is the
evidence from the store this repo funds, which runs every module below in
production. Sanitized only where buyer privacy requires.

## doctor: run against the live HonorBox store (2026-07-18)

```
[ OK ] config: parses
[ OK ] config: has name / url / theme
[ OK ] config: fulfillment[] present
[ OK ] fulfillment[0]: repo is owner/name
[ OK ] fulfillment[0]: payment_link is a plink_ id
[ OK ] products: at least one
[ OK ] product honorbox-pro.md: frontmatter / id/name/price / checkout URL
[ OK ] stripe: plink_… exists (HTTP 200)
[ OK ] stripe: plink_… active
[ OK ] stripe: price_… exists (HTTP 200)
[ OK ] github: product repo reachable
[ OK ] github: product repo is private
[ OK ] github: token can admin product repo
[ OK ] site: config.url reachable (HTTP 200)

18 checks, 0 failing
```

All three tiers exercised: offline config checks, live Stripe API, GitHub
token permissions.

## ops bots: real issue, real ack

Issue [Honorboxx/honorbox#1](https://github.com/Honorboxx/honorbox/issues/1)
(public; verify yourself): opened as a delivery-problem test, auto-acknowledged
and labeled `support` by `bots.js` on the next cycle:

```
acked issue #1: Test: invite didn't arrive [support]
```

The refund guard runs in the same cycle on the same store; its revocation
path (collaborator removal + pending-invitation cancellation) executes against
the same GitHub API calls you can read in `ops-bots/bots.js`.

## stats: rendered from the live Stripe account

```
report -> report.html  (1 orders, gross 0.00 USD, 0 refunds)
```

(The store was hours old at that run; one $0 end-to-end test order. The
point is the pipeline: sessions + refunds paginated from the live API,
report rendered, no trackers anywhere.)

## license module: sign/verify round-trip (2026-07-18)

```
good:          {"ok":true,"license":{"v":1,"product":"my-app","holder":"buyer@example.com",...}}
wrong product: wrong product
tampered:      bad signature
JS VERIFY: ALL PASS
PY VERIFY: PASS
```

Independent review note we agree with: don't take our word for it. The verify
snippets are short; read them.

## The store itself

The storefront, fulfillment cron, and delivery pipeline this repo documents
are the ones that just delivered *this repo* to you. That end-to-end path
(live Stripe checkout → scheduled poll → repo invite) was verified with a
real completed order before launch and runs on schedule since.
