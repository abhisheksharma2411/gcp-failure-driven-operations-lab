# ADR-001: Independence is derived from the graph, never declared

- Status: Accepted
- Date: 2026-09-15
- Article: 05

## Context

The validator needs to know which components survive a failure. The obvious
implementation is a flag: `independent: true`.

## Decision

Remove the flag. A component survives a domain when nothing in its transitive
closure sits in that domain, and it is an *anchor* when nothing in its closure
sits in any domain at all. Both are computed.

## Why this option

The first implementation had the flag, and test `T6` broke it immediately.

The flag made independence an assertion, and asserting it excluded the
component's entire dependency subtree from validation. Mark the bastion
independent and the validator stops looking — which is precisely the failure
this tool exists to detect, reintroduced as a feature.

It is also the same defect Article 4 names in its irreversibility flag, arriving
by a different route. There the mitigation was attribution, because
irreversibility genuinely cannot be computed from the artifact. Here it can, so
the honest thing is to compute it.

The practical consequence is visible in negative control `N2`: two
differently-named tools, `runbook-wiki` and `incident-chat`, both resting on
`corp-dns`. Neither is an anchor, and no naming convention can make them one.

## Consequences

Someone must declare the graph, which is real work and is the tool's actual
cost. What they cannot do is declare the *conclusion*.

The graph is only as good as its edges. A missing dependency produces a false
sense of safety, which is why `UNDECLARED_COMPONENT` is a finding rather than a
silent skip — a step referencing something absent from the graph is reported
rather than assumed fine.

## Conditions that would change the decision

Automatic discovery of dependency edges, from network policy, IAM bindings or
traces, would remove the main source of error. That is a substantially larger
tool and is out of scope.
