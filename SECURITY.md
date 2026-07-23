# Security policy

## Supported versions

HonorBox is distributed from this repository and run from a copy you host on
your own Stripe and GitHub accounts. Fixes land on the latest release; there is
no separate maintenance branch for older tags.

| Version | Supported |
|---|---|
| latest release (currently 0.5.1) | yes |
| older | no; update to the latest release |

The engine requires Node.js 20 or newer (`engines.node` in `package.json`).

## Reporting a vulnerability

Report privately. Do not open a public issue for a security problem, and please
hold off on public disclosure until a fix is out. Either channel works:

- GitHub private vulnerability reporting: the **Report a vulnerability** button
  under this repository's **Security** tab. The report and the discussion stay
  private to the maintainers.
- Email **honorbox@proton.me**.

A useful report names the version or commit, the file or endpoint involved, what
an attacker gains, and the shortest way to reproduce it. A proof of concept
helps but is not required.

## What to expect

HonorBox is maintained by a small team, so this is best effort, not a
contractual SLA. We aim to acknowledge a report within a few days, fix valid
issues on a timeline set by severity, and keep you posted while we do. We credit
reporters when the fix ships, unless you would rather we did not. There is no
paid bounty program.

## Scope

HonorBox has no server of its own. It is three GitHub repositories and two
scoped secrets, described in [how it works](docs/how-it-works.md) and
[least privilege](docs/least-privilege.md). What that means for a report:

In scope:

- The build and engine scripts under `scripts/`: the storefront builder, the
  fulfillment poller, invitation renewal, and the subscription reconciler.
- The built storefront. It loads no external scripts, styles, fonts, or images,
  so any injection has to come from repository content or from buyer input. The
  one untrusted buyer input is the GitHub username taken from a Stripe checkout
  field; it is validated before it reaches any API call.
- The optional webhook relay in `webhook-mode/`.
- The workflow templates in `setup/` that a seller copies into a private ops
  repo.

Out of scope:

- Stripe and GitHub themselves. Report platform issues to those vendors.
- A seller running with a broader credential than the docs call for. HonorBox is
  built to run on a restricted Stripe key (Checkout Sessions: Read) and a
  fine-grained GitHub token scoped to the product repo; the blast radius of each
  is set out in [least privilege](docs/least-privilege.md). Secrets belong only
  in a private ops repository's Actions secrets, never in this public repository.

The two documents above cover the trust boundaries and key scoping in full; this
policy is the front door to them.
