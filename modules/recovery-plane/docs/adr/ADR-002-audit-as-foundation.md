# ADR-002: The audit log is the foundation because the operator cannot break it

- Status: Accepted
- Date: 2026-09-15
- Article: 05

## Context

Every component in a recovery plane is a dependency, including the ones meant
to make it trustworthy. A recovery path whose audit trail can be disabled by
the person using it is not auditable.

## Decision

Anchor the evidence on Admin Activity audit logs, and model them as a component
with no dependencies and no failure domains.

## Why this option

Because the documentation makes a claim almost nothing else does:

> "Admin Activity audit logs are always written; you can't configure, exclude,
> or disable them."

And it holds even against the most obvious attempt to remove it:

> "Even if you disable the Cloud Logging API, Admin Activity audit logs are
> still generated."

Plus immutability: "Log entries written by Cloud Audit Logs are immutable."

That combination is unusual and is what makes it a foundation rather than one
more thing to check. Most controls protect against an outsider. This one holds
against the operator, which is the threat model that matters for a path whose
entire purpose is elevated access under pressure.

Privileged Access Manager writes into it: "Privileged Access Manager events,
such as creation of entitlements, requisition or review of grants, are logged
to Cloud Audit Logs."

## Consequences

The lab models an audit record written on both the granted and the denied path,
because a denial is the more interesting record — it is what a review reads
after an incident to find out who tried.

`T19` and `N6` assert it. The recovery plane's honesty does not depend on the
responder choosing to log anything.

## Conditions that would change the decision

Nothing available. If the guarantee were ever narrowed, the whole design would
need a different evidence anchor, and there is not an obvious second choice.
