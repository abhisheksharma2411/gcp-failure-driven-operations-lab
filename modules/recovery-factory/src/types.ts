// A recovery factory: backup artifacts with provenance, an ordered dependency
// manifest, an isolated restore, and a validation contract that checks
// business invariants rather than exit codes.
//
// The premise is GitLab, January 2017. Five protection mechanisms existed. The
// one that mattered ran successfully and produced nothing usable:
//
//   "The backup procedure was using pg_dump 9.2, while our database is running
//    PostgreSQL 9.6."
//
// And nobody found out, because the failure notification was discarded, and
// nobody owned testing the restore.
//
// A completed backup job is not evidence of recoverability. This module exists
// to make that distinction executable.

/** A synthetic double-entry ledger. Small, and with a checkable invariant. */
export interface Posting {
  readonly id: string;
  readonly account: string;
  /** Minor units. Debits positive, credits negative. */
  readonly amountMinor: number;
  readonly txnId: string;
  readonly atMs: number;
}

export interface Dataset {
  readonly postings: readonly Posting[];
  /** Schema version the writer used. Restores must be able to read it. */
  readonly schemaVersion: number;
}

/**
 * Metadata a backup carries so a restore can refuse it.
 *
 * The GitLab failure is a mismatch between the tool that wrote the artifact and
 * the system it came from. Recording it is what lets a restore fail loudly
 * instead of producing an empty database.
 */
export interface BackupProvenance {
  /** Version of the tool that produced the artifact. */
  readonly toolVersion: number;
  /** Schema version of the source at capture time. */
  readonly sourceSchemaVersion: number;
  /** Key the payload is encrypted under. Null means unencrypted. */
  readonly keyRef: string | null;
  readonly capturedAtMs: number;
}

export type ArtifactState = "INTACT" | "RETAINED" | "DELETED";

export interface BackupArtifact {
  readonly id: string;
  readonly provenance: BackupProvenance;
  /** Opaque payload. Null models a job that ran and wrote nothing usable. */
  readonly payload: Dataset | null;
  /** Retention policy expiry. Locked policies cannot be shortened. */
  readonly retainedUntilMs: number;
  readonly retentionLocked: boolean;
  state: ArtifactState;
}

/** Ordered recovery dependencies. Order is part of the contract. */
export interface DependencyStep {
  readonly id: string;
  readonly description: string;
  /** Other step ids that must complete first. */
  readonly requires: readonly string[];
}

export interface RecoveryManifest {
  readonly version: number;
  readonly steps: readonly DependencyStep[];
  /** Tool version the restore path can read. */
  readonly restoreToolVersion: number;
  /** Schema versions the restore path can read. */
  readonly readableSchemaVersions: readonly number[];
  /** Keys available to the restore environment. */
  readonly availableKeys: readonly string[];
}

export type RestoreOutcome =
  | "RESTORED_AND_VALIDATED"
  | "BLOCKED_MISSING_DEPENDENCY"
  | "BLOCKED_UNREADABLE_ARTIFACT"
  | "BLOCKED_MISSING_KEY"
  | "RESTORED_BUT_INVALID"
  | "BLOCKED_NO_ARTIFACT";

export interface InvariantResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface RecoveryEvidence {
  readonly outcome: RestoreOutcome;
  readonly artifactId: string | null;
  readonly reasons: readonly string[];
  /** Steps completed, in the order they ran. */
  readonly stepsCompleted: readonly string[];
  readonly invariants: readonly InvariantResult[];
  /** Measured, in virtual ms. Not a vendor figure and not a target. */
  readonly rtoMs: number;
  /** Data-loss window: source head minus artifact capture time. */
  readonly rpoMs: number;
  /** Evidence the operator cannot suppress. Written on every path. */
  readonly recordedAtMs: number;
}
