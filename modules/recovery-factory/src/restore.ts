import { validate } from "./ledger.ts";
import type {
  BackupArtifact,
  RecoveryEvidence,
  RecoveryManifest,
  RestoreOutcome,
} from "./types.ts";

/**
 * Topologically order the manifest's steps, refusing cycles.
 *
 * Order is part of the recovery contract. Restoring data before its encryption
 * key is available, or before the schema exists, fails in ways that look like
 * corruption.
 */
export function orderSteps(m: RecoveryManifest): { order: string[]; cycle: string[] } {
  const byId = new Map(m.steps.map((s) => [s.id, s]));
  const state = new Map<string, "open" | "done">();
  const order: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "done" || cycle.length > 0) return;
    if (state.get(id) === "open") { cycle = [...path, id]; return; }
    state.set(id, "open");
    for (const dep of byId.get(id)?.requires ?? []) {
      if (!byId.has(dep)) continue;
      visit(dep, [...path, id]);
    }
    state.set(id, "done");
    order.push(id);
  };

  for (const s of m.steps) visit(s.id, []);
  return { order, cycle };
}

/**
 * Restore into an isolated target and validate.
 *
 * Isolation is not modelled as an option. Cloud SQL's point-in-time recovery
 * "always creates a new instance; you cannot perform a PITR to an existing
 * instance", and this follows that shape: a restore never writes over the
 * source, so a failed restore cannot make the incident worse.
 *
 * Evidence is produced on every path, including refusals. A restore that
 * blocked and left no record teaches nobody anything.
 */
export function restore(
  artifact: BackupArtifact | null,
  manifest: RecoveryManifest,
  opts: { sourceHeadMs: number; nowMs: number; stepCostMs?: number },
): RecoveryEvidence {
  const stepCost = opts.stepCostMs ?? 60_000;
  const reasons: string[] = [];
  const stepsCompleted: string[] = [];

  const evidence = (
    outcome: RestoreOutcome,
    invariants: RecoveryEvidence["invariants"] = [],
    rtoMs = stepsCompleted.length * stepCost,
  ): RecoveryEvidence => ({
    outcome,
    artifactId: artifact?.id ?? null,
    reasons,
    stepsCompleted,
    invariants,
    rtoMs,
    rpoMs: artifact ? Math.max(0, opts.sourceHeadMs - artifact.provenance.capturedAtMs) : 0,
    recordedAtMs: opts.nowMs,
  });

  if (!artifact || artifact.state === "DELETED") {
    reasons.push(artifact ? `artifact ${artifact.id} has been deleted` : "no artifact available");
    return evidence("BLOCKED_NO_ARTIFACT");
  }

  const { order, cycle } = orderSteps(manifest);
  if (cycle.length > 0) {
    reasons.push(`dependency cycle in manifest: ${cycle.join(" -> ")}`);
    return evidence("BLOCKED_MISSING_DEPENDENCY");
  }

  // Undeclared dependencies are a blocking finding, not a silent skip.
  const declared = new Set(manifest.steps.map((s) => s.id));
  for (const s of manifest.steps) {
    for (const dep of s.requires) {
      if (!declared.has(dep)) {
        reasons.push(`step "${s.id}" requires "${dep}", which the manifest does not declare`);
        return evidence("BLOCKED_MISSING_DEPENDENCY");
      }
    }
  }

  for (const id of order) {
    // The key is a recovery dependency with the same standing as the artifact.
    // "After a key is destroyed, data that was encrypted with the key version
    // can't be decrypted."
    if (id === "key" && artifact.provenance.keyRef !== null) {
      if (!manifest.availableKeys.includes(artifact.provenance.keyRef)) {
        reasons.push(
          `key "${artifact.provenance.keyRef}" is not available to the restore environment; ` +
          "the payload is ciphertext and stays that way",
        );
        return evidence("BLOCKED_MISSING_KEY");
      }
    }

    if (id === "data") {
      // The 2017 failure: the job ran, the artifact exists, the payload does not.
      if (artifact.payload === null) {
        reasons.push(
          `artifact ${artifact.id} has no usable payload: it was captured by tool version ` +
          `${artifact.provenance.toolVersion} against schema version ` +
          `${artifact.provenance.sourceSchemaVersion}. The job completed; the output is unusable.`,
        );
        return evidence("BLOCKED_UNREADABLE_ARTIFACT");
      }
      if (!manifest.readableSchemaVersions.includes(artifact.provenance.sourceSchemaVersion)) {
        reasons.push(
          `restore path cannot read schema version ${artifact.provenance.sourceSchemaVersion}; ` +
          `it reads ${manifest.readableSchemaVersions.join(", ")}`,
        );
        return evidence("BLOCKED_UNREADABLE_ARTIFACT");
      }
    }

    stepsCompleted.push(id);
  }

  const invariants = validate(artifact.payload!);
  const failed = invariants.filter((i) => !i.passed);
  if (failed.length > 0) {
    for (const f of failed) reasons.push(`invariant failed: ${f.name} (${f.detail})`);
    return evidence("RESTORED_BUT_INVALID", invariants);
  }

  reasons.push("restore completed and all invariants passed");
  return evidence("RESTORED_AND_VALIDATED", invariants);
}
