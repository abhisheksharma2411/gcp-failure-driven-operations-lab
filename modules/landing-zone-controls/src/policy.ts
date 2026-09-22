// The configuration question: what may be configured here?
//
// Identity and Access Management focuses on who and authorizes who can take
// action; Organization Policy focuses on what and sets restrictions on how
// resources can be configured. This file is the second of those, and it does
// not consult identity at all -- an owner and a viewer get the same answer.

import type { ConstraintId, ResourceConfig } from "./types.ts";
import type { EffectivePolicy, Hierarchy } from "./hierarchy.ts";

export interface ConstraintViolation {
  readonly constraint: ConstraintId;
  readonly reason: string;
  /** The node the deciding policy was attached to. */
  readonly sourceNodeId: string;
  readonly inherited: boolean;
  /** True when an exception is the reason this did *not* fail. */
  readonly viaException?: boolean;
}

/**
 * Check a requested resource shape against effective policy at a project.
 *
 * Returns every violation rather than the first, because a developer who is
 * told about one problem at a time abandons the platform faster than one who
 * is told about three at once. The friction model counts on this.
 */
export function checkConfiguration(
  hierarchy: Hierarchy,
  projectId: string,
  config: ResourceConfig | undefined,
  nowMs: number,
): readonly ConstraintViolation[] {
  if (config === undefined) return [];
  const violations: ConstraintViolation[] = [];

  const check = (
    constraint: ConstraintId,
    evaluate: (p: EffectivePolicy) => string | null,
  ): void => {
    const policy = hierarchy.effectivePolicy(projectId, constraint, nowMs);
    if (policy === null) return; // unconstrained
    const reason = evaluate(policy);
    if (reason !== null) {
      violations.push({
        constraint,
        reason,
        sourceNodeId: policy.sourceNodeId,
        inherited: policy.inherited,
      });
    }
  };

  if (config.publiclyAccessible === true) {
    check("publicExposure", (p) =>
      p.value.type === "boolean" && p.value.enforced
        ? "public exposure is blocked by policy"
        : null,
    );
  }

  if (config.region !== undefined) {
    const region = config.region;
    check("allowedRegions", (p) =>
      p.value.type === "list" && !p.value.allowed.includes(region)
        ? `region ${region} is not in the allowed set [${p.value.allowed.join(", ")}]`
        : null,
    );
  }

  if (config.createsServiceAccountKey === true) {
    check("serviceAccountKeyCreation", (p) =>
      p.value.type === "boolean" && p.value.enforced
        ? "creating a service-account key is blocked by policy"
        : null,
    );
  }

  if (config.externalIp === true) {
    check("externalIp", (p) =>
      p.value.type === "boolean" && p.value.enforced
        ? "assigning an external IP is blocked by policy"
        : null,
    );
  }

  if (config.service !== undefined) {
    const service = config.service;
    check("allowedServices", (p) =>
      p.value.type === "list" && !p.value.allowed.includes(service)
        ? `service ${service} is not in the allowed set`
        : null,
    );
  }

  return violations;
}

/**
 * Explain, for one project, which constraints currently hold and where each
 * one comes from. Used by the report and by the exception-lifecycle test.
 */
export function describeEffectivePolicy(
  hierarchy: Hierarchy,
  projectId: string,
  nowMs: number,
): readonly PolicyDescription[] {
  const constraints: ConstraintId[] = [
    "publicExposure",
    "allowedRegions",
    "serviceAccountKeyCreation",
    "externalIp",
    "allowedServices",
  ];
  const out: PolicyDescription[] = [];
  for (const c of constraints) {
    const p = hierarchy.effectivePolicy(projectId, c, nowMs);
    out.push({
      constraint: c,
      present: p !== null,
      sourceNodeId: p?.sourceNodeId,
      inherited: p?.inherited ?? false,
      isException: p?.isException ?? false,
      expiresAtMs: p?.expiresAtMs ?? null,
      summary: p === null ? "unconstrained" : summarize(p),
    });
  }
  return out;
}

export interface PolicyDescription {
  readonly constraint: ConstraintId;
  readonly present: boolean;
  readonly sourceNodeId?: string;
  readonly inherited: boolean;
  readonly isException: boolean;
  readonly expiresAtMs: number | null;
  readonly summary: string;
}

function summarize(p: EffectivePolicy): string {
  const body =
    p.value.type === "boolean"
      ? p.value.enforced
        ? "enforced"
        : "not enforced"
      : `allow [${p.value.allowed.join(", ")}]`;
  const origin = p.inherited ? `inherited from ${p.sourceNodeId}` : `set here`;
  const life = p.isException ? `, exception expiring at ${p.expiresAtMs}` : "";
  return `${body} (${origin}${life})`;
}
