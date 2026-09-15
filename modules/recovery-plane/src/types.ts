// A recovery dependency graph, and a validator that flags recovery steps
// sharing the failure domain they are meant to repair.
//
// The premise is one sentence from Meta's 2021 incident report:
//
//   "it was not possible to access our data centers through our normal means
//    because their networks were down, and second, the total loss of DNS broke
//    many of the internal tools we'd normally use to investigate and resolve
//    outages like this"
//
// The tools needed to fix the outage depended on the thing that was broken.
// That is not a mistake anyone makes deliberately; it is a property of a graph
// nobody drew. So draw it, and check it.

/** A failure domain is a thing that can fail as a unit. */
export type DomainId = string;

/** Anything a recovery step might rely on. */
export interface Component {
  readonly id: string;
  /** Domains this component stops working in. */
  readonly inDomains: readonly DomainId[];
  /** Other components this one needs in order to function. */
  readonly dependsOn: readonly string[];
}

/**
 * NOTE ON A REMOVED FEATURE.
 *
 * An earlier version had an `independent?: boolean` flag meaning "this keeps
 * working when everything else does not". Test T6 showed why that was wrong:
 * the flag was a self-reported assertion that silently excluded a component's
 * entire dependency subtree from validation. Mark IAP independent and the
 * validator stops looking — which is the precise failure mode this tool exists
 * to catch, reintroduced as a feature.
 *
 * Independence is now DERIVED. A component survives a domain when nothing in
 * its transitive closure sits in that domain, and it is an anchor when nothing
 * in its closure sits in any domain at all. Neither can be asserted.
 */

export interface RecoveryStep {
  readonly id: string;
  readonly description: string;
  /** The domain this step exists to repair. */
  readonly repairs: DomainId;
  /** Components this step uses. */
  readonly uses: readonly string[];
}

export type FindingKind =
  | "CIRCULAR_DEPENDENCY" // the step needs something the broken domain contains
  | "UNDECLARED_COMPONENT" // the step uses something not in the graph
  | "NO_ANCHOR"; // nothing in the step's chain is free of every failure domain

export interface Finding {
  readonly kind: FindingKind;
  readonly stepId: string;
  readonly domain: DomainId;
  /** The dependency chain that proves the problem, for the report. */
  readonly path: readonly string[];
  readonly message: string;
}

export interface ValidationResult {
  readonly findings: readonly Finding[];
  readonly ok: boolean;
  /** Steps proved independent of the domain they repair. */
  readonly safeSteps: readonly string[];
}
