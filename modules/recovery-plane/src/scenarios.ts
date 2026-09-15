import type { Component, RecoveryStep } from "./types.ts";

/**
 * A fictional environment. No real organisation is modelled, and the shape is
 * deliberately ordinary — this is what a competent estate looks like before
 * anyone draws the graph.
 */
export const COMPONENTS: readonly Component[] = [
  // --- the normal operating path ---
  { id: "corp-dns", inDomains: ["network"], dependsOn: [] },
  { id: "corp-network", inDomains: ["network"], dependsOn: [] },
  { id: "identity-provider", inDomains: ["identity"], dependsOn: ["corp-dns", "corp-network"] },
  { id: "iap", inDomains: ["identity"], dependsOn: ["identity-provider", "corp-dns"] },
  { id: "bastion", inDomains: ["network"], dependsOn: ["iap", "corp-network"] },
  { id: "admin-console", inDomains: ["identity"], dependsOn: ["iap"] },
  { id: "ci-pipeline", inDomains: ["network"], dependsOn: ["identity-provider", "corp-network"] },
  { id: "chat", inDomains: ["network"], dependsOn: ["corp-dns", "identity-provider"] },
  { id: "wiki-runbooks", inDomains: ["network"], dependsOn: ["corp-dns", "identity-provider"] },
  { id: "central-logging", inDomains: ["network"], dependsOn: ["corp-network"] },
  { id: "secret-manager", inDomains: ["identity"], dependsOn: ["identity-provider"] },

  // --- things that survive ---
  // Anchors. Nothing here is asserted to survive: each is free of every
  // declared domain, and so is everything it depends on, all the way down.
  // The validator derives that rather than taking anyone's word for it.
  {
    id: "admin-activity-logs",
    inDomains: [],
    dependsOn: [],
    // "Admin Activity audit logs are always written; you can't configure,
    // exclude, or disable them." Not even by the operator, which is what makes
    // it a foundation rather than one more dependency.
  },
  { id: "hardware-token", inDomains: [], dependsOn: [] },
  { id: "printed-runbook", inDomains: [], dependsOn: [] },
  // A separate identity path that does not federate through the primary IdP.
  { id: "recovery-idp", inDomains: [], dependsOn: ["hardware-token"] },
  { id: "out-of-band-console", inDomains: [], dependsOn: ["recovery-idp"] },
];

/** What most organisations actually have written down, if anything. */
export const NAIVE_STEPS: readonly RecoveryStep[] = [
  {
    id: "restore-dns",
    description: "Repair corporate DNS resolution",
    repairs: "network",
    // Reaches the bastion through IAP, which needs DNS. This is the Meta shape.
    uses: ["bastion", "wiki-runbooks", "chat"],
  },
  {
    id: "rotate-compromised-key",
    description: "Rotate a leaked credential",
    repairs: "identity",
    uses: ["admin-console", "secret-manager"],
  },
  {
    id: "redeploy-service",
    description: "Roll a service back to a known-good revision",
    repairs: "network",
    uses: ["ci-pipeline", "chat"],
  },
];

/** The same three repairs, designed against the graph rather than around it. */
export const DESIGNED_STEPS: readonly RecoveryStep[] = [
  {
    id: "restore-dns",
    description: "Repair corporate DNS resolution",
    repairs: "network",
    uses: ["out-of-band-console", "printed-runbook", "admin-activity-logs"],
  },
  {
    id: "rotate-compromised-key",
    description: "Rotate a leaked credential",
    repairs: "identity",
    uses: ["out-of-band-console", "printed-runbook", "admin-activity-logs"],
  },
  {
    id: "redeploy-service",
    description: "Roll a service back to a known-good revision",
    repairs: "network",
    uses: ["out-of-band-console", "printed-runbook", "admin-activity-logs"],
  },
];
