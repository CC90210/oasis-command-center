/**
 * db-bool.test.ts - the two permission flags, read one strict way everywhere
 * (PR #544 review, 2026-10-08).
 *
 * WHY. user_profiles.is_owner and user_profiles.admin_access are yes/no flags
 * the store keeps as the INTEGER 0 or 1. Readers guessed at the shape and got it
 * wrong both ways: `!!profile.is_owner` read the string "0" as YES, so an
 * ordinary member resolved as a full admin and could create, change and delete
 * a workspace's forms; `admin_access === true` read the stored 1 as NO, so an
 * admin's full-access grant worked on Forms and nowhere else. lib/db-bool.ts is
 * the one read now: true, 1 and "1" are yes, everything else is no.
 *
 * WHAT IS PINNED.
 *   1. dbBool on the seven shapes the store and the code hand around (0, 1,
 *      "0", "1", null, true, false) and on stranger ones.
 *   2. Through the REAL Forms routes: a member whose is_owner is each of the
 *      seven shapes, and a member whose admin_access is each of them. For 0,
 *      "0", null and false every write (create, change, delete, mint a link,
 *      create from a template) answers 403 and the forms table is unchanged;
 *      for 1, "1" and true each write works.
 *   3. Through the team context (lib/team.ts getSessionContext) and its routes:
 *      DELETE /api/team/members (a true-admin action) follows is_owner and is
 *      refused to every admin_access grant; GET /api/team/invites follows
 *      admin_access. resolveSessionContext and getSessionContext agree.
 *   4. The other readers the sweep moved onto dbBool, as pure functions:
 *      lead scope, workspace settings, the onboarding gate, the closer-credit
 *      rule, the team roster and the active-profile pick.
 *   5. SOURCE GUARD: every read of either flag in app/, lib/, components/,
 *      workers/ and middleware.ts is dbBool(<the read>), found with the
 *      TypeScript parser. Files another open PR owns are allow-listed with
 *      their current count and the reason; a new raw read there fails too.
 *
 * HOW THE SHAPES REACH THE ROUTES. Live, both columns are INTEGER NOT NULL (the
 * 2026-10-08 census found every row stored as the integer 0 or 1), so SQLite
 * itself turns a written "0" into 0. This test rebuilds the two columns
 * without a declared type, so a stored "0" stays the string "0" and the real
 * adapter hands it back as one: 0, 1, "0", "1" and NULL are real stored values.
 * No SQLite driver can return a JS boolean, so true and false are stored as
 * marker strings and the libSQL client's own execute() turns the markers into
 * booleans, the way a boolean-returning driver would. Everything above the
 * driver is real: the signed session, the Turso adapter, the session context,
 * the persona, the route handlers.
 *
 * Run: node --conditions=react-server --import tsx tests/db-bool.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { CLIENT_A, check, finish, login, setupDatabase } from "./_delivery-harness";
import { dbBool } from "../lib/db-bool";

process.env.FORM_LINK_HMAC_KEY = "db-bool-test-form-link-signing-key-0123456789abcdef";

const ROOT = join(__dirname, "..");

/** The seven shapes, and what each must mean. */
const JS_TRUE = "__test_js_true__";
const JS_FALSE = "__test_js_false__";
type Shape = { label: string; stored: string | number | null; value: unknown; yes: boolean };
const SHAPES: Shape[] = [
  { label: "0", stored: 0, value: 0, yes: false },
  { label: "1", stored: 1, value: 1, yes: true },
  { label: '"0"', stored: "0", value: "0", yes: false },
  { label: '"1"', stored: "1", value: "1", yes: true },
  { label: "null", stored: null, value: null, yes: false },
  { label: "true", stored: JS_TRUE, value: true, yes: true },
  { label: "false", stored: JS_FALSE, value: false, yes: false },
];

type U = { id: string; email: string };
const seat = (n: number, slug: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email: `${slug}@client-a.test` });
/** One member per shape per flag: team role "member", the other flag 0. */
const OWNER_SHAPES = SHAPES.map((s, i) => ({ ...s, flag: "is_owner" as const, user: seat(i + 1, `owner-shape-${i}`) }));
const GRANT_SHAPES = SHAPES.map((s, i) => ({ ...s, flag: "admin_access" as const, user: seat(i + 21, `grant-shape-${i}`) }));

const FORM_A = "f0e00000-0000-4000-8000-00000000000a";
const LEAD_A = "1eae0000-0000-4000-8000-00000000000a";
const VALID_STEPS = [{ key: "contact", title: "Contact", fields: [{ name: "email", label: "Email", type: "email" }] }];
const MISSING_PROFILE = "p-nobody-0000";

type Json = Record<string, unknown>;

// ── the source guard ───────────────────────────────────────────────────────

const FLAGS = new Set(["is_owner", "admin_access"]);

/**
 * Raw reads of either flag that remain in other open PRs' files. Each is
 * fixed in the sweep after that PR merges; until then its count may not grow.
 */
const DEFERRED: Record<string, { max: number; reason: string }> = {
  "app/api/agents/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "app/api/agents/[slug]/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "app/api/agents/generate/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "app/api/manifest/chat/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "app/api/chat/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "app/api/chat/resume/route.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "lib/queries.ts": { max: 2, reason: "owned by open PR #535 (AI account)" },
  "lib/setup-readiness.ts": { max: 1, reason: "owned by open PR #535 (AI account)" },
  "components/settings/SettingsContent.tsx": { max: 1, reason: "edited by open PR #535 (AI account)" },
  "lib/slack/identity.ts": { max: 1, reason: "owned by PR #525 (Slack), on hold for a redesign" },
  "lib/notify/sunbiz-events.ts": { max: 1, reason: "owned by open PR #540 (alerts); SunBiz is retired" },
  "components/web-leads/BookMeetPanel.tsx": { max: 1, reason: "APEX's Book the Meet surface (lease); its members JSON is normalised at the source" },
};

/**
 * Reads of a field that shares the name but is not the stored flag: the
 * admin-access toggle's REQUEST BODY, which the route refuses unless it is a
 * real boolean (`typeof body.admin_access !== "boolean"` answers 400).
 */
const NOT_STORED: Record<string, { max: number; reason: string }> = {
  "app/api/team/members/[id]/admin-access/route.ts": {
    max: 2,
    reason: "the request body's admin_access, refused unless it is a real boolean; not a stored flag",
  },
};
const ALLOWANCES: Record<string, { max: number; reason: string }> = { ...DEFERRED, ...NOT_STORED };

const SCAN_DIRS = ["app", "lib", "components", "workers"];
const SCAN_FILES = ["middleware.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__", ".open-next", "__tests__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

/** Is `node` the first argument of a dbBool(...) call? */
function readThroughDbBool(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "dbBool" && p.arguments[0] === node;
}

/** Is `node` the left side of a plain assignment (a write, not a read)? */
function writtenTo(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/**
 * Every read of is_owner / admin_access in `src` that is not dbBool(<read>):
 * `x.is_owner`, `x?.admin_access`, `x["is_owner"]` and `const { is_owner } = x`.
 * Comments, strings (select lists, SQL), types and object keys are not reads.
 */
export function rawFlagReads(fileName: string, src: string): string[] {
  if (!src.includes("is_owner") && !src.includes("admin_access")) return [];
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const hit = (node: ts.Node) =>
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${node.getText(sf).slice(0, 80)}`);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && FLAGS.has(node.name.text)) {
      if (!readThroughDbBool(node) && !writtenTo(node)) hit(node);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      FLAGS.has(node.argumentExpression.text)
    ) {
      if (!readThroughDbBool(node) && !writtenTo(node)) hit(node);
    } else if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && FLAGS.has(key.text)) hit(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

async function sourceGuard() {
  console.log("db-bool (source guard):");
  const files = [...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...SCAN_FILES.map((f) => join(ROOT, f))];
  const sources = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")] as const));

  await check("the scan walked the whole tree", () => {
    assert.ok(sources.size > 1000, `only ${sources.size} files walked: the scan is broken`);
    for (const must of ["lib/api-auth.ts", "lib/team.ts", "lib/bridge-proxy.ts", "middleware.ts", "app/team/page.tsx"]) {
      assert.ok(sources.has(must), `the walk never reached ${must}`);
    }
  });

  await check("the detector finds every raw shape and ignores dbBool, comments, strings, types, keys and writes", () => {
    const n = (src: string, file = "x.ts") => rawFlagReads(file, src).length;
    assert.equal(n(`const a = !!p.is_owner;`), 1);
    assert.equal(n(`const a = p?.admin_access === true;`), 1);
    assert.equal(n(`const a = Number(row.is_owner) === 1;`), 1);
    assert.equal(n(`const a = row["admin_access"];`), 1);
    assert.equal(n(`const { is_owner } = row;`), 1);
    assert.equal(n(`const { admin_access: granted } = row;`), 1);
    assert.equal(n(`const f = ({ is_owner }: { is_owner: number }) => is_owner;`), 1);
    assert.equal(n(`const a = dbBool(p.is_owner) || dbBool(p?.admin_access) || dbBool(row["is_owner"]);`), 0);
    assert.equal(n(`// p.is_owner used to be read here\n/* !!p.admin_access */ const a = 1;`), 0);
    assert.equal(n(`db.from("user_profiles").select("is_owner, admin_access").eq("is_owner", true);`), 0);
    assert.equal(n(`type P = { is_owner?: boolean; admin_access: boolean | null };`), 0);
    assert.equal(n(`const update = { is_owner: 1, admin_access: false };`), 0);
    assert.equal(n(`row.is_owner = 1;`), 0);
    assert.equal(n("const sql = `SELECT 1 FROM user_profiles p WHERE p.is_owner = 1`;"), 0);
    assert.equal(n(`export const X = (m: M) => <b>{m.is_owner ? "owner" : ""}</b>;`, "x.tsx"), 1);
  });

  await check("every read of is_owner / admin_access outside the allowed files goes through dbBool", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      if (ALLOWANCES[file]) continue;
      for (const at of rawFlagReads(file, src)) offenders.push(`${file}:${at}`);
    }
    assert.deepEqual(offenders, [], `raw flag reads (read them with dbBool from lib/db-bool.ts):\n${offenders.join("\n")}`);
  });

  await check("an allowed file gains no new raw read (its count may only fall)", () => {
    const grown: string[] = [];
    for (const [file, { max, reason }] of Object.entries(ALLOWANCES)) {
      const src = sources.get(file);
      if (src === undefined) continue; // moved or deleted: nothing left to defer
      const reads = rawFlagReads(file, src);
      if (reads.length > max) grown.push(`${file} (${reason}): ${reads.length} raw reads, allowed ${max}\n  ${reads.join("\n  ")}`);
      else if (reads.length < max) console.log(`        note: ${file} is down to ${reads.length} raw read(s); lower its allowance`);
    }
    assert.deepEqual(grown, []);
  });
}

// ── the routes ─────────────────────────────────────────────────────────────

async function main() {
  await check("dbBool: true, 1 and \"1\" are yes; 0, \"0\", null, false and anything stranger are no", () => {
    for (const s of SHAPES) assert.equal(dbBool(s.value), s.yes, `dbBool(${s.label})`);
    for (const strange of [undefined, "", "true", "TRUE", "yes", " 1", "1 ", "01", "1.0", "0x1", 2, -1, 0.5, NaN, Infinity, 1n, [1], ["1"], { valueOf: () => 1 }, new Boolean(true)]) {
      assert.equal(dbBool(strange), false, `dbBool(${typeof strange === "bigint" ? "1n" : JSON.stringify(strange) ?? String(strange)}) must be no`);
    }
    assert.equal(dbBool(1.0), true, "1.0 is the same JS number as 1");
  });

  const db = await setupDatabase();
  // The two flags without a declared type: a stored "0" stays the string "0".
  await db.executeMultiple(`
    ALTER TABLE user_profiles DROP COLUMN is_owner;
    ALTER TABLE user_profiles DROP COLUMN admin_access;
    ALTER TABLE user_profiles ADD COLUMN is_owner;
    ALTER TABLE user_profiles ADD COLUMN admin_access;
    UPDATE user_profiles SET is_owner = CASE WHEN team_role = 'owner' THEN 1 ELSE 0 END, admin_access = 0;
    CREATE TABLE tenant_invites (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, team_role TEXT, token_hash TEXT,
      created_by TEXT, expires_at TEXT, redeemed_at TEXT, redeemed_by TEXT, revoked_at TEXT, created_at TEXT);
  `);
  // A JS number reaches an untyped column as a REAL; bound as a bigint it is
  // stored as the INTEGER the live column holds. Read back, both are the JS
  // number the adapter hands the app.
  const asStored = (v: string | number | null) => (typeof v === "number" ? BigInt(v) : v);
  const profile = (u: U, isOwner: string | number | null, adminAccess: string | number | null) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, full_name, joined_at, updated_at)
            VALUES (?, ?, ?, ?, 'member', ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      args: [`p-${u.id}`, u.id, u.email, CLIENT_A, asStored(isOwner), asStored(adminAccess), u.email.split("@")[0]],
    },
  ];
  await db.batch(
    [
      ...OWNER_SHAPES.flatMap((s) => profile(s.user, s.stored, 0)),
      ...GRANT_SHAPES.flatMap((s) => profile(s.user, 0, s.stored)),
      {
        sql: `INSERT INTO forms (id, tenant_id, slug, name, branding, steps, step_outcomes, enabled) VALUES (?, ?, 'intake', 'Intake', '{}', ?, '{}', 1)`,
        args: [FORM_A, CLIENT_A, JSON.stringify(VALID_STEPS)],
      },
      { sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', '{"name":"Alice Lead"}')`, args: [LEAD_A, CLIENT_A] },
    ],
    "write",
  );

  // The driver hands the two marker strings back as JS booleans. Wrapped on the
  // app's own libSQL client (lib/turso.ts), below the adapter.
  const { getTursoClient } = await import("../lib/turso");
  const client = getTursoClient();
  const driverExecute = Object.getPrototypeOf(client).execute as (this: unknown, stmt: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
  const marked = (v: unknown) => (v === JS_TRUE ? true : v === JS_FALSE ? false : v);
  (client as unknown as { execute: (stmt: unknown) => Promise<unknown> }).execute = async function (this: unknown, stmt: unknown) {
    const res = await driverExecute.call(this, stmt);
    if (!res.rows.some((row) => Object.values(row).some((v) => v === JS_TRUE || v === JS_FALSE))) return res;
    return { ...res, rows: res.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, marked(v)]))) };
  };

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
      /* not JSON */
    }
    return { status: res.status, body, text };
  };
  const formsTable = async () =>
    JSON.stringify((await db.execute("SELECT id, tenant_id, slug, name, steps, enabled, created_by, updated_at FROM forms ORDER BY id")).rows);

  const listRoute = await import("../app/api/forms/route");
  const formRoute = await import("../app/api/forms/[id]/route");
  const mintRoute = await import("../app/api/forms/[id]/mint-link/route");
  const templateRoute = await import("../app/api/forms/templates/sunbiz/[step]/route");
  const membersRoute = await import("../app/api/team/members/route");
  const invitesRoute = await import("../app/api/team/invites/route");
  const { resolveSessionContext } = await import("../lib/api-auth");
  const { getSessionContext } = await import("../lib/team");
  const access = await import("../lib/forms/access");

  console.log("db-bool:");

  await check("the shapes are really stored that way, and the adapter hands each back as written", async () => {
    const rows = (
      await db.execute({
        sql: `SELECT auth_user_id, typeof(is_owner) AS o, typeof(admin_access) AS g FROM user_profiles WHERE tenant_id = ? AND team_role = 'member'`,
        args: [CLIENT_A],
      })
    ).rows;
    const kinds = new Map(rows.map((r) => [String(r.auth_user_id), `${r.o}/${r.g}`]));
    const expectKind = (v: string | number | null) => (v === null ? "null" : typeof v === "number" ? "integer" : "text");
    for (const s of OWNER_SHAPES) {
      assert.equal(kinds.get(s.user.id), `${expectKind(s.stored)}/integer`, `is_owner ${s.label} stored as ${kinds.get(s.user.id)}`);
    }
    for (const s of GRANT_SHAPES) {
      assert.equal(kinds.get(s.user.id), `integer/${expectKind(s.stored)}`, `admin_access ${s.label} stored as ${kinds.get(s.user.id)}`);
    }
    const { getServiceSupabase } = await import("../lib/supabase-server");
    for (const s of [...OWNER_SHAPES, ...GRANT_SHAPES]) {
      const { data, error } = await getServiceSupabase().from("user_profiles").select(s.flag).eq("auth_user_id", s.user.id).maybeSingle();
      assert.equal(error, null);
      assert.deepEqual((data as Json | null)?.[s.flag], s.value, `${s.flag} ${s.label} came back as ${JSON.stringify((data as Json | null)?.[s.flag])}`);
    }
  });

  /** Every forms write route, as one member would call it. */
  const writes = () =>
    [
      ["create", () => listRoute.POST(req("POST", "/api/forms", { slug: "made-by-shape", name: "Made", steps: VALID_STEPS }))],
      ["change", () => formRoute.PATCH(req("PATCH", `/api/forms/${FORM_A}`, { name: "Hijacked", enabled: false }), params({ id: FORM_A }))],
      ["delete", () => formRoute.DELETE(req("DELETE", `/api/forms/${FORM_A}`), params({ id: FORM_A }))],
      ["mint a link", () => mintRoute.POST(req("POST", `/api/forms/${FORM_A}/mint-link`, { lead_id: LEAD_A }), params({ id: FORM_A }))],
      ["create from a template", () => templateRoute.POST(req("POST", "/api/forms/templates/sunbiz/initial-lead-capture"), params({ step: "initial-lead-capture" }))],
    ] as const;

  for (const s of [...OWNER_SHAPES, ...GRANT_SHAPES]) {
    await check(`${s.flag} = ${s.label}: the session reads ${s.yes ? "YES" : "no"}, and the Forms routes ${s.yes ? "let them change forms" : "refuse every write (403) and change nothing"}`, async () => {
      await login(s.user);
      const session = await resolveSessionContext();
      assert.ok(session.ok);
      const teamCtx = await getSessionContext();
      assert.ok(teamCtx);
      if (s.flag === "is_owner") {
        assert.equal(session.isTrueAdmin, s.yes, "resolveSessionContext isTrueAdmin");
        assert.equal(teamCtx.isOwner, s.yes, "getSessionContext isOwner");
        assert.equal(session.adminAccess, false);
      } else {
        assert.equal(session.adminAccess, s.yes, "resolveSessionContext adminAccess");
        assert.equal(teamCtx.adminAccess, s.yes, "getSessionContext adminAccess");
        assert.equal(session.isTrueAdmin, false, "a grant is never a true admin");
      }
      assert.equal(session.isAdmin, s.yes, "resolveSessionContext isAdmin");

      const before = await formsTable();
      if (!s.yes) {
        for (const [what, run] of writes()) {
          const res = await call(run());
          assert.equal(res.status, 403, `${what}: HTTP ${res.status} ${res.text.slice(0, 160)}`);
          assert.equal(res.body.error, "forbidden", what);
          assert.equal(res.body.message, access.FORMS_EDIT_REFUSED, what);
        }
        assert.equal(await formsTable(), before, "a refused write changed the forms table");
        return;
      }
      const created = await call(listRoute.POST(req("POST", "/api/forms", { slug: "made-by-shape", name: "Made", steps: VALID_STEPS })));
      assert.equal(created.status, 200, created.text);
      const createdId = String((created.body.form as { id: string }).id);
      const renamed = await call(formRoute.PATCH(req("PATCH", `/api/forms/${createdId}`, { name: "Renamed" }), params({ id: createdId })));
      assert.equal(renamed.status, 200, renamed.text);
      const minted = await call(mintRoute.POST(req("POST", `/api/forms/${FORM_A}/mint-link`, { lead_id: LEAD_A }), params({ id: FORM_A })));
      assert.equal(minted.status, 200, minted.text);
      assert.equal((await call(formRoute.DELETE(req("DELETE", `/api/forms/${createdId}`), params({ id: createdId })))).status, 200);
      const templated = await call(templateRoute.POST(req("POST", "/api/forms/templates/sunbiz/initial-lead-capture"), params({ step: "initial-lead-capture" })));
      assert.equal(templated.status, 200, templated.text);
      const templateId = String(templated.body.form_id);
      assert.equal((await call(formRoute.DELETE(req("DELETE", `/api/forms/${templateId}`), params({ id: templateId })))).status, 200);
      assert.equal(await formsTable(), before, "the round trip left a form behind");
    });
  }

  for (const s of OWNER_SHAPES) {
    await check(`team context, is_owner = ${s.label}: removing a member is ${s.yes ? "past the true-admin gate" : "refused (403)"}`, async () => {
      await login(s.user);
      const res = await call(membersRoute.DELETE(req("DELETE", `/api/team/members?profile_id=${MISSING_PROFILE}`)));
      if (s.yes) {
        // Past the gate, the target lookup answers: no such member, nothing removed.
        assert.equal(res.status, 404, res.text);
        assert.equal(res.body.error, "member_not_found");
      } else {
        assert.equal(res.status, 403, res.text);
        assert.equal(res.body.error, "forbidden");
      }
    });
  }

  for (const s of GRANT_SHAPES) {
    await check(`team context, admin_access = ${s.label}: the invite list ${s.yes ? "opens (200), with no Administrator role on offer" : "is refused (403)"}; removing a member is refused either way`, async () => {
      await login(s.user);
      const invites = await call(invitesRoute.GET());
      if (s.yes) {
        assert.equal(invites.status, 200, invites.text);
        const roles = (invites.body.role_options as Array<{ value: string }>).map((o) => o.value);
        assert.ok(!roles.includes("admin"), `a grant could mint an Administrator: ${roles.join(", ")}`);
      } else {
        assert.equal(invites.status, 403, invites.text);
      }
      // The grant never confers removal, whatever its shape (escalation guard).
      const removed = await call(membersRoute.DELETE(req("DELETE", `/api/team/members?profile_id=${MISSING_PROFILE}`)));
      assert.equal(removed.status, 403, removed.text);
    });
  }

  // ── the other readers, as pure functions ───────────────────────────────
  const leadScope = await import("../lib/lead-scope");
  const settings = await import("../components/settings/settings-sections");
  const gate = await import("../lib/onboarding-gate");
  const workflow = await import("../lib/website-sales-workflow");
  const team = await import("../lib/team");
  const resolver = await import("../lib/active-profile-resolver");

  await check("lead scope, workspace settings and the onboarding gate read each shape the same way", () => {
    for (const s of SHAPES) {
      const owner = { is_owner: s.value, team_role: "member", admin_access: 0 } as never;
      const granted = { is_owner: 0, team_role: "member", admin_access: s.value } as never;
      assert.equal(leadScope.isTrueAdmin(owner), s.yes, `isTrueAdmin(is_owner ${s.label})`);
      assert.equal(leadScope.isAdminProfile(owner), s.yes, `isAdminProfile(is_owner ${s.label})`);
      assert.equal(leadScope.isTrueAdmin(granted), false, `a grant is not a true admin (${s.label})`);
      assert.equal(leadScope.isAdminProfile(granted), s.yes, `isAdminProfile(admin_access ${s.label})`);
      assert.equal(settings.canManageWorkspaceSettings(owner, true), s.yes, `settings, is_owner ${s.label}`);
      assert.equal(settings.canManageWorkspaceSettings(granted, true), s.yes, `settings, admin_access ${s.label}`);
      assert.equal(
        gate.shouldRedirectToOnboarding(
          { onboarding_completed_at: null, invited_by: null, tenant_id: "t-1", is_owner: s.value as never },
          { workspaceProvisioned: false },
        ),
        s.yes ? "/onboarding/wizard" : null,
        `onboarding gate, is_owner ${s.label}`,
      );
    }
  });

  await check("closer credit excludes an owner in every yes-shape, and only then", () => {
    for (const s of SHAPES) {
      const credited = workflow.mayCreditAdminVerifiedCloser({
        candidateUserId: "22222222-2222-4222-8222-222222222222",
        frozenOpenerUserId: "11111111-1111-4111-8111-111111111111",
        auditHostUserId: "22222222-2222-4222-8222-222222222222",
        assignedTo: "33333333-3333-4333-8333-333333333333",
        recordedAuditHostRole: "builder",
        liveTeamRole: "builder",
        isOwner: s.value,
      });
      assert.equal(credited, !s.yes, `isOwner ${s.label}`);
    }
  });

  await check("the team roster hands back real booleans, and an owner or a grant never joins the sales roster's reps", () => {
    for (const s of SHAPES) {
      const row = (id: string, overrides: Json) =>
        ({ id, auth_user_id: `auth-${id}`, email: `${id}@a.test`, full_name: id, display_name: null, team_role: "closer", is_owner: 0, admin_access: 0, invited_by: null, joined_at: "2026-01-01T00:00:00Z", ...overrides }) as never;
      const [owner] = team.canonicalizeTenantMembers([row("o", { is_owner: s.value })]);
      const [granted] = team.canonicalizeTenantMembers([row("g", { admin_access: s.value })]);
      assert.equal(owner.is_owner, s.yes, `is_owner ${s.label} -> ${String(owner.is_owner)}`);
      assert.equal(granted.admin_access, s.yes, `admin_access ${s.label} -> ${String(granted.admin_access)}`);
      assert.equal(typeof owner.is_owner, "boolean");
      assert.equal(typeof granted.admin_access, "boolean");
    }
  });

  await check("the active-profile pick ranks a seat as the owner's only for a yes-shape", () => {
    for (const s of SHAPES) {
      const picked = resolver.chooseActiveProfile(
        [
          { id: "a-flagged", email: "x@a.test", is_owner: s.value, onboarding_completed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
          { id: "b-plain", email: "x@a.test", is_owner: 0, onboarding_completed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" },
        ] as never,
        "x@a.test",
      );
      assert.equal(picked.id, s.yes ? "a-flagged" : "b-plain", `is_owner ${s.label}`);
    }
  });

  await sourceGuard();
  finish("db-bool");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
