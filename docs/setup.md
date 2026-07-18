# Setup: from fork to first sale

Time: ~30 minutes. Cost: $0/month. You need a GitHub account and an activated
Stripe account (charges enabled).

## 1. Your storefront repo

1. Fork (or "Use this template") this repo. Public is recommended — Pages is
   free on public repos and the open store *is* your credibility.
2. Edit `store.config.json`:
   - `name`, `kicker`, `headline`, `tagline`, `subline` — your store's voice.
   - `url` — `https://<user>.github.io/<repo>` (or your custom domain later).
   - `seller` — who the merchant is. Be honest; it builds trust and it's the law
     in most places.
   - `sections` — keep, edit, or delete the marketing sections. They're plain
     JSON; the `compare` and `faq` types cover most needs.
3. Replace `products/honorbox-pro.md` with your own product file (same
   frontmatter shape; see comments there). One `.md` per product.
4. `node scripts/build.js` locally and open `dist/index.html` to preview.

## 2. Stripe

1. Dashboard → Products → **Add product**: name, price (one-time), currency.
2. Create a **Payment Link** for that price:
   - Add a **custom field**: label "GitHub username (for delivery)",
     key `github_username`, type text, **required**.
   - After payment → show a confirmation message like: *"You're in. Your GitHub
     account will be invited to the private repo within the hour — usually
     minutes. Trouble? Reply to your receipt."*
   - (Recommended) In Payment Link settings, allow promotion codes — you'll
     want launch coupons.
3. Paste the Payment Link URL into your product's `payment_link` frontmatter
   **and** into `store.config.json` → `fulfillment[].payment_link`, with
   the target private repo in `repo` (e.g. `you/yourproduct-access`).

Note the **Payment Link id** (starts with `plink_`, visible in the link's URL
in the dashboard or via the API) — the fulfillment matcher uses the id from the
session, which Stripe reports as `payment_link`. Put the id, not the URL, in
`fulfillment[].payment_link`.

## 3. The product repo

Create a **private** repo containing what buyers get (code, files, releases).
Buyers are invited with read (`pull`) permission. Updates = you push, they pull.

## 4. Pages deploy

Copy `setup/workflows/deploy.yml` to `.github/workflows/deploy.yml` in your
fork (it lives in `setup/` so the template pushes cleanly with minimal token
scopes). Then: repo → Settings → Pages → Source: **GitHub Actions**. Push to
`main`; the workflow builds and publishes. Prefer no CI? `node scripts/build.js`
and push `dist/` to a `gh-pages` branch instead — Pages serves either way.

## 5. Fulfillment (the ops repo)

Keep secrets and state **out of your public repo**:

1. Create a **private** repo, e.g. `you/yourstore-ops`.
2. Copy into it: `scripts/fulfill.js`, `scripts/lib/`, your `store.config.json`,
   and `setup/workflows/fulfill.yml.example` → `.github/workflows/fulfill.yml`.
3. Add **Actions secrets**:
   - `STRIPE_SECRET_KEY` — create a **restricted key** in Stripe (Developers →
     API keys → Create restricted key) with only **Checkout Sessions: Read**.
     Don't use your full secret key if you don't have to.
   - `GH_FULFILL_TOKEN` — a fine-grained PAT scoped to your private product
     repo(s) with **Administration: Read & write** (for collaborator invites)
     and **Contents: Read & write** on the ops/storefront repos (to push ledger).
4. (Optional, off by default) Actions **variable** `PUBLIC_STORE_REPO` =
   `you/yourstore` to publish the anonymized ledger to a public trust page on
   your storefront. Skip it to keep sales data private.
5. Run the workflow once manually (Actions → Fulfill orders → Run workflow) and
   check the log.

## 6. Test the whole pipe before launch

1. In Stripe, create a coupon for **100% off** with 1–2 max redemptions and a
   promotion code only you know.
2. Buy your own product with it (costs $0, no card needed), entering a real
   GitHub username.
3. Run the fulfillment workflow; confirm the invite arrives and the ledger row
   appears. Refund/cleanup isn't needed — the order was $0.

## 7. Going live checklist

- [ ] Payment link opens and shows your product + custom field
- [ ] `store.config.json` fulfillment uses the `plink_` id, not the URL
- [ ] Fulfillment run is green and idempotent (run it twice; second run does nothing)
- [ ] Terms/refunds/privacy pages say something true
- [ ] Stripe receipts enabled (Settings → Emails → successful payments)
- [ ] Read [docs/tax.md](tax.md) once, honestly
