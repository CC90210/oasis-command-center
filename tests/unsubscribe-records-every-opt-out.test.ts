/**
 * Every opt-out is recorded, under the right sender, and honoured.
 *
 * WHY (2026-10-19 audit). /api/unsubscribe resolved the link's brand to a
 * workspace by splicing it into `.or("name.ilike.<brand>,custom_fields->>brand.ilike.<brand>")`:
 *   - a brand with a comma ("Trytan Health, Inc.") broke the expression, the
 *     route answered 500, and the opt-out was never recorded;
 *   - "_" and "%" in a brand matched other workspaces' names;
 *   - `.limit(1)` filed a name several workspaces share under whichever row
 *     came first, where its real sender never looks.
 * And a brand that matched nothing was filed with tenant_id NULL, which no
 * Worker sender read, because every opt-out check filtered on the sender's own
 * tenant only. Migration 136 forbade NULL on Postgres; the Turso table never
 * carried that NOT NULL.
 *
 * Now the brand is matched as a value (exact, case-insensitive), a brand that
 * names no single workspace is filed globally, a failed lookup also files
 * globally rather than losing the opt-out, and every sender honours global
 * rows (lib/email/suppression-scope.ts).
 *
 * Runs the REAL route and the REAL checkEmailSuppressed against a local libSQL
 * file through the real Turso adapter, with the production table definition.
 *
 * Run: node --conditions=react-server --import tsx tests/unsubscribe-records-every-opt-out.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "unsubscribe-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;

const TRYTAN = "11111111-0000-4000-8000-000000000001";
const ACME_X = "11111111-0000-4000-8000-000000000002";
const SHARED_A = "11111111-0000-4000-8000-000000000003";
const SHARED_B = "11111111-0000-4000-8000-000000000004";
const BRANDED = "11111111-0000-4000-8000-000000000005";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const { OASIS_SUPPRESSION_TENANT_ID } = await import("../lib/email/support-mailbox");
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "email_suppressions" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "email" TEXT NOT NULL,
      "tenant_id" TEXT,
      "brand" TEXT,
      "reason" TEXT NOT NULL DEFAULT 'unsubscribe',
      "source" TEXT NOT NULL DEFAULT 'web_form',
      "user_agent" TEXT,
      "ip_address" TEXT,
      "added_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX "email_suppressions_unique" ON "email_suppressions" (email, COALESCE (tenant_id, '\\u001f__null__'), COALESCE (brand, '\\u001f__null__'));
  `);
  for (const [id, slug, name, custom] of [
    [TRYTAN, "trytan", "Trytan Health, Inc.", "{}"],
    [ACME_X, "acmexco", "AcmeXCo", "{}"],
    [SHARED_A, "shared-a", "Shared Name", "{}"],
    [SHARED_B, "shared-b", "Shared Name", "{}"],
    [BRANDED, "branded", "Legal Entity LLC", JSON.stringify({ brand: "Bright Brand" })],
    [OASIS_SUPPRESSION_TENANT_ID, "oasis-ai-cc", "OASIS AI", "{}"],
  ]) {
    await db.execute({ sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, ?, ?, ?)", args: [id, slug, name, custom] });
  }

  const { POST } = await import("../app/api/unsubscribe/route");
  const { checkEmailSuppressed } = await import("../lib/lead-interactions-queries");
  const { NextRequest } = await import("next/server");

  async function optOut(email: string, brand: string) {
    const res = await POST(
      new NextRequest("https://oasisai.work/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ email, brand }),
      }),
    );
    const rows = await db.execute({ sql: "SELECT tenant_id, brand FROM email_suppressions WHERE email = ?", args: [email] });
    return { status: res.status, rows: rows.rows.map((r) => ({ tenant_id: r.tenant_id as string | null, brand: r.brand as string | null })) };
  }

  console.log("unsubscribe-records-every-opt-out:");

  await check("a brand with a comma is recorded under its workspace (was a 500 that recorded nothing)", async () => {
    const r = await optOut("comma@example.com", "Trytan Health, Inc.");
    assert.equal(r.status, 200);
    assert.deepEqual(r.rows, [{ tenant_id: TRYTAN, brand: "Trytan Health, Inc." }]);
  });

  await check("case does not matter, wildcards do not match other names", async () => {
    assert.deepEqual((await optOut("case@example.com", "trytan health, inc.")).rows, [{ tenant_id: TRYTAN, brand: "trytan health, inc." }]);
    // "_" would have matched "AcmeXCo" as a one-character wildcard.
    assert.deepEqual((await optOut("wild@example.com", "Acme_Co")).rows, [{ tenant_id: null, brand: "Acme_Co" }]);
  });

  await check("a brand set in custom_fields.brand finds its workspace", async () => {
    assert.deepEqual((await optOut("brand@example.com", "bright brand")).rows, [{ tenant_id: BRANDED, brand: "bright brand" }]);
  });

  await check("a name two workspaces share is filed globally, never under whichever came first", async () => {
    assert.deepEqual((await optOut("shared@example.com", "Shared Name")).rows, [{ tenant_id: null, brand: "Shared Name" }]);
  });

  await check("an unknown brand is filed globally", async () => {
    assert.deepEqual((await optOut("unknown@example.com", "Nobody We Know")).rows, [{ tenant_id: null, brand: "Nobody We Know" }]);
  });

  await check("OASIS's support brand stays pinned to OASIS's own workspace", async () => {
    assert.deepEqual((await optOut("support@example.com", "OASIS AI")).rows, [{ tenant_id: OASIS_SUPPRESSION_TENANT_ID, brand: "OASIS AI" }]);
  });

  await check("a second click is not a second row", async () => {
    await optOut("twice@example.com", "Nobody We Know");
    const again = await optOut("twice@example.com", "Nobody We Know");
    assert.equal(again.status, 200);
    assert.equal(again.rows.length, 1);
  });

  await check("a global opt-out stops every workspace's sender; a workspace's own stops only that workspace", async () => {
    for (const tenant of [TRYTAN, ACME_X, OASIS_SUPPRESSION_TENANT_ID]) {
      assert.deepEqual(await checkEmailSuppressed(tenant, "unknown@example.com"), { suppressed: true, checkFailed: false }, `global row vs ${tenant}`);
    }
    assert.deepEqual(await checkEmailSuppressed(TRYTAN, "comma@example.com"), { suppressed: true, checkFailed: false });
    assert.deepEqual(await checkEmailSuppressed(ACME_X, "comma@example.com"), { suppressed: false, checkFailed: false });
    assert.deepEqual(await checkEmailSuppressed(ACME_X, "never-opted-out@example.com"), { suppressed: false, checkFailed: false });
  });

  await check("a failed brand lookup still records the opt-out, globally", async () => {
    await db.execute("ALTER TABLE tenants RENAME TO tenants_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const r = await optOut("lookup-failed@example.com", "Trytan Health, Inc.");
      assert.equal(r.status, 200);
      assert.deepEqual(r.rows, [{ tenant_id: null, brand: "Trytan Health, Inc." }]);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE tenants_offline RENAME TO tenants");
    }
  });

  await check("every send path's opt-out lookup includes the global rows", async () => {
    const { readFileSync } = await import("node:fs");
    // Each sender's lookup: the shared checkEmailSuppressed and the three
    // inline copies. lib/metrics only counts opt-outs, so it is not a sender.
    for (const file of [
      "lib/lead-interactions-queries.ts",
      "lib/bulk-email/dispatch.ts",
      "lib/forms/oasis-funnel-email.ts",
      "lib/forms/next-steps-email.ts",
    ]) {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      const at = src.indexOf('.from("email_suppressions")');
      assert.ok(at >= 0, `${file} has no opt-out lookup any more: update this list`);
      const lookup = src.slice(at, at + 200);
      assert.ok(/\.or\((suppressionScope\(\w+(\.\w+)?\)|scope|suppScope)\)/.test(lookup), `${file} scopes its lookup with suppressionScope`);
      assert.ok(!/\.eq\("tenant_id"/.test(lookup), `${file} must not narrow the lookup to its own tenant`);
      assert.ok(src.includes('from "@/lib/email/suppression-scope"') || src.includes('from "./email/suppression-scope"'), `${file} imports suppressionScope`);
    }
  });

  if (failures > 0) {
    console.log(`unsubscribe-records-every-opt-out: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("unsubscribe-records-every-opt-out: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
