// Negative controls: remove one mechanism, show the property breaks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dropOneLeg, makeDataset } from "../src/ledger.ts";
import { attemptDelete, setRetention, takeBackup } from "../src/protection.ts";
import { restore } from "../src/restore.ts";
import { DAY, GOOD_TOOL, KEY, STALE_TOOL, loadManifest } from "../src/scenarios.ts";

const M = loadManifest();
const src = makeDataset(200);
const HEAD = 200 * 1000;
const CAPTURED = HEAD - 4 * 3_600_000;
const NOW = HEAD + 60_000;

test("N1 without provenance checking, an unusable artifact passes as a restore", () => {
  // A restore path that trusts the job's exit code rather than the metadata.
  const stale = takeBackup("bk", src, { ...STALE_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true });

  // What a "did the job run" check sees:
  assert.equal(stale.state, "INTACT");
  const naiveVerdict = stale.state === "INTACT" ? "backup OK" : "backup failed";
  assert.equal(naiveVerdict, "backup OK", "exit-code thinking calls this a success");

  // What checking the artifact sees:
  const ev = restore(stale, M, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(ev.outcome, "BLOCKED_UNREADABLE_ARTIFACT");
});

test("N2 without retention locking, a hostile identity destroys the evidence", () => {
  const unlocked = takeBackup("u", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: false });
  const locked = takeBackup("l", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true });

  assert.equal(attemptDelete(unlocked, NOW), "DELETED");
  assert.equal(attemptDelete(locked, NOW), "RETENTION_POLICY_NOT_MET");

  // And the consequence for recovery.
  assert.equal(restore(unlocked, M, { sourceHeadMs: HEAD, nowMs: NOW }).outcome, "BLOCKED_NO_ARTIFACT");
  assert.equal(restore(locked, M, { sourceHeadMs: HEAD, nowMs: NOW }).outcome, "RESTORED_AND_VALIDATED");
});

test("N3 without a locked policy, retention can be shortened to nothing first", () => {
  // The subtler attack: do not delete, just make the policy expire.
  const unlocked = takeBackup("u", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: false });
  assert.equal(setRetention(unlocked, 0).applied, true);
  assert.equal(attemptDelete(unlocked, NOW), "DELETED");

  const locked = takeBackup("l", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true });
  assert.equal(setRetention(locked, 0).applied, false);
  assert.equal(attemptDelete(locked, NOW), "RETENTION_POLICY_NOT_MET");
});

test("N4 without invariant validation, a corrupt restore is indistinguishable from a good one", () => {
  const good = restore(
    takeBackup("g", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true }),
    M, { sourceHeadMs: HEAD, nowMs: NOW });
  const bad = restore(
    takeBackup("b", dropOneLeg(src), { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true }),
    M, { sourceHeadMs: HEAD, nowMs: NOW });

  // Identical by every structural measure.
  assert.equal(good.stepsCompleted.length, bad.stepsCompleted.length);
  assert.deepEqual(good.stepsCompleted, bad.stepsCompleted);
  // Distinguished only by the invariants.
  assert.equal(good.outcome, "RESTORED_AND_VALIDATED");
  assert.equal(bad.outcome, "RESTORED_BUT_INVALID");
});

test("N5 without the key as a declared dependency, the failure surfaces late", () => {
  // With the key step present, the restore stops before touching data.
  const withKey = restore(
    takeBackup("k", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true }),
    { ...M, availableKeys: [] }, { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(withKey.outcome, "BLOCKED_MISSING_KEY");
  const early = withKey.stepsCompleted.length;

  // With the key step removed from the manifest, the same missing key is not
  // checked at all and the restore reports success on ciphertext it never read.
  const withoutKeyStep = restore(
    takeBackup("k", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true }),
    {
      ...M,
      availableKeys: [],
      steps: M.steps.filter((s) => s.id !== "key").map((s) => ({ ...s, requires: s.requires.filter((r) => r !== "key") })),
    },
    { sourceHeadMs: HEAD, nowMs: NOW });
  assert.equal(withoutKeyStep.outcome, "RESTORED_AND_VALIDATED");
  assert.ok(withoutKeyStep.stepsCompleted.length > early, "it got further, and learned less");
});

test("N6 cleanup must not delete protected source evidence", () => {
  // The cleanup step deletes what the restore created, never the artifact it
  // restored from. A cleanup that can reach the source is an incident waiting.
  const protectedArtifact = takeBackup("src", src, { ...GOOD_TOOL, keyRef: KEY, atMs: CAPTURED, retentionDays: 30, retentionLocked: true });
  const restoredCopy = takeBackup("copy", src, { ...GOOD_TOOL, keyRef: KEY, atMs: NOW, retentionDays: 1, retentionLocked: false });

  // Cleanup removes the temporary restore target.
  assert.equal(attemptDelete(restoredCopy, NOW + 2 * DAY), "DELETED");
  // The same cleanup, pointed at the protected artifact, is refused.
  assert.equal(attemptDelete(protectedArtifact, NOW + 2 * DAY), "RETENTION_POLICY_NOT_MET");
  assert.equal(protectedArtifact.state, "RETAINED");
  assert.equal(restore(protectedArtifact, M, { sourceHeadMs: HEAD, nowMs: NOW }).outcome, "RESTORED_AND_VALIDATED");
});
