// The resource hierarchy, and what a policy resolves to at a given node
// at a given instant.

import type {
  ConstraintId,
  ConstraintValue,
  Grant,
  PolicyBinding,
  ResourceNode,
} from "./types.ts";

export class HierarchyError extends Error {}

/**
 * The organization, its folders and its projects, plus the policies and grants
 * attached to them.
 *
 * Everything that resolves -- effective policy, effective permissions -- is
 * computed by walking this tree. Nothing is cached, because a resolution is
 * only correct for the instant it was asked about.
 */
export class Hierarchy {
  readonly #nodes = new Map<string, ResourceNode>();
  readonly #policies: PolicyBinding[] = [];
  readonly #grants: Grant[] = [];

  addNode(node: ResourceNode): this {
    if (this.#nodes.has(node.id)) {
      throw new HierarchyError(`duplicate node: ${node.id}`);
    }
    if (node.kind === "organization") {
      if (node.parent !== null) {
        throw new HierarchyError("the organization is the root and has no parent");
      }
      for (const existing of this.#nodes.values()) {
        if (existing.kind === "organization") {
          throw new HierarchyError("a hierarchy has exactly one organization");
        }
      }
    } else {
      if (node.parent === null) {
        throw new HierarchyError(`${node.id}: only the organization may have no parent`);
      }
      if (!this.#nodes.has(node.parent)) {
        throw new HierarchyError(`${node.id}: parent ${node.parent} does not exist`);
      }
      const parent = this.#nodes.get(node.parent)!;
      if (parent.kind === "project") {
        throw new HierarchyError(`${node.id}: a project cannot contain resources`);
      }
    }
    this.#nodes.set(node.id, node);
    return this;
  }

  addPolicy(binding: PolicyBinding): this {
    if (!this.#nodes.has(binding.nodeId)) {
      throw new HierarchyError(`policy on unknown node: ${binding.nodeId}`);
    }
    if (binding.expiresAtMs !== null && !binding.justification) {
      // An exception without a stated reason is the thing that survives
      // forever because nobody can remember why it was granted.
      throw new HierarchyError(
        `exception on ${binding.nodeId}/${binding.constraint} needs a justification`,
      );
    }
    this.#policies.push(binding);
    return this;
  }

  addGrant(grant: Grant): this {
    if (!this.#nodes.has(grant.scope)) {
      throw new HierarchyError(`grant on unknown node: ${grant.scope}`);
    }
    this.#grants.push(grant);
    return this;
  }

  node(id: string): ResourceNode {
    const n = this.#nodes.get(id);
    if (!n) throw new HierarchyError(`unknown node: ${id}`);
    return n;
  }

  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  /** The node, then its parent, then its parent, up to the organization. */
  ancestry(id: string): readonly string[] {
    const path: string[] = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new HierarchyError(`cycle in hierarchy at ${cursor}`);
      }
      seen.add(cursor);
      path.push(cursor);
      cursor = this.node(cursor).parent;
    }
    return path;
  }

  /**
   * What a constraint resolves to at `nodeId` at `nowMs`.
   *
   * Policies inherit downward, and a policy set on a descendant overwrites the
   * inheritance. So the nearest binding wins -- but only while it is live. An
   * exception that has lapsed is skipped, and the inherited value applies
   * again without anyone doing anything.
   */
  effectivePolicy(
    nodeId: string,
    constraint: ConstraintId,
    nowMs: number,
  ): EffectivePolicy | null {
    for (const candidate of this.ancestry(nodeId)) {
      const bindings = this.#policies.filter(
        (p) => p.nodeId === candidate && p.constraint === constraint,
      );
      if (bindings.length === 0) continue;

      const live = bindings.filter(
        (p) => p.expiresAtMs === null || p.expiresAtMs > nowMs,
      );
      if (live.length === 0) {
        // Every binding at this node has lapsed. Keep walking up.
        continue;
      }
      // A node with more than one live binding for one constraint is a
      // modelling error, not a policy outcome.
      if (live.length > 1) {
        throw new HierarchyError(
          `${candidate}/${constraint}: ${live.length} live bindings; expected at most one`,
        );
      }
      const binding = live[0]!;
      return {
        value: binding.value,
        sourceNodeId: candidate,
        inherited: candidate !== nodeId,
        isException: binding.expiresAtMs !== null,
        expiresAtMs: binding.expiresAtMs,
        justification: binding.justification,
      };
    }
    return null;
  }

  /** Every policy binding, for reporting. */
  policies(): readonly PolicyBinding[] {
    return [...this.#policies];
  }

  /**
   * Grants that apply to `nodeId` for `principal` at `nowMs`.
   *
   * A role granted at a high level is inherited by all child resources, so a
   * grant anywhere on the path from the node to the organization counts.
   * An expired grant does not.
   */
  activeGrants(
    principal: string,
    nodeId: string,
    nowMs: number,
  ): readonly Grant[] {
    const path = new Set(this.ancestry(nodeId));
    return this.#grants.filter(
      (g) =>
        g.principal === principal &&
        path.has(g.scope) &&
        (g.expiresAtMs === null || g.expiresAtMs > nowMs),
    );
  }

  grants(): readonly Grant[] {
    return [...this.#grants];
  }

  nodes(): readonly ResourceNode[] {
    return [...this.#nodes.values()];
  }
}

export interface EffectivePolicy {
  readonly value: ConstraintValue;
  readonly sourceNodeId: string;
  readonly inherited: boolean;
  readonly isException: boolean;
  readonly expiresAtMs: number | null;
  readonly justification?: string;
}
