# ADR-001: Required gates follow blast radius, not change type

- Status: Accepted
- Date: 2026-09-15
- Article: 04

## Context

Most release processes classify changes and apply different scrutiny per class.
Application code goes through review, CI, staging and canary. Configuration
goes through a form. Infrastructure goes through a plan review. IAM goes
through a ticket.

Cloudflare's 2019 outage is what that produces. A WAF rule update "went global
in seconds" because it was configuration, and the remediation they published
was to stop treating it that way:

> "Changing the SOP to do staged rollouts of rules in the same manner used for
> other software."

## Decision

Derive required gates from **blast radius** first, with a small number of
type-specific additions. No change type is exempt from the radius set.

## Why this option

The classification-by-type approach fails in a specific way: the taxonomy
becomes a place to hide. Every organisation eventually has a class that means
"this one is quick," and that class is where the next incident comes from.
Radius is harder to argue with, because "how much of the world does this reach"
has an answer that does not depend on which team owns the file.

The type-specific additions are deliberately minimal — schema, IAM and
edge-policy each add a compatibility check, because each can break callers that
were never enumerated. Keeping that list short is a design goal rather than an
accident; a rich taxonomy here would reintroduce the problem.

Test `T1` asserts that every change type at global radius carries the same
seven core gates. `T3` asserts that requirements increase monotonically with
radius, so no combination can be quietly cheaper than a smaller one.

## Consequences

Some changes become more expensive than teams are used to. A one-line IAM
change with global reach now needs staged rollout and a proved recovery path,
which will be unpopular and is the point.

The emergency path exists because a process with no emergency path gets
bypassed entirely, which is worse than one with a narrow, attributable
exception. Provenance and audit identity are never waived.

## Conditions that would change the decision

If an organisation genuinely cannot express blast radius for some change type,
the manifest cannot classify it, and the honest response is to treat it as
global until it can be.
