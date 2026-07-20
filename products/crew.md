---
id: crew
order: 2
name: Crew
meta_title: Crew ($19): 10 agents and 14 discipline skills for Claude Code
description: 10 specialist agents and 14 discipline skills for Claude Code, designed as one system and installed in one command. Free tier on GitHub; $19 for the full pack.
tagline: 10 specialist agents and 14 discipline skills for Claude Code, designed as one system and installed in one command.
price: $19
price_note: one-time · lifetime access & updates
badge: New
payment_link: https://buy.stripe.com/8x29AT8J9d7xdqc8hma7C03
features:
  - 10 specialist agents: reviewer, debugger, planner, tester, security, perf, refactorer, docs, simplifier, captain
  - 14 discipline skills: TDD, verification-before-done, PR authoring, accurate changelogs, safe shipping
  - Six safety hooks: git, shell, exfil, scope and secret guards, plus post-edit format (commented, auditable shell, with test suites)
  - CLAUDE.md starter templates for solo and team repos
  - One-command installer with dry-run, conflict detection, and clean uninstall
  - Free tier on GitHub: 3 agents + 3 skills, MIT, try before buying
---

30 days to change your mind, no questions asked, refunded through Stripe.
[The refund policy in full](./refunds.html).

## Every file has one job, and one non-job

The reviewer knows what the debugger owns. The verification skill knows what
"done" means for both. `ROSTER.md` is the design document that assigns each of
the twenty-four files a job, a boundary and a hand-off, and it says plainly
that any overlap between two of them is a bug worth filing an issue over.

## Check it before you pay

A prompt pack is the one kind of product you cannot evaluate through the box,
so we opened it.
[SAMPLES.md](https://github.com/Honorboxx/crew/blob/main/SAMPLES.md) publishes
the complete text of one paid agent and one paid skill, the `description` of
all eighteen paid-only files, and the exact `diff` between the six free files
and their paid counterparts. That diff is six inserted cross-references and
nothing else, which means the [free tier](https://github.com/Honorboxx/crew)
is an honest sample of the writing: judge the bar on the three free agents and
you have judged it on the files you have not read.

The same page carries a recorded run of the free reviewer and a paid agent
against the same public commit of this store's engine. They overlapped on one
observation out of fifteen, and disposed of it in opposite directions, each
correctly for its own job. The free reviewer also
found a real bug on a money path in our own code, and that finding is
published intact rather than edited out of the transcript.

It also names the three files we think are the weakest in the pack, with the
reasons. You would find them a day after paying anyway.

## What's inside

**Ten agents.** A correctness reviewer that reads *outside* the diff (most
review-detectable bugs live in unchanged code whose assumptions just broke), a
systematic debugger that forms ranked hypotheses before touching anything, a
planner that argues scope before code, plus tester, security, performance,
refactoring, docs, simplifier, and a release captain that takes a branch from
code-done to published and stops the line when preflight fails.

**Fourteen skills.** The disciplines that keep agent work verifiable:
test-driven development, verification before claiming done, PR authoring,
accurate changelogs, safe shipping checklists, structured handoffs between
sessions.

**Hooks and templates.** Six auditable shell hooks and CLAUDE.md starters for
solo and team repositories. Five are guards that block: force-pushes to main,
destructive shell commands, exfiltration, out-of-scope edits, and secrets
entering files. The sixth, format-on-edit, is a convenience that fails open.

**The installer.** POSIX sh, zero dependencies: `--dry-run` narrates before
touching anything, checksum-based conflict detection refuses to clobber your
edited files, `--uninstall` removes exactly what it installed. Tested against
fresh, upgraded, and conflicted setups.

## How delivery works

Checkout asks for your GitHub username. The fulfillment bot invites that
account to the private `Honorboxx/crew-full` repository, usually within
minutes and always within a few hours. Access is permanent; updates land in
the same repo.

## Terms

- $19, one-time. No subscription. Every later update is included at no extra
  cost.
- Licensed per developer; use across all your projects.
- Don't republish or resell the pack itself.
- 30-day refunds, no questions asked, via Stripe.
- Support: GitHub issues or honorbox@proton.me.
