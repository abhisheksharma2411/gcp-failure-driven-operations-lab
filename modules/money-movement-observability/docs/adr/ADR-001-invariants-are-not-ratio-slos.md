# ADR-001 — A business invariant gets a detection-and-repair objective, not a ratio

## Status

Accepted.

## Context

The obvious way to put "the journal balances" into an SLO catalogue is to make
it a ratio: the proportion of posting groups whose debits equal their credits,
with a goal of 100%.

Cloud Monitoring's own guidance refuses that shape in plain words. A service
required to meet a 100% SLO goal has no error budget, and setting such an SLO
is described there as bad practice. The reasoning is sound: an error budget is
what makes an objective a decision-making tool rather than a number on a slide,
and a goal with no budget cannot inform a decision.

So the catalogue had a problem. Either the ledger objective is a ratio below
100%, which asserts that some rate of unbalanced journals is acceptable, or it
is a ratio at 100%, which the platform's own documentation calls bad practice.

## Options considered

**A. A ratio below 100%, for example 99.99% of journals balanced.** Honest
about the fact that defects happen, consistent with the rest of the catalogue,
and tooling-friendly. It also says, in writing, that one journal in ten
thousand may be wrong and nobody needs to do anything. For a ledger that is not
a target anybody would defend out loud.

**B. A ratio at 100%.** Says the right thing and leaves no budget, so there is
no way to express "we are inside tolerance" and no way to prioritise against it.
It also makes every single occurrence a breach of an annual objective, which
produces a catalogue nobody can act on.

**C. Not a ratio at all.** Express the objective as two durations: how long a
violation may exist before it is detected, and how long after detection before
it is repaired. The budget that gets consumed is time, not money.

## Decision

Option C, for the ledger-posting and settlement-finality tiers. Those objectives
carry `detectMinutes` and `repairMinutes` and no goal. The customer-promise,
service-processing and provider-outcome tiers stay as ratios.

## Why this option

A conservation law and a service level are different kinds of statement. "99.9%
of requests succeed" is a claim about a distribution, and a budget over a
distribution is meaningful. "Debits equal credits" is not a distribution; it is
either true or there is an incident. What varies is not whether it holds but how
long you took to notice and how long you took to fix it, and those are exactly
the two quantities a responder can be held to.

It also makes the objective independent of volume. A ratio objective over
journals looks better in a quiet week; a duration does not move because traffic
did. What the module measures directly is the repair half: the incident loop
records the gap between the alert firing and the invariant being verified
healthy again, and the report prints it. The detection half is not measured
here, because in this model the checker runs instantly and in-process; its real
floor is the check interval plus the metric pipeline's ingestion delay, and
`docs/MODEL.md` says so.

## Consequences

- The catalogue has two kinds of objective in it, which is more to explain. The
  SLO document has to say which kind each one is.
- Error-budget tooling that assumes a ratio cannot consume these objectives.
  They have to be reported as durations.
- A test enforces the split: every objective in the ledger or settlement tier
  must be `detect-and-repair`, must have no goal, and must carry both durations.
  A separate test enforces that no ratio objective is set to 100%.

## Conditions that would change this

If an organisation's error-budget process genuinely cannot consume anything but
ratios, option A with a very tight goal and an explicit note that every
occurrence is investigated is defensible. The thing not to do is option B: an
objective with no budget that nobody can act on becomes an objective nobody
looks at.
