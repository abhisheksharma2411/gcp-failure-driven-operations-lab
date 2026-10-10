# What this model is not

This module is a local, deterministic model of a money-movement observability
stack. It creates no cloud resources, calls no Google Cloud API, holds no
credentials and reaches no network. Everything below is a way the model departs
from the real platforms it is named after. The list is meant to be unflattering;
where the model makes the design look better than it would be in production,
that is said here rather than left for a reader to discover.

## Tracing

1. **This is not the OpenTelemetry SDK.** `src/telemetry/trace.ts` implements a
   span, a context, a `traceparent` carrier and a head sampler. It does not
   implement baggage, span events, links, resource detection, exporters,
   batching, retry on export failure, or the OTLP wire format.
2. **Sampling is head sampling only.** Tail sampling — the thing that would let
   you keep every trace that contains an error — is described in the article and
   not implemented. A real deployment that wants "always sample a trace that
   moved money" needs a stateful collector, and that collector is a system with
   its own failure modes that this module does not model.
3. **The sampler is deterministic, not probabilistic.** `headSample` hashes the
   trace ID. Real consistent probability sampling has the same property, but the
   hash here is a toy and its distribution has not been tested.
4. **Span timings are fixed offsets, not measurements.** A checkout span lasts
   42 ms because the model says so. No latency figure in this module is a
   measurement of anything.
5. **Context propagation never fails.** In the model, a `traceparent` that
   cannot be parsed throws. In production the common failure is quieter: a
   proxy, a queue, or a library that drops the header, and the trace silently
   splits into two. The module cannot show you that, and it is the most common
   way trace correlation is lost in practice.

## Logs

6. **Redaction is a write-time transform in one process.** Real redaction has to
   hold across every library that logs, every framework that logs a request
   body, and every crash handler that dumps a stack with arguments in it. The
   module's guarantee covers only the code that calls `StructuredLog.write`.
7. **The denied-field list is hand-written and short.** It has no detector, no
   confidence score and no concept of a custom infoType. Sensitive Data
   Protection is cited in the article as what you would actually use; it is not
   used here.
8. **The pseudonym is a 32-bit FNV hash.** It is a marker that keeps two
   occurrences of one value joinable. It is not a cryptographic token, it is
   trivially reversible for a small input space, and nothing in a real system
   should use it as the basis for anything.
9. **There is no log routing, no sink, no bucket, no retention.** The article
   discusses `_Required` and `_Default` buckets and their retention periods;
   the module keeps an array in memory.

## Metrics

10. **The cardinality guard is stricter than any real system.** It requires
    every label value to be enumerated in advance. Cloud Monitoring will happily
    accept a high-cardinality label and present you with the consequences later.
    The guard makes the article's point structurally, and a real service with
    dynamic-but-bounded labels, such as a country code, would need a looser
    form of it.
11. **There is no aggregation, no alignment period, no delay.** Real metric
    pipelines have ingestion latency and alignment windows, which means a
    freshly violated invariant is not instantly visible. The module publishes
    and reads in the same tick, which makes detection look instantaneous. It is
    not.
12. **Percentiles are nearest-rank over every observation.** Real backends use
    bucketed histograms, so a p95 read from a distribution metric is an
    approximation whose error depends on the bucket boundaries.

## The money-movement flow

13. **Four functions, one process, no concurrency.** There are no threads, no
    network calls and no transactions. Two copies of an operation arriving at
    once is not something this module can exercise, and claim-and-check atomicity
    is assumed rather than demonstrated.
14. **The ledger is a list.** Three accounts, one currency per operation, no
    reversals, no partial refunds, no multi-currency journal, no period close.
    Article 14 owns ledger design; this module needs only enough of one for an
    imbalance to be a meaningful thing to detect.
15. **Settlement is one record with one amount.** No files, no batches, no fee
    schedules that disagree, no corrections arriving after the fact. Article 19
    owns that; INV-7 here asks only whether evidence arrived at all.
16. **Reconciliation exceptions are created by the scenario, not derived.** The
    module does not implement a matcher. Article 7 owns turning duplicate and
    late events into a financial position; this module owns noticing that the
    position is wrong.
17. **Faults are injected by flags on a single code path.** That is better than
    a separate harness, and it is still not production: a real fault arrives
    from a dependency, a deploy, or a data shape nobody anticipated.

## Invariants, SLOs and alerts

18. **The invariant checker runs over the whole world, in memory, instantly.**
    A real checker runs over a warehouse table or a change stream, costs money
    per run, takes minutes, and sees a snapshot that is already stale. The
    article's detect-and-repair objective is stated in minutes partly because
    the real detection path has a floor this model does not have.
19. **The checker shares a process with the thing it checks.** The design claim
    is that an invariant must be evaluated by code that shares nothing with the
    code that wrote the state. The module satisfies the weaker version —
    different module, different inputs, no shared helpers — and not the strong
    version, which is a separate deployment reading a separate copy.
20. **Alert evaluation has no window, no duration and no flapping.** A real
    policy fires when a condition holds for some period. Everything here is
    instantaneous, so the module cannot show alert flapping, and alert fatigue
    is discussed in the article without being demonstrated.
21. **There is no notification channel, no escalation, no on-call schedule.**
    `route` is a string.
22. **The eight invariants are the ones this flow can violate.** A real payment
    platform has more, including ones about tax, FX, limits, holds and
    chargebacks. The catalogue is a starting shape, not a complete list.

## The canary

23. **The canary runs in its own pipeline instance.** That is the largest
    simplification in the module: a probe that does not share the production
    path proves nothing about the production path. A real canary runs against
    the real services with a reserved business reference and is excluded from
    customer-facing SLIs by that reference.
24. **The canary's money is not real and nothing settles.** A production
    money-movement canary has to either use a provider sandbox, a tiny real
    amount that is later reversed, or a dedicated test merchant — and each of
    those choices has consequences the module does not model.

## Cost

25. **Every figure in `src/cost.ts` is an assumption, not a measurement.**
    Bytes per span, bytes per log entry and points per series per day are round
    numbers chosen to be legible. The ratios between the signals are the claim;
    the absolute numbers are inputs to replace.
26. **No price appears anywhere, deliberately.** Pricing changes, and a figure
    pasted from a documentation page into an article is wrong by the time
    somebody acts on it.

## Determinism

27. **There is no `Date.now()` in `src/`.** Every function that needs the time
    takes it as a parameter, and identifiers come from a seeded counter. This
    is what makes `make report` byte-identical on re-run, and it is also why
    nothing in this module can be used to reason about real clock skew, which
    is a genuine source of false invariant violations in a distributed ledger.
