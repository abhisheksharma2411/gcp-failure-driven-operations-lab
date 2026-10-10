// A local model of OpenTelemetry tracing: spans, a propagated context, and a
// head sampler keyed on the trace ID.
//
// This is not the OpenTelemetry SDK. It reproduces the parts of the model the
// article argues about — context propagation across service boundaries, the
// W3C `traceparent` carrier, and the consequence of a head sampling decision —
// and nothing else. Every departure is listed in ../../docs/MODEL.md.
//
// Determinism: no clock. Every function that needs the time takes it as a
// parameter, and IDs are derived from a seeded counter rather than randomness,
// so `make report` is byte-identical on re-run.

/** The services the synthetic flow runs across. */
export type ServiceName =
  | "checkout-api"
  | "provider-gateway"
  | "ledger-poster"
  | "settlement-importer";

export interface SpanAttributes {
  /** Low-cardinality. Safe on a metric label. */
  readonly [key: string]: string | number | boolean;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly service: ServiceName;
  readonly name: string;
  readonly startedAtMs: number;
  endedAtMs: number | null;
  status: "UNSET" | "OK" | "ERROR";
  readonly attributes: Record<string, string | number | boolean>;
  /** Whether the sampler chose to export this span. */
  readonly sampled: boolean;
}

/**
 * The context that crosses a service boundary.
 *
 * OpenTelemetry's default propagator carries this in the `traceparent` header
 * defined by W3C Trace Context. The sampling flag travels with it, which is
 * why a head sampling decision made at the edge binds every downstream span.
 */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

/** Serialise to the W3C `traceparent` form: version-traceid-spanid-flags. */
export function toTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/** Parse a `traceparent` header. Returns null when it is malformed. */
export function fromTraceparent(header: string): TraceContext | null {
  const parts = header.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version !== "00") return null;
  if (!traceId || traceId.length !== 32 || !spanId || spanId.length !== 16) return null;
  if (flags !== "00" && flags !== "01") return null;
  return { traceId, spanId, sampled: flags === "01" };
}

/**
 * Head sampling, modelled on consistent probability sampling.
 *
 * The decision is a function of the trace ID alone, so every service reaches
 * the same answer without coordinating, and whole traces are kept or dropped
 * rather than fragments of them. The cost is the one the OpenTelemetry
 * documentation names: the decision cannot depend on anything that has not
 * happened yet, including whether the trace will end in an error.
 */
export function headSample(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let acc = 0;
  for (let i = 0; i < traceId.length; i += 1) acc = (acc * 31 + traceId.charCodeAt(i)) % 100003;
  return acc / 100003 < rate;
}

/** Deterministic ID generation. Seeded, not random: see the header comment. */
export class IdFactory {
  seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  private next(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed;
  }

  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.next().toString(16).padStart(8, "0");
    return out.slice(0, length);
  }

  traceId(): string {
    return this.hex(32);
  }

  spanId(): string {
    return this.hex(16);
  }
}

/**
 * Collects spans in memory.
 *
 * `exported` holds what a backend would have received; `all` holds everything
 * the process created. The gap between them is the point of scenario S07: a
 * span that was never exported cannot be evidence of anything.
 */
export class Tracer {
  readonly all: Span[];
  readonly ids: IdFactory;
  samplingRate: number;
  /** When false, the export pipeline is down and nothing reaches the backend. */
  exportAvailable: boolean;
  droppedByExportFailure: number;

  constructor(options: { seed: number; samplingRate: number }) {
    this.all = [];
    this.ids = new IdFactory(options.seed);
    this.samplingRate = options.samplingRate;
    this.exportAvailable = true;
    this.droppedByExportFailure = 0;
  }

  startRootSpan(
    service: ServiceName,
    name: string,
    atMs: number,
    attributes: Record<string, string | number | boolean>,
  ): Span {
    const traceId = this.ids.traceId();
    const sampled = headSample(traceId, this.samplingRate);
    return this.push({
      traceId,
      spanId: this.ids.spanId(),
      parentSpanId: null,
      service,
      name,
      startedAtMs: atMs,
      endedAtMs: null,
      status: "UNSET",
      attributes: { ...attributes },
      sampled,
    });
  }

  startChildSpan(
    parent: TraceContext,
    service: ServiceName,
    name: string,
    atMs: number,
    attributes: Record<string, string | number | boolean>,
  ): Span {
    return this.push({
      traceId: parent.traceId,
      spanId: this.ids.spanId(),
      parentSpanId: parent.spanId,
      service,
      name,
      startedAtMs: atMs,
      endedAtMs: null,
      status: "UNSET",
      // The sampling flag arrived with the context. The child does not get a vote.
      attributes: { ...attributes },
      sampled: parent.sampled,
    });
  }

  private push(span: Span): Span {
    this.all.push(span);
    return span;
  }

  end(span: Span, atMs: number, status: "OK" | "ERROR"): void {
    span.endedAtMs = atMs;
    span.status = status;
  }

  contextOf(span: Span): TraceContext {
    return { traceId: span.traceId, spanId: span.spanId, sampled: span.sampled };
  }

  /** What a tracing backend would actually hold. */
  exported(): Span[] {
    if (!this.exportAvailable) {
      return [];
    }
    return this.all.filter((s) => s.sampled);
  }

  /** Simulate the export pipeline going away mid-run. */
  setExportAvailable(available: boolean): void {
    if (!available) this.droppedByExportFailure += this.all.filter((s) => s.sampled).length;
    this.exportAvailable = available;
  }

  /** Every span of one trace, in creation order. */
  trace(traceId: string): Span[] {
    return this.all.filter((s) => s.traceId === traceId);
  }

  /** Distinct services a trace touched. */
  servicesInTrace(traceId: string): ServiceName[] {
    const seen: ServiceName[] = [];
    for (const s of this.trace(traceId)) if (!seen.includes(s.service)) seen.push(s.service);
    return seen;
  }
}
