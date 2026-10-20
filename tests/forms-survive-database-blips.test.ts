/**
 * A public form survives a database blip, and a file that did not land is
 * never a silent success.
 *
 * WHY (2026-10-19 audit).
 *   - lib/forms/public-resolver.ts answered a failed read as not_found. The
 *     form page drew its 404, the submit route answered not_found, and the
 *     visitor read "This link is no longer valid" for a link that worked a
 *     moment later. Nothing recorded it. A failed read of the earlier steps
 *     told a visitor on step 2 to go back and finish steps they had finished.
 *   - A file of the wrong type, an oversize file, a storage failure or a
 *     failed registration only went into a `warnings` list no client reads:
 *     the step was recorded, the form said thank you, the document was missing.
 *   - findExistingLead answered a failed read as "no such lead": a duplicate
 *     lead, and on the Instagram setter a second booking for someone booked.
 *   - The database's own words (table and constraint names) went back to
 *     anonymous visitors.
 *
 * Now a failed read is `unavailable`: 503 form_unavailable from the submit
 * route (the client keeps the answers, says try again and sends its failure
 * beacon), the app's error page with a retry on /f and /book, 503 on
 * /go/community. A file that did not land fails its step with a sentence that
 * names it. The lead lookup throws. The database's words stay in the log.
 *
 * Real route, real SQL (tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/forms-survive-database-blips.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";
import { SUBMIT_ERROR_COPY } from "../components/forms/FormPublicClient";

// next/server's after() needs a request scope this harness doesn't open; the
// route's background alerts are not what this suite checks.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stand-in
const realServer = require("next/server") as Record<string, unknown>;
const serverPath = require.resolve("next/server");
require.cache[serverPath] = {
  id: serverPath,
  filename: serverPath,
  path: dirname(serverPath),
  loaded: true,
  children: [],
  paths: [],
  exports: { ...realServer, after: () => undefined },
} as unknown as NodeModule;

type Json = Record<string, unknown>;
const field = (name: string, type: string, label: string, required = true, extra: Json = {}) => ({ name, type, label, required, ...extra });
const UPLOAD_STEPS = [
  {
    key: "docs",
    title: "Your details",
    fields: [field("email", "email", "Email"), field("statement", "file_upload", "Bank statement", false, { accept: ["application/pdf"] })],
  },
];
const TWO_STEPS = [
  { key: "contact", title: "Reach you", fields: [field("email", "email", "Email")] },
  { key: "more", title: "One more", fields: [field("note", "text", "Note", false)] },
];

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

async function main() {
  const seed = await setupDatabase();
  await seed.executeMultiple(`
    DROP TABLE forms;
    CREATE TABLE forms (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, routing TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, target_agent TEXT,
      payload TEXT, correlation_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await seed.executeMultiple(read("database/turso/bravo__214_consent_events.sql"));
  await seed.batch(
    [
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-upload', ?, 'upload-form', 'Upload', ?)", args: [OASIS, JSON.stringify(UPLOAD_STEPS)] },
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-two', ?, 'two-step', 'Two', ?)", args: [OASIS, JSON.stringify(TWO_STEPS)] },
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const { resolvePublicForm } = await import("../lib/forms/public-resolver");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { findExistingLead } = await import("../lib/forms/agent-routing");
  const route = await import("../app/api/forms/submit/route");
  const community = await import("../app/go/community/route");

  const count = async (sql: string, args: unknown[] = []) => Number((await seed.execute({ sql, args: args as never })).rows[0].n);
  const leads = () => count("SELECT count(*) AS n FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead'", [OASIS]);
  const steps = (formId: string) => count("SELECT count(*) AS n FROM form_submissions WHERE form_id = ?", [formId]);
  let ip = 0;
  const post = async (body: Json): Promise<{ status: number; json: Json }> => {
    ip += 1;
    const res = await route.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.0.${ip}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Json };
  };
  const anon = (formSlug: string) => ({ tenant_slug: "oasis-ai-cc", form_slug: formSlug });
  /** Take a table away for the length of `fn`: a read of it fails as in an outage. */
  const offline = async <T>(table: string, fn: () => Promise<T>): Promise<T> => {
    await seed.execute(`ALTER TABLE ${table} RENAME TO ${table}_offline`);
    const errors = console.error;
    console.error = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = errors;
      await seed.execute(`ALTER TABLE ${table}_offline RENAME TO ${table}`);
    }
  };
  const inlineFile = (text: string, filename: string, mime: string) => ({
    inline_base64: Buffer.from(text).toString("base64"),
    filename,
    mime_type: mime,
    size_bytes: Buffer.byteLength(text),
  });

  console.log("forms-survive-database-blips:");

  await check("a form that exists resolves, and one that does not is not_found", async () => {
    const db = getServiceSupabase();
    assert.equal((await resolvePublicForm(db, "oasis-ai-cc", "two-step")).ok, true);
    assert.deepEqual(await resolvePublicForm(db, "oasis-ai-cc", "no-such-form"), { ok: false, reason: "not_found" });
    assert.deepEqual(await resolvePublicForm(db, "no-such-workspace", "two-step"), { ok: false, reason: "not_found" });
  });

  await check("a read that fails is unavailable, never not_found, for the form and for the workspace", async () => {
    const db = getServiceSupabase();
    for (const table of ["forms", "tenants"]) {
      const r = await offline(table, () => resolvePublicForm(db, "oasis-ai-cc", "two-step"));
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, "unavailable", `${table} offline`);
      assert.ok(!r.ok && r.reason === "unavailable" && r.error.length > 0, "the error is carried for the log");
    }
  });

  await check("the first step of a form that cannot be read answers 503 form_unavailable, never not_found, and makes no lead", async () => {
    const before = await leads();
    const r = await offline("forms", () => post({ step_index: 0, anonymous_init: anon("two-step"), payload: { email: "blip@example.com" } }));
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, "form_unavailable");
    assert.equal(await leads(), before);
  });

  await check("a later step whose earlier answers cannot be read answers 503, never 'finish the earlier steps'", async () => {
    const first = await post({ step_index: 0, anonymous_init: anon("two-step"), payload: { email: "steps@example.com" } });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const token = String(first.json.minted_token);
    assert.ok(token.length > 20, "the first step hands back the visitor's link");
    const second = await offline("form_submissions", () => post({ token, step_index: 1, payload: { note: "hello" } }));
    assert.equal(second.status, 503, JSON.stringify(second.json));
    assert.equal(second.json.error, "form_unavailable");
    const retried = await post({ token, step_index: 1, payload: { note: "hello" } });
    assert.equal(retried.status, 200, `a retry once the read works goes through: ${JSON.stringify(retried.json)}`);
  });

  await check("a file of a type the field does not accept fails the step with a sentence naming it; nothing is recorded", async () => {
    const before = await steps("form-upload");
    const r = await post({
      step_index: 0,
      anonymous_init: anon("upload-form"),
      payload: { email: "wrong-type@example.com", statement: inlineFile("<html>x</html>", "statement.html", "text/html") },
    });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.error, "upload_failed");
    assert.equal(r.json.field, "statement");
    assert.match(String(r.json.message), /^Bank statement: that type of file isn't accepted here/);
    assert.equal(await steps("form-upload"), before, "the step was not recorded");
  });

  await check("a file storage could not keep fails the step too, never a thank-you with the document missing", async () => {
    // The harness configures no storage, so an allowed file cannot be kept.
    const before = await steps("form-upload");
    const r = await post({
      step_index: 0,
      anonymous_init: anon("upload-form"),
      payload: { email: "no-storage@example.com", statement: inlineFile("%PDF-1.4 x", "statement.pdf", "application/pdf") },
    });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.error, "upload_failed");
    assert.match(String(r.json.message), /^Bank statement: we couldn't save that file just now/);
    assert.equal(await steps("form-upload"), before);
  });

  await check("a step with no file goes through as before", async () => {
    const before = await steps("form-upload");
    const r = await post({ step_index: 0, anonymous_init: anon("upload-form"), payload: { email: "no-file@example.com" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await steps("form-upload"), before + 1);
  });

  await check("a failed lead lookup throws instead of answering 'no such lead'", async () => {
    await offline("tenant_records", async () => {
      await assert.rejects(() => findExistingLead(OASIS, { email: "anyone@example.com" }), /lead lookup failed/);
    });
    assert.equal(await findExistingLead(OASIS, { email: "nobody-at-all@example.com" }), null, "a lookup that works and finds nothing is still null");
  });

  await check("/go/community with a form that cannot be read answers 503 try-again, not 404", async () => {
    const r = await offline("forms", () =>
      community.GET(new NextRequest("http://localhost/go/community?t=oasis-ai-cc&form=two-step")),
    );
    assert.equal(r.status, 503);
    assert.match(await r.text(), /try again/);
  });

  await check("the visitor is told to try again, the failure beacon fires, and the pages raise instead of drawing a dead end", () => {
    assert.ok(SUBMIT_ERROR_COPY.form_unavailable && !/no longer valid/i.test(SUBMIT_ERROR_COPY.form_unavailable));
    assert.ok(SUBMIT_ERROR_COPY.upload_failed, "a fallback sentence for upload_failed");
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(client, /data\.error === "server_error" \|\| data\.error === "form_unavailable"/, "form_unavailable sends the beacon");
    assert.match(read("app/f/[tenant_slug]/[form_slug]/page.tsx"), /if \(resolved\.reason === "unavailable"\) throw new Error/);
    assert.match(read("app/book/page.tsx"), /resolved\.reason === "unavailable"\) throw new Error/);
  });

  await check("the database's own words never go back to an anonymous visitor", () => {
    const src = read("app/api/forms/submit/route.ts");
    assert.ok(!src.includes("{ ok: false, error: insertRes.error.message }"), "the step insert's error text stays in the log");
    assert.ok(!src.includes("error: `lead_create_failed:"), "the lead create's error text stays in the log");
    assert.match(src, /console\.error\("\[forms\.submit\] step insert failed"/, "and the log still has it");
  });

  finish("forms-survive-database-blips");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
