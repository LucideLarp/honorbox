---
title: Sell digital products with Stripe Payment Links: the complete guide
---

Stripe Payment Links are the fastest way to charge money on the internet: no
code, no server, a URL you can put anywhere. This guide covers actually
*selling digital products* with them, including the part Stripe doesn't do
for you: delivery. Useful whether or not you use our tool; we mark the one
section where we're selling you something.

## 1. Create the product and price (2 minutes)

Dashboard → Products → Add product. One-time price, your currency. For digital
goods sold internationally, most indie sellers price in USD. Buyers everywhere
are used to it and Stripe converts.

## 2. Create the Payment Link

Create a Payment Link from that price. Three settings that matter for digital
goods:

- **Collect a delivery handle.** Add a custom field: for products delivered
  through GitHub, the buyer's GitHub username; for other goods, whatever
  identifies where the product goes. Without this you'll fulfill by replying
  to receipt emails forever.
- **Confirmation message.** After payment, the buyer sees a hosted message.
  Say exactly what happens next and how long it takes ("your repo invite
  usually arrives within minutes, always within a few hours"), and how to
  reach you if it doesn't. Vague messages create support tickets and disputes.
- **Promotion codes toggle** if you ever want launch coupons.

## 3. Deliver the digital product (the hard part)

A completed Payment Link checkout gives you money and a `checkout.session`
object. It does not give the buyer anything. Your options, in increasing
order of infrastructure:

1. **Manual.** Stripe emails you per sale; you email the goods. Fine for the
   first sales, doesn't survive a launch spike or a weekend away.
2. **Secret download URL in the confirmation message.** Instant and zero
   infra, but one buyer can share the link and there's no per-buyer control.
3. **Webhook + server + mailer.** The classic: `checkout.session.completed`
   fires, your endpoint generates a license or link and emails it. Fully
   flexible; you now operate TLS, retries, a mail sender, and an inbox for
   bounce handling.
4. **Polling from CI** *(the part where we sell you something: this is what
   our free, MIT-licensed [HonorBox](https://github.com/Honorboxx/honorbox)
   does)*. A scheduled GitHub Action lists recent checkout sessions, reads
   the buyer's GitHub username from the custom field, and invites them to a
   private repo with the goods. Access-controlled per buyer, revocable on
   refund, no server, no webhook endpoint, no mailer. The cost: delivery
   takes a few minutes, and buyers need GitHub accounts.
   [See it running on this store](./index.html); our own checkout is this
   exact pipeline.

Option 4 in depth: [Deliver digital products through GitHub](./deliver-digital-products-github.html).

## 4. Receipts, refunds, disputes

- Turn on receipt emails (Settings → Emails → successful payments).
- Decide your refund policy before launch and write it down where buyers can
  find it. For $10–50 digital goods, "30 days, no questions" costs you almost
  nothing and prevents disputes. A single chargeback typically costs a $15
  fee plus the payment, more than several refunds put together.
- Refund fast. A refund request answered in an hour rarely becomes a dispute.

## 5. Tax on digital products, in one paragraph

With Payment Links you are the merchant of record: VAT/sales tax on digital
goods is your responsibility, unlike on Gumroad or Lemon Squeezy where the
platform is the seller. Practically: most small sellers start below
registration thresholds; enable Stripe Tax's free threshold monitoring on day
one, and read the rules for your own country once. Our
[plain-language tax explainer](https://github.com/Honorboxx/honorbox/blob/main/docs/tax.md)
goes one level deeper without the hand-waving. Not tax advice.

## 6. The launch checklist

- Product + one-time price created
- Payment Link with a delivery-handle custom field
- Confirmation message states delivery method and latency
- Delivery automated (any of options 2–4)
- Receipt emails on, refund policy written
- Stripe Tax threshold monitoring on

## Related

- [Gumroad alternatives (2026): fees, trade-offs, and when DIY wins](./gumroad-alternatives.html)
- [Lemon Squeezy vs Gumroad vs DIY (2026): fees compared](./lemon-squeezy-vs-gumroad-vs-diy.html)
- [Deliver digital products through GitHub: the practical guide](./deliver-digital-products-github.html)
