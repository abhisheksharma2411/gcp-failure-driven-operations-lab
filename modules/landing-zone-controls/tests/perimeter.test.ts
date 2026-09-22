import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPerimeter } from "../src/perimeter.ts";
import type { Perimeter } from "../src/types.ts";

const INSIDE = "projects/sensitive";
const ALSO_INSIDE = "projects/sensitive-2";
const OUTSIDE = "projects/partner";

const P: readonly Perimeter[] = [
  {
    name: "sensitive",
    projects: [INSIDE, ALSO_INSIDE],
    restrictedServices: ["storage.googleapis.com", "bigquery.googleapis.com"],
    dryRun: false,
  },
];

test("P1 communication inside the perimeter is free", () => {
  const v = checkPerimeter(P, INSIDE, ALSO_INSIDE, "storage.googleapis.com");
  assert.equal(v.blocked, false);
  assert.equal(v.dryRunViolation, false);
});

test("P2 egress across the perimeter is blocked by default", () => {
  const v = checkPerimeter(P, INSIDE, OUTSIDE, "storage.googleapis.com");
  assert.equal(v.blocked, true);
  assert.match(v.reason!, /crosses perimeter sensitive/);
});

test("P3 ingress into the perimeter is blocked", () => {
  const v = checkPerimeter(P, OUTSIDE, INSIDE, "bigquery.googleapis.com");
  assert.equal(v.blocked, true);
  assert.match(v.reason!, /ingress/);
});

test("P4 only restricted services are protected", () => {
  const v = checkPerimeter(P, INSIDE, OUTSIDE, "run.googleapis.com");
  assert.equal(v.blocked, false);
});

test("P5 an explicit egress allowance is honoured", () => {
  const allowed: readonly Perimeter[] = [{ ...P[0]!, egressAllowedTo: [OUTSIDE] }];
  assert.equal(checkPerimeter(allowed, INSIDE, OUTSIDE, "storage.googleapis.com").blocked, false);
});

test("P6 dry run records the violation and lets the call through", () => {
  const dry: readonly Perimeter[] = [{ ...P[0]!, dryRun: true }];
  const v = checkPerimeter(dry, INSIDE, OUTSIDE, "storage.googleapis.com");
  assert.equal(v.blocked, false);
  assert.equal(v.dryRunViolation, true);
  assert.match(v.reason!, /crosses perimeter/);
});

test("P7 traffic that touches no perimeter is unaffected", () => {
  assert.equal(checkPerimeter(P, OUTSIDE, "projects/other", "storage.googleapis.com").blocked, false);
  assert.equal(checkPerimeter(P, INSIDE, undefined, "storage.googleapis.com").blocked, false);
  assert.equal(checkPerimeter(P, INSIDE, INSIDE, "storage.googleapis.com").blocked, false);
});
