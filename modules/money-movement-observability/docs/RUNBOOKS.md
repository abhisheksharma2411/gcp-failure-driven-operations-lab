# Runbooks

One per alert. Each is four sections, in the order a responder uses them:
**what fired**, **how to see it**, **what to do**, **how to know it worked**.

A runbook whose verification step is "check the dashboard again" is not
finished. Every verification step below re-evaluates the invariant that fired.

The repair commands are the ones this module actually implements. Where a
repair is not automated, the runbook says so rather than inventing one.

---

## RB-LEDGER-IMBALANCE — the journal does not balance

**What fired.** `money.invariant.violations{invariant=INV-1}` went above zero.
Debits and credits of a live posting group disagree. Nothing in the request
path failed; expect every technical objective to be green.

**How to see it.**

```text
money.ledger.imbalance_minor         the size of the gap, by currency
audit action=ledger.posted           which journals were written, and when
jsonPayload.correlation.journalId    the posting group's own log lines
```

The violation record carries the operation, the journal and the amount. Start
from the audit timeline for that operation: it reconstructs intent, provider
effect, posting and status publication without depending on the trace, which
may have been dropped by the sampler.

**What to do.**

```bash
node scripts/incident.ts                                   # reproduce the shape
node scripts/incident.ts --repair ledger-imbalance --journal <id>
```

The repair supersedes the wrong group and writes a corrected one. It does not
edit anything: the original stays, carrying the id of the group that replaced
it. Running it twice is safe and is the second invocation in the test.

Before repairing, decide whether the gap is one journal or a class. One journal
is an incident. A class is a defect, and the repair has to wait until the defect
is fixed or it will be re-created behind you.

**How to know it worked.** Re-run the checker. `INV-1` returns to zero, and the
audit trail carries a `repair.applied` record naming the runbook as the actor —
so the correction is evidence too.

---

## RB-POSTING-MISMATCH — the posting does not match the provider effect

**What fired.** `INV-2`. The amount credited to the customer differs from what
the provider captured. The journal may still balance, which is what makes this
one nastier than an imbalance: double entry is satisfied and the number is
wrong.

**How to see it.** Compare the posting group against the provider effect for
the same `providerOpId`. The audit trail holds both.

**What to do.** There is no automated repair. A mismatch means the posting
logic and the provider disagree about an amount, and which one is right is a
business question: a partial capture, a fee change, a rounding rule. Open a
reconciliation exception, stop the posting path for the affected class if the
rate is non-trivial, and decide the correct amount before writing anything.

**How to know it worked.** `INV-2` returns to zero and the exception closes.

---

## RB-ORPHAN-POSTING — a posting references an effect nobody recorded

**What fired.** `INV-3`. A posting group names a provider effect that does not
exist in durable state. The usual cause is a replay: an event re-delivered from
a backup, a recovery drill, or a consumer reading from an offset it should not
have.

**How to see it.** The violation names the journal and the unknown
`providerOpId`. Search the audit trail for that id; if nothing comes back, the
effect was never recorded here.

**What to do.** Do not delete the posting. Establish first whether the effect
happened and was lost, or never happened. Those have opposite repairs, and the
provider is the authority for which.

**How to know it worked.** `INV-3` returns to zero.

---

## RB-DUPLICATE-EFFECT — one operation produced more than one effect

**What fired.** `INV-4`. Two provider effects carry the same `operationId`. The
usual cause is a retry that minted a fresh idempotency key, which makes the
second attempt a different operation as far as the provider can tell.

**How to see it.** `money.effects.applied` against the count of operations. The
violation names the operation; the audit trail holds both effects.

**What to do.** Treat it as a customer-money incident immediately: somebody has
probably been charged twice. Reverse the second effect through the provider,
post the reversal, and tell the customer before they tell you. Then find the
retry path that regenerated the key.

**How to know it worked.** `INV-4` returns to zero and the reversal appears in
the audit trail.

---

## RB-STATUS-DIVERGENCE — the customer has been told something untrue

**What fired.** `INV-5`. An operation reports SUCCEEDED with no provider effect,
or FAILED while one exists. The status endpoint's own availability and latency
are irrelevant here and will be green.

**How to see it.** The violation names the operation and the direction. The
audit `status.published` record says what was said and when.

**What to do.** Correct the customer-facing status from durable state, not from
memory. If the operation is in `OUTCOME_UNKNOWN`, resolve it with the provider
first: the status cannot be corrected until the outcome is known.

**How to know it worked.** `INV-5` returns to zero.

---

## RB-STUCK-OPERATION — an operation stopped moving

**What fired.** `INV-6`. An operation has been in a non-terminal state longer
than that state's budget. Note the budget is per state: `OUTCOME_UNKNOWN` gets
ten minutes, `POSTED` gets fifty hours because it is legitimately waiting for
settlement.

**How to see it.** `money.state.oldest_age_seconds` beside
`money.state.count`. The count will usually look fine. That is the point of the
alert: a small backlog with a growing age is a few items that cannot be
processed, not a capacity problem.

**What to do.** Find the step it stopped at from the audit trail — the last
action recorded is the one that completed. Then decide whether to re-drive the
next step or to resolve an unknown outcome with the provider.

**How to know it worked.** The operation reaches a terminal state and `INV-6`
returns to zero.

---

## RB-UNKNOWN-OUTCOME — the provider stopped telling us

**What fired.** `SLO-P1` breached, or `money.state.oldest_age_seconds{state=
OUTCOME_UNKNOWN}` above budget.

**How to see it.** The operation is open with a provider operation id recorded
and no outcome. The effect may or may not exist.

**What to do.** Ask the provider about the key. Do not retry blind and do not
guess: an unknown outcome is a state to resolve, not an error to repeat. If the
key was regenerated between attempts there is nothing to ask about, which is the
failure mode Article 12 is about.

**How to know it worked.** The operation leaves `OUTCOME_UNKNOWN` and the
customer-facing status is corrected to match.

---

## RB-SETTLEMENT-LATE — a capture has no settlement evidence

**What fired.** `INV-7`. A capture older than the settlement budget has no
matching settlement record. This opens a ticket, not a page: it is a 48-hour
problem and waking somebody at 3 a.m. will not make the bank file arrive.

**How to see it.** `money.settlement.lateness_seconds` by currency, and the
violation record for the affected capture.

**What to do.** Establish whether the file is late, the import is broken, or the
provider has not settled. Those are three different owners. Open an exception so
the age is tracked rather than the case being remembered.

**How to know it worked.** The settlement record exists and `INV-7` returns to
zero.

---

## RB-RECONCILIATION-BACKLOG — the exception queue stopped draining

**What fired.** `INV-8`, on count or on age. Age usually moves first.

**How to see it.** `money.reconciliation.open` and
`money.reconciliation.oldest_age_seconds`, by kind. Read them together: a flat
count with a rising age means a few cases nobody can resolve, not a volume
problem.

**What to do.** Triage by kind, not by age alone. A growing
`unmatched-settlement` queue and a growing `amount-mismatch` queue have
different causes.

**How to know it worked.** Both the count and the oldest age return inside
budget.

---

## RB-API-AVAILABILITY — checkout is refusing requests

**What fired.** `SLO-C1`. This is the honest failure: the request was refused,
nothing happened, and the customer was told so.

**What to do.** Ordinary service triage. The reason this runbook is short is
that it is the case every team already has a runbook for, and the article is
about the cases they do not.

**How to know it worked.** The objective recovers, and — separately — check
that nothing moved money during the window.

---

## RB-API-LATENCY — checkout is slow

**What fired.** `SLO-C2`, p95 above the threshold.

**What to do.** Ordinary triage. Check the invariant dashboard as well: a slow
system with a growing `OUTCOME_UNKNOWN` age is a different incident wearing a
latency costume.

**How to know it worked.** p95 returns inside the threshold.

---

## RB-CHECKER-STALE — something stopped looking

**What fired.** `money.checker.staleness_seconds` above budget for any checker.
This pages, and it should, because every tile on the invariant dashboard is now
unreliable and must be read as unknown rather than as healthy.

**How to see it.** The staleness gauge names which checker. A checker that
publishes zeros when healthy is distinguishable from one that has stopped; one
that only publishes on violation is not, which is why the gauges are written
even when nothing is wrong.

**What to do.** Restore the checker first. Do not reason about the invariant
dashboard until it is running, and do not close invariant alerts that fired
before it stopped.

**How to know it worked.** Staleness returns to roughly the run interval, and
the checker publishes a fresh value for every invariant.

---

## RB-CANARY-FAILED — a known-good payment no longer produces the known-good effect

**What fired.** The synthetic canary's assertions did not hold. The canary
asserts the effect, not the response, so a failure here is a correctness signal
that arrived before a customer complained.

**How to see it.** The canary result lists each check with its expected and
actual value, so the failure names the property that broke.

**What to do.** Treat it as the invariant it corresponds to. A canary failing
the "posting legs" check is `RB-LEDGER-IMBALANCE` before any customer money is
involved.

**How to know it worked.** The next canary run passes every check.

---

## RB-CARDINALITY — a metric write was refused

**What fired.** The registry refused one or more label writes. Something tried
to put an unbounded value on a metric label.

**What to do.** Find the write. The identifier belongs on the span, in the log
line, or in the audit record — all three are joinable to the metric by time and
by service, and none of them multiplies the number of time series.

**How to know it worked.** No further refusals, and the investigation the
engineer wanted is possible from logs instead.
