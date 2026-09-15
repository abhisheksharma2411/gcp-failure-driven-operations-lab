import type { BlastRadius, ChangeType, Gate } from "./types.ts";

/**
 * Gates required by blast radius, independent of change type.
 *
 * This is the whole idea. A global change needs the same scrutiny whether it is
 * Go code, a Terraform plan, an IAM binding, or a WAF rule, because the blast
 * radius is a property of the change's reach and not of the file extension.
 */
const BY_RADIUS: Record<BlastRadius, readonly Gate[]> = {
  "single-instance": ["PROVENANCE", "AUDIT_IDENTITY"],
  "single-region": [
    "PROVENANCE",
    "POLICY_ADMISSION",
    "STAGED_ROLLOUT",
    "REGRESSION_CHECK",
    "REVERSIBLE",
    "AUDIT_IDENTITY",
  ],
  global: [
    "PROVENANCE",
    "POLICY_ADMISSION",
    "COMPATIBILITY",
    "STAGED_ROLLOUT",
    "BUSINESS_VERIFICATION",
    "REGRESSION_CHECK",
    "REVERSIBLE",
    "AUDIT_IDENTITY",
  ],
};

/**
 * Extra gates a change type earns on its own merits, added to the radius set.
 *
 * Deliberately small. The temptation is to encode a rich taxonomy here, and
 * that temptation is exactly what produced the Cloudflare failure: a
 * classification scheme in which one class quietly required less.
 */
const BY_TYPE: Partial<Record<ChangeType, readonly Gate[]>> = {
  schema: ["COMPATIBILITY"], // old and new code run concurrently during any rollout
  iam: ["COMPATIBILITY"], // a removed permission breaks callers you did not list
  "edge-policy": ["COMPATIBILITY"], // a rule that matches more than intended
};

export function requiredGates(type: ChangeType, radius: BlastRadius): Gate[] {
  const set = new Set<Gate>(BY_RADIUS[radius]);
  for (const g of BY_TYPE[type] ?? []) set.add(g);
  return [...set].sort();
}

/**
 * The emergency path.
 *
 * Emergencies are real and a process that pretends otherwise gets bypassed
 * entirely, which is worse. What an emergency may not do is become invisible:
 * provenance and audit identity are never waived, so every emergency change is
 * still attributable afterwards.
 */
export function emergencyGates(): Gate[] {
  return ["AUDIT_IDENTITY", "PROVENANCE"];
}

/** Every change type, for tests that must cover all of them. */
export const ALL_TYPES: readonly ChangeType[] = [
  "application-code",
  "configuration",
  "infrastructure",
  "schema",
  "iam",
  "routing",
  "edge-policy",
];

export const ALL_RADII: readonly BlastRadius[] = ["single-instance", "single-region", "global"];
