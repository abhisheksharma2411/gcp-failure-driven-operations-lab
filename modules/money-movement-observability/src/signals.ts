// The metric catalogue.
//
// Every label here has a closed set of values, written down. Two consequences
// follow, and both are deliberate. The registry can refuse a write that would
// create an undeclared series, and the maximum number of series the whole
// system can emit is a number this file can compute rather than a surprise on
// a bill.
//
// What is conspicuously absent: operation ID, provider operation ID, journal
// ID, settlement ID, customer identifiers, amounts. Those are investigation
// keys. They belong on spans, in structured logs, and in audit records.

import type { MetricDefinition } from "./telemetry/metrics.ts";
import { declaredCardinality } from "./telemetry/metrics.ts";

const SERVICES = ["checkout-api", "provider-gateway", "ledger-poster", "settlement-importer"] as const;
const CURRENCIES = ["EUR", "USD"] as const;

export const INVARIANT_IDS = [
  "INV-1",
  "INV-2",
  "INV-3",
  "INV-4",
  "INV-5",
  "INV-6",
  "INV-7",
  "INV-8",
] as const;

export const METRICS: readonly MetricDefinition[] = [
  {
    name: "money.http.responses",
    kind: "counter",
    description: "HTTP responses by class. The signal that stays green in scenario S04.",
    unit: "1",
    labels: { service: SERVICES, class: ["2xx", "4xx", "5xx"] },
  },
  {
    name: "money.http.latency",
    kind: "distribution",
    description: "Server-side request latency in milliseconds.",
    unit: "ms",
    labels: { service: SERVICES, route: ["POST /payments", "POST /capture", "POST /postings", "POST /settlements"] },
  },
  {
    name: "money.provider.attempts",
    kind: "counter",
    description: "Calls made to the external provider, by what the provider said.",
    unit: "1",
    labels: { outcome: ["captured", "declined", "unknown"] },
  },
  {
    name: "money.events.delivered",
    kind: "counter",
    description: "Event deliveries into the ledger poster, by what the consumer did with them.",
    unit: "1",
    labels: { outcome: ["processed", "duplicate-suppressed", "dead-lettered"] },
  },
  {
    name: "money.effects.applied",
    kind: "counter",
    description: "Externally visible money-moving effects actually applied.",
    unit: "1",
    labels: { currency: CURRENCIES },
  },
  {
    name: "money.state.oldest_age_seconds",
    kind: "gauge",
    description: "Age of the oldest operation in each non-terminal state.",
    unit: "s",
    labels: { state: ["INTENT", "PROVIDER_PENDING", "OUTCOME_UNKNOWN", "CAPTURED", "POSTED"] },
  },
  {
    name: "money.state.count",
    kind: "gauge",
    description: "Operations in each non-terminal state. Healthy on its own in S03.",
    unit: "1",
    labels: { state: ["INTENT", "PROVIDER_PENDING", "OUTCOME_UNKNOWN", "CAPTURED", "POSTED"] },
  },
  {
    name: "money.ledger.imbalance_minor",
    kind: "gauge",
    description: "Absolute difference between debits and credits, in minor units.",
    unit: "1",
    labels: { currency: CURRENCIES },
  },
  {
    name: "money.invariant.violations",
    kind: "gauge",
    description: "Open violations per business invariant. The red light in a green dashboard.",
    unit: "1",
    labels: { invariant: INVARIANT_IDS },
  },
  {
    name: "money.reconciliation.open",
    kind: "gauge",
    description: "Open reconciliation exceptions by kind.",
    unit: "1",
    labels: { kind: ["unmatched-effect", "unmatched-settlement", "amount-mismatch"] },
  },
  {
    name: "money.reconciliation.oldest_age_seconds",
    kind: "gauge",
    description: "Age of the oldest open exception by kind. Moves when the count does not.",
    unit: "s",
    labels: { kind: ["unmatched-effect", "unmatched-settlement", "amount-mismatch"] },
  },
  {
    name: "money.settlement.lateness_seconds",
    kind: "gauge",
    description: "How long the oldest captured effect has waited for settlement evidence.",
    unit: "s",
    labels: { currency: CURRENCIES },
  },
  {
    name: "money.canary.outcome",
    kind: "counter",
    description: "Synthetic canary runs, by result.",
    unit: "1",
    labels: { result: ["pass", "fail"] },
  },
  {
    name: "money.checker.staleness_seconds",
    kind: "gauge",
    description: "Time since each periodic checker last completed. Absence of signal is not health.",
    unit: "s",
    labels: { checker: ["invariants", "canary", "reconciliation"] },
  },
];

/** The ceiling on series this whole catalogue can produce. */
export function catalogueCardinality(): { metric: string; series: number }[] {
  return METRICS.map((m) => ({ metric: m.name, series: declaredCardinality(m) }));
}

export function totalDeclaredSeries(): number {
  return catalogueCardinality().reduce((acc, m) => acc + m.series, 0);
}

/**
 * Identifiers that must never appear as a metric label value.
 *
 * Cloud Monitoring's own guidance names this list; the guard in
 * telemetry/metrics.ts enforces it structurally by refusing any value that is
 * not in a declared set, which is the stronger form of the same rule.
 */
export const INVESTIGATION_KEYS: readonly string[] = [
  "operationId",
  "providerOpId",
  "journalId",
  "settlementId",
  "businessRef",
  "customerId",
  "traceId",
];
