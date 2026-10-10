// The business-invariant catalogue.
//
// An invariant is a statement about money that must be true no matter what the
// services did. It is evaluated out of band, from durable state, by code that
// shares nothing with the code that produced the state — which is the point.
// An invariant checked by the same function that wrote the row is a comment.
//
// Each invariant exports as a single low-cardinality gauge: the count of open
// violations. The identifiers needed to investigate one are in the violation
// record, which goes to logs and to the incident evidence, never to a label.

import type {
  Budgets,
  PostingGroup,
  ProviderEffect,
  World,
} from "./domain/types.ts";
import { NON_TERMINAL_STATES } from "./domain/types.ts";
import type { MetricRegistry } from "./telemetry/metrics.ts";
import { INVARIANT_IDS } from "./signals.ts";

export type Severity = "page" | "ticket";

export interface InvariantDefinition {
  readonly id: string;
  readonly title: string;
  /** The statement, in the form an auditor would recognise. */
  readonly statement: string;
  readonly severity: Severity;
  readonly runbook: string;
  /** Which technical signal would be green while this is red. */
  readonly invisibleTo: string;
}

export interface Violation {
  readonly invariant: string;
  readonly operationId: string | null;
  readonly detail: string;
  /** Minor units of money implicated, where the invariant is about an amount. */
  readonly amountMinor: number | null;
}

function debits(group: PostingGroup): number {
  return group.legs.filter((l) => l.direction === "DEBIT").reduce((a, l) => a + l.amountMinor, 0);
}

function credits(group: PostingGroup): number {
  return group.legs.filter((l) => l.direction === "CREDIT").reduce((a, l) => a + l.amountMinor, 0);
}

function live(groups: readonly PostingGroup[]): PostingGroup[] {
  return groups.filter((g) => g.supersededByJournalId === null);
}

export const INVARIANTS: readonly InvariantDefinition[] = [
  {
    id: "INV-1",
    title: "the journal balances",
    statement: "For every live posting group, the sum of debits equals the sum of credits.",
    severity: "page",
    runbook: "RB-LEDGER-IMBALANCE",
    invisibleTo: "request success rate, latency, error rate — the posting request returns 200",
  },
  {
    id: "INV-2",
    title: "the posting equals the effect",
    statement: "For every provider effect with a posting group, the amount credited to the customer equals the amount the provider captured.",
    severity: "page",
    runbook: "RB-POSTING-MISMATCH",
    invisibleTo: "provider success rate — the capture succeeded and the posting succeeded",
  },
  {
    id: "INV-3",
    title: "no posting without an effect",
    statement: "Every posting group references a provider effect that exists.",
    severity: "page",
    runbook: "RB-ORPHAN-POSTING",
    invisibleTo: "event delivery metrics — the event was delivered and acknowledged",
  },
  {
    id: "INV-4",
    title: "one effect per operation",
    statement: "A logical operation causes at most one externally visible money-moving effect.",
    severity: "page",
    runbook: "RB-DUPLICATE-EFFECT",
    invisibleTo: "arrival counts — every arrival was handled successfully",
  },
  {
    id: "INV-5",
    title: "the customer is told the truth",
    statement: "No operation reports SUCCEEDED to the customer without a captured provider effect, and none reports FAILED when one exists.",
    severity: "page",
    runbook: "RB-STATUS-DIVERGENCE",
    invisibleTo: "the status endpoint's own availability and latency",
  },
  {
    id: "INV-6",
    title: "nothing is stuck",
    statement: "No operation remains in a non-terminal state for longer than its state-age budget.",
    severity: "page",
    runbook: "RB-STUCK-OPERATION",
    invisibleTo: "queue depth and in-flight counts, which stay small while an age grows",
  },
  {
    id: "INV-7",
    title: "settlement arrives",
    statement: "Every captured effect older than the settlement budget appears in settlement evidence.",
    severity: "ticket",
    runbook: "RB-SETTLEMENT-LATE",
    invisibleTo: "every online signal; nothing in the request path knows settlement is late",
  },
  {
    id: "INV-8",
    title: "the exception queue drains",
    statement: "Open reconciliation exceptions stay within budget in both count and age.",
    severity: "ticket",
    runbook: "RB-RECONCILIATION-BACKLOG",
    invisibleTo: "throughput, which rises while the residue accumulates",
  },
];

export function invariant(id: string): InvariantDefinition {
  const found = INVARIANTS.find((i) => i.id === id);
  if (!found) throw new Error(`unknown invariant ${id}`);
  return found;
}

/**
 * Evaluate every invariant against durable state at a point in time.
 *
 * Pure: a world, a clock reading and a set of budgets in, a list of violations
 * out. No I/O, no ambient time, and no dependency on the services that wrote
 * the state.
 */
export function checkInvariants(world: World, nowMs: number, budgets: Budgets): Violation[] {
  const out: Violation[] = [];
  const effectsByProviderOpId = new Map<string, ProviderEffect>();
  for (const e of world.effects) effectsByProviderOpId.set(e.providerOpId, e);

  // INV-1 — the journal balances.
  for (const group of live(world.postings)) {
    const d = debits(group);
    const c = credits(group);
    if (d !== c) {
      out.push({
        invariant: "INV-1",
        operationId: group.operationId,
        detail: `journal ${group.journalId}: debits ${d} credits ${c}`,
        amountMinor: Math.abs(d - c),
      });
    }
  }

  // INV-2 — the posting equals the effect.
  for (const group of live(world.postings)) {
    const effect = effectsByProviderOpId.get(group.providerOpId);
    if (!effect) continue;
    const payable = group.legs
      .filter((l) => l.account === "customer-payable" && l.direction === "CREDIT")
      .reduce((a, l) => a + l.amountMinor, 0);
    if (payable !== effect.capturedMinor) {
      out.push({
        invariant: "INV-2",
        operationId: group.operationId,
        detail: `journal ${group.journalId}: credited ${payable}, provider captured ${effect.capturedMinor}`,
        amountMinor: Math.abs(payable - effect.capturedMinor),
      });
    }
  }

  // INV-3 — no posting without an effect.
  for (const group of live(world.postings)) {
    if (!effectsByProviderOpId.has(group.providerOpId)) {
      out.push({
        invariant: "INV-3",
        operationId: group.operationId,
        detail: `journal ${group.journalId} references unknown provider effect ${group.providerOpId}`,
        amountMinor: credits(group),
      });
    }
  }

  // INV-4 — one effect per operation.
  const effectCount = new Map<string, number>();
  for (const e of world.effects) effectCount.set(e.operationId, (effectCount.get(e.operationId) ?? 0) + 1);
  for (const [operationId, count] of effectCount) {
    if (count > 1) {
      out.push({
        invariant: "INV-4",
        operationId,
        detail: `${count} provider effects for one operation`,
        amountMinor: null,
      });
    }
  }

  // INV-5 — the customer is told the truth.
  for (const op of world.operations.values()) {
    const hasEffect = (effectCount.get(op.operationId) ?? 0) > 0;
    if (op.customerStatus === "SUCCEEDED" && !hasEffect) {
      out.push({
        invariant: "INV-5",
        operationId: op.operationId,
        detail: "customer told SUCCEEDED with no provider effect",
        amountMinor: op.amountMinor,
      });
    }
    if (op.customerStatus === "FAILED" && hasEffect) {
      out.push({
        invariant: "INV-5",
        operationId: op.operationId,
        detail: "customer told FAILED while a provider effect exists",
        amountMinor: op.amountMinor,
      });
    }
  }

  // INV-6 — nothing is stuck.
  for (const op of world.operations.values()) {
    if (!NON_TERMINAL_STATES.includes(op.state)) continue;
    const budget =
      op.state === "OUTCOME_UNKNOWN"
        ? budgets.unknownOutcomeMs
        : op.state === "POSTED"
          ? budgets.postedAgeMs
          : budgets.stateAgeMs;
    const age = nowMs - op.stateSinceMs;
    if (age > budget) {
      out.push({
        invariant: "INV-6",
        operationId: op.operationId,
        detail: `state ${op.state} for ${Math.round(age / 60_000)} min, budget ${Math.round(budget / 60_000)} min`,
        amountMinor: op.amountMinor,
      });
    }
  }

  // INV-7 — settlement arrives.
  const settled = new Set(world.settlements.map((s) => s.providerOpId));
  for (const effect of world.effects) {
    if (settled.has(effect.providerOpId)) continue;
    const age = nowMs - effect.atMs;
    if (age > budgets.settlementMs) {
      out.push({
        invariant: "INV-7",
        operationId: effect.operationId,
        detail: `capture ${effect.providerOpId} unsettled after ${Math.round(age / 3_600_000)} h`,
        amountMinor: effect.capturedMinor,
      });
    }
  }

  // INV-8 — the exception queue drains.
  const open = world.exceptions.filter((e) => e.resolvedAtMs === null);
  if (open.length > budgets.openExceptions) {
    out.push({
      invariant: "INV-8",
      operationId: null,
      detail: `${open.length} open exceptions, budget ${budgets.openExceptions}`,
      amountMinor: null,
    });
  }
  for (const exception of open) {
    const age = nowMs - exception.openedAtMs;
    if (age > budgets.exceptionAgeMs) {
      out.push({
        invariant: "INV-8",
        operationId: exception.operationId,
        detail: `exception ${exception.exceptionId} open for ${Math.round(age / 3_600_000)} h`,
        amountMinor: null,
      });
    }
  }

  return out;
}

/** Count of open violations per invariant, including the zeroes. */
export function violationCounts(violations: readonly Violation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of INVARIANT_IDS) counts[id] = 0;
  for (const v of violations) counts[v.invariant] = (counts[v.invariant] ?? 0) + 1;
  return counts;
}

/**
 * Publish the invariant results as metrics.
 *
 * Writing a zero matters as much as writing a one. A gauge that is only
 * written when something is wrong is indistinguishable from a checker that has
 * stopped running, which is scenario S06.
 */
export function publishInvariantGauges(
  metrics: MetricRegistry,
  violations: readonly Violation[],
): void {
  const counts = violationCounts(violations);
  for (const [id, count] of Object.entries(counts)) {
    metrics.set("money.invariant.violations", { invariant: id }, count);
  }
}

/**
 * Publish the operational gauges the alerts read.
 *
 * Count and age are published side by side on purpose. The stuck case is
 * precisely the one where the count stays small and the age does not, and
 * Pub/Sub's own backlog guidance describes the same pair for the same reason.
 */
export function publishOperationalGauges(
  metrics: MetricRegistry,
  world: World,
  nowMs: number,
): void {
  for (const state of NON_TERMINAL_STATES) {
    const inState = [...world.operations.values()].filter((o) => o.state === state);
    metrics.set("money.state.count", { state }, inState.length);
    const oldest = inState.reduce((max, o) => Math.max(max, nowMs - o.stateSinceMs), 0);
    metrics.set("money.state.oldest_age_seconds", { state }, Math.round(oldest / 1000));
  }

  for (const currency of ["EUR", "USD"] as const) {
    const groups = live(world.postings).filter((g) => g.currency === currency);
    const imbalance = groups.reduce((acc, g) => acc + (debits(g) - credits(g)), 0);
    metrics.set("money.ledger.imbalance_minor", { currency }, Math.abs(imbalance));

    const settled = new Set(world.settlements.map((s) => s.providerOpId));
    const unsettled = world.effects.filter((e) => e.currency === currency && !settled.has(e.providerOpId));
    const lateness = unsettled.reduce((max, e) => Math.max(max, nowMs - e.atMs), 0);
    metrics.set("money.settlement.lateness_seconds", { currency }, Math.round(lateness / 1000));
  }

  for (const kind of ["unmatched-effect", "unmatched-settlement", "amount-mismatch"] as const) {
    const open = world.exceptions.filter((e) => e.kind === kind && e.resolvedAtMs === null);
    metrics.set("money.reconciliation.open", { kind }, open.length);
    const oldest = open.reduce((max, e) => Math.max(max, nowMs - e.openedAtMs), 0);
    metrics.set("money.reconciliation.oldest_age_seconds", { kind }, Math.round(oldest / 1000));
  }

  for (const checker of ["invariants", "canary", "reconciliation"] as const) {
    const last = world.checkerLastRunMs.get(checker);
    const staleness = last === undefined ? nowMs : nowMs - last;
    metrics.set("money.checker.staleness_seconds", { checker }, Math.round(staleness / 1000));
  }
}
