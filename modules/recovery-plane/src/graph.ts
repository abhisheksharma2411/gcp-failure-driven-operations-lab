import type { Component, DomainId, Finding, RecoveryStep, ValidationResult } from "./types.ts";

/**
 * Everything a component transitively needs, including itself.
 *
 * Cycles in the dependency graph are possible and must not hang the validator;
 * a system whose components mutually depend on each other is exactly the kind
 * this tool exists to find.
 */
export function closure(
  start: readonly string[],
  components: ReadonlyMap<string, Component>,
): { reached: Set<string>; missing: Set<string>; parents: Map<string, string> } {
  const reached = new Set<string>();
  const missing = new Set<string>();
  const parents = new Map<string, string>();
  const queue = [...start];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    const c = components.get(id);
    if (!c) {
      missing.add(id);
      continue;
    }
    reached.add(id);
    for (const dep of c.dependsOn) {
      if (!reached.has(dep) && !parents.has(dep)) parents.set(dep, id);
      queue.push(dep);
    }
  }
  return { reached, missing, parents };
}

/** Rebuild the chain that led to a component, for a readable finding. */
function chain(target: string, parents: ReadonlyMap<string, string>, roots: readonly string[]): string[] {
  const path = [target];
  let cur = target;
  const guard = new Set<string>([target]);
  while (!roots.includes(cur)) {
    const parent = parents.get(cur);
    if (parent === undefined || guard.has(parent)) break;
    path.unshift(parent);
    guard.add(parent);
    cur = parent;
  }
  return path;
}

/**
 * Is this component an anchor: does nothing in its whole closure belong to any
 * failure domain?
 *
 * Derived rather than declared. An anchor is something like an immutable audit
 * log, a hardware token, or a printed runbook — and crucially, something whose
 * dependencies are also anchors, all the way down. A "recovery" console that
 * federates through the primary identity provider is not an anchor no matter
 * what it is called.
 */
export function isAnchor(id: string, components: ReadonlyMap<string, Component>): boolean {
  const { reached, missing } = closure([id], components);
  if (missing.size > 0) return false;
  for (const r of reached) {
    if ((components.get(r)?.inDomains.length ?? 0) > 0) return false;
  }
  return true;
}

/**
 * The validator.
 *
 * For each recovery step, walk everything it transitively depends on. If any of
 * those components sits in the very domain the step is meant to repair, the
 * step is circular: it cannot run at the only time it is needed.
 */
export function validate(
  components: readonly Component[],
  steps: readonly RecoveryStep[],
): ValidationResult {
  const byId = new Map(components.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  const safeSteps: string[] = [];

  for (const step of steps) {
    const { reached, missing, parents } = closure(step.uses, byId);

    for (const m of missing) {
      findings.push({
        kind: "UNDECLARED_COMPONENT",
        stepId: step.id,
        domain: step.repairs,
        path: chain(m, parents, step.uses),
        message: `step "${step.id}" uses "${m}", which is not declared in the graph`,
      });
    }

    let circular = false;
    for (const id of reached) {
      const c = byId.get(id)!;
      if (c.inDomains.includes(step.repairs)) {
        circular = true;
        findings.push({
          kind: "CIRCULAR_DEPENDENCY",
          stepId: step.id,
          domain: step.repairs,
          path: chain(id, parents, step.uses),
          message:
            `step "${step.id}" repairs domain "${step.repairs}" but depends on ` +
            `"${id}", which fails in that same domain`,
        });
      }
    }

    const hasAnchor = step.uses.some((id) => isAnchor(id, byId));
    if (!circular && !hasAnchor && reached.size > 0) {
      findings.push({
        kind: "NO_ANCHOR",
        stepId: step.id,
        domain: step.repairs,
        path: [...step.uses],
        message:
          `step "${step.id}" uses nothing that is free of every failure domain; ` +
          `it survives "${step.repairs}" but rests entirely on things that fail elsewhere`,
      });
    }

    if (!circular && missing.size === 0 && hasAnchor) safeSteps.push(step.id);
  }

  return { findings, ok: findings.length === 0, safeSteps };
}
