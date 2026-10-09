/**
 * offer-pages-migration.test.ts - migration bravo__203 (form_offer_pages),
 * design section 3.2.
 *
 * WHAT IS PINNED, against a throwaway libSQL file in the delivery harness's
 * live table shapes, the file applied statement by statement the way the
 * Turso runner splits it:
 *   - it is additive and re-runnable: no BEGIN/COMMIT (the runner is not
 *     transactional, and a wrapped file applies nothing while still writing
 *     its ledger row), every statement IF NOT EXISTS, no ALTER or DROP;
 *   - a second run is a no-op;
 *   - `forms` is not altered, byte for byte;
 *   - the table holds exactly the designed columns and defaults, one row per
 *     form, with the (tenant_id, live) index;
 *   - deleting a form through the forms DELETE route removes its offer page in
 *     the same batch; another workspace's form id deletes nothing.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-migration.test.ts
 */
import {
  CLIENT_A,
  OASIS,
  OFFER_MIGRATION_PATH,
  USERS,
  applyOfferMigration,
  done,
  formRow,
  login,
  minimalDoc,
  offerRow,
  setupOfferDatabase,
  step,
  CONTACT_STEPS,
} from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FORM = "f0b0b000-0000-4000-8000-000000000001";
const FORM_2 = "f0b0b000-0000-4000-8000-000000000002";
const FORM_A = "f0b0b000-0000-4000-8000-00000000000a";

async function main() {
  const db = await setupOfferDatabase({ migrate: false });
  const formsSchema = async () =>
    JSON.stringify({
      cols: (await db.execute("PRAGMA table_info(forms)")).rows,
      sql: (await db.execute("SELECT sql FROM sqlite_master WHERE name = 'forms'")).rows,
      idx: (await db.execute("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'forms' ORDER BY name")).rows,
    });

  console.log("offer-pages-migration:");

  await step("the file is additive and re-runnable: no transaction, every statement IF NOT EXISTS, no ALTER or DROP", () => {
    const sql = readFileSync(OFFER_MIGRATION_PATH, "utf8");
    const code = sql
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    assert.doesNotMatch(code, /\b(BEGIN|COMMIT|ROLLBACK|TRANSACTION)\b/i);
    // Every statement is a CREATE ... IF NOT EXISTS: no ALTER, DROP, INSERT,
    // UPDATE or DELETE statement (the foreign keys' "ON DELETE CASCADE" is a
    // clause, not a statement).
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(statements.length, 2, "one table, one index");
    for (const s of statements) {
      assert.match(s, /^CREATE\s+(TABLE|INDEX)\s+IF NOT EXISTS\b/i, s.slice(0, 60));
      assert.doesNotMatch(s, /^\s*(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i);
    }
  });

  const before = await formsSchema();
  await applyOfferMigration(db);

  await step("a second run is a no-op, and forms is not altered", async () => {
    await applyOfferMigration(db);
    assert.equal(await formsSchema(), before);
  });

  await step("the table holds exactly the designed columns, defaults and index", async () => {
    const cols = (await db.execute("PRAGMA table_info(form_offer_pages)")).rows.map((r) => [r.name, r.type, Number(r.notnull), r.dflt_value, Number(r.pk)]);
    assert.deepEqual(
      cols.map((c) => c[0]),
      [
        "form_id",
        "tenant_id",
        "template_key",
        "draft",
        "draft_version",
        "draft_updated_at",
        "draft_updated_by",
        "published",
        "published_version",
        "published_at",
        "published_by",
        "live",
        "claims_confirmed",
        "created_at",
        "updated_at",
      ],
    );
    const pk = cols.filter((c) => c[4] === 1).map((c) => c[0]);
    assert.deepEqual(pk, ["form_id"], "one row per form");
    const idx = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'form_offer_pages' AND sql IS NOT NULL")).rows.map((r) => r.name);
    assert.deepEqual(idx, ["form_offer_pages_tenant_live_idx"]);
    await db.batch([formRow(FORM, OASIS, "defaults", "Defaults", CONTACT_STEPS)], "write");
    await db.execute({ sql: "INSERT INTO form_offer_pages (form_id, tenant_id, template_key) VALUES (?, ?, 'book_call')", args: [FORM, OASIS] });
    const row = (await db.execute({ sql: "SELECT draft, draft_version, published, published_version, live, claims_confirmed, created_at FROM form_offer_pages WHERE form_id = ?", args: [FORM] })).rows[0];
    assert.equal(row.draft, "{}");
    assert.equal(Number(row.draft_version), 0);
    assert.equal(row.published, null, "never published");
    assert.equal(Number(row.live), 0, "nothing is live by default");
    assert.equal(row.claims_confirmed, "[]");
    assert.match(String(row.created_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await assert.rejects(
      db.execute({ sql: "INSERT INTO form_offer_pages (form_id, tenant_id, template_key) VALUES (?, ?, 'free_audit')", args: [FORM, OASIS] }),
      /UNIQUE|PRIMARY/i,
      "a second page for the same form",
    );
  });

  await step("deleting a form deletes its offer page in the same batch; another workspace's form id deletes nothing", async () => {
    await db.batch(
      [
        formRow(FORM_2, OASIS, "second", "Second", CONTACT_STEPS),
        offerRow({ formId: FORM_2, tenantId: OASIS, draft: minimalDoc() }),
        formRow(FORM_A, CLIENT_A, "client-offer", "Client offer", CONTACT_STEPS),
        offerRow({ formId: FORM_A, tenantId: CLIENT_A, draft: minimalDoc() }),
      ],
      "write",
    );
    const { NextRequest } = await import("next/server");
    const route = await import("../app/api/forms/[id]/route");
    const del = (id: string) => route.DELETE(new NextRequest(`http://localhost/api/forms/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
    await login(USERS.cc);
    const foreign = await del(FORM_A);
    assert.equal(foreign.status, 404, "OASIS's owner deleted a client's form");
    const count = async (id: string) =>
      Number((await db.execute({ sql: "SELECT (SELECT COUNT(*) FROM forms WHERE id = ?) + (SELECT COUNT(*) FROM form_offer_pages WHERE form_id = ?) AS n", args: [id, id] })).rows[0].n);
    assert.equal(await count(FORM_A), 2, "the client's form and page are untouched");
    const res = await del(FORM_2);
    assert.equal(res.status, 200, await res.text());
    assert.equal(await count(FORM_2), 0, "the form and its offer page are gone together");
    assert.equal(await count(FORM), 2, "another form's page is untouched");
  });

  done("offer-pages-migration");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
