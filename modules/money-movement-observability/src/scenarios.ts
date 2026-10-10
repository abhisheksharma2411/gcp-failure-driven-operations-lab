// The fault catalogue.
//
// Ten scenarios, each one of the exercises the article claims the design
// handles, written as data so that the expectations can be read without
// reading the implementation. Each records three things: whether every
// technical objective stayed green, which business invariants broke, and which
// alerts fired.
//
// The column that matters is the first one. A scenario where the technical
// objectives stay green and an invariant goes red is a scenario where an
// ordinary monitoring setup sees nothing at all.

import { Pipeline } from "./domain/flow.ts";
import { DEFAULT_BUDGETS } from "./domain/types.ts";
import type { Budgets } from "./domain/types.ts";
import { checkInvariants, publishInvariantGauges, publishOperationalGauges } from "./invariants.ts";
import type { Violation } from "./invariants.ts";
import { evaluateAlerts, type Snapshot } from "./alerts.ts";
import { allTechnicalSlosGreen, evaluateTechnicalSlos } from "./slo.ts";
import type { SloResult } from "./slo.ts";
import { runCanary } from "./canary.ts";
import { respond } from "./incident.ts";
import { CardinalityError } from "./telemetry/metrics.ts";
import { SYNTHETIC_PAN, SYNTHETIC_EMAIL } from "./domain/fixtures.ts";

/** Deliberately weakened variants, used as negative controls. */
export type Mutation =
  | "no-invariant-checker"
  | "no-state-age-check"
  | "no-redaction"
  | "no-cardinality-guard"
  | "no-audit-trail"
  | "disable-everything";

export const MUTATIONS: readonly Mutation[] = [
  "no-invariant-checker",
  "no-state-age-check",
  "no-redaction",
  "no-cardinality-guard",
  "no-audit-trail",
];

export const BLUNT_MUTATION: Mutation = "disable-everything";

export const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const HOUR = 3_600_000;

export interface ScenarioOutcome {
  readonly pipeline: Pipeline;
  readonly evaluateAtMs: number;
  readonly canaryPassed: boolean | null;
  readonly cardinalityRejections: number;
  readonly extra: Record<string, number | boolean | string>;
}

export interface ScenarioExpectation {
  readonly technicalGreen: boolean;
  readonly invariants: readonly string[];
  readonly alerts: readonly string[];
  readonly extra?: Readonly<Record<string, number | boolean | string>>;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** The required exercise this scenario is the answer to. */
  readonly covers: string;
  readonly expect: ScenarioExpectation;
  readonly run: (ctx: { mutation: Mutation | null; budgets: Budgets }) => ScenarioOutcome;
}

function pipelineFor(mutation: Mutation | null, seed: number): Pipeline {
  return new Pipeline({
    seed,
    samplingRate: 1,
    redactionEnabled: mutation !== "no-redaction" && mutation !== "disable-everything",
    cardinalityGuardEnabled: mutation !== "no-cardinality-guard" && mutation !== "disable-everything",
  });
}

function heartbeats(pipeline: Pipeline, atMs: number): void {
  pipeline.recordCheckerRun("invariants", atMs);
  pipeline.recordCheckerRun("canary", atMs);
  pipeline.recordCheckerRun("reconciliation", atMs);
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "S01",
    title: "the provider succeeded and the client never heard",
    covers: "provider success with lost client response",
    expect: {
      technicalGreen: false,
      invariants: ["INV-6"],
      alerts: ["ALERT-PROVIDER-UNKNOWN", "ALERT-STUCK-OPERATION"],
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 101);
      pipeline.submit(
        { operationId: "op-101", businessRef: "order-101", amountMinor: 24_000, currency: "EUR" },
        T0,
        { lostClientResponse: true },
      );
      const at = T0 + 20 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: null,
        cardinalityRejections: 0,
        extra: { effectsRecorded: pipeline.world.effects.length },
      };
    },
  },
  {
    id: "S02",
    title: "the same event is delivered twice and nothing happens twice",
    covers: "duplicate delivery without duplicate effect",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: [],
      extra: { effects: 1, duplicatesSuppressed: 1 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 102);
      pipeline.submit(
        { operationId: "op-102", businessRef: "order-102", amountMinor: 31_500, currency: "EUR" },
        T0,
        { duplicateDelivery: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          effects: pipeline.world.effects.length,
          duplicatesSuppressed: pipeline.metrics.read("money.events.delivered", {
            outcome: "duplicate-suppressed",
          }),
        },
      };
    },
  },
  {
    id: "S03",
    title: "one operation stops moving while the queue looks empty",
    covers: "stuck in-progress operation",
    expect: {
      technicalGreen: true,
      invariants: ["INV-6"],
      alerts: ["ALERT-STUCK-OPERATION"],
      extra: { capturedCount: 1 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 103);
      pipeline.submit(
        { operationId: "op-103", businessRef: "order-103", amountMinor: 18_900, currency: "EUR" },
        T0,
        { stuckOperation: true },
      );
      const at = T0 + 45 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          capturedCount: [...pipeline.world.operations.values()].filter((o) => o.state === "CAPTURED").length,
        },
      };
    },
  },
  {
    id: "S04",
    title: "every call returns 200 and the journal is short by the fee",
    covers: "ledger imbalance injected in a non-production fixture",
    expect: {
      technicalGreen: true,
      invariants: ["INV-1"],
      alerts: ["ALERT-LEDGER-IMBALANCE"],
      extra: { httpErrors: 0, legs: 2 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 104);
      pipeline.submit(
        { operationId: "op-104", businessRef: "order-104", amountMinor: 50_000, currency: "EUR" },
        T0,
        { dropFeeLeg: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      let httpErrors = 0;
      for (const service of ["checkout-api", "provider-gateway", "ledger-poster", "settlement-importer"]) {
        httpErrors += pipeline.metrics.read("money.http.responses", { service, class: "5xx" });
      }
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { httpErrors, legs: pipeline.world.postings[0]?.legs.length ?? 0 },
      };
    },
  },
  {
    id: "S05",
    title: "the exception queue stops draining",
    covers: "reconciliation backlog growth",
    expect: {
      technicalGreen: true,
      invariants: ["INV-8"],
      alerts: ["ALERT-RECON-BACKLOG"],
      extra: { openExceptions: 31 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 105);
      pipeline.submit(
        { operationId: "op-105", businessRef: "order-105", amountMinor: 12_000, currency: "EUR" },
        T0,
        {},
      );
      // A backlog that accumulated over three days. The arrival rate never
      // changed, so throughput looks exactly as it always did.
      for (let i = 0; i < 31; i += 1) {
        pipeline.openException("unmatched-settlement", null, T0 - 72 * HOUR + i * HOUR);
      }
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          openExceptions: pipeline.world.exceptions.filter((e) => e.resolvedAtMs === null).length,
        },
      };
    },
  },
  {
    id: "S06",
    title: "the telemetry pipeline goes away and the dashboard turns green",
    covers: "telemetry pipeline partially unavailable",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: ["ALERT-CHECKER-STALE"],
      extra: { seriesWritten: 0 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 106);
      pipeline.submit(
        { operationId: "op-106", businessRef: "order-106", amountMinor: 9_900, currency: "EUR" },
        T0,
        { telemetryDown: "metrics" },
      );
      // No heartbeat: the checker cannot publish, so its staleness grows.
      const at = T0 + 40 * MIN;
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: null,
        cardinalityRejections: 0,
        extra: { seriesWritten: pipeline.metrics.activeSeries() },
      };
    },
  },
  {
    id: "S07",
    title: "the sampler drops the trace and the audit record survives",
    covers: "trace sampling still preserves required audit evidence",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: [],
      extra: { exportedSpans: 0, auditRecords: 5, timelineReconstructed: true },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 107);
      const op = pipeline.submit(
        { operationId: "op-107", businessRef: "order-107", amountMinor: 41_000, currency: "EUR" },
        T0,
        { forceUnsampled: true },
      );
      const at = T0 + 2 * HOUR;
      heartbeats(pipeline, at);
      const exported = pipeline.tracer.exported().filter((s) => s.traceId === op.traceId);
      const records =
        mutation === "no-audit-trail" || mutation === "disable-everything"
          ? []
          : pipeline.audit.byOperation("op-107");
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          exportedSpans: exported.length,
          auditRecords: records.length,
          timelineReconstructed: records.length > 0,
        },
      };
    },
  },
  {
    id: "S08",
    title: "a card number and an address reach a log line and do not leave it",
    covers: "log-redaction test",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: [],
      extra: { panOccurrences: 0, emailOccurrences: 0, correlationIntact: true },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 108);
      // Synthetic values, assembled at run time: see domain/fixtures.ts for
      // why no card-shaped literal appears in this repository.
      pipeline.submit(
        {
          operationId: "op-108",
          businessRef: "order-108",
          amountMinor: 7_500,
          currency: "USD",
          customerEmail: SYNTHETIC_EMAIL,
          pan: SYNTHETIC_PAN,
        },
        T0,
        {},
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      const serialised = pipeline.log.serialised();
      const entries = pipeline.log.byOperation("op-108");
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          panOccurrences: serialised.split(SYNTHETIC_PAN).length - 1,
          emailOccurrences: serialised.split(SYNTHETIC_EMAIL).length - 1,
          correlationIntact: entries.length > 0 && entries.every((e) => e.correlation.traceId !== ""),
        },
      };
    },
  },
  {
    id: "S09",
    title: "a service tries to label a metric with an operation id",
    covers: "metric-cardinality guard",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: ["ALERT-CARDINALITY-REJECTED"],
      extra: { rejected: 1 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 109);
      pipeline.submit(
        { operationId: "op-109", businessRef: "order-109", amountMinor: 6_400, currency: "EUR" },
        T0,
        {},
      );
      let rejected = 0;
      try {
        // The write a well-meaning engineer adds during an incident, because
        // the dashboard would be so much more useful broken down by operation.
        pipeline.metrics.increment("money.effects.applied", { currency: "op-109" });
      } catch (error) {
        if (error instanceof CardinalityError) rejected += 1;
        else throw error;
      }
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: rejected,
        extra: { rejected },
      };
    },
  },
  {
    id: "S10",
    title: "the alert fires, the runbook repairs it twice, and the invariant comes back",
    covers: "alert fires, runbook identifies cause, repair executes idempotently, invariant healthy",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: [],
      extra: { violationsBefore: 1, violationsAfter: 0, repairIdempotent: true, timelineSteps: 5 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 110);
      pipeline.submit(
        { operationId: "op-110", businessRef: "order-110", amountMinor: 50_000, currency: "EUR" },
        T0,
        { dropFeeLeg: true },
      );
      const firedAtMs = T0 + 10 * MIN;
      const evidence = respond({
        alertId: "ALERT-LEDGER-IMBALANCE",
        world: pipeline.world,
        audit: pipeline.audit,
        budgets,
        firedAtMs,
      });
      const at = evidence.verifiedAtMs;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: {
          violationsBefore: evidence.violationsBefore,
          violationsAfter: evidence.violationsAfter,
          repairIdempotent: evidence.repair.idempotent,
          timelineSteps: evidence.diagnosis.auditTimeline.length,
          outcome: evidence.outcome,
        },
      };
    },
  },

  // --- scenarios that exist to prove the remaining alerts can fire ----------
  //
  // The alert-coverage check found seven rules that no required exercise could
  // trigger. An alert nobody has ever seen fire is a belief; these seven
  // scenarios turn each of them into an observation.

  {
    id: "S11",
    title: "checkout refuses the request and every signal agrees",
    covers: "alert coverage: availability breach",
    expect: {
      technicalGreen: false,
      invariants: [],
      alerts: ["ALERT-API-AVAILABILITY"],
      extra: { effects: 0 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 111);
      pipeline.submit(
        { operationId: "op-111", businessRef: "order-111", amountMinor: 2_000, currency: "EUR" },
        T0,
        { apiRejects: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { effects: pipeline.world.effects.length },
      };
    },
  },
  {
    id: "S12",
    title: "checkout answers slowly and correctly",
    covers: "alert coverage: latency breach",
    expect: {
      technicalGreen: false,
      invariants: [],
      alerts: ["ALERT-API-LATENCY"],
      extra: { p95: 1400 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 112);
      pipeline.submit(
        { operationId: "op-112", businessRef: "order-112", amountMinor: 2_000, currency: "EUR" },
        T0,
        { slowCheckout: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { p95: pipeline.metrics.percentile("money.http.latency", { service: "checkout-api" }, 95) },
      };
    },
  },
  {
    id: "S13",
    title: "the journal balances and credits the wrong amount",
    covers: "alert coverage: posting mismatch with a balanced journal",
    expect: {
      technicalGreen: true,
      invariants: ["INV-2"],
      alerts: ["ALERT-POSTING-MISMATCH"],
      extra: { balanced: true },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 113);
      pipeline.submit(
        { operationId: "op-113", businessRef: "order-113", amountMinor: 50_000, currency: "EUR" },
        T0,
        { postingMismatch: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      const group = pipeline.world.postings[0];
      const d = group?.legs.filter((l) => l.direction === "DEBIT").reduce((a, l) => a + l.amountMinor, 0) ?? 0;
      const c = group?.legs.filter((l) => l.direction === "CREDIT").reduce((a, l) => a + l.amountMinor, 0) ?? 0;
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { balanced: d === c },
      };
    },
  },
  {
    id: "S14",
    title: "a posting arrives for an effect nobody recorded",
    covers: "alert coverage: orphan posting",
    expect: {
      technicalGreen: true,
      invariants: ["INV-3"],
      alerts: ["ALERT-ORPHAN-POSTING"],
      extra: { postings: 1 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 114);
      pipeline.submit(
        { operationId: "op-114", businessRef: "order-114", amountMinor: 50_000, currency: "EUR" },
        T0,
        { orphanPosting: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { postings: pipeline.world.postings.length },
      };
    },
  },
  {
    id: "S15",
    title: "a retry mints a fresh key and the customer is charged twice",
    covers: "alert coverage: duplicate effect",
    expect: {
      technicalGreen: true,
      invariants: ["INV-4"],
      alerts: ["ALERT-DUPLICATE-EFFECT"],
      extra: { effects: 2 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 115);
      pipeline.submit(
        { operationId: "op-115", businessRef: "order-115", amountMinor: 50_000, currency: "EUR" },
        T0,
        { duplicateEffect: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { effects: pipeline.world.effects.length },
      };
    },
  },
  {
    id: "S16",
    title: "the provider declined and the customer was told it worked",
    covers: "alert coverage: status divergence",
    expect: {
      technicalGreen: true,
      invariants: ["INV-5"],
      alerts: ["ALERT-STATUS-DIVERGENCE"],
      extra: { effects: 0 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 116);
      pipeline.submit(
        { operationId: "op-116", businessRef: "order-116", amountMinor: 50_000, currency: "EUR" },
        T0,
        { providerDeclined: true, optimisticStatus: true },
      );
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { effects: pipeline.world.effects.length },
      };
    },
  },
  {
    id: "S17",
    title: "settlement evidence never arrives",
    covers: "alert coverage: settlement lateness",
    expect: {
      technicalGreen: true,
      invariants: ["INV-7"],
      alerts: ["ALERT-SETTLEMENT-LATE"],
      extra: { settlements: 0 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 117);
      pipeline.submit(
        { operationId: "op-117", businessRef: "order-117", amountMinor: 50_000, currency: "EUR" },
        T0,
        { settlementStalled: true },
      );
      const at = T0 + 49 * HOUR;
      heartbeats(pipeline, at);
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: true,
        cardinalityRejections: 0,
        extra: { settlements: pipeline.world.settlements.length },
      };
    },
  },
  {
    id: "S18",
    title: "the canary notices before a customer does",
    covers: "alert coverage: synthetic canary failure",
    expect: {
      technicalGreen: true,
      invariants: [],
      alerts: ["ALERT-CANARY-FAILED"],
      extra: { canaryChecksFailed: 3 },
    },
    run: ({ mutation, budgets }) => {
      const pipeline = pipelineFor(mutation, 118);
      pipeline.submit(
        { operationId: "op-118", businessRef: "order-118", amountMinor: 2_000, currency: "EUR" },
        T0,
        {},
      );
      // The canary runs against the same flow with the fault present. Customer
      // traffic in this window happened not to hit it; the probe did.
      const probe = runCanary({ runId: "canary-probe", atMs: T0, faults: { dropFeeLeg: true } });
      const at = T0 + 5 * MIN;
      heartbeats(pipeline, at);
      pipeline.metrics.increment("money.canary.outcome", { result: probe.passed ? "pass" : "fail" });
      return {
        pipeline,
        evaluateAtMs: at,
        canaryPassed: probe.passed,
        cardinalityRejections: 0,
        extra: { canaryChecksFailed: probe.checks.filter((c) => !c.passed).length },
      };
    },
  },
];

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly covers: string;
  readonly technicalGreen: boolean;
  readonly technical: SloResult[];
  readonly invariantsViolated: string[];
  readonly alertsFired: string[];
  readonly extra: Record<string, number | boolean | string>;
  readonly passed: boolean;
  readonly failures: string[];
}

/** Apply a mutation to the invariant results. */
function mutateViolations(violations: Violation[], mutation: Mutation | null): Violation[] {
  if (mutation === "no-invariant-checker" || mutation === "disable-everything") return [];
  if (mutation === "no-state-age-check") {
    return violations.filter((v) => v.invariant !== "INV-6" && v.invariant !== "INV-7");
  }
  return violations;
}

export function runScenario(
  scenario: Scenario,
  mutation: Mutation | null = null,
  budgets: Budgets = DEFAULT_BUDGETS,
): ScenarioResult {
  const outcome = scenario.run({ mutation, budgets });
  const { pipeline, evaluateAtMs } = outcome;

  const violations = mutateViolations(
    checkInvariants(pipeline.world, evaluateAtMs, budgets),
    mutation,
  );
  publishOperationalGauges(pipeline.metrics, pipeline.world, evaluateAtMs);
  publishInvariantGauges(pipeline.metrics, violations);

  const technical = evaluateTechnicalSlos(pipeline.metrics);
  const technicalGreen = allTechnicalSlosGreen(pipeline.metrics);

  const snapshot: Snapshot = {
    nowMs: evaluateAtMs,
    metrics: pipeline.metrics,
    world: pipeline.world,
    budgets,
    violations,
    technical,
    canaryPassed: outcome.canaryPassed,
    cardinalityRejections: outcome.cardinalityRejections,
  };
  const alertsFired = evaluateAlerts(snapshot);

  const invariantsViolated = [...new Set(violations.map((v) => v.invariant))].sort();
  const failures: string[] = [];
  if (technicalGreen !== scenario.expect.technicalGreen) {
    failures.push(`technicalGreen expected ${scenario.expect.technicalGreen}, got ${technicalGreen}`);
  }
  const expectedInvariants = [...scenario.expect.invariants].sort();
  if (JSON.stringify(invariantsViolated) !== JSON.stringify(expectedInvariants)) {
    failures.push(`invariants expected [${expectedInvariants}], got [${invariantsViolated}]`);
  }
  const expectedAlerts = [...scenario.expect.alerts].sort();
  const gotAlerts = [...alertsFired].sort();
  if (JSON.stringify(gotAlerts) !== JSON.stringify(expectedAlerts)) {
    failures.push(`alerts expected [${expectedAlerts}], got [${gotAlerts}]`);
  }
  for (const [key, expected] of Object.entries(scenario.expect.extra ?? {})) {
    if (outcome.extra[key] !== expected) {
      failures.push(`${key} expected ${String(expected)}, got ${String(outcome.extra[key])}`);
    }
  }

  return {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    technicalGreen,
    technical,
    invariantsViolated,
    alertsFired,
    extra: outcome.extra,
    passed: failures.length === 0,
    failures,
  };
}

export function runCatalogue(
  mutation: Mutation | null = null,
  budgets: Budgets = DEFAULT_BUDGETS,
): ScenarioResult[] {
  return SCENARIOS.map((s) => runScenario(s, mutation, budgets));
}

/** A canary run against the unmodified flow, for the report. */
export function canaryForReport() {
  return runCanary({ runId: "canary-0001", atMs: T0 });
}
