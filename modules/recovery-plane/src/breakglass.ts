/**
 * A break-glass grant, modelled on Privileged Access Manager's shape:
 * an entitlement says who may request what and for how long; a grant is
 * time-bounded and revoked automatically at expiry.
 */
export interface Entitlement {
  readonly id: string;
  readonly requesters: readonly string[];
  readonly roles: readonly string[];
  readonly maxDurationMs: number;
  readonly requiresApproval: boolean;
  readonly approvers: readonly string[];
}

export interface GrantRequest {
  readonly entitlementId: string;
  readonly requester: string;
  readonly justification: string;
  readonly durationMs: number;
  readonly approvedBy?: string;
  readonly atMs: number;
}

export type GrantOutcome = "GRANTED" | "DENIED";

export interface Grant {
  readonly outcome: GrantOutcome;
  readonly reason: string;
  readonly roles: readonly string[];
  readonly expiresAtMs: number | null;
  /** Written whatever the outcome, and never suppressible. */
  readonly auditRecord: {
    readonly entitlementId: string;
    readonly requester: string;
    readonly justification: string;
    readonly outcome: GrantOutcome;
    readonly approvedBy: string;
    readonly atMs: number;
    readonly expiresAtMs: number | null;
  };
}

export function requestGrant(e: Entitlement, r: GrantRequest): Grant {
  const deny = (reason: string): Grant => ({
    outcome: "DENIED",
    reason,
    roles: [],
    expiresAtMs: null,
    auditRecord: {
      entitlementId: e.id, requester: r.requester, justification: r.justification,
      outcome: "DENIED", approvedBy: r.approvedBy ?? "(none)", atMs: r.atMs, expiresAtMs: null,
    },
  });

  if (!e.requesters.includes(r.requester)) return deny("requester is not listed on the entitlement");
  if (!r.justification.trim()) return deny("no justification supplied");
  if (r.durationMs > e.maxDurationMs) return deny("requested duration exceeds the entitlement maximum");
  if (e.requiresApproval) {
    if (!r.approvedBy) return deny("entitlement requires approval and none was recorded");
    if (!e.approvers.includes(r.approvedBy)) return deny("approver is not listed on the entitlement");
    if (r.approvedBy === r.requester) return deny("self-approval is not dual control");
  }

  const expiresAtMs = r.atMs + r.durationMs;
  return {
    outcome: "GRANTED",
    reason: "all entitlement conditions satisfied",
    roles: e.roles,
    expiresAtMs,
    auditRecord: {
      entitlementId: e.id, requester: r.requester, justification: r.justification,
      outcome: "GRANTED", approvedBy: r.approvedBy ?? "(not required)", atMs: r.atMs, expiresAtMs,
    },
  };
}

/** Roles are revoked at expiry rather than by anyone remembering. */
export function rolesAt(g: Grant, nowMs: number): readonly string[] {
  if (g.outcome !== "GRANTED" || g.expiresAtMs === null) return [];
  return nowMs < g.expiresAtMs ? g.roles : [];
}
