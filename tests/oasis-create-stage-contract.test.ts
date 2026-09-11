/**
 * oasis-create-stage-contract.test.ts — adding an OASIS lead, end to end.
 *
 * THE DEFECT (CC, 2026-09-10, verbatim): "It only allows me to add a lead to
 * the research section, which isn't even a section. Once I add the lead, it
 * says Redirecting, and then it takes me back to the pipeline, where the lead
 * does not exist. If I go to the leads page, it also doesn't exist there. We
 * need to be able to add leads to different stages without being restricted.
 * I tried to put the stage as founder meeting, and it said that I can't do it."
 *
 * Four things had to agree and none of them did:
 *   the picker   offered all 14 stages (the seed enum)
 *   the server   accepted one: `researched`
 *   the board    has not drawn `researched` since 2026-08-21
 *   the stamp    an admin's lead got no owner and no sales_motion, while
 *                /pipeline filters on sales_motion and /web-leads needs an
 *                owner for My leads
 *
 * (a) and (b) pin the stage lists to each other. (c) drives the REAL route
 * handlers — POST /api/manifest/<slug>/records/lead and POST
 * /api/leads/quick-add — through the real session check, profile resolution,
 * tenant gate and data layer, against a local libSQL database, then reads the
 * rows back through the same query /pipeline runs and the same read /web-leads
 * runs. The only stand-in is the request cookie jar (next/headers), because a
 * route handler called outside a Next request has no cookies() to read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

// Env before any module under test is imported: lib/turso.ts and
// lib/supabase-server.ts memoise their clients on first use.
const dbFile = join(mkdtempSync(join(tmpdir(), "oasis-create-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "oasis-create-stage-contract-secret-that-is-long-enough-0001";

// The cookie jar. getSessionUser() reads the Turso session cookie through
// next/headers' cookies(). Everything behind it — the HMAC check, the
// session-version check against the database, profile resolution — is the
// production path.
const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
const headersPath = require.resolve("next/headers");
require.cache[headersPath] = {
  id: headersPath,
  filename: headersPath,
  path: dirname(headersPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    cookies: async () => ({
      get: (name: string) =>
        name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
      getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
      has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
      set: () => undefined,
    }),
    headers: async () => new Headers(),
    draftMode: async () => ({ isEnabled: false }),
  },
} as unknown as NodeModule;

// UUID-shaped on purpose: the rep pipeline read fails closed on anything else.
const OWNER = "0a0a0a0a-0000-4000-8000-000000000001";
const OPENER = "0a0a0a0a-0000-4000-8000-000000000002";
const MEMBER = "0a0a0a0a-0000-4000-8000-000000000003";
const SUN_AGENT = "0a0a0a0a-0000-4000-8000-000000000004";
const OTHER_REP = "0a0a0a0a-0000-4000-8000-000000000005";
const SUN_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  fields?: string[];
  allowed_stages?: { key: string; label: string }[];
  record?: { id: string; tenant_id: string; data: Record<string, unknown> };
  id?: string;
  stage?: string;
  existing?: boolean;
  advanced?: boolean;
};

function run(name: string) {
  console.log(`  ok  ${name}`);
}

/** A refusal must be a sentence a person can act on, never the bare code. */
function assertReadable(body: ApiBody, label: string) {
  assert.equal(typeof body.message, "string", `${label}: no message`);
  assert.notEqual(body.message, body.error, `${label}: the message is just the code`);
  assert.match(body.message!, /\s/, `${label}: "${body.message}" is not a sentence`);
}

async function main() {
  const { OASIS_LEAD_STAGES, OASIS_LEAD_STAGE_KEYS } = await import("../lib/oasis-stage-meta");
  const { WEBSITE_SALES_STAGES } = await import("../lib/website-sales");
  const policy = await import("../lib/oasis-sales-pipeline-policy");
  const create = await import("../lib/oasis-lead-create");
  const { isAdminProfile } = await import("../lib/lead-scope");
  const { OASIS_COLD_OUTBOUND_MOTION, OASIS_WEBSITE_SALES_PROGRAM } = await import(
    "../lib/leads/canonical-lead-fields"
  );
  const { OASIS_SEED } = await import("../lib/manifest/seeds");
  const { countryOf } = await import("../lib/web-leads/filters");

  console.log("oasis-create-stage-contract:");

  const POOL = "researched";
  const BOARD_ALL = OASIS_LEAD_STAGE_KEYS.filter((key) => key !== POOL);

  // ───────────────────────────────────────────────────────────────────────
  // (a) creatable ⊆ board ⊆ admin set_stage, for every role
  // ───────────────────────────────────────────────────────────────────────
  const ROLE_VIEWERS = [
    { label: "owner", teamRole: "owner", isOwner: true, adminAccess: false, expect: BOARD_ALL },
    { label: "admin", teamRole: "admin", isOwner: false, adminAccess: false, expect: BOARD_ALL },
    { label: "member", teamRole: "member", isOwner: false, adminAccess: false, expect: [] as string[] },
    { label: "admin_access", teamRole: "opener", isOwner: false, adminAccess: true, expect: BOARD_ALL },
    { label: "opener", teamRole: "opener", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "closer", teamRole: "closer", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "manager", teamRole: "manager", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "builder", teamRole: "builder", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "agent", teamRole: "agent", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "marketing", teamRole: "marketing", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "read_only", teamRole: "read_only", isOwner: false, adminAccess: false, expect: [] as string[] },
  ];
  // The capability-admin predicate the records route (and admin set_stage,
  // via session.isAdmin) uses — imported, not restated.
  const viewerFor = (v: (typeof ROLE_VIEWERS)[number]) => ({
    isAdmin: isAdminProfile({ is_owner: v.isOwner, team_role: v.teamRole, admin_access: v.adminAccess }),
    teamRole: v.teamRole,
  });

  // One list: the admin set_stage allowlist IS the board's stage list.
  assert.deepEqual(
    [...WEBSITE_SALES_STAGES],
    OASIS_LEAD_STAGE_KEYS,
    "WEBSITE_SALES_STAGES (admin set_stage) drifted from OASIS_LEAD_STAGES (the board)",
  );

  for (const v of ROLE_VIEWERS) {
    const board = create
      .oasisBoardStages({ teamRole: v.teamRole, isOwner: v.isOwner, adminAccess: v.adminAccess })
      .map((stage) => stage.key);
    const creatable = create.creatableOasisStages(viewerFor(v)).map((stage) => stage.key);
    assert.deepEqual(creatable, v.expect, `${v.label}: creatable stages`);
    for (const key of creatable) {
      assert.ok(board.includes(key), `${v.label}: may create in ${key}, which their board does not draw`);
    }
    for (const key of board) {
      assert.ok(
        (WEBSITE_SALES_STAGES as readonly string[]).includes(key),
        `${v.label}: board draws ${key}, which admin set_stage cannot move a lead to`,
      );
    }
    assert.ok(!board.includes(POOL), `${v.label}: the board drew the prospect pool as a column`);
    assert.ok(!creatable.includes(POOL), `${v.label}: may create into the prospect pool`);
  }
  run("(a) every role: creatable stages are board stages, and set_stage covers the board");

  // The board page renders exactly this list — no second inline filter.
  const pipelinePage = readFileSync("app/pipeline/page.tsx", "utf8");
  assert.match(pipelinePage, /oasisBoardStages\(\{/, "/pipeline must take its columns from oasisBoardStages");
  assert.match(pipelinePage, /creatableOasisStages\(\{ isAdmin: session\.isAdmin, teamRole: session\.teamRole \}\)/);
  assert.doesNotMatch(
    pipelinePage,
    /stage\.key !== "researched"/,
    "/pipeline grew its own researched filter again — the board and create lists can drift",
  );
  assert.match(pipelinePage, /salesMotion: boardFilter\.salesMotion/);
  run("(a) /pipeline reads its columns and its program filter from the shared module");

  // ───────────────────────────────────────────────────────────────────────
  // (b) the /pipeline/new picker offers exactly the server allowlist
  // ───────────────────────────────────────────────────────────────────────
  const seedLead = OASIS_SEED.data_model!.find((entity) => entity.name === "lead")!;
  const seedStagesBefore = [...(seedLead.fields.find((f) => f.name === "stage")!.enum_values || [])];
  for (const v of ROLE_VIEWERS) {
    const viewer = viewerFor(v);
    const form = create.oasisLeadCreateForm(seedLead, viewer);
    const stageField = form.entity.fields.find((f) => f.name === "stage")!;
    const picker = stageField.enum_values || [];
    assert.deepEqual(picker, v.expect, `${v.label}: picker`);
    assert.equal(stageField.required, true, `${v.label}: stage must be required`);
    // Every one of the 14 stages: the server says yes exactly when the picker
    // offers it. This is the property that was false for CC.
    for (const key of OASIS_LEAD_STAGE_KEYS) {
      const plan = create.planOasisLeadCreate({
        viewer,
        creatorUserId: OWNER,
        data: { name: "Probe", state: "ON", stage: key },
        now: new Date(),
        requireRegion: true,
      });
      assert.equal(plan.ok, picker.includes(key), `${v.label}: picker and server disagree on ${key}`);
    }
    for (const key of picker) {
      assert.equal(
        form.optionLabels.stage[key],
        OASIS_LEAD_STAGES.find((stage) => stage.key === key)!.label,
        `${v.label}: ${key} must be labelled as the board labels it`,
      );
    }
  }
  const adminForm = create.oasisLeadCreateForm(seedLead, { isAdmin: true, teamRole: "owner" });
  assert.equal(adminForm.optionLabels.stage.founder_meeting_booked, "Founder Meeting");
  assert.deepEqual(
    seedLead.fields.find((f) => f.name === "stage")!.enum_values,
    seedStagesBefore,
    "the form must trim a COPY — existing researched leads rely on the seed's 14-stage enum",
  );
  assert.ok(seedStagesBefore.includes(POOL));

  // D7: State is a required region code, and every code lands on one board.
  const stateField = adminForm.entity.fields.find((f) => f.name === "state")!;
  assert.equal(stateField.type, "enum");
  assert.equal(stateField.required, true);
  assert.deepEqual(stateField.enum_values, [...create.OASIS_LEAD_REGION_CODES]);
  assert.equal(new Set(create.OASIS_LEAD_REGION_CODES).size, create.OASIS_LEAD_REGION_CODES.length);
  for (const code of create.OASIS_LEAD_REGION_CODES) {
    const label = adminForm.optionLabels.state[code];
    assert.equal(label.endsWith(countryOf(code) === "ca" ? "Canada" : "United States"), true, label);
  }
  assert.equal(countryOf("ON"), "ca");
  assert.equal(countryOf("FL"), "us");

  // A picker offers only what the server accepts: no lifecycle field survives
  // into the create form (last_contacted_at did, and 409'd when filled in).
  for (const field of adminForm.entity.fields) {
    if (field.name === "stage") continue;
    assert.deepEqual(
      policy.rejectedOasisGenericPatchKeys({ [field.name]: "x" }),
      [],
      `the create form offers ${field.name}, which the server refuses`,
    );
  }

  // ?stage= preselects only a stage the viewer may create in.
  const adminStages = create.creatableOasisStages({ isAdmin: true, teamRole: "owner" });
  const repStages = create.creatableOasisStages({ isAdmin: false, teamRole: "opener" });
  assert.equal(create.preselectOasisCreateStage("founder_meeting_booked", adminStages), "founder_meeting_booked");
  assert.equal(create.preselectOasisCreateStage("founder_meeting_booked", repStages), "assigned");
  assert.equal(create.preselectOasisCreateStage(POOL, adminStages), "assigned");
  assert.equal(create.preselectOasisCreateStage(undefined, adminStages), "assigned");

  const newPage = readFileSync("app/pipeline/new/page.tsx", "utf8");
  assert.match(newPage, /const form = oasisLeadCreateForm\(leadEntity, viewer\)/);
  assert.match(newPage, /entity=\{form\.entity\}/, "the page must render the trimmed form, not the seed entity");
  assert.match(newPage, /optionLabels=\{form\.optionLabels\}/);
  assert.match(newPage, /preselectOasisCreateStage\(sp\.stage, form\.stages\)/, "D8: ?stage= preselects");
  assert.match(newPage, /landOnStagePath="\/pipeline"/, "D8: a save lands on /pipeline?stage=<stage>");
  assert.doesNotMatch(newPage, /stage: "researched"/, "D3: the form must not default into the pool");
  assert.match(
    newPage,
    /if \(!isWebsiteSalesTenantSlug\(tenantSlug\)\) redirect\(`\/t\/\$\{tenantSlug\}\/leads`\)/,
    "D12: a non-OASIS workspace is sent to its own leads board",
  );
  assert.match(newPage, /if \(creatable\.length === 0\) redirect\("\/pipeline"\)/);

  const formSource = readFileSync("components/manifest/ManifestRecordForm.tsx", "utf8");
  assert.match(formSource, /optionLabels\?\.\[v\] \?\? humanize\(v\)/, "D11: labels, not humanize(key)");
  assert.match(formSource, /\$\{landOnStagePath\}\?stage=\$\{encodeURIComponent\(savedStage\)\}/);
  assert.match(formSource, /setFormError\(saveErrorMessage\(res\.status, refusal\)\)/);
  assert.doesNotMatch(formSource, /setFormError\(data\.message \|\| data\.error\)/, "D11: a raw code reached the screen");
  assert.doesNotMatch(formSource, /"network_error"/, "D11: a raw code reached the screen");

  const view = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
  assert.match(
    view,
    /variant === "oasis" && creatableStageKeys\?\.includes\(stage\.key\)\s*\?\s*`\$\{newHref\}\?stage=\$\{encodeURIComponent\(stage\.key\)\}`/,
    "D9: each creatable OASIS column links to /pipeline/new?stage=<key>",
  );
  assert.match(pipelinePage, /creatableStageKeys=\{creatableStageKeys\}/);
  run("(b) the picker offers exactly what the server accepts, with board labels and a region code");

  // The catch-all's "new record" URL was a second door onto a lead create
  // form: it rendered the seed entity (the pool, a free-text State,
  // last_contacted_at) to any profile outside a nine-role list (review,
  // 2026-09-10). Every OASIS lead create URL now opens /pipeline/new, whatever
  // the role; SunBiz keeps its own form.
  for (const slug of ["oasis", "oasis-ai-cc", "oasis-webdev", "OASIS-AI-CC"]) {
    assert.equal(
      create.oasisLeadCreateRedirect({ tenantSlug: slug, entity: "lead", isNewForm: true, stage: null }),
      "/pipeline/new",
      `${slug}: a lead create URL must open /pipeline/new`,
    );
    assert.equal(
      create.oasisLeadCreateRedirect({ tenantSlug: slug, entity: "lead", isNewForm: true, stage: "founder_meeting_booked" }),
      "/pipeline/new?stage=founder_meeting_booked",
      `${slug}: ?stage= must survive the redirect`,
    );
  }
  assert.equal(
    create.oasisLeadCreateRedirect({ tenantSlug: "sun", entity: "lead", isNewForm: true }),
    null,
    "SunBiz keeps its own lead form",
  );
  assert.equal(
    create.oasisLeadCreateRedirect({ tenantSlug: "oasis-ai-cc", entity: "application", isNewForm: true }),
    null,
    "only the lead entity moves",
  );
  assert.equal(
    create.oasisLeadCreateRedirect({ tenantSlug: "oasis-ai-cc", entity: "lead", isNewForm: false }),
    null,
    "a list or detail URL is not a create",
  );
  assert.equal(
    create.oasisLeadCreateRedirect({ tenantSlug: "oasis-ai-cc", entity: "lead", isNewForm: true, stage: "won&x=1" }),
    "/pipeline/new?stage=won%26x%3D1",
    "the stage is encoded, so a hand-edited URL cannot add a parameter",
  );
  // The page itself cannot be imported here (a client component builds a
  // React context at module load), so the wiring is pinned by position: the
  // redirect runs before anything role-dependent and before every form.
  const catchAll = readFileSync("app/t/[slug]/[...path]/page.tsx", "utf8");
  const redirectAt = catchAll.indexOf("if (oasisCreateTarget) redirect(oasisCreateTarget);");
  assert.ok(redirectAt > 0, "the catch-all must send an OASIS lead create URL to /pipeline/new");
  assert.match(
    catchAll,
    /oasisLeadCreateRedirect\(\{\s*tenantSlug: normalised,\s*entity: pageDef\.entity,\s*isNewForm,\s*stage: stageFilter,\s*\}\)/,
  );
  assert.ok(catchAll.indexOf("const profileRes =") > redirectAt, "the redirect must not depend on the caller's role");
  let formsChecked = 0;
  for (const m of catchAll.matchAll(/<ManifestRecordForm\b/g)) {
    assert.ok(m.index! > redirectAt, "a ManifestRecordForm can render before the OASIS create redirect");
    formsChecked += 1;
  }
  assert.ok(formsChecked >= 2, "expected the catch-all's edit and create forms");
  run("(b) every OASIS lead create URL opens /pipeline/new, whatever the role; SunBiz keeps its form");

  // The stamp satisfies the board's filter on every OASIS slug, and nothing
  // leaks to a non-OASIS slug.
  const stampNow = new Date("2026-09-10T12:00:00.000Z");
  for (const slug of ["oasis", "oasis-ai-cc", "oasis-webdev"]) {
    const filter = create.oasisBoardProgramFilter(slug);
    const stamp = create.oasisLeadCreateStamp({ stage: "assigned", creatorUserId: OWNER, now: stampNow });
    assert.equal(filter.salesMotion, OASIS_COLD_OUTBOUND_MOTION, `${slug} board filters on the motion`);
    assert.equal(stamp.sales_motion, filter.salesMotion, `${slug}: stamp fails the board's motion filter`);
    if (filter.salesProgram) assert.equal(stamp.sales_program, filter.salesProgram);
  }
  assert.deepEqual(create.oasisBoardProgramFilter("sun"), { salesProgram: null, salesMotion: null });
  const upper = create.oasisLeadCreateStamp({ stage: "lost", creatorUserId: OWNER.toUpperCase(), now: stampNow });
  assert.equal(upper.assigned_to, OWNER, "assigned_to is lowercased");
  assert.equal(upper.lost_at, stampNow.toISOString(), "a lead created as lost carries lost_at");
  assert.equal("claimed_at" in upper, false, "claimed_at would let the 7-day rule release a hand-made lead");
  assert.equal(
    "lost_at" in create.oasisLeadCreateStamp({ stage: "won", creatorUserId: OWNER, now: stampNow }),
    false,
  );
  run("(b) the stamp satisfies the board filter on every OASIS slug");

  // ───────────────────────────────────────────────────────────────────────
  // (c) behavioural: the real route handlers against a real libSQL database
  // ───────────────────────────────────────────────────────────────────────
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, updated_at TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (
      id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT,
      correlation_id TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE forms (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);
  `);
  const profile = (id: string, authId: string, email: string, tenant: string, role: string, owner = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [id, authId, email, tenant, role, owner],
  });
  const lead = (id: string, tenant: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, tenant, JSON.stringify(data)],
  });
  await seed.batch(
    [
      ...[
        [OWNER, "cc@oasis.test"],
        [OPENER, "opener@oasis.test"],
        [MEMBER, "member@oasis.test"],
        [SUN_AGENT, "agent@sun.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-owner", OWNER, "cc@oasis.test", WEBDEV_TENANT_ID, "owner", 1),
      profile("p-opener", OPENER, "opener@oasis.test", WEBDEV_TENANT_ID, "opener"),
      profile("p-member", MEMBER, "member@oasis.test", WEBDEV_TENANT_ID, "member"),
      profile("p-sun", SUN_AGENT, "agent@sun.test", SUN_TENANT, "agent"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [SUN_TENANT] },
      // The prospect pool: unassigned, territory, phone. Belongs in no book.
      lead("pool-1", WEBDEV_TENANT_ID, {
        business_name: "Pool Prospect", phone: "4165550100", state: "ON", stage: POOL,
        webdev_territory_id: "terr-toronto",
      }),
      // Another rep's book: an admin's Team tab shows it, nobody's My leads does.
      lead("other-rep-1", WEBDEV_TENANT_ID, {
        name: "Other Rep Lead", state: "ON", stage: "connected", assigned_to: OTHER_REP,
        sales_motion: OASIS_COLD_OUTBOUND_MOTION, sales_program: OASIS_WEBSITE_SALES_PROGRAM,
      }),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const records = await import("../app/api/manifest/[slug]/records/[entity]/route");
  const quickAdd = await import("../app/api/leads/quick-add/route");
  const { listOasisPipelineWindow, resolveOasisPipelineAssigneeScope } = await import(
    "../lib/oasis-pipeline-query"
  );
  const { fetchLeads } = await import("../lib/web-leads/data");
  const { parseFilters, filtersToParams, switchCountry } = await import("../lib/web-leads/filters");
  const { EMPTY_SCORE_INDEX } = await import("../lib/web-leads/scores");

  const login = (userId: string, email: string) => {
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const postRecord = async (slug: string, data: Record<string, unknown>) => {
    const req = new NextRequest(`http://localhost/api/manifest/${slug}/records/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const res = await records.POST(req, { params: Promise.resolve({ slug, entity: "lead" }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postQuickAdd = async (body: Record<string, unknown>) => {
    const req = new NextRequest("http://localhost/api/leads/quick-add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await quickAdd.POST(req);
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const storedLead = async (id: string) => {
    const r = await seed.execute({ sql: "SELECT tenant_id, data FROM tenant_records WHERE id = ?", args: [id] });
    assert.equal(r.rows.length, 1, `lead ${id} is not in the database`);
    return {
      tenantId: String(r.rows[0].tenant_id),
      data: JSON.parse(String(r.rows[0].data)) as Record<string, unknown>,
    };
  };
  const leadCount = async () =>
    Number((await seed.execute("SELECT count(*) AS n FROM tenant_records WHERE entity_type = 'lead'")).rows[0].n);

  const CA = parseFilters(new URLSearchParams());
  const US = parseFilters(new URLSearchParams("country=us"));
  const ownerViewer = { userId: OWNER, teamRole: "owner", isAdmin: true };
  const openerViewer = { userId: OPENER, teamRole: "opener", isAdmin: false };
  const memberViewer = { userId: MEMBER, teamRole: "member", isAdmin: false };
  const mineIds = async (viewer: typeof ownerViewer, filters = CA, scope: "mine" | "team" = "mine") =>
    new Set(
      (await fetchLeads(filters, [], viewer, EMPTY_SCORE_INDEX, { scope, now: Date.now() })).leads.map(
        (l) => l.id,
      ),
    );
  // /pipeline's query, with the arguments app/pipeline/page.tsx builds for
  // this viewer: its board stages, its program filter, its assignee scope.
  const pipelineRows = async (
    who: { userId: string; teamRole: string; isOwner: boolean },
    stage: string,
  ) => {
    const pipelineAdmin = policy.isOasisPipelineAdmin(who.teamRole, who.isOwner, false);
    const scope = resolveOasisPipelineAssigneeScope({
      isAdmin: pipelineAdmin,
      userId: who.userId,
      repFilter: null,
      canReadTeam: false,
      teamRepUserIds: [],
    });
    assert.ok(scope.allowed, `${who.teamRole} has no pipeline scope`);
    const window = await listOasisPipelineWindow({
      tenantId: WEBDEV_TENANT_ID,
      stageKeys: create
        .oasisBoardStages({ teamRole: who.teamRole, isOwner: who.isOwner, adminAccess: false })
        .map((s) => s.key),
      requestedStage: stage,
      requestedPage: null,
      ...create.oasisBoardProgramFilter("oasis-ai-cc"),
      assignedTo: scope.assignedTo,
      assignedToAny: undefined,
      viewerUserId: pipelineAdmin ? null : who.userId,
      fulfillmentOwnerId: null,
      query: null,
    });
    assert.equal(window.activeStage, stage, `/pipeline?stage=${stage} did not select that stage`);
    return window.rows.map((row) => row.id);
  };

  // Prime every read a memo could hide behind BEFORE anything is created, so a
  // cached book cannot pass the "appears immediately" check below.
  assert.equal((await mineIds(ownerViewer)).size, 0);
  assert.deepEqual([...(await mineIds(ownerViewer, CA, "team"))], ["other-rep-1"]);
  // A role with no scoping reads every row it is handed, so the only thing
  // keeping another rep's leads off a member's Team tab is that the team read
  // fetches its own book plus a roster it does not have. (Verifier, 2026-09-10.)
  assert.deepEqual([...(await mineIds(memberViewer, CA, "team"))], [],
    "a member's Team tab listed leads another rep holds");

  // An OWNER creates one lead in every stage the board draws — no phone on
  // any of them, the way a lead typed in from a referral often arrives.
  login(OWNER, "cc@oasis.test");
  const created: Record<string, string> = {};
  for (const stage of BOARD_ALL) {
    const res = await postRecord("oasis-ai-cc", {
      name: `Owner lead ${stage}`,
      company: `Company ${stage}`,
      state: "ON",
      stage,
    });
    assert.equal(res.status, 200, `${stage}: ${res.body.error} — ${res.body.message}`);
    assert.equal(res.body.record!.tenant_id, WEBDEV_TENANT_ID, `${stage}: wrong tenant`);
    const stored = await storedLead(res.body.record!.id);
    assert.equal(stored.tenantId, WEBDEV_TENANT_ID, `${stage}: row written to the wrong tenant`);
    assert.equal(stored.data.stage, stage);
    assert.equal(stored.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION, `${stage}: no sales_motion stamp`);
    assert.equal(stored.data.sales_program, OASIS_WEBSITE_SALES_PROGRAM);
    assert.equal(stored.data.assigned_to, OWNER, `${stage}: the creator does not own it`);
    assert.equal(typeof stored.data.assigned_at, "string");
    assert.equal(typeof stored.data.stage_entered_at, "string");
    assert.equal("claimed_at" in stored.data, false);
    assert.equal("lost_at" in stored.data, stage === "lost");
    created[stage] = res.body.record!.id;
  }
  run("(c) an owner creates a lead in each of the 13 board stages, stamped and owned");

  for (const stage of BOARD_ALL) {
    const ids = await pipelineRows({ userId: OWNER, teamRole: "owner", isOwner: true }, stage);
    assert.ok(ids.includes(created[stage]), `/pipeline?stage=${stage} does not show the lead just created there`);
  }
  run("(c) each lead appears on /pipeline in the stage it was created in");

  const ownerMine = await mineIds(ownerViewer);
  for (const stage of BOARD_ALL) {
    assert.ok(ownerMine.has(created[stage]), `My leads does not show the ${stage} lead just created`);
  }
  assert.equal(ownerMine.size, BOARD_ALL.length, "My leads holds something that is not the owner's");
  const ownerTeam = await mineIds(ownerViewer, CA, "team");
  for (const stage of BOARD_ALL) assert.ok(ownerTeam.has(created[stage]), `Team leads misses ${stage}`);
  assert.ok(ownerTeam.has("other-rep-1"), "an admin's Team leads must show every rep's book");
  assert.ok(!ownerTeam.has("pool-1"), "Team leads is a book — the prospect pool must not flood it");
  run("(c) each lead appears in /web-leads My leads and Team leads immediately, with no phone");

  // D7: the region code decides the board, and it is normalised.
  const us = await postRecord("oasis-ai-cc", { name: "Miami Lead", state: "fl", stage: "qualified" });
  assert.equal(us.status, 200, us.body.message);
  assert.equal((await storedLead(us.body.record!.id)).data.state, "FL");
  assert.ok(!(await mineIds(ownerViewer)).has(us.body.record!.id), "a US lead appeared on the Canada board");
  assert.ok((await mineIds(ownerViewer, US)).has(us.body.record!.id), "a US lead is missing from the US board");
  run("(c) a US region code puts the lead on the US board, not the Canada one");

  // ...and the book the page opens on SAYS where it is. My leads and Team
  // leads show one country board at a time and open on Canada; until this
  // change neither tab had a country switch, so this lead was on no screen CC
  // could reach from the page (review, 2026-09-10). The book read now counts
  // both boards, and the book tabs render the rail's own switch.
  const caBook = await fetchLeads(CA, [], ownerViewer, EMPTY_SCORE_INDEX, { scope: "mine", now: Date.now() });
  assert.deepEqual(caBook.boards, { ca: BOARD_ALL.length, us: 1 }, "My leads on Canada must report the US lead");
  assert.equal(caBook.total, caBook.boards!.ca, "the board count disagrees with the list it labels");
  const caTeam = await fetchLeads(CA, [], ownerViewer, EMPTY_SCORE_INDEX, { scope: "team", now: Date.now() });
  assert.equal(caTeam.boards?.us, 1, "Team leads on Canada must report the US lead");
  // Driven the way the switch drives it: switchCountry, then the URL it pushes.
  const switched = parseFilters(
    filtersToParams(switchCountry(parseFilters(new URLSearchParams("view=mine")), "us")),
  );
  assert.equal(switched.view, "mine", "switching boards must stay on My leads");
  assert.equal(switched.country, "us");
  assert.ok(
    (await mineIds(ownerViewer, switched)).has(us.body.record!.id),
    "the My leads switch does not reach the US lead",
  );
  // The pool keeps its rail's facet counts and gets no book count.
  const poolRead = await fetchLeads(CA, ["terr-toronto"], ownerViewer, EMPTY_SCORE_INDEX, {
    scope: "pool",
    now: Date.now(),
  });
  assert.equal(poolRead.boards, null);
  assert.deepEqual(poolRead.leads.map((l) => l.id), ["pool-1"], "the pool read changed");
  const browserSrc = readFileSync("components/web-leads/WebLeadsBrowser.tsx", "utf8");
  assert.match(
    browserSrc,
    /\{\(mine \|\| team\) && \([\s\S]{0,400}?<CountrySwitch filters=\{filters\} onChange=\{push\} counts=\{boards\}/,
    "My leads and Team leads must render the country switch with the server's board counts",
  );
  assert.match(browserSrc, /setBoards\(body\.boards \?\? null\)/, "the counts must come from the list's own response");
  const railSrc = readFileSync("components/web-leads/FilterRail.tsx", "utf8");
  assert.match(railSrc, /<CountrySwitch filters=\{filters\} onChange=\{onChange\} \/>/, "the rail must use the same switch");
  assert.match(railSrc, /onChange\(switchCountry\(filters, c\.key\)\)/, "the switch must change boards through switchCountry");
  run("(c) My leads and Team leads report the other board, and their switch reaches it");

  // ── (d) negatives — each refused with a sentence, and nothing written ───
  const n0 = await leadCount();
  const pool = await postRecord("oasis-ai-cc", { name: "Pool try", state: "ON", stage: POOL });
  assert.equal(pool.status, 409);
  assert.equal(pool.body.error, "stage_not_creatable");
  assert.match(pool.body.message!, /prospect pool/);
  assertReadable(pool.body, "researched");

  const noRegion = await postRecord("oasis-ai-cc", { name: "Nowhere", stage: "assigned" });
  assert.equal(noRegion.status, 422);
  assert.equal(noRegion.body.error, "region_required");
  assert.deepEqual(noRegion.body.fields, ["state"]);
  assertReadable(noRegion.body, "region_required");

  const badRegion = await postRecord("oasis-ai-cc", { name: "Atlantis", state: "ZZ", stage: "assigned" });
  assert.equal(badRegion.status, 422);
  assert.equal(badRegion.body.error, "invalid_region");
  assertReadable(badRegion.body, "invalid_region");

  const forged = await postRecord("oasis-ai-cc", {
    name: "Forged", state: "ON", stage: "assigned", assigned_to: OTHER_REP,
  });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.error, "protected_lifecycle_fields");
  assert.deepEqual(forged.body.fields, ["assigned_to"]);
  assert.match(forged.body.message!, /Assigned To/);
  assertReadable(forged.body, "protected_lifecycle_fields");

  login(OPENER, "opener@oasis.test");
  const repWon = await postRecord("oasis-ai-cc", { name: "Rep Won", state: "ON", stage: "won" });
  assert.equal(repWon.status, 409, "a rep may not create a lead in Won");
  assert.equal(repWon.body.error, "stage_not_creatable");
  assert.deepEqual(repWon.body.allowed_stages, [{ key: "assigned", label: "Assigned" }]);
  assert.match(repWon.body.message!, /Won/);
  assert.match(repWon.body.message!, /Assigned/, "the refusal must name the stage the rep CAN use");
  assertReadable(repWon.body, "rep won");

  login(MEMBER, "member@oasis.test");
  const member = await postRecord("oasis-ai-cc", { name: "Member Lead", state: "ON", stage: "assigned" });
  assert.equal(member.status, 403, "a role with no sales access created a lead");
  assertReadable(member.body, "member");

  login(SUN_AGENT, "agent@sun.test");
  const sunIntoOasis = await postRecord("oasis-ai-cc", { name: "Cross Tenant", state: "ON", stage: "assigned" });
  assert.equal(sunIntoOasis.status, 403, "a SunBiz profile wrote into the OASIS namespace");
  assert.equal(sunIntoOasis.body.error, "slug_not_owned");

  assert.equal(await leadCount(), n0, "a refused create still wrote a row");
  run("(d) researched, missing/invalid region, forged owner, rep-in-Won, member and a SunBiz profile are all refused");

  // A rep's own lead: Assigned, theirs, on their pipeline and in their book.
  login(OPENER, "opener@oasis.test");
  const repLead = await postRecord("oasis-ai-cc", { name: "Rep Sourced", state: "ON", stage: "assigned" });
  assert.equal(repLead.status, 200, repLead.body.message);
  const repStored = await storedLead(repLead.body.record!.id);
  assert.equal(repStored.data.assigned_to, OPENER);
  assert.equal(repStored.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  const repBoard = await pipelineRows({ userId: OPENER, teamRole: "opener", isOwner: false }, "assigned");
  assert.ok(repBoard.includes(repLead.body.record!.id), "a rep's own lead is missing from their pipeline");
  assert.ok(!repBoard.includes(created.assigned), "a rep's pipeline shows the owner's lead");
  assert.deepEqual([...(await mineIds(openerViewer))], [repLead.body.record!.id]);
  assert.deepEqual(
    [...(await mineIds(openerViewer, CA, "team"))],
    [repLead.body.record!.id],
    "a rep's Team read must be their own book — never the pool or another rep's leads",
  );
  run("(c) a rep's lead lands in Assigned, on their own pipeline and in their own book");

  // ── quick-add: the second create door, same planner on OASIS ────────────
  login(OWNER, "cc@oasis.test");
  const qaOwner = await postQuickAdd({
    business_name: "Quick Founder Co", email: "founder@quick.test", stage: "founder_meeting_booked", state: "ON",
  });
  assert.equal(qaOwner.status, 200, qaOwner.body.message);
  assert.equal(qaOwner.body.stage, "founder_meeting_booked");
  const qaOwnerRow = await storedLead(qaOwner.body.id!);
  assert.equal(qaOwnerRow.tenantId, WEBDEV_TENANT_ID);
  assert.equal(qaOwnerRow.data.assigned_to, OWNER);
  assert.equal(qaOwnerRow.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.ok(
    (await pipelineRows({ userId: OWNER, teamRole: "owner", isOwner: true }, "founder_meeting_booked")).includes(
      qaOwner.body.id!,
    ),
    "a quick-added OASIS lead is missing from /pipeline",
  );
  // A quick-add of a lead that already exists never moves it, even for an
  // admin: its stage moves only through the lead's own lifecycle actions.
  const qaOwnerSkip = await postQuickAdd({
    business_name: "Quick Founder Co", email: "founder@quick.test", state: "ON", stage: "won",
  });
  assert.equal(qaOwnerSkip.status, 409, "quick-add moved an existing OASIS lead");
  assert.equal(qaOwnerSkip.body.error, "lead_exists");
  assert.equal(qaOwnerSkip.body.id, qaOwner.body.id);
  assertReadable(qaOwnerSkip.body, "quick-add of an existing lead");
  assert.equal((await storedLead(qaOwner.body.id!)).data.stage, "founder_meeting_booked");
  // Claim facts cannot ride in on a create: a claimed_at in the past would
  // make a hand-made lead read as an expired claim and release it to the pool.
  const claimForge = await postRecord("oasis-ai-cc", {
    name: "Claim Forge Co", state: "ON", stage: "assigned", claimed_at: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(claimForge.status, 409, JSON.stringify(claimForge.body));
  assert.equal(claimForge.body.error, "protected_lifecycle_fields");
  assert.ok((claimForge.body.fields ?? []).includes("claimed_at"), JSON.stringify(claimForge.body));
  assertReadable(claimForge.body, "claimed_at on create");

  login(OPENER, "opener@oasis.test");
  const n1 = await leadCount();
  const qaWon = await postQuickAdd({ business_name: "Rep Won Co", email: "won@quick.test", stage: "won" });
  assert.equal(qaWon.status, 409);
  assert.equal(qaWon.body.error, "stage_not_creatable");
  assertReadable(qaWon.body, "quick-add rep won");
  assert.equal(await leadCount(), n1);
  const qaDefault = await postQuickAdd({
    business_name: "Rep Default Co", phone: "4165550199", email: "repdefault@quick.test", state: "ON",
  });
  assert.equal(qaDefault.status, 200, qaDefault.body.message);
  assert.equal(qaDefault.body.stage, "assigned", "an OASIS quick-add with no stage must not land in the pool");
  const qaDefaultRow = await storedLead(qaDefault.body.id!);
  assert.equal(qaDefaultRow.data.assigned_to, OPENER);
  assert.equal(qaDefaultRow.data.stage, "assigned");
  assert.equal(qaDefaultRow.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  // The region is required on this door too: it picks the Canada or US board.
  const nNoRegion = await leadCount();
  const qaNoRegion = await postQuickAdd({ business_name: "No Region Co", email: "noregion@quick.test" });
  assert.equal(qaNoRegion.status, 422, JSON.stringify(qaNoRegion.body));
  assert.equal(qaNoRegion.body.error, "region_required");
  assertReadable(qaNoRegion.body, "quick-add without a region");
  assert.equal(await leadCount(), nNoRegion);
  // Adding the same lead again never moves it or duplicates it. Matched by
  // email: the adapter's .or() grammar turns an all-digit phone into a
  // number, so a phone-only duplicate is never found (reported separately).
  // The old default moved it to researched: back into the unclaimed pool.
  const nRepeat = await leadCount();
  const qaAgain = await postQuickAdd({ business_name: "Rep Default Co", email: "repdefault@quick.test" });
  assert.equal(qaAgain.status, 200, qaAgain.body.message);
  assert.equal(qaAgain.body.existing, true);
  assert.equal(qaAgain.body.stage, "assigned", "a repeat quick-add with no stage moved the lead");
  const qaSkip = await postQuickAdd({ business_name: "Rep Default Co", email: "repdefault@quick.test", stage: "won" });
  assert.equal(qaSkip.status, 409, "a rep moved their lead to Won by adding it again");
  assert.equal(qaSkip.body.error, "lead_exists");
  assertReadable(qaSkip.body, "quick-add stage skip");
  assert.equal((await storedLead(qaDefault.body.id!)).data.stage, "assigned");
  assert.equal(await leadCount(), nRepeat, "a repeat quick-add created a duplicate");

  login(MEMBER, "member@oasis.test");
  const qaMember = await postQuickAdd({ business_name: "Member Co", email: "member-co@quick.test", stage: "assigned" });
  assert.equal(qaMember.status, 403);
  assert.equal(qaMember.body.error, "forbidden_role");
  assertReadable(qaMember.body, "quick-add member");
  // ...and may not use this door on a lead that already exists either.
  const qaMemberAgain = await postQuickAdd({ business_name: "Rep Default Co", email: "repdefault@quick.test", stage: "won" });
  assert.equal(qaMemberAgain.status, 403);
  assert.equal(qaMemberAgain.body.error, "forbidden_role");
  assert.equal((await storedLead(qaDefault.body.id!)).data.stage, "assigned", "a member moved another rep's lead");
  run("(c)/(d) quick-add on OASIS: same planner and region rule; a repeat add never moves a lead; claim facts refused");

  // SunBiz quick-add is byte-for-byte what it was: no stage rule, no stamp.
  login(SUN_AGENT, "agent@sun.test");
  const sun = await postQuickAdd({
    business_name: "Sun Merchant",
    contact_name: "Maria Lopez",
    phone: "(305) 555-0100",
    email: "Maria@SunMerchant.test",
  });
  assert.equal(sun.status, 200, JSON.stringify(sun.body));
  assert.deepEqual(sun.body, {
    ok: true,
    id: sun.body.id,
    stage: "sent_application",
    existing: false,
    advanced: false,
  });
  const sunRow = await storedLead(sun.body.id!);
  assert.equal(sunRow.tenantId, SUN_TENANT);
  assert.deepEqual(
    sunRow.data,
    {
      business_name: "Sun Merchant",
      contact_name: "Maria Lopez",
      phone: "3055550100",
      email: "maria@sunmerchant.test",
      stage: "sent_application",
    },
    "a SunBiz quick-add grew a field — the OASIS stamp must never reach another tenant",
  );
  const audit = await seed.execute({
    sql: "SELECT content, metadata FROM lead_interactions WHERE lead_id = ?",
    args: [sun.body.id!],
  });
  assert.equal(audit.rows.length, 1);
  assert.equal(String(audit.rows[0].content), "Manually added lead at sent_application");
  assert.equal(JSON.parse(String(audit.rows[0].metadata)).stage, "sent_application");
  run("(d) quick-add for a SunBiz tenant behaves exactly as before");

  seed.close();
  console.log("oasis-create-stage-contract: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
