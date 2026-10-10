// The synthetic money-movement canary.
//
// A probe payment with a known input and a known expected effect, run on a
// schedule against the same code path as real traffic, with its own business
// reference so that nothing it does is mistaken for a customer's money.
//
// The method is the one the SRE workbook describes for a correctness SLI:
// inject data with known outputs into the system and count how often the
// output matches. The difference from an uptime check is the assertion. An
// uptime check asks whether the endpoint answered. This asks whether the money
// arrived in the right place, in the right amount, exactly once.

import { Pipeline, feeFor } from "./domain/flow.ts";
import type { Faults } from "./domain/flow.ts";
import { checkInvariants } from "./invariants.ts";
import type { Violation } from "./invariants.ts";
import { DEFAULT_BUDGETS } from "./domain/types.ts";
import type { Budgets } from "./domain/types.ts";

export const CANARY_BUSINESS_REF = "canary-order";
export const CANARY_AMOUNT_MINOR = 1_000;
export const CANARY_CURRENCY = "EUR" as const;

export interface CanaryResult {
  readonly runId: string;
  readonly atMs: number;
  readonly passed: boolean;
  /** Each assertion, so a failure says which property broke. */
  readonly checks: { name: string; expected: string; actual: string; passed: boolean }[];
  readonly violations: readonly Violation[];
  readonly traceId: string;
}

/**
 * Run one canary payment and assert the known-good outcome.
 *
 * The probe runs in its own pipeline instance. That is a modelling
 * simplification — see docs/MODEL.md — and in a real deployment the canary
 * shares the production path and is excluded from customer-facing SLIs by its
 * business reference rather than by a separate process.
 */
export function runCanary(options: {
  runId: string;
  atMs: number;
  faults?: Faults;
  budgets?: Budgets;
  seed?: number;
}): CanaryResult {
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const pipeline = new Pipeline({ seed: options.seed ?? 77, samplingRate: 1 });
  pipeline.submit(
    {
      operationId: `${options.runId}-op`,
      businessRef: `${CANARY_BUSINESS_REF}-${options.runId}`,
      amountMinor: CANARY_AMOUNT_MINOR,
      currency: CANARY_CURRENCY,
    },
    options.atMs,
    options.faults ?? {},
  );

  const operation = pipeline.world.operations.get(`${options.runId}-op`);
  const effects = pipeline.world.effects;
  const postings = pipeline.world.postings;
  const expectedFee = feeFor(CANARY_AMOUNT_MINOR);
  // The settlement step lands an hour after the capture, so the probe is
  // judged two hours in — late enough for the whole flow, early enough that
  // the 48-hour settlement budget has not become the thing under test.
  const violations = checkInvariants(pipeline.world, options.atMs + 2 * 3_600_000, budgets);

  const checks: CanaryResult["checks"] = [
    {
      name: "one provider effect",
      expected: "1",
      actual: String(effects.length),
      passed: effects.length === 1,
    },
    {
      name: "captured amount",
      expected: String(CANARY_AMOUNT_MINOR),
      actual: String(effects[0]?.capturedMinor ?? 0),
      passed: effects[0]?.capturedMinor === CANARY_AMOUNT_MINOR,
    },
    {
      name: "one posting group",
      expected: "1",
      actual: String(postings.length),
      passed: postings.length === 1,
    },
    {
      name: "posting legs",
      expected: "3",
      actual: String(postings[0]?.legs.length ?? 0),
      passed: postings[0]?.legs.length === 3,
    },
    {
      name: "fee leg amount",
      expected: String(expectedFee),
      actual: String(
        postings[0]?.legs.find((l) => l.account === "processor-fees")?.amountMinor ?? 0,
      ),
      passed:
        postings[0]?.legs.find((l) => l.account === "processor-fees")?.amountMinor === expectedFee,
    },
    {
      name: "terminal state reached",
      expected: "SETTLED",
      actual: operation?.state ?? "MISSING",
      passed: operation?.state === "SETTLED",
    },
    {
      name: "no invariant violations",
      expected: "0",
      actual: String(violations.length),
      passed: violations.length === 0,
    },
    {
      name: "trace crossed every service",
      expected: "4",
      actual: String(operation ? pipeline.tracer.servicesInTrace(operation.traceId).length : 0),
      passed: operation ? pipeline.tracer.servicesInTrace(operation.traceId).length === 4 : false,
    },
  ];

  return {
    runId: options.runId,
    atMs: options.atMs,
    passed: checks.every((c) => c.passed),
    checks,
    violations,
    traceId: operation?.traceId ?? "",
  };
}
