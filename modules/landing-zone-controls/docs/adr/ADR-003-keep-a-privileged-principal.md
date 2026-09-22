# ADR-003: The fixtures keep a principal who can pass the identity layer

**Status:** accepted
**Date:** 2026-09-22

## Context

A configuration guardrail is meant to demonstrate that a constraint refuses a
resource shape. If the principal in the test case lacks the IAM permission for
the operation, the action is refused before the constraint is ever consulted,
the case goes green, and the constraint is untested.

This is not a theoretical concern. It happened during development. The
negative-control mutation that disables the short-lived-credential rule left
every guardrail passing, because the mutated fixture had no grants for the
build identity and the case was being refused for lacking a permission
instead.

## Decision

Two things:

1. The fixtures keep `user:platform-admin@example.com` holding `roles/editor`
   over the workload folders, and the configuration and perimeter guardrail
   cases use it. The identity layer therefore says yes, and the refusal that
   follows is attributable to the layer under test.
2. `GuardrailCase` carries `expectDeniedBy`, and — where a layer has more than
   one way to refuse — `expectReason`. A case refused by the wrong layer, or by
   the right layer for the wrong reason, fails (tests N2 and N5).

## Consequences

- A principal with editor over two folders exists permanently in the PAVED
  fixture. That is a real smell in a least-privilege design, and the article
  names it rather than hiding it: the platform team's own access is the hardest
  privilege to reduce, and the honest mitigation here is that it stops at the
  security folder, which is what keeps the audit trail independent (test A4).
- Mutation fixtures must be faithful copies of the zone with exactly one thing
  removed. `pavedZoneMissing` builds from the same hierarchy function for that
  reason; the earlier stripped-down version is what produced the false pass.
