// Alert, diagnosis, repair, verification, evidence.
//
// The loop this file closes is the one that decides whether an invariant is a
// control or a decoration. An invariant that fires an alert nobody can act on
// trains people to close the alert.
//
// The repair is append-only: nothing is edited, a corrected posting group is
// written and the wrong one is marked superseded. Running it twice produces
// the same state as running it once, which is checked rather than asserted.

import type { Budgets, PostingGroup, World } from "./domain/types.ts";
import { checkInvariants } from "./invariants.ts";
import type { Violation } from "./invariants.ts";
import { alertById } from "./alerts.ts";
import type { AuditTrail } from "./telemetry/audit.ts";
import { feeFor } from "./domain/flow.ts";

export interface Diagnosis {
  readonly invariant: string;
  readonly operationId: string | null;
  readonly journalId: string | null;
  readonly amountMinor: number | null;
  readonly traceId: string | null;
  readonly auditTimeline: string[];
  readonly logQuery: string;
}

export interface RepairOutcome {
  readonly command: string;
  readonly appliedAtMs: number;
  readonly timesInvoked: number;
  readonly journalsSuperseded: string[];
  readonly journalsCreated: string[];
  readonly idempotent: boolean;
}

export interface IncidentEvidence {
  readonly alertId: string;
  readonly runbook: string;
  readonly firedAtMs: number;
  readonly severity: string;
  readonly route: string;
  readonly diagnosis: Diagnosis;
  readonly repair: RepairOutcome;
  readonly violationsBefore: number;
  readonly violationsAfter: number;
  readonly verifiedAtMs: number;
  readonly outcome: "resolved" | "still-open";
}

/**
 * Turn one violation into the record a responder would start from.
 *
 * Everything here comes from signals the system already emits: the audit
 * trail gives the timeline, the correlation keys give the log query, and the
 * violation itself gives the amount. Nothing is reconstructed by guessing.
 */
export function diagnose(
  violation: Violation,
  world: World,
  audit: AuditTrail,
): Diagnosis {
  const operationId = violation.operationId;
  const operation = operationId ? world.operations.get(operationId) : undefined;
  const group = world.postings.find(
    (g) => g.operationId === operationId && g.supersededByJournalId === null,
  );
  return {
    invariant: violation.invariant,
    operationId,
    journalId: group?.journalId ?? null,
    amountMinor: violation.amountMinor,
    traceId: operation?.traceId ?? null,
    auditTimeline: operationId ? audit.timeline(operationId) : [],
    logQuery: operationId
      ? `jsonPayload.correlation.operationId="${operationId}"`
      : "jsonPayload.correlation.operationId=*",
  };
}

/**
 * Repair an unbalanced posting group by superseding it.
 *
 * Keyed on the journal id: a group that already carries a superseding id is
 * left alone. The second invocation therefore writes nothing, which is what
 * makes it safe to put in a runbook that somebody will run twice at 3 a.m.
 */
export function repairImbalance(
  world: World,
  audit: AuditTrail,
  journalId: string,
  atMs: number,
  invocation: number,
): { superseded: string[]; created: string[] } {
  const group = world.postings.find((g) => g.journalId === journalId);
  if (!group || group.supersededByJournalId !== null) return { superseded: [], created: [] };

  const effect = world.effects.find((e) => e.providerOpId === group.providerOpId);
  if (!effect) return { superseded: [], created: [] };

  const fee = feeFor(effect.capturedMinor);
  const corrected: PostingGroup = {
    journalId: `${journalId}-r${invocation}`,
    operationId: group.operationId,
    providerOpId: group.providerOpId,
    currency: group.currency,
    legs: [
      { account: "cash-in-transit", direction: "DEBIT", amountMinor: effect.capturedMinor - fee },
      { account: "processor-fees", direction: "DEBIT", amountMinor: fee },
      { account: "customer-payable", direction: "CREDIT", amountMinor: effect.capturedMinor },
    ],
    atMs,
    supersededByJournalId: null,
  };
  group.supersededByJournalId = corrected.journalId;
  world.postings.push(corrected);

  const operation = world.operations.get(group.operationId);
  audit.append({
    atMs,
    action: "repair.applied",
    operationId: group.operationId,
    businessRef: operation?.businessRef ?? "",
    traceId: operation?.traceId ?? "",
    providerOpId: group.providerOpId,
    journalId: corrected.journalId,
    settlementId: null,
    amountMinor: effect.capturedMinor,
    currency: effect.currency,
    actor: "runbook:RB-LEDGER-IMBALANCE",
    detail: `superseded ${journalId}; posted 3 legs`,
  });

  return { superseded: [journalId], created: [corrected.journalId] };
}

/**
 * The whole loop, for one alert.
 *
 * The repair is invoked twice on purpose. A runbook step that is only safe
 * once is a runbook step that will eventually be run twice.
 */
export function respond(options: {
  alertId: string;
  world: World;
  audit: AuditTrail;
  budgets: Budgets;
  firedAtMs: number;
}): IncidentEvidence {
  const { alertId, world, audit, budgets, firedAtMs } = options;
  const alert = alertById(alertId);
  const before = checkInvariants(world, firedAtMs, budgets);
  const target = before[0];
  if (!target) throw new Error(`${alertId} fired with no violation to diagnose`);

  const diagnosis = diagnose(target, world, audit);
  const first = diagnosis.journalId
    ? repairImbalance(world, audit, diagnosis.journalId, firedAtMs + 60_000, 1)
    : { superseded: [], created: [] };
  const second = diagnosis.journalId
    ? repairImbalance(world, audit, diagnosis.journalId, firedAtMs + 120_000, 2)
    : { superseded: [], created: [] };

  const verifiedAtMs = firedAtMs + 180_000;
  const after = checkInvariants(world, verifiedAtMs, budgets);

  return {
    alertId,
    runbook: alert.runbook,
    firedAtMs,
    severity: alert.severity,
    route: alert.route,
    diagnosis,
    repair: {
      command: diagnosis.journalId
        ? `node scripts/incident.ts --repair ledger-imbalance --journal ${diagnosis.journalId}`
        : "no automated repair for this invariant",
      appliedAtMs: firedAtMs + 60_000,
      timesInvoked: 2,
      journalsSuperseded: first.superseded,
      journalsCreated: first.created,
      // The second invocation must change nothing at all.
      idempotent: second.superseded.length === 0 && second.created.length === 0,
    },
    violationsBefore: before.length,
    violationsAfter: after.length,
    verifiedAtMs,
    outcome: after.length === 0 ? "resolved" : "still-open",
  };
}
