import test from "node:test";
import assert from "node:assert/strict";

import { Tracer, toTraceparent, fromTraceparent, headSample, IdFactory } from "../src/telemetry/trace.ts";
import { StructuredLog, redactPayload, pseudonym, DENIED_FIELDS } from "../src/telemetry/logs.ts";
import { MetricRegistry, CardinalityError, declaredCardinality } from "../src/telemetry/metrics.ts";
import { AuditTrail } from "../src/telemetry/audit.ts";
import { METRICS, INVESTIGATION_KEYS, totalDeclaredSeries } from "../src/signals.ts";
import { SYNTHETIC_PAN, SYNTHETIC_EMAIL } from "../src/domain/fixtures.ts";

const T0 = Date.UTC(2026, 0, 5);

test("traceparent round-trips and rejects malformed carriers", () => {
  const ctx = { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true };
  assert.equal(toTraceparent(ctx), `00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  assert.deepEqual(fromTraceparent(toTraceparent(ctx)), ctx);
  assert.equal(fromTraceparent("garbage"), null);
  assert.equal(fromTraceparent("01-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01"), null);
  assert.equal(fromTraceparent("00-short-" + "b".repeat(16) + "-01"), null);
});

test("a child span inherits the trace and the sampling decision, not a new one", () => {
  const tracer = new Tracer({ seed: 1, samplingRate: 0 });
  const root = tracer.startRootSpan("checkout-api", "POST /payments", T0, {});
  assert.equal(root.sampled, false);
  const child = tracer.startChildSpan(tracer.contextOf(root), "provider-gateway", "POST /capture", T0 + 1, {});
  assert.equal(child.traceId, root.traceId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(child.sampled, false, "the child must not re-roll the sampling decision");
});

test("head sampling is a function of the trace id alone", () => {
  const ids = new IdFactory(99);
  const traceId = ids.traceId();
  assert.equal(headSample(traceId, 0.5), headSample(traceId, 0.5));
  assert.equal(headSample(traceId, 1), true);
  assert.equal(headSample(traceId, 0), false);
});

test("an unavailable export pipeline makes every span invisible, not absent", () => {
  const tracer = new Tracer({ seed: 2, samplingRate: 1 });
  tracer.startRootSpan("checkout-api", "POST /payments", T0, {});
  assert.equal(tracer.exported().length, 1);
  tracer.setExportAvailable(false);
  assert.equal(tracer.exported().length, 0);
  assert.equal(tracer.all.length, 1, "the process still created the span");
});

test("redaction removes denied field names and denied-looking values", () => {
  const out = redactPayload({
    amountMinor: 1000,
    pan: SYNTHETIC_PAN,
    note: `contact ${SYNTHETIC_EMAIL} about card ${SYNTHETIC_PAN}`,
    nested: { cvv: "123", ok: "fine" },
  });
  const text = JSON.stringify(out);
  assert.equal(out.amountMinor, 1000);
  assert.ok(!text.includes(SYNTHETIC_PAN));
  assert.ok(!text.includes(SYNTHETIC_EMAIL));
  assert.ok(!text.includes('"123"'));
  assert.equal((out.nested as Record<string, unknown>).ok, "fine");
});

test("the same denied value produces the same marker, and the marker is not the value", () => {
  const a = pseudonym(SYNTHETIC_PAN);
  const b = pseudonym(SYNTHETIC_PAN);
  assert.equal(a, b);
  assert.notEqual(a, SYNTHETIC_PAN);
  assert.ok(a.startsWith("redacted:"));
});

test("every denied field name is actually denied", () => {
  for (const field of DENIED_FIELDS) {
    const out = redactPayload({ [field]: "sensitive-value-here" });
    assert.ok(!JSON.stringify(out).includes("sensitive-value-here"), `${field} leaked`);
  }
});

test("a log entry keeps its correlation keys after redaction", () => {
  const log = new StructuredLog();
  log.write({
    atMs: T0,
    severity: "INFO",
    service: "checkout-api",
    message: "intent",
    correlation: { operationId: "op-1", businessRef: "order-1", traceId: "t", spanId: "s" },
    payload: { pan: SYNTHETIC_PAN },
  });
  const entry = log.byOperation("op-1")[0];
  assert.ok(entry);
  assert.equal(entry.correlation.traceId, "t");
  assert.ok(!JSON.stringify(entry.payload).includes(SYNTHETIC_PAN));
});

test("the cardinality guard refuses an undeclared label value", () => {
  const registry = new MetricRegistry(METRICS);
  assert.throws(
    () => registry.increment("money.effects.applied", { currency: "op-12345" }),
    CardinalityError,
  );
  assert.equal(registry.activeSeries(), 0, "the refused write must create no series");
});

test("the cardinality guard refuses a label set that does not match the declaration", () => {
  const registry = new MetricRegistry(METRICS);
  assert.throws(
    () => registry.increment("money.effects.applied", { currency: "EUR", operationId: "op-1" }),
    CardinalityError,
  );
});

test("no declared label is an investigation key", () => {
  for (const metric of METRICS) {
    for (const label of Object.keys(metric.labels)) {
      assert.ok(
        !INVESTIGATION_KEYS.includes(label),
        `${metric.name} declares ${label}, which is an investigation key`,
      );
    }
  }
});

test("the whole catalogue has a bounded series ceiling", () => {
  for (const metric of METRICS) {
    assert.ok(declaredCardinality(metric) <= 64, `${metric.name} declares too many series`);
  }
  assert.ok(totalDeclaredSeries() < 200, "the catalogue should stay small enough to read");
});

test("an unavailable metric pipeline drops writes without throwing", () => {
  const registry = new MetricRegistry(METRICS);
  registry.setAvailable(false);
  registry.increment("money.effects.applied", { currency: "EUR" });
  assert.equal(registry.activeSeries(), 0);
  assert.equal(registry.droppedWhileUnavailable, 1);
});

test("the audit trail is append-only and reconstructs a timeline", () => {
  const audit = new AuditTrail();
  audit.append({
    atMs: T0,
    action: "intent.recorded",
    operationId: "op-1",
    businessRef: "order-1",
    traceId: "t",
    providerOpId: null,
    journalId: null,
    settlementId: null,
    amountMinor: 100,
    currency: "EUR",
    actor: "checkout-api",
    detail: "admitted",
  });
  audit.append({
    atMs: T0 + 1,
    action: "provider.effect",
    operationId: "op-1",
    businessRef: "order-1",
    traceId: "t",
    providerOpId: "prov-1",
    journalId: null,
    settlementId: null,
    amountMinor: 100,
    currency: "EUR",
    actor: "provider",
    detail: "captured",
  });
  assert.equal(audit.records.length, 2);
  assert.deepEqual(
    audit.records.map((r) => r.sequence),
    [1, 2],
  );
  assert.equal(audit.timeline("op-1").length, 2);
  assert.equal(audit.byTrace("t").length, 2);
  assert.ok(!("update" in audit));
});
