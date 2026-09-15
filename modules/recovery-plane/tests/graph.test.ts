import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAnchor, validate } from "../src/graph.ts";
import { COMPONENTS, DESIGNED_STEPS, NAIVE_STEPS } from "../src/scenarios.ts";
import type { Component, RecoveryStep } from "../src/types.ts";

test("T1 a step that reaches its own broken domain is flagged", () => {
  // The Meta shape: restore DNS using a bastion reached through IAP, and IAP
  // needs DNS.
  const r = validate(COMPONENTS, NAIVE_STEPS);
  const dns = r.findings.filter((f) => f.stepId === "restore-dns" && f.kind === "CIRCULAR_DEPENDENCY");
  assert.ok(dns.length > 0, "restore-dns should be circular");
  assert.ok(dns.some((f) => f.path.includes("bastion")));
});

test("T2 the transitive chain is reported, not just the direct dependency", () => {
  const r = validate(COMPONENTS, NAIVE_STEPS);
  const deep = r.findings.find((f) => f.path.length > 1);
  assert.ok(deep, "expected at least one multi-hop chain");
  assert.ok(deep!.path.length >= 2);
});

test("T3 every undesigned step is unsafe", () => {
  const r = validate(COMPONENTS, NAIVE_STEPS);
  assert.equal(r.safeSteps.length, 0);
  assert.equal(r.ok, false);
});

test("T4 steps designed against the graph produce no findings", () => {
  const r = validate(COMPONENTS, DESIGNED_STEPS);
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings, null, 2));
  assert.equal(r.safeSteps.length, DESIGNED_STEPS.length);
  assert.equal(r.ok, true);
});

test("T5 an identity repair that authenticates through the primary IdP is flagged", () => {
  const r = validate(COMPONENTS, NAIVE_STEPS);
  const id = r.findings.filter((f) => f.stepId === "rotate-compromised-key");
  assert.ok(id.length > 0);
  assert.ok(id.every((f) => f.domain === "identity"));
});

test("T6 independence cannot be asserted around a broken dependency", () => {
  // The defect this test found: an earlier design let a component declare
  // itself independent, which silently excluded its whole subtree. A thing
  // named "survivor" that needs a broken thing is not a survivor.
  const comps: Component[] = [
    { id: "broken", inDomains: ["net"], dependsOn: [] },
    { id: "survivor-in-name-only", inDomains: [], dependsOn: ["broken"] },
  ];
  const steps: RecoveryStep[] = [
    { id: "fix", description: "", repairs: "net", uses: ["survivor-in-name-only"] },
  ];
  const r = validate(comps, steps);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.kind === "CIRCULAR_DEPENDENCY" && f.path.includes("broken")));
});

test("T6b a genuine anchor is derived from its whole closure, not declared", () => {
  const comps: Component[] = [
    { id: "token", inDomains: [], dependsOn: [] },
    { id: "console", inDomains: [], dependsOn: ["token"] },
  ];
  const steps: RecoveryStep[] = [
    { id: "fix", description: "", repairs: "net", uses: ["console"] },
  ];
  const r = validate(comps, steps);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.ok(isAnchor("console", new Map(comps.map((c) => [c.id, c]))));
});

test("T7 an undeclared component is reported rather than silently ignored", () => {
  const steps: RecoveryStep[] = [
    { id: "fix", description: "", repairs: "net", uses: ["does-not-exist"] },
  ];
  const r = validate(COMPONENTS, steps);
  assert.ok(r.findings.some((f) => f.kind === "UNDECLARED_COMPONENT"));
});

test("T8 a step with no independent component is flagged even when not circular", () => {
  const comps: Component[] = [
    { id: "thing", inDomains: ["other-domain"], dependsOn: [] },
  ];
  const steps: RecoveryStep[] = [
    { id: "fix", description: "", repairs: "net", uses: ["thing"] },
  ];
  const r = validate(comps, steps);
  assert.ok(r.findings.some((f) => f.kind === "NO_ANCHOR"));
});

test("T9 a dependency cycle does not hang the validator", () => {
  const comps: Component[] = [
    { id: "a", inDomains: [], dependsOn: ["b"] },
    { id: "b", inDomains: [], dependsOn: ["a"] },
  ];
  const steps: RecoveryStep[] = [{ id: "fix", description: "", repairs: "net", uses: ["a"] }];
  const r = validate(comps, steps); // must terminate
  assert.ok(Array.isArray(r.findings));
});

test("T10 the audit log is an anchor, derived from having no domain and no dependencies", () => {
  const byId = new Map(COMPONENTS.map((c) => [c.id, c]));
  assert.equal(isAnchor("admin-activity-logs", byId), true);
  // And the out-of-band console is an anchor only because its whole chain is.
  assert.equal(isAnchor("out-of-band-console", byId), true);
  // While anything on the normal path is not, however it is named.
  assert.equal(isAnchor("bastion", byId), false);
});

test("T11 a differently named tool sharing dependencies is not independent", () => {
  // "chat" and "wiki-runbooks" are different products that both need DNS and
  // the primary IdP. Renaming a dependency does not remove it.
  const r = validate(COMPONENTS, [
    { id: "fix-dns", description: "", repairs: "network", uses: ["chat", "wiki-runbooks"] },
  ]);
  assert.ok(r.findings.some((f) => f.path.includes("corp-dns")));
});
