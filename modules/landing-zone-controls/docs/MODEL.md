# What this module models, and where it departs from Google Cloud

This module is a local, deterministic representation of five Google Cloud
mechanisms. It is not a Google Cloud client. It opens no connection, holds no
credential, and needs no project. Everything in `results/` is computed from the
code in `src/`.

That buys determinism and costs fidelity. This page is the record of what was
kept and what was not, so that nothing here is mistaken for a description of
how the platform behaves.

## Mechanisms represented

| Mechanism | Modelled as | Faithful in | Simplified in |
|---|---|---|---|
| Resource hierarchy | `src/hierarchy.ts` | one organization as root, folders optional, projects as leaves; roles granted high are inherited by descendants | no resource types below the project; no cross-organization moves |
| Organization policy | `src/policy.ts` | constraints inherit to all descendants; a descendant binding overwrites the inheritance; policy is evaluated without reference to identity | five constraints, not the real catalogue; boolean and list only; no `inheritFromParent`, no conditions, no tag-based targeting |
| VPC Service Controls | `src/perimeter.ts` | independent of IAM; free communication inside, cross-boundary blocked by default; only restricted services protected; dry-run observes without preventing | no access levels, no ingress/egress rule grammar, no bridges, no directional attribute matching |
| Workload Identity Federation | `src/identity.ts` | an external assertion is mapped to a Google subject; the exchange yields a short-lived credential; no key is stored anywhere | no provider or pool objects, no issuer validation, no signature checking, no attribute conditions |
| Service account impersonation | `src/identity.ts` | requires `iam.serviceAccounts.getAccessToken`; yields a short-lived, non-refreshing credential; scope differs between a node-level and an account-level grant | no delegation chains, no ID tokens or signed blobs, no domain-wide delegation |

## Departures, stated plainly

**Policy bindings expire. Real organization policies do not.** This is the
single largest departure and it is deliberate; ADR-002 records the reasoning and
what implementing it for real would cost. Nothing in Google Cloud removes a
lapsed override on its own.

**Roles are permission bundles, hand-written and small.** `ROLE_PERMISSIONS` in
`src/identity.ts` lists a handful of permissions per role. Real predefined roles
carry hundreds. The bundles were checked against the real roles where it
mattered — `roles/editor` was corrected during development to include
`logging.logEntries.list`, because a flat estate does not in fact block a
developer from reading logs, and the first version of the model wrongly said it
did.

**Destructive permissions are approximated.** `src/audit.ts` treats a small set
of permissions as sufficient to remove or rewrite stored records. The argument
does not turn on the exact names and the file says so where the set is defined.

**IAM Deny policies are absent, and no claim is made about them.** The familiar
shorthand that IAM is purely additive — that a descendant cannot take away what
an ancestor granted — is no longer straightforwardly true, and the relevant
documentation was not read for this article. The model implements additive
inheritance and the article claims only that: grants inherit downward. It says
nothing about revocation at a descendant.

**No data classification.** The perimeter protects "something sensitive",
unspecified. Anything about what makes data sensitive, how it is tokenized, or
how a boundary relates to a compliance regime is out of scope by design.

**Time is a parameter, never a clock.** Every resolution takes `nowMs`. There is
no `Date.now()` anywhere in `src/`, which is why the report can evaluate the
same zone at day 0 and day 31 and why re-running produces identical bytes.

## What the Terraform is for

`infra/main.tf` is a minimal foundation: three folders and four organization
policies. `make verify` runs `terraform fmt -check` and, when the provider
registry is reachable, `terraform validate`. It never runs `apply`.

Applying it would create real folders and real organization policies against a
real organization. `organization_id` therefore has no default, and a test
enforces that it does not acquire one.

## Reproducing

```
make verify     # typecheck, 58 tests, experiments, policy drift, terraform fmt/validate, secret scan
make report     # regenerate results/
```

Node 22.18 or newer. No npm install is needed to run the tests; installing
TypeScript only enables the strict typecheck.
