// The three questions, asked in order, on every action.
//
//   who   -- may this principal act here, and is its credential still good?
//   what  -- is this a shape the platform permits?
//   where -- may data move to where this is sending it?
//
// The layers are independent. A principal with every permission still loses to
// a constraint; a perfectly-shaped resource still loses to a perimeter. The
// evaluator never lets one layer's answer stand in for another's, and the
// denial reason always names which one refused.

import type { Action, Decision, DenialLayer, Perimeter, AuditSink } from "./types.ts";
import { Hierarchy } from "./hierarchy.ts";
import { checkConfiguration } from "./policy.ts";
import { checkPerimeter } from "./perimeter.ts";
import { resolveSink } from "./audit.ts";
import {
  canImpersonate,
  credentialIsValid,
  hasPermission,
  isShortLived,
  permissionForOperation,
} from "./identity.ts";

export interface LandingZoneOptions {
  /**
   * Reject any credential that never expires. A platform that requires
   * short-lived identity has to actually refuse the long-lived one.
   */
  readonly requireShortLivedCredentials: boolean;
  /** The bar a credential must meet when the above is on. */
  readonly maxCredentialLifetimeMs?: number;
  /** Which project each service account lives in, for impersonation scope. */
  readonly serviceAccountProjects?: Readonly<Record<string, string>>;
}

export class LandingZone {
  readonly hierarchy: Hierarchy;
  readonly perimeters: readonly Perimeter[];
  readonly sinks: readonly AuditSink[];
  readonly options: LandingZoneOptions;

  constructor(
    hierarchy: Hierarchy,
    perimeters: readonly Perimeter[] = [],
    sinks: readonly AuditSink[] = [],
    options: LandingZoneOptions = { requireShortLivedCredentials: true },
  ) {
    this.hierarchy = hierarchy;
    this.perimeters = perimeters;
    this.sinks = sinks;
    this.options = options;
  }

  evaluate(action: Action, nowMs: number): Decision {
    const trace: string[] = [];

    const deny = (layer: DenialLayer, reason: string): Decision => {
      trace.push(`DENY[${layer}] ${reason}`);
      return { allowed: false, layer, reason, trace, auditedTo: this.#sinkFor(action) };
    };

    // ---- who ------------------------------------------------------------
    if (!credentialIsValid(action.credential, nowMs)) {
      return deny(
        "identity",
        `credential for ${action.credential.subject} is not valid at ${nowMs}`,
      );
    }
    trace.push(`identity: credential kind=${action.credential.kind} valid`);

    if (
      this.options.requireShortLivedCredentials &&
      !isShortLived(action.credential, nowMs, this.options.maxCredentialLifetimeMs)
    ) {
      return deny(
        "identity",
        `credential for ${action.credential.subject} is long-lived ` +
          `(kind=${action.credential.kind}); this platform requires short-lived identity`,
      );
    }

    // The credential asserts an identity; the action claims one. A credential
    // for A does not let B act, and an impersonated credential acts as the
    // service account, not as the human behind it.
    const acting = action.credential.subject;
    if (action.credential.kind !== "impersonated" && acting !== action.principal) {
      return deny(
        "identity",
        `credential asserts ${acting} but the action claims ${action.principal}`,
      );
    }

    if (!this.hierarchy.has(action.targetProject)) {
      return deny("identity", `unknown target project ${action.targetProject}`);
    }

    if (action.operation === "iam.impersonate") {
      const target = action.impersonationTarget;
      if (target === undefined) {
        return deny("identity", "impersonation attempted with no target");
      }
      const saProject =
        this.options.serviceAccountProjects?.[target] ?? action.targetProject;
      if (!this.hierarchy.has(saProject)) {
        return deny("identity", `service account ${target} lives in no known project`);
      }
      if (!canImpersonate(this.hierarchy, action.principal, target, saProject, nowMs)) {
        return deny(
          "identity",
          `${action.principal} lacks iam.serviceAccounts.getAccessToken on ${target}`,
        );
      }
      trace.push(`identity: ${action.principal} may impersonate ${target}`);
    } else {
      const needed = permissionForOperation(action.operation);
      if (needed === null) {
        return deny("identity", `unknown operation ${action.operation}`);
      }
      if (!hasPermission(this.hierarchy, action.principal, action.targetProject, needed, nowMs)) {
        return deny(
          "identity",
          `${action.principal} lacks ${needed} on ${action.targetProject}`,
        );
      }
      trace.push(`identity: ${action.principal} holds ${needed}`);
    }

    // ---- what -----------------------------------------------------------
    const violations = checkConfiguration(
      this.hierarchy,
      action.targetProject,
      action.config,
      nowMs,
    );
    if (violations.length > 0) {
      const first = violations[0]!;
      return deny(
        "configuration",
        `${first.reason} (constraint ${first.constraint} from ${first.sourceNodeId})`,
      );
    }
    trace.push("configuration: no constraint violated");

    // ---- where ----------------------------------------------------------
    const perimeter = checkPerimeter(
      this.perimeters,
      action.targetProject,
      action.egressToProject,
      action.config?.service,
    );
    if (perimeter.blocked) {
      return deny("perimeter", perimeter.reason ?? "blocked by service perimeter");
    }
    if (perimeter.dryRunViolation) {
      trace.push(`perimeter: DRY-RUN would have blocked -- ${perimeter.reason}`);
      return {
        allowed: true,
        trace,
        dryRunViolation: perimeter.reason,
        auditedTo: this.#sinkFor(action),
      };
    }
    trace.push("perimeter: no boundary crossed");

    return { allowed: true, trace, auditedTo: this.#sinkFor(action) };
  }

  #sinkFor(action: Action): string | undefined {
    if (!this.hierarchy.has(action.targetProject)) return undefined;
    return resolveSink(this.hierarchy, this.sinks, action.targetProject)?.name;
  }
}
