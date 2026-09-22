import { test } from "node:test";
import assert from "node:assert/strict";
import { auditWeaknesses, resolveSink } from "../src/audit.ts";
import { flatZone, lockedZone, pavedZone, P_SENSITIVE, P_AUDIT, T0 } from "../src/scenarios.ts";

test("A1 a sink set at the organization covers every project under it", () => {
  const z = pavedZone();
  const sink = resolveSink(z.hierarchy, z.sinks, P_SENSITIVE);
  assert.ok(sink);
  assert.equal(sink.destinationProjectId, P_AUDIT);
});

test("A2 a flat estate writes its audit trail into the thing being audited", () => {
  const z = flatZone();
  const kinds = auditWeaknesses(z.hierarchy, z.sinks, "projects/app-prod", T0).map((w) => w.kind);
  assert.ok(kinds.includes("self-destination"));
  assert.ok(kinds.includes("no-retention-lock"));
  assert.ok(kinds.includes("shared-authority"));
});

test("A3 guardrails alone do not protect the audit trail", () => {
  // The locked zone passes every guardrail case in the suite. Its audit
  // records still sit where its administrators can reach them, because no
  // guardrail in the suite is about that, and nothing in the policy model
  // notices.
  const z = lockedZone();
  const w = auditWeaknesses(z.hierarchy, z.sinks, P_SENSITIVE, T0);
  const shared = w.find((x) => x.kind === "shared-authority");
  assert.ok(shared, "expected shared authority over the audit destination");
  assert.ok(shared.principals!.length >= 2);
});

test("A4 separating the audit folder removes the shared authority", () => {
  const z = pavedZone();
  const w = auditWeaknesses(z.hierarchy, z.sinks, P_SENSITIVE, T0);
  assert.deepEqual(w, [], `expected no weaknesses, got ${JSON.stringify(w)}`);
});

test("A5 independence is derived, not asserted", () => {
  // Granting one principal editor across both folders reintroduces the
  // weakness with no flag changed anywhere. A model that took a
  // `protected: true` field would still say the sink was fine.
  const z = pavedZone();
  z.hierarchy.addGrant({
    principal: "user:new-admin@example.com",
    role: "roles/editor",
    scope: "organizations/example",
    expiresAtMs: null,
  });
  const w = auditWeaknesses(z.hierarchy, z.sinks, P_SENSITIVE, T0);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.kind, "shared-authority");
  assert.deepEqual(w[0]!.principals, ["user:new-admin@example.com"]);
});

test("A6 a node with no sink above it is reported, not assumed fine", () => {
  const z = pavedZone();
  const w = auditWeaknesses(z.hierarchy, [], P_SENSITIVE, T0);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.kind, "no-sink");
});
