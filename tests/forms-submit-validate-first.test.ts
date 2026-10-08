/**
 * forms-submit-validate-first.test.ts - a rejected public-form submission never
 * creates a lead or changes one (PR #544 review, item 5, 2026-10-08).
 *
 * WHY. On a public form's first step, app/api/forms/submit/route.ts created the
 * lead (or merged the answers into a returning merchant's lead, matched by
 * email or phone) BEFORE it loaded the form and checked the step's required
 * fields. A whitespace-only phone passes the browser's `required`, the homepage
 * audit form trims it to "", and the server answered 400 missing_required_field
 * after the lead was already written: no submission and no notification to
 * show for it, a lead nobody finished, or a real lead's name and company
 * replaced. The route now judges the first step (refuseInvalidAnonymousFirstStep,
 * the same refuseInvalidStep every step is judged by) before initAnonymousLead.
 *
 * WHAT IS PINNED, through the real route against a local libSQL file:
 *   1. A NEW visitor: every rejection that judges the step (a required field of
 *      spaces, a required field left out, an incomplete address, too many files,
 *      no such form) answers its 4xx, and the workspace's leads and submissions
 *      are byte-for-byte unchanged.
 *   2. A RETURNING merchant, matched by email and matched by phone: the same
 *      rejections, with a new name and company in the payload, leave that lead
 *      byte-for-byte as it was.
 *   3. Controls: the same submissions made valid DO create the new lead and DO
 *      merge into the returning merchant's, each with its submission row, so
 *      "unchanged" above is the validation's doing, not a dead route.
 *
 * next/server's after() is the only stand-in: it needs a request scope, and the
 * background notices a valid submission schedules are not what this pins.
 *
 * Run: node --conditions=react-server --import tsx tests/forms-submit-validate-first.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { CLIENT_A, check, finish, setupDatabase } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "forms-submit-validate-first-signing-key-0123456789";

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

const FORM = "f5000000-0000-4000-8000-00000000000a";
const RETURNING_BY_EMAIL = "1eaf0000-0000-4000-8000-00000000000e";
const RETURNING_BY_PHONE = "1eaf0000-0000-4000-8000-00000000000f";
const STEPS = [
  {
    key: "contact",
    title: "Your details",
    fields: [
      { name: "name", label: "Your name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "phone", required: true },
      { name: "company", label: "Company", type: "text" },
      { name: "business_address", label: "Business address", type: "address" },
    ],
  },
];

type Json = Record<string, unknown>;

async function main() {
  const db = await setupDatabase();
  // The live forms table points at tenants; the submit route's form read embeds
  // tenants!inner(slug), which the adapter resolves through that foreign key.
  await db.executeMultiple(`
    ALTER TABLE forms RENAME TO forms_without_fk;
    CREATE TABLE forms (
      id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (id));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      publisher_agent TEXT, target_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  `);
  const leadRow = (id: string, data: Json) => ({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at) VALUES (?, ?, 'lead', ?, '2026-09-01T00:00:00.000Z')`,
    args: [id, CLIENT_A, JSON.stringify(data)],
  });
  await db.batch(
    [
      {
        sql: `INSERT INTO forms (id, tenant_id, slug, name, steps, on_complete_stage, enabled) VALUES (?, ?, 'intake', 'Intake', ?, 'researched', 1)`,
        args: [FORM, CLIENT_A, JSON.stringify(STEPS)],
      },
      leadRow(RETURNING_BY_EMAIL, { name: "Rita Returning", email: "rita@returning.test", phone: "+15550001111", company: "Rita Roofing", stage: "qualified" }),
      leadRow(RETURNING_BY_PHONE, { name: "Paul Phone", email: "paul@returning.test", phone: "+15550002222", company: "Paul Plumbing", stage: "qualified" }),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/forms/submit/route");
  let ip = 0;
  const submit = async (payload: Json, formSlug = "intake") => {
    ip += 1;
    const res = await route.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${ip}` },
        body: JSON.stringify({ step_index: 0, anonymous_init: { tenant_slug: "client-a", form_slug: formSlug }, payload }),
      }),
    );
    const text = await res.text();
    let body: Json = {};
    try {
      body = JSON.parse(text) as Json;
    } catch {
      /* the status says enough */
    }
    return { status: res.status, body, text };
  };
  const leads = async () =>
    JSON.stringify(
      (await db.execute({ sql: "SELECT id, data, updated_at FROM tenant_records WHERE tenant_id = ? ORDER BY id", args: [CLIENT_A] })).rows,
    );
  const lead = async (id: string) => {
    const row = (await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0];
    return row ? (JSON.parse(String(row.data)) as Json) : null;
  };
  const submissions = async () =>
    JSON.stringify(
      (await db.execute({ sql: "SELECT id, lead_id, step_index FROM form_submissions WHERE tenant_id = ? ORDER BY id", args: [CLIENT_A] })).rows,
    );
  const tooManyFiles = Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [
      `f${i + 1}`,
      { inline_base64: "aGk=", filename: `f${i + 1}.pdf`, mime_type: "application/pdf", size_bytes: 2 },
    ]),
  );

  console.log("forms-submit-validate-first:");

  /** Each rejection: what the visitor sent on top of `base`, and the answer. */
  const rejections = (base: Json) =>
    [
      ["a required phone of spaces", { ...base, phone: "   " }, 400, "missing_required_field"],
      ["a required email left out", Object.fromEntries(Object.entries(base).filter(([k]) => k !== "email")), 400, "missing_required_field"],
      ["an incomplete address", { ...base, business_address: "12 Main" }, 400, "incomplete_address"],
      ["eleven files on one step", { ...base, ...tooManyFiles }, 400, "too_many_files"],
    ] as const;

  await check("a new visitor: every rejected first step leaves the leads and submissions exactly as they were", async () => {
    const base = { name: "Nina New", email: "nina@new.test", phone: "+15550003333", company: "Nina Nails" };
    for (const [what, payload, status, error] of rejections(base)) {
      const [beforeLeads, beforeSubs] = [await leads(), await submissions()];
      const res = await submit(payload);
      assert.equal(res.status, status, `${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`);
      assert.equal(res.body.error, error, what);
      assert.equal(await leads(), beforeLeads, `${what}: a lead was created or changed`);
      assert.equal(await submissions(), beforeSubs, `${what}: a submission was recorded`);
    }
    const before = await leads();
    const missing = await submit(base, "no-such-form");
    assert.equal(missing.status, 404, missing.text);
    assert.equal(await leads(), before, "no such form: a lead was created");
  });

  for (const [label, id, match] of [
    ["matched by email", RETURNING_BY_EMAIL, { email: "rita@returning.test", phone: "+15550009999" }],
    ["matched by phone", RETURNING_BY_PHONE, { email: "someone-else@returning.test", phone: "+15550002222" }],
  ] as const) {
    await check(`a returning merchant ${label}: every rejected first step leaves their lead byte-for-byte as it was`, async () => {
      const base = { name: "Somebody Else", company: "Another Company", ...match };
      const original = await lead(id);
      assert.ok(original, "precondition: the returning merchant's lead exists");
      for (const [what, payload, status, error] of rejections(base)) {
        const [beforeLeads, beforeSubs] = [await leads(), await submissions()];
        const res = await submit(payload);
        assert.equal(res.status, status, `${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`);
        assert.equal(res.body.error, error, what);
        assert.deepEqual(await lead(id), original, `${what}: the returning merchant's lead was changed`);
        assert.equal(await leads(), beforeLeads, `${what}: a lead was created or changed`);
        assert.equal(await submissions(), beforeSubs, `${what}: a submission was recorded`);
      }
    });
  }

  await check("control: a valid first step from a new visitor creates the lead and its submission", async () => {
    const before = new Set(((await db.execute({ sql: "SELECT id FROM tenant_records WHERE tenant_id = ?", args: [CLIENT_A] })).rows).map((r) => String(r.id)));
    const res = await submit({ name: "Nina New", email: "nina@new.test", phone: "+15550003333", company: "Nina Nails" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const created = (await db.execute({ sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ?", args: [CLIENT_A] })).rows.filter(
      (r) => !before.has(String(r.id)),
    );
    assert.equal(created.length, 1, "exactly one new lead");
    const data = JSON.parse(String(created[0].data)) as Json;
    assert.equal(data.name, "Nina New");
    assert.equal(data.email, "nina@new.test");
    const subs = (await db.execute({ sql: "SELECT lead_id FROM form_submissions WHERE lead_id = ?", args: [String(created[0].id)] })).rows;
    assert.equal(subs.length, 1, "its submission row");
  });

  await check("control: a valid first step from a returning merchant merges into their lead, with its submission", async () => {
    const res = await submit({ name: "Rita Renamed", email: "rita@returning.test", phone: "+15550001111", company: "Rita Roofing Ltd" });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const merged = await lead(RETURNING_BY_EMAIL);
    assert.equal(merged?.name, "Rita Renamed", "the valid answers reached the existing lead");
    const subs = (await db.execute({ sql: "SELECT lead_id FROM form_submissions WHERE lead_id = ?", args: [RETURNING_BY_EMAIL] })).rows;
    assert.equal(subs.length, 1, "its submission row");
  });

  finish("forms-submit-validate-first");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
