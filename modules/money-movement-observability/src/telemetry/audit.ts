// The audit trail, which is deliberately not the trace.
//
// A trace is sampled, has a retention measured in weeks, and is a debugging
// aid. An audit record is written on the same path as the money, is never
// sampled, and is the thing somebody will ask for in a year. Modelling them as
// one store is the mistake this file exists to avoid; the reasoning is in
// docs/adr/ADR-002.
//
// Every record carries the correlation keys so that an investigator who starts
// from an audit record can reach the trace, the logs, the ledger and the
// settlement evidence — and so that one who starts from a trace that was never
// sampled can still reach the record.

export type AuditAction =
  | "intent.recorded"
  | "provider.attempted"
  | "provider.effect"
  | "ledger.posted"
  | "settlement.matched"
  | "status.published"
  | "repair.applied";

export interface AuditRecord {
  readonly sequence: number;
  readonly atMs: number;
  readonly action: AuditAction;
  readonly operationId: string;
  readonly businessRef: string;
  readonly traceId: string;
  readonly providerOpId: string | null;
  readonly journalId: string | null;
  readonly settlementId: string | null;
  /** Minor units. Absent for actions that move no money. */
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /** Who or what performed the action. */
  readonly actor: string;
  readonly detail: string;
}

/**
 * Append-only by construction: there is no update and no delete.
 *
 * Cloud Audit Logs makes the equivalent promise for its own entries, and the
 * reason is the same — a record that can be edited after the fact answers a
 * different question from the one an auditor asked.
 */
export class AuditTrail {
  readonly records: AuditRecord[];
  private seq: number;

  constructor() {
    this.records = [];
    this.seq = 0;
  }

  append(record: Omit<AuditRecord, "sequence">): AuditRecord {
    this.seq += 1;
    const full: AuditRecord = { sequence: this.seq, ...record };
    this.records.push(full);
    return full;
  }

  byOperation(operationId: string): AuditRecord[] {
    return this.records.filter((r) => r.operationId === operationId);
  }

  byTrace(traceId: string): AuditRecord[] {
    return this.records.filter((r) => r.traceId === traceId);
  }

  byAction(action: AuditAction): AuditRecord[] {
    return this.records.filter((r) => r.action === action);
  }

  /**
   * Reconstruct one operation's whole story from the audit trail alone.
   *
   * This is the query a dispute, a regulator, or a 2 a.m. investigator runs.
   * It must work when the trace was dropped by the sampler, when the log
   * bucket's retention has elapsed, and when the dashboard is unavailable.
   */
  timeline(operationId: string): string[] {
    return this.byOperation(operationId).map((r) => {
      const money = r.amountMinor === null ? "" : ` ${r.amountMinor} ${r.currency}`;
      return `${r.sequence} ${r.action}${money} by ${r.actor}: ${r.detail}`;
    });
  }
}
