/**
 * forms-safe.test.ts - Forms: only the people allowed to edit can change a
 * workspace's forms, another workspace's form is refused everywhere, and
 * every form's answers can be read by the people allowed to see them
 * (MKT-02, MKT-04, MKT-05, MKT-15; 2026-10-02).
 *
 * WHY. Every forms write route checked only that the caller belonged to a
 * workspace, so any member, a read-only seat included, could create, switch
 * off or delete the company's live forms and mint links for them. The editor
 * found the workspace with its own profile lookup, which failed for anyone
 * with seats in two workspaces. And no screen showed what people had sent.
 *
 * WHAT IS PINNED, with two client workspaces (A and B) and every role:
 *   1. In A, every role canEditForms refuses (member, read_only, an unknown
 *      or missing role, the legacy roles, every sales seat) gets 403 from
 *      create, change, delete, mint-link and create-from-template, and the
 *      forms table is byte-for-byte unchanged. The owner, an admin and an
 *      admin's full-access grant can do each one.
 *   2. B's owner, standing in B, gets 404 for A's form id on every route that
 *      takes one (read, change, delete, mint-link, responses, CSV, editor), and
 *      A's form is unchanged; a lead from A cannot be put in B's link.
 *   3. The Responses page and its CSV show A's answers and nothing filed
 *      under B, even a row of B's that names A's form id, to every role that
 *      opens Forms; the sales seats get 404. A signature never prints, an SSN
 *      shows its last four, a formula-looking answer opens as text in the CSV.
 *      Paging splits newest-first with no repeats.
 *   4. The Forms list hands its client canEdit for editors only, with each
 *      form's response count; the editor shows the builder only to editors and
 *      works for a member with seats in two workspaces.
 *   5. A RETIRED workspace (SunBiz, lib/tenant/retired.ts; PR #544 review,
 *      2026-10-08): its owner and its members alike get 403 workspace_closed
 *      on every write and the forms table is unchanged; its Forms page is the
 *      read-only list with the closed sentence (never the SunBiz step cards,
 *      which only offer changes); the editor says the same; its answers stay
 *      readable on the Responses page and in the CSV.
 *   6. The CSV is one stable set (same review): a response that lands between
 *      two chunk reads is neither exported twice nor allowed to push another
 *      out, at a chunk boundary inside a run of equal timestamps and at the
 *      5,000-row cap.
 *
 * Real everything against a local libSQL file (tests/_delivery-harness.ts):
 * real signed sessions, the real Turso adapter, the real route handlers and
 * pages. next/headers, next/navigation, next/link and the three client
 * components the pages mount are the only stand-ins; the CSV checks add a
 * response from inside the real adapter's own read, between two chunks.
 *
 * Run: node --conditions=react-server --import tsx tests/forms-safe.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "forms-safe-test-form-link-signing-key-0123456789";

// Pages run as server components: tsconfig's jsx:"preserve" makes tsx use the
// classic runtime (a global React); next/link stands in as a plain anchor.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
function stubPath(p: string, exports: Record<string, unknown>) {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stubPath(require.resolve("next/link"), {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
});
// The client components the pages mount: markers, so a test reads the props a
// page hands them without loading the browser half.
const FormsListMarker = Object.assign(() => null, { displayName: "FormsListClient" });
const FormBuilderMarker = Object.assign(() => null, { displayName: "FormBuilderClient" });
const SunBizFormsMarker = Object.assign(() => null, { displayName: "SunBizFormsClient" });
stubPath(join(__dirname, "..", "components", "forms", "FormsListClient.tsx"), { FormsListClient: FormsListMarker });
stubPath(join(__dirname, "..", "components", "forms", "FormBuilderClient.tsx"), { FormBuilderClient: FormBuilderMarker });
stubPath(join(__dirname, "..", "components", "forms", "SunBizFormsClient.tsx"), { SunBizFormsClient: SunBizFormsMarker });

type U = { id: string; email: string };
type RoleCase = { label: string; role: string | null; fullAccess: 0 | 1; edits: boolean; opensForms: boolean; user: U };
const seat = (n: number, slug: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email: `${slug}@client-a.test` });
const ROLES: RoleCase[] = [
  { label: "admin", role: "admin", fullAccess: 0, edits: true, opensForms: true, user: seat(1, "admin") },
  { label: "read_only with an admin's full-access grant", role: "read_only", fullAccess: 1, edits: true, opensForms: true, user: seat(2, "granted") },
  { label: "member", role: "member", fullAccess: 0, edits: false, opensForms: true, user: seat(3, "member") },
  { label: "read_only", role: "read_only", fullAccess: 0, edits: false, opensForms: true, user: seat(4, "readonly") },
  { label: "an unknown role", role: "intern", fullAccess: 0, edits: false, opensForms: true, user: seat(5, "intern") },
  { label: "no role at all", role: null, fullAccess: 0, edits: false, opensForms: true, user: seat(6, "norole") },
  { label: "loan_officer", role: "loan_officer", fullAccess: 0, edits: false, opensForms: true, user: seat(7, "loans") },
  { label: "processor", role: "processor", fullAccess: 0, edits: false, opensForms: true, user: seat(8, "processor") },
  { label: "manager", role: "manager", fullAccess: 0, edits: false, opensForms: false, user: seat(9, "manager") },
  { label: "closer", role: "closer", fullAccess: 0, edits: false, opensForms: false, user: seat(10, "closer") },
  { label: "opener", role: "opener", fullAccess: 0, edits: false, opensForms: false, user: seat(11, "opener") },
  { label: "agent", role: "agent", fullAccess: 0, edits: false, opensForms: false, user: seat(12, "agent") },
  { label: "builder", role: "builder", fullAccess: 0, edits: false, opensForms: false, user: seat(13, "builder") },
  { label: "marketing", role: "marketing", fullAccess: 0, edits: false, opensForms: false, user: seat(14, "marketing") },
];
const OWNER_A: RoleCase = { label: "owner", role: "owner", fullAccess: 0, edits: true, opensForms: true, user: USERS.clientA };
const EVERY_ROLE_IN_A = [OWNER_A, ...ROLES];
/** Seats in A (member, older) and B (owner, newer): the session stands in B. */
const TWO_SEATS: U = { id: "0e000000-0000-4000-8000-000000000099", email: "two-seats@both.test" };

const FORM_A = "f0a00000-0000-4000-8000-00000000000a";
const FORM_B = "f0b00000-0000-4000-8000-00000000000b";
const FORM_PAGED = "f0c00000-0000-4000-8000-00000000000c";
const FORM_OASIS = "f0d00000-0000-4000-8000-00000000000d";
const LEAD_A = "1ead0000-0000-4000-8000-00000000000a";
const LEAD_B = "1ead0000-0000-4000-8000-00000000000b";
const LEAD_OASIS = "1ead0000-0000-4000-8000-00000000000d";
const LEAD_GONE = "1ead0000-0000-4000-8000-0000000000ff";
/** The retired workspace (SunBiz): its owner and a member, its one form. */
const SUN_OWNER: U = { id: "0e000000-0000-4000-8000-0000000000a1", email: "owner@sun.test" };
const SUN_MEMBER: U = { id: "0e000000-0000-4000-8000-0000000000a2", email: "member@sun.test" };
const FORM_SUN = "f0e00000-0000-4000-8000-00000000000e";
const LEAD_SUN = "1ead0000-0000-4000-8000-00000000000e";
/** A workspace of its own for the CSV checks, so no other list moves. */
const CLIENT_C = "cccccccc-0000-4000-8000-00000000000c";
const FORM_CSV_BOUNDARY = "f0f00000-0000-4000-8000-0000000000c1";
const FORM_CSV_CAP = "f0f00000-0000-4000-8000-0000000000c2";

const STEPS = JSON.stringify([
  {
    key: "contact",
    title: "Contact",
    fields: [
      { name: "name", label: "Your name", type: "text" },
      { name: "email", label: "Email", type: "email" },
      { name: "owner_ssn", label: "SSN", type: "text" },
      { name: "signature", label: "Signature", type: "signature" },
    ],
  },
  {
    key: "project",
    title: "Project",
    fields: [
      { name: "budget", label: "Budget", type: "select", options: [{ value: "5k", label: "About $5,000" }] },
      { name: "plans", label: "Plans", type: "file_upload_multi" },
    ],
  },
]);
const VALID_STEPS = [{ key: "contact", title: "Contact", fields: [{ name: "email", label: "Email", type: "email" }] }];
const FORMULA = '=HYPERLINK("http://evil.test")';

type Json = Record<string, unknown>;

/** Every string in an element tree, plain function components rendered (os-customers.test.ts). */
function textOf(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) textOf(v, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (typeof el.type === "function") {
      try {
        const rendered = (el.type as (p: unknown) => unknown)(el.props);
        if (!(rendered instanceof Promise)) textOf(rendered, out, seen);
      } catch {
        /* a component with hooks: its props below are what ships */
      }
    }
    textOf(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) textOf(v, out, seen);
  return out;
}

/** The props of the first element of `type` in a tree. */
function propsOf(node: unknown, type: unknown, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = propsOf(v, type, seen);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (el.type === type) return el.props;
    return propsOf(el.props, type, seen);
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = propsOf(v, type, seen);
    if (hit) return hit;
  }
  return null;
}

async function outcome(run: () => unknown): Promise<"404" | `redirect:${string}` | { tree: unknown }> {
  try {
    return { tree: await run() };
  } catch (err) {
    const msg = (err as Error).message;
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test(msg)) return "404";
    const r = /^NEXT_REDIRECT;(.*)$/.exec(msg);
    if (r) return `redirect:${r[1]}`;
    throw err;
  }
}

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
  `);
  // A provisioned workspace for each client, so the rail draws Forms there.
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  for (const [id, tenant, slug] of [["m-a", CLIENT_A, "client-a"], ["m-b", CLIENT_B, "client-b"]] as const) {
    await db.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, JSON.stringify(parseManifest(finalizeManifestFromWizard({ template: "custom", slug, answers: {} })))],
    });
  }
  const profile = (id: string, u: U, tenant: string, role: string | null, owner: 0 | 1, fullAccess: 0 | 1, updated: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, full_name, joined_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [id, u.id, u.email, tenant, role, owner, fullAccess, u.email.split("@")[0], updated],
  });
  const form = (id: string, tenant: string, slug: string, name: string) => ({
    sql: `INSERT INTO forms (id, tenant_id, slug, name, branding, steps, step_outcomes, enabled) VALUES (?, ?, ?, ?, '{}', ?, '{}', 1)`,
    args: [id, tenant, slug, name, STEPS],
  });
  const submission = (id: string, formId: string, tenant: string, lead: string, step: number, payload: Json, at: string) => ({
    sql: `INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, formId, tenant, lead, step, JSON.stringify(payload), at],
  });
  const lead = (id: string, tenant: string, name: string) => ({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)`,
    args: [id, tenant, JSON.stringify({ name })],
  });
  await db.batch(
    [
      ...ROLES.map((r) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [r.user.id, r.user.email] })),
      ...ROLES.map((r, i) => profile(`p-role-${i}`, r.user, CLIENT_A, r.role, 0, r.fullAccess, "2026-09-01T00:00:00Z")),
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [TWO_SEATS.id, TWO_SEATS.email] },
      profile("p-two-a", TWO_SEATS, CLIENT_A, "member", 0, 0, "2026-09-01T00:00:00Z"),
      profile("p-two-b", TWO_SEATS, CLIENT_B, "owner", 1, 0, "2026-09-15T00:00:00Z"),
      form(FORM_A, CLIENT_A, "intake", "Intake"),
      form(FORM_B, CLIENT_B, "intake", "B Intake"),
      form(FORM_PAGED, CLIENT_A, "many", "Many answers"),
      form(FORM_OASIS, OASIS, "audit-test", "Audit test"),
      lead(LEAD_A, CLIENT_A, "Alice Lead"),
      lead(LEAD_B, CLIENT_B, "Bob Lead"),
      lead(LEAD_OASIS, OASIS, "Olive Lead"),
      submission("s-a1", FORM_A, CLIENT_A, LEAD_A, 0, {
        name: "Alice Answer",
        email: "alice@a.test",
        owner_ssn: "123-45-6789",
        signature: "data:image/png;base64,iVBORw0KGgoAAAA",
        note_extra: FORMULA,
      }, "2026-09-02T10:00:00.000Z"),
      submission("s-a2", FORM_A, CLIENT_A, LEAD_A, 1, {
        budget: "5k",
        plans: [{ filename: "plan.pdf", storage_path: `${CLIENT_A}/${LEAD_A}/plan.pdf` }],
      }, "2026-09-03T10:00:00.000Z"),
      submission("s-b1", FORM_B, CLIENT_B, LEAD_B, 0, { name: "Bob Secret", email: "bob@b.test" }, "2026-09-04T10:00:00.000Z"),
      // Filed under B but naming A's form id: never one of A's answers.
      submission("s-x1", FORM_A, CLIENT_B, LEAD_B, 0, { name: "Mallory Smuggled" }, "2026-09-05T10:00:00.000Z"),
      submission("s-o1", FORM_OASIS, OASIS, LEAD_OASIS, 0, { name: "Olive Answer" }, "2026-09-06T10:00:00.000Z"),
      submission("s-o2", FORM_OASIS, OASIS, LEAD_GONE, 0, { name: "Gone Answer" }, "2026-09-07T10:00:00.000Z"),
      ...Array.from({ length: 27 }, (_, i) =>
        submission(
          `s-p${String(i + 1).padStart(2, "0")}`,
          FORM_PAGED,
          CLIENT_A,
          LEAD_A,
          0,
          { name: `Paged ${i + 1}` },
          `2026-09-10T10:${String(i).padStart(2, "0")}:00.000Z`,
        ),
      ),
    ],
    "write",
  );
  // The retired workspace, provisioned the way SunBiz was (tenant row
  // "submissions", profile slug "sun", a stored manifest) so its Forms page is
  // reachable at all; and a workspace for the CSV checks with two big forms.
  const { SUNBIZ_RETIRED_TENANT_ID: SUN } = await import("../lib/tenant/retired");
  await db.batch(
    [
      {
        sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'submissions', 'SunBiz Funding', ?)",
        args: [SUN, JSON.stringify({ command_center_profile_slug: "sun" })],
      },
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-sun', ?, 'sun', ?, 1, 1, '2026-01-01', '2026-01-01')",
        args: [SUN, JSON.stringify(parseManifest(finalizeManifestFromWizard({ template: "custom", slug: "sun", answers: {} })))],
      },
      ...[SUN_OWNER, SUN_MEMBER].map((u) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] })),
      profile("p-sun-owner", SUN_OWNER, SUN, "owner", 1, 0, "2026-09-01T00:00:00Z"),
      profile("p-sun-member", SUN_MEMBER, SUN, "member", 0, 0, "2026-09-01T00:00:00Z"),
      form(FORM_SUN, SUN, "initial-lead-capture", "Initial Lead Capture"),
      lead(LEAD_SUN, SUN, "Sunny Lead"),
      submission("s-sun1", FORM_SUN, SUN, LEAD_SUN, 0, { name: "Sunny Answer", email: "sunny@sun.test" }, "2026-09-08T10:00:00.000Z"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-c', 'Client C Exports')", args: [CLIENT_C] },
      form(FORM_CSV_BOUNDARY, CLIENT_C, "boundary", "Boundary"),
      form(FORM_CSV_CAP, CLIENT_C, "capped", "Capped"),
    ],
    "write",
  );
  // Seven answers to each second: a 500-row chunk then ends inside a run of
  // equal timestamps, which only the (submitted_at, id) cursor gets right.
  for (const [formId, prefix, count] of [[FORM_CSV_BOUNDARY, "csv-b", 1230], [FORM_CSV_CAP, "csv-c", 5050]] as const) {
    await db.execute({
      sql: `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
            INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, submitted_at)
            SELECT printf('%s-%05d', ?, i), ?, ?, 'lead-csv', 0, json_object('name', 'Row ' || i),
                   strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01 00:00:00', '+' || (i / 7) || ' seconds')
            FROM seq`,
      args: [count - 1, prefix, formId, CLIENT_C],
    });
  }

  const { NextRequest } = await import("next/server");
  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
  const call = async (p: Promise<Response> | Response) => {
    const res = await p;
    const text = await res.text();
    let body: Json = {};
    try {
      body = JSON.parse(text) as Json;
    } catch {
      /* the CSV */
    }
    return { status: res.status, body, text, type: res.headers.get("content-type") || "" };
  };
  const formsTable = async () =>
    JSON.stringify(
      (
        await db.execute(
          "SELECT id, tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes, enabled, redirect_url, created_by, updated_at FROM forms ORDER BY id",
        )
      ).rows,
    );

  const listRoute = await import("../app/api/forms/route");
  const formRoute = await import("../app/api/forms/[id]/route");
  const mintRoute = await import("../app/api/forms/[id]/mint-link/route");
  const templateRoute = await import("../app/api/forms/templates/sunbiz/[step]/route");
  const csvRoute = await import("../app/api/forms/[id]/responses/route");
  const formsPage = (await import("../app/forms/page")).default;
  const editPage = (await import("../app/forms/[id]/edit/page")).default;
  const responsesPage = (await import("../app/forms/[id]/responses/page")).default;
  const access = await import("../lib/forms/access");

  /** Every forms write route, as one role would call it against A's form. */
  const writes = (formId: string) =>
    [
      ["create", () => listRoute.POST(req("POST", "/api/forms", { slug: "made-by-anyone", name: "Made", steps: VALID_STEPS }))],
      ["change", () => formRoute.PATCH(req("PATCH", `/api/forms/${formId}`, { name: "Hijacked", enabled: false }), params({ id: formId }))],
      ["delete", () => formRoute.DELETE(req("DELETE", `/api/forms/${formId}`), params({ id: formId }))],
      ["mint a link", () => mintRoute.POST(req("POST", `/api/forms/${formId}/mint-link`, { lead_id: LEAD_A }), params({ id: formId }))],
      ["create from a template", () => templateRoute.POST(req("POST", "/api/forms/templates/sunbiz/initial-lead-capture"), params({ step: "initial-lead-capture" }))],
    ] as const;

  console.log("forms-safe:");

  // ── 1. only editors write ─────────────────────────────────────────────────
  for (const r of EVERY_ROLE_IN_A.filter((x) => !x.edits)) {
    await check(`${r.label} in A: refused (403) on create, change, delete, mint-link and template; the forms are unchanged`, async () => {
      await login(r.user);
      const before = await formsTable();
      for (const [what, run] of writes(FORM_A)) {
        const res = await call(run());
        assert.equal(res.status, 403, `${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`);
        assert.equal(res.body.error, "forbidden", what);
        assert.equal(res.body.message, access.FORMS_EDIT_REFUSED, `${what} names who may change forms`);
      }
      assert.equal(await formsTable(), before, "a refused write changed the forms table");
    });
  }

  for (const r of EVERY_ROLE_IN_A.filter((x) => x.edits)) {
    await check(`${r.label} in A: creates, changes, deletes, mints a link and creates from a template`, async () => {
      await login(r.user);
      const before = await formsTable();
      const created = await call(listRoute.POST(req("POST", "/api/forms", { slug: "made-by-editor", name: "Made", steps: VALID_STEPS })));
      assert.equal(created.status, 200, created.text);
      const createdForm = created.body.form as { id: string; tenant_id: string; created_by: string };
      assert.equal(createdForm.tenant_id, CLIENT_A, "filed in the session's workspace");
      assert.equal(createdForm.created_by, r.user.id);
      const renamed = await call(formRoute.PATCH(req("PATCH", `/api/forms/${createdForm.id}`, { name: "Renamed" }), params({ id: createdForm.id })));
      assert.equal(renamed.status, 200, renamed.text);
      assert.equal((renamed.body.form as { name: string }).name, "Renamed");
      const minted = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_A}/mint-link`, { lead_id: LEAD_A }), params({ id: FORM_A })));
      assert.equal(minted.status, 200, minted.text);
      assert.match(String(minted.body.url), /\/f\/client-a\/intake\/v\d\./, "a signed link to A's form");
      const removed = await call(formRoute.DELETE(req("DELETE", `/api/forms/${createdForm.id}`), params({ id: createdForm.id })));
      assert.equal(removed.status, 200, removed.text);
      const templated = await call(templateRoute.POST(req("POST", "/api/forms/templates/sunbiz/initial-lead-capture"), params({ step: "initial-lead-capture" })));
      assert.equal(templated.status, 200, templated.text);
      const templateId = String(templated.body.form_id);
      const tenantOf = await db.execute({ sql: "SELECT tenant_id FROM forms WHERE id = ?", args: [templateId] });
      assert.equal(tenantOf.rows[0]?.tenant_id, CLIENT_A);
      assert.equal((await call(formRoute.DELETE(req("DELETE", `/api/forms/${templateId}`), params({ id: templateId })))).status, 200);
      assert.equal(await formsTable(), before, "the editor's round trip left a form behind");
    });
  }

  await check("signed out: 401 on every forms write route", async () => {
    await login(null);
    for (const [what, run] of writes(FORM_A)) assert.equal((await call(run())).status, 401, what);
  });

  // ── 2. another workspace's form id is refused on every route ──────────────
  await check("B's owner, given A's form id: 404 on read, change, delete and mint-link; A's form unchanged", async () => {
    await login(USERS.clientB);
    const before = await formsTable();
    const read = await call(formRoute.GET(req("GET", `/api/forms/${FORM_A}`), params({ id: FORM_A })));
    assert.equal(read.status, 404, read.text);
    assert.doesNotMatch(read.text, /Intake|client-a/);
    const changed = await call(formRoute.PATCH(req("PATCH", `/api/forms/${FORM_A}`, { name: "Taken over" }), params({ id: FORM_A })));
    assert.equal(changed.status, 404, changed.text);
    const deleted = await call(formRoute.DELETE(req("DELETE", `/api/forms/${FORM_A}`), params({ id: FORM_A })));
    assert.equal(deleted.status, 404, deleted.text);
    const minted = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_A}/mint-link`, { lead_id: LEAD_A }), params({ id: FORM_A })));
    assert.equal(minted.status, 404, minted.text);
    assert.equal(await formsTable(), before, "B changed A's form");
    const list = await call(listRoute.GET());
    assert.equal(list.status, 200);
    assert.deepEqual((list.body.forms as Array<{ id: string }>).map((f) => f.id), [FORM_B], "B's list holds only B's forms");
  });

  await check("B's owner cannot put A's lead in B's own link (lead_not_found)", async () => {
    await login(USERS.clientB);
    const minted = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_B}/mint-link`, { lead_id: LEAD_A }), params({ id: FORM_B })));
    assert.equal(minted.status, 404, minted.text);
    assert.equal(minted.body.error, "lead_not_found");
    const own = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_B}/mint-link`, { lead_id: LEAD_B }), params({ id: FORM_B })));
    assert.equal(own.status, 200, own.text);
  });

  await check("B's owner, given A's form id: the Responses page, its CSV and the editor answer 404", async () => {
    await login(USERS.clientB);
    assert.equal(await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_A }), searchParams: Promise.resolve({}) })), "404");
    const csv = await call(csvRoute.GET(req("GET", `/api/forms/${FORM_A}/responses`), params({ id: FORM_A })));
    assert.equal(csv.status, 404, csv.text.slice(0, 200));
    assert.doesNotMatch(csv.text, /Alice|Mallory/);
    assert.equal(await outcome(() => editPage({ params: Promise.resolve({ id: FORM_A }) })), "404");
  });

  // ── 3. the answers, for the people allowed to see them ────────────────────
  const A_ANSWERS = ["Alice Answer", "alice@a.test", "Signed", "ends in 6789", "1 file: plan.pdf", "About $5,000", "Alice Lead", "Step 1 of 2: Contact", "Step 2 of 2: Project", FORMULA];
  const NEVER_ON_A = ["Mallory", "Bob", "123-45-6789", "data:image", "iVBORw0KGgo"];
  for (const r of EVERY_ROLE_IN_A) {
    await check(`${r.label} in A: Responses page ${r.opensForms ? "shows A's answers and nothing of B's" : "answers 404"}`, async () => {
      await login(r.user);
      const got = await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_A }), searchParams: Promise.resolve({}) }));
      if (!r.opensForms) {
        assert.equal(got, "404", `${r.label} read A's answers`);
        return;
      }
      assert.ok(typeof got === "object", `${r.label}: ${String(got)}`);
      const text = textOf(got.tree).join("\n");
      for (const s of A_ANSWERS) assert.ok(text.includes(s), `missing "${s}"`);
      for (const s of NEVER_ON_A) assert.ok(!text.includes(s), `"${s}" is on A's Responses page`);
      assert.match(text, /2 responses, newest first/);
      // Newest first: the step-2 row (09-03) before the step-1 row (09-02).
      assert.ok(text.indexOf("Step 2 of 2: Project") < text.indexOf("Step 1 of 2: Contact"));
    });
  }

  for (const r of EVERY_ROLE_IN_A) {
    await check(`${r.label} in A: CSV download ${r.opensForms ? "holds A's answers only, formulas defused" : "answers 404"}`, async () => {
      await login(r.user);
      const csv = await call(csvRoute.GET(req("GET", `/api/forms/${FORM_A}/responses`), params({ id: FORM_A })));
      if (!r.opensForms) {
        assert.equal(csv.status, 404, `${r.label} downloaded A's answers`);
        assert.doesNotMatch(csv.text, /Alice/);
        return;
      }
      assert.equal(csv.status, 200, csv.text.slice(0, 200));
      assert.match(csv.type, /^text\/csv/);
      const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
      assert.equal(lines.length, 3, "a header and A's two rows");
      for (const h of ["Submitted at (UTC)", "Step", "Lead", "Your name", "Email", "SSN", "Signature", "Budget", "Plans", "note_extra"]) {
        assert.ok(lines[0].includes(`"${h}"`), `header lacks ${h}`);
      }
      assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil.test"")"`), "a formula-looking answer is prefixed so it opens as text");
      assert.ok(!csv.text.includes(`"=HYPERLINK`), "an answer would run as a formula");
      for (const s of ["Alice Answer", "ends in 6789", "Signed", "1 file: plan.pdf", "Alice Lead", "2026-09-02T10:00:00.000Z"]) {
        assert.ok(csv.text.includes(s), `CSV lacks ${s}`);
      }
      for (const s of NEVER_ON_A) assert.ok(!csv.text.includes(s), `"${s}" is in A's CSV`);
    });
  }

  await check("signed out: the Responses page and the CSV refuse", async () => {
    await login(null);
    assert.equal(await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_A }), searchParams: Promise.resolve({}) })), "404");
    assert.equal((await call(csvRoute.GET(req("GET", `/api/forms/${FORM_A}/responses`), params({ id: FORM_A })))).status, 401);
  });

  await check("Responses paging: 27 answers split 25 + 2, newest first, no repeats", async () => {
    await login(USERS.clientA);
    const pageText = async (page: string) => {
      const got = await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_PAGED }), searchParams: Promise.resolve({ page }) }));
      assert.ok(typeof got === "object");
      return textOf(got.tree).join("\n");
    };
    const names = (text: string) => [...text.matchAll(/^Paged (\d+)$/gm)].map((m) => Number(m[1]));
    const one = await pageText("1");
    const two = await pageText("2");
    assert.match(one, /27 responses, newest first/);
    assert.match(one, /Page 1 of 2/);
    assert.deepEqual(names(one), Array.from({ length: 25 }, (_, i) => 27 - i));
    assert.deepEqual(names(two), [2, 1]);
  });

  await check("OASIS's own workspace: a lead opens on the Pipeline; a lead no longer on file says so", async () => {
    await login(USERS.cc);
    const got = await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_OASIS }), searchParams: Promise.resolve({}) }));
    assert.ok(typeof got === "object", String(got));
    const strings = textOf(got.tree);
    assert.ok(strings.includes("Olive Lead") && strings.includes("Lead no longer on file"), strings.join(" | "));
    assert.ok(strings.includes(`/pipeline/${LEAD_OASIS}`), "OASIS's lead links to its lead page");
    assert.ok(!strings.includes(`/pipeline/${LEAD_GONE}`), "a lead no longer on file is linked");
    // In a client workspace the lead is named, not linked (no lead page there).
    await login(USERS.clientA);
    const client = await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_A }), searchParams: Promise.resolve({}) }));
    assert.ok(typeof client === "object");
    const clientStrings = textOf(client.tree);
    assert.ok(clientStrings.includes("Alice Lead"), "the client's lead is named");
    assert.ok(!clientStrings.some((s) => s.startsWith("/pipeline/")), "a client's lead links to a page its workspace does not have");
  });

  await check("a viewer whose rail draws Forms but who may not see every lead cannot read answers", () => {
    const navInput = { persona: "worker", capabilities: undefined, isOperator: false, tenantSlug: "client-a", isOasisTenant: false, modules: [], provisioned: true, founders: null };
    const allowed = { navInput, surface: { capabilities: { canSeeAllPipeline: true } } } as unknown as Parameters<typeof access.mayReadFormResponses>[0];
    const narrowed = { navInput, surface: { capabilities: { canSeeAllPipeline: false } } } as unknown as Parameters<typeof access.mayReadFormResponses>[0];
    assert.equal(access.mayReadFormResponses(allowed), true, "precondition: the rail draws Forms for this viewer");
    assert.equal(access.mayReadFormResponses(narrowed), false);
  });

  await check("canEditForms: founders only, among every persona, and nobody in a retired workspace", () => {
    const personas = ["founder", "manager", "sales", "marketing", "builder", "worker", "readonly", "legacy"] as const;
    assert.deepEqual(personas.filter((p) => access.canEditForms({ persona: p, tenantId: CLIENT_A })), ["founder"]);
    assert.deepEqual(personas.filter((p) => access.canEditForms({ persona: p, tenantId: SUN })), []);
    assert.deepEqual(access.formsEditRefusal({ persona: "founder", tenantId: SUN }), {
      error: "workspace_closed",
      message: access.FORMS_WORKSPACE_CLOSED,
    });
    assert.deepEqual(access.formsEditRefusal({ persona: "worker", tenantId: CLIENT_A }), {
      error: "forbidden",
      message: access.FORMS_EDIT_REFUSED,
    });
  });

  // ── 4. the list and the editor ────────────────────────────────────────────
  for (const r of EVERY_ROLE_IN_A) {
    await check(`${r.label} in A: Forms list ${r.opensForms ? `canEdit=${r.edits}, with A's counts` : "answers 404"}`, async () => {
      await login(r.user);
      const got = await outcome(() => formsPage());
      if (!r.opensForms) {
        assert.equal(got, "404");
        return;
      }
      assert.ok(typeof got === "object");
      const props = propsOf(got.tree, FormsListMarker) as { canEdit: boolean; responseCounts: Record<string, number | null>; initialRows: Array<{ id: string }> } | null;
      assert.ok(props, "the list is mounted");
      assert.equal(props.canEdit, r.edits);
      assert.deepEqual(props.initialRows.map((f) => f.id).sort(), [FORM_A, FORM_PAGED].sort(), "A's forms only");
      // Two of A's own rows; B's row that names A's form id is not counted.
      assert.deepEqual(props.responseCounts, { [FORM_A]: 2, [FORM_PAGED]: 27 });
      assert.doesNotMatch(textOf(got.tree).join("\n"), /personalized lead links/i, "the subtitle still promises personalized links");
    });
  }

  for (const r of EVERY_ROLE_IN_A.filter((x) => x.opensForms)) {
    await check(`${r.label} in A: the editor ${r.edits ? "opens the builder" : "says who may change forms and links the answers"}`, async () => {
      await login(r.user);
      const got = await outcome(() => editPage({ params: Promise.resolve({ id: FORM_A }) }));
      assert.ok(typeof got === "object", String(got));
      const builder = propsOf(got.tree, FormBuilderMarker) as { initialForm: { id: string } } | null;
      if (r.edits) {
        assert.equal(builder?.initialForm.id, FORM_A);
        return;
      }
      assert.equal(builder, null, `${r.label} was handed the builder`);
      const strings = textOf(got.tree);
      assert.ok(strings.includes(access.FORMS_EDIT_REFUSED));
      assert.ok(strings.includes(`/forms/${FORM_A}/responses`), "no way to the answers");
    });
  }

  await check("a member with seats in two workspaces: the editor opens the form of the workspace the session stands in, and only that one", async () => {
    await login(TWO_SEATS);
    const own = await outcome(() => editPage({ params: Promise.resolve({ id: FORM_B }) }));
    assert.ok(typeof own === "object", `the editor answered ${String(own)} for the active workspace's form`);
    assert.equal((propsOf(own.tree, FormBuilderMarker) as { initialForm: { id: string } } | null)?.initialForm.id, FORM_B);
    assert.equal(await outcome(() => editPage({ params: Promise.resolve({ id: FORM_A }) })), "404", "the other seat's form opened");
    const minted = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_B}/mint-link`, { lead_id: LEAD_B }), params({ id: FORM_B })));
    assert.equal(minted.status, 200, `mint-link for a two-seat owner: ${minted.text}`);
  });

  // ── 5. a retired workspace is read-only for everyone ──────────────────────
  for (const [label, user] of [["its owner", SUN_OWNER], ["a member", SUN_MEMBER]] as const) {
    await check(`retired workspace, ${label}: every forms write answers 403 workspace_closed and the forms are unchanged`, async () => {
      await login(user);
      const before = await formsTable();
      for (const [what, run] of writes(FORM_SUN)) {
        const res = await call(run());
        assert.equal(res.status, 403, `${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`);
        assert.equal(res.body.error, "workspace_closed", what);
        assert.equal(res.body.message, access.FORMS_WORKSPACE_CLOSED, `${what} says the workspace is closed`);
      }
      assert.equal(await formsTable(), before, "a write landed in a retired workspace");
    });

    await check(`retired workspace, ${label}: the Forms page is the read-only list with the closed sentence, never the SunBiz step cards`, async () => {
      await login(user);
      const got = await outcome(() => formsPage());
      assert.ok(typeof got === "object", `the page answered ${String(got)}`);
      assert.equal(propsOf(got.tree, SunBizFormsMarker), null, "the SunBiz step cards (Create from template, editor) were mounted");
      const props = propsOf(got.tree, FormsListMarker) as {
        canEdit: boolean;
        readOnlyNote?: string;
        responseCounts: Record<string, number | null>;
        initialRows: Array<{ id: string }>;
      } | null;
      assert.ok(props, "the read-only list is mounted");
      assert.equal(props.canEdit, false);
      assert.equal(props.readOnlyNote, access.FORMS_WORKSPACE_CLOSED);
      assert.deepEqual(props.initialRows.map((f) => f.id), [FORM_SUN]);
      assert.deepEqual(props.responseCounts, { [FORM_SUN]: 1 }, "its answers are counted and linked");
    });
  }

  await check("retired workspace: the editor tells its owner the workspace is closed and links the answers, with no builder", async () => {
    await login(SUN_OWNER);
    const got = await outcome(() => editPage({ params: Promise.resolve({ id: FORM_SUN }) }));
    assert.ok(typeof got === "object", String(got));
    assert.equal(propsOf(got.tree, FormBuilderMarker), null, "the owner of a retired workspace was handed the builder");
    const strings = textOf(got.tree);
    assert.ok(strings.includes(access.FORMS_WORKSPACE_CLOSED));
    assert.ok(strings.includes(`/forms/${FORM_SUN}/responses`), "no way to the answers");
  });

  await check("retired workspace: its owner still reads the answers, on the Responses page and in the CSV", async () => {
    await login(SUN_OWNER);
    const got = await outcome(() => responsesPage({ params: Promise.resolve({ id: FORM_SUN }), searchParams: Promise.resolve({}) }));
    assert.ok(typeof got === "object", String(got));
    const text = textOf(got.tree).join("\n");
    assert.ok(text.includes("Sunny Answer") && text.includes("Sunny Lead"), text.slice(0, 400));
    const csv = await call(csvRoute.GET(req("GET", `/api/forms/${FORM_SUN}/responses`), params({ id: FORM_SUN })));
    assert.equal(csv.status, 200, csv.text.slice(0, 200));
    assert.ok(csv.text.includes("Sunny Answer"));
  });

  // ── 6. the CSV is one stable set ───────────────────────────────────────────
  const { answerText, loadResponsesForExport, loadResponsesForm, RESPONSES_EXPORT_LIMIT } = await import("../lib/forms/responses");

  await check("a sensitive answer never prints: a card code or password not at all, a list, file or object under a sensitive name not at all, a number only its last four", () => {
    assert.equal(answerText("owner_ssn", undefined, "123-45-6789"), "ends in 6789");
    assert.equal(answerText("tax_id", undefined, 987654321), "ends in 4321");
    assert.equal(answerText("owner_ssn", undefined, ["123-45-6789"]), "Hidden");
    assert.equal(answerText("account_number", undefined, { value: "000123456789" }), "Hidden");
    assert.equal(answerText("ssn_card", undefined, { filename: "ssn-123-45-6789.pdf" }), "Hidden");
    assert.equal(answerText("password", undefined, "hunter2secret"), "Hidden");
    assert.equal(answerText("card_cvv", undefined, "12345"), "Hidden");
    assert.equal(answerText("owner_ssn", undefined, "   "), "");
    // An ordinary answer is untouched.
    assert.equal(answerText("notes", undefined, ["a", "b"]), "a, b");
    assert.equal(answerText("plans", undefined, { filename: "plan.pdf" }), "1 file: plan.pdf");
  });
  const { getServiceSupabase } = await import("../lib/supabase-server");
  type Db = ReturnType<typeof getServiceSupabase>;
  /**
   * The real adapter, except that every read of form_submissions, once it has
   * answered, lets `afterRead` write before the export's next read: a public
   * submission landing between two chunks.
   */
  const insertingBetweenReads = (afterRead: (n: number) => Promise<void>): Db => {
    const real = getServiceSupabase();
    let reads = 0;
    const wrap = (builder: object): object => {
      const proxy: object = new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              (target as PromiseLike<unknown>)
                .then(async (out) => {
                  reads += 1;
                  await afterRead(reads);
                  return out;
                })
                .then(onOk, onErr);
          }
          const value = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            return result === target ? proxy : result;
          };
        },
      });
      return proxy;
    };
    return new Proxy(real as object, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "from") {
          return (table: string) => {
            const builder = (value as (t: string) => object).call(target, table);
            return table === "form_submissions" ? wrap(builder) : builder;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Db;
  };
  let lateAnswers = 0;
  const lateAnswer = (formId: string) =>
    db.execute({
      sql: `INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, submitted_at)
            VALUES (?, ?, ?, 'lead-late', 0, '{"name":"Late"}', ?)`,
      args: [`late-${String(++lateAnswers).padStart(3, "0")}`, formId, CLIENT_C, `2026-12-01T00:00:${String(lateAnswers % 60).padStart(2, "0")}.000Z`],
    });
  /** The rows the export must hold, read in one statement before it starts. */
  const snapshot = async (formId: string) =>
    (
      await db.execute({
        sql: "SELECT id FROM form_submissions WHERE tenant_id = ? AND form_id = ? ORDER BY submitted_at DESC, id DESC LIMIT ?",
        args: [CLIENT_C, formId, RESPONSES_EXPORT_LIMIT],
      })
    ).rows.map((r) => String(r.id));

  await check("CSV export: an answer landing between two chunk reads is not exported, and every answer that was there is, once, in order", async () => {
    const expected = await snapshot(FORM_CSV_BOUNDARY);
    assert.equal(expected.length, 1230, "precondition: three chunks of rows");
    const form = await loadResponsesForm(getServiceSupabase(), CLIENT_C, FORM_CSV_BOUNDARY);
    assert.ok(form);
    const { rows } = await loadResponsesForExport(
      insertingBetweenReads(async (n) => {
        if (n === 1) await lateAnswer(FORM_CSV_BOUNDARY);
      }),
      { tenantId: CLIENT_C, form },
    );
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `exported twice: ${ids.filter((id, i) => ids.indexOf(id) !== i).slice(0, 5).join(", ")}`);
    assert.deepEqual(ids, expected, "the export is not the set that was there when it began, newest first");
  });

  await check("CSV export at the 5,000 cap: with an answer landing after every read, it is exactly the newest 5,000 there when it began", async () => {
    const expected = await snapshot(FORM_CSV_CAP);
    assert.equal(expected.length, RESPONSES_EXPORT_LIMIT, "precondition: more answers than the cap");
    const form = await loadResponsesForm(getServiceSupabase(), CLIENT_C, FORM_CSV_CAP);
    assert.ok(form);
    const { rows } = await loadResponsesForExport(
      insertingBetweenReads(async () => {
        await lateAnswer(FORM_CSV_CAP);
      }),
      { tenantId: CLIENT_C, form },
    );
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "an answer was exported twice");
    assert.deepEqual(ids, expected, "an answer that belonged in the file was pushed out, or a late one let in");
  });

  finish("forms-safe");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
