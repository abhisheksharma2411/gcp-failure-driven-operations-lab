import { test } from "node:test";
import assert from "node:assert/strict";
import { Hierarchy } from "../src/hierarchy.ts";
import { checkConfiguration } from "../src/policy.ts";

const ORG = "organizations/x";
const P = "projects/app";

function h(): Hierarchy {
  return new Hierarchy()
    .addNode({ id: ORG, kind: "organization", parent: null })
    .addNode({ id: P, kind: "project", parent: ORG });
}

test("O1 an unconstrained project permits anything", () => {
  const v = checkConfiguration(h(), P, {
    publiclyAccessible: true,
    region: "us-central1",
    externalIp: true,
    createsServiceAccountKey: true,
    service: "compute.googleapis.com",
  }, 0);
  assert.deepEqual(v, []);
});

test("O2 every violation is reported, not just the first", () => {
  const x = h();
  x.addPolicy({ constraint: "publicExposure", nodeId: ORG, value: { type: "boolean", enforced: true }, expiresAtMs: null });
  x.addPolicy({ constraint: "externalIp", nodeId: ORG, value: { type: "boolean", enforced: true }, expiresAtMs: null });
  x.addPolicy({ constraint: "allowedRegions", nodeId: ORG, value: { type: "list", allowed: ["europe-west1"] }, expiresAtMs: null });

  const v = checkConfiguration(x, P, {
    publiclyAccessible: true,
    externalIp: true,
    region: "us-central1",
  }, 0);
  assert.equal(v.length, 3);
  assert.deepEqual(
    v.map((x) => x.constraint).sort(),
    ["allowedRegions", "externalIp", "publicExposure"],
  );
  assert.ok(v.every((x) => x.inherited && x.sourceNodeId === ORG));
});

test("O3 a constraint only fires on the shape it governs", () => {
  const x = h();
  x.addPolicy({ constraint: "publicExposure", nodeId: ORG, value: { type: "boolean", enforced: true }, expiresAtMs: null });
  assert.deepEqual(checkConfiguration(x, P, { publiclyAccessible: false }, 0), []);
  assert.deepEqual(checkConfiguration(x, P, {}, 0), []);
  assert.deepEqual(checkConfiguration(x, P, undefined, 0), []);
});

test("O4 a policy present but not enforced permits the shape", () => {
  const x = h();
  x.addPolicy({ constraint: "publicExposure", nodeId: ORG, value: { type: "boolean", enforced: false }, expiresAtMs: null });
  assert.deepEqual(checkConfiguration(x, P, { publiclyAccessible: true }, 0), []);
});

test("O5 the configuration layer never consults identity", () => {
  // Same hierarchy, no grants at all, and the answer is identical. The layer
  // cannot be satisfied by holding a role, which is the whole reason it is a
  // separate question from who.
  const x = h();
  x.addPolicy({ constraint: "allowedRegions", nodeId: ORG, value: { type: "list", allowed: ["europe-west1"] }, expiresAtMs: null });
  const withoutGrants = checkConfiguration(x, P, { region: "us-central1" }, 0);
  x.addGrant({ principal: "user:anyone", role: "roles/owner", scope: ORG, expiresAtMs: null });
  const withOwner = checkConfiguration(x, P, { region: "us-central1" }, 0);
  assert.deepEqual(withOwner, withoutGrants);
  assert.equal(withOwner.length, 1);
});
