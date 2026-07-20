# Instant delivery (optional)

HonorBox's default fulfillment is a poll every 30 minutes: zero
infrastructure, zero accounts beyond Stripe + GitHub, and an invite a median
of ~15 minutes after payment, sometimes hours when GitHub's cron drifts. (The
cadence is set by the free Actions tier, not by taste; the arithmetic is in
[setup.md](setup.md).) The *payment* is always instant; this page is about
shrinking the wait for the *invite*.

Both upgrades here are opt-in. The poll stays on either way; it is the
safety net, and skipping these keeps a perfectly working store.

| Mode | Typical delivery | Worst case | What you add |
|---|---|---|---|
| Poll (default) | ~15 min median | hours (cron drift) | nothing |
| + Heartbeat | ~15 min median | two independent crons must both drift | 1 fine-grained token |
| + Webhook relay | **~15-60 seconds** | falls back to the poll | 1 free serverless endpoint + webhook secret + 1 token |

## Webhook mode: delivery in seconds

```
buyer pays
  └▶ Stripe fires checkout.session.completed ──▶ relay (free serverless fn)
                                                   1. verify Stripe signature
                                                   2. POST repository_dispatch
                                                      "honorbox_sale" ──▶ ops repo
                                                                            └▶ fulfill-on-sale.yml
                                                                               runs the same fulfill.js
meanwhile the scheduled fulfill.yml keeps polling; whichever runs first
delivers; the other is a no-op (processed-set + ledger-ref guard)
```

The relay is one file, ~140 lines, dependency-free, in
[`webhook-mode/`](../webhook-mode/): a Cloudflare Workers variant and a
Val Town / plain-Node variant. Both free tiers take no card. What it does is
deliberately tiny:

- Verifies the `Stripe-Signature` header by hand (HMAC-SHA256 over
  `timestamp.body`, constant-time compare, 5-minute replay window). Unsigned,
  mis-signed, or stale requests are rejected with a 400. **This check is
  mandatory. Do not deploy a relay with it removed.**
- On `checkout.session.completed` (and `async_payment_succeeded`), POSTs one
  `repository_dispatch` to your ops repo and returns 200. If GitHub says no,
  it returns 502, and Stripe retries the webhook on its own schedule. That
  retry loop is the relay's reliability layer.
- Does **no fulfillment itself**. It holds no Stripe API key, reads no buyer
  data, and forwards none.

The exact dispatch payload:

```json
{
  "event_type": "honorbox_sale",
  "client_payload": {
    "event": "checkout.session.completed",
    "livemode": true,
    "created": 1700000000,
    "ref": "58f4e5e2f1"
  }
}
```

`ref` is the same 10-char SHA-256 prefix of the session id the ledger uses,
so a workflow run can be matched to its ledger row. Note what is *not* in
there: no session id, no username, no amount, no email. The workflow never
trusts webhook content. It runs the same poller, which re-reads the truth
from Stripe's API. A forged dispatch can at worst trigger an empty run.

### Turning it on (~10 minutes)

1. **Workflow:** copy `setup/workflows/fulfill-on-sale.yml` to
   `.github/workflows/fulfill-on-sale.yml` in your private ops repo. It uses
   the secrets the ops repo already has; nothing new.
2. **Token:** GitHub → Settings → Developer settings → Fine-grained tokens →
   new token: Repository access = *only your ops repo*, Permissions =
   **Contents: Read and write**. That is GitHub's minimum for
   `repository_dispatch` (there is no dispatch-only permission).
3. **Relay:** Cloudflare `dash.cloudflare.com` → Workers & Pages → Create →
   paste `webhook-mode/relay-cloudflare.mjs`. Add secrets `GITHUB_TOKEN`
   (step 2) and `GITHUB_REPO` (`you/yourstore-ops`). (Val Town instead: new
   HTTP val, paste `relay-node.mjs`, same env vars.)
4. **Stripe:** Dashboard → Developers → Webhooks → Add endpoint: the
   relay's URL, events `checkout.session.completed` +
   `checkout.session.async_payment_succeeded`. Copy the signing secret
   (`whsec_…`) into the relay's `STRIPE_WEBHOOK_SECRET`.
5. **Test:** Stripe's endpoint page → "Send test event" →
   `checkout.session.completed`. Within seconds the ops repo should show a
   "Fulfill on sale" run; the run finds no real paid session and no-ops.
   For a full rehearsal, place a $0 test order using either method in
   [setup §7](setup.md) and watch the invite arrive in seconds.

### Threat model

| Concern | Answer |
|---|---|
| Forged webhook to the relay | Rejected: signature is verified against your endpoint secret before anything else. Replays older than 5 min are rejected even with a valid signature. |
| Signature check removed/broken | Worst case is dispatch spam → empty workflow runs burning Actions minutes. Fulfillment can't be forged, because the workflow re-derives sales from Stripe's API and invites are idempotent. Still: the check is mandatory, and the tests pin it (`scripts/test/dispatch.test.js`). |
| Relay compromised | It holds two secrets: the webhook secret (can only make the relay believe Stripe called) and the GitHub token. It has no Stripe API key, so it cannot read sales or move money. |
| GitHub token leaked | Fine-grained, single-repo. Contents R/W on the ops repo is real blast radius (it can push there). Scope it to *only* the ops repo, never an org-wide or classic PAT. Set a real expiry (6-12 months) and calendar the rotation; GitHub allows non-expiring fine-grained PATs now, don't use one. Tighter-token option: point the relay at `POST …/actions/workflows/fulfill.yml/dispatches` instead and the token needs only **Actions: R/W** (can't push), at the price of losing the typed event and the payload `ref`. |
| Secrets in the repo | Never. Webhook secret and token live only in the relay platform's env/secret store; the workflow uses the ops repo's existing Actions secrets. |
| Relay down / Stripe webhook outage | Delivery degrades to the poll, which is exactly today's behavior. Stripe also retries failed webhook deliveries for days and emails you about a failing endpoint. |
| Double delivery (webhook + poll race) | The two workflows share a concurrency group so they serialize; the processed-set and ledger-ref guard make the second run a no-op; the GitHub invite call itself is idempotent (204 if already invited). |

## Heartbeat: a second scheduler, no new accounts

No relay and no webhook, just a second, independent scheduler. A workflow in a
*different* repo (your public storefront fork is the natural home) fires
hourly and `workflow_dispatch`es the ops fulfill workflow. GitHub crons drift
independently per repo, and a dispatched run starts promptly, so two
schedulers cut the odds of a long gap without any always-on machine.

Heartbeat buys **reliability, not speed**. Pair it with an hourly poll
(`0 * * * *` in `fulfill.yml`, `30 * * * *` here) and you get the same
~15-minute median as the shipped `*/30` poll, for the same 1,488 Actions
minutes a month, but from two schedulers instead of one, so a single
scheduler drifting no longer means a long silence. It does not beat the
webhook relay, and it is not free to run tighter: see the cost note below.

Set up: copy `setup/workflows/heartbeat.yml` into the storefront repo's
`.github/workflows/`, add secret `OPS_DISPATCH_TOKEN` (fine-grained PAT:
*only* the ops repo, **Actions: Read and write**; it can start runs but
cannot read code or secrets, and cannot push) and variable `OPS_REPO`. Details and
limits are in the template's header. The big one: on public repos GitHub
disables schedules after 60 days without repo activity, so a dormant store
eventually loses its heartbeat (you get an email; any push re-arms).

## What this costs you

- **Webhook mode:** one account on a free serverless tier (Cloudflare
  Workers or Val Town, no card either way), one webhook signing secret, one
  fine-grained GitHub token, ~10 minutes. Ongoing: a token rotation once a
  year and one more place where a config can rot.
- **Heartbeat:** one fine-grained token and a workflow file. Ongoing: the
  same token rotation, plus Actions minutes. The heartbeat's own cron runs in
  your public repo, where minutes are free, but each nudge starts a run in the
  **private** ops repo, and private runs bill a whole minute each even when
  they find nothing. So a nudge costs exactly what a poll costs: 1 minute.
  Hourly here + hourly in `fulfill.yml` = 1,488 min/month, inside the free
  2,000. A `*/5` heartbeat would be 8,928 min/month, 4.5x the free tier.
  The arithmetic is in [setup.md](setup.md).
- **Staying on the plain poll costs nothing** and remains the default:
  set the buyer's expectation at checkout ("usually within minutes, always
  within a few hours") and beat it.
