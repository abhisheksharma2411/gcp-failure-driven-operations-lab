import test from "node:test";
import assert from "node:assert/strict";

import { Pipeline } from "../src/domain/flow.ts";
import { respond, diagnose, repairImbalance } from "../src/incident.ts";
import { checkInvariants } from "../src/invariants.ts";
import { DEFAULT_BUDGETS } from "../src/domain/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;

function broken(seed = 31): Pipeline {
  const p = new Pipeline({ seed, samplingRate: 1 });
  p.submit({ operationId: "op-31", businessRef: "order-31", amountMinor: 50_000, currency: "EUR" }, T0, {
    dropFeeLeg: true,
  });
  return p;
}

test("the diagnosis reaches the operation, the journal, the money and the log query", () => {
  const p = broken();
  const violation = checkInvariants(p.world, T0 + 10 * MIN, DEFAULT_BUDGETS)[0];
  assert.ok(violation);
  const d = diagnose(violation, p.world, p.audit);
  assert.equal(d.operationId, "op-31");
  assert.ok(d.journalId);
  assert.ok((d.amountMinor ?? 0) > 0);
  assert.match(d.logQuery, /operationId="op-31"/);
  assert.ok(d.auditTimeline.length >= 5, "the timeline must be reconstructable from the audit trail alone");
  assert.ok(d.traceId);
});

test("the repair supersedes rather than edits", () => {
  const p = broken(32);
  const original = p.world.postings[0];
  assert.ok(original);
  const before = JSON.stringify(original.legs);
  repairImbalance(p.world, p.audit, original.journalId, T0 + MIN, 1);
  assert.equal(JSON.stringify(original.legs), before, "the wrong group must not be rewritten");
  assert.ok(original.supersededByJournalId);
  assert.equal(p.world.postings.length, 2);
});

test("the second invocation of the repair changes nothing", () => {
  const p = broken(33);
  const journalId = p.world.postings[0]?.journalId;
  assert.ok(journalId);
  const first = repairImbalance(p.world, p.audit, journalId, T0 + MIN, 1);
  const second = repairImbalance(p.world, p.audit, journalId, T0 + 2 * MIN, 2);
  assert.equal(first.created.length, 1);
  assert.deepEqual(second, { superseded: [], created: [] });
  assert.equal(p.world.postings.length, 2);
});

test("the full loop resolves the violation and records what happened", () => {
  const p = broken(34);
  const evidence = respond({
    alertId: "ALERT-LEDGER-IMBALANCE",
    world: p.world,
    audit: p.audit,
    budgets: DEFAULT_BUDGETS,
    firedAtMs: T0 + 10 * MIN,
  });
  assert.equal(evidence.violationsBefore, 1);
  assert.equal(evidence.violationsAfter, 0);
  assert.equal(evidence.outcome, "resolved");
  assert.equal(evidence.repair.idempotent, true);
  assert.equal(evidence.runbook, "RB-LEDGER-IMBALANCE");
  assert.equal(evidence.route, "payments-oncall");
});

test("the repair writes its own audit record, so the correction is evidence too", () => {
  const p = broken(35);
  respond({
    alertId: "ALERT-LEDGER-IMBALANCE",
    world: p.world,
    audit: p.audit,
    budgets: DEFAULT_BUDGETS,
    firedAtMs: T0 + 10 * MIN,
  });
  const repairs = p.audit.byAction("repair.applied");
  assert.equal(repairs.length, 1);
  assert.match(repairs[0]?.actor ?? "", /^runbook:/);
  assert.ok(repairs[0]?.journalId);
});

test("responding to an alert with nothing to diagnose is an error, not a silent success", () => {
  const p = new Pipeline({ seed: 36, samplingRate: 1 });
  p.submit({ operationId: "op-36", businessRef: "order-36", amountMinor: 1_000, currency: "EUR" }, T0, {});
  assert.throws(() =>
    respond({
      alertId: "ALERT-LEDGER-IMBALANCE",
      world: p.world,
      audit: p.audit,
      budgets: DEFAULT_BUDGETS,
      firedAtMs: T0 + 10 * MIN,
    }),
  );
});
