/**
 * Idempotent seeding of entities, charts, categories and tax codes from the
 * pure definition in chart.ts. Runs once per process on first use; every
 * statement is INSERT OR IGNORE, so concurrent cold starts are harmless and a
 * founder's edits are never overwritten.
 *
 * Workers recycle isolates often, and "once per process" was a ~200-statement
 * write transaction on the first page of every cold isolate. So the batch is
 * now gated by ONE read: count the seeded primary keys that already exist
 * (indexed lookups) and write only when any is missing. The key list is
 * derived from seedStatements() itself, so a row added to chart.ts later is
 * noticed and seeded. A statement whose table has no known key column makes
 * the check fail closed — the batch runs, exactly as before.
 */
import "server-only";

import { cache } from "react";
import { settledOnce } from "@/lib/runtime/settled-once";
import { seedStatements, type SeedStatement } from "./chart";
import { n, queryOne, writeBatch } from "./db";

/** Primary-key column of each seeded table; the key is each statement's first arg. */
const SEED_KEY_COLUMN: Readonly<Record<string, string>> = {
  fin_entities: "id",
  fin_settings: "entity_id",
  fin_accounts: "id",
  fin_categories: "id",
  fin_tax_codes: "id",
  fin_rules: "id",
};

/** One SELECT that counts the seeded keys already present, or null when the shape is unknown. */
export function seedPresenceQuery(statements: readonly SeedStatement[]): { sql: string; args: string[]; expected: number } | null {
  const byTable = new Map<string, string[]>();
  for (const st of statements) {
    const table = /INSERT OR IGNORE INTO (\w+)/.exec(st.sql)?.[1];
    const key = st.args[0];
    if (!table || !SEED_KEY_COLUMN[table] || typeof key !== "string") return null;
    byTable.set(table, [...(byTable.get(table) || []), key]);
  }
  if (byTable.size === 0) return null;
  const parts: string[] = [];
  const args: string[] = [];
  for (const [table, keys] of byTable) {
    parts.push(`(SELECT COUNT(*) FROM ${table} WHERE ${SEED_KEY_COLUMN[table]} IN (${keys.map(() => "?").join(", ")}))`);
    args.push(...keys);
  }
  return { sql: `SELECT ${parts.join(" + ")} AS n`, args, expected: args.length };
}

async function seedIfMissing(): Promise<void> {
  const statements = seedStatements();
  const presence = seedPresenceQuery(statements);
  if (presence) {
    const row = await queryOne<{ n: number }>(presence.sql, presence.args);
    if (n(row?.n) === presence.expected) return;
  }
  await writeBatch(statements.map((st) => ({ sql: st.sql, args: st.args })));
}

/**
 * Only a FINISHED check is shared across requests. This used to be a
 * module-level promise, so a request arriving while another request's check
 * was in flight awaited that request's read; the Workers runtime cancels such
 * a waiter as hung, and an aborted check left the promise pending for the
 * isolate's lifetime (2026-10-01 pipeline incident; lib/runtime/settled-once.ts).
 * cache() still shares one check within a request. A failure is not
 * remembered across requests: the next request checks again (within the same
 * request, cache() hands later callers the same rejection).
 */
const seedCheck = settledOnce(cache(seedIfMissing));

export function ensureFinanceSeed(): Promise<void> {
  return seedCheck.get();
}

/** Tests only: forget the per-process memo. */
export function resetFinanceSeedMemo(): void {
  seedCheck.reset();
}
