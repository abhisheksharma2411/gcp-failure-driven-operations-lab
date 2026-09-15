// Negative controls: remove one mechanism, show the property breaks.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAnchor, validate } from "../src/graph.ts";
import { COMPONENTS, DESIGNED_STEPS, NAIVE_STEPS } from "../src/scenarios.ts";
import { requestGrant, rolesAt, type Entitlement } from "../src/breakglass.ts";
import type { Component } from "../src/types.ts";

test("N1 without the transitive walk, the Meta failure is invisible", () => {
  // A validator that only checks DIRECT dependencies sees nothing wrong with
  // "restore DNS using the bastion", because the bastion is not DNS.
  const byId = new Map(COMPONENTS.map((c) => [c.id, c]));
  const step = NAIVE_STEPS.find((s) => s.id === "restore-dns")!;

  const directOnly = step.uses.filter((id) => byId.get(id)?.inDomains.includes(step.repairs));
  const transitive = validate(COMPONENTS, [step]).findings
    .filter((f) => f.kind === "CIRCULAR_DEPENDENCY");

  // Direct inspection finds some, but the multi-hop chains are what matter.
  assert.ok(
    transitive.length > directOnly.length,
    `transitive walk should find more than direct inspection: ${transitive.length} vs ${directOnly.length}`,
  );
  assert.ok(transitive.some((f) => f.path.length > 1), "expected a multi-hop chain");
});

test("N2 renaming a dependency does not make it independent", () => {
  // Two differently-named tools, both resting on the same broken thing.
  const comps: Component[] = [
    { id: "corp-dns", inDomains: ["network"], dependsOn: [] },
    { id: "runbook-wiki", inDomains: [], dependsOn: ["corp-dns"] },
    { id: "incident-chat", inDomains: [], dependsOn: ["corp-dns"] },
  ];
  const byId = new Map(comps.map((c) => [c.id, c]));
  assert.equal(isAnchor("runbook-wiki", byId), false);
  assert.equal(isAnchor("incident-chat", byId), false);

  const r = validate(comps, [
    { id: "fix", description: "", repairs: "network", uses: ["runbook-wiki", "incident-chat"] },
  ]);
  assert.equal(r.ok, false);
});

test("N3 designed steps stop being safe the moment one dependency moves", () => {
  // Put the out-of-band console behind the primary identity provider, which is
  // the single most common way a recovery path quietly stops being one.
  const broken = COMPONENTS.map((c) =>
    c.id === "recovery-idp" ? { ...c, dependsOn: ["identity-provider"] } : c);

  assert.equal(validate(COMPONENTS, DESIGNED_STEPS).ok, true);
  const after = validate(broken, DESIGNED_STEPS);
  assert.equal(after.ok, false, "moving one edge should break the whole recovery plane");
  assert.ok(after.findings.some((f) => f.path.includes("identity-provider")));
});

test("N4 without expiry, emergency privilege becomes permanent privilege", () => {
  const e: Entitlement = {
    id: "e", requesters: ["r@example"], roles: ["roles/owner"],
    maxDurationMs: 60 * 60 * 1000, requiresApproval: false, approvers: [],
  };
  const g = requestGrant(e, {
    entitlementId: "e", requester: "r@example", justification: "INC-1",
    durationMs: 60 * 60 * 1000, atMs: 0,
  });
  assert.equal(g.outcome, "GRANTED");
  // With expiry: gone after an hour.
  assert.deepEqual(rolesAt(g, 61 * 60 * 1000), []);
  // Without it, the same roles would still be held a week later. Modelled by
  // reading the grant's roles directly rather than through rolesAt().
  assert.deepEqual(g.roles, ["roles/owner"]);
});

test("N5 without dual control, one compromised account is the whole recovery plane", () => {
  const withApproval: Entitlement = {
    id: "e", requesters: ["r@example"], roles: ["roles/owner"],
    maxDurationMs: 3600_000, requiresApproval: true, approvers: ["m@example"],
  };
  const without: Entitlement = { ...withApproval, requiresApproval: false };
  const bare = {
    entitlementId: "e", requester: "r@example", justification: "INC-1",
    durationMs: 3600_000, atMs: 0,
  };
  assert.equal(requestGrant(withApproval, bare).outcome, "DENIED");
  assert.equal(requestGrant(without, bare).outcome, "GRANTED");
});

test("N6 a denied request still produces a record", () => {
  const e: Entitlement = {
    id: "e", requesters: ["r@example"], roles: ["roles/owner"],
    maxDurationMs: 3600_000, requiresApproval: true, approvers: ["m@example"],
  };
  const g = requestGrant(e, {
    entitlementId: "e", requester: "attacker@example", justification: "",
    durationMs: 3600_000, atMs: 42,
  });
  assert.equal(g.outcome, "DENIED");
  assert.equal(g.auditRecord.requester, "attacker@example");
  assert.equal(g.auditRecord.atMs, 42);
});
