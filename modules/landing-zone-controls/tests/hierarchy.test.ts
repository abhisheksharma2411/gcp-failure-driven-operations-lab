import { test } from "node:test";
import assert from "node:assert/strict";
import { Hierarchy, HierarchyError } from "../src/hierarchy.ts";
import { describeEffectivePolicy } from "../src/policy.ts";

const ORG = "organizations/x";
const F = "folders/prod";
const P = "projects/app";

function base(): Hierarchy {
  return new Hierarchy()
    .addNode({ id: ORG, kind: "organization", parent: null })
    .addNode({ id: F, kind: "folder", parent: ORG })
    .addNode({ id: P, kind: "project", parent: F });
}

test("H1 the organization is the root and nothing sits above it", () => {
  const h = base();
  assert.deepEqual(h.ancestry(P), [P, F, ORG]);
  assert.equal(h.node(ORG).parent, null);
  assert.throws(
    () => h.addNode({ id: "organizations/y", kind: "organization", parent: null }),
    HierarchyError,
  );
});

test("H2 the hierarchy refuses shapes Resource Manager does not have", () => {
  const h = base();
  assert.throws(() => h.addNode({ id: "projects/b", kind: "project", parent: P }), HierarchyError);
  assert.throws(() => h.addNode({ id: "folders/b", kind: "folder", parent: "folders/nope" }), HierarchyError);
  assert.throws(() => h.addNode({ id: "projects/c", kind: "project", parent: null }), HierarchyError);
  assert.throws(() => h.addNode({ id: P, kind: "project", parent: F }), HierarchyError);
});

test("H3 a policy set high is inherited by every descendant", () => {
  const h = base();
  h.addPolicy({
    constraint: "publicExposure",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  const at = h.effectivePolicy(P, "publicExposure", 0);
  assert.ok(at);
  assert.equal(at.sourceNodeId, ORG);
  assert.equal(at.inherited, true);
  assert.deepEqual(at.value, { type: "boolean", enforced: true });
});

test("H4 a descendant policy overwrites the inherited one", () => {
  const h = base();
  h.addPolicy({
    constraint: "publicExposure",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  h.addPolicy({
    constraint: "publicExposure",
    nodeId: P,
    value: { type: "boolean", enforced: false },
    expiresAtMs: 1_000,
    justification: "partner demo",
  });
  const at = h.effectivePolicy(P, "publicExposure", 0)!;
  assert.equal(at.sourceNodeId, P);
  assert.equal(at.inherited, false);
  assert.equal(at.isException, true);
  assert.deepEqual(at.value, { type: "boolean", enforced: false });
});

test("H5 an expired exception stops applying without anyone removing it", () => {
  const h = base();
  h.addPolicy({
    constraint: "publicExposure",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  h.addPolicy({
    constraint: "publicExposure",
    nodeId: P,
    value: { type: "boolean", enforced: false },
    expiresAtMs: 1_000,
    justification: "partner demo",
  });

  const before = h.effectivePolicy(P, "publicExposure", 999)!;
  assert.equal(before.sourceNodeId, P);
  assert.deepEqual(before.value, { type: "boolean", enforced: false });

  // One millisecond later, with no administrative action of any kind, the
  // organization's policy governs again.
  const after = h.effectivePolicy(P, "publicExposure", 1_000)!;
  assert.equal(after.sourceNodeId, ORG);
  assert.equal(after.inherited, true);
  assert.deepEqual(after.value, { type: "boolean", enforced: true });
});

test("H6 an exception must say why it exists", () => {
  const h = base();
  assert.throws(
    () =>
      h.addPolicy({
        constraint: "publicExposure",
        nodeId: P,
        value: { type: "boolean", enforced: false },
        expiresAtMs: 1_000,
      }),
    HierarchyError,
  );
});

test("H7 grants inherit downward and expire on time", () => {
  const h = base();
  h.addGrant({ principal: "user:a", role: "roles/viewer", scope: ORG, expiresAtMs: null });
  h.addGrant({
    principal: "user:b",
    role: "roles/owner",
    scope: F,
    expiresAtMs: 500,
    justification: "incident",
  });

  assert.equal(h.activeGrants("user:a", P, 0).length, 1);
  assert.equal(h.activeGrants("user:b", P, 499).length, 1);
  assert.equal(h.activeGrants("user:b", P, 500).length, 0);
  // A grant at a folder does not reach a sibling branch.
  assert.equal(h.activeGrants("user:b", ORG, 0).length, 0);
});

test("H8 two live bindings for one constraint at one node is a modelling error", () => {
  const h = base();
  h.addPolicy({
    constraint: "externalIp",
    nodeId: P,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  h.addPolicy({
    constraint: "externalIp",
    nodeId: P,
    value: { type: "boolean", enforced: false },
    expiresAtMs: 9_000,
    justification: "migration",
  });
  assert.throws(() => h.effectivePolicy(P, "externalIp", 0), HierarchyError);
});

test("H9 an unconstrained constraint reports as unconstrained, not as permitted", () => {
  const h = base();
  const described = describeEffectivePolicy(h, P, 0);
  assert.equal(described.length, 5);
  assert.ok(described.every((d) => !d.present && d.summary === "unconstrained"));
});
