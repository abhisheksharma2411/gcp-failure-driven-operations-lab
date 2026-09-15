import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requestGrant, rolesAt, type Entitlement, type GrantRequest } from "../src/breakglass.ts";

const ENTITLEMENT: Entitlement = {
  id: "emergency-network-admin",
  requesters: ["responder@example", "oncall@example"],
  roles: ["roles/compute.networkAdmin"],
  maxDurationMs: 60 * 60 * 1000,
  requiresApproval: true,
  approvers: ["duty-manager@example", "oncall@example"],
};

const req = (over: Partial<GrantRequest> = {}): GrantRequest => ({
  entitlementId: ENTITLEMENT.id,
  requester: "responder@example",
  justification: "INC-1234 backbone unreachable",
  durationMs: 30 * 60 * 1000,
  approvedBy: "duty-manager@example",
  atMs: 0,
  ...over,
});

test("T12 a valid, approved, justified request is granted", () => {
  const g = requestGrant(ENTITLEMENT, req());
  assert.equal(g.outcome, "GRANTED");
  assert.deepEqual(g.roles, ["roles/compute.networkAdmin"]);
});

test("T13 an unlisted requester is denied", () => {
  const g = requestGrant(ENTITLEMENT, req({ requester: "stranger@example" }));
  assert.equal(g.outcome, "DENIED");
});

test("T14 an unapproved request is denied", () => {
  const g = requestGrant(ENTITLEMENT, req({ approvedBy: undefined }));
  assert.equal(g.outcome, "DENIED");
  assert.ok(g.reason.includes("approval"));
});

test("T15 self-approval is not dual control", () => {
  // oncall@example is both a valid requester and a valid approver, which is a
  // realistic configuration and a real hole.
  const g = requestGrant(ENTITLEMENT, req({ requester: "oncall@example", approvedBy: "oncall@example" }));
  assert.equal(g.outcome, "DENIED");
  assert.ok(g.reason.includes("self-approval"));
});

test("T16 a request without justification is denied", () => {
  const g = requestGrant(ENTITLEMENT, req({ justification: "   " }));
  assert.equal(g.outcome, "DENIED");
});

test("T17 a request exceeding the maximum duration is denied", () => {
  const g = requestGrant(ENTITLEMENT, req({ durationMs: 24 * 60 * 60 * 1000 }));
  assert.equal(g.outcome, "DENIED");
  assert.ok(g.reason.includes("duration"));
});

test("T18 privilege expires without anyone remembering to revoke it", () => {
  const g = requestGrant(ENTITLEMENT, req());
  assert.deepEqual(rolesAt(g, 29 * 60 * 1000), ["roles/compute.networkAdmin"]);
  assert.deepEqual(rolesAt(g, 31 * 60 * 1000), []);
});

test("T19 an audit record is written whether the request is granted or denied", () => {
  const granted = requestGrant(ENTITLEMENT, req());
  const denied = requestGrant(ENTITLEMENT, req({ requester: "stranger@example" }));
  for (const g of [granted, denied]) {
    assert.equal(g.auditRecord.entitlementId, ENTITLEMENT.id);
    assert.ok(g.auditRecord.requester.length > 0);
    assert.equal(typeof g.auditRecord.atMs, "number");
  }
  assert.equal(denied.auditRecord.outcome, "DENIED");
  assert.equal(granted.auditRecord.outcome, "GRANTED");
});

test("T20 the recovery path cannot become a daily path", () => {
  // Every grant is bounded, so continuous use requires continuous, justified,
  // approved, individually-logged requests. The cost of abusing the path is
  // that it is extremely visible.
  const day = 24 * 60 * 60 * 1000;
  const grants = Array.from({ length: 24 }, (_, i) =>
    requestGrant(ENTITLEMENT, req({ atMs: i * 60 * 60 * 1000 })));
  assert.ok(grants.every((g) => g.outcome === "GRANTED"));
  // ...but none of them covers the whole day, and each left a record.
  assert.ok(grants.every((g) => (g.expiresAtMs ?? 0) - g.auditRecord.atMs <= ENTITLEMENT.maxDurationMs));
  assert.equal(new Set(grants.map((g) => g.auditRecord.atMs)).size, 24);
  const covered = grants.reduce((acc, g) => acc + ((g.expiresAtMs ?? 0) - g.auditRecord.atMs), 0);
  assert.ok(covered < day, "bounded grants should not silently cover a whole day");
});
