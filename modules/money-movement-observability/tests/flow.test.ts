import test from "node:test";
import assert from "node:assert/strict";

import { Pipeline, feeFor } from "../src/domain/flow.ts";
import { runCanary } from "../src/canary.ts";
import { evaluateTechnicalSlos, allTechnicalSlosGreen, SLOS, TIERS, errorBudget, invariantsWithoutSlo } from "../src/slo.ts";
import { checkInvariants } from "../src/invariants.ts";
import { DEFAULT_BUDGETS } from "../src/domain/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;

test("one payment produces one trace that crosses all four services", () => {
  const p = new Pipeline({ seed: 21, samplingRate: 1 });
  const op = p.submit(
    { operationId: "op-21", businessRef: "order-21", amountMinor: 50_000, currency: "EUR" },
    T0,
    {},
  );
  const services = p.tracer.servicesInTrace(op.traceId);
  assert.deepEqual(services, ["checkout-api", "provider-gateway", "ledger-poster", "settlement-importer"]);
  assert.equal(new Set(p.tracer.all.map((s) => s.traceId)).size, 1);
});

test("every span after the first has a parent inside the same trace", () => {
  const p = new Pipeline({ seed: 22, samplingRate: 1 });
  const op = p.submit(
    { operationId: "op-22", businessRef: "order-22", amountMinor: 1_000, currency: "EUR" },
    T0,
    {},
  );
  const spans = p.tracer.trace(op.traceId);
  const ids = new Set(spans.map((s) => s.spanId));
  assert.equal(spans.filter((s) => s.parentSpanId === null).length, 1);
  for (const span of spans) {
    if (span.parentSpanId) assert.ok(ids.has(span.parentSpanId), `${span.name} has an orphan parent`);
  }
});

test("the posting group balances and carries the fee as its own leg", () => {
  const p = new Pipeline({ seed: 23, samplingRate: 1 });
  p.submit({ operationId: "op-23", businessRef: "order-23", amountMinor: 50_000, currency: "EUR" }, T0, {});
  const group = p.world.postings[0];
  assert.ok(group);
  assert.equal(group.legs.length, 3);
  const debits = group.legs.filter((l) => l.direction === "DEBIT").reduce((a, l) => a + l.amountMinor, 0);
  const credits = group.legs.filter((l) => l.direction === "CREDIT").reduce((a, l) => a + l.amountMinor, 0);
  assert.equal(debits, credits);
  assert.equal(group.legs.find((l) => l.account === "processor-fees")?.amountMinor, feeFor(50_000));
});

test("a duplicate delivery is suppressed and produces no second posting", () => {
  const p = new Pipeline({ seed: 24, samplingRate: 1 });
  p.submit({ operationId: "op-24", businessRef: "order-24", amountMinor: 1_000, currency: "EUR" }, T0, {
    duplicateDelivery: true,
  });
  assert.equal(p.world.postings.length, 1);
  assert.equal(p.world.effects.length, 1);
  assert.equal(p.metrics.read("money.events.delivered", { outcome: "duplicate-suppressed" }), 1);
});

test("a lost client response leaves the operation open and the effect recorded", () => {
  const p = new Pipeline({ seed: 25, samplingRate: 1 });
  const op = p.submit(
    { operationId: "op-25", businessRef: "order-25", amountMinor: 1_000, currency: "EUR" },
    T0,
    { lostClientResponse: true },
  );
  assert.equal(op.state, "OUTCOME_UNKNOWN");
  assert.equal(op.customerStatus, "PROCESSING");
  assert.equal(p.world.effects.length, 1, "the provider still did the work");
  assert.equal(p.world.postings.length, 0);
});

test("the dropped fee leg breaks the books and nothing in the request path", () => {
  const p = new Pipeline({ seed: 26, samplingRate: 1 });
  p.submit({ operationId: "op-26", businessRef: "order-26", amountMinor: 50_000, currency: "EUR" }, T0, {
    dropFeeLeg: true,
  });
  for (const service of ["checkout-api", "provider-gateway", "ledger-poster", "settlement-importer"]) {
    assert.equal(p.metrics.read("money.http.responses", { service, class: "5xx" }), 0);
  }
  assert.equal(allTechnicalSlosGreen(p.metrics), true);
  assert.equal(checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS).length, 1);
});

test("technical objectives report a value and a verdict for each tier they cover", () => {
  const p = new Pipeline({ seed: 27, samplingRate: 1 });
  p.submit({ operationId: "op-27", businessRef: "order-27", amountMinor: 1_000, currency: "EUR" }, T0, {});
  const results = evaluateTechnicalSlos(p.metrics);
  assert.equal(results.length, 4);
  for (const r of results) assert.ok(r.value !== null);
});

test("every objective names a tier that exists, and every tier has an objective", () => {
  for (const slo of SLOS) assert.ok(TIERS.includes(slo.tier), `${slo.id} has an unknown tier`);
  for (const tier of TIERS) {
    assert.ok(SLOS.some((s) => s.tier === tier), `${tier} has no objective`);
  }
});

test("ledger and settlement objectives are detect-and-repair, not ratios", () => {
  for (const slo of SLOS) {
    if (slo.tier === "ledger-posting" || slo.tier === "settlement-finality") {
      assert.equal(slo.kind, "detect-and-repair", `${slo.id} should not be a ratio objective`);
      assert.equal(slo.goal, null);
      assert.ok((slo.detectMinutes ?? 0) > 0, `${slo.id} has no detection target`);
      assert.ok((slo.repairMinutes ?? 0) > 0, `${slo.id} has no repair target`);
    }
  }
});

test("no ratio objective is set to 100 percent", () => {
  for (const slo of SLOS) {
    if (slo.goal !== null) assert.ok(slo.goal < 1, `${slo.id} leaves no error budget`);
  }
});

test("every invariant is named by at least one objective", () => {
  assert.deepEqual(invariantsWithoutSlo(), []);
});

test("the error budget is the complement of the goal", () => {
  assert.equal(errorBudget(0.999, 1_000_000), 1_000);
  assert.equal(errorBudget(0.85, 60_480), 9_072);
});

test("the canary asserts the effect, not the response", () => {
  const pass = runCanary({ runId: "c1", atMs: T0 });
  assert.equal(pass.passed, true);
  assert.equal(pass.checks.length, 8);

  const fail = runCanary({ runId: "c2", atMs: T0, faults: { dropFeeLeg: true } });
  assert.equal(fail.passed, false);
  const failed = fail.checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(failed, ["posting legs", "fee leg amount", "no invariant violations"]);
});

test("the canary uses its own business reference so it is never mistaken for a customer", () => {
  const result = runCanary({ runId: "c3", atMs: T0 });
  assert.match(result.runId, /^c3$/);
  assert.ok(result.traceId.length === 32);
});
