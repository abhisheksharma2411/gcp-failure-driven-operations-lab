import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_PHASES, rollout, ungatedRollout, type Baseline, type Observation, type Phase } from "../src/rollout.ts";
import { requiredGates } from "../src/manifest.ts";
import type { Change } from "../src/types.ts";

const BASELINE: Baseline = { errorRate: 0.001, p99Ms: 200 };
const healthy: Observation = { errorRate: 0.001, p99Ms: 200, businessCheckPassed: true };

const ready = (over: Partial<Change> = {}): Change => ({
  id: "r1",
  type: "application-code",
  radius: "global",
  satisfied: requiredGates(over.type ?? "application-code", over.radius ?? "global"),
  promotedBy: "release-pipeline@example",
  ...over,
});

test("T15 a healthy change completes every phase and reaches full traffic", () => {
  const r = rollout(ready(), BASELINE, () => healthy);
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(r.reachedPhase, "stable");
  assert.equal(r.maxExposure, 100);
  assert.equal(r.rolledBack, false);
});

test("T16 an error-rate regression halts at the first canary phase", () => {
  const r = rollout(ready(), BASELINE, (p: Phase) =>
    p.name === "canary-25" ? { ...healthy, errorRate: 0.05 } : healthy);
  assert.equal(r.outcome, "HALTED");
  assert.equal(r.reachedPhase, "canary-25");
  assert.equal(r.maxExposure, 25, "more than a quarter of traffic was exposed");
  assert.equal(r.rolledBack, true);
});

test("T17 a latency regression halts promotion", () => {
  const r = rollout(ready(), BASELINE, (p: Phase) =>
    p.name === "canary-50" ? { ...healthy, p99Ms: 900 } : healthy);
  assert.equal(r.outcome, "HALTED");
  assert.equal(r.reachedPhase, "canary-50");
  assert.ok(r.reasons.some((x) => x.includes("p99 regressed")));
});

test("T18 a functional regression that health checks would miss halts promotion", () => {
  // The distinction the article insists on: the service is up, responding
  // quickly, and returning the wrong answer.
  const r = rollout(ready(), BASELINE, (p: Phase) =>
    p.name === "canary-25" ? { errorRate: 0.001, p99Ms: 195, businessCheckPassed: false } : healthy);
  assert.equal(r.outcome, "HALTED");
  assert.equal(r.maxExposure, 25);
  assert.ok(r.reasons.some((x) => x.includes("business verification failed")));
});

test("T19 a change that fails its gates never reaches any traffic at all", () => {
  const r = rollout(ready({ satisfied: [] }), BASELINE, () => healthy);
  assert.equal(r.outcome, "BLOCKED_AT_GATE");
  assert.equal(r.maxExposure, 0);
  assert.equal(r.reachedPhase, null);
});

test("T20 staging bounds exposure: the worst case is one phase, not the fleet", () => {
  // The number the article is actually about.
  const staged = rollout(ready(), BASELINE, (p: Phase) =>
    p.name === "canary-25" ? { ...healthy, errorRate: 1 } : healthy);
  const unstaged = rollout(ready(), BASELINE, () => ({ ...healthy, errorRate: 1 }),
    [{ name: "stable", percent: 100 }]);

  assert.equal(staged.maxExposure, 25);
  assert.equal(unstaged.maxExposure, 100);
  assert.ok(staged.maxExposure < unstaged.maxExposure);
});

test("T21 the default phase ladder matches the documented canary example", () => {
  assert.deepEqual(DEFAULT_PHASES.map((p) => p.name), ["canary-25", "canary-50", "canary-75", "stable"]);
});

test("T22 a halted rollout reports that it rolled back", () => {
  const r = rollout(ready(), BASELINE, () => ({ ...healthy, businessCheckPassed: false }));
  assert.equal(r.rolledBack, true);
});

test("T23 with no gate at all, a regression is found only after full exposure", () => {
  // Modelling the absence of a gate, not a failed one. Running an ungated
  // change through the gated path gets it blocked, which is the manifest
  // working rather than the failure being reproduced.
  const r = ungatedRollout(BASELINE, () => ({ ...healthy, errorRate: 1 }));
  assert.equal(r.maxExposure, 100);
  assert.equal(r.reachedPhase, "stable");
  assert.equal(r.rolledBack, true);
  assert.ok(r.reasons.some((x) => x.includes("already exposed")));
});
