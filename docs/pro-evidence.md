# HonorBox Pro: production evidence (public copy)

Pro is delivered as a private repo, which fairly reads as "blind purchase."
This document is what you can check before paying: what the conformance suite,
doctor, reconcile, the scheduled guard, the ops bots, stats and the license
module each print and how to read it, the license module's complete API
surface, and the playbook's full table of contents. The `stand` theme this store runs on is published whole in
this repo (`themes/stand/`), so the code standard is checkable before you pay
for the rest. The failure catalogue the suite is built from is published in full, free,
at [docs/failure-catalogue.md](failure-catalogue.md).

Themes are shown as [previews](../assets/previews/) rather than transcripts,
because a theme has no output to reproduce.

Fair question from a skeptical reviewer: *"ops bots and stats are plausible
but I couldn't execute them without live keys."* Correct. Every module below
runs in production on the store this repo funds, and what is reproduced here is
its real output *format* on a synthetic store: placeholder handles, a
placeholder product, masked ids, invented amounts. Our own order counts and
revenue are not published anywhere, which is the same discipline
[least-privilege.md](least-privilege.md) asks of you.

## audit: the standing guard, on a store that looks fine

This is the largest thing Pro ships and the one that earns its keep before your
first sale, not after it. Doctor is a preflight you run once. Reconcile is an
autopsy that needs orders to examine. The conformance suite asks the question in
between, on every push: which of the known ways this architecture loses money
quietly is my setup open to right now?

It matters most on day one, for an unglamorous reason. When a new store makes no
sales, "nobody came" and "my store is silently broken" look exactly the same from
where the seller is standing. Both are a quiet dashboard and an empty ledger. Most
of these checks fire with zero orders in the account, so they can tell those two
apart while there is still time to fix it.

Below is a run against a synthetic store: a plausible first setup with four
ordinary mistakes in it, none of which any link checker, uptime monitor or `curl`
would report. The store's own site builds and deploys perfectly.

```
HonorBox audit: the known ways this architecture loses money quietly

scanned /tmp/widget-store (1 source files, 1 product pages)
config  /tmp/widget-store/store.config.json

[  OK  ] A paid checkout that matches no fulfillment grant
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no paid sessions were ever skipped for want of a grant

[EXPOSED] The checkout URL pasted where Stripe reports an id
         shipped defect: real bug, reproduced, no victim (2026-07-19)
         fulfillment[0] ("Widget Pro") payment_link is a checkout URL, not an id
         -> the matcher compares against session.payment_link, which Stripe reports
         as a plink_ id. Copy the id from the Stripe dashboard (or GET
         /v1/payment_links). As written, every sale of this product is silently
         skipped.
         fulfillment[0] ("Widget Pro") can never match a sale
         -> set payment_link (plink_...) or price (price_...). Without one of them
         this product is unsellable and fails silently

[  OK  ] A forked store still selling through the original author's checkout
         shipped defect: real bug, reproduced, no victim (2026-07-19 / 2026-07-20)
         no exact-string URL gates

[EXPOSED] A poll cadence that outruns the free tier, then stops delivering
         incident: happened here (2026-07-19)
         .github/workflows/poll.yml schedule "*/2 * * * *" is ~22320 runs/month ≈ 22320 billed minutes (jobs round up to 1 min)
         -> that is 20320 minutes over the 2000-minute Free allowance on a private
         repo, from this workflow alone. When it runs out mid-month delivery simply
         stops and nothing tells you. Either poll locally (launchd/systemd) and
         keep Actions as the safety net, or widen the cron.

[EXPOSED] One hung request stalling every buyer behind it
         reasoned guard: has NOT happened here (2026-07-20)
         scripts/fulfill.js:4 fetch() with no signal
         -> add signal: AbortSignal.timeout(MS). Undici will wait 300s per phase
         for a socket that accepts and never answers. If this file shares a runner
         with fulfillment (and on a single-job runner everything does), a stall
         here is a delivery outage for every buyer queued behind it.

[  OK  ] An unstaged file halting delivery
         incident: happened here (2026-07-19)
         no unguarded `git pull --rebase` on the ops path

[  OK  ] Production running a copy of the engine you stopped reading
         incident: happened here (2026-07-20)
         no divergent copies of engine modules

[EXPOSED] HTTP 204 logged as if it were a fresh invitation
         incident: happened here (2026-07-19)
         scripts/fulfill.js accepts 201 and 204 as one outcome
         -> log them differently: 201 is "invited", 204 is "already had access".
         Reporting both as an invite turns your own test purchase into a phantom
         delivery and misleads you when a buyer reports a missing invite.

[  OK  ] A buyer flagged for attention that nothing ever tells
         reasoned guard: has NOT happened here
         no ledger rows are flagged needs_attention

[  OK  ] A force-push guard that fails open on the short spelling
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no force-push guard that misses the refspec form

Live checks skipped (--static-only): payment-link coverage, forked-checkout
detection, dead buy buttons, advertised-price drift, coupon exposure and
invitation expiry all need read credentials. An entry above marked OK was
judged on its static half only, and an entry with no live-checkable half
is not listed at all.

10 entries checked: 4 exposed · 0 warn · 0 unchecked · 6 guarded
The 4 exposed hold 5 separate findings, each listed above with its fix.

Each EXPOSED line above is a specific way this store loses a sale without
telling you. They are listed with the fix; there is no score to improve.

13 catalogue entries · 5 from incidents here, 4 from defects we shipped and caught, 4 guarded before they happened.
Known gaps we have NOT closed (1). Read audit/CATALOGUE.md:
  - A 200 that acknowledges dispatch, not delivery: A short secondary throttle is retried in-run (30s per wait, 60s per run, 3 attempts); anything longer, including a primary rate limit, is declined by design and falls to the scheduled poll, whose real recovery time is the next run that actually fires, measured here at up to 3h08m on a quiet private repo.
```

Four findings, each with the fix attached and no score to improve. The pasted
checkout URL alone means every sale of that product is skipped in silence: the
money arrives, the buyer waits, and nothing in the seller's own tooling says a
word.

**What this is, precisely.** It reads the sources and config you point it at, and
with a read-only key it asks Stripe and GitHub about the objects behind them. It
is static analysis plus configuration checking plus read-only API reads. It does
not execute your code, it cannot see a mistake nobody has catalogued, and it says
`UNKNOWN` rather than `OK` when it could not check something, with the reason
printed next to it. There is no score, because a number invites you to feel 82%
safe and there is no such thing here.

Every check is proven able to fail: `audit/test/mutation.test.js` builds a correct
store, asserts green, then breaks the exact thing each check guards, asserts that
check goes red, and asserts it returns to green on revert. A check that cannot be
made to fail is decoration.

The same store with those four fixed:

```
HonorBox audit: the known ways this architecture loses money quietly

scanned /tmp/widget-store (1 source files, 1 product pages)
config  /tmp/widget-store/store.config.json

[  OK  ] A paid checkout that matches no fulfillment grant
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no paid sessions were ever skipped for want of a grant

[  OK  ] The checkout URL pasted where Stripe reports an id
         shipped defect: real bug, reproduced, no victim (2026-07-19)
         1 grant(s) can match a session

[  OK  ] A forked store still selling through the original author's checkout
         shipped defect: real bug, reproduced, no victim (2026-07-19 / 2026-07-20)
         no exact-string URL gates

[  OK  ] A poll cadence that outruns the free tier, then stops delivering
         incident: happened here (2026-07-19)
         .github/workflows/poll.yml schedule "17 * * * *" is ~744 runs/month ≈ 744 billed minutes (jobs round up to 1 min)

[  OK  ] One hung request stalling every buyer behind it
         reasoned guard: has NOT happened here (2026-07-20)
         every fetch() on the money path carries a deadline

[  OK  ] An unstaged file halting delivery
         incident: happened here (2026-07-19)
         no unguarded `git pull --rebase` on the ops path

[  OK  ] Production running a copy of the engine you stopped reading
         incident: happened here (2026-07-20)
         no divergent copies of engine modules

[  OK  ] HTTP 204 logged as if it were a fresh invitation
         incident: happened here (2026-07-19)
         invite code tells 201 (invited) apart from 204 (already had access)

[  OK  ] A buyer flagged for attention that nothing ever tells
         reasoned guard: has NOT happened here
         no ledger rows are flagged needs_attention

[  OK  ] A force-push guard that fails open on the short spelling
         shipped defect: real bug, reproduced, no victim (2026-07-20)
         no force-push guard that misses the refspec form

Live checks skipped (--static-only): payment-link coverage, forked-checkout
detection, dead buy buttons, advertised-price drift, coupon exposure and
invitation expiry all need read credentials. An entry above marked OK was
judged on its static half only, and an entry with no live-checkable half
is not listed at all.

10 entries checked: 0 exposed · 0 warn · 0 unchecked · 10 guarded

13 catalogue entries · 5 from incidents here, 4 from defects we shipped and caught, 4 guarded before they happened.
Known gaps we have NOT closed (1). Read audit/CATALOGUE.md:
  - A 200 that acknowledges dispatch, not delivery: A short secondary throttle is retried in-run (30s per wait, 60s per run, 3 attempts); anything longer, including a primary rate limit, is declined by design and falls to the scheduled poll, whose real recovery time is the next run that actually fires, measured here at up to 3h08m on a quiet private repo.
```

It exits non-zero when anything is `EXPOSED`, which is what makes it a gate
rather than a report: `audit/workflows/conformance.yml` drops into your
storefront repo and fails the build on the day your config drifts into a failure
you read about a year ago and forgot.

The thirteen entries behind these checks, with the incident or defect that put
each one there, are published in full and free at
[docs/failure-catalogue.md](failure-catalogue.md). Reading the catalogue once and
having a gate that will not let you regress are different things, and only one of
them keeps working after you have stopped thinking about it.

## doctor: what a clean preflight looks like

```
[ OK ] config: parses
[ OK ] config: has name
[ OK ] config: has url
[ OK ] config: has theme
[ OK ] config: fulfillment[] present
[ OK ] fulfillment[0]: repo is owner/name
[ OK ] fulfillment[0]: payment_link is a plink_ id
[ OK ] products: at least one
[ OK ] product widget-pro.md: frontmatter
[ OK ] product widget-pro.md: id/name/price
[ OK ] product widget-pro.md: payment_link is checkout URL
[ OK ] stripe: plink_… exists
[ OK ] stripe: plink_… active
[ OK ] stripe: price_… exists
[ OK ] github: you/widget-pro-access reachable
[ OK ] github: you/widget-pro-access is private
[ OK ] github: token can admin you/widget-pro-access
[ OK ] site: config.url reachable

18 checks, 0 failing
```

That is one product and one fulfillment entry; the per-product and
per-fulfillment checks repeat, so a bigger catalogue prints more rows. All
three tiers are exercised: offline config checks, live Stripe API, GitHub token
permissions. Without keys the six live checks collapse into two `[WARN]` lines
telling you which variable to set, and the run still exits 0.

## reconcile: what a run tells you

Below is reconcile's output format, on a synthetic store: placeholder handles, a
placeholder product, and masked session ids. The verdicts, the counts line, the
revenue line and the exit code are exactly what the module prints.

It is deliberately not our account's data. Publishing that would model the
opposite of what [least-privilege.md](least-privilege.md) asks of you, and what
you need in order to judge this module is the shape of the answer it gives, not
our numbers. Session ids are masked for the same reason they would be worth
nothing unmasked: retrieving one needs the account's secret key
(`/v1/checkout/sessions/…` answers 401 without it), and the hosted checkout URL
returns a byte-identical page for a fabricated id as for a real one.

```
HonorBox reconcile: last 90 days

[ OK ] 2026-05-14 Widget Pro    29.00 USD  @ada-example      delivered
       cs_live_XXXXXXXXXXXX…
[ OK ] 2026-05-12 Widget Pro    free       @grace-example    delivered
       cs_live_XXXXXXXXXXXX…

2 paid orders in window · 2 confirmed · 0 need attention · 0 not delivered
revenue actually collected: 29.00 USD across 1 paid order (1 zero-cost fulfillment excluded)

Every paid order is confirmed delivered against GitHub, not assumed from a send.
```

The revenue line is the point. A coupon-covered order is a delivery, not a sale,
so reconcile counts them apart and your revenue figure means money that actually
arrived. And each `delivered` is confirmed by asking GitHub whether that account
is a collaborator on that product repo, rather than inferred from having sent an
invite.

The same live orders through a config copy carrying the two most common setup
mistakes (a mistyped price id; a grant pointing at a repo the token cannot see):

```
[UNREADABLE] you/widget-pro-typo: GitHub collaborators for you/widget-pro-typo failed: Not Found
  buyers on the repo(s) above could not be checked at all.

[LOST] 2026-05-12 ?            29.00 USD  @grace-example    PAID, NO GRANT
       this order matches no fulfillment grant: the engine skipped it and the money is sitting in your account with nothing delivered
       cs_live_XXXXXXXXXXXX…

1 paid orders in window · 0 confirmed · 0 need attention · 1 not delivered

1 order(s) took money and delivered nothing. That is the list to act on today.
```

Exit 1, so a scheduled run fails loudly. A repo it cannot read is reported as
unreadable, never silently counted clean.

Scope note in the same spirit: our store has never had a pending or expired
invitation, so those verdicts are covered by the module's test suite over
fixtures (18 tests) rather than by a live catch. The test that matters most
there pins that GitHub's own `expired` flag decides expiry, never our clock.

## guard: what the alarm issue says

The suite above gates pushes, but the failures worth fearing do not arrive by
push: a link gets deactivated in a dashboard, an invitation ages toward
GitHub's 7-day expiry, and the repo never changes. The guard is a drop-in
Actions workflow for your private ops repo that runs audit and reconcile four
times a day and turns anything red into one GitHub issue there, so the alarm
arrives the way GitHub already notifies you of everything. Its dry run on the
same synthetic store, carrying one deliberate mistake and no keys:

```
guard: 2 red, 3 unchecked, 0 to watch.

DRY RUN: the alarm issue would carry this:
title: Store guard: 2 red, 3 unchecked

## Red

- **audit: grant-shape** fulfillment[0] ("Widget Pro") payment_link is a checkout URL, not an id
  Fix: the matcher compares against session.payment_link, which Stripe reports
  as a plink_ id. As written, every sale of this product is silently skipped.

## The guard could not see

These reads never happened, so this store is unwatched in exactly the
places listed. A check that could not run is not a check that passed.

- **audit: Stripe** no STRIPE_SECRET_KEY
- **reconcile: the reconcile run** reconcile: STRIPE_SECRET_KEY is not set. There is nothing to reconcile against.
```

One issue, ever: the same failures on the next run refresh its body without
notifying, a changed picture posts a comment, and the first green run closes
it with a resolution note. A run that could not reach Stripe is an alarm, not
a pass, which is the difference between a monitor and a checklist.

## ops bots: real issue, real ack

Issue [Honorboxx/honorbox#1](https://github.com/Honorboxx/honorbox/issues/1)
is public, so you can verify this one yourself: it was auto-acknowledged
and labeled `support` by `bots.js` on the next cycle:

```
acked issue #1: Test: invite didn't arrive [support]
```

The refund guard runs in the same cycle on the same store. Its revocation path
(collaborator removal plus pending-invitation cancellation) executes against
the same GitHub API calls you can read in `ops-bots/bots.js`, and it scopes
each revocation to the repos that purchase granted, matched by payment link,
so a buyer who owns two products and refunds one keeps the other.

## stats: what the command prints

```
report -> report.html  (2 orders, gross 29.00 USD, 0 refunds)
```

Synthetic figures, matching the example store above. The point is the pipeline:
sessions and refunds paginated from the Stripe API, the report rendered to one
offline HTML file, and no tracker anywhere.

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

## The license module: API surface

The whole module is one issuer script and two verification snippets. Below is
its complete public interface: signatures, the token format, the order of
checks, and how it wires into fulfillment. The implementations stay in the
paid repo, but nothing here is a surprise you would discover after paying.

### Token and key format

A license is one line of ASCII, safe in a config file, an env var, or a text
field:

```
base64url(payload).base64url(signature)
```

The payload is plain JSON, so a buyer can read exactly what they were granted:

```json
{ "v": 1, "product": "my-app", "holder": "buyer@example.com", "issued": 1784455200, "expires": null }
```

- `v` is the format version. Verification rejects anything that is not `1`.
- `holder` is whatever you issued to: an email, a name, a GitHub username.
- `issued` and `expires` are Unix seconds. `expires` is `null` for a perpetual
  license, which is the default.
- Signatures are ed25519. The private key is a PKCS#8 PEM you keep in Actions
  secrets; the public key is an SPKI PEM you ship inside your app, and it is
  not a secret.

### Issuing (`sign.js`, Node >= 20, zero dependencies)

```bash
# once: generate the keypair. Private key to your ops repo's Actions
# secrets as LICENSE_PRIVATE_KEY; public key pasted into your app source.
node sign.js keygen

# per sale: issue a token. --days is optional and defaults to perpetual.
LICENSE_PRIVATE_KEY="$(cat private.pem)" \
  node sign.js issue --product my-app --holder "buyer@example.com" [--days 365]
```

`issue` prints the token on stdout and exits 0. A missing `LICENSE_PRIVATE_KEY`
or a missing `--product`/`--holder` exits 2 with a usage message, so a broken
fulfillment run fails loudly instead of committing an empty license file.

### Verifying, JavaScript

```js
verifyLicense(token, publicKeyPem, expectedProduct)
  // => { ok: true,  license: { v, product, holder, issued, expires } }
  // => { ok: false, reason: string }
```

Usage in your app:

```js
const { verifyLicense } = require('./verify');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----`;

const res = verifyLicense(process.env.MY_APP_LICENSE, PUBLIC_KEY, 'my-app');
if (!res.ok) {
  console.error(`Invalid license (${res.reason})`);
  process.exit(1);
}
console.log(`Licensed to ${res.license.holder}`);
```

Node >= 20, no dependencies: ed25519 comes from `node:crypto`.

### Verifying, Python

```python
verify_license(token, public_key_pem, expected_product) -> dict
  # {"ok": True,  "license": {...}}
  # {"ok": False, "reason": "..."}
```

Usage in your app:

```python
from verify import verify_license

res = verify_license(token, PUBLIC_KEY, "my-app")
if not res["ok"]:
    raise SystemExit(f"Invalid license ({res['reason']})")
print("Licensed to", res["license"]["holder"])
```

Python 3.8+, one dependency: `cryptography`.

### The verify flow, in order

Both snippets run the same checks in the same order, and every failure returns
a reason string rather than raising:

1. Split the token on `.`; a missing half returns `malformed`.
2. Base64url-decode both halves and load the public key.
3. Check the ed25519 signature over the payload bytes. Failure returns
   `bad signature`.
4. Parse the payload JSON. Any parse error returns `malformed`.
5. Reject `v != 1` as `unknown version`.
6. Reject a payload whose `product` is not the id you passed as
   `expectedProduct`, returning `wrong product`.
7. Reject a non-null `expires` in the past as `expired`.

So the complete set of reasons your app can surface is `malformed`,
`bad signature`, `unknown version`, `wrong product`, and `expired`. Signature
verification runs before any field is trusted, and a tampered payload fails at
step 3 regardless of what it claims.

Verification never opens a socket. There is no license server to run, nothing
to keep online, and no request to your buyer's machine to explain in a privacy
policy. The trade is explicit: offline verification means a determined user can
patch your binary, and paying customers get software that never breaks because
an endpoint went down.

### How it reaches the buyer

`workflows/fulfill-with-licenses.yml` is a drop-in replacement for the core
fulfill step. Per run: the core `fulfill.js` invites new buyers, then the
license step reads that run's usernames, issues a token for each, and commits
it to `licenses/<username>.license` in the product repo the buyer was just
invited to. Delivery and entitlement ride the same channel, so there is no
second system to secure.

You can confirm the two hooks that step depends on without buying anything,
because they are in this free repo:
[`scripts/fulfill.js`](https://github.com/Honorboxx/honorbox/blob/main/scripts/fulfill.js)
writes `state/new-sales.json` (the usernames fulfilled on that run) and touches
`state/HAD_ACTIVITY` only when a run actually had sales.

## The commerce playbook

Four documents in `playbook/`. Chapter titles are complete; the one-line
summaries are here so you can judge the shape and the specificity before
paying for the prose.

### `launch-pricing.md`: Launch pricing and coupons with Payment Links

1. **Picking the number.** Anchor against three comparables your buyer already
   knows, never against what the thing cost you to build.
2. **The launch-price pattern.** Why a low list price labeled as one beats the
   same price reached by coupon, plus the Payment Link mechanics of raising it.
3. **When to raise, and how to grandfather.** Raise on the schedule you
   announced even when sales are slow, and let repo delivery grandfather early
   buyers automatically.
4. **Coupons that don't cheapen you.** Named codes tied to a real story with
   real expiry dates, and why a permanent sale marks your list price as fiction.
5. **The 100%-off test coupon.** The one end-to-end fulfillment test that
   produces a real Stripe session and moves no money.
6. **Launch week, worked.** A decision tree keyed to which kind of zero you are
   looking at, since week one for an unknown product is zero to three sales.
7. **What you can measure with fewer than ten sales.** Statistically nothing;
   what small numbers give you instead is reasons at high density.
8. **Cross-sell without being gross.** One mention on the confirmation, one
   section in the README, and never through receipt replies.

### `first-ten-sales.md`: The first ten sales

1. **The free tier is the funnel.** Free has to be genuinely sufficient for the
   smallest real use case, because it is the only thing a stranger can evaluate.
2. **Where trust substitutes live.** The four you control without reviews: open
   code, the refund policy stated next to the price, evidence docs, and a
   surface with no typos on it.
3. **The first support ticket is a review.** On GitHub it is public, permanent,
   and findable by every future buyer who reads your issues before paying.
4. **The first refund is good news.** The densest information you will get all
   quarter, and proof the revocation machinery ran with real stakes.
5. **What not to do, with the reasons.** Fake urgency, fake social proof, paid
   ads, and spam, each with the arithmetic or the mechanism that kills it.
6. **What to do instead.** The short boring list: be findable where your buyers
   already are, ship visibly, answer fast, ask every early buyer one question.

### `vat-primer.md`: The self-serve seller's EU VAT primer

1. **The one-paragraph model.** EU B2C digital sales are taxed where the buyer
   lives, and OSS exists so you register once instead of 27 times.
2. **Thresholds, when it actually bites.** The €10,000 micro-exemption for EU
   sellers, the absence of one for non-EU sellers, B2B reverse charge, and the
   domestic obligations that apply from sale one.
3. **What Stripe gives you.** Stripe Tax calculates and collects once you tell
   it where you are registered, its threshold monitoring is free, and it does
   not file your returns.
4. **A sane escalation path.** Three stages, from registering nothing extra to
   paying an accountant, with the trigger for each.
5. **Worked example 1, an EU seller crossing €10,000 mid-year.** The crossing
   sale itself is destination-taxed, the notification deadline is the 10th of
   the following month, and the quarterly cadence starts there.
6. **Worked example 2, a non-EU seller's first EU sale.** A tax-inclusive €29
   German sale contains €4.63 that is Germany's, and what full compliance costs
   in calendar terms.

Not tax advice, and it says so first: rules as generally understood mid-2026,
with a standing instruction to verify anything that matters with an accountant.

### `multi-product.md`: Multi-product stores

1. **Files.** One markdown file per product, one grant per payment link, and
   why announcements should link product URLs rather than your home page.
2. **Per-product private repos.** One repo per product, because a pooled
   customers repo cannot revoke one product without revoking all of them.
3. **Bundles.** The honest-simple bundle is a third product whose payment link
   carries several grant rows, one per repo it should invite to.
4. **Refunds when there are N repos.** Scoping revocation to the repos that
   purchase actually granted, so refunding one product does not cost a buyer
   the other.
5. **Catalog hygiene.** The order you retire a product in, what a retired
   product sitting inside a live bundle needs, and why product ids are forever.

## The store itself

The storefront, fulfillment cron, and delivery pipeline this repo documents
are the ones that just delivered *this repo* to you. That end-to-end path
(live Stripe checkout → scheduled poll → repo invite) was verified with a
real completed order before launch and runs on schedule since.
