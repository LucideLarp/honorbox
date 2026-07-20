# How HonorBox works (and its limits)

## Architecture

Three repos, no servers:

| Repo | Visibility | Holds |
|---|---|---|
| storefront | public | static site source, built to GitHub Pages |
| product | private | what buyers get; buyers invited read-only |
| ops | private | fulfillment workflow, Stripe key, state, ledger source |

**No webhooks.** Fulfillment is a poll: a scheduled Action lists Stripe Checkout
Sessions created since the last cursor (with a 25-hour overlap window, wider
than Stripe's 24-hour default session expiry so a checkout completed a day
after it was opened is never missed) and
processes the ones that are `complete` and paid. Idempotency comes from a
committed set of processed session ids, so re-runs and overlaps are safe.

**Why polling beats webhooks here:** a webhook needs an always-on endpoint:
a server, TLS, retries, signature verification, and a place for secrets
to leak. A poll from CI needs none of that and is at most ~15 minutes behind,
which is fine for "invite to a repo" delivery.

## Delivery model

The only delivery channel is a **GitHub collaborator invite** to the private
product repo. That's deliberate:

- It's access-controlled: no "secret download URL" that leaks.
- It's durable: buyers keep access and get updates via `git pull`.
- It's auditable: the invite log is the entitlement record.

**Sending the invite is not the same as delivering it.** The buyer has access
only once they *accept*, and GitHub expires an unaccepted invitation seven days
after it was created. Until they accept, every system you own reads "delivered":
Stripe says paid, the ledger has a row, the run is green. If they never open the
email, that stays true right up to the moment the invitation lapses, and then
they have nothing permanently, with nothing anywhere saying so.

The engine does not watch for this: `fulfill.js`'s job ends when GitHub accepts
the invite. Two things make it visible and one makes it go away:

- Put "accept the invite" in your post-payment confirmation and receipt. Most
  buyers who miss it simply did not realise there was a second step.
- Watch `GET /repos/{owner}/{repo}/invitations` for anything old. Pro's
  [ops bots](https://github.com/Honorboxx/honorbox-pro) sweep it for you, and
  its reconciler pairs it back to the money.
- Re-issuing an invitation restarts the seven-day clock, so an invitation can be
  held open indefinitely. Doing it by hand from the repo's Settings page takes
  ten seconds; the Pro sweep does it automatically before each one expires.

The cost: by default delivery is not instant (the poll runs on a schedule and
GitHub sometimes delays it). Set that expectation at checkout:
"usually within minutes, always within a few hours." If you want near-instant
delivery, opt into [webhook mode](instant-delivery.md): a signed Stripe webhook
hits a tiny serverless relay you supply (free tier) which fires a GitHub
`repository_dispatch`, and fulfillment runs in seconds. Polling stays the
zero-infra default; webhook mode is the upgrade for when minutes aren't fast
enough.

## Buyer-input safety

The GitHub username is buyer-supplied text from a Stripe custom field. Before it
touches any API call it must match `^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$` (no
doubled hyphens). Invalid input never reaches a URL; the order is flagged
`needs_attention` in the ledger and a human fixes it from
the Stripe dashboard. Usernames are never interpolated into workflow YAML.

## The ledger

Every fulfillment appends to `ledger/ledger.json` in your **private** ops repo:
date, product, amount, currency, buyer country, and a 10-char SHA-256 prefix of
the session id. No names, emails, or usernames. It's your bookkeeping.

Publishing it is **opt-in**: copy the file into your storefront repo and the
builder renders a public `/trust` page. Some sellers like the radical
transparency; keeping it private is the default.

## Security posture

- Stripe key lives only in the private ops repo's Actions secrets. Use a
  **restricted key** (Checkout Sessions: Read); fulfillment never needs to
  move money.
- The PAT is fine-grained: admin only on the product repo(s).
- Secret-bearing workflows run on `schedule`/`workflow_dispatch` only: no
  `pull_request` surface, no third-party actions in those jobs.
- Public repo workflows (Pages deploy) carry no secrets beyond the default
  scoped token.

## Failure modes

| Failure | What happens |
|---|---|
| Buyer typos username | Order flagged `needs_attention`; fix by hand from Stripe dashboard (buyer email is there); refund if unreachable |
| Buyer never accepts the invite | Nothing looks wrong anywhere: paid, ledgered, green run. The invitation expires after 7 days and they are left with nothing. Re-invite them (it restarts the clock), and see [Delivery model](#delivery-model) |
| GitHub cron delayed | Delivery late by minutes to hours; confirmation message sets expectation |
| Actions outage | Sales queue up; next run drains the backlog (poll + idempotency) |
| Stripe key leaked | Restricted key limits blast radius to reading checkout sessions; rotate in dashboard |
| Refund issued | Revoke collaborator access by hand (or leave it; your call) |
