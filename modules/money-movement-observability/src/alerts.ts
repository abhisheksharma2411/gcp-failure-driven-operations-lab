// Alert rules, each bound to one signal, one severity, one route and one
// runbook.
//
// Two structural rules are enforced by tests rather than by review:
//
//   1. Every alert must be fired by at least one scenario in the fault
//      catalogue. An alert nobody has ever seen fire is a belief, not a
//      control, and this module has no way to tell a working rule from a
//      typo in a filter.
//   2. Every scenario that moves money wrongly must fire at least one alert.
//      A scenario that passes silently is a blind spot with a test around it.

import type { MetricRegistry } from "./telemetry/metrics.ts";
import type { Budgets, World } from "./domain/types.ts";
import type { Violation } from "./invariants.ts";
import type { SloResult } from "./slo.ts";
import type { Severity } from "./invariants.ts";

export type AlertBasis = "technical" | "invariant" | "meta";

export interface AlertDefinition {
  readonly id: string;
  readonly title: string;
  readonly basis: AlertBasis;
  readonly severity: Severity;
  /** Where the notification goes. */
  readonly route: "payments-oncall" | "payments-finops" | "observability-oncall";
  /** The condition, written the way it would appear in a monitoring policy. */
  readonly condition: string;
  readonly runbook: string;
  /** The question the responder is being asked to answer. */
  readonly asks: string;
}

export interface Snapshot {
  readonly nowMs: number;
  readonly metrics: MetricRegistry;
  readonly world: World;
  readonly budgets: Budgets;
  readonly violations: readonly Violation[];
  readonly technical: readonly SloResult[];
  /** Synthetic canary result for the most recent run, if any. */
  readonly canaryPassed: boolean | null;
  /** Label writes the cardinality guard refused since the last evaluation. */
  readonly cardinalityRejections: number;
}

export const ALERTS: readonly AlertDefinition[] = [
  {
    id: "ALERT-API-AVAILABILITY",
    title: "checkout availability below objective",
    basis: "technical",
    severity: "page",
    route: "payments-oncall",
    condition: "SLO-C1 is below 99.9% over the alerting window",
    runbook: "RB-API-AVAILABILITY",
    asks: "Are customers being refused?",
  },
  {
    id: "ALERT-API-LATENCY",
    title: "checkout latency above objective",
    basis: "technical",
    severity: "ticket",
    route: "payments-oncall",
    condition: "p95 of money.http.latency{service=checkout-api} exceeds 400 ms",
    runbook: "RB-API-LATENCY",
    asks: "Are customers waiting?",
  },
  {
    id: "ALERT-PROVIDER-UNKNOWN",
    title: "provider outcome unknown beyond budget",
    basis: "technical",
    severity: "page",
    route: "payments-oncall",
    condition: "money.state.oldest_age_seconds{state=OUTCOME_UNKNOWN} exceeds the unknown-outcome budget",
    runbook: "RB-UNKNOWN-OUTCOME",
    asks: "Did money move for an operation we have given up on?",
  },
  {
    id: "ALERT-LEDGER-IMBALANCE",
    title: "journal does not balance",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-1} is above zero",
    runbook: "RB-LEDGER-IMBALANCE",
    asks: "Which journal, which operation, how much, and since when?",
  },
  {
    id: "ALERT-POSTING-MISMATCH",
    title: "posting does not match the provider effect",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-2} is above zero",
    runbook: "RB-POSTING-MISMATCH",
    asks: "Does what we recorded match what the provider did?",
  },
  {
    id: "ALERT-ORPHAN-POSTING",
    title: "posting references an effect nobody recorded",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-3} is above zero",
    runbook: "RB-ORPHAN-POSTING",
    asks: "Did we book money that no provider effect accounts for?",
  },
  {
    id: "ALERT-DUPLICATE-EFFECT",
    title: "one operation produced more than one effect",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-4} is above zero",
    runbook: "RB-DUPLICATE-EFFECT",
    asks: "Has a customer been charged twice?",
  },
  {
    id: "ALERT-STATUS-DIVERGENCE",
    title: "customer status contradicts durable state",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-5} is above zero",
    runbook: "RB-STATUS-DIVERGENCE",
    asks: "Have we told somebody something untrue?",
  },
  {
    id: "ALERT-STUCK-OPERATION",
    title: "operation stuck in a non-terminal state",
    basis: "invariant",
    severity: "page",
    route: "payments-oncall",
    condition: "money.invariant.violations{invariant=INV-6} is above zero",
    runbook: "RB-STUCK-OPERATION",
    asks: "Which operation stopped moving, and at which step?",
  },
  {
    id: "ALERT-SETTLEMENT-LATE",
    title: "capture without settlement evidence",
    basis: "invariant",
    severity: "ticket",
    route: "payments-finops",
    condition: "money.invariant.violations{invariant=INV-7} is above zero",
    runbook: "RB-SETTLEMENT-LATE",
    asks: "Is the bank short of money we believe we have?",
  },
  {
    id: "ALERT-RECON-BACKLOG",
    title: "reconciliation exceptions outside budget",
    basis: "invariant",
    severity: "ticket",
    route: "payments-finops",
    condition: "money.invariant.violations{invariant=INV-8} is above zero",
    runbook: "RB-RECONCILIATION-BACKLOG",
    asks: "Is the exception queue draining or accumulating?",
  },
  {
    id: "ALERT-CHECKER-STALE",
    title: "an invariant checker has stopped reporting",
    basis: "meta",
    severity: "page",
    route: "observability-oncall",
    condition: "money.checker.staleness_seconds exceeds the staleness budget for any checker",
    runbook: "RB-CHECKER-STALE",
    asks: "Is the dashboard green because the system is healthy or because nothing is looking?",
  },
  {
    id: "ALERT-CANARY-FAILED",
    title: "synthetic money-movement canary failed",
    basis: "meta",
    severity: "page",
    route: "payments-oncall",
    condition: "money.canary.outcome{result=fail} increased in the last window",
    runbook: "RB-CANARY-FAILED",
    asks: "Does a known-good payment still produce the known-good effect?",
  },
  {
    id: "ALERT-CARDINALITY-REJECTED",
    title: "metric writes refused by the cardinality guard",
    basis: "meta",
    severity: "ticket",
    route: "observability-oncall",
    condition: "the registry refused one or more label writes in the last window",
    runbook: "RB-CARDINALITY",
    asks: "Which service tried to put an identifier on a metric label?",
  },
];

export function alertById(id: string): AlertDefinition {
  const found = ALERTS.find((a) => a.id === id);
  if (!found) throw new Error(`unknown alert ${id}`);
  return found;
}

function hasViolation(snapshot: Snapshot, ...ids: string[]): boolean {
  return snapshot.violations.some((v) => ids.includes(v.invariant));
}

function technicalFailing(snapshot: Snapshot, id: string): boolean {
  const r = snapshot.technical.find((t) => t.id === id);
  return r !== undefined && !r.met;
}

/**
 * Evaluate every rule against one snapshot.
 *
 * The evaluation is deliberately boring: no thresholds learned from history,
 * no anomaly detection, no dependency hierarchy deciding which alert to
 * suppress. Each rule reads one published signal and answers yes or no.
 */
export function evaluateAlerts(snapshot: Snapshot): string[] {
  const fired: string[] = [];
  const fire = (id: string) => {
    if (!fired.includes(id)) fired.push(id);
  };

  if (technicalFailing(snapshot, "SLO-C1")) fire("ALERT-API-AVAILABILITY");
  if (technicalFailing(snapshot, "SLO-C2")) fire("ALERT-API-LATENCY");
  if (technicalFailing(snapshot, "SLO-P1")) fire("ALERT-PROVIDER-UNKNOWN");

  if (hasViolation(snapshot, "INV-1")) fire("ALERT-LEDGER-IMBALANCE");
  if (hasViolation(snapshot, "INV-2")) fire("ALERT-POSTING-MISMATCH");
  if (hasViolation(snapshot, "INV-3")) fire("ALERT-ORPHAN-POSTING");
  if (hasViolation(snapshot, "INV-4")) fire("ALERT-DUPLICATE-EFFECT");
  if (hasViolation(snapshot, "INV-5")) fire("ALERT-STATUS-DIVERGENCE");
  if (hasViolation(snapshot, "INV-6")) fire("ALERT-STUCK-OPERATION");
  if (hasViolation(snapshot, "INV-7")) fire("ALERT-SETTLEMENT-LATE");
  if (hasViolation(snapshot, "INV-8")) fire("ALERT-RECON-BACKLOG");

  for (const checker of ["invariants", "canary", "reconciliation"]) {
    const last = snapshot.world.checkerLastRunMs.get(checker);
    const staleness = last === undefined ? Infinity : snapshot.nowMs - last;
    if (staleness > snapshot.budgets.checkerStalenessMs) fire("ALERT-CHECKER-STALE");
  }

  if (snapshot.canaryPassed === false) fire("ALERT-CANARY-FAILED");
  if (snapshot.cardinalityRejections > 0) fire("ALERT-CARDINALITY-REJECTED");

  return fired;
}

/** Alerts that page, in the order a responder would see them. */
export function paging(fired: readonly string[]): string[] {
  return fired.filter((id) => alertById(id).severity === "page");
}
