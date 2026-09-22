// Who is acting, how they proved it, and what that lets them do.

import type { Credential, Permission } from "./types.ts";
import type { Hierarchy } from "./hierarchy.ts";

/**
 * Roles as permission bundles.
 *
 * A deliberately small set. `roles/owner` is here because the article needs
 * something to contrast the paved road against, not because anyone should
 * hold it.
 */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  "roles/owner": ["*"],
  "roles/editor": [
    "run.services.create",
    "run.services.update",
    "storage.buckets.create",
    "storage.buckets.setIamPolicy",
    "compute.instances.create",
    "iam.serviceAccounts.create",
    "iam.serviceAccountKeys.create",
    "iam.serviceAccounts.getAccessToken",
    "artifactregistry.repositories.uploadArtifacts",
    "bigquery.tables.export",
    "logging.logEntries.list",
  ],
  "roles/viewer": ["run.services.get", "storage.buckets.get", "logging.logEntries.list"],

  // The paved road. Narrow on purpose: deploy a revision of a service that
  // already exists, and read what it is doing.
  "roles/paved.deployer": [
    "run.services.update",
    "run.services.get",
    "logging.logEntries.list",
  ],
  // Held by the pipeline's service account, not by the developer.
  "roles/paved.buildRunner": [
    "artifactregistry.repositories.uploadArtifacts",
    "run.services.update",
  ],
  "roles/iam.serviceAccountTokenCreator": ["iam.serviceAccounts.getAccessToken"],
  "roles/paved.breakGlass": ["*"],
};

export class CredentialError extends Error {}

/**
 * A credential is usable if it was issued and has not lapsed.
 *
 * A stored service-account key has `expiresAtMs === null`, so this returns
 * true forever. That is the mechanism the documentation is warning about, and
 * this function is where it is visible: there is no branch that can retire a
 * key, because possession of the key is the whole authentication.
 */
export function credentialIsValid(c: Credential, nowMs: number): boolean {
  if (nowMs < c.issuedAtMs) return false;
  if (c.expiresAtMs === null) return true;
  return nowMs < c.expiresAtMs;
}

/** How long a credential can still be used. Infinity for a stored key. */
export function remainingLifetimeMs(c: Credential, nowMs: number): number {
  if (c.expiresAtMs === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, c.expiresAtMs - nowMs);
}

export const HOUR_MS = 3_600_000;

/**
 * Whether a credential meets the short-lived bar the platform requires.
 *
 * Impersonation and federation both yield credentials measured in hours.
 * A key meets no bar at all.
 */
export function isShortLived(c: Credential, nowMs: number, maxMs = 12 * HOUR_MS): boolean {
  return remainingLifetimeMs(c, nowMs) <= maxMs;
}

/**
 * Derive a Google identity from an external token, the way an attribute
 * mapping does.
 *
 * The mapping is expressed as `google.subject = assertion.<claim>`; this takes
 * the claim name and reads it off the presented assertion. A workload whose
 * assertion does not carry the mapped claim gets no identity.
 */
export function deriveFederatedSubject(
  assertion: Readonly<Record<string, string>>,
  subjectClaim: string,
): string | null {
  const v = assertion[subjectClaim];
  return v === undefined || v === "" ? null : v;
}

/**
 * Every permission a principal holds at a node right now.
 *
 * Grants bound to a single service account are excluded: they authorize
 * impersonating that account and nothing else, and counting them here would
 * inflate the privilege measurement the friction budget depends on.
 */
export function effectivePermissions(
  hierarchy: Hierarchy,
  principal: string,
  nodeId: string,
  nowMs: number,
): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const grant of hierarchy.activeGrants(principal, nodeId, nowMs)) {
    if (grant.serviceAccount !== undefined) continue;
    for (const p of ROLE_PERMISSIONS[grant.role] ?? []) out.add(p);
  }
  return out;
}

export function hasPermission(
  hierarchy: Hierarchy,
  principal: string,
  nodeId: string,
  permission: Permission,
  nowMs: number,
): boolean {
  const held = effectivePermissions(hierarchy, principal, nodeId, nowMs);
  return held.has("*") || held.has(permission);
}

/** Which permission an operation needs. */
export const OPERATION_PERMISSION: Readonly<Record<string, Permission>> = {
  "run.deploy": "run.services.update",
  "run.read": "run.services.get",
  "storage.createBucket": "storage.buckets.create",
  "storage.makePublic": "storage.buckets.setIamPolicy",
  "compute.createInstance": "compute.instances.create",
  "iam.createServiceAccountKey": "iam.serviceAccountKeys.create",
  "iam.impersonate": "iam.serviceAccounts.getAccessToken",
  "artifactregistry.push": "artifactregistry.repositories.uploadArtifacts",
  "logging.read": "logging.logEntries.list",
  "bigquery.export": "bigquery.tables.export",
};

export function permissionForOperation(operation: string): Permission | null {
  return OPERATION_PERMISSION[operation] ?? null;
}

/**
 * Whether `principal` may impersonate `targetServiceAccount`.
 *
 * Impersonation needs `iam.serviceAccounts.getAccessToken`. Where that
 * permission is held decides the blast radius, and the two shapes differ:
 *
 *   - granted at a node, it covers every service account that lives in that
 *     node or below it;
 *   - granted on one service account, it covers that account only.
 *
 * The second shape is what keeps a build workload from reaching a production
 * deployer it was never meant to reach, and it is the reason the unrelated-
 * impersonation test is about *scope* rather than about the workload holding
 * no permissions at all.
 */
export function canImpersonate(
  hierarchy: Hierarchy,
  principal: string,
  targetServiceAccount: string,
  serviceAccountProject: string,
  nowMs: number,
): boolean {
  for (const g of hierarchy.activeGrants(principal, serviceAccountProject, nowMs)) {
    const perms = ROLE_PERMISSIONS[g.role] ?? [];
    const grantsToken =
      perms.includes("iam.serviceAccounts.getAccessToken") || perms.includes("*");
    if (!grantsToken) continue;
    if (g.serviceAccount !== undefined && g.serviceAccount !== targetServiceAccount) {
      continue;
    }
    return true;
  }
  return false;
}

/** Mint the short-lived credential an impersonation produces. */
export function impersonate(
  by: string,
  serviceAccount: string,
  nowMs: number,
  lifetimeMs = HOUR_MS,
): Credential {
  if (lifetimeMs > 12 * HOUR_MS) {
    throw new CredentialError("impersonated credentials are short-lived by construction");
  }
  return {
    kind: "impersonated",
    subject: serviceAccount,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + lifetimeMs,
    impersonatedBy: by,
  };
}

/** Mint the short-lived credential a federated token exchange produces. */
export function federate(
  assertion: Readonly<Record<string, string>>,
  subjectClaim: string,
  nowMs: number,
  lifetimeMs = HOUR_MS,
): Credential | null {
  const subject = deriveFederatedSubject(assertion, subjectClaim);
  if (subject === null) return null;
  return {
    kind: "federated",
    subject,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + lifetimeMs,
    assertion,
  };
}

/** A stored service-account key. Present so the tests can reject it. */
export function storedKey(serviceAccount: string, issuedAtMs: number): Credential {
  return {
    kind: "serviceAccountKey",
    subject: serviceAccount,
    issuedAtMs,
    expiresAtMs: null,
  };
}
