// Where the record of an action is written, and who could erase it.
//
// Routing audit records somewhere is easy. Routing them somewhere the actor
// cannot reach is the part that gets skipped, so this file derives that
// property rather than accepting a flag that claims it -- the same reasoning
// as the recovery-plane module's independence check, applied to evidence
// instead of to recovery.

import type { AuditSink } from "./types.ts";
import type { Hierarchy } from "./hierarchy.ts";
import { ROLE_PERMISSIONS } from "./identity.ts";

/** The nearest sink at or above a node. Sinks inherit like policies do. */
export function resolveSink(
  hierarchy: Hierarchy,
  sinks: readonly AuditSink[],
  nodeId: string,
): AuditSink | null {
  for (const candidate of hierarchy.ancestry(nodeId)) {
    const sink = sinks.find((s) => s.sourceNodeId === candidate);
    if (sink) return sink;
  }
  return null;
}

export interface AuditWeakness {
  readonly sink: string;
  readonly kind: "no-sink" | "shared-authority" | "no-retention-lock" | "self-destination";
  readonly detail: string;
  readonly principals?: readonly string[];
}

/**
 * Permissions that would let a principal remove or rewrite stored records.
 * Modelled coarsely on purpose: the article's point does not depend on the
 * exact permission names, and pretending to precision here would be a claim
 * the source matrix does not carry.
 */
const DESTRUCTIVE = new Set<string>([
  "*",
  "storage.buckets.create",
  "storage.buckets.setIamPolicy",
]);

function principalsWithDestructiveAccess(
  hierarchy: Hierarchy,
  nodeId: string,
  nowMs: number,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const grant of hierarchy.grants()) {
    if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) continue;
    if (grant.serviceAccount !== undefined) continue;
    if (!hierarchy.ancestry(nodeId).includes(grant.scope)) continue;
    const perms = ROLE_PERMISSIONS[grant.role] ?? [];
    if (perms.some((p) => DESTRUCTIVE.has(p))) out.add(grant.principal);
  }
  return out;
}

/**
 * Whether a sensitive node's audit trail survives an actor who controls that
 * node.
 *
 * A sink whose destination sits inside the authority the sink is meant to
 * evidence records everything right up until it matters.
 */
export function auditWeaknesses(
  hierarchy: Hierarchy,
  sinks: readonly AuditSink[],
  sensitiveNodeId: string,
  nowMs: number,
): readonly AuditWeakness[] {
  const out: AuditWeakness[] = [];
  const sink = resolveSink(hierarchy, sinks, sensitiveNodeId);
  if (sink === null) {
    out.push({
      sink: "(none)",
      kind: "no-sink",
      detail: `${sensitiveNodeId} has no audit sink at or above it`,
    });
    return out;
  }

  if (sink.destinationProjectId === sensitiveNodeId) {
    out.push({
      sink: sink.name,
      kind: "self-destination",
      detail: `${sensitiveNodeId} writes its own audit records into itself`,
    });
  }

  if (!sink.retentionLocked) {
    out.push({
      sink: sink.name,
      kind: "no-retention-lock",
      detail: `${sink.destinationProjectId} accepts deletion of stored records`,
    });
  }

  if (hierarchy.has(sink.destinationProjectId)) {
    const overSource = principalsWithDestructiveAccess(hierarchy, sensitiveNodeId, nowMs);
    const overSink = principalsWithDestructiveAccess(
      hierarchy,
      sink.destinationProjectId,
      nowMs,
    );
    const shared = [...overSource].filter((p) => overSink.has(p)).sort();
    if (shared.length > 0) {
      out.push({
        sink: sink.name,
        kind: "shared-authority",
        detail:
          `${shared.length} principal(s) can act destructively on both ` +
          `${sensitiveNodeId} and ${sink.destinationProjectId}`,
        principals: shared,
      });
    }
  }

  return out;
}
