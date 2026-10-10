// A telemetry volume model.
//
// This computes volumes, not money. No price appears anywhere in this module,
// because a price read from a documentation page on one day and pasted into an
// article is a number that will be wrong by the time somebody acts on it. The
// output is bytes and time series; multiply by whatever your own billing
// account actually charges.
//
// The useful part is not the total. It is the shape: which signal shrinks when
// you sample, which does not, and which one you are not allowed to shrink.

import { totalDeclaredSeries } from "./signals.ts";

export interface VolumeAssumptions {
  /** Operations per day through the flow. */
  readonly operationsPerDay: number;
  /** Spans emitted per operation, across all four services. */
  readonly spansPerOperation: number;
  readonly bytesPerSpan: number;
  readonly logEntriesPerOperation: number;
  readonly bytesPerLogEntry: number;
  readonly auditRecordsPerOperation: number;
  readonly bytesPerAuditRecord: number;
  /** Points written per time series per day. */
  readonly metricPointsPerSeriesPerDay: number;
  readonly bytesPerMetricPoint: number;
  /** Head sampling rate applied to traces. */
  readonly traceSamplingRate: number;
}

/**
 * Defaults chosen to be round and legible, not measured.
 *
 * They are the article's `Illustrative example` label: the ratios between the
 * signals are the claim, and the absolute numbers are inputs a reader should
 * replace with their own.
 */
export const DEFAULT_ASSUMPTIONS: VolumeAssumptions = {
  operationsPerDay: 1_000_000,
  spansPerOperation: 4,
  bytesPerSpan: 1_200,
  logEntriesPerOperation: 3,
  bytesPerLogEntry: 900,
  auditRecordsPerOperation: 5,
  bytesPerAuditRecord: 400,
  metricPointsPerSeriesPerDay: 1_440,
  bytesPerMetricPoint: 40,
  traceSamplingRate: 0.01,
};

export interface VolumeLine {
  readonly signal: string;
  readonly bytesPerDay: number;
  readonly gibPerDay: number;
  /** Whether sampling reduces this signal. */
  readonly sampleable: boolean;
  readonly note: string;
}

function gib(bytes: number): number {
  // Three decimals, because the metric line is small enough that two would
  // print zero — and "free" is the thing that line is there to show.
  return Math.round((bytes / 1_073_741_824) * 1000) / 1000;
}

export function telemetryVolume(a: VolumeAssumptions = DEFAULT_ASSUMPTIONS): VolumeLine[] {
  const tracesUnsampled = a.operationsPerDay * a.spansPerOperation * a.bytesPerSpan;
  const traces = tracesUnsampled * a.traceSamplingRate;
  const logs = a.operationsPerDay * a.logEntriesPerOperation * a.bytesPerLogEntry;
  const audit = a.operationsPerDay * a.auditRecordsPerOperation * a.bytesPerAuditRecord;
  const metrics = totalDeclaredSeries() * a.metricPointsPerSeriesPerDay * a.bytesPerMetricPoint;

  return [
    {
      signal: `traces at ${Math.round(a.traceSamplingRate * 100)}% head sampling`,
      bytesPerDay: traces,
      gibPerDay: gib(traces),
      sampleable: true,
      note: `${gib(tracesUnsampled)} GiB/day unsampled; the sampler is the only lever`,
    },
    {
      signal: "structured logs",
      bytesPerDay: logs,
      gibPerDay: gib(logs),
      sampleable: true,
      note: "reducible by exclusion filters, at the cost of the investigation path",
    },
    {
      signal: "audit records",
      bytesPerDay: audit,
      gibPerDay: gib(audit),
      sampleable: false,
      note: "not sampleable; this is the evidence a dispute or an auditor asks for",
    },
    {
      signal: "metrics",
      bytesPerDay: metrics,
      gibPerDay: gib(metrics),
      sampleable: false,
      note: `${totalDeclaredSeries()} declared series; bounded by the catalogue, not by traffic`,
    },
  ];
}

export interface VolumeSummary {
  readonly lines: VolumeLine[];
  readonly totalGibPerDay: number;
  readonly sampleableGibPerDay: number;
  readonly fixedGibPerDay: number;
  /** The headline: metrics are flat in traffic, traces are not. */
  readonly seriesIndependentOfTraffic: number;
}

export function summariseVolume(a: VolumeAssumptions = DEFAULT_ASSUMPTIONS): VolumeSummary {
  const lines = telemetryVolume(a);
  const total = lines.reduce((acc, l) => acc + l.gibPerDay, 0);
  const sampleable = lines.filter((l) => l.sampleable).reduce((acc, l) => acc + l.gibPerDay, 0);
  return {
    lines,
    totalGibPerDay: Math.round(total * 1000) / 1000,
    sampleableGibPerDay: Math.round(sampleable * 1000) / 1000,
    fixedGibPerDay: Math.round((total - sampleable) * 1000) / 1000,
    seriesIndependentOfTraffic: totalDeclaredSeries(),
  };
}
