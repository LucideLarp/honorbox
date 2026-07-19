# HonorBox Pro: production evidence (public copy)

Pro is delivered as a private repo, which fairly reads as "blind purchase."
This document is the audit surface: transcripts of every Pro module running
against the live store, the license module's complete API surface, and the
playbook's full table of contents. The `terminal` theme is published whole in
this repo (`themes/terminal/`), so the code standard is checkable before you
pay for the rest.


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

Two caveats so the numbers line up: the lines above are an excerpt (14 of the
18), and the run predates Crew, so it covers a single product and a single
fulfillment entry. The store sells two products today, and a current run
covers both. All three tiers are exercised either way: offline config checks,
live Stripe API, GitHub token permissions.

## ops bots: real issue, real ack

Issue [Honorboxx/honorbox#1](https://github.com/Honorboxx/honorbox/issues/1)
(public; verify yourself): opened as a delivery-problem test, auto-acknowledged
and labeled `support` by `bots.js` on the next cycle:

```
acked issue #1: Test: invite didn't arrive [support]
```

The refund guard runs in the same cycle on the same store. Its revocation path
(collaborator removal plus pending-invitation cancellation) executes against
the same GitHub API calls you can read in `ops-bots/bots.js`, and it scopes
each revocation to the repos that purchase granted, matched by payment link,
so a buyer who owns two products and refunds one keeps the other.

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
