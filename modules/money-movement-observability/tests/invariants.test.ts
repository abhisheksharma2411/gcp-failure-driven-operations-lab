import test from "node:test";
import assert from "node:assert/strict";

import { Pipeline, feeFor } from "../src/domain/flow.ts";
import { checkInvariants, INVARIANTS, violationCounts, publishInvariantGauges } from "../src/invariants.ts";
import { DEFAULT_BUDGETS, emptyWorld } from "../src/domain/types.ts";
import { MetricRegistry } from "../src/telemetry/metrics.ts";
import { METRICS, INVARIANT_IDS } from "../src/signals.ts";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const HOUR = 3_600_000;

function healthy(seed = 1): Pipeline {
  const p = new Pipeline({ seed, samplingRate: 1 });
  p.submit({ operationId: "op-1", businessRef: "order-1", amountMinor: 50_000, currency: "EUR" }, T0, {});
  return p;
}

test("a clean run violates nothing", () => {
  const p = healthy();
  assert.deepEqual(checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS), []);
});

test("every invariant has a distinct id, a runbook, and a severity", () => {
  const ids = INVARIANTS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...INVARIANT_IDS].sort());
  for (const i of INVARIANTS) {
    assert.ok(i.runbook.startsWith("RB-"), `${i.id} has no runbook`);
    assert.ok(i.statement.length > 40, `${i.id} has no statement worth reading`);
    assert.ok(i.invisibleTo.length > 10, `${i.id} does not say what signal misses it`);
  }
});

test("INV-1 catches the dropped fee leg and nothing else does", () => {
  const p = new Pipeline({ seed: 2, samplingRate: 1 });
  p.submit({ operationId: "op-2", businessRef: "order-2", amountMinor: 50_000, currency: "EUR" }, T0, {
    dropFeeLeg: true,
  });
  const violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.invariant, "INV-1");
  assert.equal(violations[0]?.amountMinor, feeFor(50_000));
});

test("INV-2 catches a posting that does not match the captured amount", () => {
  const p = healthy(3);
  const group = p.world.postings[0];
  assert.ok(group);
  const payable = group.legs.find((l) => l.account === "customer-payable");
  assert.ok(payable);
  // Rewrite the credit leg and the matching debit so that INV-1 still holds.
  group.legs.splice(0, group.legs.length, { ...payable, amountMinor: payable.amountMinor - 100 }, {
    account: "cash-in-transit",
    direction: "DEBIT",
    amountMinor: payable.amountMinor - 100,
  });
  const violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  assert.deepEqual(
    violations.map((v) => v.invariant),
    ["INV-2"],
  );
});

test("INV-3 catches a posting with no provider effect behind it", () => {
  const p = healthy(4);
  p.world.effects.splice(0, p.world.effects.length);
  const violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  const ids = violations.map((v) => v.invariant);
  assert.ok(ids.includes("INV-3"));
  assert.ok(ids.includes("INV-5"), "a customer told SUCCEEDED with no effect is also a lie");
});

test("INV-4 catches two effects for one operation", () => {
  const p = healthy(5);
  const effect = p.world.effects[0];
  assert.ok(effect);
  p.world.effects.push({ ...effect, providerOpId: "prov-dup" });
  const violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  assert.ok(violations.some((v) => v.invariant === "INV-4"));
});

test("INV-5 catches both directions of an untruthful status", () => {
  const p = healthy(6);
  const op = p.world.operations.get("op-1");
  assert.ok(op);
  op.customerStatus = "FAILED";
  let violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  assert.ok(violations.some((v) => v.invariant === "INV-5"));

  p.world.effects.splice(0, p.world.effects.length);
  op.customerStatus = "SUCCEEDED";
  violations = checkInvariants(p.world, T0 + 2 * HOUR, DEFAULT_BUDGETS);
  assert.ok(violations.some((v) => v.invariant === "INV-5"));
});

test("INV-6 fires on age, not on count", () => {
  const p = new Pipeline({ seed: 7, samplingRate: 1 });
  p.submit({ operationId: "op-7", businessRef: "order-7", amountMinor: 1_000, currency: "EUR" }, T0, {
    stuckOperation: true,
  });
  assert.deepEqual(checkInvariants(p.world, T0 + 5 * MIN, DEFAULT_BUDGETS), [], "inside the budget");
  const late = checkInvariants(p.world, T0 + 45 * MIN, DEFAULT_BUDGETS);
  assert.deepEqual(
    late.map((v) => v.invariant),
    ["INV-6"],
  );
});

test("INV-6 gives an unknown outcome a shorter budget than an ordinary state", () => {
  const p = new Pipeline({ seed: 8, samplingRate: 1 });
  p.submit({ operationId: "op-8", businessRef: "order-8", amountMinor: 1_000, currency: "EUR" }, T0, {
    lostClientResponse: true,
  });
  assert.deepEqual(checkInvariants(p.world, T0 + 5 * MIN, DEFAULT_BUDGETS), []);
  const late = checkInvariants(p.world, T0 + 12 * MIN, DEFAULT_BUDGETS);
  assert.equal(late.length, 1);
  assert.match(late[0]?.detail ?? "", /OUTCOME_UNKNOWN/);
});

test("INV-7 fires only after the settlement budget has elapsed", () => {
  const p = new Pipeline({ seed: 9, samplingRate: 1 });
  p.submit({ operationId: "op-9", businessRef: "order-9", amountMinor: 1_000, currency: "EUR" }, T0, {
    settlementStalled: true,
  });
  assert.deepEqual(
    checkInvariants(p.world, T0 + 47 * HOUR, DEFAULT_BUDGETS).map((v) => v.invariant),
    [],
  );
  assert.deepEqual(
    checkInvariants(p.world, T0 + 49 * HOUR, DEFAULT_BUDGETS).map((v) => v.invariant),
    ["INV-7"],
  );
});

test("INV-8 fires on count and on age independently", () => {
  const p = new Pipeline({ seed: 10, samplingRate: 1 });
  for (let i = 0; i < 26; i += 1) p.openException("amount-mismatch", null, T0);
  const byCount = checkInvariants(p.world, T0 + MIN, DEFAULT_BUDGETS);
  assert.deepEqual(
    byCount.map((v) => v.invariant),
    ["INV-8"],
  );

  const q = new Pipeline({ seed: 11, samplingRate: 1 });
  q.openException("amount-mismatch", null, T0 - 30 * HOUR);
  const byAge = checkInvariants(q.world, T0, DEFAULT_BUDGETS);
  assert.equal(byAge.length, 1);
  assert.match(byAge[0]?.detail ?? "", /open for/);
});

test("the gauges publish a zero for every invariant, not only the broken ones", () => {
  const registry = new MetricRegistry(METRICS);
  publishInvariantGauges(registry, []);
  for (const id of INVARIANT_IDS) {
    assert.equal(registry.read("money.invariant.violations", { invariant: id }), 0);
  }
  assert.equal(registry.activeSeries(), INVARIANT_IDS.length);
});

test("violationCounts reports every invariant even when nothing is wrong", () => {
  assert.deepEqual(Object.keys(violationCounts([])).sort(), [...INVARIANT_IDS].sort());
});

test("the checker is pure: an empty world has no violations and no side effects", () => {
  const world = emptyWorld();
  assert.deepEqual(checkInvariants(world, T0, DEFAULT_BUDGETS), []);
  assert.equal(world.operations.size, 0);
  assert.equal(world.postings.length, 0);
});
