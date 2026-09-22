// Domain types for the landing-zone control model.
//
// This module is a local, deterministic representation of five Google Cloud
// mechanisms. It is not a Google Cloud client and reaches no network. Every
// mechanism it models is cited in ../docs/MODEL.md against public
// documentation; where the model simplifies, MODEL.md says so.

/** Resource Manager hierarchy: organization (root) -> folders -> projects. */
export type NodeKind = "organization" | "folder" | "project";

export interface ResourceNode {
  readonly id: string;
  readonly kind: NodeKind;
  /** null only for the organization, which is the root node. */
  readonly parent: string | null;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * The organization-policy constraints this model understands.
 *
 * Real Google Cloud exposes many more. These five are the ones the article's
 * guardrail tests exercise, and each maps to a documented constraint family.
 */
export type ConstraintId =
  | "publicExposure"
  | "allowedRegions"
  | "serviceAccountKeyCreation"
  | "externalIp"
  | "allowedServices";

/** A boolean constraint is enforced or not; a list constraint names a set. */
export type ConstraintValue =
  | { readonly type: "boolean"; readonly enforced: boolean }
  | { readonly type: "list"; readonly allowed: readonly string[] };

/**
 * A policy attached to one node for one constraint.
 *
 * `expiresAtMs` is the departure from Google Cloud: a real organization policy
 * has no expiry. Modelling expiry is the point -- see ADR-002.
 */
export interface PolicyBinding {
  readonly constraint: ConstraintId;
  readonly nodeId: string;
  readonly value: ConstraintValue;
  /** null = permanent. A number = an exception that lapses at that instant. */
  readonly expiresAtMs: number | null;
  /** Required when expiresAtMs is set. Recorded in the decision trace. */
  readonly justification?: string;
  readonly requestedBy?: string;
}

/** How a principal proved who it is. */
export type CredentialKind =
  | "serviceAccountKey"
  | "federated"
  | "impersonated"
  | "userInteractive";

export interface Credential {
  readonly kind: CredentialKind;
  /** The identity the credential asserts. */
  readonly subject: string;
  readonly issuedAtMs: number;
  /**
   * null means the credential does not expire.
   *
   * Only a stored service-account key has this shape, and that is the whole
   * reason the documentation calls keys a security risk.
   */
  readonly expiresAtMs: number | null;
  /**
   * For a federated credential: the external claim the Google identity was
   * derived from, as an attribute mapping would produce.
   */
  readonly assertion?: Readonly<Record<string, string>>;
  /** For an impersonated credential: who did the impersonating. */
  readonly impersonatedBy?: string;
}

export type Permission = string;

/** An IAM binding. Granted at a node, inherited by every descendant. */
export interface Grant {
  readonly principal: string;
  readonly role: string;
  /** The node the role is granted at. */
  readonly scope: string;
  readonly expiresAtMs: number | null;
  readonly justification?: string;
  /**
   * When set, the grant applies only to this one service account rather than
   * to the whole node -- the resource-level binding you get by granting a role
   * on the service account itself instead of on its project.
   *
   * Such a grant confers nothing outside impersonation of that account, so
   * `effectivePermissions` skips it.
   */
  readonly serviceAccount?: string;
}

/** A service perimeter around a set of projects. */
export interface Perimeter {
  readonly name: string;
  readonly projects: readonly string[];
  readonly restrictedServices: readonly string[];
  /**
   * Dry run records what it would have blocked without blocking it.
   * Documented as the way to understand traffic before enforcing.
   */
  readonly dryRun: boolean;
  /** Projects outside the perimeter that egress is nonetheless allowed to. */
  readonly egressAllowedTo?: readonly string[];
}

/** Where audit records for a node are written. */
export interface AuditSink {
  readonly name: string;
  /** The node whose activity this sink captures. */
  readonly sourceNodeId: string;
  /** The project that holds the written records. */
  readonly destinationProjectId: string;
  /** Whether the destination refuses deletion before its retention elapses. */
  readonly retentionLocked: boolean;
}

/** A thing a principal is trying to do. */
export interface Action {
  readonly principal: string;
  readonly credential: Credential;
  readonly operation: string;
  readonly targetProject: string;
  /** The resource shape being requested, checked against constraints. */
  readonly config?: ResourceConfig;
  /** Set when the operation moves data to another project. */
  readonly egressToProject?: string;
  /** For impersonation attempts: the service account being impersonated. */
  readonly impersonationTarget?: string;
  /** Marks a step that a human must approve. Counted as friction. */
  readonly requiresManualApproval?: boolean;
}

export interface ResourceConfig {
  readonly service?: string;
  readonly region?: string;
  readonly publiclyAccessible?: boolean;
  readonly externalIp?: boolean;
  readonly createsServiceAccountKey?: boolean;
}

/** Which of the three questions rejected the action, if any. */
export type DenialLayer = "identity" | "configuration" | "perimeter";

export interface Decision {
  readonly allowed: boolean;
  readonly layer?: DenialLayer;
  readonly reason?: string;
  /** Every check that ran, in order, for the article's decision trace. */
  readonly trace: readonly string[];
  /** Emitted when a dry-run perimeter would have blocked but did not. */
  readonly dryRunViolation?: string;
  /** The sink the action's audit record was written to, if any. */
  readonly auditedTo?: string;
}
