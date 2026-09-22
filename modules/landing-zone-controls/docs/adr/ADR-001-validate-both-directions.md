# ADR-001: The suite fails when the golden path breaks, not only when a guardrail leaks

**Status:** accepted
**Date:** 2026-09-22

## Context

The obvious shape for a landing-zone test suite is a list of things that must
be refused: no public buckets, no disallowed regions, no stored keys, no
crossing the perimeter. Every one of those is easy to write and easy to keep
green.

A suite of that shape is maximally green on a platform where nothing can be
done at all. Revoke every role in the organization and all six of this module's
guardrail cases still pass. The suite cannot distinguish a well-governed
platform from a dead one.

That is not a hypothetical failure mode. It is the observed behaviour of the
LOCKED zone in `results/report.md`: 6/6 guardrails held, 5 of 5 golden-path
steps refused, and one viable escape route.

## Decision

Every run evaluates two populations against the same landing zone:

- **guardrail cases**, which must be refused, by a named layer and — where the
  layer has more than one way to say no — for a named reason;
- **golden paths**, which must succeed, within a stated budget of permissions
  and manual approvals, with no viable escape route.

`runSuite` passes only if both populations hold. A guardrail added in response
to an incident that breaks the paved road turns the suite red, and it should,
because that guardrail has not reduced risk — it has relocated the work.

## Consequences

- The suite reports four distinct failures rather than one: guardrail leak,
  path break, over-privilege or over-friction, and viable escape.
- Escape routes are evaluated only when the path is already blocked. A bypass
  nobody has a reason to take is a guardrail question, not a friction one, and
  conflating them would manufacture findings (test N4).
- The friction budget is a number someone has to choose. Four permissions and
  zero approvals is this module's choice for one workload shape, not a
  recommendation. Real budgets come from watching what developers actually do.
- Two properties in this module are deliberately *outside* the guardrail
  population: audit independence and exception lifecycle. Both are properties
  of the zone rather than of an action, and forcing them into an action-shaped
  case would have hidden them. The LOCKED zone's erasable audit trail is
  visible only because of that split.
