---
title: Privacy
meta_title: Privacy, what is collected and what is kept · HonorBox
description: This storefront collects nothing. What Stripe collects at checkout, what GitHub sees on delivery, and the exact fields the fulfillment bot records.
---

This storefront collects nothing at all. Checkout collects what Stripe needs
to take a payment, delivery needs a GitHub username, and that is the whole of
it. Last updated 2026-07-20.

## What this site collects

Nothing. The storefront is static HTML on GitHub Pages: no analytics, no
cookies, no tracking pixel, no forms, and no script, stylesheet, font or image
loaded from a third party. You do not have to take that on faith. View the
source of any page here. This page carries no script tag at all; the few that
carry one carry a single block of JSON describing the products to search
engines, and nothing else. Every asset is served from this site.

GitHub hosts the site and logs requests as any web host does. That log belongs
to GitHub, is governed by GitHub's privacy statement, and the seller never
sees it.

## What checkout collects

Checkout is a Stripe Payment Link and happens on Stripe's own page rather than
this one. Stripe collects:

- your email address,
- your payment details,
- your billing country, and a fuller billing address where the payment method
  or the card network requires one,
- the GitHub username you type into the delivery field.

It does not ask for a phone number, a shipping address, or a tax ID, and no
sales tax or VAT is calculated or added at checkout.

Stripe's privacy policy governs that data. In the Stripe dashboard the seller
can see your email address, your country and your GitHub username. Your card
number is never visible to the seller.

## What delivery involves

Delivery is an invitation to a private GitHub repository. GitHub therefore
learns that the account you named was invited, and emails that account at the
address on it. You are a collaborator on that repository until access ends.

## What the fulfillment bot records

One line per sale, in a private repository, containing exactly: the time of
the order, the product name, the amount and currency, the buyer's country as
Stripe reported it, and a truncated one-way hash of the Stripe session id.

It records no name, no email address, and not the GitHub username. The one
exception is failure: when a delivery cannot be completed the error is kept so
a person can repair it by hand, and that error text can contain the username
that was rejected.

A separate working file lists which Stripe session ids have already been
handled, so that a restart cannot deliver the same order twice. It holds
identifiers, not people.

## Retention, and asking for deletion

The sale line is kept as the seller's ordinary commercial record. To have a
fulfillment record deleted once any refund window has passed, email
honorbox@proton.me or reply to your Stripe receipt.

Stripe keeps its own transaction records for as long as financial regulation
requires and the seller cannot delete those. That is true of every Stripe
merchant, including each platform this store compares itself against.

## What is never done

Nothing collected here is sold, shared, or used for advertising. Buying does
not subscribe you to anything: Stripe sends a receipt, and there is no
marketing email and no mailing list. If that ever changes it will be something
you opt into, and this page will say so before it does.

Questions about any of the above go to honorbox@proton.me.
