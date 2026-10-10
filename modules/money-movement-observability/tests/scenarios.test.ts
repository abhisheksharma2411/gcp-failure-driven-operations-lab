import test from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS, runCatalogue, runScenario, MUTATIONS, BLUNT_MUTATION } from "../src/scenarios.ts";
import { ALERTS, alertById, paging } from "../src/alerts.ts";
import { INVARIANTS } from "../src/invariants.ts";
import { DASHBOARDS, metricsOnNoDashboard } from "../src/dashboard.ts";
import { summariseVolume } from "../src/cost.ts";

test("every scenario in the catalogue meets its expectations", () => {
  for (const result of runCatalogue()) {
    assert.equal(result.passed, true, `${result.id}: ${result.failures.join("; ")}`);
  }
});

test("the catalogue covers every required exercise exactly once", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  const covers = SCENARIOS.map((s) => s.covers);
  assert.equal(new Set(covers).size, covers.length);
  const required = SCENARIOS.filter((s) => !s.covers.startsWith("alert coverage:"));
  assert.equal(required.length, 10, "ten required exercises, one scenario each");
  assert.equal(SCENARIOS.length, 18);
});

test("at least three scenarios are green on every technical objective and wrong about money", () => {
  const results = runCatalogue();
  const greenAndWrong = results.filter((r) => r.technicalGreen && r.invariantsViolated.length > 0);
  assert.ok(greenAndWrong.length >= 3, `only ${greenAndWrong.length} scenarios are green and wrong`);
  assert.ok(greenAndWrong.some((r) => r.id === "S04"), "the headline scenario must be one of them");
});

test("the headline scenario emits no HTTP errors at all", () => {
  const s04 = runCatalogue().find((r) => r.id === "S04");
  assert.ok(s04);
  assert.equal(s04.extra.httpErrors, 0);
  assert.equal(s04.technicalGreen, true);
  assert.deepEqual(s04.invariantsViolated, ["INV-1"]);
});

test("the duplicate-delivery scenario fires nothing: alerts do not cry wolf", () => {
  const s02 = runCatalogue().find((r) => r.id === "S02");
  assert.ok(s02);
  assert.deepEqual(s02.alertsFired, []);
  assert.deepEqual(s02.invariantsViolated, []);
});

test("sampling drops the trace and the audit record survives it", () => {
  const s07 = runCatalogue().find((r) => r.id === "S07");
  assert.ok(s07);
  assert.equal(s07.extra.exportedSpans, 0);
  assert.ok((s07.extra.auditRecords as number) > 0);
  assert.equal(s07.extra.timelineReconstructed, true);
});

test("a missing telemetry pipeline reads as green, and only the staleness alert says otherwise", () => {
  const s06 = runCatalogue().find((r) => r.id === "S06");
  assert.ok(s06);
  assert.equal(s06.technicalGreen, true, "no data must read as green; that is the point of the scenario");
  assert.equal(s06.extra.seriesWritten, 0);
  assert.deepEqual(s06.alertsFired, ["ALERT-CHECKER-STALE"]);
});

test("the repair is idempotent and the invariant returns to healthy", () => {
  const s10 = runCatalogue().find((r) => r.id === "S10");
  assert.ok(s10);
  assert.equal(s10.extra.violationsBefore, 1);
  assert.equal(s10.extra.violationsAfter, 0);
  assert.equal(s10.extra.repairIdempotent, true);
  assert.equal(s10.extra.outcome, "resolved");
});

// --- negative controls ------------------------------------------------------

test("N1 each mutation turns specific, named scenarios red", () => {
  const expected: Record<string, string[]> = {
    "no-invariant-checker": ["S01", "S03", "S04", "S05", "S13", "S14", "S15", "S16", "S17"],
    "no-state-age-check": ["S01", "S03", "S17"],
    "no-redaction": ["S08"],
    "no-cardinality-guard": ["S09"],
    "no-audit-trail": ["S07"],
  };
  for (const mutation of MUTATIONS) {
    const red = runCatalogue(mutation)
      .filter((r) => !r.passed)
      .map((r) => r.id);
    assert.deepEqual(red, expected[mutation], `${mutation} reddened ${red.join(", ")}`);
  }
});

test("N2 no targeted mutation reddens the whole catalogue", () => {
  for (const mutation of MUTATIONS) {
    const red = runCatalogue(mutation).filter((r) => !r.passed);
    assert.ok(red.length > 0, `${mutation} was not detected at all`);
    assert.ok(red.length <= SCENARIOS.length / 2, `${mutation} is too blunt to prove anything`);
  }
});

test("N3 the blunt mutation is rejected because it proves nothing", () => {
  const red = runCatalogue(BLUNT_MUTATION).filter((r) => !r.passed);
  assert.ok(
    red.length > SCENARIOS.length / 2,
    "a mutation that disables everything should redden most of the catalogue",
  );
});

test("N4 the harness fails a scenario whose expectation is wrong", () => {
  const real = SCENARIOS.find((s) => s.id === "S04");
  assert.ok(real);
  const sabotaged = {
    ...real,
    expect: { ...real.expect, invariants: ["INV-7"] },
  };
  const result = runScenario(sabotaged);
  assert.equal(result.passed, false, "a wrong expectation must fail, or every test passes vacuously");
});

test("N5 the catalogue is deterministic across runs", () => {
  assert.equal(JSON.stringify(runCatalogue()), JSON.stringify(runCatalogue()));
});

test("N6 every alert is fired by at least one scenario", () => {
  const fired = new Set(runCatalogue().flatMap((r) => r.alertsFired));
  const never = ALERTS.filter((a) => !fired.has(a.id)).map((a) => a.id);
  assert.deepEqual(never, [], "an alert nobody has seen fire is a belief, not a control");
});

test("N7 every scenario that violates an invariant fires at least one alert", () => {
  for (const r of runCatalogue()) {
    if (r.invariantsViolated.length > 0) {
      assert.ok(r.alertsFired.length > 0, `${r.id} violates ${r.invariantsViolated} and pages nobody`);
    }
  }
});

// --- catalogue hygiene ------------------------------------------------------

test("every alert has a runbook, a route and a question it asks", () => {
  for (const alert of ALERTS) {
    assert.ok(alert.runbook.startsWith("RB-"), `${alert.id} has no runbook`);
    assert.ok(alert.asks.endsWith("?"), `${alert.id} does not say what it is asking`);
    assert.equal(alertById(alert.id), alert);
  }
});

test("every invariant's runbook is referenced by an alert", () => {
  const runbooks = new Set(ALERTS.map((a) => a.runbook));
  for (const invariant of INVARIANTS) {
    assert.ok(runbooks.has(invariant.runbook), `${invariant.id} names ${invariant.runbook}, which no alert routes to`);
  }
});

test("only invariants and genuine outages page; the rest open tickets", () => {
  const pagingAlerts = paging(ALERTS.map((a) => a.id));
  assert.ok(pagingAlerts.length < ALERTS.length, "not everything can be a page");
  assert.ok(pagingAlerts.includes("ALERT-LEDGER-IMBALANCE"));
  assert.ok(!pagingAlerts.includes("ALERT-SETTLEMENT-LATE"), "a 48-hour problem is not a 3 a.m. problem");
});

test("every metric appears on a dashboard", () => {
  assert.deepEqual(metricsOnNoDashboard(), []);
  assert.equal(DASHBOARDS.length, 2);
});

test("the telemetry volume model separates what sampling can and cannot reduce", () => {
  const summary = summariseVolume();
  assert.ok(summary.sampleableGibPerDay > 0);
  assert.ok(summary.fixedGibPerDay > 0);
  const audit = summary.lines.find((l) => l.signal === "audit records");
  assert.ok(audit);
  assert.equal(audit.sampleable, false);
});
