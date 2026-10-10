# ADR-003 — The cardinality guard rejects at the write, not at review

## Status

Accepted.

## Context

Cloud Monitoring's metric model is specific about what must never become a
metric label value: do not use high-resolution values like timestamps, any kind
of unique identifier, user IDs, IP addresses or unparameterized URLs. The
guidance is clear, and it is guidance — nothing enforces it at the point a
service writes a point.

The failure mode is slow and expensive. A label that takes a bounded set of
values in a test environment takes an unbounded set in production; the series
count multiplies, queries get slower, and the metric eventually becomes
unreadable. By then the write is in several services.

The pressure to add one is highest during an incident, which is when review is
weakest. "This dashboard would be so much more useful broken down by operation"
is a reasonable sentence that produces an unreadable metric.

## Options considered

**A. Documentation and code review.** Zero machinery. Depends on every reviewer
knowing the rule and noticing the violation, at the moment when the person
writing it has a good reason and is in a hurry.

**B. A denylist of forbidden label names.** Catches `operationId`; does not
catch `key`, `ref`, or `id2`. A denylist of names cannot see values, and the
problem is values.

**C. An allowlist of values, declared per metric.** Every metric states the
complete set of values each label may take, and a write carrying anything else
throws. The ceiling on series becomes a number the catalogue can compute.

## Decision

Option C. `MetricDefinition.labels` maps each label name to its complete set of
permitted values; `MetricRegistry` refuses a write whose label set or label
values do not match, and `declaredCardinality` computes the ceiling.

For the catalogue in this module the ceiling is 69 series, which is small enough
to print in the report and check by eye.

## Why this option

It converts a review question into a failure. The write that would have created
an unbounded label does not reach the backend, it throws in the service's own
tests, and the person writing it finds out at the moment they write it rather
than on a bill.

It also produces the number the cost model needs. A metric line that is flat in
traffic — the same 69 series whether the system handles a thousand payments a
day or a million — is only flat because every label is bounded, and the
guard is what makes that true rather than hoped for.

The refusal is a signal in its own right: `ALERT-CARDINALITY-REJECTED` routes
to the observability owners with a runbook that says where the identifier should
have gone instead. A guard that silently drops the write would have taught
nobody anything.

## Consequences

- Adding a legitimate new label value is a code change. For a label like
  currency or service name that is correct. For a genuinely dynamic but bounded
  label — a country code, a payment method added by a partner — it is friction,
  and `docs/MODEL.md` records that a real system needs a looser form.
- The guard throws rather than dropping. A write that cannot be satisfied is a
  defect in the caller, and a service that crashes in its own test suite is
  cheaper than a metric nobody can query. A production implementation should
  consider failing closed on the metric rather than on the request path.
- A test asserts that no declared label name is one of the investigation keys,
  so the rule is enforced against the catalogue as well as against writes.

## Conditions that would change this

If the monitoring backend enforced a per-metric series budget and rejected
writes beyond it with a clear error, this guard would be redundant. Today the
consequence of exceeding it arrives later and somewhere else.
