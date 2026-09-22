import type { BackupArtifact, BackupProvenance, Dataset } from "./types.ts";

/**
 * Take a backup.
 *
 * `toolVersion` is deliberately a parameter. A backup taken by a tool that
 * cannot read the source's schema still *runs*, still *exits*, and still
 * *produces an artifact*. That is the 2017 failure and the reason `payload`
 * can be null while the operation reports success.
 */
export function takeBackup(
  id: string,
  source: Dataset,
  opts: {
    toolVersion: number;
    keyRef: string | null;
    atMs: number;
    retentionDays: number;
    retentionLocked: boolean;
    /**
     * Schema versions this tool can serialise. A source outside this set
     * yields an artifact with no usable payload -- the job "succeeded".
     */
    toolReadableSchemas: readonly number[];
  },
): BackupArtifact {
  const provenance: BackupProvenance = {
    toolVersion: opts.toolVersion,
    sourceSchemaVersion: source.schemaVersion,
    keyRef: opts.keyRef,
    capturedAtMs: opts.atMs,
  };

  const usable = opts.toolReadableSchemas.includes(source.schemaVersion);

  return {
    id,
    provenance,
    payload: usable ? source : null,
    retainedUntilMs: opts.atMs + opts.retentionDays * 86_400_000,
    retentionLocked: opts.retentionLocked,
    state: "INTACT",
  };
}

export type DeleteOutcome = "DELETED" | "RETENTION_POLICY_NOT_MET";

/**
 * Attempt to delete an artifact, as a compromised or mistaken operator would.
 *
 * Models a locked retention policy: "Attempts to delete or replace objects
 * whose age is less than the retention period fail with a
 * 403 - retentionPolicyNotMet error." A locked policy cannot be removed or
 * shortened, so no amount of privilege changes this outcome.
 */
export function attemptDelete(a: BackupArtifact, nowMs: number): DeleteOutcome {
  if (a.retentionLocked && nowMs < a.retainedUntilMs) {
    a.state = "RETAINED";
    return "RETENTION_POLICY_NOT_MET";
  }
  a.state = "DELETED";
  return "DELETED";
}

/**
 * Attempt to shorten retention, which a locked policy forbids.
 *
 * Returns the effective retention. Protection is a ratchet: increasing is
 * always permitted, reducing never is.
 */
export function setRetention(
  a: BackupArtifact,
  newRetainedUntilMs: number,
): { applied: boolean; retainedUntilMs: number; reason: string } {
  if (a.retentionLocked && newRetainedUntilMs < a.retainedUntilMs) {
    return {
      applied: false,
      retainedUntilMs: a.retainedUntilMs,
      reason: "locked retention policy cannot be reduced",
    };
  }
  const obj = a as { retainedUntilMs: number };
  obj.retainedUntilMs = newRetainedUntilMs;
  return { applied: true, retainedUntilMs: newRetainedUntilMs, reason: "retention extended" };
}
