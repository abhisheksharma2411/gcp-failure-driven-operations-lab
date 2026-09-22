# ADR-004: Audit independence is derived from grants, never declared

**Status:** accepted
**Date:** 2026-09-22

## Context

`AuditSink` could have carried a `protected: boolean`. Constructing the
fixtures would have been shorter and every test would have passed.

It would also have been the exact failure the module exists to catch. A flag
that claims a property is a claim, and claims do not survive a reorganisation,
a migration, or a new administrator being granted a role at the organization
because it was quicker than working out which folder they needed.

The recovery-plane module reached the same conclusion about recovery
independence and recorded it in its own ADR-001. The reasoning transfers
directly: a self-asserted independence flag silently excludes whatever it is
attached to from the analysis meant to check it.

## Decision

`auditWeaknesses` computes, from the live grant set, which principals hold
destructive permissions over the audited node and which hold them over the
sink's destination. The intersection is the finding. Nothing in the model can
declare a sink safe.

## Consequences

- Adding one `roles/editor` grant at the organization reintroduces the weakness
  with no flag changed anywhere (test A5).
- The LOCKED zone is shown to hold every guardrail in the suite while its
  administrators retain destructive access to its own audit trail. That result
  is the module's sharpest finding and it exists only because the property is
  derived.
- The destructive-permission set is deliberately coarse. The article's argument
  does not depend on exact permission names, and claiming precision the source
  matrix does not support would be worse than the approximation. `src/audit.ts`
  says so at the point of definition.
