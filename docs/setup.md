# Setup: from fork to first sale

Time: ~30 minutes. Cost: $0/month — the arithmetic is in
[§6](#6-what-this-costs), not asserted. You need a GitHub account and an
activated Stripe account (charges enabled).

## 1. Your storefront repo

1. Fork (or "Use this template") this repo. Public is recommended: Pages is
   free on public repos and the open store *is* your credibility.
2. Edit `store.config.json`:
   - `name`, `kicker`, `headline`, `tagline`, `subline`: your store's voice.
   - `url`: `https://<user>.github.io/<repo>` (or your custom domain later).
   - `seller`: who the merchant is. Use your real name or entity; it builds
     trust and it's the law in most places.
   - `sections`: keep, edit, or delete the marketing sections. They're plain
     JSON; the `compare` and `faq` types cover most needs.
3. Delete the shipped product files (`products/honorbox-pro.md` and
   `products/crew.md`) and write your own. One `.md` per product, same
   frontmatter shape. Both ship with HonorBox's real `payment_link`, so a
   store that keeps them sends its buyers to HonorBox's checkout and the
   money lands in HonorBox's Stripe account. The build refuses to produce
   that store once `repo` is yours, and names the files to fix.
4. `node scripts/build.js` locally and open `dist/index.html` to preview.

## 2. Stripe

**Fast path:** `STRIPE_SECRET_KEY=rk_... node scripts/init.js --name "My Tool"
--price 2900 --repo you/product-access` (a temporary restricted key; scopes in
[least-privilege.md](least-privilege.md)) creates the Product, Price, and a
correctly-configured Payment Link, and wires `store.config.json` +
`products/<id>.md` for you. Skip to §3. The manual path:

1. Dashboard → Products → **Add product**: name, price (one-time), currency.
2. Create a **Payment Link** for that price:
   - Add a **custom field**: label "GitHub username (for delivery)",
     key `github_username`, type text, **required**.
   - After payment → show a confirmation message like: *"You're in. Your GitHub
     account will be invited to the private repo, usually within minutes and
     always within a few hours. Trouble? Reply to your receipt."*
   - Leave "allow promotion codes" **off** unless you are actively running a
     coupon. `init.js` generates links with it off on purpose: a link that
     accepts typed codes plus any live 100%-off coupon is a free copy of your
     product to anyone who guesses the code. Turn it on for a campaign, turn it
     back off when the campaign ends. Section 7 shows how to test without it.
3. The link gives you two different values, and they go in two different
   places:
   - the **URL** goes in your product's `payment_link` frontmatter; that is
     what the Buy button opens.
   - the **id** (starts with `plink_`, visible in the link's URL in the
     dashboard or via the API) goes in `store.config.json` →
     `fulfillment[].payment_link`, with the target private repo in `repo`
     (e.g. `you/yourproduct-access`).

Stripe reports the id, not the URL, on the checkout session, so a URL in
`fulfillment[].payment_link` matches nothing: the sale is skipped, the run
still exits green, and the buyer is never invited. `fulfill.js` prints a
`CONFIG` warning for that shape on every poll, but the grant is easier to
get right the first time.

## 3. The product repo

Create a **private** repo containing what buyers get (code, files, releases).
Buyers are invited with read (`pull`) permission. Updates = you push, they pull.

## 4. Pages deploy

Copy `setup/workflows/deploy.yml` to `.github/workflows/deploy.yml` in your
fork (it lives in `setup/` so the template pushes cleanly with minimal token
scopes). Then: repo → Settings → Pages → Source: **GitHub Actions**. Push to
`main`; the workflow builds and publishes.

`static/` ships HonorBox's IndexNow key file. Replace it with your own key
file or delete it: the deploy workflow reads the host and key from
`store.config.json` and `static/`, and skips the ping when there is no key.

Prefer no CI? Build and publish `dist/` to a `gh-pages` branch yourself.
`dist/` is in `.gitignore`, so it needs a force-add:

```bash
node scripts/build.js
git add -f dist && git commit -m "build"
git subtree push --prefix dist origin gh-pages
```

Pages serves either way.

## 5. Fulfillment (the ops repo)

Keep secrets and state **out of your public repo**:

1. Create a **private** repo, e.g. `you/yourstore-ops`.
2. Copy into it: `scripts/fulfill.js`, `scripts/lib/`, your `store.config.json`,
   and `setup/workflows/fulfill.yml.example` → `.github/workflows/fulfill.yml`.
3. Add **Actions secrets**:
   - `STRIPE_SECRET_KEY`: create a **restricted key** in Stripe (Developers →
     API keys → Create restricted key) with only **Checkout Sessions: Read**.
     Don't use your full secret key if you don't have to.
   - `GH_FULFILL_TOKEN`: a fine-grained PAT scoped to your private product
     repo(s) with **Administration: Read & write** (for collaborator invites).
     The ops-repo state commit uses the workflow's own `GITHUB_TOKEN`, not this
     PAT; add **Contents: Read & write** on the *storefront* repo only if you
     enable the public-ledger option below. Full scope map:
     [least-privilege.md](least-privilege.md).
4. (Optional, off by default) Actions **variable** `PUBLIC_STORE_REPO` =
   `you/yourstore` to publish the anonymized ledger to a public trust page on
   your storefront. Skip it to keep sales data private.
5. Run the workflow once manually (Actions → Fulfill orders → Run workflow) and
   check the log.

## 6. What this costs

$0/month, and here is the arithmetic rather than the assurance.

**GitHub Pages + the storefront build.** Your storefront repo is public, and
Actions minutes in public repositories are not billed at all — GitHub's own
wording is "There are no billable minutes when using GitHub Actions in public
repositories." So the site build and deploy are free at any frequency.

**The fulfillment poll.** This is the only part with a meter on it. Your ops
repo is private, and private-repo Actions bill against **2,000 free
minutes/month** on the GitHub Free plan. Two rules decide the bill:

- Each *job* is rounded **up to a whole minute** — "GitHub rounds the minutes
  and partial minutes each job uses up to the nearest whole minute."
- A fulfillment run takes ~15 seconds, so it is billed as **1 minute**,
  whether it finds a sale or not.

So the monthly cost of polling is simply its run count, and the shipped
`*/30` cron is sized to fit a 31-day month:

| Poll cron | Runs/month (31d) | Billable minutes | Inside 2,000? |
|---|---|---|---|
| **`*/30` (shipped default)** | 1,488 | 1,488 | **yes** — 512 spare |
| `*/20` | 2,232 | 2,232 | no — 232 over |
| `*/15` | 2,976 | 2,976 | no — 976 over (~$5.86/mo at $0.006/min) |
| `*/5` | 8,928 | 8,928 | no — 4.5x the tier |

The 512 spare minutes are real headroom, not rounding: they cover
sale-triggered runs (`fulfill-on-sale.yml` costs 1 minute per sale, so 512
sales/month before the free tier binds) and any manual re-runs.

If you turn on the optional heartbeat (§ [instant-delivery.md](instant-delivery.md)),
loosen this cron to hourly — heartbeat nudges cost an ops-repo minute each, and
hourly + hourly is the same 1,488 minutes as a lone `*/30`.

**What you actually wait for.** With the `*/30` default and no webhook relay,
a buyer's invite lands a median of **~15 minutes** after payment (uniform
arrival inside a 30-minute window) and ~30 minutes worst case *if GitHub runs
the cron on time*. It often does not: GitHub's scheduler is best-effort and
drops scheduled runs on quiet repos, so real worst case is a few hours. That
is why the confirmation message promises "usually within minutes, always
within a few hours" and why webhook mode (seconds, and free) exists for
sellers who want the wait gone.

**Stripe** takes its per-transaction percentage and no monthly fee. That is a
cost per *sale*, not per month, and it is the only money that leaves.

The one edit that can put you over: tightening the poll cron. Everything else
here scales with sales, not with time.

## 7. Test the whole pipe before launch

Your generated payment link does not accept typed promotion codes (see step 2),
so a test order goes through a coupon you apply yourself. Two ways, both $0 and
neither needing a card.

**A. Temporarily allow codes on the link** (simplest, all in the Dashboard)

1. In Stripe, create a coupon for **100% off**, `max_redemptions` 1–2, with an
   expiry. Bound it; an unbounded 100% coupon is the whole risk here.
2. On the payment link, turn "allow promotion codes" on, and create a promotion
   code only you know. Do not use a guessable name like `FREETEST`.
3. Buy your own product with it, entering a real GitHub username.
4. Confirm the invite arrives and the ledger row appears. No refund needed; the
   order was $0.
5. **Turn "allow promotion codes" back off and deactivate the code.** This step
   is not optional. A working 100%-off code left live on a public product page
   is a free copy of your product for anyone who finds it.

**B. Pre-applied coupon on a Checkout Session** (no flag to remember to unset)

Create the Session from the API with `discounts[0][coupon]=<coupon_id>` — the
coupon id, not the promotion code — and open the URL it returns. The link's
promo setting is irrelevant, so there is nothing to switch back off afterwards.
This is the path this project uses for its own testing.

Either way you are exercising the real pipe: a `$0` order completes with
`amount_total: 0`, which fulfillment treats as paid and logs distinctly from a
paying customer, so your test never masquerades as revenue.

## 8. Going live checklist

- [ ] Payment link opens and shows your product + custom field
- [ ] `store.config.json` fulfillment uses the `plink_` id, not the URL
- [ ] Fulfillment run is green and idempotent (run it twice; second run does nothing)
- [ ] Terms/refunds/privacy pages say something true
- [ ] Stripe receipts enabled (Settings → Emails → successful payments)
- [ ] Read [docs/tax.md](tax.md) once, all the way through
