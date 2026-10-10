// The SLO catalogue, in five tiers.
//
// The tiers exist because a payment keeps being true or false at five
// different moments, and a single availability number collapses all of them.
// A customer can be served a fast, successful response by a system that has
// not yet moved any money; a provider can move money for an operation whose
// ledger entry is wrong; a ledger can be perfect while settlement never
// arrives.
//
// The last two tiers are not ratios. See ADR-001: an invariant does not get a
// permitted violation rate, it gets a time to detect and a time to repair.

import type { MetricRegistry } from "./telemetry/metrics.ts";
import { INVARIANTS } from "./invariants.ts";

export type SloTier =
  | "customer-promise"
  | "service-processing"
  | "provider-outcome"
  | "ledger-posting"
  | "settlement-finality";

export const TIERS: readonly SloTier[] = [
  "customer-promise",
  "service-processing",
  "provider-outcome",
  "ledger-posting",
  "settlement-finality",
];

export type SloKind = "request-based" | "windows-based" | "detect-and-repair";

export interface SloDefinition {
  readonly id: string;
  readonly tier: SloTier;
  readonly title: string;
  /** What is being measured, in words a product owner can argue with. */
  readonly specification: string;
  /** Where the number comes from. */
  readonly implementation: string;
  readonly kind: SloKind;
  /** Ratio goal for request-based objectives; null for detect-and-repair. */
  readonly goal: number | null;
  /** Minutes to detect and to repair, for detect-and-repair objectives. */
  readonly detectMinutes: number | null;
  readonly repairMinutes: number | null;
  readonly window: string;
  readonly note: string;
}

export const SLOS: readonly SloDefinition[] = [
  {
    id: "SLO-C1",
    tier: "customer-promise",
    title: "checkout accepts a payment",
    specification: "The proportion of checkout requests that receive a non-5xx response.",
    implementation: "money.http.responses{service=checkout-api}, 2xx+4xx over all classes.",
    kind: "request-based",
    goal: 0.999,
    detectMinutes: null,
    repairMinutes: null,
    window: "28-day rolling",
    note: "This is the number a dashboard shows first and the one that stays green in S04.",
  },
  {
    id: "SLO-C2",
    tier: "customer-promise",
    title: "checkout responds quickly",
    specification: "The proportion of checkout requests served faster than 400 ms.",
    implementation: "money.http.latency{service=checkout-api}, p95 against a 400 ms threshold.",
    kind: "request-based",
    goal: 0.99,
    detectMinutes: null,
    repairMinutes: null,
    window: "28-day rolling",
    note: "Fast is not the same as correct, and this objective knows nothing about the ledger.",
  },
  {
    id: "SLO-C3",
    tier: "customer-promise",
    title: "the status a customer sees is true",
    specification: "INV-5 holds: nobody is told SUCCEEDED without a provider effect, or FAILED when one exists.",
    implementation: "money.invariant.violations{invariant=INV-5}, evaluated out of band against durable state.",
    kind: "detect-and-repair",
    goal: null,
    detectMinutes: 15,
    repairMinutes: 60,
    window: "per occurrence",
    note: "The status endpoint can be fast, available and lying. Its own SLIs cannot tell.",
  },
  {
    id: "SLO-S1",
    tier: "service-processing",
    title: "an accepted payment reaches a terminal state",
    specification: "The proportion of operations that leave every non-terminal state within the state-age budget (INV-6).",
    implementation: "money.state.oldest_age_seconds per state, against the budget.",
    kind: "windows-based",
    goal: 0.999,
    detectMinutes: null,
    repairMinutes: null,
    window: "28-day rolling",
    note: "Age, not count. A small count with a growing age is the stuck case.",
  },
  {
    id: "SLO-P1",
    tier: "provider-outcome",
    title: "unknown outcomes are resolved",
    specification: "The proportion of provider calls whose outcome is known within 10 minutes, with INV-4 holding throughout.",
    implementation: "money.state.oldest_age_seconds{state=OUTCOME_UNKNOWN} against the budget; money.invariant.violations{invariant=INV-4}.",
    kind: "windows-based",
    goal: 0.999,
    detectMinutes: null,
    repairMinutes: null,
    window: "28-day rolling",
    note: "An unknown outcome is a state to resolve, not an error to retry blindly.",
  },
  {
    id: "SLO-L1",
    tier: "ledger-posting",
    title: "the journal balances",
    specification: "INV-1 holds. There is no acceptable rate of unbalanced journals.",
    implementation: "money.invariant.violations{invariant=INV-1}, evaluated out of band.",
    kind: "detect-and-repair",
    goal: null,
    detectMinutes: 15,
    repairMinutes: 240,
    window: "per occurrence",
    note: "Expressed as time to detect and time to repair rather than as a ratio. See ADR-001.",
  },
  {
    id: "SLO-L2",
    tier: "ledger-posting",
    title: "postings match effects",
    specification: "INV-2 and INV-3 hold for every live posting group.",
    implementation: "money.invariant.violations{invariant=INV-2} and {invariant=INV-3}.",
    kind: "detect-and-repair",
    goal: null,
    detectMinutes: 15,
    repairMinutes: 240,
    window: "per occurrence",
    note: "A posting that succeeded and a posting that is right are different claims.",
  },
  {
    id: "SLO-F1",
    tier: "settlement-finality",
    title: "settlement evidence arrives",
    specification: "INV-7 holds: every capture older than 48 hours has settlement evidence.",
    implementation: "money.settlement.lateness_seconds and money.invariant.violations{invariant=INV-7}.",
    kind: "detect-and-repair",
    goal: null,
    detectMinutes: 60,
    repairMinutes: 2880,
    window: "per occurrence",
    note: "Nothing in the request path knows this is late. Only a periodic check does.",
  },
  {
    id: "SLO-F2",
    tier: "settlement-finality",
    title: "the exception queue drains",
    specification: "INV-8 holds in both count and age.",
    implementation: "money.reconciliation.open and money.reconciliation.oldest_age_seconds.",
    kind: "detect-and-repair",
    goal: null,
    detectMinutes: 60,
    repairMinutes: 2880,
    window: "per occurrence",
    note: "Throughput rises while the residue accumulates, so throughput is the wrong signal.",
  },
];

export interface SloResult {
  readonly id: string;
  readonly tier: SloTier;
  readonly kind: SloKind;
  readonly value: number | null;
  readonly goal: number | null;
  readonly met: boolean;
}

/**
 * Evaluate only the technical objectives, from the metrics a service emits.
 *
 * This is deliberately the whole of what an ordinary monitoring setup can
 * answer. The invariant tiers are absent, and their absence is the argument.
 */
export function evaluateTechnicalSlos(metrics: MetricRegistry): SloResult[] {
  const results: SloResult[] = [];

  const total = metrics.sum("money.http.responses", { service: "checkout-api" });
  const bad = metrics.read("money.http.responses", { service: "checkout-api", class: "5xx" });
  const availability = total === 0 ? 1 : (total - bad) / total;
  results.push({
    id: "SLO-C1",
    tier: "customer-promise",
    kind: "request-based",
    value: availability,
    goal: 0.999,
    met: availability >= 0.999,
  });

  const p95 = metrics.percentile("money.http.latency", { service: "checkout-api" }, 95);
  results.push({
    id: "SLO-C2",
    tier: "customer-promise",
    kind: "request-based",
    value: p95,
    goal: 400,
    met: p95 <= 400,
  });

  const attempts = metrics.sum("money.provider.attempts");
  const unknown = metrics.read("money.provider.attempts", { outcome: "unknown" });
  const providerKnown = attempts === 0 ? 1 : (attempts - unknown) / attempts;
  results.push({
    id: "SLO-P1",
    tier: "provider-outcome",
    kind: "windows-based",
    value: providerKnown,
    goal: 0.999,
    met: providerKnown >= 0.999,
  });

  const delivered = metrics.sum("money.events.delivered");
  const dead = metrics.read("money.events.delivered", { outcome: "dead-lettered" });
  const deliverySuccess = delivered === 0 ? 1 : (delivered - dead) / delivered;
  results.push({
    id: "SLO-S1",
    tier: "service-processing",
    kind: "windows-based",
    value: deliverySuccess,
    goal: 0.999,
    met: deliverySuccess >= 0.999,
  });

  return results;
}

/** True when every technical objective is inside its target. */
export function allTechnicalSlosGreen(metrics: MetricRegistry): boolean {
  return evaluateTechnicalSlos(metrics).every((r) => r.met);
}

/**
 * The error budget implied by a ratio objective.
 *
 * Cloud Monitoring's own guidance is that a 100% goal leaves no error budget
 * and is bad practice. That is correct for ratio objectives and is exactly why
 * the ledger tiers are not ratio objectives.
 */
export function errorBudget(goal: number, eligibleEvents: number): number {
  return Math.floor((1 - goal) * eligibleEvents);
}

/** Every invariant must be named by at least one objective, or it is unowned. */
export function invariantsWithoutSlo(): string[] {
  const text = SLOS.map((s) => `${s.specification} ${s.implementation}`).join(" ");
  return INVARIANTS.filter((i) => !text.includes(i.id)).map((i) => i.id);
}
