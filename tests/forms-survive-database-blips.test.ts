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
 * ITS SECOND ROUND, with a fake R2 and fault injection on the app's own
 * database client (both from its probes):
 *   - scrub-candidates looks the lead up before the claim, so a failure has
 *     nothing to roll back; a rollback that fails after a failed create is
 *     logged with the candidate's id.
 *   - A direct upload is found by asking for it, not by a 100-key listing; a
 *     filename whose letters are stripped never becomes a path holding "..";
 *     an accept list typed as extensions takes those types.
 *   - The router refuses no files and, failing twice for one visitor, pages,
 *     filed as nothing to recover. /book and the audit form beacon too.
 *
 * Real route, real SQL (tests/_delivery-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/forms-survive-database-blips.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createElement, type ReactNode } from "react";
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

// The form page (its tab title is checked below) pulls modules a bundler would
// handle: stubbed as tests/_offer-pages-harness.ts does.
const stubPath = (p: string, exports: Record<string, unknown>) => {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
};
stubPath(require.resolve("next/link"), {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
});
stubPath(require.resolve("next/font/local"), {
  __esModule: true,
  default: (opts: { variable?: string }) => ({
    className: "font-stub",
    variable: `font-var-${String(opts.variable || "x").replace(/[^a-z]/gi, "")}`,
    style: { fontFamily: "stub" },
  }),
});
stubPath(join(__dirname, "..", "app", "(marketing)", "marketing.css"), {});

// A fake R2 behind a fetch stub (no network), from the independent review of
// #714: ListObjectsV2 with prefix and max-keys in key order, PUT, HEAD, DELETE.
// DOWN by default, so a check that needs storage to fail gets a fault, and the
// checks that need a working storage turn it on.
const R2_STORE = new Map<string, number>(); // object key -> size
let r2Down = true;
process.env.R2_ACCOUNT_ID = "testacct";
process.env.R2_ACCESS_KEY_ID = "AKIATEST";
process.env.R2_SECRET_ACCESS_KEY = "testsecret";
process.env.R2_BUCKET = "test-bucket";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "testacct.r2.cloudflarestorage.com") throw new Error(`test: network blocked (${url.hostname})`);
  if (r2Down) return new Response("storage down", { status: 500 });
  const method = (init?.method || "GET").toUpperCase();
  const path = decodeURIComponent(url.pathname);
  if (path === "/test-bucket" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const max = Number(url.searchParams.get("max-keys") || "1000");
    const keys = [...R2_STORE.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, max);
    const body =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>test-bucket</Name><Prefix>${prefix}</Prefix>` +
      `<MaxKeys>${max}</MaxKeys><IsTruncated>${keys.length === max}</IsTruncated>` +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>${R2_STORE.get(k)}</Size></Contents>`).join("") +
      `</ListBucketResult>`;
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  }
  const key = path.replace(/^\/test-bucket\//, "");
  if (method === "PUT") {
    R2_STORE.set(key, 10);
    return new Response(null, { status: 200 });
  }
  if (method === "DELETE") {
    R2_STORE.delete(key);
    return new Response(null, { status: 204 });
  }
  if (method === "HEAD" || method === "GET") {
    return R2_STORE.has(key)
      ? new Response(null, { status: 200, headers: { "content-length": String(R2_STORE.get(key)) } })
      : new Response(null, { status: 404 });
  }
  return new Response(null, { status: 400 });
}) as typeof fetch;

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
    fields: [
      select("path", ["community", "audit"]),
      field("deck", "file_upload", "Deck", false, { accept: ["application/pdf"] }),
      field("decks", "file_upload_multi", "Decks", false, { accept: ["application/pdf"], max_files: 1 }),
    ],
  },
];
// The builder's "Accepted file types" box is free text: an operator typed "pdf".
const FREE_ACCEPT_STEPS = [
  {
    key: "docs",
    title: "Proof",
    fields: [field("email", "email", "Email"), field("proof", "file_upload", "Proof of address", false, { accept: ["pdf"] })],
  },
];
// The file rules one step has to hold (independent review of #714, round 3):
// a field name used twice (the last is the field, as in the upload loop), a
// multi-file field that takes one file, and five file fields whose sizes add
// up past the request's limit.
const FILE_RULE_STEPS = [
  {
    key: "files",
    title: "Files",
    fields: [
      field("email", "email", "Email"),
      field("doc", "text", "Document note", false),
      field("doc", "file_upload", "Document", false, { accept: ["application/pdf"] }),
      field("one", "file_upload_multi", "One statement", false, { accept: ["application/pdf"], max_files: 1 }),
      ...[1, 2, 3, 4, 5].map((n) => field(`f${n}`, "file_upload", `File ${n}`, false, { accept: ["application/pdf"] })),
    ],
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
    -- The alert card and the paging ladder, as production has them (tests/workspace-alerts.test.ts).
    CREATE TABLE agent_alerts (
      id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info', subject_type TEXT, subject_id TEXT, title TEXT NOT NULL, body TEXT,
      payload TEXT NOT NULL DEFAULT '{}', dedup_key TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), resolved_at TEXT, resolved_by TEXT
    );
    CREATE TABLE health_alert_state (alert_key TEXT PRIMARY KEY, tenant_id TEXT, last_signature TEXT,
      last_alerted_at TEXT, repeat_n INTEGER NOT NULL DEFAULT 0, first_failed_at TEXT, updated_at TEXT);
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
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-free', ?, 'free-accept', 'Free', ?)", args: [OASIS, JSON.stringify(FREE_ACCEPT_STEPS)] },
      { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('form-rules', ?, 'file-rules', 'Rules', ?)", args: [OASIS, JSON.stringify(FILE_RULE_STEPS)] },
    ],
    "write",
  );
  await seed.executeMultiple(read("database/turso/146_form_submit_failures.turso.sql"));

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
  const submitFailure = await import("../app/api/forms/submit-failure/route");
  const formPage = await import("../app/f/[tenant_slug]/[form_slug]/page");
  const { sanitizeStorageFilename } = await import("../lib/storage-helpers");
  const { normalizedAccept } = await import("../lib/forms/file-type");
  const { getTursoClient } = await import("../lib/turso");

  // Fault injection on the app's own database client (the seed client is a
  // separate connection), from the independent review of #714: a query the
  // test names fails as in an outage, and everything else runs.
  const appClient = getTursoClient() as unknown as Record<string, unknown>;
  const ownExecute = Reflect.getOwnPropertyDescriptor(appClient, "execute");
  const realExecute = (ownExecute?.value ?? (Object.getPrototypeOf(appClient) as Record<string, unknown>).execute) as (
    this: unknown,
    stmt: unknown,
  ) => Promise<unknown>;
  let failWhen: ((sql: string, args: unknown[]) => boolean) | null = null;
  appClient.execute = function (this: unknown, stmt: unknown) {
    const sql = typeof stmt === "string" ? stmt : String((stmt as { sql: string }).sql);
    const args = typeof stmt === "string" ? [] : (((stmt as { args?: unknown[] }).args ?? []) as unknown[]);
    if (failWhen && failWhen(sql, args)) return Promise.reject(new Error("test: connection reset"));
    return realExecute.call(this, stmt);
  };
  /** Fail the queries `when` names for the length of `fn`. */
  const failing = async <T>(when: (sql: string, args: unknown[]) => boolean, fn: () => Promise<T>): Promise<T> => {
    failWhen = when;
    try {
      return await quiet(fn);
    } finally {
      failWhen = null;
    }
  };

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
    // A type the field does not take, in the lead's own folder: refused by the
    // check that runs before anything is written, not only by the upload loop
    // after the consent decision (independent review of #714, round 3).
    const exe = await quiet(() =>
      post({
        token,
        step_index: 1,
        consent_ledger: { email: true },
        payload: {
          statements_email: "multi@example.com",
          statements: [{ ...desc(`${OASIS}/${leadId}/1_setup.exe`), filename: "setup.exe", mime_type: "application/x-msdownload" }],
        },
      }),
    );
    assert.equal(exe.status, 422, JSON.stringify(exe.json));
    assert.equal(exe.json.message, "Bank statements (setup.exe): that type of file isn't accepted here. Please choose a PDF file.");
    assert.equal(await consents(), consentsBefore, "a wrong type is refused before the consent decision is written");
    const missing = await quiet(() => post({ token, step_index: 1, payload: { statements: [{ filename: "s.pdf", mime_type: "application/pdf" }] } }));
    assert.equal(missing.status, 422, JSON.stringify(missing.json));
    assert.equal(missing.json.message, "Bank statements (s.pdf): that file didn't finish uploading. Please choose it again.", "the visitor is told which file");
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

  await check("one step's file rules hold before anything is written: a repeated name is its last field, a one-file field says 'file', and files past the request's limit are a 413", async () => {
    // Independent review of #714, round 3: each of these refusals also had a
    // copy in the upload loop, which runs after the lead is written, so only
    // "no lead" tells the early check is there.
    const leadsBefore = await leads();
    const doubled = await quiet(() =>
      post({ step_index: 0, anonymous_init: anon("file-rules"), payload: { email: "rules-doc@example.com", doc: inlineFile("MZ", "setup.exe", "application/x-msdownload") } }),
    );
    assert.equal(doubled.status, 422, JSON.stringify(doubled.json));
    assert.equal(doubled.json.message, "Document: that type of file isn't accepted here. Please choose a PDF file.");
    const two = await quiet(() =>
      post({ step_index: 0, anonymous_init: anon("file-rules"), payload: { email: "rules-one@example.com", one: [{ storage_path: "x/1_a.pdf" }, { storage_path: "x/2_b.pdf" }] } }),
    );
    assert.equal(two.status, 422, JSON.stringify(two.json));
    assert.equal(two.json.message, "One statement: that's more than 1 file. Please remove some and try again.");
    // Five files of 12.5 MB: each under the 15 MB one may be, 62.5 MB together.
    const part = inlineFile(Buffer.alloc(12.5 * 1024 * 1024, 0x25), "part.pdf", "application/pdf");
    const total = await quiet(() =>
      post({ step_index: 0, anonymous_init: anon("file-rules"), payload: { email: "rules-total@example.com", f1: part, f2: part, f3: part, f4: part, f5: part } }),
    );
    assert.equal(total.status, 413, JSON.stringify(total.json).slice(0, 300));
    assert.equal(total.json.error, "request_payload_too_large");
    assert.equal(await leads(), leadsBefore, "no lead for any of them");
  });

  await check("a failed lead lookup throws instead of answering 'no such lead'", async () => {
    await offline("tenant_records", async () => {
      await assert.rejects(() => findExistingLead(OASIS, { email: "anyone@example.com" }), /lead lookup failed/);
    });
    assert.equal(await findExistingLead(OASIS, { email: "nobody-at-all@example.com" }), null, "a lookup that works and finds nothing is still null");
  });

  const approve = (id: string) =>
    scrub.POST(
      new NextRequest(`http://localhost/api/scrub-candidates/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      { params: Promise.resolve({ id }) },
    );
  const candidate = async (id: string) =>
    (await seed.execute({ sql: "SELECT status, reviewed_by FROM scrub_candidates WHERE id = ?", args: [id] })).rows[0];

  await check("scrub-candidates: a lookup that fails changes nothing, so the candidate stays in the queue, with a 503", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await seed.execute({
      sql: "INSERT INTO scrub_candidates (id, tenant_id, status, lead_data) VALUES (?, ?, 'pending_review', ?)",
      args: [id, OASIS, JSON.stringify({ email: "candidate@example.com", phone: "4165550100", business_name: "Acme" })],
    });
    await login(USERS.cc);
    const res = await offline("tenant_records", () => approve(id));
    assert.equal(res.status, 503);
    const body = (await res.json()) as Json;
    assert.equal(body.error, "lookup_unavailable");
    assert.match(String(body.message), /Nothing was changed/);
    const row = await candidate(id);
    assert.equal(String(row.status), "pending_review", `the candidate was stranded in '${String(row.status)}'`);
    assert.equal(row.reviewed_by, null, "the lookup runs before the claim: it was never claimed");
  });

  await check("scrub-candidates: a lead create that fails, and then a rollback that fails, is logged with the candidate's id, never hidden", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await seed.execute({
      sql: "INSERT INTO scrub_candidates (id, tenant_id, status, lead_data) VALUES (?, ?, 'pending_review', ?)",
      args: [id, OASIS, JSON.stringify({ email: "stuck@example.com", business_name: "Stuck Co" })],
    });
    await login(USERS.cc);
    await seed.executeMultiple(`
      CREATE TRIGGER refuse_lead BEFORE INSERT ON tenant_records BEGIN SELECT RAISE(ABORT, 'no leads now'); END;
      CREATE TRIGGER refuse_rollback BEFORE UPDATE ON scrub_candidates WHEN NEW.status = 'pending_review' BEGIN SELECT RAISE(ABORT, 'no writes now'); END;
    `);
    const lines: string[] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    let res: Response;
    try {
      res = await approve(id);
    } finally {
      console.error = errors;
      await seed.executeMultiple("DROP TRIGGER refuse_lead; DROP TRIGGER refuse_rollback;");
    }
    assert.ok(res.status >= 400, `HTTP ${res.status}`);
    assert.equal(String((await candidate(id)).status), "approving");
    assert.ok(lines.some((l) => l.includes("stuck in 'approving'") && l.includes(id)), "the stuck candidate is named in the log");
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

  await check("the router: a destination whose read fails answers 503 through the route, never the next rule or the default page", async () => {
    const answer = () => post({ step_index: 0, anonymous_init: anon("router"), route_only: true, steps_payload: [{ path: "audit" }] });
    const healthy = await answer();
    assert.equal(healthy.json.route_to, "/f/oasis-ai-cc/two-step");
    // Only the destination's own read fails: its slug is in that query's arguments.
    const blip = await failing((sql, args) => /^\s*select/i.test(sql) && /forms/.test(sql) && args.includes("two-step"), answer);
    assert.equal(blip.status, 503, JSON.stringify(blip.json));
    assert.equal(blip.json.error, "form_unavailable");
  });

  await check("two forms of one workspace answering one slug is bad data, not an outage: not_found, and logged", async () => {
    await seed.batch(
      [
        { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('dup-form-1', ?, 'dup-form', 'One', '[]')", args: [OASIS] },
        { sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES ('dup-form-2', ?, 'dup-form', 'Two', '[]')", args: [OASIS] },
      ],
      "write",
    );
    const lines: unknown[][] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void lines.push(a);
    try {
      assert.deepEqual(await resolvePublicForm(getServiceSupabase(), "oasis-ai-cc", "dup-form"), { ok: false, reason: "not_found" });
    } finally {
      console.error = errors;
    }
    assert.ok(lines.some((a) => /more than one form/.test(String(a[0]))));
  });

  await check("a multi-file upload is found in a folder already holding over 100 files; one that never landed is the visitor's to redo; a storage fault is a 503", async () => {
    // R2 lists 100 keys in key order and these keys start with Date.now(), so a
    // new upload sorted past a full listing and read as "not found", on every
    // retry (independent review of #714). The object is now asked for itself.
    const { token, leadId } = await firstStep("multi-form", "folder-100@example.com");
    r2Down = false;
    try {
      for (let i = 0; i < 120; i += 1) R2_STORE.set(`lead-documents/${OASIS}/${leadId}/17000000${String(i).padStart(5, "0")}_old.pdf`, 10);
      const fresh = `${OASIS}/${leadId}/1800000000000_new.pdf`;
      // Storage holds 4,321 bytes; the browser's descriptor claims 10.
      R2_STORE.set(`lead-documents/${fresh}`, 4321);
      const desc = (path: string, filename = "new.pdf") => ({ storage_path: path, filename, mime_type: "application/pdf", size_bytes: 10 });
      const found = await quiet(() => post({ token, step_index: 1, payload: { statements: [desc(fresh)] } }));
      assert.equal(found.status, 200, JSON.stringify(found.json));
      assert.equal(await count("SELECT count(*) AS n FROM lead_documents WHERE lead_id = ?", [leadId]), 1, "the document was registered");
      assert.equal(
        await count("SELECT size_bytes AS n FROM lead_documents WHERE lead_id = ?", [leadId]),
        4321,
        "registered at the size storage reports, never the size the browser claimed",
      );

      const missing = await quiet(() =>
        post({ token, step_index: 1, payload: { statements: [desc(`${OASIS}/${leadId}/1800000000001_gone.pdf`, "gone.pdf")] } }),
      );
      assert.equal(missing.status, 422, JSON.stringify(missing.json));
      assert.equal(missing.json.message, "Bank statements (gone.pdf): that file didn't finish uploading. Please choose it again.");

      const wrongType = await quiet(() =>
        post({ token, step_index: 1, payload: { statements: [{ ...desc(fresh, "notes.docx"), mime_type: "application/msword" }] } }),
      );
      assert.equal(wrongType.status, 422, JSON.stringify(wrongType.json));
      assert.match(String(wrongType.json.message), /^Bank statements \(notes\.docx\): that type of file isn't accepted here\. Please choose a PDF file\.$/);
    } finally {
      r2Down = true;
    }
    const fault = await quiet(() =>
      post({ token, step_index: 1, payload: { statements: [{ storage_path: `${OASIS}/${leadId}/1800000000002_x.pdf`, filename: "x.pdf", mime_type: "application/pdf" }] } }),
    );
    assert.equal(fault.status, 503, "storage that cannot answer is a fault, not the visitor's");
  });

  await check("a filename whose letters are stripped never becomes a path holding '..'", async () => {
    for (const name of ["выписка.банк.pdf", "Q1.&.Q2.pdf", "relevé.é.pdf"]) {
      const clean = sanitizeStorageFilename(name);
      assert.ok(!clean.includes(".."), `${name} -> ${clean}`);
      assert.ok(clean.endsWith(".pdf"), `${name} keeps its extension: ${clean}`);
    }
    assert.equal(sanitizeStorageFilename("hook v3.mp4"), "hook_v3.mp4", "an ordinary name is unchanged");
  });

  await check("an accept list typed as extensions ('pdf') takes those types, in the route, the file picker and the dropzone", async () => {
    assert.deepEqual(normalizedAccept(["pdf", ".JPG", "image", "application/PDF", "docx", " "]), ["application/pdf", "image/jpeg", "image/*"]);
    assert.deepEqual(normalizedAccept(["docx"]), [], "only unknown words: the caller's own default applies");
    // Misspelled types no browser sends, and "anything", refused every file
    // (independent review of #714, round 3).
    assert.deepEqual(normalizedAccept(["image/jpg", "application/x-pdf"]), ["image/jpeg", "application/pdf"]);
    assert.deepEqual(normalizedAccept(["*/*"]), [], "'anything' is the caller's inert default, never every type");
    assert.deepEqual(normalizedAccept(["*", "pdf"]), ["application/pdf"]);
    r2Down = false;
    try {
      const pdf = await quiet(() =>
        post({ step_index: 0, anonymous_init: anon("free-accept"), payload: { email: "free-pdf@example.com", proof: inlineFile("%PDF-1.4 x", "proof.pdf", "application/pdf") } }),
      );
      assert.equal(pdf.status, 200, JSON.stringify(pdf.json));
    } finally {
      r2Down = true;
    }
    const html = await quiet(() =>
      post({ step_index: 0, anonymous_init: anon("free-accept"), payload: { email: "free-html@example.com", proof: inlineFile("<html>", "proof.html", "text/html") } }),
    );
    assert.equal(html.status, 422);
    assert.equal(html.json.message, "Proof of address: that type of file isn't accepted here. Please choose a PDF file.");
    assert.match(read("components/forms/FormRenderer.tsx"), /accept=\{normalizedAccept\(field\.accept\)\.join\(","\) \|\| undefined\}/);
    assert.match(read("components/forms/MultiFileDropzone.tsx"), /const normalized = normalizedAccept\(accept\);/);
  });

  await check("the router stores no files, so it refuses none: a multi-file answer goes through as it always did", async () => {
    const r = await post({
      step_index: 0,
      anonymous_init: anon("router"),
      route_only: true,
      steps_payload: [{ path: "audit", decks: [{ storage_path: "a/b/1_s.pdf" }, { storage_path: "a/b/2_s.pdf" }, "s.pdf"] }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });

  let beaconIp = 0;
  const beacon = (body: Json) =>
    submitFailure.POST(
      new NextRequest("http://localhost/api/forms/submit-failure", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.77.0.${++beaconIp}` },
        body: JSON.stringify(body),
      }),
    );

  await check("a router's beacon is filed already recovered: it pages, but holds no row open for a hand to close", async () => {
    await quiet(() => beacon({ tenant_slug: "oasis-ai-cc", form_slug: "router", step_index: 0, error: "form_unavailable", payload: { path: "audit" }, nothing_to_recover: true }));
    await quiet(() => beacon({ tenant_slug: "oasis-ai-cc", form_slug: "two-step", step_index: 0, error: "server_error", payload: { email: "lost@example.com" } }));
    const rows = await seed.execute("SELECT form_slug, recovered_at FROM form_submit_failures ORDER BY form_slug");
    const byForm = Object.fromEntries(rows.rows.map((r) => [String(r.form_slug), r.recovered_at]));
    assert.ok(byForm.router, "the router's row is filed already recovered");
    assert.equal(byForm["two-step"], null, "a merchant's lost answers stay open until someone recovers them");
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(
      client,
      /if \(isSubmitFault\(res\.status, data\)\) routeFailures\.current \+= 1;\s*showSubmitFailure\(res, data, lastPayload, currentStep, \{\s*beacon: routeFailures\.current >= 2,\s*nothingToRecover: true,/,
      "the router beacons on the visitor's second fault in a row, and their own mistakes do not count",
    );
  });

  await check("a router's failure has its own card and paging, never a real loss's; a 'nothing to recover' beacon that carries a contact is a real loss", async () => {
    // Independent review of #714, round 3: the router's card shared the real
    // loss's type and subject, so a router beacon (or a forged one) rewrote
    // the card that held the reference to a prospect's saved answers, and the
    // two shared one paging ladder.
    const card = async (type: string) =>
      (
        await seed.execute({
          sql: "SELECT title, body, payload FROM agent_alerts WHERE tenant_id = ? AND alert_type = ? AND subject_id = 'form-router' AND resolved_at IS NULL",
          args: [OASIS, type],
        })
      ).rows;
    await quiet(() => beacon({ tenant_slug: "oasis-ai-cc", form_slug: "router", step_index: 0, error: "server_error", payload: { path: "audit", email: "real-loss@example.com" } }));
    const real = await card("form_submit_blocked");
    assert.equal(real.length, 1, "the real loss has its card");
    const deadLetter = JSON.parse(String(real[0].payload)).dead_letter_id as string;
    assert.ok(deadLetter, "and its reference");
    await quiet(() => beacon({ tenant_slug: "oasis-ai-cc", form_slug: "router", step_index: 0, error: "route_network_error", payload: { path: "audit" }, nothing_to_recover: true }));
    const after = await card("form_submit_blocked");
    assert.equal(String(after[0].title), "Form submission blocked: a merchant could not submit", "the real loss's card is untouched");
    assert.equal(JSON.parse(String(after[0].payload)).dead_letter_id, deadLetter, "and still holds the reference to the saved answers");
    const router = await card("form_router_failed");
    assert.equal(router.length, 1, "the router's failure has a card of its own");
    assert.equal(String(router[0].title), "A form's router could not answer a visitor, twice");
    const keys = (await seed.execute("SELECT alert_key FROM health_alert_state WHERE alert_key LIKE '%oasis-ai-cc/router/%' ORDER BY alert_key")).rows.map((r) => String(r.alert_key));
    assert.deepEqual(keys, ["routerfail:oasis-ai-cc/router/client_beacon", "submitfail:oasis-ai-cc/router/client_beacon"], "each on its own paging ladder");

    // "Nothing to recover" is the browser's word; answers that hold a way to
    // reach the visitor say otherwise, under any field name.
    await quiet(() =>
      beacon({ tenant_slug: "oasis-ai-cc", form_slug: "router", step_index: 0, error: "server_error", payload: { path: "audit", work_email: "forged@example.com" }, nothing_to_recover: true }),
    );
    const forged = (
      await seed.execute("SELECT recovered_at FROM form_submit_failures WHERE payload LIKE '%forged@example.com%'")
    ).rows;
    assert.equal(forged.length, 1);
    assert.equal(forged[0].recovered_at, null, "filed open: there is someone to recover");
  });

  await check("a beacon whose form cannot be read is logged as an error beside the outage, not a quiet warning", async () => {
    // Independent review of #714, round 3 (N-8): in an outage there is no
    // workspace to page, but the loss must show in the logs as an error.
    const lines: string[] = [];
    await offline("forms", async () => {
      const errors = console.error;
      console.error = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      try {
        await beacon({ tenant_slug: "oasis-ai-cc", form_slug: "two-step", step_index: 0, error: "server_error", payload: { email: "outage@example.com" } });
      } finally {
        console.error = errors;
      }
    });
    assert.ok(lines.some((l) => l.includes("the form could not be read; nobody was paged")), lines.join("\n"));
    const kept = (await seed.execute("SELECT recovered_at FROM form_submit_failures WHERE payload LIKE '%outage@example.com%'")).rows;
    assert.equal(kept.length, 1, "the answers are still kept");
  });

  await check("a declined consent box travels with the beacon, is kept with the answers, and is on the card", async () => {
    // Independent review of #714, round 3: consent_record_unavailable means a
    // decline could not be recorded and an earlier tick still stands; the card
    // told someone to contact a visitor who had just said no.
    await quiet(() =>
      beacon({
        tenant_slug: "oasis-ai-cc",
        form_slug: "two-step",
        step_index: 0,
        error: "consent_record_unavailable",
        payload: { email: "said-no@example.com" },
        consent_ledger: { email: false, sms: true, extra: "dropped" },
      }),
    );
    const row = (await seed.execute("SELECT payload FROM form_submit_failures WHERE payload LIKE '%said-no@example.com%'")).rows[0];
    assert.deepEqual(JSON.parse(String(row.payload)).consent_ledger, { email: false, sms: true }, "kept beside the answers, booleans only");
    const body = String(
      (
        await seed.execute({
          sql: "SELECT body FROM agent_alerts WHERE tenant_id = ? AND alert_type = 'form_submit_blocked' AND subject_id = 'form-two' AND resolved_at IS NULL",
          args: [OASIS],
        })
      ).rows[0].body,
    );
    assert.match(body, /They declined email marketing on that step, and it may not have been recorded: follow up on this request only\./);
  });

  await check("a blip on a form's page names it in the tab as 'try again', never as a dead link", async () => {
    const meta = () =>
      formPage.generateMetadata({ params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: "two-step" }), searchParams: Promise.resolve({}) });
    assert.equal((await offline("forms", meta)).title, "Please try again");
    assert.equal(
      (await formPage.generateMetadata({ params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: "no-such-form" }), searchParams: Promise.resolve({}) })).title,
      "Page not available",
    );
  });

  await check("/book and the homepage audit form beacon a fault on our side, any 5xx included, and a connection that dies; /book stops telling a visitor to check details we failed to save", () => {
    // Text checks: these pages need a browser to click through. Each pins the
    // fault test and the beacon call together, so neither can drift alone.
    const book = read("components/booking/BookingPage.tsx");
    const audit = read("components/marketing/AuditForm.tsx");
    assert.match(book, /const fault = isSubmitFault\(res\.status, data\);\s*if \(fault\) \{\s*sendSubmitFailureBeacon\(\{/, "/book beacons a fault the shared way");
    assert.match(audit, /if \(isSubmitFault\(res\.status, data\)\) \{\s*sendSubmitFailureBeacon\(\{/, "the audit form beacons a fault the shared way");
    assert.match(book, /We couldn't save your details just now\. They're still here, so please try again in a moment\./);
    assert.match(book, /fault\s*\?\s*"We couldn't save your details just now/, "a fault gets the try-again sentence, never 'check them'");
    // A connection that dies before the details were saved (round 3, N-2).
    assert.match(book, /\} catch \{\s*if \(unsaved\) \{\s*sendSubmitFailureBeacon\(\{[\s\S]{0,200}error: "network_error",\s*payload: unsaved,/);
    assert.match(book, /tokenRef\.current = token;\s*unsaved = null;/, "once saved, a dropped booking request is not a lost lead");
    // Only comments between the catch and the beacon: nothing can return first.
    assert.match(audit, /\} catch \{\s*(?:\/\/[^\n]*\n\s*)*sendSubmitFailureBeacon\(\{[\s\S]{0,200}error: "network_error",\s*payload: body\.payload,/);
    // The consent decision rides with each page's beacons (round 3, N-6).
    assert.equal((book.match(/consentLedger,\s*\}\);/g) ?? []).length, 2, "/book: both beacons carry the consent boxes");
    assert.equal((audit.match(/consentLedger: body\.consent_ledger,/g) ?? []).length, 2, "the audit form: both beacons carry them");
  });

  await check("a file the browser reports no type for is named by its extension, and only for the types a form takes", () => {
    assert.equal(chosenFileType({ name: "statement.PDF", type: "" }), "application/pdf");
    assert.equal(chosenFileType({ name: "photo.jpg", type: "" }), "image/jpeg");
    assert.equal(chosenFileType({ name: "photo.heic", type: "" }), "image/heic");
    assert.equal(chosenFileType({ name: "notes.docx", type: "" }), "application/octet-stream");
    assert.equal(chosenFileType({ name: "no-extension", type: "" }), "application/octet-stream");
    assert.equal(chosenFileType({ name: "statement.pdf", type: "text/html" }), "text/html", "a type the browser reported is never overridden");
    // Some browsers say octet-stream outright rather than nothing (review of #714, round 3).
    assert.equal(chosenFileType({ name: "statement.pdf", type: "application/octet-stream" }), "application/pdf");
    assert.equal(chosenFileType({ name: "setup.exe", type: "application/octet-stream" }), "application/octet-stream");
    for (const rel of ["components/forms/FormPublicClient.tsx", "components/forms/MultiFileDropzone.tsx"]) {
      assert.ok(!read(rel).includes('.type || "application/octet-stream"'), `${rel} uses chosenFileType`);
    }
  });

  await check("the beacon module sends what it is handed (nothing to recover, the consent boxes, no file bytes), and the form client hands both through", async () => {
    // Independent review of #714, round 3 (N-3): any of these hand-offs could
    // drop the flag and every test still passed, filing each router failure
    // as an open real loss.
    const { sendSubmitFailureBeacon } = await import("../lib/forms/submit-failure-beacon");
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      sendSubmitFailureBeacon({
        tenantSlug: "oasis-ai-cc",
        formSlug: "router",
        stepIndex: 1,
        error: "route_network_error",
        payload: { path: "audit", deck: inlineFile("%PDF-1.4 x", "deck.pdf", "application/pdf") },
        nothingToRecover: true,
        consentLedger: { email: false },
      });
      sendSubmitFailureBeacon({ tenantSlug: "oasis-ai-cc", formSlug: "two-step", stepIndex: 0, error: "server_error", payload: { email: "a@example.com" } });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, "/api/forms/submit-failure");
    assert.equal(sent[0].init.keepalive, true);
    const first = JSON.parse(String(sent[0].init.body)) as Json;
    assert.equal(first.nothing_to_recover, true);
    assert.deepEqual(first.consent_ledger, { email: false });
    assert.deepEqual((first.payload as Json).deck, { skipped_file: "deck.pdf", size_bytes: 10 }, "no file bytes");
    const second = JSON.parse(String(sent[1].init.body)) as Json;
    assert.equal("nothing_to_recover" in second, false, "an ordinary failure is not marked");
    assert.equal("consent_ledger" in second, false);

    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(client, /reportSubmitFailure\(data \? data\.error \?\? "server_error" : `non_json_http_\$\{res\.status\}`, payload, stepIndex, \{\s*nothingToRecover,\s*consentLedger,\s*\}\);/);
    assert.match(client, /reportSubmitFailure\(`unmapped_submit_error:\$\{data\.error\}`, payload, stepIndex, \{ nothingToRecover, consentLedger \}\);/);
    assert.match(client, /payload: payload \?\? values,\s*nothingToRecover,\s*consentLedger,\s*\}\);/, "reportSubmitFailure forwards both to the beacon");
    // A signed link's page passes the slugs as props, not anonymousInit: the
    // beacon must still name the form, or its loss pages nobody (CodeRabbit on #714).
    assert.match(client, /tenantSlug: anonymousInit\?\.tenant_slug \?\? tenantSlug,\s*formSlug: anonymousInit\?\.form_slug \?\? formSlug,/);
    assert.match(read("app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx"), /tenantSlug=\{result\.tenant_slug\}\s*formSlug=\{result\.form\.slug\}/, "and the signed-link page passes them");
    assert.match(client, /showSubmitFailure\(res, data, built\.payload, currentStep, \{ consentLedger: ledger \}\);/, "a step's consent boxes go with its failure");
    assert.match(client, /showSubmitFailure\(res, data, \{ \.\.\.payload, \.\.\.\(contact \?\? \{\}\) \}, i, \{ consentLedger: ledger \}\);/, "and a held step's");
    // The router: a dead connection counts, and is never filed as a real loss;
    // an answer that works starts the count again (N-7).
    assert.match(
      client,
      /\} catch \{\s*\/\/[^\n]*\n\s*routeFailures\.current \+= 1;\s*if \(routeFailures\.current >= 2\) \{\s*reportSubmitFailure\("route_network_error", lastPayload, currentStep, \{ nothingToRecover: true \}\);/,
    );
    assert.match(client, /routeFailures\.current = 0;\s*if \(tenantSlug && formSlug\) \{/, "a router answer that works resets the count");
    // Remove empties the file input AND the answer, so the file is not sent (R6).
    assert.match(read("components/forms/FormRenderer.tsx"), /if \(input\) input\.value = "";\s*onChange\(null\);/);
  });

  await check("a missing object reads as missing on either storage, and a dedup approval whose own update fails says so", async () => {
    // Independent review of #714, round 3 (N-4): Supabase Storage, the
    // rollback backend, answers a missing object with HTTP 400 and "404" in
    // the body, so every unfinished upload read as a storage fault.
    const { storageObjectMissing } = await import("../lib/lead-documents");
    assert.equal(storageObjectMissing({ status: 404, message: "Not Found" }), true, "R2");
    assert.equal(storageObjectMissing({ status: 400, statusCode: "404", message: "Object not found" }), true, "Supabase Storage");
    assert.equal(storageObjectMissing({ status: 400, statusCode: "400", message: "Bad request" }), false);
    assert.equal(storageObjectMissing({ status: 500, message: "storage down" }), false);
    assert.equal(storageObjectMissing(null), false);
    assert.match(read("lib/lead-documents.ts"), /return storageObjectMissing\(head\.error\)\s*\?\s*\{ ok: false, error: "uploaded_object_not_found" \}/);

    // scrub-candidates: the lead already exists and the candidate's own update
    // fails. The answer and the log say so, never a plain "approved".
    const id = "33333333-3333-4333-8333-333333333333";
    await firstStep("two-step", "dedup-target@example.com");
    await seed.execute({
      sql: "INSERT INTO scrub_candidates (id, tenant_id, status, lead_data) VALUES (?, ?, 'pending_review', ?)",
      args: [id, OASIS, JSON.stringify({ email: "dedup-target@example.com", business_name: "Dedup Co" })],
    });
    await login(USERS.cc);
    await seed.execute("CREATE TRIGGER refuse_approved BEFORE UPDATE ON scrub_candidates WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, 'no writes now'); END");
    const lines: string[] = [];
    const errors = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    let res: Response;
    try {
      res = await approve(id);
    } finally {
      console.error = errors;
      await seed.execute("DROP TRIGGER refuse_approved");
    }
    const body = (await res.json()) as Json;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.deduped, true);
    assert.equal(body.warning, "candidate_status_update_failed");
    assert.ok(lines.some((l) => l.includes("dedup finalize update error") && l.includes(id)), "logged with the candidate's id");
  });

  await check("the visitor is told to try again, the beacon fires and carries no file bytes, and the pages raise instead of drawing a dead end", async () => {
    assert.ok(SUBMIT_ERROR_COPY.form_unavailable && !/no longer valid/i.test(SUBMIT_ERROR_COPY.form_unavailable));
    assert.ok(SUBMIT_ERROR_COPY.upload_failed, "a fallback sentence for upload_failed");
    assert.ok(SUBMIT_ERROR_COPY.upload_unavailable, "a fallback sentence for upload_unavailable");
    const { BEACON_ERRORS, isSubmitFault } = await import("../lib/forms/submit-failure-beacon");
    for (const code of ["server_error", "form_unavailable", "upload_unavailable", "consent_record_unavailable"]) {
      assert.ok(BEACON_ERRORS.has(code), `${code} sends the beacon`);
      assert.ok(isSubmitFault(400, { error: code }), `${code} is a fault whatever its status`);
    }
    for (const code of ["rate_limited", "upload_failed", "missing_required_field", "contact_required"]) {
      assert.ok(!BEACON_ERRORS.has(code), `${code} is the form working, not a lost visitor`);
      assert.ok(!isSubmitFault(code === "rate_limited" ? 429 : 400, { error: code }), `${code} is not a fault`);
    }
    // Any 5xx, named or not, and an answer that is not JSON (round 3, N-2).
    for (const [status, error] of [[500, "form_definition_corrupt"], [503, "form_links_misconfigured"], [503, "token_server_misconfigured"], [503, "funnel_stage_write_unavailable"]] as const) {
      assert.ok(isSubmitFault(status, { error }), `${status} ${error} is a fault`);
    }
    assert.ok(isSubmitFault(200, null), "no JSON answer is a fault");
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(client, /if \(beacon && isSubmitFault\(res\.status, data\)\) \{/);
    assert.match(client, /\} else if \(beacon && data\?\.error && !\(data\.error in SUBMIT_ERROR_COPY\)\) \{/, "one beacon per failure, never both");
    assert.match(
      read("lib/forms/submit-failure-beacon.ts"),
      /typeof \(v as \{ inline_base64\?: unknown \}\)\.inline_base64 === "string"/,
      "the beacon drops a built payload's file bytes",
    );
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
