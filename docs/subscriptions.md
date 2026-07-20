# Selling a subscription

Written for someone who has never run a subscription business. If you only sell
one-time, you can close this page: subscriptions are off unless you switch them
on, and nothing here changes how your store works today.

## What this does

Delivery already works for a recurring price. A customer checks out, and the
engine invites them to your private repo exactly as it would for a one-time
sale. What this page adds is the other half: **when a subscription ends, the
customer is removed from the repo.**

Without it you are selling a subscription that never lapses, which is a
donation with extra steps.

## Read this before you price anything

**A lapse takes away updates, not the product.**

Your product is delivered as a repository invitation. On day one your customer
clones the repo, and that copy is on their machine forever. When their
subscription ends we remove them as a collaborator, which stops them pulling
anything new. It does not, and cannot, reach into their laptop and delete what
they already have. Nothing in git works that way.

So what you are selling is **continued access and future updates**, not use of
the software. That is a perfectly good thing to sell, and it is what most
source-code subscriptions actually are. But price it, and describe it, as what
it is. A customer who subscribes for one month and cancels keeps that month's
version.

This is also why HonorBox does not offer free trials. A trial of a git repo
hands over the whole product on day one, so the trial never really ends. If you
want people to try before buying, publish a demo, a limited build, or good
documentation instead.

## Turning it on

Add one block to `store.config.json`:

```json
"subscriptions": {
  "enforce": false,
  "grace_days": 7
}
```

Then schedule the reconciler alongside your fulfillment job:

```
node scripts/reconcile-subs.js --config store.config.json \
  --state state/subscriptions.json --bots-state state/bots-state.json
```

`--bots-state` is where removals are written down. If you run the ops bots, use
the same path they use, so the two agree about who has been removed. Getting
this wrong is what would let one part of the system invite back somebody another
part just removed.

**Leave `enforce` set to `false` at first.** That is reporting mode: the
reconciler works out exactly who it would remove and prints it, and removes
nobody. Watch it for a few days. When the list only ever names people who really
did cancel, set `enforce` to `true`.

Nobody should have to trust software with their customers' access on its first
run. Reporting mode costs you a few days and removes the entire category of
"I switched it on and it emptied my repo".

## What happens for each subscription state

Stripe gives every subscription a status. Here is what each one means for your
customer's access, in plain terms.

| Stripe says | We do | Why |
|---|---|---|
| `active` | Keep access | They are paying. |
| `trialing` | Keep access | A trial you configured is running. |
| `past_due` | **Keep access** | Their card failed and Stripe is still retrying. See below. |
| `incomplete` | Nothing | Their first payment has not gone through yet. |
| `unpaid` | Start the grace clock | Stripe retried and gave up. They can still pay and come back. |
| `canceled` | Start the grace clock | They cancelled, or Stripe cancelled for them. |
| `paused` | Depends on why | A paused trial lapses. A pause you asked for keeps access. |
| Anything unfamiliar | Keep access, and tell you | We never remove someone on a status we do not recognise. |

### `past_due` is not a cancellation, and we treat it that way

This is the most important row. When a card fails, Stripe does not give up. It
retries on a schedule you control, by default 8 attempts over 2 weeks, and up to
2 months if you choose.

Throughout all of that the subscription sits in `past_due`, and **we never
remove anybody for it.** A customer whose bank declined one payment while they
were on holiday keeps working the whole time.

Only when Stripe finishes retrying, and the subscription becomes `canceled` or
`unpaid`, does the clock start. Then your grace period runs on top.

With the defaults that is roughly **three weeks from the first failed payment to
losing access**, and up to two months and a week if you use the longest retry
window. Losing access is never a surprise.

**One thing to check in your Stripe dashboard.** Under Billing, the failed
payment setting can be "cancel the subscription", "mark as unpaid", or "leave
past-due". If you pick the third one, subscriptions stay `past_due` forever, and
since we never remove anyone for `past_due`, **nothing will ever be enforced.**
The reconciler notices this and warns you, but it is easier to just pick one of
the first two.

## The grace period

`grace_days` is how long access continues after a subscription genuinely ends.
It defaults to 7.

This is on top of everything Stripe already did. It exists for the customer who
meant to renew, whose card expired, who was away. Seven days of access costs you
very little; removing someone who was about to pay you costs a lot more.

You can set it as low as 0, but the reconciler will warn you, and you should
have a reason.

## The safety limit

The reconciler will not perform a large number of removals at once. If a single
run would remove more than **the larger of 3 people or 10% of your
subscribers**, it removes *nobody*, writes down what it wanted to do, and tells
you.

This is deliberate. Almost every way this could go badly wrong, a typo in your
config, a bad API key, a renamed repo, looks the same from the inside: suddenly
every customer appears to have cancelled. Real cancellations trickle. Bugs
arrive all at once. The limit tells those apart.

If it ever trips, nothing has been taken from anyone. Read the warning, fix what
it points at, and run it again.

## Undoing a removal

Every removal is printed with the exact command to reverse it:

```
WARN: REVOKED alice from acme/widget (subscription sub_xxx canceled, grace expired;
lapsed since 2026-07-01T00:00:00.000Z).
Undo: gh api -X PUT repos/acme/widget/collaborators/alice -f permission=pull
```

Copy the `Undo:` line and run it. The customer is invited straight back.

One caveat worth knowing: a re-invitation has to be accepted from the email
GitHub sends, and those expire after 7 days. If a customer says they never got
back in, check for a pending invitation on the repo.

### If they resubscribe

Every removal is written to a list of people whose access was taken away on
purpose, and each entry records **why**: a subscription that lapsed, or a
refund. That list is what stops other parts of the system from quietly inviting
a removed customer back in.

When a former customer subscribes again they are invited normally, and what
happens to their old entry depends on why they were removed.

**They lapsed and have now resubscribed.** The entry is cleared automatically.
A new subscription answers a lapse, so everything returns to normal, including
automatic renewal of their invitation.

**They were refunded and have now subscribed again.** The entry stays. They are
still invited and the invitation still works, it just will not be automatically
renewed if they leave it unaccepted for a week. The reconciler prints a warning
naming them.

That difference is deliberate and it is not symmetric. The cost of leaving a
refund entry in place is that one returning customer may have to click a second
invitation email. The cost of clearing it wrongly is that anyone who gets a
refund and then starts a subscription is handed their old access back
automatically. Those are not the same size of mistake, so they do not get the
same rule.

If a refunded customer really has returned for good, clear their entry from
`revoked_access` in your bots state file and renewals resume.

Entries written before this behaviour existed carry no reason, and those are
treated as refunds. Not knowing why access was removed is not a good enough
reason to give it back.

## Who can never be removed

The reconciler only ever removes people **it invited itself, for a
subscription.** It works from its own records and never from the repo's
collaborator list.

That means it cannot touch:

- you, or anyone on your team
- contributors and anyone you added by hand
- one-time buyers, including anyone who bought before you switched this on
- anyone whose subscription is still running under any other plan

If you remove a product from your config entirely, its customers keep their
access. "I stopped selling this" and "remove all these people" are different
things, and we assume the first.

## What we do not do

- **Free trials.** See the top of this page.
- **Multiple seats per subscription.** Coming. Today one subscription grants
  access to the one GitHub account that checked out.
- **Metered or usage-based billing.** Repo access is on or off.
- **Different permission levels per plan.** Everyone gets read access.
- **Dunning emails or a customer portal.** Stripe Billing does these properly,
  and you should turn them on there.
