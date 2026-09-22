import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dropOneLeg, makeDataset, validate } from "../src/ledger.ts";
import { attemptDelete, takeBackup } from "../src/protection.ts";
import { orderSteps, restore } from "../src/restore.ts";
import { GOOD_TOOL, KEY, STALE_TOOL, loadManifest } from "../src/scenarios.ts";

const M = loadManifest();
const src = makeDataset(200);
const HEAD = 200 * 1000;
const CAPTURED = HEAD - 4 * 3_600_000;
const NOW = HEAD + 60_000;

const backup = (d = src, tool = GOOD_TOOL, keyRef: string | null = KEY) =>
  takeBackup("bk", d, { ...tool, keyRef, atMs: CAPTURED, retentionDays: 30, retentionLocked: true });

test("T9 the shipped manifest orders every step and contains no cycle", () => {
  const { order, cycle } = orderSteps(M);
  assert.deepEqual(cycle, []);
  assert.equal(order.length, M.steps.length);
  // Data cannot precede the key, the storage, or the schema.
  for (const dep of ["key", "storage", "schema"]) {
    assert.ok(order.indexOf(dep) < order.indexOf("data"), `${dep} must precede data`);
  }
  assert.ok(order.indexOf("data") < order.indexOf("validate"));
});

test("T10 a healthy restore completes every step and passes every invariant", () => {
  const ev = restore(backup(), M, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "RESTORED_AND_VALIDATED");
  assert.equal(ev.stepsCompleted.length, M.steps.length);
  assert.ok(ev.invariants.every((i) => i.passed));
});

test("T11 a successful-but-unusable backup is refused, naming the mismatch", () => {
  const ev = restore(backup(src, STALE_TOOL), M, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_UNREADABLE_ARTIFACT");
  assert.ok(ev.reasons.some((r) => r.includes("The job completed; the output is unusable")));
  assert.ok(ev.reasons.some((r) => r.includes("tool version 1")));
});

test("T12 a missing key blocks recovery visibly and early", () => {
  const ev = restore(backup(), { ...M, availableKeys: [] }, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_MISSING_KEY");
  assert.ok(ev.reasons.some((r) => r.includes("ciphertext")));
  // Fails before loading anything, not halfway through.
  assert.ok(ev.stepsCompleted.length < 3, `stopped after ${ev.stepsCompleted.length} steps`);
});

test("T13 an undeclared dependency blocks the restore rather than being skipped", () => {
  const ev = restore(backup(), {
    ...M,
    steps: [...M.steps, { id: "app", description: "", requires: ["vault-that-does-not-exist"] }],
  }, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_MISSING_DEPENDENCY");
  assert.ok(ev.reasons.some((r) => r.includes("does not declare")));
});

test("T14 a manifest cycle is refused rather than hanging", () => {
  const ev = restore(backup(), {
    ...M,
    steps: [
      { id: "a", description: "", requires: ["b"] },
      { id: "b", description: "", requires: ["a"] },
    ],
  }, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_MISSING_DEPENDENCY");
  assert.ok(ev.reasons.some((r) => r.includes("cycle")));
});

test("T15 validation catches a corruption that step completion does not", () => {
  // Every step runs. The restore "works". The ledger is wrong.
  const ev = restore(backup(dropOneLeg(src)), M, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "RESTORED_BUT_INVALID");
  assert.equal(ev.stepsCompleted.length, M.steps.length, "all steps completed");
  assert.ok(ev.invariants.filter((i) => !i.passed).length >= 2);
  assert.ok(ev.reasons.some((r) => r.includes("double-entry balances to zero")));
});

test("T16 a deleted artifact blocks recovery and says so", () => {
  const a = takeBackup("bk", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 1, retentionLocked: false });
  attemptDelete(a, CAPTURED + 1000);
  const ev = restore(a, M, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_NO_ARTIFACT");
});

test("T17 RTO and RPO are measured, not asserted", () => {
  const ev = restore(backup(), M, { sourceHeadMs: HEAD, nowMs: NOW, stepCostMs: 30_000 });
  // Seven steps at thirty seconds each.
  assert.equal(ev.rtoMs, 7 * 30_000);
  // Four hours between capture and source head.
  assert.equal(ev.rpoMs, 4 * 3_600_000);
});

test("T18 evidence is produced on every path, including refusals", () => {
  const paths = [
    restore(backup(), M, { sourceHeadMs: HEAD, nowMs: NOW }),
    restore(backup(src, STALE_TOOL), M, { sourceHeadMs: HEAD, nowMs: NOW }),
    restore(backup(), { ...M, availableKeys: [] }, { sourceHeadMs: HEAD, nowMs: NOW }),
    restore(null, M, { sourceHeadMs: HEAD, nowMs: NOW }),
  ];
  for (const ev of paths) {
    assert.equal(ev.recordedAtMs, NOW);
    assert.ok(ev.reasons.length > 0, `no reason recorded for ${ev.outcome}`);
    assert.ok(typeof ev.rtoMs === "number");
  }
});

test("T19 the validation contract is about business rules, not row counts", () => {
  const corrupt = dropOneLeg(src);
  // A row count would notice one fewer row, and nothing about correctness.
  assert.equal(corrupt.postings.length, src.postings.length - 1);
  const failed = validate(corrupt).filter((i) => !i.passed).map((i) => i.name);
  assert.ok(failed.includes("double-entry balances to zero"));
  assert.ok(failed.includes("every transaction balances individually"));
});
