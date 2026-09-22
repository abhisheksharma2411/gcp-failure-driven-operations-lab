import { readFileSync } from "node:fs";
import type { RecoveryManifest } from "./types.ts";
import { SCHEMA_VERSION } from "./ledger.ts";

/** The shipped manifest, loaded from disk so the article and the tests agree. */
export function loadManifest(path = "manifests/recovery-manifest.json"): RecoveryManifest {
  return JSON.parse(readFileSync(path, "utf8")) as RecoveryManifest;
}

export const KEY = "projects/example/locations/global/keyRings/dr/cryptoKeys/ledger";

/**
 * A backup tool, described by what it can actually serialise.
 *
 * Typed rather than inferred: `as const` narrows these to literal types, and a
 * test that swaps one profile for another then fails to compile for no useful
 * reason.
 */
export interface ToolProfile {
  readonly toolVersion: number;
  readonly toolReadableSchemas: readonly number[];
}

/** A tool that can read the current schema. The happy path. */
export const GOOD_TOOL: ToolProfile = { toolVersion: 2, toolReadableSchemas: [1, SCHEMA_VERSION] };

/**
 * A tool one major version behind the source, which is the 2017 shape:
 * pg_dump 9.2 against a 9.6 database. The job succeeds; the output is unusable.
 */
export const STALE_TOOL: ToolProfile = { toolVersion: 1, toolReadableSchemas: [1] };

export const DAY = 86_400_000;
