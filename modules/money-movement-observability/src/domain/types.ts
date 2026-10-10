// The synthetic money-movement flow, as types.
//
// The flow is deliberately small: a customer request becomes a provider
// effect, a provider effect becomes a group of ledger postings, and a
// settlement record eventually arrives for it. That is enough shape to carry
// every signal the article argues about, and little enough that a reader can
// hold all of it while reading the invariants.
//
// This module is a local model. It is not a Google Cloud client, it reaches no
// network, and it creates no cloud resources. Every departure from real
// platform behaviour is listed in ../../docs/MODEL.md.

export type Currency = "EUR" | "USD";

export const CURRENCIES: readonly Currency[] = ["EUR", "USD"];

/**
 * Where an operation is.
 *
 * `OUTCOME_UNKNOWN` is a state, not an error. A provider call that times out
 * has not failed; it has stopped telling us. Collapsing it into FAILED is how
 * a system ends up telling a customer that nothing happened while the money
 * has gone.
 */
export type OperationState =
  | "INTENT"
  | "PROVIDER_PENDING"
  | "OUTCOME_UNKNOWN"
  | "CAPTURED"
  | "POSTED"
  | "SETTLED"
  | "FAILED_FINAL";

export const NON_TERMINAL_STATES: readonly OperationState[] = [
  "INTENT",
  "PROVIDER_PENDING",
  "OUTCOME_UNKNOWN",
  "CAPTURED",
  "POSTED",
];

/** What the customer has been told. Not the same thing as the state. */
export type CustomerStatus = "PROCESSING" | "SUCCEEDED" | "FAILED";

export interface Operation {
  readonly operationId: string;
  readonly businessRef: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly createdAtMs: number;
  readonly traceId: string;
  state: OperationState;
  stateSinceMs: number;
  customerStatus: CustomerStatus;
  providerOpId: string | null;
}

export interface ProviderEffect {
  readonly providerOpId: string;
  readonly operationId: string;
  /** What the provider says it took. May differ from what was requested. */
  readonly capturedMinor: number;
  readonly feeMinor: number;
  readonly currency: Currency;
  readonly atMs: number;
}

export type AccountName =
  | "cash-in-transit"
  | "processor-fees"
  | "customer-payable";

export interface PostingLeg {
  readonly account: AccountName;
  readonly direction: "DEBIT" | "CREDIT";
  readonly amountMinor: number;
}

export interface PostingGroup {
  readonly journalId: string;
  readonly operationId: string;
  readonly providerOpId: string;
  readonly currency: Currency;
  readonly legs: PostingLeg[];
  readonly atMs: number;
  /** Set when a repair supersedes this group. */
  supersededByJournalId: string | null;
}

export interface SettlementRecord {
  readonly settlementId: string;
  readonly providerOpId: string;
  readonly netMinor: number;
  readonly currency: Currency;
  readonly atMs: number;
}

export type ExceptionKind =
  | "unmatched-effect"
  | "unmatched-settlement"
  | "amount-mismatch";

export interface ReconciliationException {
  readonly exceptionId: string;
  readonly kind: ExceptionKind;
  readonly operationId: string | null;
  readonly openedAtMs: number;
  resolvedAtMs: number | null;
}

export const EXCEPTION_KINDS: readonly ExceptionKind[] = [
  "unmatched-effect",
  "unmatched-settlement",
  "amount-mismatch",
];

/** Everything the invariant checker reads. */
export interface World {
  readonly operations: Map<string, Operation>;
  readonly effects: ProviderEffect[];
  readonly postings: PostingGroup[];
  readonly settlements: SettlementRecord[];
  readonly exceptions: ReconciliationException[];
  /** When each periodic checker last completed. Absence is not health. */
  readonly checkerLastRunMs: Map<string, number>;
}

export function emptyWorld(): World {
  return {
    operations: new Map(),
    effects: [],
    postings: [],
    settlements: [],
    exceptions: [],
    checkerLastRunMs: new Map(),
  };
}

/** Budgets the invariants and alerts are measured against. */
export interface Budgets {
  /**
   * How long an operation may stay in a non-terminal state.
   *
   * One budget per state, not one for all of them. The first version of this
   * module used a single figure, and a payment waiting legitimately for
   * settlement evidence therefore tripped the stuck-operation alert fifteen
   * minutes into a forty-eight-hour wait. A budget that pages during normal
   * operation is an alert that will be turned off.
   */
  readonly stateAgeMs: number;
  /** How long an unknown provider outcome may stay unresolved. */
  readonly unknownOutcomeMs: number;
  /** How long a posted operation may wait for settlement before it is stuck. */
  readonly postedAgeMs: number;
  /** How long after a capture a settlement record is expected. */
  readonly settlementMs: number;
  /** How long a reconciliation exception may stay open. */
  readonly exceptionAgeMs: number;
  /** How many reconciliation exceptions may be open at once. */
  readonly openExceptions: number;
  /** How stale a periodic checker's last run may be. */
  readonly checkerStalenessMs: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  stateAgeMs: 15 * 60_000,
  unknownOutcomeMs: 10 * 60_000,
  postedAgeMs: 50 * 3_600_000,
  settlementMs: 48 * 3_600_000,
  exceptionAgeMs: 24 * 3_600_000,
  openExceptions: 25,
  checkerStalenessMs: 15 * 60_000,
};
