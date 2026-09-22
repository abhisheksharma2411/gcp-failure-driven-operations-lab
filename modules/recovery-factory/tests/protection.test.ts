import { strict as assert } from "node:assert";
import { test } from "node:test";
import { attemptDelete, setRetention, takeBackup } from "../src/protection.ts";
import { makeDataset } from "../src/ledger.ts";
import { DAY, GOOD_TOOL, KEY, STALE_TOOL } from "../src/scenarios.ts";

const src = makeDataset(50);
const mk = (locked: boolean, days = 30) =>
  takeBackup("bk", src, { ...GOOD_TOOL, keyRef: KEY, atMs: 0, retentionDays: days, retentionLocked: locked });

test("T1 a backup taken by a capable tool carries a usable payload", () => {
  const a = mk(true);
  assert.notEqual(a.payload, null);
  assert.equal(a.provenance.sourceSchemaVersion, src.schemaVersion);
});

test("T2 a backup taken by a stale tool succeeds and carries nothing usable", () => {
  // The 2017 shape: pg_dump 9.2 against a 9.6 database. The job ran.
  const a = takeBackup("bk-stale", src, {
    ...STALE_TOOL, keyRef: KEY, atMs: 0, retentionDays: 30, retentionLocked: true,
  });
  assert.equal(a.state, "INTACT", "the artifact exists");
  assert.equal(a.payload, null, "and is unusable");
  assert.equal(a.provenance.toolVersion, 1);
});

test("T3 provenance records the tool and schema, so a restore can refuse it", () => {
  const a = takeBackup("bk", src, { ...STALE_TOOL, keyRef: KEY, atMs: 0, retentionDays: 30, retentionLocked: true });
  assert.equal(a.provenance.toolVersion, 1);
  assert.equal(a.provenance.sourceSchemaVersion, 2);
  // The mismatch is visible in the metadata rather than only in the outcome.
  assert.ok(!STALE_TOOL.toolReadableSchemas.includes(a.provenance.sourceSchemaVersion));
});

test("T4 an unlocked artifact can be deleted by whoever holds the credentials", () => {
  const a = mk(false);
  assert.equal(attemptDelete(a, 1000), "DELETED");
  assert.equal(a.state, "DELETED");
});

test("T5 a locked artifact refuses deletion inside its retention period", () => {
  const a = mk(true);
  assert.equal(attemptDelete(a, 10 * DAY), "RETENTION_POLICY_NOT_MET");
  assert.equal(a.state, "RETAINED");
});

test("T6 no amount of privilege shortens a locked retention policy", () => {
  const a = mk(true);
  const r = setRetention(a, 1000);
  assert.equal(r.applied, false);
  assert.ok(r.reason.includes("cannot be reduced"));
  assert.equal(a.retainedUntilMs, 30 * DAY);
});

test("T7 protection is a ratchet: extending retention is always allowed", () => {
  const a = mk(true);
  const r = setRetention(a, 90 * DAY);
  assert.equal(r.applied, true);
  assert.equal(a.retainedUntilMs, 90 * DAY);
});

test("T8 a locked artifact becomes deletable only after retention expires", () => {
  const a = mk(true);
  assert.equal(attemptDelete(a, 10 * DAY), "RETENTION_POLICY_NOT_MET");
  assert.equal(attemptDelete(a, 31 * DAY), "DELETED");
});
