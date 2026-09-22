# landing-zone-controls

A landing-zone policy suite that fails in two directions: when a guardrail
leaks, and when the supported route through the platform stops working.

Companion lab for Article 9, *Build the Guardrails Before the Workloads*.

No cloud project. No credentials. No network. `make verify` runs everything.

## The idea

A guardrail suite that only checks that bad things are refused will be
maximally green on a platform where nothing can be done at all. Revoke every
role in an organization and every "must be blocked" test still passes.

So this suite evaluates two populations against the same landing zone:

- **guardrail cases** that must be refused — by a named layer, and where a layer
  has more than one way to say no, for a named reason;
- **golden paths** that must succeed — within a budget of permissions and
  manual approvals, with no viable escape route.

It passes only if both hold.

## The result

The same suite, run against three landing zones over the same organization:

| zone | guardrails held | golden path usable | developer permissions | steps blocked | viable escapes |
|---|---|---|---|---|---|
| FLAT — no folders, no constraints, editor for everyone | 0/6 | no | 11 | 0/5 | 0 |
| LOCKED — every guardrail on, no route through | 6/6 | no | 0 | 5/5 | 1 |
| PAVED — the same guardrails plus a paved road | 6/6 | yes | 3 | 0/5 | 0 |

FLAT fails every guardrail and the developer can still ship, which is why
nobody fixes it. LOCKED holds every guardrail and refuses all five steps of the
supported path — and the one place policy was relaxed, a sandbox exception
granted for a workshop that has ended, is still open. The work will go there.

Only PAVED passes. Its guardrails are identical to LOCKED's.

Separately, and not caught by any guardrail case: LOCKED's administrators
retain destructive access to LOCKED's own audit trail.

Full output in [results/report.md](results/report.md).

## The three questions

Every action is evaluated against three independent layers, and a refusal
always names which one refused:

| question | mechanism | file |
|---|---|---|
| **who** may act | IAM grants, credential validity and lifetime | `src/identity.ts` |
| **what** may be configured | organization policy constraints, inherited | `src/policy.ts` |
| **where** data may go | service perimeter | `src/perimeter.ts` |

The layers do not substitute for one another. The configuration layer never
consults identity — test O5 grants `roles/owner` and shows the answer is
unchanged — and the perimeter is evaluated after both.

## Layout

```
src/        the model: hierarchy, identity, policy, perimeter, audit, evaluator, suite
tests/      58 tests, including the eight the article claims and five negative controls
scripts/    report.ts (experiments), render-policies.ts (policy-as-code drift check)
infra/      minimal Terraform foundation -- fmt and validate only, never applied
policies/   the declarative policy set, generated from the model so it cannot drift
docs/       MODEL.md (what is and is not faithful) and four ADRs
results/    generated output
```

## Running it

```
make verify
```

Runs the strict typecheck (if TypeScript is installed), 58 tests, every
experiment, the policy drift check, `terraform fmt -check` and `validate`, and a
secret scan. Nothing applies Terraform and nothing reaches Google Cloud.

Node 22.18 or newer. `npm install` is optional and only enables the typecheck.

## Honesty notes

- Policy bindings here carry an expiry. **Real organization policies do not.**
  That is the model's largest departure and [ADR-002](docs/adr/ADR-002-exceptions-expire.md)
  records what implementing it for real would actually cost.
- The friction budget — four permissions, zero approvals — is this module's
  choice for one workload shape, not a recommendation.
- Nothing here is a compliance claim. [docs/MODEL.md](docs/MODEL.md) lists every
  simplification, including one claim about IAM that is deliberately not made.
