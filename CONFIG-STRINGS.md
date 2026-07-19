# Config string changes for the owner to apply

Two items. **Item 1 is a change to make now.** Item 2 is the checklist for the
day the 25th copy sells; nothing to apply yet.

I did not edit `store.config.json` myself, per the brief.

---

## Item 1: state the price ladder in the store's own words (apply now)

**Why this is needed and the product pages are not enough:** on the home page,
both themes hide the companion card's price note (`.product-card.companion
.price small { display: none }` in `themes/stand/style.css:277` and
`themes/terminal/style.css:138`). Crew is the companion card, so a home-page
visitor sees Crew's `$19` with no ladder at all. The FAQ is the only place on
the home page where the commitment can be stated for both products.

It also answers the question the ladder creates. A launch price that goes up
invites "is this real, or is it a permanent fake sale," and that question is
better answered by us than assumed by the reader.

**JSON path:** `sections[4].items` (the `faq` section, "Straight answers").
**Change:** insert a new object at index `6`, immediately before the existing
`"Refunds?"` item. Nothing is replaced; the existing items shift by one.

```json
{
  "q": "Why does the price go up after 25 copies?",
  "a": "Pro is $29 for the first 25 copies, then $39. Crew is $19 for the first 25, then $24. That is a launch price with a real end: it goes up once, and it stays up. Anyone who buys at the launch price keeps every later update at no extra cost, because updates land in the repo they already have access to. There's no countdown and no live counter on the page, because a number nobody can audit isn't worth putting there."
}
```

For reference, the item it should sit above is unchanged:

```json
{
  "q": "Refunds?",
  "a": "30 days, no questions asked, refunded through Stripe to your original payment method. Repository access ends when a refund is issued."
}
```

---

## Item 2: what has to change when the 25th copy sells

Not a change to apply now. It is here because the raise touches Stripe and the
config together, and getting it half-done is the failure that silently stops
fulfilling sales.

### The order that matters

`playbook/launch-pricing.md` is explicit that a Payment Link's price cannot be
edited in place. Raising the price means creating a new price and a new link,
then swapping it. And `playbook/multi-product.md` is explicit that the old
`fulfillment` row has to stay for at least the refund window, because a
checkout completed a minute before the swap still needs fulfilling and a late
refund still needs its row to map back.

So at raise time:

1. Create the new price and a new Payment Link in Stripe. Do not deactivate the
   old link yet.
2. **Add** a new row to `fulfillment[]` with the new `payment_link` and `price`.
   Leave the old row in place for 30 days, then remove it.
3. Update the product markdown (below) and push.
4. Deactivate the old Payment Link once the new one is live on the site.

Doing step 3 without step 2 is the dangerous one: the store advertises a link
whose `plink_` id has no `fulfillment` row, so buyers pay and nothing invites
them. `doctor` catches this, so run it after the swap.

### Strings that change, Pro

All in `products/honorbox-pro.md` frontmatter:

| Field | Now | After the raise |
| --- | --- | --- |
| `price` | `$29` | `$39` |
| `price_note` | `one-time · lifetime access & updates · $29 for the first 25 copies, then $39` | `one-time · lifetime access & updates` |
| `meta_title` | `HonorBox Pro ($29): license keys, 4 themes, ops bots for your Stripe + GitHub store` | same with `($39)` |
| `description` | `... $29 one-time, lifetime updates.` | `... $39 one-time, lifetime updates.` |
| `payment_link` | current `buy.stripe.com/aFa9AT...` | the new link |

Body, `## Terms`, first bullet:

- Now: `$29, one-time, for the first 25 copies; $39 after those are sold. No subscription, no upsell treadmill. Buyers at $29 keep every later update at no extra cost, because updates land in the repo you already have access to.`
- After: `$39, one-time. No subscription, no upsell treadmill. Updates are included for as long as the product exists, because they land in the repo you already have access to.`

### Strings that change, Crew

All in `products/crew.md` frontmatter:

| Field | Now | After the raise |
| --- | --- | --- |
| `price` | `$19` | `$24` |
| `price_note` | `one-time · lifetime access & updates · $19 for the first 25 copies, then $24` | `one-time · lifetime access & updates` |
| `meta_title` | `Crew ($19): 10 agents and 14 discipline skills for Claude Code` | same with `($24)` |
| `description` | `... $19 for the full pack.` | `... $24 for the full pack.` |
| `payment_link` | current `buy.stripe.com/8x29AT...` | the new link |

Body, `## Terms`, first bullet:

- Now: `$19, one-time, for the first 25 copies; $24 after those are sold. No subscription. Buyers at $19 keep every later update at no extra cost.`
- After: `$24, one-time. No subscription. Updates are included for as long as the product exists.`

### And in `store.config.json`

| JSON path | Now | After the raise |
| --- | --- | --- |
| `fulfillment[0].payment_link` | `plink_1Tudl9E9zX2nUu1OZywmp76G` | new `plink_` id, added as a new row |
| `fulfillment[0].price` | `price_1TudkyE9zX2nUu1OTQhtZq8Q` | new `price_` id |
| `fulfillment[1].payment_link` | `plink_1TupsnE9zX2nUu1OV1JOs3x3` | new `plink_` id, added as a new row |
| `fulfillment[1].price` | `price_1TupsmE9zX2nUu1O0MI3E8oR` | new `price_` id |
| `sections[4].items[6].a` | the launch-price answer added in item 1 | remove the item, or rewrite it as the raise announcement |

The FAQ answer added in item 1 promises the price goes up once and stays up. On
raise day it either goes or becomes the announcement. Leaving it live at $39
turns the one honest urgency mechanic on the store into a false claim, which is
the exact failure `playbook/launch-pricing.md` warns about.
