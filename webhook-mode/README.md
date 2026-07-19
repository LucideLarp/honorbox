# Webhook mode: delivery in seconds (optional)

By default HonorBox delivers by polling Stripe on a schedule: zero servers,
zero extra accounts, minutes of delay (occasionally more when GitHub's cron
drifts). Webhook mode adds a ~140-line relay on a free serverless tier that
turns each paid checkout into an immediate fulfillment run. **The poll stays
on as the safety net**: whichever fires first delivers, the other no-ops.

```
Stripe webhook ──▶ relay: verify signature ──▶ repository_dispatch ──▶ ops repo
                   (rejects unsigned/stale)     "honorbox_sale"          └▶ runs fulfill.js now
```

The relay does no fulfillment, holds no Stripe API key, and forwards no buyer
data. It verifies the webhook signature and says "a sale happened, go look".
Fulfillment truth always comes from Stripe's API via the normal poller logic,
so a forged or replayed webhook can at worst trigger an empty run.

Two interchangeable single-file variants, both dependency-free:

| File | Runs on |
|---|---|
| `relay-cloudflare.mjs` | Cloudflare Workers (free tier, no card) |
| `relay-node.mjs` | Val Town (free tier, no card) as an HTTP val, or `node relay-node.mjs` on any Node ≥ 20 box behind TLS |

## Turn it on (~10 minutes)

1. **Ops repo:** copy `setup/workflows/fulfill-on-sale.yml` →
   `.github/workflows/fulfill-on-sale.yml`. Uses the secrets already there.
2. **Token:** GitHub → Settings → Developer settings → Fine-grained tokens:
   Repository access = *only your ops repo*; Permissions = **Contents:
   Read & write** (GitHub's minimum for `repository_dispatch`).
3. **Relay:** paste one of the files above into Cloudflare Workers (or a
   Val Town HTTP val) and set its env secrets:
   - `GITHUB_TOKEN`: the token from step 2
   - `GITHUB_REPO`: `you/yourstore-ops`
   - `STRIPE_WEBHOOK_SECRET`: comes from step 4
4. **Stripe:** Dashboard → Developers → Webhooks → Add endpoint: the relay
   URL, events `checkout.session.completed` and
   `checkout.session.async_payment_succeeded`. Copy the signing secret
   (`whsec_…`) into the relay's `STRIPE_WEBHOOK_SECRET`.
5. **Test:** the endpoint page's "Send test event" should produce a
   "Fulfill on sale" run in the ops repo within seconds (it finds no real
   paid session and no-ops, which proves the whole pipe).

Secrets live only in the relay platform's secret store and the ops repo's
Actions secrets. They are never in any repo and never in code.

## Guarantees and limits

- Signature verification is hand-rolled (HMAC-SHA256 over `t.body`,
  constant-time compare, 5-minute replay window) and covered by
  `scripts/test/dispatch.test.js`: known-good vector passes, tampered
  payload/forged signature/stale timestamp are rejected. It is **mandatory**;
  don't deploy with it removed.
- If the GitHub dispatch fails the relay returns 502 and Stripe retries the
  webhook automatically. No queue to build, no state in the relay.
- If the relay is down entirely, delivery degrades to the scheduled poll,
  exactly the default behavior.

Full walkthrough and threat model: [docs/instant-delivery.md](../docs/instant-delivery.md).
