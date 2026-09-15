import { emergencyGates, requiredGates } from "./manifest.ts";
import type { Change, Gate, GateResult } from "./types.ts";

/**
 * Decide whether a change may be promoted.
 *
 * Returns an audit record on both paths. A block that leaves no trace is a
 * block nobody can learn from, and Binary Authorization's own behaviour is the
 * model here: it "blocks deployment and writes a message to Cloud Audit Logs
 * that describes why the image is out of compliance."
 */
export function evaluate(change: Change): GateResult {
  const required = change.emergency
    ? emergencyGates()
    : requiredGates(change.type, change.radius);

  const satisfied = new Set<Gate>(change.satisfied);
  const missing = required.filter((g) => !satisfied.has(g));
  const reasons: string[] = [];

  for (const g of missing) reasons.push(`missing gate: ${g}`);

  // An irreversible change cannot satisfy REVERSIBLE by assertion. Claiming it
  // does is the most consequential lie available in a release system.
  if (change.irreversible && required.includes("REVERSIBLE")) {
    if (!missing.includes("REVERSIBLE")) missing.push("REVERSIBLE");
    reasons.push(
      "change is marked irreversible but its radius requires a proved recovery path",
    );
  }

  const promotedBy = change.promotedBy ?? "";
  if (!promotedBy) {
    if (!missing.includes("AUDIT_IDENTITY")) missing.push("AUDIT_IDENTITY");
    reasons.push("no identity recorded for the promotion request");
  }

  const decision = missing.length === 0 ? "PROMOTE" : "BLOCK";

  return {
    decision,
    required,
    missing,
    reasons,
    audit: {
      changeId: change.id,
      type: change.type,
      radius: change.radius,
      decision,
      promotedBy: promotedBy || "(unrecorded)",
      requiredGates: required,
      missingGates: missing,
    },
  };
}
