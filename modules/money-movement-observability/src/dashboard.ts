// Dashboards as code.
//
// Two dashboards, written as data and exported to definitions/. They are not
// Cloud Monitoring dashboard JSON — this module creates no cloud resources —
// but they carry the same fields a dashboard definition needs, and the export
// has a drift check so the file in the repository cannot disagree with the
// catalogue it came from.
//
// The split between them is the argument. The technical dashboard is the one
// everybody already has. The invariant dashboard is the one that is red in
// scenario S04 while the other is entirely green.

import { METRICS } from "./signals.ts";
import { INVARIANTS } from "./invariants.ts";
import { SLOS } from "./slo.ts";
import { ALERTS } from "./alerts.ts";

export interface Tile {
  readonly title: string;
  readonly metric: string;
  readonly groupBy: string[];
  readonly kind: "line" | "stat" | "heatmap";
  /** What a responder should conclude from this tile. */
  readonly reads: string;
}

export interface DashboardDefinition {
  readonly name: string;
  readonly purpose: string;
  readonly tiles: Tile[];
  /** The question the whole dashboard answers in one sentence. */
  readonly answers: string;
}

export const TECHNICAL_DASHBOARD: DashboardDefinition = {
  name: "money-movement-technical",
  purpose: "Whether the services are responding.",
  answers: "Is the software up, fast, and returning successes?",
  tiles: [
    {
      title: "Response classes by service",
      metric: "money.http.responses",
      groupBy: ["service", "class"],
      kind: "line",
      reads: "A rising 5xx line is a service problem. A flat zero proves nothing about money.",
    },
    {
      title: "Request latency p95",
      metric: "money.http.latency",
      groupBy: ["service"],
      kind: "heatmap",
      reads: "Tail latency by service. Distribution, not mean: a mean hides the tail.",
    },
    {
      title: "Provider attempts by outcome",
      metric: "money.provider.attempts",
      groupBy: ["outcome"],
      kind: "line",
      reads: "The 'unknown' series is the one to watch; it is not an error, it is an open question.",
    },
    {
      title: "Event deliveries",
      metric: "money.events.delivered",
      groupBy: ["outcome"],
      kind: "line",
      reads: "Duplicates suppressed is a health signal, not a defect count.",
    },
  ],
};

export const INVARIANT_DASHBOARD: DashboardDefinition = {
  name: "money-movement-invariants",
  purpose: "Whether the money is where the books say it is.",
  answers: "Is anything financially wrong right now, and for how long has it been wrong?",
  tiles: [
    {
      title: "Open invariant violations",
      metric: "money.invariant.violations",
      groupBy: ["invariant"],
      kind: "stat",
      reads: "Any non-zero value is an incident. There is no acceptable rate.",
    },
    {
      title: "Effects applied",
      metric: "money.effects.applied",
      groupBy: ["currency"],
      kind: "line",
      reads: "Money-moving effects, not arrivals. Compare with request counts, never substitute them.",
    },
    {
      title: "Ledger imbalance",
      metric: "money.ledger.imbalance_minor",
      groupBy: ["currency"],
      kind: "line",
      reads: "Minor units of difference between debits and credits. The headline of S04.",
    },
    {
      title: "Oldest operation by state",
      metric: "money.state.oldest_age_seconds",
      groupBy: ["state"],
      kind: "line",
      reads: "Age, beside count. A small count with a growing age is the stuck case.",
    },
    {
      title: "Operations by state",
      metric: "money.state.count",
      groupBy: ["state"],
      kind: "line",
      reads: "Present only so that it can be compared with the tile above it.",
    },
    {
      title: "Settlement lateness",
      metric: "money.settlement.lateness_seconds",
      groupBy: ["currency"],
      kind: "line",
      reads: "How long the oldest capture has waited for bank evidence.",
    },
    {
      title: "Reconciliation exceptions open",
      metric: "money.reconciliation.open",
      groupBy: ["kind"],
      kind: "line",
      reads: "The count. Read it beside the age tile below, never instead of it.",
    },
    {
      title: "Reconciliation exceptions: oldest open",
      metric: "money.reconciliation.oldest_age_seconds",
      groupBy: ["kind"],
      kind: "line",
      reads: "The age series moves first when the queue stops draining.",
    },
    {
      title: "Checker staleness",
      metric: "money.checker.staleness_seconds",
      groupBy: ["checker"],
      kind: "stat",
      reads: "If this grows, every tile above it is unreliable and must be read as unknown.",
    },
    {
      title: "Canary outcome",
      metric: "money.canary.outcome",
      groupBy: ["result"],
      kind: "line",
      reads: "A known-good payment, end to end, on a schedule. A failure here precedes customer reports.",
    },
  ],
};

export const DASHBOARDS: readonly DashboardDefinition[] = [TECHNICAL_DASHBOARD, INVARIANT_DASHBOARD];

/** Every metric in the catalogue should appear on some dashboard or be removed. */
export function metricsOnNoDashboard(): string[] {
  const used = new Set(DASHBOARDS.flatMap((d) => d.tiles.map((t) => t.metric)));
  return METRICS.filter((m) => !used.has(m.name)).map((m) => m.name);
}

/** The exported, drift-checked definition bundle. */
export function definitionBundle(): Record<string, unknown> {
  return {
    note: "Declarative definitions for Article 22. Not Cloud Monitoring API payloads; this module creates no cloud resources.",
    metrics: METRICS,
    invariants: INVARIANTS,
    slos: SLOS,
    alerts: ALERTS,
    dashboards: DASHBOARDS,
  };
}
