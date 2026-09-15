// A machine-readable release-risk manifest.
//
// The premise comes from Cloudflare's own remediation after their 2019 outage:
// "Changing the SOP to do staged rollouts of rules in the same manner used for
// other software." A WAF rule reached the whole fleet in seconds because it was
// classified as configuration, and configuration did not go through the staging
// that code did.
//
// The fix modelled here is to stop letting the CLASS of change decide how much
// scrutiny it gets. Gates are derived from (change type, blast radius), and no
// type is exempt.

/** Everything that can reach production is one of these. */
export type ChangeType =
  | "application-code"
  | "configuration"
  | "infrastructure"
  | "schema"
  | "iam"
  | "routing"
  | "edge-policy";

/** How much of the world a change can affect if it is wrong. */
export type BlastRadius = "single-instance" | "single-region" | "global";

/** A gate is a check that must pass before a change may be promoted. */
export type Gate =
  | "PROVENANCE" // the artifact came from a build we can identify
  | "POLICY_ADMISSION" // an admission policy allowed it
  | "COMPATIBILITY" // it is compatible with what is already running
  | "STAGED_ROLLOUT" // it reached a subset before the whole
  | "BUSINESS_VERIFICATION" // a synthetic business check passed, not just health
  | "REGRESSION_CHECK" // latency and error rate did not regress
  | "REVERSIBLE" // a known-good recovery path exists and was proved
  | "AUDIT_IDENTITY"; // the record names who or what promoted it

export interface Change {
  readonly id: string;
  readonly type: ChangeType;
  readonly radius: BlastRadius;
  /** Gates this change has actually satisfied. */
  readonly satisfied: readonly Gate[];
  /** Set when the change cannot be rolled back, e.g. a destructive migration. */
  readonly irreversible?: boolean;
  /** Identity that requested promotion. */
  readonly promotedBy?: string;
  /** Emergency changes take a different, narrower path. */
  readonly emergency?: boolean;
}

export type Decision = "PROMOTE" | "BLOCK";

export interface GateResult {
  readonly decision: Decision;
  readonly required: readonly Gate[];
  readonly missing: readonly Gate[];
  readonly reasons: readonly string[];
  /** Audit record. Present even when the decision is BLOCK. */
  readonly audit: {
    readonly changeId: string;
    readonly type: ChangeType;
    readonly radius: BlastRadius;
    readonly decision: Decision;
    readonly promotedBy: string;
    readonly requiredGates: readonly Gate[];
    readonly missingGates: readonly Gate[];
  };
}
