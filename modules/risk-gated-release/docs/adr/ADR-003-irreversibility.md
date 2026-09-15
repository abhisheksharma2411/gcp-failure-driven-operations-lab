# ADR-003: Reversibility is proved, not asserted

- Status: Accepted
- Date: 2026-09-15
- Article: 04

## Context

Every rollback plan is fine until it is used. The gate `REVERSIBLE` could be
satisfied by a checkbox, and in most organisations it is.

## Decision

Treat a change marked irreversible as unable to satisfy `REVERSIBLE`, even if
the gate is otherwise listed as satisfied. The evaluator overrides the claim.

## Why this option

Because the failure mode is specific and common: a destructive migration, a
deleted IAM binding, a dropped column, or a rule whose removal is itself a
change with its own blast radius. In each case a pipeline can be told the
change is reversible, and the claim is simply false.

`T9` asserts that the override fires. `N4` shows the same change promoting when
`irreversible` is false and blocking when it is true, with nothing else
different.

The deeper point for the article: rollback and roll-forward are different
strategies with different preconditions, and a system that conflates them will
discover the difference during an incident. A change that cannot be rolled back
is not forbidden — it needs a different plan, and the manifest's job is to
force that plan to exist before promotion rather than after.

## Consequences

Teams must mark irreversibility honestly, and the incentive runs the other way.
This is a genuine weakness: the flag is self-reported. The mitigation is that
it is auditable after the fact — the audit record carries the flag, so a
post-incident review can ask why a destructive change was marked reversible.

## Conditions that would change the decision

Automated detection of irreversibility for specific change classes — a schema
diff that drops a column, for instance — would let the system infer the flag
rather than trust it. That is a better design and is out of scope here.
