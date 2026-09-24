/**
 * Idempotent seeding of entities, charts, categories and tax codes from the
 * pure definition in chart.ts. Runs once per process on first use; every
 * statement is INSERT OR IGNORE, so concurrent cold starts are harmless and a
 * founder's edits are never overwritten.
 */
import "server-only";

import { seedStatements } from "./chart";
import { writeBatch } from "./db";

let seeded: Promise<void> | null = null;

export function ensureFinanceSeed(): Promise<void> {
  if (!seeded) {
    seeded = writeBatch(seedStatements().map((st) => ({ sql: st.sql, args: st.args })))
      .then(() => undefined)
      .catch((e) => {
        seeded = null; // retry next call rather than caching a failure
        throw e;
      });
  }
  return seeded;
}

/** Tests only: forget the per-process memo. */
export function resetFinanceSeedMemo(): void {
  seeded = null;
}
