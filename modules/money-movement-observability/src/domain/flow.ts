// The instrumented money-movement flow.
//
// Four services, one logical operation, and every signal emitted on the way
// through: a span per hop with the context propagated between them, a
// structured log line with the correlation keys, a low-cardinality metric, and
// an audit record for anything that touches money.
//
// Faults are injected by flags rather than by editing the code, so a scenario
// is a data structure and the same instrumented path runs in every case. That
// matters: a fault-injection harness that takes a different code path from
// production proves something about the harness.

import { Tracer } from "../telemetry/trace.ts";
import type { Span, TraceContext } from "../telemetry/trace.ts";
import { toTraceparent, fromTraceparent } from "../telemetry/trace.ts";
import { StructuredLog } from "../telemetry/logs.ts";
import { MetricRegistry } from "../telemetry/metrics.ts";
import { AuditTrail } from "../telemetry/audit.ts";
import { METRICS } from "../signals.ts";
import { emptyWorld, DEFAULT_BUDGETS } from "./types.ts";
import type {
  Budgets,
  Currency,
  Operation,
  PostingGroup,
  PostingLeg,
  ProviderEffect,
  World,
} from "./types.ts";

export interface Faults {
  /** The provider captured; the gateway never saw the response. */
  readonly lostClientResponse?: boolean;
  /** The ledger-poster receives the same event twice. */
  readonly duplicateDelivery?: boolean;
  /** The ledger-poster never runs. The operation sits in CAPTURED. */
  readonly stuckOperation?: boolean;
  /** The fee branch posts two legs where it needs three. The headline fault. */
  readonly dropFeeLeg?: boolean;
  /** Settlement evidence never arrives. */
  readonly settlementStalled?: boolean;
  /** Metrics, logs or traces stop reaching the backend. */
  readonly telemetryDown?: "metrics" | "logs" | "traces";
  /** Force the head sampler to drop this trace. */
  readonly forceUnsampled?: boolean;
  /** Publish SUCCEEDED to the customer regardless of the provider outcome. */
  readonly optimisticStatus?: boolean;
  /** The checkout API refuses the request outright. */
  readonly apiRejects?: boolean;
  /** The checkout API answers, slowly. */
  readonly slowCheckout?: boolean;
  /** The provider declines. No money moves. */
  readonly providerDeclined?: boolean;
  /** A retry carrying a fresh key produces a second provider effect. */
  readonly duplicateEffect?: boolean;
  /** The posting group references a provider effect nobody recorded. */
  readonly orphanPosting?: boolean;
  /** The posting balances and credits the wrong amount. */
  readonly postingMismatch?: boolean;
}

export interface PaymentRequest {
  readonly operationId: string;
  readonly businessRef: string;
  readonly amountMinor: number;
  readonly currency: Currency;
  /** Present only to prove the redaction path removes it. Synthetic. */
  readonly customerEmail?: string;
  readonly pan?: string;
}

export interface PipelineOptions {
  readonly seed?: number;
  readonly samplingRate?: number;
  readonly budgets?: Budgets;
  /** Negative controls switch these off. Production never does. */
  readonly redactionEnabled?: boolean;
  readonly cardinalityGuardEnabled?: boolean;
}

/** The provider's fee schedule. Fixed, so the arithmetic stays checkable. */
export function feeFor(amountMinor: number): number {
  return Math.round(amountMinor * 0.019) + 25;
}

export class Pipeline {
  readonly tracer: Tracer;
  readonly log: StructuredLog;
  readonly metrics: MetricRegistry;
  readonly audit: AuditTrail;
  readonly world: World;
  readonly budgets: Budgets;
  private counter: number;
  /** Events the ledger poster has already processed, by event id. */
  private readonly inbox: Set<string>;

  constructor(options: PipelineOptions = {}) {
    this.tracer = new Tracer({ seed: options.seed ?? 20260109, samplingRate: options.samplingRate ?? 1 });
    this.log = new StructuredLog({ redactionEnabled: options.redactionEnabled !== false });
    this.metrics = new MetricRegistry(METRICS, { guardEnabled: options.cardinalityGuardEnabled !== false });
    this.audit = new AuditTrail();
    this.world = emptyWorld();
    this.budgets = options.budgets ?? DEFAULT_BUDGETS;
    this.counter = 0;
    this.inbox = new Set();
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter.toString().padStart(4, "0")}`;
  }

  private applyTelemetryFault(faults: Faults): void {
    this.metrics.setAvailable(faults.telemetryDown !== "metrics");
    this.log.available = faults.telemetryDown !== "logs";
    this.tracer.setExportAvailable(faults.telemetryDown !== "traces");
  }

  /**
   * Run one payment end to end.
   *
   * `atMs` is the time the customer's request arrived. Later steps advance
   * from it by fixed offsets so that latency is a property of the scenario
   * rather than of the machine the test runs on.
   */
  submit(request: PaymentRequest, atMs: number, faults: Faults = {}): Operation {
    this.applyTelemetryFault(faults);
    if (faults.forceUnsampled) this.tracer.samplingRate = 0;

    // --- checkout-api ------------------------------------------------------
    const root = this.tracer.startRootSpan("checkout-api", "POST /payments", atMs, {
      "service.name": "checkout-api",
      "payment.currency": request.currency,
    });
    const operation: Operation = {
      operationId: request.operationId,
      businessRef: request.businessRef,
      amountMinor: request.amountMinor,
      currency: request.currency,
      createdAtMs: atMs,
      traceId: root.traceId,
      state: "INTENT",
      stateSinceMs: atMs,
      customerStatus: "PROCESSING",
      providerOpId: null,
    };
    this.world.operations.set(operation.operationId, operation);

    this.log.write({
      atMs,
      severity: "INFO",
      service: "checkout-api",
      message: "payment intent recorded",
      correlation: {
        operationId: operation.operationId,
        businessRef: operation.businessRef,
        traceId: root.traceId,
        spanId: root.spanId,
      },
      payload: {
        amountMinor: request.amountMinor,
        currency: request.currency,
        customerEmail: request.customerEmail ?? "",
        pan: request.pan ?? "",
      },
    });
    this.audit.append({
      atMs,
      action: "intent.recorded",
      operationId: operation.operationId,
      businessRef: operation.businessRef,
      traceId: root.traceId,
      providerOpId: null,
      journalId: null,
      settlementId: null,
      amountMinor: request.amountMinor,
      currency: request.currency,
      actor: "checkout-api",
      detail: "customer request admitted",
    });
    if (faults.apiRejects) {
      // The honest failure: the request was refused, nothing happened, and the
      // customer was told so. Every signal agrees, which is what makes it the
      // easy case.
      this.metrics.increment("money.http.responses", { service: "checkout-api", class: "5xx" });
      this.metrics.observe("money.http.latency", { service: "checkout-api", route: "POST /payments" }, 38);
      this.tracer.end(root, atMs + 38, "ERROR");
      this.transition(operation, "FAILED_FINAL", atMs + 38);
      this.publishStatus(operation, "FAILED", atMs + 38);
      return operation;
    }

    const checkoutLatency = faults.slowCheckout ? 1_400 : 42;
    this.metrics.increment("money.http.responses", { service: "checkout-api", class: "2xx" });
    this.metrics.observe("money.http.latency", { service: "checkout-api", route: "POST /payments" }, checkoutLatency);
    this.tracer.end(root, atMs + checkoutLatency, "OK");

    this.transition(operation, "PROVIDER_PENDING", atMs + checkoutLatency);

    // --- provider-gateway --------------------------------------------------
    const carrier = toTraceparent(this.tracer.contextOf(root));
    const captured = this.callProvider(operation, carrier, atMs + 50, faults);

    if (!captured) {
      // The provider's answer never arrived. The operation stays open.
      this.publishStatus(operation, faults.optimisticStatus === true ? "SUCCEEDED" : "PROCESSING", atMs + 120);
      return operation;
    }

    // --- ledger-poster -----------------------------------------------------
    const eventId = `evt-${captured.providerOpId}`;
    if (faults.stuckOperation) {
      // No consumer runs. The count of CAPTURED operations is 1, which looks
      // like nothing at all until somebody looks at its age.
      this.publishStatus(operation, "SUCCEEDED", atMs + 140);
      return operation;
    }
    this.deliver(eventId, captured, carrier, atMs + 200, faults);
    if (faults.duplicateDelivery) this.deliver(eventId, captured, carrier, atMs + 260, faults);

    this.publishStatus(operation, "SUCCEEDED", atMs + 300);

    // --- settlement-importer ----------------------------------------------
    if (!faults.settlementStalled) {
      this.importSettlement(captured, carrier, atMs + 3_600_000, faults);
    }

    return operation;
  }

  private transition(operation: Operation, to: Operation["state"], atMs: number): void {
    operation.state = to;
    operation.stateSinceMs = atMs;
  }

  private callProvider(
    operation: Operation,
    carrier: string,
    atMs: number,
    faults: Faults,
  ): ProviderEffect | null {
    const parent = fromTraceparent(carrier);
    if (!parent) throw new Error("trace context did not survive the hop");
    const span = this.tracer.startChildSpan(parent, "provider-gateway", "POST /capture", atMs, {
      "service.name": "provider-gateway",
      "payment.currency": operation.currency,
    });

    const effect: ProviderEffect = {
      providerOpId: this.nextId("prov"),
      operationId: operation.operationId,
      capturedMinor: operation.amountMinor,
      feeMinor: feeFor(operation.amountMinor),
      currency: operation.currency,
      atMs: atMs + 180,
    };

    if (faults.providerDeclined) {
      this.metrics.increment("money.provider.attempts", { outcome: "declined" });
      this.metrics.increment("money.http.responses", { service: "provider-gateway", class: "2xx" });
      this.metrics.observe("money.http.latency", { service: "provider-gateway", route: "POST /capture" }, 150);
      this.logHop(span, operation, "INFO", "provider declined", { providerOpId: null });
      this.tracer.end(span, atMs + 150, "OK");
      this.transition(operation, "FAILED_FINAL", atMs + 150);
      return null;
    }

    if (faults.lostClientResponse) {
      // The provider did the work. We never heard. This is the one case where
      // the technical signal is honest about there being a problem and still
      // tells you nothing about whether money moved.
      this.world.effects.push(effect);
      this.audit.append({
        atMs: effect.atMs,
        action: "provider.effect",
        operationId: operation.operationId,
        businessRef: operation.businessRef,
        traceId: span.traceId,
        providerOpId: effect.providerOpId,
        journalId: null,
        settlementId: null,
        amountMinor: effect.capturedMinor,
        currency: effect.currency,
        actor: "provider-simulator",
        detail: "captured; response to caller lost",
      });
      this.metrics.increment("money.provider.attempts", { outcome: "unknown" });
      this.metrics.increment("money.effects.applied", { currency: operation.currency });
      this.metrics.increment("money.http.responses", { service: "provider-gateway", class: "5xx" });
      this.metrics.observe("money.http.latency", { service: "provider-gateway", route: "POST /capture" }, 30_000);
      this.logHop(span, operation, "WARNING", "provider outcome unknown", { providerOpId: null });
      this.tracer.end(span, atMs + 30_000, "ERROR");
      this.transition(operation, "OUTCOME_UNKNOWN", atMs + 30_000);
      return null;
    }

    operation.providerOpId = effect.providerOpId;
    this.world.effects.push(effect);
    this.metrics.increment("money.provider.attempts", { outcome: "captured" });
    this.metrics.increment("money.effects.applied", { currency: operation.currency });
    this.metrics.increment("money.http.responses", { service: "provider-gateway", class: "2xx" });
    this.metrics.observe("money.http.latency", { service: "provider-gateway", route: "POST /capture" }, 180);
    this.logHop(span, operation, "INFO", "provider captured", { providerOpId: effect.providerOpId });
    this.audit.append({
      atMs: effect.atMs,
      action: "provider.effect",
      operationId: operation.operationId,
      businessRef: operation.businessRef,
      traceId: span.traceId,
      providerOpId: effect.providerOpId,
      journalId: null,
      settlementId: null,
      amountMinor: effect.capturedMinor,
      currency: effect.currency,
      actor: "provider-simulator",
      detail: `captured with fee ${effect.feeMinor}`,
    });
    if (faults.duplicateEffect) {
      // A retry that minted a fresh idempotency key. The provider has no way
      // to recognise it, so it captures again. Article 12 is the long version.
      const second: ProviderEffect = { ...effect, providerOpId: this.nextId("prov"), atMs: effect.atMs + 500 };
      this.world.effects.push(second);
      this.metrics.increment("money.provider.attempts", { outcome: "captured" });
      this.metrics.increment("money.effects.applied", { currency: operation.currency });
      this.audit.append({
        atMs: second.atMs,
        action: "provider.effect",
        operationId: operation.operationId,
        businessRef: operation.businessRef,
        traceId: span.traceId,
        providerOpId: second.providerOpId,
        journalId: null,
        settlementId: null,
        amountMinor: second.capturedMinor,
        currency: second.currency,
        actor: "provider-simulator",
        detail: "captured again under a regenerated key",
      });
    }

    this.tracer.end(span, effect.atMs, "OK");
    this.transition(operation, "CAPTURED", effect.atMs);
    return effect;
  }

  private deliver(
    eventId: string,
    effect: ProviderEffect,
    carrier: string,
    atMs: number,
    faults: Faults,
  ): void {
    const operation = this.world.operations.get(effect.operationId);
    if (!operation) throw new Error(`unknown operation ${effect.operationId}`);

    if (this.inbox.has(eventId)) {
      // Article 12's rule, applied: count effects, not arrivals. The duplicate
      // is visible as a metric and produces no second posting.
      this.metrics.increment("money.events.delivered", { outcome: "duplicate-suppressed" });
      return;
    }
    this.inbox.add(eventId);
    this.metrics.increment("money.events.delivered", { outcome: "processed" });

    const parent = fromTraceparent(carrier);
    if (!parent) throw new Error("trace context did not survive the hop");
    const span = this.tracer.startChildSpan(parent, "ledger-poster", "POST /postings", atMs, {
      "service.name": "ledger-poster",
      "payment.currency": effect.currency,
    });

    const group = this.post(effect, atMs, faults);
    this.world.postings.push(group);
    this.metrics.increment("money.http.responses", { service: "ledger-poster", class: "2xx" });
    this.metrics.observe("money.http.latency", { service: "ledger-poster", route: "POST /postings" }, 61);
    this.log.write({
      atMs,
      severity: "INFO",
      service: "ledger-poster",
      message: "posting group written",
      correlation: {
        operationId: operation.operationId,
        businessRef: operation.businessRef,
        traceId: span.traceId,
        spanId: span.spanId,
        providerOpId: effect.providerOpId,
        journalId: group.journalId,
      },
      payload: { legs: group.legs.length, currency: effect.currency },
    });
    this.audit.append({
      atMs,
      action: "ledger.posted",
      operationId: operation.operationId,
      businessRef: operation.businessRef,
      traceId: span.traceId,
      providerOpId: effect.providerOpId,
      journalId: group.journalId,
      settlementId: null,
      amountMinor: effect.capturedMinor,
      currency: effect.currency,
      actor: "ledger-poster",
      detail: `${group.legs.length} legs`,
    });
    this.tracer.end(span, atMs + 61, "OK");
    this.transition(operation, "POSTED", atMs + 61);
  }

  /**
   * Build the posting group for one captured effect.
   *
   * Three legs. The customer is owed the gross amount; the money arriving in
   * the bank is the gross amount less the provider's fee; the fee itself is an
   * expense. Debits equal credits, which is the whole of INV-1.
   *
   * The `dropFeeLeg` fault omits the expense leg. Nothing about the request
   * fails: the service returns 200, the span is OK, the customer is told the
   * payment succeeded, and the journal is short by exactly the fee.
   */
  private post(effect: ProviderEffect, atMs: number, faults: Faults): PostingGroup {
    const net = effect.capturedMinor - effect.feeMinor;
    const legs: PostingLeg[] = [
      { account: "cash-in-transit", direction: "DEBIT", amountMinor: net },
      { account: "processor-fees", direction: "DEBIT", amountMinor: effect.feeMinor },
      { account: "customer-payable", direction: "CREDIT", amountMinor: effect.capturedMinor },
    ];
    if (faults.dropFeeLeg) legs.splice(1, 1);
    if (faults.postingMismatch) {
      // Balanced and wrong: a rounding step shaved a unit off both sides, so
      // double entry is satisfied and the customer is credited the wrong
      // amount. INV-1 is silent here; INV-2 is not.
      legs.splice(0, legs.length,
        { account: "cash-in-transit", direction: "DEBIT", amountMinor: net - 100 },
        { account: "processor-fees", direction: "DEBIT", amountMinor: effect.feeMinor },
        { account: "customer-payable", direction: "CREDIT", amountMinor: effect.capturedMinor - 100 },
      );
    }
    return {
      journalId: this.nextId("jrnl"),
      operationId: effect.operationId,
      providerOpId: faults.orphanPosting ? "prov-replayed-from-backup" : effect.providerOpId,
      currency: effect.currency,
      legs,
      atMs,
      supersededByJournalId: null,
    };
  }

  private importSettlement(effect: ProviderEffect, carrier: string, atMs: number, _faults: Faults): void {
    const operation = this.world.operations.get(effect.operationId);
    if (!operation) return;
    const parent = fromTraceparent(carrier);
    if (!parent) throw new Error("trace context did not survive the hop");
    const span = this.tracer.startChildSpan(parent, "settlement-importer", "POST /settlements", atMs, {
      "service.name": "settlement-importer",
      "payment.currency": effect.currency,
    });
    const record = {
      settlementId: this.nextId("setl"),
      providerOpId: effect.providerOpId,
      netMinor: effect.capturedMinor - effect.feeMinor,
      currency: effect.currency,
      atMs,
    };
    this.world.settlements.push(record);
    this.metrics.increment("money.http.responses", { service: "settlement-importer", class: "2xx" });
    this.metrics.observe("money.http.latency", { service: "settlement-importer", route: "POST /settlements" }, 95);
    this.audit.append({
      atMs,
      action: "settlement.matched",
      operationId: operation.operationId,
      businessRef: operation.businessRef,
      traceId: span.traceId,
      providerOpId: effect.providerOpId,
      journalId: null,
      settlementId: record.settlementId,
      amountMinor: record.netMinor,
      currency: record.currency,
      actor: "settlement-importer",
      detail: "settlement evidence matched to effect",
    });
    this.tracer.end(span, atMs + 95, "OK");
    if (operation.state === "POSTED") this.transition(operation, "SETTLED", atMs + 95);
  }

  private publishStatus(operation: Operation, status: Operation["customerStatus"], atMs: number): void {
    operation.customerStatus = status;
    this.audit.append({
      atMs,
      action: "status.published",
      operationId: operation.operationId,
      businessRef: operation.businessRef,
      traceId: operation.traceId,
      providerOpId: operation.providerOpId,
      journalId: null,
      settlementId: null,
      amountMinor: null,
      currency: null,
      actor: "checkout-api",
      detail: `customer told ${status}`,
    });
  }

  private logHop(
    span: Span,
    operation: Operation,
    severity: "INFO" | "WARNING" | "ERROR",
    message: string,
    extra: { providerOpId: string | null },
  ): void {
    this.log.write({
      atMs: span.startedAtMs,
      severity,
      service: span.service,
      message,
      correlation: {
        operationId: operation.operationId,
        businessRef: operation.businessRef,
        traceId: span.traceId,
        spanId: span.spanId,
        ...(extra.providerOpId ? { providerOpId: extra.providerOpId } : {}),
      },
      payload: { currency: operation.currency },
    });
  }

  /** Open a reconciliation exception. Used by the backlog scenario. */
  openException(
    kind: ReconciliationKind,
    operationId: string | null,
    atMs: number,
  ): void {
    this.world.exceptions.push({
      exceptionId: this.nextId("exc"),
      kind,
      operationId,
      openedAtMs: atMs,
      resolvedAtMs: null,
    });
  }

  /** Record that a periodic checker completed. */
  recordCheckerRun(checker: string, atMs: number): void {
    this.world.checkerLastRunMs.set(checker, atMs);
  }

  /** The trace context a downstream caller would receive. For the tests. */
  contextForTrace(traceId: string): TraceContext | null {
    const root = this.tracer.all.find((s) => s.traceId === traceId && s.parentSpanId === null);
    return root ? this.tracer.contextOf(root) : null;
  }
}

type ReconciliationKind = "unmatched-effect" | "unmatched-settlement" | "amount-mismatch";
