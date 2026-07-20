# Least privilege: the two keys, scoped honestly

"You want my Stripe secret key in a GitHub Action?" No. HonorBox never
needs your full secret key, and it never needs a broad GitHub token.
Delivering a sale is two calls, both visible in
[`scripts/fulfill.js`](../scripts/fulfill.js) (under 300 lines, read it):

| Call | Why | Secret |
|---|---|---|
| `GET /v1/checkout/sessions` (list, expanding line items) | find new paid checkouts | `STRIPE_SECRET_KEY` |
| `PUT /repos/{repo}/collaborators/{user}` (read-only invite) | deliver the product | `GH_FULFILL_TOKEN` |

Keeping that sale delivered adds three more, in
[`scripts/renew-invites.js`](../scripts/renew-invites.js). GitHub expires an
unaccepted invitation after seven days, so the fulfillment workflow re-issues
one before that happens ([how-it-works](how-it-works.md#delivery-model)):

| Call | Why | Secret |
|---|---|---|
| `GET /repos/{repo}/invitations` | find invitations about to lapse | `GH_FULFILL_TOKEN` |
| `PUT /repos/{repo}/collaborators/{user}` | re-issue, restarting the 7-day clock | `GH_FULFILL_TOKEN` |
| `DELETE /repos/{repo}/invitations/{id}` | remove the invitation it just superseded | `GH_FULFILL_TOKEN` |

No Stripe key is involved: renewal never looks at money, so the step that runs
it is not given one. The same file's `--revoke`, which you run by hand after a
refund, additionally calls `DELETE /repos/{repo}/collaborators/{user}`.

Selling a subscription adds its own calls on top, in
[`scripts/reconcile-subs.js`](../scripts/reconcile-subs.js). That feature makes
no call at all until you configure it ([subscriptions.md](subscriptions.md)).

Both providers support scoping a credential down to exactly that. This page
gives the exact toggles, what breaks if you cut too deep, and what a leaked
key could and could not do. Set up this way, the scary-sounding secret in
your Actions repo is a read-only sales viewer and a single-repo repo admin,
not your Stripe account and not your GitHub account.

## The Stripe key: a restricted key, read-only

Stripe [restricted API keys](https://docs.stripe.com/keys/restricted-api-keys)
(prefix `rk_live_`) carry only the permissions you pick, one setting per
resource: **None**, **Read**, or **Write**. Stripe's own guidance is to
prefer them over secret keys everywhere. The fulfillment poll only ever
issues GET requests, and in Stripe's model GET maps to **Read**. The key
needs write access to nothing.

Create it: Dashboard → **Developers → API keys → Create restricted key**,
start from zero permissions, then set exactly one resource:

- **Checkout Sessions → Read**
- everything else → **None**

Put that `rk_live_…` value in the ops repo's Actions secret
`STRIPE_SECRET_KEY`. The engine doesn't care which key type it gets: a
restricted key is a drop-in replacement.

Prove it on your own account in one run: trigger the fulfillment workflow
once (Actions → Fulfill orders → Run workflow) and read the log. If a
permission is missing, Stripe rejects the call and, per Stripe's docs,
the error response names the permission to add; the key's request log in
the Dashboard (⋯ → View request logs) shows the same thing. A green
`sessions scanned=…` line is your proof that Read on Checkout Sessions is
all this engine ever asks for. (The poll expands each session's line items;
line items are part of the Checkout Sessions resource, and this one-run
check verifies it against your account rather than asking you to trust us.)

**The one-time `init.js` helper is different.** It *creates* your Product,
Price, and Payment Link, so it needs **Write** on those resources. Don't
give the fulfillment key that power: run `init.js` from your laptop with a
second restricted key (Products → Write, Payment Links → Write; prices are
created under Products), then delete that key in the Dashboard. It never
belongs in Actions secrets. Prefer zero keys? The manual Dashboard path in
[setup §2](setup.md) needs none.

## The GitHub token: fine-grained, one permission, named repos

Delivery is one call: invite the buyer to the private product repo with
read (`pull`) permission. GitHub's
[fine-grained personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
scope to named repositories and named permissions, and GitHub's
[REST permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
maps the invite endpoint to repository **Administration (write)**.

Create it: GitHub → **Settings → Developer settings → Fine-grained tokens
→ Generate new token**:

- **Resource owner**: the account (or org) that owns the product repo. An
  org's repos only appear if the org allows fine-grained PATs. Enable that
  in org settings if the list is empty.
- **Repository access**: *Only select repositories* → your private product
  repo(s). Nothing else.
- **Repository permissions**: **Administration → Read and write**. Nothing
  else. (GitHub adds a read-only Metadata entry on its own.)
- **Expiration**: GitHub's default is 30 days, and non-expiring tokens are
  allowed. Pick a real date (6-12 months) and calendar the rotation
  instead of taking either extreme.

That token is Actions secret `GH_FULFILL_TOKEN`.

Two scope notes that keep this minimal:

- **State commits don't use your PAT.** The workflow pushes fulfillment
  state and the ledger back to the ops repo with its own short-lived
  `GITHUB_TOKEN` (`permissions: contents: write` in the workflow file).
  Your PAT never needs access to the ops repo.
- **Public ledger is the one widener.** Only if you opt into publishing the
  ledger (`PUBLIC_STORE_REPO`) does the PAT also need your storefront repo
  in its repository list with **Contents → Read and write**, because that
  step pushes a file there. Skip the option, skip the scope.

## If you over-restrict, here's what breaks

Nothing fails silently, and no sale is lost: the poll re-reads truth from
Stripe on every run.

| Cut too deep | Symptom | Sale outcome |
|---|---|---|
| Stripe key lacks Checkout Sessions Read | run fails loudly; Stripe's error names the missing permission | nothing processed, state untouched; next good run picks everything up |
| PAT lacks Administration write | invite returns 403; run logs `FAILED`, ledger row flagged `needs_attention` | order is flagged, not retried; fix the token and invite the buyer from the repo page (ten seconds) |
| PAT missing the product repo | GitHub answers 404 (fine-grained tokens don't see repos outside their list) | same flagged path as above |
| PAT lacks storefront Contents write (ledger publishing on) | the publish step fails | delivery already done; only the public trust page lags |
| PAT loses Administration write later | renewal logs `WARN: re-invite ... GitHub returned 403` and does not spend the buyer's renewal allowance; it retries about once a day | the invitation still expires on its original schedule, so fix the token within a few days or re-invite by hand |

## Blast radius, honestly

**Restricted Stripe key leaks (Checkout Sessions: Read).**
Can: read your checkout sessions (buyer names, emails, countries, amounts,
and the GitHub usernames from the delivery field). That is real customer PII
and worth protecting; rotation is one click in the Dashboard.
Cannot: create charges or refunds, move or pay out money, touch products,
prices, payment links, or any other resource. Every non-session call is
refused. Compare Stripe's own words on the alternative: "If an unauthorized
party obtains your secret API key, they can make unauthorized charges,
access customer data, or disrupt your integration."

**Fine-grained PAT leaks (Administration on the product repos).**
Can: fully administer *those repositories*. Invite anyone (including the
attacker) at any permission level, remove buyers, change settings, delete the
repo. Your product's content is at risk on GitHub;
your local clone is the recovery path git already gives you.
Cannot: see or touch any repository outside its named list, read your other
code, act org-wide, or touch Stripe. If you enabled ledger publishing, add
"push to the storefront repo" to the can-list. That's the whole widening.

**Both leak at once.** The attacker reads your sales history and controls
the product repos. They still cannot move a cent.

Rotation drill, either key: revoke in the provider dashboard, mint a
replacement with the same toggles, update the Actions secret. The next
scheduled run heals itself. Flagged rows aside, there is no other state to
fix.

## Optional add-ons, same discipline

The instant-delivery upgrades each use their own separate token (never
this PAT), and each is documented with its minimum:
[webhook relay](instant-delivery.md) (Contents R/W on the ops repo only,
GitHub's floor for `repository_dispatch`) and heartbeat (Actions R/W on the
ops repo only). The relay holds no Stripe key at all.

---

*Permission names above were traced on 2026-07-19 against Stripe's
restricted-key docs ([keys/restricted-api-keys](https://docs.stripe.com/keys/restricted-api-keys),
[keys-best-practices](https://docs.stripe.com/keys-best-practices)) and
GitHub's REST reference
([permissions for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
[collaborators](https://docs.github.com/en/rest/collaborators/collaborators)).
Stripe's Dashboard is the naming authority for its permission toggles; the
one-run check above verifies your key against your account, which beats
trusting any document, including this one.*
