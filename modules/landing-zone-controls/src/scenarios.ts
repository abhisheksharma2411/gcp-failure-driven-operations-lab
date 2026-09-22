// Three landing zones over the same organization, and one suite run against
// all three.
//
//   FLAT    no folders, no constraints, everyone an editor. Where most
//           organizations actually are.
//   LOCKED  every guardrail on, nobody's job to make the platform usable.
//   PAVED   the same guardrails, plus a supported route through them.
//
// The suite is identical across the three. Only the zone changes. That is the
// whole experiment: FLAT fails on guardrails, LOCKED fails on the path, and
// only PAVED passes both sides.

import { Hierarchy } from "./hierarchy.ts";
import { LandingZone } from "./evaluate.ts";
import type { AuditSink, ConstraintId, Perimeter, ResourceNode } from "./types.ts";
import { federate, storedKey, HOUR_MS } from "./identity.ts";
import type { GoldenPath, GuardrailCase, Suite } from "./suite.ts";

export const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
export const DAY_MS = 24 * HOUR_MS;

export const ORG = "organizations/example";
export const F_PROD = "folders/production";
export const F_NONPROD = "folders/nonprod";
export const F_SECURITY = "folders/security";
export const P_APP_PROD = "projects/app-prod";
export const P_APP_DEV = "projects/app-dev";
export const P_SENSITIVE = "projects/sensitive-prod";
export const P_AUDIT = "projects/audit-store";
export const P_SANDBOX = "projects/dev-sandbox";
export const P_PARTNER = "projects/partner-analytics";

export const DEV = "user:dana@example.com";
export const SRE = "user:sam@example.com";
/** The platform team. Holds the permissions the configuration guardrails are
 *  meant to be tested against -- see ADR-003. */
export const ADMIN = "user:platform-admin@example.com";
export const SA_CI = "sa:ci-build@app-dev";
export const SA_DEPLOY_PROD = "sa:deployer@app-prod";
export const SA_SENSITIVE = "sa:reader@sensitive-prod";

const SA_PROJECTS: Readonly<Record<string, string>> = {
  [SA_CI]: P_APP_DEV,
  [SA_DEPLOY_PROD]: P_APP_PROD,
  [SA_SENSITIVE]: P_SENSITIVE,
};

// ---------------------------------------------------------------------------
// Hierarchies
// ---------------------------------------------------------------------------

/** No folders. Every project hangs off the organization. */
function flatHierarchy(): Hierarchy {
  const h = new Hierarchy();
  h.addNode({ id: ORG, kind: "organization", parent: null });
  for (const id of [P_APP_PROD, P_APP_DEV, P_SENSITIVE, P_AUDIT, P_SANDBOX, P_PARTNER]) {
    h.addNode({ id, kind: "project", parent: ORG });
  }
  // Everyone who ships is an editor, because that is what made the first
  // deploy work and nobody revisited it.
  h.addGrant({ principal: DEV, role: "roles/editor", scope: ORG, expiresAtMs: null });
  h.addGrant({ principal: SRE, role: "roles/owner", scope: ORG, expiresAtMs: null });
  h.addGrant({ principal: SA_CI, role: "roles/editor", scope: ORG, expiresAtMs: null });
  h.addGrant({ principal: ADMIN, role: "roles/editor", scope: ORG, expiresAtMs: null });
  return h;
}

function structuredNodes(): readonly ResourceNode[] {
  return [
    { id: ORG, kind: "organization", parent: null },
    { id: F_PROD, kind: "folder", parent: ORG },
    { id: F_NONPROD, kind: "folder", parent: ORG },
    { id: F_SECURITY, kind: "folder", parent: ORG },
    { id: P_APP_PROD, kind: "project", parent: F_PROD },
    { id: P_SENSITIVE, kind: "project", parent: F_PROD },
    { id: P_APP_DEV, kind: "project", parent: F_NONPROD },
    { id: P_SANDBOX, kind: "project", parent: F_NONPROD },
    { id: P_AUDIT, kind: "project", parent: F_SECURITY },
    { id: P_PARTNER, kind: "project", parent: F_NONPROD },
  ];
}

/**
 * Constraints set at the organization so every descendant inherits them.
 *
 * `sandboxExceptionExpiresAtMs` is the interesting knob: `null` means the
 * exception someone was granted in March has no end, which is how a landing
 * zone quietly develops a hole.
 */
function withGuardrails(
  h: Hierarchy,
  sandboxExceptionExpiresAtMs: number | null | undefined,
  skip?: ConstraintId,
): Hierarchy {
  const set = (b: Parameters<Hierarchy["addPolicy"]>[0]): void => {
    if (b.constraint === skip) return;
    h.addPolicy(b);
  };
  set({
    constraint: "publicExposure",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  set({
    constraint: "serviceAccountKeyCreation",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  set({
    constraint: "externalIp",
    nodeId: ORG,
    value: { type: "boolean", enforced: true },
    expiresAtMs: null,
  });
  set({
    constraint: "allowedRegions",
    nodeId: ORG,
    value: { type: "list", allowed: ["europe-west1", "europe-west4"] },
    expiresAtMs: null,
  });
  set({
    constraint: "allowedServices",
    nodeId: ORG,
    value: {
      type: "list",
      allowed: [
        "run.googleapis.com",
        "storage.googleapis.com",
        "bigquery.googleapis.com",
        "artifactregistry.googleapis.com",
      ],
    },
    expiresAtMs: null,
  });

  if (sandboxExceptionExpiresAtMs !== undefined && skip !== "publicExposure") {
    h.addPolicy({
      constraint: "publicExposure",
      nodeId: P_SANDBOX,
      value: { type: "boolean", enforced: false },
      expiresAtMs: sandboxExceptionExpiresAtMs,
      justification: "demo environment for the March partner workshop",
      requestedBy: DEV,
    });
  }
  return h;
}

/** Guardrails on, and no one has made the supported route work. */
function lockedHierarchy(): Hierarchy {
  const h = new Hierarchy();
  for (const n of structuredNodes()) h.addNode(n);
  withGuardrails(h, null); // the never-expiring exception
  // Read-only for the developer: the platform team has not got to it.
  h.addGrant({ principal: DEV, role: "roles/viewer", scope: F_NONPROD, expiresAtMs: null });
  h.addGrant({ principal: SRE, role: "roles/owner", scope: ORG, expiresAtMs: null });
  h.addGrant({ principal: ADMIN, role: "roles/editor", scope: ORG, expiresAtMs: null });
  // The sandbox predates the folders, and the grant on it came along with the
  // project when it was moved in. This is not a hypothetical: a migration that
  // reparents projects inherits their old bindings unless someone looks.
  h.addGrant({ principal: DEV, role: "roles/editor", scope: P_SANDBOX, expiresAtMs: null });
  // Nobody wired federation, so there is no usable pipeline identity either.
  return h;
}

/** The same guardrails, with a route through them. */
function pavedHierarchy(skip?: ConstraintId): Hierarchy {
  const h = new Hierarchy();
  for (const n of structuredNodes()) h.addNode(n);
  withGuardrails(h, T0 + 30 * DAY_MS, skip); // the exception now has an end

  // The developer can update the services they own, in the two folders that
  // hold them, and read their logs. Nothing else.
  h.addGrant({ principal: DEV, role: "roles/paved.deployer", scope: F_NONPROD, expiresAtMs: null });
  h.addGrant({ principal: DEV, role: "roles/paved.deployer", scope: P_APP_PROD, expiresAtMs: null });

  // The pipeline identity holds the push and deploy permissions, and the
  // developer may borrow it -- for that account only.
  h.addGrant({ principal: SA_CI, role: "roles/paved.buildRunner", scope: F_NONPROD, expiresAtMs: null });
  h.addGrant({ principal: SA_CI, role: "roles/paved.buildRunner", scope: P_APP_PROD, expiresAtMs: null });
  h.addGrant({
    principal: DEV,
    role: "roles/iam.serviceAccountTokenCreator",
    scope: P_APP_DEV,
    serviceAccount: SA_CI,
    expiresAtMs: null,
  });

  // Elevated access exists and ends. The grant is eight hours long because a
  // grant that outlives the incident is a standing grant with a story.
  h.addGrant({
    principal: SRE,
    role: "roles/paved.breakGlass",
    scope: F_PROD,
    expiresAtMs: T0 + 8 * HOUR_MS,
    justification: "incident 4471: payment latency",
  });
  // Outside the incident window the SRE is an ordinary reader.
  h.addGrant({ principal: SRE, role: "roles/viewer", scope: ORG, expiresAtMs: null });

  // The platform team administers the workload folders -- and not the folder
  // that holds the audit records. An administrator who can edit the evidence
  // of their own administration is the one privilege the hierarchy exists to
  // split, and splitting it costs a folder boundary.
  h.addGrant({ principal: ADMIN, role: "roles/editor", scope: F_PROD, expiresAtMs: null });
  h.addGrant({ principal: ADMIN, role: "roles/editor", scope: F_NONPROD, expiresAtMs: null });

  return h;
}

// ---------------------------------------------------------------------------
// Perimeters and sinks
// ---------------------------------------------------------------------------

const ENFORCED_PERIMETER: readonly Perimeter[] = [
  {
    name: "sensitive-perimeter",
    projects: [P_SENSITIVE],
    restrictedServices: ["storage.googleapis.com", "bigquery.googleapis.com"],
    dryRun: false,
  },
];

export const DRY_RUN_PERIMETER: readonly Perimeter[] = [
  { ...ENFORCED_PERIMETER[0]!, dryRun: true },
];

/** The audit trail lands inside the thing it is auditing. */
const WEAK_SINKS: readonly AuditSink[] = [
  {
    name: "local-sink",
    sourceNodeId: ORG,
    destinationProjectId: P_APP_PROD,
    retentionLocked: false,
  },
];

/** The audit trail lands in a project the production owners do not run. */
const PROTECTED_SINKS: readonly AuditSink[] = [
  {
    name: "org-audit-sink",
    sourceNodeId: ORG,
    destinationProjectId: P_AUDIT,
    retentionLocked: true,
  },
];

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export function flatZone(): LandingZone {
  return new LandingZone(flatHierarchy(), [], WEAK_SINKS, {
    // A flat estate does not refuse a key; that is what makes it flat.
    requireShortLivedCredentials: false,
    serviceAccountProjects: SA_PROJECTS,
  });
}

export function lockedZone(): LandingZone {
  return new LandingZone(lockedHierarchy(), ENFORCED_PERIMETER, PROTECTED_SINKS, {
    requireShortLivedCredentials: true,
    serviceAccountProjects: SA_PROJECTS,
  });
}

export function pavedZone(perimeters: readonly Perimeter[] = ENFORCED_PERIMETER): LandingZone {
  return new LandingZone(pavedHierarchy(), perimeters, PROTECTED_SINKS, {
    requireShortLivedCredentials: true,
    serviceAccountProjects: SA_PROJECTS,
  });
}

/**
 * The paved zone with exactly one control taken out and nothing else changed.
 *
 * Used as a negative control: a suite that keeps passing when a guardrail is
 * removed is not testing the guardrail. Each mutation must turn at least one
 * guardrail case red.
 *
 * The mutated zone has to be a faithful copy -- same hierarchy, same grants,
 * same identities. An earlier version built a stripped-down hierarchy instead,
 * and the control silently passed because the principals in it lacked the
 * permissions to reach the constraint at all.
 */
export function pavedZoneMissing(
  mutation: ConstraintId | "perimeter" | "shortLivedCredentials",
): LandingZone {
  const isConstraint = mutation !== "perimeter" && mutation !== "shortLivedCredentials";
  return new LandingZone(
    pavedHierarchy(isConstraint ? mutation : undefined),
    mutation === "perimeter" ? [] : ENFORCED_PERIMETER,
    PROTECTED_SINKS,
    {
      requireShortLivedCredentials: mutation !== "shortLivedCredentials",
      serviceAccountProjects: SA_PROJECTS,
    },
  );
}

// ---------------------------------------------------------------------------
// Credentials used by the suite
// ---------------------------------------------------------------------------

/** What a pipeline presents after a token exchange. No key anywhere. */
export function ciFederatedCredential(nowMs = T0) {
  const c = federate(
    {
      sub: SA_CI,
      repository: "example/payments",
      ref: "refs/heads/main",
      workflow: "deploy",
    },
    "sub",
    nowMs,
  );
  if (c === null) throw new Error("fixture: federation should have produced a subject");
  return c;
}

/** What a pipeline presents when someone pasted a key into a CI variable. */
export function ciStoredKeyCredential(issuedAtMs = T0 - 400 * DAY_MS) {
  return storedKey(SA_CI, issuedAtMs);
}

export function humanCredential(subject: string, nowMs = T0) {
  return {
    kind: "userInteractive" as const,
    subject,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 8 * HOUR_MS,
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function guardrailCases(nowMs = T0): readonly GuardrailCase[] {
  return [
    {
      name: "G1 public exposure is refused in production",
      expectDeniedBy: "configuration",
      action: {
        principal: ADMIN,
        credential: humanCredential(ADMIN, nowMs),
        operation: "storage.createBucket",
        targetProject: P_APP_PROD,
        config: {
          service: "storage.googleapis.com",
          region: "europe-west1",
          publiclyAccessible: true,
        },
      },
    },
    {
      name: "G2 a region outside the allowed set is refused",
      expectDeniedBy: "configuration",
      action: {
        principal: ADMIN,
        credential: humanCredential(ADMIN, nowMs),
        operation: "run.deploy",
        targetProject: P_APP_PROD,
        config: { service: "run.googleapis.com", region: "us-central1" },
      },
    },
    {
      name: "G3 creating a stored service-account key is refused",
      expectDeniedBy: "configuration",
      action: {
        principal: ADMIN,
        credential: humanCredential(ADMIN, nowMs),
        operation: "iam.createServiceAccountKey",
        targetProject: P_APP_DEV,
        config: { createsServiceAccountKey: true },
      },
    },
    {
      name: "G4 a pipeline presenting a stored key is refused",
      expectDeniedBy: "identity",
      expectReason: /long-lived/,
      action: {
        principal: SA_CI,
        credential: ciStoredKeyCredential(),
        operation: "run.deploy",
        targetProject: P_APP_DEV,
        config: { service: "run.googleapis.com", region: "europe-west1" },
      },
    },
    {
      name: "G5 the build identity cannot impersonate the production deployer",
      expectDeniedBy: "identity",
      expectReason: /getAccessToken/,
      action: {
        principal: SA_CI,
        credential: ciFederatedCredential(nowMs),
        operation: "iam.impersonate",
        targetProject: P_APP_DEV,
        impersonationTarget: SA_DEPLOY_PROD,
      },
    },
    {
      name: "G6 data cannot be copied out of the sensitive perimeter",
      expectDeniedBy: "perimeter",
      action: {
        principal: ADMIN,
        credential: humanCredential(ADMIN, nowMs),
        operation: "bigquery.export",
        targetProject: P_SENSITIVE,
        egressToProject: P_PARTNER,
        config: { service: "bigquery.googleapis.com", region: "europe-west1" },
      },
    },
  ];
}

/**
 * Ship a change: build it, push it, deploy it to dev, deploy it to production,
 * and read the logs to see whether it worked.
 *
 * Five steps, no approval gates, and a permission budget of four. If a
 * guardrail cannot coexist with this, the guardrail is the thing that is wrong.
 */
export function shipAChange(nowMs = T0): GoldenPath {
  const dev = humanCredential(DEV, nowMs);
  const ci = ciFederatedCredential(nowMs);
  return {
    name: "ship a change to production",
    developer: DEV,
    measuredAt: P_APP_PROD,
    budget: { maxPermissions: 4, maxManualApprovals: 0 },
    steps: [
      {
        name: "borrow the pipeline identity",
        action: {
          principal: DEV,
          credential: dev,
          operation: "iam.impersonate",
          targetProject: P_APP_DEV,
          impersonationTarget: SA_CI,
        },
      },
      {
        name: "push the image",
        action: {
          principal: SA_CI,
          credential: ci,
          operation: "artifactregistry.push",
          targetProject: P_APP_DEV,
          config: { service: "artifactregistry.googleapis.com", region: "europe-west1" },
        },
      },
      {
        name: "deploy to dev",
        action: {
          principal: SA_CI,
          credential: ci,
          operation: "run.deploy",
          targetProject: P_APP_DEV,
          config: { service: "run.googleapis.com", region: "europe-west1" },
        },
      },
      {
        name: "deploy to production",
        action: {
          principal: SA_CI,
          credential: ci,
          operation: "run.deploy",
          targetProject: P_APP_PROD,
          config: { service: "run.googleapis.com", region: "europe-west1" },
        },
      },
      {
        name: "read the logs",
        action: {
          principal: DEV,
          credential: dev,
          operation: "logging.read",
          targetProject: P_APP_PROD,
        },
      },
    ],
    escapeRoutes: [
      {
        name: "mint a key and deploy from a laptop",
        action: {
          principal: DEV,
          credential: humanCredential(DEV, nowMs),
          operation: "iam.createServiceAccountKey",
          targetProject: P_SANDBOX,
          config: { createsServiceAccountKey: true },
        },
      },
      {
        name: "publish the data from the sandbox instead",
        action: {
          principal: DEV,
          credential: humanCredential(DEV, nowMs),
          operation: "storage.createBucket",
          targetProject: P_SANDBOX,
          config: {
            service: "storage.googleapis.com",
            region: "europe-west1",
            publiclyAccessible: true,
          },
        },
      },
    ],
  };
}

export function landingZoneSuite(nowMs = T0): Suite {
  return {
    name: "landing-zone-controls",
    guardrails: guardrailCases(nowMs),
    goldenPaths: [shipAChange(nowMs)],
  };
}
