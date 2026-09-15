# ADR-003: Emergency access is bounded, approved and attributable — not blocked

- Status: Accepted
- Date: 2026-09-15
- Article: 05

## Context

The instinct after reading an outage report is to make emergency access harder.
Taken far enough, that produces a path nobody can use during an emergency,
which is indistinguishable from not having one.

## Decision

Model break-glass on Privileged Access Manager's shape: an entitlement naming
who may request what and for how long, a grant that is time-bounded, and
automatic revocation at expiry. Require justification and dual control. Refuse
self-approval. Never suppress the record.

## Why this option

Each rule is there because of a specific failure, and each is a test.

**Expiry, not revocation** (`T18`, `N4`). Roles are "revoked by Privileged
Access Manager" at "the end of the grant duration", enforced with "time-based
IAM Conditions". Nobody has to remember. Permanent break-glass credentials are
the most common version of this design and the worst.

**Dual control** (`T15`, `N5`). Without approval, one compromised account is
the entire recovery plane. With it, one is not enough.

**No self-approval** (`T15`). A realistic configuration lists the same on-call
person as both a valid requester and a valid approver. That is not dual control
and the evaluator refuses it explicitly rather than relying on policy text.

**Justification required** (`T16`). Not for the auditor. For the responder, six
weeks later, reading their own record.

## The property that matters most

`T20`: the recovery path cannot quietly become a normal daily path. Bounded
grants mean continuous use requires continuous, individually justified,
individually approved, individually logged requests. The path is not blocked
from routine use; it is made extremely visible, which is stronger, because a
blocked path gets circumvented and a visible one gets noticed.

## Consequences

An emergency takes slightly longer: a second person must approve. That is a
real cost during an incident and it is the correct trade, because the
alternative — a single credential that works instantly and forever — is the
thing most likely to appear in the next incident report.

## Conditions that would change the decision

A genuine single-operator context, where dual control cannot exist. Then
attribution and expiry must carry the whole weight, and that should be a
recorded decision rather than a silent default.
