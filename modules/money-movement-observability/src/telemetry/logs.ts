// Structured logs with correlation fields and redaction at the point of write.
//
// Redaction here is a write-time transform in the application, not a
// downstream scrub. A field that was never written cannot leak from a log
// bucket, a sink, an export to BigQuery, or a screenshot in a ticket. The
// trade-off is recorded in docs/adr/ADR-002.

/** The identifiers that make a log line joinable to everything else. */
export interface CorrelationFields {
  /** The logical operation. Stable across every boundary. */
  readonly operationId: string;
  /** The business thing being protected: an order, an invoice. */
  readonly businessRef: string;
  readonly traceId: string;
  readonly spanId: string;
  /** The provider's own identifier for its effect, once one exists. */
  readonly providerOpId?: string;
  /** The ledger journal group, once one exists. */
  readonly journalId?: string;
  /** The settlement record, once one exists. */
  readonly settlementId?: string;
}

export interface LogEntry {
  readonly atMs: number;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly service: string;
  readonly message: string;
  readonly correlation: CorrelationFields;
  readonly payload: Record<string, unknown>;
}

/** Field names whose values must never be written, in any service. */
export const DENIED_FIELDS: readonly string[] = [
  "pan",
  "cardNumber",
  "cvv",
  "cvc",
  "customerEmail",
  "email",
  "phone",
  "iban",
  "accountNumber",
  "authorization",
  "apiKey",
  "secret",
];

const PAN_LIKE = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g;
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Replace a denied value with a stable, non-reversible marker.
 *
 * The marker keeps the shape of the record — an investigator can still see
 * that a card was present and that two records carried the same one — without
 * the value itself. It is a digest, not encryption, and it is not a token a
 * downstream system may use to retrieve the original.
 */
export function pseudonym(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `redacted:${h.toString(16).padStart(8, "0")}`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    const masked = value.replace(PAN_LIKE, (m) => pseudonym(m)).replace(EMAIL_LIKE, (m) => pseudonym(m));
    return masked;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redactPayload(value as Record<string, unknown>);
  return value;
}

/** Strip denied field names, then mask denied-looking values in what remains. */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (DENIED_FIELDS.includes(key)) {
      out[key] = typeof value === "string" ? pseudonym(value) : "redacted";
      continue;
    }
    out[key] = redactValue(value);
  }
  return out;
}

export class StructuredLog {
  readonly entries: LogEntry[];
  /** Set false to model the logging pipeline being unavailable. */
  available: boolean;
  droppedWhileUnavailable: number;
  /** When false, the redaction transform is skipped. Negative control only. */
  redactionEnabled: boolean;

  constructor(options?: { redactionEnabled?: boolean }) {
    this.entries = [];
    this.available = true;
    this.droppedWhileUnavailable = 0;
    this.redactionEnabled = options?.redactionEnabled !== false;
  }

  write(entry: Omit<LogEntry, "payload"> & { payload: Record<string, unknown> }): LogEntry {
    const safe: LogEntry = {
      atMs: entry.atMs,
      severity: entry.severity,
      service: entry.service,
      message: entry.message,
      correlation: entry.correlation,
      payload: this.redactionEnabled ? redactPayload(entry.payload) : { ...entry.payload },
    };
    if (!this.available) {
      this.droppedWhileUnavailable += 1;
      return safe;
    }
    this.entries.push(safe);
    return safe;
  }

  /** The investigation query the runbooks use: everything for one operation. */
  byOperation(operationId: string): LogEntry[] {
    return this.entries.filter((e) => e.correlation.operationId === operationId);
  }

  /** The serialised form a sink would receive. Used by the redaction test. */
  serialised(): string {
    return JSON.stringify(this.entries);
  }
}
