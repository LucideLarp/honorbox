# Tax, without the hand-waving

**HonorBox is not a merchant of record.** When you sell through Gumroad or
Lemon Squeezy, *they* are legally the seller: they charge, collect, and remit
VAT/sales tax, and you invoice them. That service is a real part of what their
fee buys. With HonorBox you sell on your own Stripe account, so **you are the
merchant**, and tax is your responsibility.

What that means in practice (this is orientation, not tax advice):

- **Small volumes are usually simple.** Most jurisdictions only require
  registration past a threshold. Selling a handful of $29 licenses rarely
  triggers anything beyond declaring the income in your home country. Know your
  local rules.
- **EU/EEA digital goods (B2C)** are the strict case: the EU VAT place-of-supply
  rules tax digital products where the *buyer* lives, with a €10,000/yr
  EU-cross-border threshold for EU sellers (non-EU sellers technically have no
  threshold). The OSS/MOSS schemes exist to make filing manageable.
- **Stripe Tax** can calculate and collect tax on your Payment Links (one
  toggle) once you've registered where you need to; it also monitors your
  thresholds. It doesn't file for you (Stripe supports filing in some regions
  through partners).
- **B2B sales** with a valid VAT ID are typically reverse-charged in the EU;
  Stripe Tax handles the VAT-ID collection if enabled.

Rules change and depend on where you live. If your store starts making real
money: enable Stripe Tax, check your local threshold once, and spend one hour
with an accountant. That hour is the cost of keeping 100% of the platform fee.
