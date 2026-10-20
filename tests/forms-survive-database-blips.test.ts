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
 * THE INDEPENDENT REVIEW OF #714 (its probes are ported below).
 *   - A refused file was refused AFTER the lead was created or merged: the
 *     type, size and path checks now run before anything is written.
 *   - A storage or database fault under a file was a 422 "visitor error" that
 *     paged nobody: it is a 503 upload_unavailable, logged and beaconed.
 *   - scrub-candidates stranded a candidate in `approving` when the lookup
 *     threw: it goes back to the queue with a 503.
 *   - The router read a failed `routing` read, or an unreadable destination,
 *     as "no rules": the route-only answer is a 503 the visitor retries.
 *   - Two workspaces on one slug is bad data, not an outage: not_found.
 *   - Operator-email ingest and dropped applications no longer read a failed
 *     lookup as "no lead".
 *
 * Real route, real SQL (tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/forms-survive-database-blips.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, login, OASIS, setupDatabase, USERS } from "./_delivery-harness";
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
const select = (name: string, options: string[]) => ({
  name, type: "select", label: name, required: true, options: options.map((value) => ({ value, label: value })),
});
const UPLOAD_STEPS = [
  {
    key: "docs",
    title: "Your details",
    fields: [
      field("email", "email", "Email"),
      field("name", "text", "Name", false),
      field("statement", "file_upload", "Bank statement", false, { accept: ["application/pdf"] }),
    ],
  },
];
const TWO_STEPS = [
  { key: "contact", title: "Reach you", fields: [field("email", "email", "Email")] },
  { key: "more", title: "One more", fields: [field("note", "text", "Note", false)] },
];
const MULTI_STEPS = [
  { key: "contact", title: "Reach you", fields: [field("email", "email", "Email")] },
  {
    key: "docs",
    title: "Statements",
    // The email field makes the step record a consent decision, which is
    // written before the files are: a refusal that comes first writes none.
    fields: [
      field("statements_email", "email", "Email for statements", false),
      field("statements", "file_upload_multi", "Bank statements", false, { accept: ["application/pdf"], max_files: 2 }),
    ],
  },
];
const ROUTER_STEPS = [
  {
    key: "path",
    title: "Which is you?",
    fields: [select("path", ["community", "audit"]), field("deck", "file_upload", "Deck", false, { accept: ["application/pdf"] })],
  },
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
    CREATE TABLE scrub_candidates (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL, lead_data TEXT,
      created_lead_id TEXT, reviewed_by TEXT, reviewed_at TEXT, review_note TEXT, updated_at TEXT
    );
    CREATE TABLE lead_documents (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, lead_id TEXT,
      filename TEXT, mime_type TEXT, size_bytes INTEGER, doc_type TEXT, storage_path TEXT, uploaded_by TEXT,
      uploaded_at TEXT, metadata TEXT);
  `);
  await seed.executeMultiple(read("database/turso/bravo__214_consent_events.sql"));
  await seed.batch(
    [
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-upload', ?, 'upload-form', 'Upload', ?)", args: [OASIS, JSON.stringify(UPLOAD_STEPS)] },
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-two', ?, 'two-step', 'Two', ?)", args: [OASIS, JSON.stringify(TWO_STEPS)] },
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-multi', ?, 'multi-form', 'Multi', ?)", args: [OASIS, JSON.stringify(MULTI_STEPS)] },
      {
        sql: "INSERT INTO forms (id, tenant_id, slug, name, steps, redirect_url, routing) VALUES ('form-router', ?, 'router', 'Start here', ?, 'https://oasisai.work/thanks', ?)",
        args: [OASIS, JSON.stringify(ROUTER_STEPS), JSON.stringify([{ go: "two-step", when_any: [{ path: ["audit"] }] }])],
      },
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const { resolvePublicForm } = await import("../lib/forms/public-resolver");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { findExistingLead } = await import("../lib/forms/agent-routing");
  const { resolveRouterDestination, RouterDestinationUnavailable } = await import("../lib/forms/routing-destination");
  const { parseFormRouting } = await import("../lib/forms/routing");
  const { chosenFileType } = await import("../lib/forms/file-type");
  const { ingestMessages } = await import("../lib/agents/operator-email/ingest");
  const { applyExtractedApplication } = await import("../lib/applications/apply-extracted");
  const route = await import("../app/api/forms/submit/route");
  const community = await import("../app/go/community/route");
  const scrub = await import("../app/api/scrub-candidates/[id]/route");

  const count = async (sql: string, args: unknown[] = []) => Number((await seed.execute({ sql, args: args as never })).rows[0].n);
  const leads = () => count("SELECT count(*) AS n FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead'", [OASIS]);
  const steps = (formId: string) => count("SELECT count(*) AS n FROM form_submissions WHERE form_id = ?", [formId]);
  const leadIdFor = async (email: string) =>
    String(
      (
        await seed.execute({
          sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND json_extract(data, '$.email') = ?",
          args: [OASIS, email],
        })
      ).rows[0].id,
    );
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
  /** Silence the route's own error and warning logs for the length of `fn`. */
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const errors = console.error;
    const warns = console.warn;
    console.error = () => undefined;
    console.warn = () => undefined;
    try {
      return await fn();
    } finally {
      console.error = errors;
      console.warn = warns;
    }
  };
  /** Take a table away for the length of `fn`: a read of it fails as in an outage. */
  const offline = async <T>(table: string, fn: () => Promise<T>): Promise<T> => {
    await seed.execute(`ALTER TABLE ${table} RENAME TO ${table}_offline`);
    try {
      return await quiet(fn);
    } finally {
      await seed.execute(`ALTER TABLE ${table}_offline RENAME TO ${table}`);
    }
  };
  /** Make every insert into `table` fail with `words` for the length of `fn`. */
  const refusingInserts = async <T>(table: string, words: string, fn: () => Promise<T>): Promise<T> => {
    await seed.execute(`CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${words}'); END`);
    try {
      return await quiet(fn);
    } finally {
      await seed.execute(`DROP TRIGGER refuse_${table}`);
    }
  };
  const inlineFile = (text: string | Buffer, filename: string, mime: string) => ({
    inline_base64: Buffer.from(text).toString("base64"),
    filename,
    mime_type: mime,
    size_bytes: Buffer.byteLength(text),
  });
  const firstStep = async (formSlug: string, email: string) => {
    const r = await post({ step_index: 0, anonymous_init: anon(formSlug), payload: { email } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { token: String(r.json.minted_token), leadId: await leadIdFor(email) };
  };

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

  await check("two workspaces answering one slug is bad data, not an outage: not_found, and logged", async () => {
    await seed.batch(
      [
        { sql: "INSERT INTO tenants (id, slug, name) VALUES ('dup-1', 'dup-slug', 'Dup One')", args: [] },
        { sql: "INSERT INTO tenants (id, slug, name) VALUES ('dup-2', 'dup-slug', 'Dup Two')", args: [] },
      ],
      "write",
    );
    const logged: unknown[][] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      assert.deepEqual(await resolvePublicForm(getServiceSupabase(), "dup-slug", "anything"), { ok: false, reason: "not_found" });
    } finally {
      console.error = errors;
    }
    assert.ok(logged.some((a) => /more than one workspace/.test(String(a[0]))), "someone is told to untangle it");
  });

  await check("the first step of a form that cannot be read answers 503 form_unavailable, never not_found, and makes no lead", async () => {
    const before = await leads();
    const r = await offline("forms", () => post({ step_index: 0, anonymous_init: anon("two-step"), payload: { email: "blip@example.com" } }));
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, "form_unavailable");
    assert.equal(await leads(), before);
  });

  await check("every other read of the form answers 503 too: starting a lead, routing, and a step with its link", async () => {
    const init = await offline("forms", () => post({ step_index: 0, anonymous_init: anon("two-step"), initialize_only: true, payload: {} }));
    assert.equal(init.status, 503, `initialize_only: ${JSON.stringify(init.json)}`);
    const routed = await offline("forms", () =>
      post({ step_index: 0, anonymous_init: anon("router"), route_only: true, steps_payload: [{ path: "audit" }] }),
    );
    assert.equal(routed.status, 503, `route_only: ${JSON.stringify(routed.json)}`);
    const { token } = await firstStep("two-step", "token-step@example.com");
    const step = await offline("forms", () => post({ token, step_index: 1, payload: { note: "hi" } }));
    assert.equal(step.status, 503, `a step with its link: ${JSON.stringify(step.json)}`);
    for (const r of [init, routed, step]) assert.equal(r.json.error, "form_unavailable");
  });

  await check("a later step whose earlier answers cannot be read answers 503, never 'finish the earlier steps'", async () => {
    const { token } = await firstStep("two-step", "steps@example.com");
    assert.ok(token.length > 20, "the first step hands back the visitor's link");
    const second = await offline("form_submissions", () => post({ token, step_index: 1, payload: { note: "hello" } }));
    assert.equal(second.status, 503, JSON.stringify(second.json));
    assert.equal(second.json.error, "form_unavailable");
    const retried = await post({ token, step_index: 1, payload: { note: "hello" } });
    assert.equal(retried.status, 200, `a retry once the read works goes through: ${JSON.stringify(retried.json)}`);
  });

  await check("the router: a routing read that fails is a 503 to retry, never the form's default page", async () => {
    const works = await post({ step_index: 0, anonymous_init: anon("router"), route_only: true, steps_payload: [{ path: "audit" }] });
    assert.equal(works.status, 200, JSON.stringify(works.json));
    assert.equal(works.json.route_to, "/f/oasis-ai-cc/two-step", "the rules place this visitor");
    await seed.execute("ALTER TABLE forms RENAME COLUMN routing TO routing_offline");
    let blip: { status: number; json: Json };
    try {
      blip = await quiet(() => post({ step_index: 0, anonymous_init: anon("router"), route_only: true, steps_payload: [{ path: "audit" }] }));
    } finally {
      await seed.execute("ALTER TABLE forms RENAME COLUMN routing_offline TO routing");
    }
    assert.equal(blip.status, 503, JSON.stringify(blip.json));
    assert.equal(blip.json.error, "form_unavailable");

    // The router stores no files, so it never refuses one either.
    const withFile = await post({
      step_index: 0,
      anonymous_init: anon("router"),
      route_only: true,
      steps_payload: [{ path: "audit", deck: inlineFile("<html>", "deck.html", "text/html") }],
    });
    assert.equal(withFile.status, 200, JSON.stringify(withFile.json));
  });

  await check("the router: a destination that cannot be read throws, never skips to the next rule or the community", async () => {
    // A database whose every read fails, so the destination's lookup is the one that does.
    const down = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return q;
      },
    };
    const rules = parseFormRouting([{ go: "two-step", when_any: [{ path: ["audit"] }] }]);
    await assert.rejects(
      () =>
        resolveRouterDestination(down as never, {
          tenantId: OASIS,
          tenantSlug: "oasis-ai-cc",
          routerFormSlug: "router",
          rules,
          answers: { path: "audit" },
        }),
      (err: unknown) => err instanceof RouterDestinationUnavailable,
    );
    const src = read("app/api/forms/submit/route.ts");
    assert.match(src, /if \(err instanceof RouterDestinationUnavailable\) return formUnavailable\("route", err\.message\);/);
  });

  await check("a refused file on a first step writes nothing: no lead, no step, no merge into an existing lead", async () => {
    const leadsBefore = await leads();
    const stepsBefore = await steps("form-upload");
    const r = await quiet(() =>
      post({
        step_index: 0,
        anonymous_init: anon("upload-form"),
        payload: { email: "wrong-type@example.com", statement: inlineFile("<html>x</html>", "statement.html", "text/html") },
      }),
    );
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.error, "upload_failed");
    assert.equal(r.json.field, "statement");
    assert.equal(r.json.message, "Bank statement: that type of file isn't accepted here. Please choose a PDF file.");
    assert.equal(await steps("form-upload"), stepsBefore, "the step was not recorded");
    assert.equal(await leads(), leadsBefore, "no lead was created for a refused step");

    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-kept', ?, 'lead', ?)",
      args: [OASIS, JSON.stringify({ email: "kept@example.com", name: "Original Name", stage: "researched" })],
    });
    const merged = await quiet(() =>
      post({
        step_index: 0,
        anonymous_init: anon("upload-form"),
        payload: { email: "kept@example.com", name: "Overwritten Name", statement: inlineFile("<html>", "s.html", "text/html") },
      }),
    );
    assert.equal(merged.status, 422, JSON.stringify(merged.json));
    const kept = (await seed.execute("SELECT data FROM tenant_records WHERE id = 'lead-kept'")).rows[0];
    assert.equal(JSON.parse(String(kept.data)).name, "Original Name", "a refused step merged nothing into the existing lead");
  });

  await check("an oversize file is refused before anything is written, by its real decoded size", async () => {
    const leadsBefore = await leads();
    const big = Buffer.alloc(15 * 1024 * 1024 + 1, 0x25);
    const r = await quiet(() =>
      post({ step_index: 0, anonymous_init: anon("upload-form"), payload: { email: "too-big@example.com", statement: inlineFile(big, "big.pdf", "application/pdf") } }),
    );
    assert.equal(r.status, 422, JSON.stringify(r.json).slice(0, 300));
    assert.match(String(r.json.message), /^Bank statement: that file is larger than 15 MB/);
    assert.equal(await leads(), leadsBefore);
  });

  await check("a file storage could not keep is a 503 that pages and says try again, never a 'choose another file' 422", async () => {
    // The harness configures no storage, so an allowed file cannot be kept.
    const before = await steps("form-upload");
    const logged: unknown[][] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    let r: { status: number; json: Json };
    try {
      r = await post({
        step_index: 0,
        anonymous_init: anon("upload-form"),
        payload: { email: "no-storage@example.com", statement: inlineFile("%PDF-1.4 x", "statement.pdf", "application/pdf") },
      });
    } finally {
      console.error = errors;
    }
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, "upload_unavailable");
    assert.equal(r.json.field, "statement");
    assert.match(String(r.json.message), /^Bank statement: we couldn't save that file just now\. Your answers are still here/);
    assert.match(String(r.json.message), /or remove the file to continue without it\.$/, "an optional field says it can go on without the file");
    assert.equal(await steps("form-upload"), before);
    assert.ok(logged.some((a) => /a file could not be stored/.test(String(a[0]))), "logged as an error, not a warning");
  });

  await check("a multi-file field: a path outside the lead's folder, a missing path and too many files are refused before anything is written", async () => {
    const { token, leadId } = await firstStep("multi-form", "multi@example.com");
    const before = await steps("form-multi");
    const docs = () => count("SELECT count(*) AS n FROM lead_documents WHERE lead_id = ?", [leadId]);
    const consents = () => count("SELECT count(*) AS n FROM consent_events WHERE lead_id = ?", [leadId]);
    const docsBefore = await docs();
    const consentsBefore = await consents();
    const desc = (path: string) => ({ storage_path: path, filename: "s.pdf", mime_type: "application/pdf", size_bytes: 10 });
    const outside = await quiet(() =>
      post({
        token,
        step_index: 1,
        consent_ledger: { email: true },
        payload: { statements_email: "multi@example.com", statements: [desc(`${OASIS}/someone-else/1_s.pdf`)] },
      }),
    );
    assert.equal(outside.status, 422, JSON.stringify(outside.json));
    assert.equal(outside.json.message, "Bank statements: that file didn't finish uploading. Please choose it again.");
    assert.equal(await consents(), consentsBefore, "refused before the step's consent decision was written");
    const missing = await quiet(() => post({ token, step_index: 1, payload: { statements: [{ filename: "s.pdf", mime_type: "application/pdf" }] } }));
    assert.equal(missing.status, 422, JSON.stringify(missing.json));
    const notOne = await quiet(() => post({ token, step_index: 1, payload: { statements: ["s.pdf"] } }));
    assert.equal(notOne.status, 422, "a descriptor that is not one is refused, not dropped");
    const many = await quiet(() =>
      post({ token, step_index: 1, payload: { statements: [1, 2, 3].map((n) => desc(`${OASIS}/${leadId}/${n}_s.pdf`)) } }),
    );
    assert.equal(many.status, 422, JSON.stringify(many.json));
    assert.equal(many.json.message, "Bank statements: that's more than 2 files. Please remove some and try again.");
    assert.equal(await steps("form-multi"), before, "no step was recorded");
    assert.equal(await docs(), docsBefore, "no document was registered");

    // In its own folder, the file is looked up in storage; a storage the
    // harness never configured is a fault, not the visitor's.
    const fault = await quiet(() => post({ token, step_index: 1, payload: { statements: [desc(`${OASIS}/${leadId}/1_s.pdf`)] } }));
    assert.equal(fault.status, 503, JSON.stringify(fault.json));
    assert.equal(fault.json.error, "upload_unavailable");

    // A duplicate check that could not read is not "not registered yet".
    const { registerLeadDocument } = await import("../lib/lead-documents");
    const reg = await offline("lead_documents", () =>
      registerLeadDocument({
        tenantId: OASIS,
        leadId,
        storagePath: `${OASIS}/${leadId}/1_s.pdf`,
        filename: "s.pdf",
        mimeType: "application/pdf",
        docType: "unclassified",
        uploadedBy: "form_intake",
        source: "form_intake",
      }),
    );
    assert.equal(reg.ok, false);
    assert.match(!reg.ok ? reg.error : "", /^metadata_read_failed: /);
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

  await check("scrub-candidates: a lookup that fails puts the candidate back in the queue with a 503", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await seed.execute({
      sql: "INSERT INTO scrub_candidates (id, tenant_id, status, lead_data) VALUES (?, ?, 'pending_review', ?)",
      args: [id, OASIS, JSON.stringify({ email: "candidate@example.com", phone: "4165550100", business_name: "Acme" })],
    });
    await login(USERS.cc);
    const res = await offline("tenant_records", () =>
      scrub.POST(
        new NextRequest(`http://localhost/api/scrub-candidates/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        }),
        { params: Promise.resolve({ id }) },
      ),
    );
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as Json).error, "lookup_unavailable");
    const status = String((await seed.execute({ sql: "SELECT status FROM scrub_candidates WHERE id = ?", args: [id] })).rows[0].status);
    assert.equal(status, "pending_review", `the candidate was stranded in '${status}'`);
  });

  await check("operator-email ingest holds a message whose lookup failed, never drops it", async () => {
    const at = Date.UTC(2026, 9, 19, 12, 0, 0);
    const msg = {
      id: "gmail-1",
      threadId: "t-1",
      subject: "Statements",
      from: "Merchant <merchant@example.com>",
      to: "rep@example.com",
      date: "Mon, 19 Oct 2026 12:00:00 +0000",
      internalDate: String(at),
      body: "attached",
      mailboxAddress: "rep@example.com",
    };
    const res = await offline("tenant_records", () =>
      ingestMessages({ tenantId: OASIS, userId: USERS.cc.id, mailbox: "personal", dryRun: true }, [msg as never]),
    );
    assert.equal(res.dropped, 0, "a personal mailbox's deal mail is not dropped on a failed lookup");
    assert.equal(res.deferred, 1);
    assert.equal(res.oldestDeferredAt, new Date(at).toISOString(), "the cursor is held behind it");
  });

  await check("a dropped application whose lookup failed stops, never creates a second copy of the merchant", async () => {
    const before = await leads();
    const r = await offline("tenant_records", () =>
      applyExtractedApplication({ tenantId: OASIS, rawFields: { business_name: "Blip Co", email: "blip-app@example.com" } }),
    );
    assert.deepEqual(r, { ok: false, error: "lead_lookup_failed" });
    assert.equal(await leads(), before);
  });

  await check("/go/community with a form that cannot be read answers 503 try-again, not 404", async () => {
    const r = await offline("forms", () =>
      community.GET(new NextRequest("http://localhost/go/community?t=oasis-ai-cc&form=two-step")),
    );
    assert.equal(r.status, 503);
    assert.match(await r.text(), /try again/);
  });

  await check("the database's own words never go back to an anonymous visitor", async () => {
    const { token } = await firstStep("two-step", "words@example.com");
    const step = await refusingInserts("form_submissions", "fs_internal_words_xyz", () => post({ token, step_index: 1, payload: { note: "x" } }));
    assert.equal(step.status, 500, JSON.stringify(step.json));
    assert.equal(step.json.error, "server_error");
    assert.ok(!JSON.stringify(step.json).includes("fs_internal_words_xyz"), "the step insert's words stay in the log");
    const lead = await refusingInserts("tenant_records", "lead_internal_words_xyz", () =>
      post({ step_index: 0, anonymous_init: anon("two-step"), payload: { email: "words-new@example.com" } }),
    );
    assert.ok(lead.status >= 500, JSON.stringify(lead.json));
    assert.ok(!JSON.stringify(lead.json).includes("lead_internal_words_xyz"), "the lead create's words stay in the log");
  });

  await check("a file the browser reports no type for is named by its extension, and only for the types a form takes", () => {
    assert.equal(chosenFileType({ name: "statement.PDF", type: "" }), "application/pdf");
    assert.equal(chosenFileType({ name: "photo.jpg", type: "" }), "image/jpeg");
    assert.equal(chosenFileType({ name: "photo.heic", type: "" }), "image/heic");
    assert.equal(chosenFileType({ name: "notes.docx", type: "" }), "application/octet-stream");
    assert.equal(chosenFileType({ name: "no-extension", type: "" }), "application/octet-stream");
    assert.equal(chosenFileType({ name: "statement.pdf", type: "text/html" }), "text/html", "a type the browser reported is never overridden");
    for (const rel of ["components/forms/FormPublicClient.tsx", "components/forms/MultiFileDropzone.tsx"]) {
      assert.ok(!read(rel).includes('.type || "application/octet-stream"'), `${rel} uses chosenFileType`);
    }
  });

  await check("the visitor is told to try again, the beacon fires and carries no file bytes, and the pages raise instead of drawing a dead end", () => {
    assert.ok(SUBMIT_ERROR_COPY.form_unavailable && !/no longer valid/i.test(SUBMIT_ERROR_COPY.form_unavailable));
    assert.ok(SUBMIT_ERROR_COPY.upload_failed, "a fallback sentence for upload_failed");
    assert.ok(SUBMIT_ERROR_COPY.upload_unavailable, "a fallback sentence for upload_unavailable");
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(
      client,
      /data\.error === "server_error" \|\| data\.error === "form_unavailable" \|\| data\.error === "upload_unavailable"/,
      "form_unavailable and upload_unavailable send the beacon",
    );
    assert.match(client, /typeof \(v as \{ inline_base64\?: unknown \}\)\.inline_base64 === "string"/, "the beacon drops a built payload's file bytes");
    assert.match(client, /showSubmitFailure\(res, data, lastPayload, currentStep, \{ beacon: false \}\);/, "the router's answer, which stored nothing, sends none");
    assert.match(read("components/forms/FormRenderer.tsx"), /\{chosen && !field\.required \? \(/, "an optional file can be removed");
    assert.match(read("app/f/[tenant_slug]/[form_slug]/page.tsx"), /if \(resolved\.reason === "unavailable"\) throw new Error/);
    assert.match(read("app/book/page.tsx"), /resolved\.reason === "unavailable"\) throw new Error/);
  });

  finish("forms-survive-database-blips");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
