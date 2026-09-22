import type { Dataset, InvariantResult, Posting } from "./types.ts";

export const SCHEMA_VERSION = 2;

/** Deterministic synthetic ledger. Balanced by construction. */
export function makeDataset(txnCount: number, startMs = 0): Dataset {
  const postings: Posting[] = [];
  for (let i = 0; i < txnCount; i += 1) {
    const amount = 100 + ((i * 37) % 900);
    const txnId = `t${i}`;
    const atMs = startMs + i * 1000;
    postings.push({ id: `${txnId}-d`, account: "cash", amountMinor: amount, txnId, atMs });
    postings.push({ id: `${txnId}-c`, account: "revenue", amountMinor: -amount, txnId, atMs });
  }
  return { postings, schemaVersion: SCHEMA_VERSION };
}

/**
 * The validation contract.
 *
 * These are business invariants, not health checks. A restore that produces a
 * technically valid store with an unbalanced ledger is a failed restore, and
 * row counts cannot tell you that.
 */
export function validate(d: Dataset): InvariantResult[] {
  const results: InvariantResult[] = [];

  const sum = d.postings.reduce((a, p) => a + p.amountMinor, 0);
  results.push({
    name: "double-entry balances to zero",
    passed: sum === 0,
    detail: `sum of all postings = ${sum} minor units`,
  });

  const byTxn = new Map<string, number>();
  for (const p of d.postings) byTxn.set(p.txnId, (byTxn.get(p.txnId) ?? 0) + p.amountMinor);
  const unbalanced = [...byTxn.entries()].filter(([, v]) => v !== 0);
  results.push({
    name: "every transaction balances individually",
    passed: unbalanced.length === 0,
    detail: unbalanced.length === 0
      ? "all transactions balance"
      : `${unbalanced.length} unbalanced: ${unbalanced.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  });

  const ids = new Set(d.postings.map((p) => p.id));
  results.push({
    name: "posting ids are unique",
    passed: ids.size === d.postings.length,
    detail: `${d.postings.length} postings, ${ids.size} distinct ids`,
  });

  const orphans = [...byTxn.entries()].filter(([txn]) =>
    d.postings.filter((p) => p.txnId === txn).length < 2);
  results.push({
    name: "no transaction has a single leg",
    passed: orphans.length === 0,
    detail: orphans.length === 0 ? "every transaction has both legs" : `${orphans.length} single-leg transactions`,
  });

  results.push({
    name: "dataset is non-empty",
    passed: d.postings.length > 0,
    detail: `${d.postings.length} postings`,
  });

  return results;
}

/** Corrupt a dataset in a way a row count cannot detect. */
export function dropOneLeg(d: Dataset): Dataset {
  const idx = d.postings.findIndex((p) => p.amountMinor < 0);
  return { ...d, postings: d.postings.filter((_, i) => i !== idx) };
}
