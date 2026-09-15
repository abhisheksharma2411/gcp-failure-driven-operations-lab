import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ALL_RADII, ALL_TYPES, emergencyGates, requiredGates } from "../src/manifest.ts";
import { evaluate } from "../src/evaluate.ts";
import type { Change, Gate } from "../src/types.ts";

const change = (over: Partial<Change> = {}): Change => ({
  id: "c1",
  type: "application-code",
  radius: "global",
  satisfied: [],
  promotedBy: "release-pipeline@example",
  ...over,
});

test("T1 no change type is exempt: every type at global radius requires the same core gates", () => {
  // The Cloudflare lesson, encoded. A WAF rule and a Go binary going global get
  // the same scrutiny, because scrutiny follows reach, not file extension.
  const core: Gate[] = [
    "PROVENANCE", "POLICY_ADMISSION", "STAGED_ROLLOUT",
    "BUSINESS_VERIFICATION", "REGRESSION_CHECK", "REVERSIBLE", "AUDIT_IDENTITY",
  ];
  for (const type of ALL_TYPES) {
    const gates = requiredGates(type, "global");
    for (const g of core) {
      assert.ok(gates.includes(g), `${type} at global radius is missing ${g}`);
    }
  }
});

test("T2 an edge-policy change going global requires a staged rollout", () => {
  // Stated separately because it is the exact change that went global in
  // seconds in 2019.
  assert.ok(requiredGates("edge-policy", "global").includes("STAGED_ROLLOUT"));
});

test("T3 requirements increase monotonically with blast radius", () => {
  for (const type of ALL_TYPES) {
    const instance = new Set(requiredGates(type, "single-instance"));
    const region = new Set(requiredGates(type, "single-region"));
    const global = new Set(requiredGates(type, "global"));
    for (const g of instance) assert.ok(region.has(g), `${type}: region lost ${g}`);
    for (const g of region) assert.ok(global.has(g), `${type}: global lost ${g}`);
  }
});

test("T4 schema, IAM and edge-policy changes additionally require a compatibility check", () => {
  for (const type of ["schema", "iam", "edge-policy"] as const) {
    assert.ok(
      requiredGates(type, "single-region").includes("COMPATIBILITY"),
      `${type} should require COMPATIBILITY even at regional radius`,
    );
  }
});

test("T5 a change satisfying every required gate is promoted", () => {
  const c = change({ satisfied: requiredGates("application-code", "global") });
  const r = evaluate(c);
  assert.equal(r.decision, "PROMOTE");
  assert.deepEqual(r.missing, []);
});

test("T6 an unsigned artifact is blocked for missing provenance", () => {
  const gates = requiredGates("application-code", "global").filter((g) => g !== "PROVENANCE");
  const r = evaluate(change({ satisfied: gates }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("PROVENANCE"));
});

test("T7 a failing admission policy blocks promotion", () => {
  const gates = requiredGates("application-code", "global").filter((g) => g !== "POLICY_ADMISSION");
  const r = evaluate(change({ satisfied: gates }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("POLICY_ADMISSION"));
});

test("T8 an incompatible schema change is blocked", () => {
  const gates = requiredGates("schema", "global").filter((g) => g !== "COMPATIBILITY");
  const r = evaluate(change({ type: "schema", satisfied: gates }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("COMPATIBILITY"));
});

test("T9 an irreversible change cannot assert its way past the recovery gate", () => {
  // Claiming reversibility you do not have is the most consequential lie a
  // release system can accept.
  const r = evaluate(change({
    satisfied: requiredGates("application-code", "global"),
    irreversible: true,
  }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("REVERSIBLE"));
  assert.ok(r.reasons.some((x) => x.includes("irreversible")));
});

test("T10 promotion without a recorded identity is blocked", () => {
  const r = evaluate(change({
    satisfied: requiredGates("application-code", "global"),
    promotedBy: "",
  }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("AUDIT_IDENTITY"));
});

test("T11 an audit record exists on the blocked path, not only the promoted one", () => {
  const r = evaluate(change({ satisfied: [] }));
  assert.equal(r.decision, "BLOCK");
  assert.equal(r.audit.changeId, "c1");
  assert.equal(r.audit.decision, "BLOCK");
  assert.ok(r.audit.missingGates.length > 0);
  assert.equal(r.audit.type, "application-code");
});

test("T12 emergency changes take a narrower path but never lose attribution", () => {
  const r = evaluate(change({ emergency: true, satisfied: ["PROVENANCE", "AUDIT_IDENTITY"] }));
  assert.equal(r.decision, "PROMOTE");
  assert.ok(emergencyGates().includes("AUDIT_IDENTITY"));
  assert.ok(emergencyGates().includes("PROVENANCE"));
});

test("T13 an emergency change still cannot be anonymous", () => {
  const r = evaluate(change({ emergency: true, satisfied: ["PROVENANCE"], promotedBy: "" }));
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("AUDIT_IDENTITY"));
});

test("T14 every combination of type and radius yields a non-empty gate set", () => {
  for (const type of ALL_TYPES) {
    for (const radius of ALL_RADII) {
      assert.ok(requiredGates(type, radius).length > 0, `${type}/${radius} had no gates`);
    }
  }
});
