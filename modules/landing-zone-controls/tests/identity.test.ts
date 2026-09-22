import { test } from "node:test";
import assert from "node:assert/strict";
import { Hierarchy } from "../src/hierarchy.ts";
import {
  HOUR_MS,
  canImpersonate,
  credentialIsValid,
  deriveFederatedSubject,
  effectivePermissions,
  federate,
  impersonate,
  isShortLived,
  remainingLifetimeMs,
  storedKey,
} from "../src/identity.ts";

const ORG = "organizations/x";
const P_DEV = "projects/dev";
const P_PROD = "projects/prod";

function h(): Hierarchy {
  return new Hierarchy()
    .addNode({ id: ORG, kind: "organization", parent: null })
    .addNode({ id: P_DEV, kind: "project", parent: ORG })
    .addNode({ id: P_PROD, kind: "project", parent: ORG });
}

test("I1 a stored key never stops working, which is the entire problem", () => {
  const key = storedKey("sa:ci@dev", 0);
  const aDecadeLater = 10 * 365 * 24 * HOUR_MS;
  assert.equal(credentialIsValid(key, aDecadeLater), true);
  assert.equal(remainingLifetimeMs(key, aDecadeLater), Number.POSITIVE_INFINITY);
  assert.equal(isShortLived(key, aDecadeLater), false);
});

test("I2 federated and impersonated credentials are short-lived", () => {
  const fed = federate({ sub: "sa:ci@dev" }, "sub", 0)!;
  const imp = impersonate("user:dana", "sa:deploy@prod", 0);
  for (const c of [fed, imp]) {
    assert.equal(isShortLived(c, 0), true);
    assert.equal(credentialIsValid(c, HOUR_MS - 1), true);
    assert.equal(credentialIsValid(c, HOUR_MS), false);
  }
});

test("I3 a credential is not valid before it was issued", () => {
  const fed = federate({ sub: "sa:ci@dev" }, "sub", 1_000)!;
  assert.equal(credentialIsValid(fed, 999), false);
});

test("I4 an assertion without the mapped claim yields no identity", () => {
  assert.equal(deriveFederatedSubject({ sub: "sa:ci@dev" }, "sub"), "sa:ci@dev");
  assert.equal(deriveFederatedSubject({ repository: "example/x" }, "sub"), null);
  assert.equal(deriveFederatedSubject({ sub: "" }, "sub"), null);
  assert.equal(federate({ repository: "example/x" }, "sub", 0), null);
});

test("I5 impersonation is refused without getAccessToken on the target", () => {
  const x = h();
  x.addGrant({ principal: "sa:ci@dev", role: "roles/paved.buildRunner", scope: ORG, expiresAtMs: null });
  assert.equal(canImpersonate(x, "sa:ci@dev", "sa:deploy@prod", P_PROD, 0), false);
});

test("I6 a grant bound to one service account does not reach another", () => {
  const x = h();
  x.addGrant({
    principal: "user:dana",
    role: "roles/iam.serviceAccountTokenCreator",
    scope: P_DEV,
    serviceAccount: "sa:ci@dev",
    expiresAtMs: null,
  });
  assert.equal(canImpersonate(x, "user:dana", "sa:ci@dev", P_DEV, 0), true);
  assert.equal(canImpersonate(x, "user:dana", "sa:other@dev", P_DEV, 0), false);
});

test("I7 a grant at a project reaches every service account in it", () => {
  const x = h();
  x.addGrant({
    principal: "user:sam",
    role: "roles/iam.serviceAccountTokenCreator",
    scope: P_DEV,
    expiresAtMs: null,
  });
  assert.equal(canImpersonate(x, "user:sam", "sa:ci@dev", P_DEV, 0), true);
  assert.equal(canImpersonate(x, "user:sam", "sa:other@dev", P_DEV, 0), true);
  // ...but not one that lives somewhere else.
  assert.equal(canImpersonate(x, "user:sam", "sa:deploy@prod", P_PROD, 0), false);
});

test("I8 a service-account-bound grant confers no ordinary permissions", () => {
  const x = h();
  x.addGrant({
    principal: "user:dana",
    role: "roles/iam.serviceAccountTokenCreator",
    scope: P_DEV,
    serviceAccount: "sa:ci@dev",
    expiresAtMs: null,
  });
  // It authorizes borrowing an identity, and nothing else. If this counted
  // toward the permission total, the friction budget would be measuring the
  // wrong thing.
  assert.equal(effectivePermissions(x, "user:dana", P_DEV, 0).size, 0);
});

test("I9 impersonation cannot be asked to mint a long-lived credential", () => {
  assert.throws(() => impersonate("user:dana", "sa:deploy@prod", 0, 72 * HOUR_MS));
});

test("I10 an expired grant stops conferring permissions", () => {
  const x = h();
  x.addGrant({
    principal: "user:sam",
    role: "roles/paved.breakGlass",
    scope: P_PROD,
    expiresAtMs: 8 * HOUR_MS,
    justification: "incident 4471",
  });
  assert.equal(effectivePermissions(x, "user:sam", P_PROD, 8 * HOUR_MS - 1).size, 1);
  assert.equal(effectivePermissions(x, "user:sam", P_PROD, 8 * HOUR_MS).size, 0);
});
