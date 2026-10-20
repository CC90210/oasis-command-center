/**
 * An opt-out matches its own address, whatever characters the address holds.
 *
 * WHY. Every suppression check escapes LIKE wildcards the Postgres way and asks
 * the adapter for an ilike: "first_last@x.com" is sent as "first\_last@x.com"
 * so the underscore matches only itself (lib/lead-interactions-queries.ts
 * checkEmailSuppressed, plus the inline copies in lib/bulk-email/dispatch.ts,
 * lib/forms/oasis-funnel-email.ts and lib/forms/next-steps-email.ts). Postgres
 * reads a backslash as LIKE's escape character by default; SQLite has no
 * default, and lib/turso-postgrest.ts compiled `lower(col) LIKE ?` with no
 * ESCAPE clause. So on Turso the backslash was a literal character and an
 * address with "_" or "%" never matched its own opt-out row: drips, scheduled
 * sends, per-lead email and bulk email all went on mailing people who had
 * unsubscribed (found in the 2026-10-19 audit).
 *
 * This runs the real adapter against a real in-memory libSQL database.
 *
 * Run: node --conditions=react-server --import tsx tests/opt-out-matches-every-address.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";

/** The escaping every suppression caller uses (lib/lead-interactions-queries.ts). */
const escapeLike = (addr: string) => addr.replace(/[%_\\]/g, "\\$&");

async function main() {
  const client = createClient({ url: ":memory:" });
  const db = createTursoPostgrest(client);
  await client.executeMultiple(`
    CREATE TABLE email_suppressions (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, brand TEXT);
    INSERT INTO email_suppressions VALUES
      ('s1', 't1', 'first_last@example.com', 'OASIS AI'),
      ('s2', 't1', 'pct%sign@example.com', 'OASIS AI'),
      ('s3', 't1', 'plain@example.com', 'OASIS AI'),
      ('s4', 't1', 'Mixed_Case@Example.com', 'OASIS AI');
  `);

  async function suppressed(addr: string): Promise<boolean> {
    const r = await db
      .from("email_suppressions")
      .select("email")
      .eq("tenant_id", "t1")
      .ilike("email", escapeLike(addr.trim().toLowerCase()))
      .limit(1);
    assert.equal(r.error, null, `lookup for ${addr} must not error`);
    return (r.data?.length ?? 0) > 0;
  }

  // 1. The addresses that used to slip through now match their own row.
  assert.equal(await suppressed("first_last@example.com"), true, "underscore address matches its opt-out");
  assert.equal(await suppressed("pct%sign@example.com"), true, "percent address matches its opt-out");
  assert.equal(await suppressed("FIRST_LAST@EXAMPLE.COM"), true, "case does not matter");
  assert.equal(await suppressed("mixed_case@example.com"), true, "a mixed-case stored address still matches");
  assert.equal(await suppressed("plain@example.com"), true, "plain addresses keep matching");

  // 2. An escaped wildcard is a literal: no stranger is suppressed by it.
  assert.equal(await suppressed("firstXlast@example.com"), false, "'_' in the row is not a one-character wildcard");
  assert.equal(await suppressed("pctANYTHINGsign@example.com"), false, "'%' in the row is not a wildcard");
  assert.equal(await suppressed("someone@example.com"), false, "an unrelated address is not suppressed");

  // 3. Callers that pass real wildcards keep their meaning.
  const contains = await db.from("email_suppressions").select("id").ilike("email", "%@example.com");
  assert.equal(contains.data?.length, 4, "an unescaped % still matches any run of characters");
  const star = await db.from("email_suppressions").select("id").like("email", "plain*");
  assert.deepEqual(star.data?.map((r) => r.id), ["s3"], "PostgREST's * still means %");

  // 4. The same rule holds inside .or() and under .not().
  const viaOr = await db
    .from("email_suppressions")
    .select("id")
    .or(`email.ilike.${escapeLike("first_last@example.com")},email.eq.nobody@example.com`);
  assert.deepEqual(viaOr.data?.map((r) => r.id), ["s1"], ".or() ilike honours the escape");
  const negated = await db
    .from("email_suppressions")
    .select("id")
    .not("email", "ilike", escapeLike("first_last@example.com"));
  assert.deepEqual(negated.data?.map((r) => r.id).sort(), ["s2", "s3", "s4"], ".not() ilike honours the escape");

  // 5. Every suppression caller escapes with a backslash, which is the escape
  //    character the adapter now declares. A caller that switched to another
  //    convention would silently stop matching again.
  const root = join(__dirname, "..");
  for (const file of [
    "lib/lead-interactions-queries.ts",
    "lib/bulk-email/dispatch.ts",
    "lib/forms/oasis-funnel-email.ts",
    "lib/forms/next-steps-email.ts",
  ]) {
    const src = readFileSync(join(root, file), "utf8");
    assert.ok(src.includes('.replace(/[%_\\\\]/g, "\\\\$&")'),
      `${file} escapes LIKE wildcards with a backslash`);
  }

  console.log("opt-out-matches-every-address: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
