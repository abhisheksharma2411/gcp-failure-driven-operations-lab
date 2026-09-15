// Negative controls: remove one mechanism, show the property breaks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requiredGates } from "../src/manifest.ts";
import { evaluate } from "../src/evaluate.ts";
import { rollout, type Baseline, type Observation, type Phase } from "../src/rollout.ts";
import type { Change, Gate } from "../src/types.ts";

const BASELINE: Baseline = { errorRate: 0.001, p99Ms: 200 };
const healthy: Observation = { errorRate: 0.001, p99Ms: 200, businessCheckPassed: true };

test("N1 without radius-derived gates, an edge-policy change reaches the fleet ungated", () => {
  // This reproduces the 2019 shape: a rule classified as configuration, going
  // global, with the scrutiny a config change used to get.
  const legacyManifest = (): Gate[] => ["AUDIT_IDENTITY"]; // "it's only config"
  const change: Change = {
    id: "waf-rule",
    type: "edge-policy",
    radius: "global",
    satisfied: ["AUDIT_IDENTITY"],
    promotedBy: "engineer@example",
  };

  // Under the legacy view, it promotes with no staging at all.
  const legacyMissing = legacyManifest().filter((g) => !change.satisfied.includes(g));
  assert.equal(legacyMissing.length, 0, "legacy classification should wave it through");

  // Under the manifest, it is blocked, and specifically for the gate that
  // would have bounded the damage.
  const r = evaluate(change);
  assert.equal(r.decision, "BLOCK");
  assert.ok(r.missing.includes("STAGED_ROLLOUT"));
  assert.ok(r.missing.includes("BUSINESS_VERIFICATION"));
});

test("N2 without staged rollout, a bad change exposes the entire fleet", () => {
  const change: Change = {
    id: "c", type: "application-code", radius: "global",
    satisfied: requiredGates("application-code", "global"),
    promotedBy: "pipeline@example",
  };
  const broken = (): Observation => ({ ...healthy, errorRate: 1 });

  const staged = rollout(change, BASELINE, broken);
  const straightToStable = rollout(change, BASELINE, broken, [{ name: "stable", percent: 100 }]);

  assert.equal(staged.maxExposure, 25);
  assert.equal(straightToStable.maxExposure, 100);
});

test("N3 without business verification, a functionally broken change promotes fully", () => {
  const change: Change = {
    id: "c", type: "application-code", radius: "global",
    satisfied: requiredGates("application-code", "global"),
    promotedBy: "pipeline@example",
  };
  // Healthy by every technical signal, wrong by the business one.
  const technicallyFine: Observation = { errorRate: 0.001, p99Ms: 190, businessCheckPassed: false };

  const withCheck = rollout(change, BASELINE, () => technicallyFine);
  // Simulate not having the check by reporting it as passing.
  const withoutCheck = rollout(change, BASELINE, () => ({ ...technicallyFine, businessCheckPassed: true }));

  assert.equal(withCheck.outcome, "HALTED");
  assert.equal(withCheck.maxExposure, 25);
  assert.equal(withoutCheck.outcome, "COMPLETED");
  assert.equal(withoutCheck.maxExposure, 100);
});

test("N4 without the irreversibility check, a destructive change claims a recovery path it lacks", () => {
  const base: Change = {
    id: "migration", type: "schema", radius: "global",
    satisfied: requiredGates("schema", "global"),
    promotedBy: "pipeline@example",
  };
  assert.equal(evaluate({ ...base, irreversible: false }).decision, "PROMOTE");
  assert.equal(evaluate({ ...base, irreversible: true }).decision, "BLOCK");
});

test("N5 without an identity requirement, promotions become unattributable", () => {
  const base: Change = {
    id: "c", type: "configuration", radius: "single-region",
    satisfied: requiredGates("configuration", "single-region"),
    promotedBy: "",
  };
  const r = evaluate(base);
  assert.equal(r.decision, "BLOCK");
  assert.equal(r.audit.promotedBy, "(unrecorded)");
  assert.ok(r.reasons.some((x) => x.includes("no identity recorded")));
});
