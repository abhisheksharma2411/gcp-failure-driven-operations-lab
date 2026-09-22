import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../scripts/render-policies.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("C1 the checked-in policy set matches the model", () => {
  const onDisk = readFileSync(join(HERE, "..", "policies", "landing-zone.json"), "utf8");
  assert.equal(
    onDisk,
    render(),
    "policies/landing-zone.json is stale; run: node scripts/render-policies.ts",
  );
});

test("C2 every exception in the policy set has an end date and a reason", () => {
  const doc = JSON.parse(readFileSync(join(HERE, "..", "policies", "landing-zone.json"), "utf8"));
  for (const p of doc.policies) {
    if (p.expiresAtMs === null) continue;
    assert.ok(p.justification, `exception on ${p.node}/${p.constraint} has no justification`);
  }
  // At least one exception exists, or the check above proves nothing.
  assert.ok(doc.policies.some((p: { expiresAtMs: number | null }) => p.expiresAtMs !== null));
});

test("C3 no grant in the policy set carries a wildcard role permanently", () => {
  const doc = JSON.parse(readFileSync(join(HERE, "..", "policies", "landing-zone.json"), "utf8"));
  for (const g of doc.grants) {
    if (g.role === "roles/owner" || g.role === "roles/paved.breakGlass") {
      assert.notEqual(
        g.expiresAtMs,
        null,
        `${g.principal} holds ${g.role} on ${g.scope} with no end date`,
      );
      assert.ok(g.justification, `${g.principal}'s ${g.role} grant has no justification`);
    }
  }
});

test("C4 the Terraform foundation has no default organization ID", () => {
  const tf = readFileSync(join(HERE, "..", "infra", "main.tf"), "utf8");
  const block = tf.slice(tf.indexOf('variable "organization_id"'));
  const body = block.slice(0, block.indexOf("\n}"));
  // Match an assignment, not the word. An earlier version of this test read
  // the variable's own description, which says "No default", and failed on it.
  assert.ok(
    !/^\s*default\s*=/m.test(body),
    "organization_id must have no default; applying this must be deliberate",
  );
  // And the control is real: the regex does fire on a variable that has one.
  const regions = tf.slice(tf.indexOf('variable "allowed_regions"'));
  assert.ok(/^\s*default\s*=/m.test(regions.slice(0, regions.indexOf("\n}"))));
});
