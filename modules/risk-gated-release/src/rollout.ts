import type { Change } from "./types.ts";
import { evaluate } from "./evaluate.ts";

export interface Phase {
  readonly name: string;
  readonly percent: number;
}

export interface Observation {
  /** Error rate observed during the phase, as a fraction. */
  readonly errorRate: number;
  /** p99 latency in ms observed during the phase. */
  readonly p99Ms: number;
  /** Did a synthetic business check pass? Health checks are not this. */
  readonly businessCheckPassed: boolean;
}

export interface Baseline {
  readonly errorRate: number;
  readonly p99Ms: number;
}

export type RolloutOutcome = "COMPLETED" | "HALTED" | "BLOCKED_AT_GATE";

export interface RolloutResult {
  readonly outcome: RolloutOutcome;
  readonly reachedPhase: string | null;
  /** Fraction of traffic exposed to the change at the worst moment. */
  readonly maxExposure: number;
  readonly reasons: readonly string[];
  readonly rolledBack: boolean;
}

/**
 * The legacy path: no manifest, no gate, one step to everything.
 *
 * This exists so the comparison in the report is honest. Running an ungated
 * change through `rollout` does NOT model 2019, because `rollout` consults the
 * manifest and blocks it -- which is the manifest working, not the failure. To
 * show the failure, the gate has to be absent rather than failed.
 */
export function ungatedRollout(
  baseline: Baseline,
  observe: (phase: Phase) => Observation,
): RolloutResult {
  const phase: Phase = { name: "stable", percent: 100 };
  const o = observe(phase);
  const bad =
    !o.businessCheckPassed ||
    o.errorRate > baseline.errorRate * 2 ||
    o.p99Ms > baseline.p99Ms * 1.5;
  return {
    outcome: bad ? "HALTED" : "COMPLETED",
    reachedPhase: "stable",
    maxExposure: 100,
    reasons: bad ? ["regression detected, but everything was already exposed"] : [],
    rolledBack: bad,
  };
}

/** Phase names follow the Cloud Deploy canary example. */
export const DEFAULT_PHASES: readonly Phase[] = [
  { name: "canary-25", percent: 25 },
  { name: "canary-50", percent: 50 },
  { name: "canary-75", percent: 75 },
  { name: "stable", percent: 100 },
];

/**
 * Run a staged rollout, halting on the first phase whose observations regress.
 *
 * The thing worth noticing is `maxExposure`. A change that is wrong will be
 * wrong somewhere; the question a release system answers is how much of the
 * world saw it. Going straight to stable makes that number 100, which is what
 * "went global in seconds" means.
 */
export function rollout(
  change: Change,
  baseline: Baseline,
  observe: (phase: Phase) => Observation,
  phases: readonly Phase[] = DEFAULT_PHASES,
): RolloutResult {
  const gate = evaluate(change);
  if (gate.decision === "BLOCK") {
    return {
      outcome: "BLOCKED_AT_GATE",
      reachedPhase: null,
      maxExposure: 0,
      reasons: gate.reasons,
      rolledBack: false,
    };
  }

  const reasons: string[] = [];
  let maxExposure = 0;
  let reached: string | null = null;

  for (const phase of phases) {
    maxExposure = Math.max(maxExposure, phase.percent);
    reached = phase.name;
    const o = observe(phase);

    if (!o.businessCheckPassed) {
      reasons.push(`business verification failed at ${phase.name}`);
      return { outcome: "HALTED", reachedPhase: reached, maxExposure, reasons, rolledBack: true };
    }
    if (o.errorRate > baseline.errorRate * 2) {
      reasons.push(
        `error rate regressed at ${phase.name}: ${o.errorRate} against baseline ${baseline.errorRate}`,
      );
      return { outcome: "HALTED", reachedPhase: reached, maxExposure, reasons, rolledBack: true };
    }
    if (o.p99Ms > baseline.p99Ms * 1.5) {
      reasons.push(
        `p99 regressed at ${phase.name}: ${o.p99Ms}ms against baseline ${baseline.p99Ms}ms`,
      );
      return { outcome: "HALTED", reachedPhase: reached, maxExposure, reasons, rolledBack: true };
    }
  }

  return { outcome: "COMPLETED", reachedPhase: reached, maxExposure, reasons, rolledBack: false };
}
