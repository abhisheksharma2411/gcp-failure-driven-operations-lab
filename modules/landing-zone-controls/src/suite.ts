// The contribution: a policy suite that fails in two directions.
//
// A guardrail suite that only checks that bad things are blocked will pass
// perfectly on a platform nobody can use. A landing zone that nobody can use
// is not secure, because the work still happens -- somewhere else, on someone's
// laptop, in a project outside the hierarchy, under a key that never expires.
//
// So every guardrail case here is paired with a golden-path case over the
// SAME landing zone, and the suite reports a failure if either side breaks:
//
//   guardrail leak  -- something that should have been refused was allowed
//   path break      -- the supported route a developer takes was refused
//   over-friction   -- the route works but costs more than its budget
//   viable escape   -- the route is blocked and a bypass is not
//
// The fourth is the one that matters most and is the easiest to miss. It is
// the difference between a control that holds and a control that is merely
// unenforceable in the direction anyone actually goes.

import type { Action, DenialLayer } from "./types.ts";
import type { LandingZone } from "./evaluate.ts";
import { effectivePermissions } from "./identity.ts";

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface GuardrailCase {
  readonly name: string;
  readonly action: Action;
  /** Which layer is expected to refuse. Naming it prevents right-for-the-
   *  wrong-reason passes: a config rejected because the principal happened to
   *  lack a permission has not demonstrated the constraint. */
  readonly expectDeniedBy: DenialLayer;
  /**
   * Which refusal within that layer was expected.
   *
   * The layer alone is not always enough. "This principal holds no such
   * permission" and "this credential never expires" are both identity
   * refusals, and a case that accepts either will keep passing after the
   * credential-lifetime rule is switched off. A negative control found
   * exactly that, so cases whose layer has more than one way to say no
   * pin down which one they meant.
   */
  readonly expectReason?: RegExp;
}

export interface GuardrailResult {
  readonly name: string;
  readonly passed: boolean;
  readonly expectedLayer: DenialLayer;
  readonly actualLayer?: DenialLayer;
  readonly detail: string;
}

export function runGuardrail(
  zone: LandingZone,
  c: GuardrailCase,
  nowMs: number,
): GuardrailResult {
  const d = zone.evaluate(c.action, nowMs);
  if (d.allowed) {
    return {
      name: c.name,
      passed: false,
      expectedLayer: c.expectDeniedBy,
      detail: `LEAK: allowed, expected refusal by ${c.expectDeniedBy}`,
    };
  }
  if (d.layer !== c.expectDeniedBy) {
    return {
      name: c.name,
      passed: false,
      expectedLayer: c.expectDeniedBy,
      actualLayer: d.layer,
      detail:
        `refused by ${d.layer}, not ${c.expectDeniedBy}: ${d.reason} ` +
        `-- the intended control was not the one that fired`,
    };
  }
  if (c.expectReason !== undefined && !c.expectReason.test(d.reason ?? "")) {
    return {
      name: c.name,
      passed: false,
      expectedLayer: c.expectDeniedBy,
      actualLayer: d.layer,
      detail:
        `refused by the right layer for the wrong reason: expected ` +
        `${c.expectReason} but got "${d.reason}"`,
    };
  }
  return {
    name: c.name,
    passed: true,
    expectedLayer: c.expectDeniedBy,
    actualLayer: d.layer,
    detail: d.reason ?? "refused",
  };
}

// ---------------------------------------------------------------------------
// The golden path
// ---------------------------------------------------------------------------

export interface GoldenPathStep {
  readonly name: string;
  readonly action: Action;
}

export interface FrictionBudget {
  /** How many distinct permissions the developer may hold. */
  readonly maxPermissions: number;
  /** How many steps may require a human to approve something. */
  readonly maxManualApprovals: number;
}

export interface GoldenPath {
  readonly name: string;
  readonly developer: string;
  /** The project whose grants are measured for the privilege budget. */
  readonly measuredAt: string;
  readonly steps: readonly GoldenPathStep[];
  readonly budget: FrictionBudget;
  /**
   * What the developer does instead when the path does not work.
   *
   * These are not things the platform offers. They are things a person under
   * deadline finds. If the path is blocked and one of these succeeds, the
   * guardrails have not prevented the outcome -- they have only moved it
   * somewhere with no guardrails at all.
   */
  readonly escapeRoutes?: readonly GoldenPathStep[];
}

export interface GoldenPathResult {
  readonly name: string;
  readonly passed: boolean;
  readonly permissionsHeld: number;
  readonly permissions: readonly string[];
  readonly manualApprovals: number;
  readonly stepCount: number;
  readonly blockedSteps: readonly { name: string; layer?: DenialLayer; reason?: string }[];
  readonly viableEscapes: readonly string[];
  readonly failures: readonly string[];
}

export function runGoldenPath(
  zone: LandingZone,
  path: GoldenPath,
  nowMs: number,
): GoldenPathResult {
  const perms = [
    ...effectivePermissions(zone.hierarchy, path.developer, path.measuredAt, nowMs),
  ].sort();

  const blocked: { name: string; layer?: DenialLayer; reason?: string }[] = [];
  let manualApprovals = 0;

  for (const step of path.steps) {
    if (step.action.requiresManualApproval === true) manualApprovals += 1;
    const d = zone.evaluate(step.action, nowMs);
    if (!d.allowed) {
      blocked.push({ name: step.name, layer: d.layer, reason: d.reason });
    }
  }

  // Escapes are only evaluated when the path is actually broken. A bypass that
  // exists but that nobody has a reason to take is a separate concern, and the
  // guardrail cases are where it belongs.
  const viableEscapes: string[] = [];
  if (blocked.length > 0) {
    for (const escape of path.escapeRoutes ?? []) {
      if (zone.evaluate(escape.action, nowMs).allowed) viableEscapes.push(escape.name);
    }
  }

  const failures: string[] = [];
  if (blocked.length > 0) {
    failures.push(
      `PATH BREAK: ${blocked.length} of ${path.steps.length} steps refused ` +
        `(${blocked.map((b) => `${b.name}/${b.layer}`).join(", ")})`,
    );
  }
  if (perms.length > path.budget.maxPermissions) {
    failures.push(
      `OVER-PRIVILEGE: developer holds ${perms.length} permissions, ` +
        `budget is ${path.budget.maxPermissions}`,
    );
  }
  if (manualApprovals > path.budget.maxManualApprovals) {
    failures.push(
      `OVER-FRICTION: ${manualApprovals} manual approvals, ` +
        `budget is ${path.budget.maxManualApprovals}`,
    );
  }
  if (viableEscapes.length > 0) {
    failures.push(
      `VIABLE ESCAPE: the supported path is blocked but ` +
        `${viableEscapes.join(", ")} still works -- the work will go there`,
    );
  }

  return {
    name: path.name,
    passed: failures.length === 0,
    permissionsHeld: perms.length,
    permissions: perms,
    manualApprovals,
    stepCount: path.steps.length,
    blockedSteps: blocked,
    viableEscapes,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Both sides at once
// ---------------------------------------------------------------------------

export interface Suite {
  readonly name: string;
  readonly guardrails: readonly GuardrailCase[];
  readonly goldenPaths: readonly GoldenPath[];
}

export interface SuiteResult {
  readonly name: string;
  readonly nowMs: number;
  readonly passed: boolean;
  readonly guardrails: readonly GuardrailResult[];
  readonly goldenPaths: readonly GoldenPathResult[];
  readonly guardrailsPassed: number;
  readonly goldenPathsPassed: number;
  readonly summary: string;
}

/**
 * Run every guardrail and every golden path against one landing zone at one
 * instant, and pass only if both sides hold.
 *
 * The instant matters: a suite that passes on Monday and has not been re-run
 * says nothing about Friday, because exceptions expire between them. Callers
 * are expected to run this at several instants -- the report does.
 */
export function runSuite(zone: LandingZone, suite: Suite, nowMs: number): SuiteResult {
  const guardrails = suite.guardrails.map((g) => runGuardrail(zone, g, nowMs));
  const goldenPaths = suite.goldenPaths.map((p) => runGoldenPath(zone, p, nowMs));

  const gp = guardrails.filter((g) => g.passed).length;
  const pp = goldenPaths.filter((p) => p.passed).length;
  const passed = gp === guardrails.length && pp === goldenPaths.length;

  return {
    name: suite.name,
    nowMs,
    passed,
    guardrails,
    goldenPaths,
    guardrailsPassed: gp,
    goldenPathsPassed: pp,
    summary:
      `${gp}/${guardrails.length} guardrails held, ` +
      `${pp}/${goldenPaths.length} golden paths usable`,
  };
}
