// Export the signal, SLO, alert and dashboard catalogue to definitions/.
//
//   node scripts/export-definitions.ts          write the file
//   node scripts/export-definitions.ts --check  fail if it has drifted
//
// The check runs in `make verify`. A definitions file that disagrees with the
// code it came from is worse than no definitions file, because somebody will
// read it and believe it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { definitionBundle } from "../src/dashboard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "definitions");
const OUT = join(OUT_DIR, "observability-definitions.json");

const serialised = JSON.stringify(definitionBundle(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error("definitions/observability-definitions.json is missing; run: node scripts/export-definitions.ts");
    process.exit(1);
  }
  if (current !== serialised) {
    console.error("definitions/observability-definitions.json has drifted from src/; run: node scripts/export-definitions.ts");
    process.exit(1);
  }
  console.log("definitions: no drift");
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, serialised);
  console.log(`wrote ${OUT}`);
}
