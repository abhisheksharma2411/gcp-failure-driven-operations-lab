// A metric registry that refuses high-cardinality labels at the point of write.
//
// Cloud Monitoring's metric model is explicit about which values must never
// become label values, and the failure mode is not a warning: it is a bill, a
// slow query, and eventually a metric that cannot be read at all. The guard
// here turns that guidance into a build-time contract: every metric declares
// the complete set of values each of its labels may take, and a write carrying
// anything else throws.
//
// The identifiers an investigator actually needs — operation ID, provider
// operation ID, journal ID — are therefore absent from metrics by
// construction. They live on spans, in structured logs, and in audit records,
// which is where an unbounded identifier belongs.

export type MetricKind = "counter" | "gauge" | "distribution";

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly description: string;
  readonly unit: string;
  /** Label name -> the complete, closed set of values it may take. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
}

export class CardinalityError extends Error {
  readonly metric: string;
  readonly label: string;
  readonly value: string;

  constructor(metric: string, label: string, value: string, reason: string) {
    super(`${metric}: label ${label} ${reason} (value: ${value})`);
    this.name = "CardinalityError";
    this.metric = metric;
    this.label = label;
    this.value = value;
  }
}

/** The maximum number of distinct series a single metric may produce. */
export function declaredCardinality(def: MetricDefinition): number {
  let total = 1;
  for (const values of Object.values(def.labels)) total *= values.length;
  return total;
}

export interface MetricPoint {
  readonly metric: string;
  readonly labels: Readonly<Record<string, string>>;
  value: number;
  /** For distributions: every observation, so a percentile can be computed. */
  readonly observations: number[];
}

export class MetricRegistry {
  readonly definitions: Map<string, MetricDefinition>;
  readonly series: Map<string, MetricPoint>;
  /** Set false to model the metric pipeline being unavailable. */
  available: boolean;
  droppedWhileUnavailable: number;
  /** When false, label values are accepted unchecked. Negative control only. */
  guardEnabled: boolean;
  readonly rejected: { metric: string; label: string }[];

  constructor(definitions: readonly MetricDefinition[], options?: { guardEnabled?: boolean }) {
    this.definitions = new Map(definitions.map((d) => [d.name, d]));
    this.series = new Map();
    this.available = true;
    this.droppedWhileUnavailable = 0;
    this.guardEnabled = options?.guardEnabled !== false;
    this.rejected = [];
  }

  private check(def: MetricDefinition, labels: Record<string, string>): void {
    if (!this.guardEnabled) return;
    const declared = Object.keys(def.labels).sort().join(",");
    const supplied = Object.keys(labels).sort().join(",");
    if (declared !== supplied) {
      throw new CardinalityError(def.name, supplied || "(none)", supplied, `set does not match the declared set [${declared}]`);
    }
    for (const [label, value] of Object.entries(labels)) {
      const allowed = def.labels[label];
      if (!allowed || !allowed.includes(value)) {
        this.rejected.push({ metric: def.name, label });
        throw new CardinalityError(def.name, label, value, "is not one of the declared values");
      }
    }
  }

  private key(name: string, labels: Record<string, string>): string {
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return `${name}{${parts.join(",")}}`;
  }

  private point(name: string, labels: Record<string, string>): MetricPoint | null {
    const def = this.definitions.get(name);
    if (!def) throw new Error(`metric ${name} is not declared`);
    this.check(def, labels);
    if (!this.available) {
      this.droppedWhileUnavailable += 1;
      return null;
    }
    const key = this.key(name, labels);
    let point = this.series.get(key);
    if (!point) {
      point = { metric: name, labels: { ...labels }, value: 0, observations: [] };
      this.series.set(key, point);
    }
    return point;
  }

  increment(name: string, labels: Record<string, string>, by = 1): void {
    const p = this.point(name, labels);
    if (p) p.value += by;
  }

  set(name: string, labels: Record<string, string>, value: number): void {
    const p = this.point(name, labels);
    if (p) p.value = value;
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const p = this.point(name, labels);
    if (p) {
      p.observations.push(value);
      p.value = p.observations.length;
    }
  }

  read(name: string, labels: Record<string, string>): number {
    return this.series.get(this.key(name, labels))?.value ?? 0;
  }

  /** Sum across every series of a metric, optionally filtered by some labels. */
  sum(name: string, filter: Record<string, string> = {}): number {
    let total = 0;
    for (const p of this.series.values()) {
      if (p.metric !== name) continue;
      if (Object.entries(filter).every(([k, v]) => p.labels[k] === v)) total += p.value;
    }
    return total;
  }

  /** Nearest-rank percentile over a distribution metric's observations. */
  percentile(name: string, filter: Record<string, string>, p: number): number {
    const all: number[] = [];
    for (const point of this.series.values()) {
      if (point.metric !== name) continue;
      if (Object.entries(filter).every(([k, v]) => point.labels[k] === v)) all.push(...point.observations);
    }
    if (all.length === 0) return 0;
    all.sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * all.length));
    return all[rank - 1] ?? 0;
  }

  /** Series actually created. Compare against declaredCardinality for drift. */
  activeSeries(): number {
    return this.series.size;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }
}
