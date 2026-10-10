// Walk one incident end to end, printing what a responder would see.
//
//   node scripts/incident.ts
//   node scripts/incident.ts --healthy     run the same flow with no fault
//   node scripts/incident.ts --help
//
// No cloud project, no credentials, no network.

import { Pipeline } from "../src/domain/flow.ts";
import { checkInvariants, publishInvariantGauges, publishOperationalGauges } from "../src/invariants.ts";
import { evaluateAlerts } from "../src/alerts.ts";
import { evaluateTechnicalSlos, allTechnicalSlosGreen } from "../src/slo.ts";
import { respond } from "../src/incident.ts";
import { DEFAULT_BUDGETS } from "../src/domain/types.ts";
import { T0 } from "../src/scenarios.ts";

if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/incident.ts [--healthy]

Runs one payment through the instrumented flow, evaluates the technical
objectives and the business invariants side by side, and — when an invariant is
violated — walks the alert, the diagnosis, the repair and the verification.

  --healthy   inject no fault; everything should stay green and silent
`);
  process.exit(0);
}

const healthy = process.argv.includes("--healthy");
const pipeline = new Pipeline({ seed: 4242, samplingRate: 1 });
pipeline.submit(
  { operationId: "op-4242", businessRef: "order-4242", amountMinor: 50_000, currency: "EUR" },
  T0,
  healthy ? {} : { dropFeeLeg: true },
);

const at = T0 + 10 * 60_000;
pipeline.recordCheckerRun("invariants", at);
pipeline.recordCheckerRun("canary", at);
pipeline.recordCheckerRun("reconciliation", at);

const violations = checkInvariants(pipeline.world, at, DEFAULT_BUDGETS);
publishOperationalGauges(pipeline.metrics, pipeline.world, at);
publishInvariantGauges(pipeline.metrics, violations);

const technical = evaluateTechnicalSlos(pipeline.metrics);

console.log(`\n== technical objectives ${allTechnicalSlosGreen(pipeline.metrics) ? "(all green)" : "(breached)"}`);
for (const t of technical) {
  const value = t.id === "SLO-C2" ? `${t.value} ms` : `${((t.value ?? 0) * 100).toFixed(2)}%`;
  console.log(`  ${t.id}  ${value.padStart(10)}  ${t.met ? "met" : "BREACHED"}`);
}

console.log(`\n== business invariants (${violations.length} violation(s))`);
for (const v of violations) {
  console.log(`  ${v.invariant}  ${v.detail}`);
}
if (violations.length === 0) console.log("  none");

const fired = evaluateAlerts({
  nowMs: at,
  metrics: pipeline.metrics,
  world: pipeline.world,
  budgets: DEFAULT_BUDGETS,
  violations,
  technical,
  canaryPassed: true,
  cardinalityRejections: 0,
});
console.log(`\n== alerts: ${fired.join(", ") || "none"}`);

if (fired.includes("ALERT-LEDGER-IMBALANCE")) {
  const evidence = respond({
    alertId: "ALERT-LEDGER-IMBALANCE",
    world: pipeline.world,
    audit: pipeline.audit,
    budgets: DEFAULT_BUDGETS,
    firedAtMs: at,
  });
  console.log(`\n== runbook ${evidence.runbook}`);
  console.log(`  operation ${evidence.diagnosis.operationId}, journal ${evidence.diagnosis.journalId}`);
  console.log(`  ${evidence.diagnosis.amountMinor} minor units implicated`);
  console.log(`  log query: ${evidence.diagnosis.logQuery}`);
  console.log("\n  audit timeline:");
  for (const line of evidence.diagnosis.auditTimeline) console.log(`    ${line}`);
  console.log(`\n  repair: ${evidence.repair.command}`);
  console.log(`  invoked ${evidence.repair.timesInvoked} times; idempotent: ${evidence.repair.idempotent}`);
  console.log(`  violations ${evidence.violationsBefore} -> ${evidence.violationsAfter}; ${evidence.outcome}\n`);
}
