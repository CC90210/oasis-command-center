/**
 * tests/forms-delete-tenant-scope.test.ts
 *
 * WHY THIS FILE EXISTS. On 2026-08-22 an operator deleted a form and got
 * "not_found_or_forbidden" — while the form actually disappeared. The route
 * uses `.delete({ count: "exact" })` as its existence/tenant check, but the
 * Turso adapter's delete() silently discarded the option and runDelete()
 * always returned count:null, so EVERY delete reported 404 after succeeding.
 * The same shape exists at sequences/[id], cron-jobs/[id], and
 * lib/manifest/data.ts — a class, fixed once in the adapter.
 *
 * Two halves:
 *   1. Behavior — the exact create→delete chain the forms routes run, against
 *      a real in-memory libSQL database through the real adapter. Same tenant
 *      → count 1 (route: 200). Foreign tenant → count 0 AND the row survives
 *      (route: 404, correctly this time). Plus update({count}) for parity.
 *   2. Wiring — create (POST /api/forms) and delete (DELETE /api/forms/[id])
 *      must resolve the caller's tenant through the SAME resolveTenantId()
 *      from lib/api-auth. If either route ever grows its own tenant lookup,
 *      "a just-created form is deletable by its creator" is no longer
 *      guaranteed by construction — this pins the shared path.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";

async function main() {
  // ---------------------------------------------------------------- behavior
  const client = createClient({ url: ":memory:" });
  const db = createTursoPostgrest(client);

  await client.executeMultiple(`
    CREATE TABLE forms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1
    );
  `);

  const TENANT_A = "tenant-a";
  const TENANT_B = "tenant-b";

  // Create — the POST /api/forms shape (insert scoped to the caller's tenant).
  const created = await db
    .from("forms")
    .insert({ id: "f1", tenant_id: TENANT_A, slug: "form-x", name: "New form" })
    .select()
    .single();
  assert.equal(created.error, null, "create must succeed");
  assert.equal(created.data.tenant_id, TENANT_A);

  // Foreign-tenant delete — the DELETE route chain with the WRONG tenant.
  // Must report count 0 (→ 404) and must NOT remove the row.
  const foreign = await db
    .from("forms")
    .delete({ count: "exact" })
    .eq("id", "f1")
    .eq("tenant_id", TENANT_B);
  assert.equal(foreign.error, null);
  assert.equal(foreign.count, 0, "foreign-tenant delete must count 0");
  const survives = await db.from("forms").select("id").eq("id", "f1").maybeSingle();
  assert.ok(survives.data, "foreign-tenant delete must not remove the row");

  // Same-tenant delete — the exact route chain for the creator's tenant.
  // This is the regression: count came back null, `!count` → 404 after the
  // row was already gone.
  const own = await db
    .from("forms")
    .delete({ count: "exact" })
    .eq("id", "f1")
    .eq("tenant_id", TENANT_A);
  assert.equal(own.error, null);
  assert.equal(own.count, 1, "creator's delete must count exactly 1");
  const gone = await db.from("forms").select("id").eq("id", "f1").maybeSingle();
  assert.equal(gone.data, null, "row must actually be gone");

  // Repeat delete — id already gone → count 0 (→ 404, and that's honest now).
  const repeat = await db
    .from("forms")
    .delete({ count: "exact" })
    .eq("id", "f1")
    .eq("tenant_id", TENANT_A);
  assert.equal(repeat.count, 0, "double delete must count 0");

  // update({ count }) — same adapter defect class, same fix.
  await db.from("forms").insert({ id: "f2", tenant_id: TENANT_A, slug: "s2", name: "n2" });
  const upd = await db
    .from("forms")
    .update({ name: "renamed" }, { count: "exact" })
    .eq("id", "f2")
    .eq("tenant_id", TENANT_A);
  assert.equal(upd.error, null);
  assert.equal(upd.count, 1, "update count must report rows affected");
  const updMiss = await db
    .from("forms")
    .update({ name: "nope" }, { count: "exact" })
    .eq("id", "f2")
    .eq("tenant_id", TENANT_B);
  assert.equal(updMiss.count, 0, "foreign-tenant update must count 0");

  // Delete with RETURNING (.delete().select()) still counts.
  const delReturning = await db
    .from("forms")
    .delete({ count: "exact" })
    .eq("id", "f2")
    .eq("tenant_id", TENANT_A)
    .select();
  assert.equal(delReturning.count, 1, "delete+returning must still count");
  assert.equal(delReturning.data?.[0]?.id, "f2");

  // ---------------------------------------------------------------- wiring
  // Create and delete must share ONE tenant resolution path. Both route files
  // must import resolveTenantId from lib/api-auth and call it — no bespoke
  // profile lookup on either side.
  const root = path.join(__dirname, "..");
  const createRoute = readFileSync(path.join(root, "app", "api", "forms", "route.ts"), "utf8");
  const deleteRoute = readFileSync(
    path.join(root, "app", "api", "forms", "[id]", "route.ts"),
    "utf8",
  );
  for (const [label, src] of [
    ["app/api/forms/route.ts", createRoute],
    ["app/api/forms/[id]/route.ts", deleteRoute],
  ] as const) {
    assert.match(
      src,
      /import\s*{[^}]*\bresolveTenantId\b[^}]*}\s*from\s*"@\/lib\/api-auth"/,
      `${label} must import resolveTenantId from @/lib/api-auth`,
    );
    assert.match(src, /await resolveTenantId\(\)/, `${label} must call resolveTenantId()`);
  }

  console.log("forms-delete-tenant-scope: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
