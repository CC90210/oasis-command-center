/**
 * The public form routes take a bounded request, keep the database's words to
 * themselves, and say so when a side write fails.
 *
 * WHY (2026-10-19 audit, the findings #714 did not cover). These routes take the
 * leads from paid ads and answer anyone:
 *   - `await req.json()` buffered the whole body, up to what the platform lets
 *     through, before any check could run (submit, view, upload-url, and the
 *     failure beacon, which read `req.text()` first and measured after).
 *   - No answer had a length limit: the rest of the body was bounded only by
 *     the platform, and the support form stored whatever object it was sent.
 *   - upload-url answered `sign_failed: <the storage client's words>`, and any
 *     throw under it (storage not set up) escaped as an unhandled 500.
 *   - Three form-definition refusals sent the definition's own path and reason.
 *   - Five writes that matter or are worth knowing about failed silently,
 *     because the adapter answers `{ error }` instead of throwing.
 *   - The Meet room routes built their database client outside the handler's
 *     try, so a client that could not be built was an unhandled 500 with no log.
 *
 * WHAT THE NUMBERS ARE. Measured from the code and the data, not guessed: the
 * seeded form definitions (the *-seed.ts files and sunbiz-templates.ts in
 * lib/forms, lib/delivery/support-form.ts), form links signed the way production
 * signs them (lib/form-links.ts), and signature PNGs drawn stroke by stroke the
 * way components/forms/SignaturePad.tsx draws them.
 *   - submit takes 88 MiB: the route has always accepted 60 MiB of inline files
 *     per request (PER_REQUEST_DECODED_CAP_BYTES), which is 80 MiB of base64, so
 *     no cap can sit lower without refusing files it accepts today; the other
 *     8 MiB is the answers, 20 times the largest text-only request measured
 *     (a heavy signature plus a 30-field form at every limit, about 0.4 MB).
 *   - view and upload-url take 16 KiB. A form link is 227 characters (302 at
 *     the worst: UUID ids and a 63-character workspace slug), so view's body is
 *     0.31 KB at most and upload-url's 0.4 KB, or 1.15 KB with the longest file
 *     name a browser allows: 14 times the worst of them.
 *   - the failure beacon takes 64 KiB: the most a browser sends with keepalive.
 *   - an answer takes 10,000 characters unless its field says less (the largest
 *     limit any seeded form declares is 5,000), a field that declares more is
 *     held to 100,000, a signature takes 2 MiB (a signature is a PNG data
 *     address: 30 to 41 thousand characters normally, 370 thousand for a heavy
 *     one, 1.5 million for a scribble over the whole pad), and a payload takes
 *     200 keys (the largest seeded step has 10 fields, the largest form 30) of
 *     128 characters (a field name is 63 at most).
 *
 * AN ANSWER OVER ITS LIMIT IS CUT, NOT REFUSED. A person who pasted an essay
 * into a box keeps their lead: the contact fields and the first 10,000
 * characters go through, and the cut says so where whoever reads the answer
 * will see it. Refusing it would lose the lead to a rule they cannot see. What
 * cannot be cut is refused with a sentence naming the field: a signature (half
 * a PNG is nothing) and a value that is not text.
 *
 * Real routes, real SQL (tests/_delivery-harness.ts), the way
 * forms-survive-database-blips.test.ts drives them.
 *
 * Run: node --conditions=react-server --import tsx tests/public-forms-bounded.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";
import { BEACON_ERRORS, isSubmitFault } from "../lib/forms/submit-failure-beacon";
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

const MiB = 1024 * 1024;
// The contract, pinned here and not read back from the code under test.
const SUBMIT_BODY_CAP = 88 * MiB;
const SMALL_BODY_CAP = 16 * 1024;
const BEACON_BODY_CAP = 64 * 1024;
const TEXT_LIMIT = 10_000;
const DECLARED_CEILING = 100_000;
const SIGNATURE_LIMIT = 2 * MiB;
const COMPOUND_LIMIT = 100_000;
const MIN_KEYS = 200;
const KEY_CHARS = 128;

// A fake R2 behind a fetch stub (no network): PUT, HEAD, GET, DELETE and the
// listing, the way forms-survive-database-blips.test.ts has it.
const R2_STORE = new Map<string, number>(); // object key -> size
process.env.R2_ACCOUNT_ID = "testacct";
process.env.R2_ACCESS_KEY_ID = "AKIATEST";
process.env.R2_SECRET_ACCESS_KEY = "testsecret";
process.env.R2_BUCKET = "test-bucket";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "testacct.r2.cloudflarestorage.com") throw new Error(`test: network blocked (${url.hostname})`);
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

// -- the forms ---------------------------------------------------------------
const BOUNDED_STEPS = [
  {
    key: "contact",
    title: "Reach you",
    fields: [
      field("email", "email", "Email"),
      field("name", "text", "Name", false),
      field("story", "textarea", "Your story", false),
      field("short", "text", "Short answer", false, { maxLength: 20 }),
      field("bio", "textarea", "Bio", false, { maxLength: 5000 }),
      field("far_too_high", "text", "Declared limit far too high", false, { maxLength: 5_000_000 }),
    ],
  },
  {
    key: "sign",
    title: "Sign",
    fields: [field("note", "text", "Note", false), field("sig", "signature", "Signature", false)],
  },
];
// The largest form the real ones come to (30 fields), every one at its limit.
const BIG_STEP0_FIELDS = [
  field("email", "email", "Email"),
  ...Array.from({ length: 26 }, (_, i) => field(`t${String(i + 1).padStart(2, "0")}`, "text", `Text ${i + 1}`, false, { maxLength: 200 })),
  field("bio", "textarea", "Bio", false, { maxLength: 5000 }),
  field("story", "textarea", "Story", false),
  field("story2", "textarea", "More of the story", false),
];
const BIG_STEPS = [
  { key: "details", title: "Details", fields: BIG_STEP0_FIELDS },
  { key: "sign", title: "Sign", fields: [field("note", "text", "Note", false), field("sig", "signature", "Signature", false)] },
];
const UPLOAD_STEPS = [
  {
    key: "docs",
    title: "Documents",
    fields: [
      field("email", "email", "Email"),
      field("doc1", "file_upload", "First document", false, { accept: ["application/pdf"] }),
      field("doc2", "file_upload", "Second document", false, { accept: ["application/pdf"] }),
    ],
  },
];
// An upload-first form: its first step needs the visitor's link before a file can be chosen,
// so the form page asks for the link alone (initialize_only) and the contact rides with it.
const INIT_STEPS = [
  {
    key: "docs",
    title: "Documents",
    fields: [
      field("email", "email", "Email"),
      field("name", "text", "Name", false),
      field("statements", "file_upload_multi", "Statements", false, { accept: ["application/pdf"], max_files: 2 }),
    ],
  },
];
// A form wider than the real ones: 120 fields in one step (the largest seeded step has 10).
const WIDE_STEPS = [
  {
    key: "wide",
    title: "Wide",
    fields: [field("email", "email", "Email"), ...Array.from({ length: 119 }, (_, i) => field(`w${String(i + 1).padStart(3, "0")}`, "text", `Wide ${i + 1}`, false))],
  },
];
const MERGE_STEPS = [{ key: "contact", title: "Reach you", fields: [field("email", "email", "Email"), field("name", "text", "Name", false)] }];
const START_STEPS = [
  { key: "start", title: "Start", fields: [field("email", "email", "Email"), field("name", "text", "Name", false), field("instagram", "text", "Instagram", false)] },
];
const OWNER_STEPS = [
  { key: "contact", title: "Reach you", fields: [field("email", "email", "Email")] },
  { key: "owner", title: "Owner", fields: [field("owner_full_name", "text", "Owner's full name", false)] },
];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
/** Half of a surrogate pair (an emoji cut in the middle) anywhere in `text`. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function main() {
  const seed = await setupDatabase();

  // -- first, before anything builds the app's database client ---------------
  console.log("public-forms-bounded:");
  await check("every Meet route whose database client cannot be built (the five a guest uses, and the host's panel) answers JSON and logs under its own name, never an unhandled throw", async () => {
    const saved = process.env.TURSO_DB_PATH;
    delete process.env.TURSO_DB_PATH;
    try {
      const { getTursoClient } = await import("../lib/turso");
      assert.throws(() => getTursoClient(), /Turso misconfigured/, "precondition: nothing has built the client yet");
      const panel = await import("../app/api/calendar/meet/route");
      const room = "/api/meet/abc-defg-hij";
      const routes = [
        ["join", "POST", await import("../app/api/meet/[code]/join/route"), `${room}/join`],
        ["leave", "POST", await import("../app/api/meet/[code]/leave/route"), `${room}/leave`],
        ["host", "POST", await import("../app/api/meet/[code]/host/route"), `${room}/host`],
        ["sfu", "POST", await import("../app/api/meet/[code]/sfu/route"), `${room}/sfu`],
        ["state", "GET", await import("../app/api/meet/[code]/state/route"), `${room}/state`],
        // The host's panel (signed in) is built the same way, and logs under its handlers' names.
        ["rooms.list", "GET", panel, "/api/calendar/meet"],
        ["rooms.create", "POST", panel, "/api/calendar/meet"],
      ] as const;
      const { NextRequest } = await import("next/server");
      for (const [where, method, mod, url] of routes) {
        const lines: string[] = [];
        const errors = console.error;
        console.error = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
        let res: Response;
        try {
          const req = new NextRequest(`http://localhost${url}`, {
            method,
            headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
            ...(method === "POST" ? { body: JSON.stringify({ name: "Guest" }) } : {}),
          });
          const handler = (mod as unknown as Record<string, (r: unknown, c: unknown) => Promise<Response>>)[method];
          res = await handler(req, { params: Promise.resolve({ code: "abc-defg-hij" }) });
        } finally {
          console.error = errors;
        }
        assert.equal(res.status, 500, `${where}: ${res.status}`);
        assert.deepEqual(await res.json(), { ok: false, error: "meet_unavailable" }, `${where}: a stable answer`);
        assert.ok(lines.some((l) => l.includes(`[meet.${where}]`) && /Turso misconfigured/.test(l)), `${where}: logged under its own name: ${lines.join(" | ")}`);
      }
    } finally {
      process.env.TURSO_DB_PATH = saved;
    }
  });

  // -- the world the form routes run in -----------------------------------------
  await seed.executeMultiple(`
    -- The harness's forms table has no foreign key to tenants, which the form read joins through, and
    -- no forms.routing (migration bravo__220). Rebuilt with both, keeping the support form that
    -- migration 183 seeded (the support intake is checked below).
    ALTER TABLE forms RENAME TO forms_harness;
    CREATE TABLE forms (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, routing TEXT
    );
    INSERT INTO forms (id, tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes, enabled, redirect_url, created_by, created_at, updated_at)
      SELECT id, tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes, enabled, redirect_url, created_by, created_at, updated_at FROM forms_harness;
    DROP TABLE forms_harness;
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, target_agent TEXT,
      payload TEXT, correlation_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lead_documents (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, lead_id TEXT,
      filename TEXT, mime_type TEXT, size_bytes INTEGER, doc_type TEXT, storage_path TEXT, uploaded_by TEXT,
      uploaded_at TEXT, metadata TEXT);
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
  await seed.executeMultiple(read("database/turso/146_form_submit_failures.turso.sql"));
  const insertForm = (id: string, slug: string, name: string, steps: unknown) =>
    seed.execute({ sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES (?, ?, ?, ?, ?)", args: [id, OASIS, slug, name, JSON.stringify(steps)] });
  await insertForm("form-bounded", "bounded-form", "Bounded", BOUNDED_STEPS);
  await insertForm("form-big", "big-form", "Big", BIG_STEPS);
  await insertForm("form-upload", "upload-form", "Upload", UPLOAD_STEPS);
  await insertForm("form-merge", "merge-form", "Merge", MERGE_STEPS);
  await insertForm("form-wide", "wide-form", "Wide", WIDE_STEPS);
  await insertForm("form-init", "init-form", "Init", INIT_STEPS);
  await insertForm("form-start", "start", "Work with CC", START_STEPS);
  await insertForm("form-owner", "owner-form", "Owner", OWNER_STEPS);
  await insertForm("form-corrupt", "corrupt-form", "Corrupt", [{ key: "x", title: "X", fields: [{ name: "Bad Name", type: "text", label: "Bad" }] }]);

  const { NextRequest } = await import("next/server");
  const submit = await import("../app/api/forms/submit/route");
  const view = await import("../app/api/forms/view/route");
  const upload = await import("../app/api/forms/upload-url/route");
  const beacon = await import("../app/api/forms/submit-failure/route");
  const booking = await import("../app/api/forms/booking/route");
  const bookingAvailability = await import("../app/api/forms/booking/availability/route");
  const bookingDetailsOnly = await import("../app/api/forms/booking/details-only/route");
  const { getTursoClient } = await import("../lib/turso");

  // Fault injection on the app's own database client (the seed client is a
  // separate connection): a statement the test names fails as in an outage,
  // and everything else runs (from forms-survive-database-blips.test.ts).
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

  /** Run `fn` with the console captured; the lines are what the route logged. */
  const logged = async <T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
    const lines: string[] = [];
    const errors = console.error;
    const warns = console.warn;
    const grab = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
    console.error = grab;
    console.warn = grab;
    try {
      return { value: await fn(), lines };
    } finally {
      console.error = errors;
      console.warn = warns;
    }
  };
  /** Fail the statements `when` names for the length of `fn`, capturing what is logged. */
  const failing = async <T>(when: (sql: string, args: unknown[]) => boolean, fn: () => Promise<T>) => {
    failWhen = when;
    try {
      return await logged(fn);
    } finally {
      failWhen = null;
    }
  };
  const isUpdateWith = (...needles: string[]) => (sql: string, args: unknown[]) =>
    /^\s*update/i.test(sql) && needles.every((n) => args.some((a) => typeof a === "string" && a.includes(n)));
  const refusingInserts = async <T>(table: string, words: string, fn: () => Promise<T>) => {
    await seed.execute(`CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, '${words}'); END`);
    try {
      return await logged(fn);
    } finally {
      await seed.execute(`DROP TRIGGER refuse_${table}`);
    }
  };

  const count = async (sql: string, args: unknown[] = []) => Number((await seed.execute({ sql, args: args as never })).rows[0].n);
  const leads = () => count("SELECT count(*) AS n FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead'", [OASIS]);
  const steps = (formId: string) => count("SELECT count(*) AS n FROM form_submissions WHERE form_id = ?", [formId]);
  const leadIdFor = async (email: string) =>
    String((await seed.execute({ sql: "SELECT id FROM tenant_records WHERE tenant_id = ? AND entity_type = 'lead' AND json_extract(data, '$.email') = ?", args: [OASIS, email] })).rows[0].id);
  const storedPayload = async (leadId: string, step: number) =>
    JSON.parse(String((await seed.execute({ sql: "SELECT payload FROM form_submissions WHERE lead_id = ? AND step_index = ?", args: [leadId, step] })).rows[0].payload)) as Json;

  let ip = 0;
  const nextIp = () => `10.8.${Math.floor(++ip / 250)}.${ip % 250}`;
  const send = async (handler: (r: never) => Promise<Response>, path: string, body: unknown) => {
    const res = await handler(
      new NextRequest(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
        body: JSON.stringify(body),
      }) as never,
    );
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) as Json; } catch { return {} as Json; } })() };
  };
  const post = (body: unknown) => send(submit.POST as never, "/api/forms/submit", body);
  const anon = (formSlug: string) => ({ tenant_slug: "oasis-ai-cc", form_slug: formSlug });
  const firstStep = async (formSlug: string, email: string, payload: Json = {}) => {
    const r = await post({ step_index: 0, anonymous_init: anon(formSlug), payload: { email, ...payload } });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    return { token: String(r.json.minted_token), leadId: await leadIdFor(email), response: r };
  };
  /** A response with the two ids no two runs share taken out, so it can be compared to the byte. */
  const masked = (text: string) =>
    text.replace(/"submission_id":"[0-9a-f-]{36}"/g, '"submission_id":"<id>"').replace(/"minted_token":"[^"]+"/g, '"minted_token":"<token>"');

  // A request whose body is a stream the test can watch: how many reads were
  // asked of it, and how many bytes were handed over. highWaterMark 0 means
  // nothing is read ahead, so a count of zero is proof that nothing was read.
  const streamed = (path: string, o: { declared?: number; chunk: number; total: number; headers?: Record<string, string> }) => {
    const state = { pulls: 0, pulled: 0 };
    const chunk = new Uint8Array(o.chunk).fill(0x20); // JSON whitespace: valid to the end, never a document
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulls += 1;
          if (state.pulled >= o.total) {
            controller.close();
            return;
          }
          state.pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": nextIp(), ...o.headers };
    if (o.declared !== undefined) headers["content-length"] = String(o.declared);
    const request = new NextRequest(`http://localhost${path}`, { method: "POST", headers, body: stream, duplex: "half" } as unknown as RequestInit);
    return { request, state };
  };
  const bytesBody = (path: string, bytes: string, declared: number) =>
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), "content-length": String(declared) },
      body: bytes,
    });

  // -- the golden: what a normal request answers today, to the byte ---------
  // Captured from the code before this change (the run that failed here).
  const GOLDEN_FIRST_STEP =
    '{"ok":true,"submission_id":"<id>","next_step":1,"lead_stage":null,"route_to":null,"redirect_url":null,"next_forms":null,"stage_warning":null,"uploads":{"attempted":0,"succeeded":0,"warnings":[]},"minted_token":"<token>"}';
  const GOLDEN_LAST_STEP =
    '{"ok":true,"submission_id":"<id>","next_step":null,"lead_stage":null,"route_to":null,"redirect_url":null,"next_forms":null,"stage_warning":null,"uploads":{"attempted":0,"succeeded":0,"warnings":[]},"minted_token":null}';
  const GOLDEN_VIEW = '{"ok":true,"viewed_application_fired":false,"intent_inquiry_fired":false}';
  const GOLDEN_VIEW_AGAIN = '{"ok":true,"viewed_application_fired":false}';

  // ===========================================================================
  // 1. A body is bounded BEFORE it is read
  // ===========================================================================
  const ROUTES = [
    { name: "submit", path: "/api/forms/submit", handler: submit.POST as never, cap: SUBMIT_BODY_CAP, chunk: 256 * 1024, error: "request_payload_too_large" },
    { name: "view", path: "/api/forms/view", handler: view.POST as never, cap: SMALL_BODY_CAP, chunk: 1024, error: "request_payload_too_large" },
    { name: "upload-url", path: "/api/forms/upload-url", handler: upload.POST as never, cap: SMALL_BODY_CAP, chunk: 1024, error: "request_payload_too_large" },
    // The beacon's answer to a body over its cap has always been too_large.
    { name: "submit-failure", path: "/api/forms/submit-failure", handler: beacon.POST as never, cap: BEACON_BODY_CAP, chunk: 4 * 1024, error: "too_large" },
  ] as const;

  for (const r of ROUTES) {
    await check(`${r.name}: a body that declares more than ${r.cap} bytes is refused 413 without one byte of it being read`, async () => {
      const { request, state } = streamed(r.path, { declared: r.cap + 1, chunk: r.chunk, total: r.cap * 2 });
      const res = await (r.handler as (q: unknown) => Promise<Response>)(request);
      assert.equal(res.status, 413, `HTTP ${res.status}: the body was read and judged afterwards`);
      assert.equal(((await res.json()) as Json).error, r.error);
      assert.equal(state.pulls, 0, `the handler asked for ${state.pulls} reads of a body it was told was too big`);
    });
    await check(`${r.name}: a body with no Content-Length is cut off at the cap, never read to its end`, async () => {
      const { request, state } = streamed(r.path, { chunk: r.chunk, total: r.cap + 3 * r.chunk });
      const res = await (r.handler as (q: unknown) => Promise<Response>)(request);
      assert.equal(res.status, 413, `HTTP ${res.status}: the whole ${state.pulled} bytes were read`);
      assert.equal(((await res.json()) as Json).error, r.error);
      assert.ok(state.pulled > r.cap && state.pulled <= r.cap + r.chunk, `read ${state.pulled} bytes of a ${r.cap} byte cap (one chunk is ${r.chunk})`);
    });
    await check(`${r.name}: a Content-Length that lies low is cut off at the cap all the same`, async () => {
      const { request, state } = streamed(r.path, { declared: 100, chunk: r.chunk, total: r.cap + 3 * r.chunk });
      const res = await (r.handler as (q: unknown) => Promise<Response>)(request);
      assert.equal(res.status, 413, `HTTP ${res.status}: the whole ${state.pulled} bytes were read`);
      assert.ok(state.pulled > r.cap && state.pulled <= r.cap + r.chunk, `read ${state.pulled} bytes of a ${r.cap} byte cap`);
    });
    await check(`${r.name}: the cap is exact: ${r.cap} declared goes on to be judged, ${r.cap + 1} does not`, async () => {
      const at = await (r.handler as (q: unknown) => Promise<Response>)(bytesBody(r.path, "{}", r.cap));
      assert.notEqual(at.status, 413, "a body at the cap is not too big");
      const over = await (r.handler as (q: unknown) => Promise<Response>)(bytesBody(r.path, "{}", r.cap + 1));
      assert.equal(over.status, 413);
    });
  }

  // The public booking routes read their body through lib/forms/public-booking.ts
  // readPublicBookingJson, which was bounded before this change (8,000 bytes, a
  // Content-Length fast path and a running count) and answers 400 invalid_json
  // rather than 413. Left as it was; pinned here so it stays bounded.
  const BOOKING_CAP = 8_000;
  const sameOriginHeaders = { origin: "http://localhost", host: "localhost" };
  for (const r of [
    { name: "booking", path: "/api/forms/booking", handler: booking.POST },
    { name: "booking/availability", path: "/api/forms/booking/availability", handler: bookingAvailability.POST },
    { name: "booking/details-only", path: "/api/forms/booking/details-only", handler: bookingDetailsOnly.POST },
  ] as const) {
    await check(`${r.name} (bounded before this change, pinned): ${BOOKING_CAP + 1} bytes declared is refused unread, and a body that does not say is cut off at ${BOOKING_CAP}`, async () => {
      const declared = streamed(r.path, { declared: BOOKING_CAP + 1, chunk: 1024, total: 64 * 1024, headers: sameOriginHeaders });
      const refused = await r.handler(declared.request as never);
      assert.equal(refused.status, 400);
      assert.equal(((await refused.json()) as Json).error, "invalid_json");
      assert.equal(declared.state.pulls, 0, "not one read of a body it was told was too big");
      const silent = streamed(r.path, { chunk: 1024, total: 64 * 1024, headers: sameOriginHeaders });
      const cut = await r.handler(silent.request as never);
      assert.equal(cut.status, 400);
      assert.ok(silent.state.pulled > BOOKING_CAP && silent.state.pulled <= BOOKING_CAP + 1024, `read ${silent.state.pulled} bytes of an ${BOOKING_CAP} byte cap`);
    });
  }

  await check("the caps in the code are the caps this suite pins, and submit's leaves room for every file the route accepts", async () => {
    const caps = await import("../lib/forms/bounded-body");
    assert.equal(caps.SUBMIT_BODY_CAP_BYTES, SUBMIT_BODY_CAP);
    assert.equal(caps.SMALL_BODY_CAP_BYTES, SMALL_BODY_CAP);
    const limits = await import("../lib/forms/answer-limits");
    assert.deepEqual(
      { ...limits.ANSWER_LIMITS },
      { textChars: TEXT_LIMIT, declaredCeilingChars: DECLARED_CEILING, signatureChars: SIGNATURE_LIMIT, compoundChars: COMPOUND_LIMIT, minKeys: MIN_KEYS, keyChars: KEY_CHARS },
    );
    const routeSrc = read("app/api/forms/submit/route.ts");
    const decoded = /const PER_REQUEST_DECODED_CAP_BYTES = (\d+) \* 1024 \* 1024;/.exec(routeSrc);
    assert.ok(decoded, "the route's own limit on files is where this test looks for it");
    const filesAsBase64 = Math.ceil((Number(decoded[1]) * MiB) / 3) * 4;
    assert.ok(caps.SUBMIT_BODY_CAP_BYTES >= filesAsBase64 + 8 * MiB, "the cap holds every file the route accepts, as base64, with 8 MiB over for the answers");
    assert.equal(/const BODY_CAP_BYTES = (\d+) \* 1024;/.exec(read("app/api/forms/submit-failure/route.ts"))?.[1], "64", "the beacon's cap is a browser's keepalive limit");
  });

  await check("a request carrying the most inline files a visitor can pick (two of 15 MiB) is not refused by the cap, and lands", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(15 * MiB - 9, 0x25)]);
    const file = (name: string) => ({ inline_base64: pdf.toString("base64"), filename: name, mime_type: "application/pdf", size_bytes: pdf.length });
    const r = await post({ step_index: 0, anonymous_init: anon("upload-form"), payload: { email: "files@example.com", doc1: file("a.pdf"), doc2: file("b.pdf") } });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.deepEqual((r.json.uploads as Json).succeeded, 2);
    assert.equal(await count("SELECT count(*) AS n FROM lead_documents WHERE lead_id = ?", [await leadIdFor("files@example.com")]), 2);
  });

  // ===========================================================================
  // 2. A normal request is answered exactly as before
  // ===========================================================================
  let minted: { token: string; leadId: string } | null = null;
  await check("a normal two-step submission answers byte for byte what it did before this change", async () => {
    const first = await firstStep("bounded-form", "golden@example.com", { name: "Golden", story: "A short story." });
    assert.equal(masked(first.response.text), GOLDEN_FIRST_STEP);
    const last = await post({ token: first.token, step_index: 1, payload: { note: "Done" } });
    assert.equal(last.status, 200);
    assert.equal(masked(last.text), GOLDEN_LAST_STEP);
    minted = { token: first.token, leadId: first.leadId };
    assert.deepEqual(await storedPayload(first.leadId, 0), { email: "golden@example.com", name: "Golden", story: "A short story." });
  });

  await check("the largest legitimate submission (30 fields at their limits, then a heavy signature) is stored untouched and answered as before", async () => {
    const step0: Json = { email: "big@example.com", bio: "b".repeat(5000), story: "s".repeat(TEXT_LIMIT), story2: "z".repeat(TEXT_LIMIT) };
    for (let i = 1; i <= 26; i += 1) step0[`t${String(i).padStart(2, "0")}`] = "t".repeat(200);
    const first = await post({ step_index: 0, anonymous_init: anon("big-form"), payload: step0 });
    assert.equal(first.status, 200, first.text.slice(0, 300));
    assert.equal(masked(first.text), GOLDEN_FIRST_STEP);
    const leadId = await leadIdFor("big@example.com");
    assert.deepEqual(await storedPayload(leadId, 0), step0, "every answer, to the character");
    // A heavy signature: a PNG data address of 369,030 characters (measured).
    const sig = `data:image/png;base64,${"A".repeat(369_030 - 22)}`;
    const last = await post({ token: String(first.json.minted_token), step_index: 1, payload: { note: "Done", sig } });
    assert.equal(last.status, 200, last.text.slice(0, 300));
    assert.equal(masked(last.text), GOLDEN_LAST_STEP);
    assert.equal((await storedPayload(leadId, 1)).sig, sig, "the signature is stored whole");
  });

  // ===========================================================================
  // 3. An answer over its limit is cut and the lead is kept; what cannot be cut is refused
  // ===========================================================================
  await check("an answer over its field's own limit is cut to it, the lead is kept, and the cut is logged without the answer", async () => {
    const { value: first, lines } = await logged(() => firstStep("bounded-form", "cut-declared@example.com", { short: "q".repeat(500), bio: "b".repeat(6000) }));
    const cut = await storedPayload(first.leadId, 0);
    assert.equal(cut.short, "q".repeat(20));
    // Cut the way the browser's own maxlength would have: no note in an answer the box would never have held.
    assert.equal(cut.bio, "b".repeat(5000));
    const line = lines.find((l) => /answers cut to their limit/.test(l));
    assert.ok(line, `a log line: ${lines.join(" | ")}`);
    assert.ok(/"short"/.test(line) && !/qqqqq/.test(line), "the field is named, the answer is not");
  });

  await check("an answer exactly at its limit is untouched, one character over is cut (declared and default)", async () => {
    const a = await firstStep("bounded-form", "limit-edge@example.com", { short: "e".repeat(20), story: "e".repeat(TEXT_LIMIT) });
    const kept = await storedPayload(a.leadId, 0);
    assert.equal(kept.short, "e".repeat(20));
    assert.equal(kept.story, "e".repeat(TEXT_LIMIT));
    const b = await firstStep("bounded-form", "limit-over@example.com", { short: "e".repeat(21), story: "e".repeat(TEXT_LIMIT + 1) });
    const cut = await storedPayload(b.leadId, 0);
    assert.equal((cut.short as string).length, 20);
    assert.equal((cut.story as string).length, TEXT_LIMIT, "cut to the limit, note included");
  });

  await check("an answer with no limit of its own is cut to 10,000 characters with a note in the answer itself, where whoever reads it will see it", async () => {
    const r = await firstStep("bounded-form", "cut-default@example.com", { story: `${"a".repeat(TEXT_LIMIT + 5_000)}`, name: "N".repeat(50_000) });
    const story = (await storedPayload(r.leadId, 0)).story as string;
    const leadName = await count("SELECT length(json_extract(data, '$.name')) AS n FROM tenant_records WHERE id = ?", [r.leadId]);
    assert.ok(leadName > 0 && leadName <= TEXT_LIMIT, `the lead made from it carries a name of ${leadName} characters`);
    assert.equal(story.length, TEXT_LIMIT);
    assert.ok(story.startsWith("a".repeat(9_000)), "the beginning of the answer is what is kept");
    assert.match(story, /\[cut: this answer was longer than 10,000 characters\]$/);
  });

  await check("a limit a form declares far too high is held to 100,000 characters", async () => {
    const r = await firstStep("bounded-form", "cut-ceiling@example.com", { far_too_high: "h".repeat(DECLARED_CEILING + 50_000) });
    assert.equal(((await storedPayload(r.leadId, 0)).far_too_high as string).length, DECLARED_CEILING);
    const ok = await firstStep("bounded-form", "ceiling-ok@example.com", { far_too_high: "h".repeat(DECLARED_CEILING) });
    assert.equal(((await storedPayload(ok.leadId, 0)).far_too_high as string).length, DECLARED_CEILING, "a limit it is within is untouched");
  });

  await check("a signature is never cut: a heavy one is stored whole at the limit, one character over is refused naming the field, and nothing is written", async () => {
    const { token } = await firstStep("bounded-form", "sig-limit@example.com");
    const before = await steps("form-bounded");
    const atLimit = `data:image/png;base64,${"S".repeat(SIGNATURE_LIMIT - 22)}`;
    const ok = await post({ token, step_index: 1, payload: { sig: atLimit } });
    assert.equal(ok.status, 200, ok.text.slice(0, 200));
    const afterOk = await steps("form-bounded");
    const over = await post({ token, step_index: 1, payload: { sig: `${atLimit}S` } });
    assert.equal(over.status, 413, over.text.slice(0, 200));
    assert.equal(over.json.error, "answer_too_large");
    assert.equal(over.json.field, "sig");
    assert.match(String(over.json.message), /^Signature: /);
    assert.ok(!/_/.test(String(over.json.message)), "a sentence, not a code");
    assert.equal(await steps("form-bounded"), afterOk, "the refused step wrote nothing");
    assert.equal(afterOk, before + 1);
  });

  await check("a value that is not text and is too heavy is refused naming the field, an inline file's own weight counts but its bytes do not", async () => {
    const heavy = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "heavy-object@example.com", short: { a: "x".repeat(COMPOUND_LIMIT) } } });
    assert.equal(heavy.status, 413, heavy.text.slice(0, 200));
    assert.equal(heavy.json.error, "answer_too_large");
    assert.equal(heavy.json.field, "short");
    // Exactly the limit once written as JSON ({"a":"..."} is 8 characters around the string) is within it.
    const edge = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "edge-object@example.com", short: { a: "x".repeat(COMPOUND_LIMIT - 8) } } });
    assert.equal(edge.status, 200, edge.text.slice(0, 200));
    const small = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "small-object@example.com", short: { a: "x".repeat(1000) }, name: ["a", "b"] } });
    assert.equal(small.status, 200, small.text.slice(0, 200));
    const name = await post({
      step_index: 0,
      anonymous_init: anon("upload-form"),
      payload: { email: "long-filename@example.com", doc1: { inline_base64: "QQ==", filename: "f".repeat(COMPOUND_LIMIT + 1), mime_type: "application/pdf", size_bytes: 1 } },
    });
    assert.equal(name.status, 413, name.text.slice(0, 200));
    assert.equal(name.json.field, "doc1");
  });

  await check("a payload with too many keys, or a key too long, is refused 400 and writes no lead and no step", async () => {
    const leadsBefore = await leads();
    const stepsBefore = await steps("form-bounded");
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    const tooMany = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "too-many@example.com", ...keys(MIN_KEYS) } });
    assert.equal(tooMany.status, 400, tooMany.text.slice(0, 200));
    assert.equal(tooMany.json.error, "invalid_answers");
    const longKey = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "long-key@example.com", ["k".repeat(KEY_CHARS + 1)]: "v" } });
    assert.equal(longKey.status, 400, longKey.text.slice(0, 200));
    assert.equal(longKey.json.error, "invalid_answers");
    assert.equal(await leads() - leadsBefore, 0, "no lead for either");
    assert.equal(await steps("form-bounded"), stepsBefore);
    // The limits themselves are inside: exactly 200 keys, one of them 128 characters long, is taken.
    const atTheLimits = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "exact-keys@example.com", ...keys(MIN_KEYS - 2), ["k".repeat(KEY_CHARS)]: "v" } });
    assert.equal(atTheLimits.status, 200, `200 keys (email, 198, and the long one): ${atTheLimits.text.slice(0, 200)}`);
    const oneOver = await post({ step_index: 0, anonymous_init: anon("bounded-form"), payload: { email: "edge-keys@example.com", ...keys(MIN_KEYS - 1), ["k".repeat(KEY_CHARS)]: "v" } });
    assert.equal(oneOver.status, 400, "201 keys: the same payload with one more");
  });

  await check("the contact an upload-first form sends to get its link (initialize_only) is held to the same limits before it becomes the lead", async () => {
    const r = await post({ step_index: 0, anonymous_init: anon("init-form"), initialize_only: true, payload: { email: "init@example.com", name: "N".repeat(50_000) } });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(r.json.minted_token, "the visitor still gets their link");
    const name = await count("SELECT length(json_extract(data, '$.name')) AS n FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?", [OASIS, "init@example.com"]);
    assert.ok(name > 0 && name <= TEXT_LIMIT, `the lead's name is ${name} characters`);
    const keys = await post({
      step_index: 0,
      anonymous_init: anon("init-form"),
      initialize_only: true,
      payload: { email: "init-keys@example.com", ...Object.fromEntries(Array.from({ length: MIN_KEYS + 1 }, (_, i) => [`k${i}`, "v"])) },
    });
    assert.equal(keys.status, 400, keys.text.slice(0, 200));
    assert.equal(keys.json.error, "invalid_answers");
  });

  await check("the support form, which stores the whole object it is sent, holds the same limits: a flood of keys is refused with no ticket, an undeclared answer past the limit is cut where it is stored", async () => {
    const tickets = () => count("SELECT count(*) AS n FROM support_tickets");
    const stored = (email: string) => count("SELECT count(*) AS n FROM form_submissions WHERE json_extract(payload, '$.email') = ?", [email]);
    const ticket = (email: string, more: Json = {}) => ({ name: "Support Sam", email, category: "other", priority: "low", description: "It will not load.", ...more });
    const before = await tickets();
    const flood = await post({
      step_index: 0,
      anonymous_init: anon("support"),
      payload: ticket("support-flood@example.test", Object.fromEntries(Array.from({ length: MIN_KEYS + 1 }, (_, i) => [`junk${i}`, "x"]))),
    });
    assert.equal(flood.status, 400, flood.text.slice(0, 200));
    assert.equal(flood.json.error, "invalid_answers");
    assert.equal(await tickets(), before, "no ticket for it");
    assert.equal(await stored("support-flood@example.test"), 0, "nothing stored for it");

    const long = await logged(() => post({ step_index: 0, anonymous_init: anon("support"), payload: ticket("support-cut@example.test", { junk_note: "j".repeat(50_000) }) }));
    assert.equal(long.value.status, 200, long.value.text.slice(0, 200));
    assert.equal(await tickets(), before + 1, "the ticket is made");
    const row = (await seed.execute({ sql: "SELECT payload FROM form_submissions WHERE json_extract(payload, '$.email') = ?", args: ["support-cut@example.test"] })).rows[0];
    const kept = JSON.parse(String(row.payload)) as Json;
    assert.equal((kept.junk_note as string).length, TEXT_LIMIT, "the undeclared answer is cut where it is stored");
    assert.match(String(kept.junk_note), /\[cut: this answer was longer than 10,000 characters\]$/);
    assert.equal(kept.description, "It will not load.", "the declared answers are as they were");
    assert.ok(long.lines.some((l) => l.includes("[support-intake] answers cut to their limit")), `logged: ${long.lines.join(" | ")}`);

    const heavy = await post({ step_index: 0, anonymous_init: anon("support"), payload: ticket("support-heavy@example.test", { junk: { a: "x".repeat(COMPOUND_LIMIT) } }) });
    assert.equal(heavy.status, 413, heavy.text.slice(0, 200));
    assert.equal(heavy.json.error, "answer_too_large");
    assert.equal(await tickets(), before + 1, "and no second ticket");
  });

  await check("a form wider than the real ones is never refused for width: twice its fields in keys are taken, one more is not", async () => {
    const wide: Json = { email: "wide@example.com" };
    for (let i = 1; i <= 119; i += 1) wide[`w${String(i).padStart(3, "0")}`] = "w";
    const extras = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`extra${i}`, "x"]));
    const ok = await post({ step_index: 0, anonymous_init: anon("wide-form"), payload: { ...wide, ...extras(120) } });
    assert.equal(ok.status, 200, `240 keys on a 120-field step: ${ok.text.slice(0, 200)}`);
    const over = await post({ step_index: 0, anonymous_init: anon("wide-form"), payload: { ...wide, email: "wide-over@example.com", ...extras(121) } });
    assert.equal(over.status, 400, `241 keys: ${over.text.slice(0, 200)}`);
    assert.equal(over.json.error, "invalid_answers");
  });

  await check("a cut never leaves half of an emoji at the end of the answer", async () => {
    // The note takes 53 characters of the limit, so the cut falls after the 9,947th:
    // an emoji that starts at the 9,947th is two code units wide and would be split.
    const emoji = String.fromCodePoint(0x1f600);
    const r = await firstStep("bounded-form", "emoji-cut@example.com", { story: `${"a".repeat(9_946)}${emoji.repeat(200)}` });
    const kept = (await storedPayload(r.leadId, 0)).story as string;
    assert.ok(kept.length <= TEXT_LIMIT);
    assert.ok(!hasLoneSurrogate(kept), "no half of an emoji");
    assert.match(kept, /\[cut: this answer was longer than 10,000 characters\]$/);
    assert.ok(kept.startsWith("a".repeat(9_946)), "the cut is at the emoji, not before it");
  });

  await check("the same limits hold on a later step sent with its link, and on the router's all-steps request", async () => {
    const { token } = await firstStep("bounded-form", "later-step@example.com");
    const stepsBefore = await steps("form-bounded");
    const many = await post({ token, step_index: 1, payload: Object.fromEntries(Array.from({ length: MIN_KEYS + 1 }, (_, i) => [`k${i}`, "v"])) });
    assert.equal(many.status, 400, many.text.slice(0, 200));
    assert.equal(many.json.error, "invalid_answers");
    const cut = await post({ token, step_index: 1, payload: { note: "n".repeat(TEXT_LIMIT + 100) } });
    assert.equal(cut.status, 200, cut.text.slice(0, 200));
    assert.equal(((await storedPayload(await leadIdFor("later-step@example.com"), 1)).note as string).length, TEXT_LIMIT);
    assert.equal(await steps("form-bounded"), stepsBefore + 1, "the refused one wrote nothing, the cut one is recorded");
    const routed = await post({
      step_index: 0,
      anonymous_init: anon("merge-form"),
      route_only: true,
      steps_payload: [{ name: "z".repeat(TEXT_LIMIT + 1), ...Object.fromEntries(Array.from({ length: MIN_KEYS + 1 }, (_, i) => [`k${i}`, "v"])) }],
    });
    assert.equal(routed.status, 400, "the router's payload is bounded too");
    assert.equal(routed.json.error, "invalid_answers");
  });

  // ===========================================================================
  // 4. The words that go back to an anonymous caller
  // ===========================================================================
  await check("a storage client that answers an error: its words go to the log, the browser gets sign_failed", async () => {
    assert.ok(minted, "a link from the golden check");
    // The real module object, so the patch reaches the R2 signer's own import of it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a namespace import would be a copy
    const crypto = require("node:crypto") as { createHmac: (...a: unknown[]) => unknown };
    const realHmac = crypto.createHmac;
    crypto.createHmac = (alg: unknown, key: unknown, ...rest: unknown[]) => {
      if (typeof key === "string" && key.startsWith("AWS4")) throw new Error("hmac-words-xyz");
      return realHmac(alg, key, ...rest);
    };
    let out: Awaited<ReturnType<typeof logged<Awaited<ReturnType<typeof send>>>>>;
    try {
      out = await logged(() => send(upload.POST as never, "/api/forms/upload-url", { token: minted!.token, filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1000 }));
    } finally {
      crypto.createHmac = realHmac;
    }
    assert.equal(out.value.status, 500);
    assert.deepEqual(out.value.json, { ok: false, error: "sign_failed" });
    assert.ok(!out.value.text.includes("hmac-words-xyz"), "the storage client's words stay out of the response");
    assert.ok(out.lines.some((l) => l.includes("[forms.upload-url]") && l.includes("hmac-words-xyz")), `logged: ${out.lines.join(" | ")}`);
  });

  await check("a storage that is not set up (the client throws) is the same stable answer, not an unhandled 500", async () => {
    assert.ok(minted);
    const saved = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;
    try {
      const out = await logged(() => send(upload.POST as never, "/api/forms/upload-url", { token: minted!.token, filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1000 }));
      assert.equal(out.value.status, 500);
      assert.deepEqual(out.value.json, { ok: false, error: "sign_failed" });
      assert.ok(out.lines.some((l) => l.includes("[forms.upload-url]")), `logged: ${out.lines.join(" | ")}`);
    } finally {
      process.env.R2_ACCOUNT_ID = saved;
    }
  });

  await check("a good upload link is answered as before", async () => {
    assert.ok(minted);
    const r = await send(upload.POST as never, "/api/forms/upload-url", { token: minted!.token, filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1000 });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(Object.keys(r.json), ["ok", "storage_path", "signed_url"]);
    assert.match(String(r.json.storage_path), new RegExp(`^${OASIS}/${minted!.leadId}/\\d+_a\\.pdf$`));
    assert.match(String(r.json.signed_url), /^https:\/\/testacct\.r2\.cloudflarestorage\.com\/test-bucket\/lead-documents\/.+\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
  });

  await check("a form definition that is corrupt is refused with its stable code only: the path and reason go to the log", async () => {
    const corruptReason = /form definition invalid at/;
    // 1. an anonymous first step
    const first = await logged(() => post({ step_index: 0, anonymous_init: anon("corrupt-form"), payload: { email: "corrupt-1@example.com" } }));
    // 2. the router's all-steps request
    const routed = await logged(() => post({ step_index: 0, anonymous_init: anon("corrupt-form"), route_only: true, steps_payload: [{}] }));
    // 3. a step sent with its link, to a form that has since gone bad
    const { token } = await firstStep("owner-form", "corrupt-3@example.com");
    await seed.execute("UPDATE forms SET steps = '[{\"key\":\"x\"}]' WHERE id = 'form-owner'");
    const later = await logged(() => post({ token, step_index: 1, payload: { owner_full_name: "x" } }));
    await seed.execute({ sql: "UPDATE forms SET steps = ? WHERE id = 'form-owner'", args: [JSON.stringify(OWNER_STEPS)] });
    for (const [which, r] of [["first step", first], ["router", routed], ["later step", later]] as const) {
      assert.equal(r.value.status, 500, `${which}: ${r.value.text.slice(0, 200)}`);
      assert.deepEqual(r.value.json, { ok: false, error: "form_definition_corrupt" }, `${which}: no path, no reason`);
      assert.ok(r.lines.some((l) => corruptReason.test(l) || (/form definition corrupt/.test(l) && /"path"/.test(l))), `${which}: the detail is logged: ${r.lines.join(" | ")}`);
    }
  });

  await check("already fixed by #714, pinned: the database's own words (the step insert, the lead create) never reach the response", async () => {
    const { token } = await firstStep("merge-form", "words@example.com");
    const step = await refusingInserts("form_submissions", "fs_internal_words_xyz", () => post({ token, step_index: 0, payload: { email: "words@example.com" } }));
    assert.equal(step.value.status, 500);
    assert.equal(step.value.json.error, "server_error");
    assert.ok(!step.value.text.includes("fs_internal_words_xyz"));
    const lead = await refusingInserts("tenant_records", "lead_internal_words_xyz", () =>
      post({ step_index: 0, anonymous_init: anon("merge-form"), payload: { email: "words-new@example.com" } }),
    );
    assert.ok(lead.value.status >= 500);
    assert.ok(!lead.value.text.includes("lead_internal_words_xyz"));
  });

  // ===========================================================================
  // 5. A write that fails is not silent
  // ===========================================================================
  await check("view: a view row that did not land is logged, and the visitor's answer is the same", async () => {
    assert.ok(minted);
    // The table form_views is not in this database: the insert fails, as it would on a deployment without it.
    const first = await logged(() => send(view.POST as never, "/api/forms/view", { token: minted!.token }));
    assert.equal(first.value.status, 200);
    assert.equal(first.value.text, GOLDEN_VIEW, "the answer is unchanged");
    assert.ok(first.lines.some((l) => l.includes("[forms.view]") && /form_views/.test(l)), `logged: ${first.lines.join(" | ")}`);
    await seed.execute(
      "CREATE TABLE form_views (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), form_id TEXT, tenant_id TEXT, lead_id TEXT, ip_address TEXT, user_agent TEXT, viewed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    );
    const second = await logged(() => send(view.POST as never, "/api/forms/view", { token: minted!.token }));
    assert.equal(second.value.text, GOLDEN_VIEW);
    assert.equal(second.lines.filter((l) => l.includes("[forms.view]")).length, 0, "a view that lands logs nothing");
    assert.equal(await count("SELECT count(*) AS n FROM form_views WHERE lead_id = ?", [minted!.leadId]), 1);
    const again = await send(view.POST as never, "/api/forms/view", { token: minted!.token });
    assert.equal(again.text, GOLDEN_VIEW_AGAIN, "a second view inside the hour is answered as before");
  });

  await check("submit: the owner details that did not land on the lead are logged, and the step is still recorded", async () => {
    const { token } = await firstStep("owner-form", "owner-write@example.com");
    const before = await steps("form-owner");
    const out = await failing(isUpdateWith('"owner_name"'), () => post({ token, step_index: 1, payload: { owner_full_name: "Owner Marker" } }));
    assert.equal(out.value.status, 200, out.value.text.slice(0, 300));
    assert.equal(masked(out.value.text), GOLDEN_LAST_STEP);
    assert.equal(await steps("form-owner"), before + 1);
    assert.ok(out.lines.some((l) => l.includes("[forms.submit.owner_map.failed]")), `logged: ${out.lines.join(" | ")}`);
  });

  await check("submit: the OASIS funnel's lead enrichment that did not land is logged, and the step is still recorded", async () => {
    const before = await steps("form-start");
    const out = await failing(isUpdateWith('"instagram"'), () =>
      post({ step_index: 0, anonymous_init: anon("start"), payload: { email: "enrich@example.com", name: "Enrich", instagram: "@enrich_marker" } }),
    );
    assert.equal(out.value.status, 200, out.value.text.slice(0, 300));
    assert.equal(await steps("form-start"), before + 1);
    assert.ok(out.lines.some((l) => l.includes("[forms.submit.oasis_enrich.failed]")), `logged: ${out.lines.join(" | ")}`);
  });

  await check("submit: a returning visitor's details that did not merge into their lead are logged, and they carry on", async () => {
    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-merge-1', ?, 'lead', ?)",
      args: [OASIS, JSON.stringify({ email: "merge-fail@example.com", name: "Original", stage: "researched" })],
    });
    const out = await failing(
      (sql, args) => isUpdateWith("Merge Marker")(sql, args) && !args.some((a) => typeof a === "string" && a.includes("assigned_agent_name")),
      () => post({ step_index: 0, anonymous_init: anon("merge-form"), payload: { email: "merge-fail@example.com", name: "Merge Marker" } }),
    );
    assert.equal(out.value.status, 200, out.value.text.slice(0, 300));
    assert.ok(out.value.json.minted_token, "the visitor has their link and carries on");
    assert.ok(out.lines.some((l) => l.includes("[forms.submit.returning_lead_merge.failed]")), `logged: ${out.lines.join(" | ")}`);
  });

  await check("submit: the signer name and link that did not land on a new lead are logged, and the visitor carries on", async () => {
    await seed.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-patch-1', ?, 'lead', ?)",
      args: [OASIS, JSON.stringify({ email: "patch-fail@example.com", name: "Original", stage: "researched" })],
    });
    const out = await failing(isUpdateWith("assigned_agent_name"), () =>
      post({ step_index: 0, anonymous_init: anon("merge-form"), payload: { email: "patch-fail@example.com", name: "Patch Marker" } }),
    );
    assert.equal(out.value.status, 200, out.value.text.slice(0, 300));
    assert.ok(out.value.json.minted_token);
    assert.ok(out.lines.some((l) => l.includes("[forms.submit.lead_patch.failed]")), `logged: ${out.lines.join(" | ")}`);
  });

  // ===========================================================================
  // 6. What the visitor reads, and what is kept when a request is refused
  // ===========================================================================
  await check("a refusal for size shows the visitor a sentence and sends the failure beacon, which keeps their contact fields", async () => {
    for (const code of ["request_payload_too_large", "invalid_answers", "answer_too_large"]) {
      const copy = SUBMIT_ERROR_COPY[code];
      assert.ok(copy && copy.trim().length > 20, `${code} has a sentence`);
      assert.ok(!/_/.test(copy) && !copy.includes(String.fromCharCode(0x2014)), `${code} reads as a sentence: ${copy}`);
    }
    // Too large is the one the visitor may give up on without being told what to fix.
    assert.ok(BEACON_ERRORS.has("request_payload_too_large"));
    assert.ok(isSubmitFault(413, { error: "request_payload_too_large" }), "413 from this route is captured");
    assert.ok(isSubmitFault(413, null), "a platform 413 (no JSON) still is");
    // The two a visitor fixes on the page are the form working.
    assert.ok(!isSubmitFault(413, { error: "answer_too_large" }));
    assert.ok(!isSubmitFault(400, { error: "invalid_answers" }));
    const client = read("components/forms/FormPublicClient.tsx");
    assert.match(client, /if \(beacon && isSubmitFault\(res\.status, data\)\) \{/, "the page beacons through the shared rule");
    assert.match(read("lib/forms/submit-failure-beacon.ts"), /"request_payload_too_large",/);
  });

  await check("the failure beacon route reads through the bounded reader, not req.text(), and still stores a normal report", async () => {
    const src = read("app/api/forms/submit-failure/route.ts");
    assert.ok(!/await req\.(?:text|json|arrayBuffer)\(\)/.test(src), "the body is no longer read whole before it is measured");
    assert.match(src, /await readBoundedJson\(req, BODY_CAP_BYTES\)/);
    const stored = () => count("SELECT count(*) AS n FROM form_submit_failures WHERE source = 'client_beacon' AND payload LIKE '%beacon@example.com%'");
    const before = await stored();
    const r = await send(beacon.POST as never, "/api/forms/submit-failure", { tenant_slug: "oasis-ai-cc", form_slug: "bounded-form", step_index: 0, error: "server_error", payload: { email: "beacon@example.com" } });
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"ok":true}');
    assert.equal(await stored(), before + 1, "the report is kept with its contact fields");
  });

  finish("public-forms-bounded");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
