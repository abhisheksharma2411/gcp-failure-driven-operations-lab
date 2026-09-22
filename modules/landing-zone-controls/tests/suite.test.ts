// The eight behaviours the article claims, plus the controls that show the
// suite can fail.
//
// T1..T8 map one-to-one onto the required-test list in the article package.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN,
  DEV,
  SA_CI,
  SA_DEPLOY_PROD,
  SRE,
  P_APP_DEV,
  P_APP_PROD,
  P_SANDBOX,
  P_SENSITIVE,
  P_AUDIT,
  T0,
  DAY_MS,
  ciFederatedCredential,
  ciStoredKeyCredential,
  flatZone,
  humanCredential,
  landingZoneSuite,
  lockedZone,
  pavedZone,
  pavedZoneMissing,
  shipAChange,
  DRY_RUN_PERIMETER,
} from "../src/scenarios.ts";
import { runGoldenPath, runGuardrail, runSuite } from "../src/suite.ts";
import { HOUR_MS } from "../src/identity.ts";
import { auditWeaknesses, resolveSink } from "../src/audit.ts";

// ---------------------------------------------------------------------------
// T1  CI deploys with no stored cloud key
// ---------------------------------------------------------------------------

test("T1 the pipeline deploys with a federated credential and no stored key", () => {
  const zone = pavedZone();
  const federated = ciFederatedCredential(T0);
  assert.notEqual(federated.expiresAtMs, null);

  const deploy = zone.evaluate(
    {
      principal: SA_CI,
      credential: federated,
      operation: "run.deploy",
      targetProject: P_APP_PROD,
      config: { service: "run.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(deploy.allowed, true, deploy.reason);

  // The same deployment, authenticated with a key that was pasted into a CI
  // variable a year ago, is refused at the identity layer.
  const withKey = zone.evaluate(
    {
      principal: SA_CI,
      credential: ciStoredKeyCredential(),
      operation: "run.deploy",
      targetProject: P_APP_PROD,
      config: { service: "run.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(withKey.allowed, false);
  assert.equal(withKey.layer, "identity");
  assert.match(withKey.reason!, /long-lived/);

  // And no step of the supported path presents a credential that never ends.
  for (const step of shipAChange(T0).steps) {
    assert.notEqual(
      step.action.credential.expiresAtMs,
      null,
      `${step.name} used a non-expiring credential`,
    );
  }
});

// ---------------------------------------------------------------------------
// T2  forbidden public exposure is rejected
// ---------------------------------------------------------------------------

test("T2 public exposure is rejected by policy, not by lack of permission", () => {
  const zone = pavedZone();
  const d = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "storage.createBucket",
      targetProject: P_APP_PROD,
      config: {
        service: "storage.googleapis.com",
        region: "europe-west1",
        publiclyAccessible: true,
      },
    },
    T0,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.layer, "configuration");

  // The same principal creating the same bucket without public access
  // succeeds, which is what makes the refusal above about the shape and not
  // about the person.
  const ok = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "storage.createBucket",
      targetProject: P_APP_PROD,
      config: {
        service: "storage.googleapis.com",
        region: "europe-west1",
        publiclyAccessible: false,
      },
    },
    T0,
  );
  assert.equal(ok.allowed, true, ok.reason);
});

// ---------------------------------------------------------------------------
// T3  disallowed region and service are rejected
// ---------------------------------------------------------------------------

test("T3 a region and a service outside the allowed set are rejected", () => {
  const zone = pavedZone();
  const badRegion = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "run.deploy",
      targetProject: P_APP_PROD,
      config: { service: "run.googleapis.com", region: "us-central1" },
    },
    T0,
  );
  assert.equal(badRegion.layer, "configuration");
  assert.match(badRegion.reason!, /us-central1/);

  const badService = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "compute.createInstance",
      targetProject: P_APP_PROD,
      config: { service: "compute.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(badService.layer, "configuration");
  assert.match(badService.reason!, /compute\.googleapis\.com/);
});

// ---------------------------------------------------------------------------
// T4  privileged access expires
// ---------------------------------------------------------------------------

test("T4 elevated access stops working when its window ends", () => {
  const zone = pavedZone();
  const during = T0 + 1 * HOUR_MS;
  const after = T0 + 9 * HOUR_MS;

  const act = (nowMs: number) =>
    zone.evaluate(
      {
        principal: SRE,
        credential: humanCredential(SRE, nowMs),
        operation: "run.deploy",
        targetProject: P_APP_PROD,
        config: { service: "run.googleapis.com", region: "europe-west1" },
      },
      nowMs,
    );

  assert.equal(act(during).allowed, true, act(during).reason);

  const later = act(after);
  assert.equal(later.allowed, false);
  assert.equal(later.layer, "identity");
  // Nobody revoked anything. The grant simply stopped.
  assert.match(later.reason!, /lacks run\.services\.update/);
});

// ---------------------------------------------------------------------------
// T5  an exception expires
// ---------------------------------------------------------------------------

test("T5 an exception lapses and the inherited policy governs again", () => {
  const zone = pavedZone();
  const publish = (nowMs: number) =>
    zone.evaluate(
      {
        principal: ADMIN,
        credential: humanCredential(ADMIN, nowMs),
        operation: "storage.createBucket",
        targetProject: P_SANDBOX,
        config: {
          service: "storage.googleapis.com",
          region: "europe-west1",
          publiclyAccessible: true,
        },
      },
      nowMs,
    );

  // While the exception is live the organization's policy is overwritten
  // here, which is the documented behaviour and the reason exceptions are
  // dangerous without an end date.
  assert.equal(publish(T0 + 29 * DAY_MS).allowed, true);

  const afterExpiry = publish(T0 + 31 * DAY_MS);
  assert.equal(afterExpiry.allowed, false);
  assert.equal(afterExpiry.layer, "configuration");

  // The effective policy points back at the organization with no edit.
  const resolved = zone.hierarchy.effectivePolicy(P_SANDBOX, "publicExposure", T0 + 31 * DAY_MS)!;
  assert.equal(resolved.sourceNodeId, "organizations/example");
  assert.equal(resolved.isException, false);
});

// ---------------------------------------------------------------------------
// T6  sensitive audit events reach a destination the actor does not control
// ---------------------------------------------------------------------------

test("T6 sensitive audit records land outside the authority they evidence", () => {
  const zone = pavedZone();
  const sink = resolveSink(zone.hierarchy, zone.sinks, P_SENSITIVE)!;
  assert.equal(sink.destinationProjectId, P_AUDIT);
  assert.equal(sink.retentionLocked, true);
  assert.notEqual(sink.destinationProjectId, P_SENSITIVE);

  // Independence is derived from who actually holds destructive permissions,
  // not from a field claiming the sink is protected.
  assert.deepEqual(auditWeaknesses(zone.hierarchy, zone.sinks, P_SENSITIVE, T0), []);

  // A denied action is still audited. A control that only records successes
  // loses exactly the events an investigation starts from.
  const denied = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "bigquery.export",
      targetProject: P_SENSITIVE,
      egressToProject: "projects/partner-analytics",
      config: { service: "bigquery.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(denied.allowed, false);
  assert.equal(denied.auditedTo, sink.name);
});

// ---------------------------------------------------------------------------
// T7  a workload identity cannot reach an unrelated service account
// ---------------------------------------------------------------------------

test("T7 the build identity cannot impersonate the production deployer", () => {
  const zone = pavedZone();
  const d = zone.evaluate(
    {
      principal: SA_CI,
      credential: ciFederatedCredential(T0),
      operation: "iam.impersonate",
      targetProject: P_APP_DEV,
      impersonationTarget: SA_DEPLOY_PROD,
    },
    T0,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.layer, "identity");
  assert.match(d.reason!, /getAccessToken/);

  // The developer may borrow the build identity -- and only that one.
  const borrow = zone.evaluate(
    {
      principal: DEV,
      credential: humanCredential(DEV, T0),
      operation: "iam.impersonate",
      targetProject: P_APP_DEV,
      impersonationTarget: SA_CI,
    },
    T0,
  );
  assert.equal(borrow.allowed, true, borrow.reason);

  const reach = zone.evaluate(
    {
      principal: DEV,
      credential: humanCredential(DEV, T0),
      operation: "iam.impersonate",
      targetProject: P_APP_PROD,
      impersonationTarget: SA_DEPLOY_PROD,
    },
    T0,
  );
  assert.equal(reach.allowed, false);
  assert.equal(reach.layer, "identity");
});

// ---------------------------------------------------------------------------
// T8  the paved road works without broad permissions
// ---------------------------------------------------------------------------

test("T8 the developer ships without broad permissions", () => {
  const r = runGoldenPath(pavedZone(), shipAChange(T0), T0);
  assert.equal(r.passed, true, r.failures.join("; "));
  assert.equal(r.blockedSteps.length, 0);
  assert.equal(r.manualApprovals, 0);
  assert.ok(r.permissionsHeld <= 4, `held ${r.permissionsHeld}`);
  assert.ok(!r.permissions.includes("*"));
  for (const broad of [
    "storage.buckets.setIamPolicy",
    "iam.serviceAccountKeys.create",
    "compute.instances.create",
  ]) {
    assert.ok(!r.permissions.includes(broad), `developer should not hold ${broad}`);
  }
});

// ---------------------------------------------------------------------------
// The claim the article actually makes
// ---------------------------------------------------------------------------

test("T9 a locked platform passes every guardrail and still fails the suite", () => {
  const r = runSuite(lockedZone(), landingZoneSuite(T0), T0);
  assert.equal(r.guardrailsPassed, 6);
  assert.equal(r.goldenPathsPassed, 0);
  assert.equal(r.passed, false);

  const path = r.goldenPaths[0]!;
  assert.equal(path.blockedSteps.length, 5);
  // And the work does not stop: it moves to the one place policy was relaxed.
  assert.deepEqual(path.viableEscapes, ["publish the data from the sandbox instead"]);
});

test("T10 a flat estate passes no guardrail and over-privileges the developer", () => {
  const r = runSuite(flatZone(), landingZoneSuite(T0), T0);
  assert.equal(r.guardrailsPassed, 0);
  assert.equal(r.passed, false);
  const path = r.goldenPaths[0]!;
  // The path works. That is why nobody fixes it.
  assert.equal(path.blockedSteps.length, 0);
  assert.ok(path.permissionsHeld >= 10);
  assert.ok(path.failures.some((f) => f.startsWith("OVER-PRIVILEGE")));
});

test("T11 only the paved zone passes both sides", () => {
  const r = runSuite(pavedZone(), landingZoneSuite(T0), T0);
  assert.equal(r.passed, true, JSON.stringify(r.goldenPaths[0]!.failures));
  assert.equal(r.guardrailsPassed, 6);
  assert.equal(r.goldenPathsPassed, 1);
});

test("T12 a dry-run perimeter reports the violation and does not stop it", () => {
  const zone = pavedZone(DRY_RUN_PERIMETER);
  const d = zone.evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(ADMIN, T0),
      operation: "bigquery.export",
      targetProject: P_SENSITIVE,
      egressToProject: "projects/partner-analytics",
      config: { service: "bigquery.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(d.allowed, true);
  assert.match(d.dryRunViolation!, /crosses perimeter/);

  // A dry-run perimeter must therefore fail the guardrail case. Shipping a
  // perimeter in dry run and calling the control done is the mistake this
  // asserts against.
  const g = runGuardrail(zone, landingZoneSuite(T0).guardrails[5]!, T0);
  assert.equal(g.passed, false);
  assert.match(g.detail, /LEAK/);
});

// ---------------------------------------------------------------------------
// Negative controls: the suite must be able to fail
// ---------------------------------------------------------------------------

test("N1 removing any single control turns a guardrail red", () => {
  const mutations = [
    "publicExposure",
    "allowedRegions",
    "serviceAccountKeyCreation",
    "perimeter",
    "shortLivedCredentials",
  ] as const;
  for (const m of mutations) {
    const r = runSuite(pavedZoneMissing(m), landingZoneSuite(T0), T0);
    assert.ok(
      r.guardrailsPassed < 6,
      `removing ${m} left every guardrail passing -- that control is untested`,
    );
  }
});

test("N2 a refusal by the wrong layer does not count as a pass", () => {
  // DEV cannot create buckets at all, so this action is refused -- but by the
  // identity layer, which proves nothing about the public-exposure constraint.
  const g = runGuardrail(
    pavedZone(),
    {
      name: "wrong-layer control",
      expectDeniedBy: "configuration",
      action: {
        principal: DEV,
        credential: humanCredential(DEV, T0),
        operation: "storage.createBucket",
        targetProject: P_APP_PROD,
        config: {
          service: "storage.googleapis.com",
          region: "europe-west1",
          publiclyAccessible: true,
        },
      },
    },
    T0,
  );
  assert.equal(g.passed, false);
  assert.equal(g.actualLayer, "identity");
  assert.match(g.detail, /not the one that fired/);
});

test("N3 a credential for one identity cannot be used to act as another", () => {
  const d = pavedZone().evaluate(
    {
      principal: ADMIN,
      credential: humanCredential(DEV, T0),
      operation: "run.deploy",
      targetProject: P_APP_PROD,
      config: { service: "run.googleapis.com", region: "europe-west1" },
    },
    T0,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.layer, "identity");
  assert.match(d.reason!, /asserts .* but the action claims/);
});

test("N4 escapes are only counted when the path is actually blocked", () => {
  // In the paved zone the developer has no reason to leave the road, and the
  // suite must not manufacture a finding out of a route nobody would take.
  const r = runGoldenPath(pavedZone(), shipAChange(T0), T0);
  assert.deepEqual(r.viableEscapes, []);
});

test("N5 pinning the refusal reason is itself enforced", () => {
  // Guards the guard: if `expectReason` were ignored, the negative control
  // above would go back to passing for the wrong reason.
  const g = runGuardrail(
    pavedZone(),
    {
      name: "mis-pinned control",
      expectDeniedBy: "configuration",
      expectReason: /this is not why it was refused/,
      action: {
        principal: ADMIN,
        credential: humanCredential(ADMIN, T0),
        operation: "run.deploy",
        targetProject: P_APP_PROD,
        config: { service: "run.googleapis.com", region: "us-central1" },
      },
    },
    T0,
  );
  assert.equal(g.passed, false);
  assert.match(g.detail, /right layer for the wrong reason/);
});
