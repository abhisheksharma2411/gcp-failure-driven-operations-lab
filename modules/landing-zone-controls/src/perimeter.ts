// The perimeter question: where may data go?
//
// VPC Service Controls is an extra layer of defence that is independent of
// IAM: IAM enables identity-based access control, while a service perimeter
// enables context-based perimeter security including control of data egress.
// Both run here. Neither substitutes for the other, and the evaluator proves
// it by consulting them separately.

import type { Perimeter } from "./types.ts";

export interface PerimeterVerdict {
  readonly blocked: boolean;
  /** Set when a dry-run perimeter would have blocked but allowed the call. */
  readonly dryRunViolation: boolean;
  readonly reason?: string;
  readonly perimeter?: string;
}

const ALLOWED: PerimeterVerdict = { blocked: false, dryRunViolation: false };

/**
 * Decide whether an operation crossing from `fromProject` to `toProject` is
 * permitted.
 *
 * A perimeter allows free communication within it but by default blocks
 * communication to Google Cloud services across it. Copying data out with an
 * ordinary service operation is the documented example of what this stops.
 */
export function checkPerimeter(
  perimeters: readonly Perimeter[],
  fromProject: string,
  toProject: string | undefined,
  service: string | undefined,
): PerimeterVerdict {
  if (toProject === undefined || toProject === fromProject) return ALLOWED;

  for (const p of perimeters) {
    const fromInside = p.projects.includes(fromProject);
    const toInside = p.projects.includes(toProject);

    // Free communication within the perimeter.
    if (fromInside && toInside) continue;
    if (!fromInside && !toInside) continue;

    // Only restricted services are protected by the perimeter.
    if (service !== undefined && !p.restrictedServices.includes(service)) continue;

    if (fromInside && !toInside) {
      if (p.egressAllowedTo?.includes(toProject)) continue;
      const reason =
        `egress from ${fromProject} to ${toProject} crosses perimeter ${p.name}`;
      // Dry run monitors requests without preventing access, so the call
      // succeeds and the violation is recorded for someone to read.
      return p.dryRun
        ? { blocked: false, dryRunViolation: true, reason, perimeter: p.name }
        : { blocked: true, dryRunViolation: false, reason, perimeter: p.name };
    }

    if (!fromInside && toInside) {
      const reason =
        `ingress from ${fromProject} into perimeter ${p.name} is blocked`;
      return p.dryRun
        ? { blocked: false, dryRunViolation: true, reason, perimeter: p.name }
        : { blocked: true, dryRunViolation: false, reason, perimeter: p.name };
    }
  }
  return ALLOWED;
}
