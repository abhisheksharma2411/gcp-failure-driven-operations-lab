# ADR-002: Policy bindings in this model carry an expiry; real ones do not

**Status:** accepted
**Date:** 2026-09-22

## Context

Google Cloud's documentation states that an organization policy set on a
resource is inherited by all descendants by default, and that a policy set on a
descendant can overwrite that inheritance. Both halves are load-bearing here:
the first is how a guardrail reaches every project, and the second is how a
guardrail acquires a hole.

What the documentation does not describe is any mechanism by which an
overriding policy stops applying. An organization policy has no expiry. Set the
override, and it is in force until a human removes it.

The failure this causes is not exotic. Somebody needs a public bucket for a
partner workshop in March. An override is set on their sandbox project. The
workshop ends. The override does not.

## Decision

`PolicyBinding` carries `expiresAtMs`. `null` means permanent; a number means
the binding stops applying at that instant, and `effectivePolicy` resumes
walking up the hierarchy as if it were not there. A binding with an expiry must
also carry a justification, enforced at construction time.

The module is explicit, here and in the article, that this is a modelling
addition and not a description of a Google Cloud feature.

## Consequences

- The exception lifecycle becomes testable as a pure function of time. Between
  day 29 and day 31 of `results/report.md` nothing is edited, and the
  organization's policy governs again.
- Implementing this against real Google Cloud requires machinery the platform
  does not supply: a scheduled job that reconciles overrides against a register
  of approved exceptions and removes the lapsed ones. The article says so
  rather than implying the behaviour is built in.
- `effectivePolicy` resolves at an instant and caches nothing. A cached
  resolution is correct only for the moment it was computed, and an expiry
  model with a cache would be the same bug wearing a hat.
- Requiring a justification is a real constraint, not decoration: the
  override that outlives its reason is usually the one whose reason nobody
  recorded.
