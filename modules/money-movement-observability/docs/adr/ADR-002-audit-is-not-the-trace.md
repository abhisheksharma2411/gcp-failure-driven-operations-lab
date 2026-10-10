# ADR-002 — The audit trail is a separate store from the trace

## Status

Accepted.

## Context

Traces already carry almost everything an investigator wants: the operation id,
the provider operation id, the timing, the causal structure across services. The
tempting conclusion is that the trace *is* the record of what happened, and that
an audit store is a duplicate of it.

Two properties of tracing make that wrong, and both are documented rather than
hypothetical.

First, traces are sampled. OpenTelemetry's own guidance on head sampling is
explicit that the decision cannot depend on anything that has not happened yet,
so it is not possible to guarantee that traces containing an error — or, here,
traces that moved money — are the ones kept. Tail sampling can do that, and it
requires a stateful collector that is itself a system that can fail. Either way,
the question "is the record of this payment present?" has a probabilistic answer.

Second, traces are a debugging aid with a retention measured in weeks. The
question an auditor, a regulator or a dispute asks is about a payment from a
year ago.

## Options considered

**A. One store: the trace is the record.** Fewer moving parts, one query
language, one retention policy. It makes evidence availability depend on a
sampling decision, which is the thing it cannot be allowed to depend on.

**B. One store: sample nothing.** Keeps every trace, and the volume model says
what that costs — in this module's illustrative figures, traces unsampled are
the largest single signal. It also keeps the *wrong* shape of data for a long
time: a span is optimised for reconstructing a request, not for answering "what
happened to this money".

**C. Two stores with different rules.** Traces sampled and short-lived for
debugging; audit records unsampled, append-only, and retained for as long as the
business needs, written on the same path as the money.

## Decision

Option C. `src/telemetry/audit.ts` is append-only — there is no update and no
delete — and every record carries the correlation keys that reach the trace, the
logs, the ledger and the settlement evidence.

Cloud Audit Logs makes the same separation for the platform's own actions: its
entries are immutable, and Admin Activity logs are always written and cannot be
configured, excluded or disabled. The application-level equivalent is this file.

## Why this option

The deciding property is what each store is allowed to lose. A trace that was
not sampled costs an investigator some convenience. An audit record that was not
written costs the organisation its answer. Those cannot share a retention
policy, and they cannot share a sampling decision.

Scenario S07 is the test: a payment whose trace the sampler drops, where the
audit timeline still reconstructs intent, provider effect, posting, status and
settlement. The negative control removes the audit trail and that scenario turns
red while nothing else does.

## Consequences

- Two stores to maintain, two retention policies, two access-control decisions.
- The audit volume is not reducible by sampling, and the cost model says so
  explicitly rather than hiding it inside a total.
- Audit records are written on the request path, so they are in the latency
  budget. The module does not model that cost; a real implementation must.
- Correlation keys have to be carried into both, which is why `CorrelationFields`
  exists rather than each store inventing its own shape.

## Conditions that would change this

If an organisation's tracing backend offered unsampled retention at audit
timescales with an immutability guarantee, the stores could merge. No such
guarantee was found for the products this article cites, and a merged store
would still have the wrong shape for the question an auditor asks.
