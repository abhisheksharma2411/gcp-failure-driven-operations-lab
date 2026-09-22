# ADR-002: Recovery is validated by business invariants, not by completion

- Status: Accepted
- Date: 2026-09-22
- Article: 06

## Context

A restore that completes every step has demonstrated that the steps completed.
Whether the resulting system is *correct* is a separate question, and the
cheap signals — row counts, table existence, a successful connection — cannot
answer it.

## Decision

The validation contract asserts business invariants over the restored data. For
the synthetic ledger: every posting sums to zero, every transaction balances
individually, posting ids are unique, no transaction has a single leg, and the
dataset is non-empty.

A restore that completes with a failing invariant returns
`RESTORED_BUT_INVALID`, which is a distinct outcome from success.

## Why this option

Negative control `N4` is the argument. Two restores, one from a clean artifact
and one from an artifact missing a single credit posting:

| | Steps completed | Outcome |
|---|---:|---|
| Clean | 7 of 7 | `RESTORED_AND_VALIDATED` |
| One leg dropped | 7 of 7 | `RESTORED_BUT_INVALID` |

Identical by every structural measure. `deepEqual` on the completed step list
passes. The only thing that separates them is the invariant check, and the
corruption is exactly the kind a row count would mistake for a slightly smaller
dataset.

## Consequences

Someone has to write the invariants, and they have to be about the business
rather than the schema. That is ongoing work and it is the part most likely to
be skipped, for the same reason Article 4's business-verification gate is the
first one dropped: it cannot be bought.

Five invariants for one ledger is the right order of magnitude. A hundred would
rot.

## Conditions that would change the decision

None. A recovery process that cannot tell a correct restore from an incorrect
one is measuring the wrong thing.
