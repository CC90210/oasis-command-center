/**
 * Does an unsubscribe actually persist now?
 *
 * email_suppressions carries a COALESCE expression unique index, and the adapter
 * was emitting a bare column list as the ON CONFLICT target. SQLite rejects that
 * outright, so every write to this table has failed since the Turso cutover —
 * including the CASL unsubscribe endpoint, and including two paths that never
 * read `.error` and therefore reported success.
 *
 * This exercises the real adapter against the real database:
 *   1. upsert a probe row            -> must succeed
 *   2. read it back                  -> must exist
 *   3. upsert the SAME key again     -> must UPDATE, not duplicate or error
 *   4. delete the probe
 *
 * Run: npx tsx scripts/upsert-conflict-probe.mjs
 */
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";

for (const f of ["probe.vars", ".env.local", ".env"]) {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) break;
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(2);
}

const { createTursoPostgrest } = await import("../lib/turso-postgrest.ts");
const raw = createClient({ url, authToken: token });
const db = createTursoPostgrest(raw);

const EMAIL = `probe-unsub-${Date.now()}@example.invalid`;
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? "\n         " + detail : ""}`);
  if (!ok) failures++;
}

console.log("=== 1. the exact upsert /api/unsubscribe performs ===");
const ins = await db.from("email_suppressions").upsert(
  { id: crypto.randomUUID(), email: EMAIL, tenant_id: null, brand: null,
    reason: "probe", source: "conflict-target-probe" },
  { onConflict: "email,tenant_id,brand", ignoreDuplicates: false },
);
check("upsert returns no error", !ins.error,
      ins.error ? JSON.stringify(ins.error).slice(0, 200) : "");

console.log("\n=== 2. is the row actually there? ===");
const read = await db.from("email_suppressions").select("email,reason,source").eq("email", EMAIL);
check("row is readable back", !read.error && (read.data?.length ?? 0) === 1,
      read.error ? JSON.stringify(read.error).slice(0, 160) : `rows=${read.data?.length ?? 0}`);

console.log("\n=== 3. same key again must UPDATE, not duplicate or throw ===");
const again = await db.from("email_suppressions").upsert(
  { id: crypto.randomUUID(), email: EMAIL, tenant_id: null, brand: null,
    reason: "probe-second", source: "conflict-target-probe" },
  { onConflict: "email,tenant_id,brand", ignoreDuplicates: false },
);
check("second upsert returns no error", !again.error,
      again.error ? JSON.stringify(again.error).slice(0, 200) : "");

const after = await db.from("email_suppressions").select("email,reason").eq("email", EMAIL);
check("still exactly one row", (after.data?.length ?? 0) === 1, `rows=${after.data?.length ?? 0}`);
check("reason was UPDATED", after.data?.[0]?.reason === "probe-second",
      `reason=${after.data?.[0]?.reason}`);

console.log("\n=== 4. cleanup ===");
const del = await raw.execute({ sql: 'DELETE FROM "email_suppressions" WHERE email = ?', args: [EMAIL] });
console.log(`  removed probe row (${del.rowsAffected} row)`);

console.log();
if (failures) {
  console.log(`${failures} check(s) FAILED — unsubscribe is still broken.`);
  process.exit(1);
}
console.log("PASS — unsubscribes persist. The CASL opt-out path works on Turso.");
