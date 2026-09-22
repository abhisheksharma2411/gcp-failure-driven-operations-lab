# ADR-003: Protection is a ratchet, and the operator is in the threat model

- Status: Accepted
- Date: 2026-09-22
- Article: 06

## Context

Operator error and ransomware share a property that ordinary availability
engineering does not address: the adversary holds valid credentials. Replication
propagates their actions faithfully. Snapshots in the same project are
deletable by the same identity.

## Decision

Model the protected copy on a locked retention policy: deletion fails inside
the retention period, the policy cannot be removed or shortened, and extending
it is always permitted.

## Why this option

Because the documented behaviour is unusually strong, and unusually specific:

> "Once a retention policy is locked, you cannot remove it or reduce the
> retention period it has."

> "Attempts to delete or replace objects whose age is less than the retention
> period fail with a `403 - retentionPolicyNotMet` error."

> "you cannot delete a bucket with a locked policy unless every object in the
> bucket has met the retention period."

And the asymmetry, which is the design:

> "you prevent the policy from ever being removed or the retention period from
> ever being reduced (although you can still increase the retention period)"

The safe operation is always available; the unsafe one never is. That is what a
ratchet means, and it is why locking is `irreversible` by design rather than by
oversight.

Negative control `N3` covers the subtler attack. A privileged identity that
cannot delete an artifact may instead shorten its retention to zero and then
delete it legitimately. `setRetention` refuses that on a locked artifact, and
permits it on an unlocked one.

## The related fact worth stating

A Spanner backup "resides in the same instance, region, and project as its
source database" and "can't outlive its parent instance." So it survives the
common accident — dropping a database — and does not survive deleting the
instance. The documented remedy is to copy it elsewhere, which is a deliberate
act somebody has to perform.

That is the same shape as Article 5's finding about audit logs: a small number
of controls hold against the person holding the credentials, and for this threat
model only those count.

## Consequences

Locked retention cannot be undone, including by the owner, including by
mistake. That is the intended property and it has a cost: storage that cannot
be reclaimed early, and a retention decision that must be right the first time.

## Conditions that would change the decision

A legal deletion obligation that conflicts with a locked retention period is a
real and unresolved conflict. The article names it and does not attempt to
resolve it, because doing so would be legal advice.
