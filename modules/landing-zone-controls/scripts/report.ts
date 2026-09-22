// Runs every experiment and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Every number below comes from
// the model in ../src, and re-running produces byte-identical output.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN,
  DAY_MS,
  DRY_RUN_PERIMETER,
  P_APP_PROD,
  P_SANDBOX,
  P_SENSITIVE,
  SRE,
  T0,
  flatZone,
  humanCredential,
  landingZoneSuite,
  lockedZone,
  pavedZone,
  pavedZoneMissing,
} from "../src/scenarios.ts";
import { runSuite, type SuiteResult } from "../src/suite.ts";
import { auditWeaknesses } from "../src/audit.ts";
import { describeEffectivePolicy } from "../src/policy.ts";
import { HOUR_MS } from "../src/identity.ts";
import type { LandingZone } from "../src/evaluate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

const iso = (ms: number): string => new Date(ms).toISOString();

// --- E1..E3: the three zones ------------------------------------------------

const ZONES: readonly (readonly [string, LandingZone, string])[] = [
  ["FLAT", flatZone(), "no folders, no constraints, editor for everyone"],
  ["LOCKED", lockedZone(), "every guardrail on, no supported route through"],
  ["PAVED", pavedZone(), "the same guardrails plus a paved road"],
];

const suiteResults: Record<string, SuiteResult> = {};
for (const [name, zone] of ZONES) suiteResults[name] = runSuite(zone, landingZoneSuite(T0), T0);

// --- E4: the exception lifecycle -------------------------------------------

const exceptionTimeline = [0, 15, 29, 30, 31, 60].map((days) => {
  const at = T0 + days * DAY_MS;
  const zone = pavedZone();
  const described = describeEffectivePolicy(zone.hierarchy, P_SANDBOX, at).find(
    (d) => d.constraint === "publicExposure",
  )!;
  const attempt = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, at),
      operation: "storage.createBucket",
      targetProject: P_SANDBOX,
      config: {
        service: "storage.googleapis.com",
        region: "europe-west1",
        publiclyAccessible: true,
      },
    },
    at,
  );
  return {
    dayOffset: days,
    at: iso(at),
    governedBy: described.sourceNodeId ?? "(unconstrained)",
    viaException: described.isException,
    publicBucketAllowed: attempt.allowed,
  };
});

// --- E5: the elevated-access lifecycle -------------------------------------

const breakGlassTimeline = [0, 1, 4, 7, 8, 9, 24].map((hours) => {
  const at = T0 + hours * HOUR_MS;
  const zone = pavedZone();
  const d = zone.evaluate(
    {
      principal: SRE,
      credential: humanCredential(SRE, at),
      operation: "run.deploy",
      targetProject: P_APP_PROD,
      config: { service: "run.googleapis.com", region: "europe-west1" },
    },
    at,
  );
  return { hourOffset: hours, at: iso(at), elevatedActionAllowed: d.allowed, reason: d.reason ?? null };
});

// --- E6: audit independence -------------------------------------------------

const auditFindings = ZONES.map(([name, zone]) => ({
  zone: name,
  sensitiveProject: P_SENSITIVE,
  weaknesses: auditWeaknesses(zone.hierarchy, zone.sinks, P_SENSITIVE, T0),
}));

// --- E7: enforced versus dry-run perimeter ----------------------------------

const perimeterModes = (["enforced", "dry-run"] as const).map((mode) => {
  const zone = mode === "enforced" ? pavedZone() : pavedZone(DRY_RUN_PERIMETER);
  const d = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "bigquery.export",
      targetProject: P_SENSITIVE,
      egressToProject: "projects/partner-analytics",
      config: { service: "bigquery.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  return {
    mode,
    egressAllowed: d.allowed,
    recordedViolation: d.dryRunViolation ?? null,
    guardrailsPassed: runSuite(zone, landingZoneSuite(T0), T0).guardrailsPassed,
  };
});

// --- E8: negative controls --------------------------------------------------

const MUTATIONS = [
  "publicExposure",
  "allowedRegions",
  "serviceAccountKeyCreation",
  "perimeter",
  "shortLivedCredentials",
] as const;

const negativeControls = MUTATIONS.map((m) => {
  const r = runSuite(pavedZoneMissing(m), landingZoneSuite(T0), T0);
  return {
    removed: m,
    guardrailsPassed: r.guardrailsPassed,
    guardrailsTotal: r.guardrails.length,
    detected: r.guardrailsPassed < r.guardrails.length,
    firstLeak: r.guardrails.find((g) => !g.passed)?.name ?? null,
  };
});

// --- write ------------------------------------------------------------------

const payload = {
  generatedFrom: "scripts/report.ts",
  evaluatedAt: iso(T0),
  note: "Deterministic. No cloud project, no credentials, no network.",
  zones: ZONES.map(([name, , description]) => ({ name, description })),
  suiteResults,
  exceptionTimeline,
  breakGlassTimeline,
  auditFindings,
  perimeterModes,
  negativeControls,
};
writeFileSync(join(RESULTS, "landing-zone-controls.json"), JSON.stringify(payload, null, 2) + "\n");

const yn = (b: boolean): string => (b ? "yes" : "no");
const lines: string[] = [];
lines.push("# landing-zone-controls results");
lines.push("");
lines.push(`Generated by \`scripts/report.ts\`. Evaluated at \`${iso(T0)}\`.`);
lines.push("Deterministic: no cloud project, no credentials, no network.");
lines.push("");
lines.push("## The suite, run against three landing zones");
lines.push("");
lines.push("| zone | guardrails held | golden path usable | developer permissions | steps blocked | viable escapes |");
lines.push("|---|---|---|---|---|---|");
for (const [name] of ZONES) {
  const r = suiteResults[name]!;
  const p = r.goldenPaths[0]!;
  lines.push(
    `| ${name} | ${r.guardrailsPassed}/${r.guardrails.length} | ${p.passed ? "yes" : "no"} | ` +
      `${p.permissionsHeld} | ${p.blockedSteps.length}/${p.stepCount} | ${p.viableEscapes.length} |`,
  );
}
lines.push("");
lines.push("Only PAVED passes. FLAT holds no guardrail; LOCKED holds every one of");
lines.push("them and is unusable, which is how the work ends up somewhere else.");
lines.push("");
for (const [name] of ZONES) {
  const p = suiteResults[name]!.goldenPaths[0]!;
  if (p.failures.length === 0) continue;
  lines.push(`**${name} golden-path failures**`);
  lines.push("");
  for (const f of p.failures) lines.push(`- ${f}`);
  lines.push("");
}
lines.push("## The exception lifecycle");
lines.push("");
lines.push("| day | governed by | via exception | public bucket permitted |");
lines.push("|---|---|---|---|");
for (const r of exceptionTimeline) {
  lines.push(`| +${r.dayOffset} | \`${r.governedBy}\` | ${yn(r.viaException)} | ${yn(r.publicBucketAllowed)} |`);
}
lines.push("");
lines.push("Nothing is edited between day 29 and day 31. The exception simply ends,");
lines.push("and the organization's policy governs again.");
lines.push("");
lines.push("## The elevated-access lifecycle");
lines.push("");
lines.push("| hour | elevated action permitted |");
lines.push("|---|---|");
for (const r of breakGlassTimeline) lines.push(`| +${r.hourOffset} | ${yn(r.elevatedActionAllowed)} |`);
lines.push("");
lines.push("## Audit independence");
lines.push("");
lines.push("| zone | weaknesses over the sensitive project |");
lines.push("|---|---|");
for (const f of auditFindings) {
  const summary = f.weaknesses.length === 0 ? "none" : f.weaknesses.map((w) => w.kind).join(", ");
  lines.push(`| ${f.zone} | ${summary} |`);
}
lines.push("");
lines.push("LOCKED holds every guardrail in the suite and still keeps its audit");
lines.push("records where its administrators can reach them. No guardrail case");
lines.push("covers that, which is the argument for deriving the property rather");
lines.push("than trusting a checklist.");
lines.push("");
lines.push("## Perimeter mode");
lines.push("");
lines.push("| mode | egress permitted | violation recorded | guardrails held |");
lines.push("|---|---|---|---|");
for (const r of perimeterModes) {
  lines.push(
    `| ${r.mode} | ${yn(r.egressAllowed)} | ${r.recordedViolation === null ? "--" : "yes"} | ` +
      `${r.guardrailsPassed}/6 |`,
  );
}
lines.push("");
lines.push("Dry run observes without preventing. It is a way to learn what a");
lines.push("perimeter would block, and it is not the control.");
lines.push("");
lines.push("## Negative controls");
lines.push("");
lines.push("| control removed | guardrails still held | leak detected | first case to fail |");
lines.push("|---|---|---|---|");
for (const n of negativeControls) {
  lines.push(
    `| ${n.removed} | ${n.guardrailsPassed}/${n.guardrailsTotal} | ${yn(n.detected)} | ${n.firstLeak ?? "--"} |`,
  );
}
lines.push("");
lines.push("Every control, removed on its own, turns a case red. A suite that stayed");
lines.push("green here would be measuring nothing.");
lines.push("");
writeFileSync(join(RESULTS, "report.md"), lines.join("\n"));

console.log("wrote results/landing-zone-controls.json and results/report.md");
