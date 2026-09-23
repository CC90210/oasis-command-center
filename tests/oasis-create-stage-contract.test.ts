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
 * The current integrity rule is deliberately simpler: every hand-created lead
 * starts in Assigned, then audited lifecycle actions move it. (a) and (b) pin
 * that single entry point to the form and server. (c) drives the REAL route
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
const READ_ONLY = "0a0a0a0a-0000-4000-8000-000000000006";
const COLD_LIST_ID = "0d0d0d0d-0000-4000-8000-000000000001";
const COLD_LEAD_ID = "0d0d0d0d-0000-4000-8000-000000000002";
const BULK_ELIGIBLE = "0c0c0c0c-0000-4000-8000-000000000001";
const BULK_WON = "0c0c0c0c-0000-4000-8000-000000000002";
const BULK_DELIVERY = "0c0c0c0c-0000-4000-8000-000000000003";
const BULK_POOL = "0c0c0c0c-0000-4000-8000-000000000004";
const SINGLE_ELIGIBLE = "0c0c0c0c-0000-4000-8000-000000000005";
const SINGLE_POOL = "0c0c0c0c-0000-4000-8000-000000000006";
const EXPIRED_CLAIM = "0c0c0c0c-0000-4000-8000-000000000007";
const OLD_ASSIGNMENT_AT = "2026-09-01T00:00:00.000Z";
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
  updated?: number;
  skipped?: number;
  failed?: number;
  trackingFailed?: number;
  claim_required?: number;
  inserted?: number;
  promoted_lead_id?: string;
  was_already_promoted?: boolean;
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
    { label: "owner", teamRole: "owner", isOwner: true, adminAccess: false, expect: ["assigned"] },
    { label: "admin", teamRole: "admin", isOwner: false, adminAccess: false, expect: ["assigned"] },
    { label: "member", teamRole: "member", isOwner: false, adminAccess: false, expect: [] as string[] },
    { label: "admin_access", teamRole: "opener", isOwner: false, adminAccess: true, expect: ["assigned"] },
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
  const ASSIGNEES = [{ userId: OPENER, label: "OASIS opener" }];
  const seedStagesBefore = [...(seedLead.fields.find((f) => f.name === "stage")!.enum_values || [])];
  for (const v of ROLE_VIEWERS) {
    const viewer = viewerFor(v);
    const form = create.oasisLeadCreateForm(seedLead, viewer, ASSIGNEES);
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
        resolvedAssigneeUserId: viewer.isAdmin ? OPENER : OWNER,
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
  const adminForm = create.oasisLeadCreateForm(seedLead, { isAdmin: true, teamRole: "owner" }, ASSIGNEES);
  assert.deepEqual(adminForm.optionLabels.stage, { assigned: "Assigned" });
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
    if (field.name === "stage" || field.name === "assigned_to") continue;
    assert.deepEqual(
      policy.rejectedOasisGenericPatchKeys({ [field.name]: "x" }),
      [],
      `the create form offers ${field.name}, which the server refuses`,
    );
  }

  // ?stage= preselects only a stage the viewer may create in.
  const adminStages = create.creatableOasisStages({ isAdmin: true, teamRole: "owner" });
  const repStages = create.creatableOasisStages({ isAdmin: false, teamRole: "opener" });
  assert.equal(create.preselectOasisCreateStage("founder_meeting_booked", adminStages), "assigned");
  assert.equal(create.preselectOasisCreateStage("founder_meeting_booked", repStages), "assigned");
  assert.equal(create.preselectOasisCreateStage(POOL, adminStages), "assigned");
  assert.equal(create.preselectOasisCreateStage(undefined, adminStages), "assigned");

  const newPage = readFileSync("app/pipeline/new/page.tsx", "utf8");
  assert.match(newPage, /const form = oasisLeadCreateForm\(leadEntity, viewer, assigneeOptions\)/);
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
  const stampNow = new Date("2026-09-23T12:00:00.000Z");
  for (const slug of ["oasis", "oasis-ai-cc", "oasis-webdev"]) {
    const filter = create.oasisBoardProgramFilter(slug);
    const stamp = create.oasisLeadCreateStamp({ stage: "assigned", ownerUserId: OPENER, sourceTrack: "company", now: stampNow });
    assert.equal(filter.salesMotion, OASIS_COLD_OUTBOUND_MOTION, `${slug} board filters on the motion`);
    assert.equal(stamp.sales_motion, filter.salesMotion, `${slug}: stamp fails the board's motion filter`);
    if (filter.salesProgram) assert.equal(stamp.sales_program, filter.salesProgram);
  }
  assert.deepEqual(create.oasisBoardProgramFilter("sun"), { salesProgram: null, salesMotion: null });
  const upper = create.oasisLeadCreateStamp({ stage: "lost", ownerUserId: OPENER.toUpperCase(), sourceTrack: "company", now: stampNow });
  assert.equal(upper.assigned_to, OPENER, "assigned_to is lowercased");
  assert.equal(upper.lost_at, stampNow.toISOString(), "a lead created as lost carries lost_at");
  assert.equal(upper.claimed_at, stampNow.toISOString(), "manual ownership must start the normal claim-expiry clock");
  assert.equal(
    "lost_at" in create.oasisLeadCreateStamp({ stage: "won", ownerUserId: OPENER, sourceTrack: "company", now: stampNow }),
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
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT,
      invited_by TEXT, manager_user_id TEXT, joined_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (
      id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE cold_lead_lists (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT,
      promoted_count INTEGER DEFAULT 0, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE cold_leads (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, list_id TEXT NOT NULL,
      business_name TEXT, contact_name TEXT, phone TEXT, email TEXT,
      stage TEXT, promoted_lead_id TEXT, raw TEXT,
      updated_at TEXT DEFAULT ${NOW_SQL}
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
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, joined_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [id, authId, email, tenant, role, owner],
  });
  const lead = (id: string, tenant: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, tenant, JSON.stringify(data)],
  });
  await seed.batch(
    [
      ...[
        [OWNER, "conaugh@oasisai.work"],
        [OPENER, "opener@oasis.test"],
        [OTHER_REP, "adon@oasisai.work"],
        [MEMBER, "member@oasis.test"],
        [SUN_AGENT, "agent@sun.test"],
        [READ_ONLY, "readonly@oasis.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-owner", OWNER, "conaugh@oasisai.work", WEBDEV_TENANT_ID, "owner", 1),
      profile("p-opener", OPENER, "opener@oasis.test", WEBDEV_TENANT_ID, "opener"),
      profile("p-closer", OTHER_REP, "adon@oasisai.work", WEBDEV_TENANT_ID, "closer"),
      profile("p-member", MEMBER, "member@oasis.test", WEBDEV_TENANT_ID, "member"),
      profile("p-sun", SUN_AGENT, "agent@sun.test", SUN_TENANT, "agent"),
      profile("p-readonly", READ_ONLY, "readonly@oasis.test", WEBDEV_TENANT_ID, "read_only"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [SUN_TENANT] },
      {
        sql: "INSERT INTO cold_lead_lists (id, tenant_id, name) VALUES (?, ?, 'Revenue reset prospects')",
        args: [COLD_LIST_ID, WEBDEV_TENANT_ID],
      },
      {
        sql: `INSERT INTO cold_leads
          (id, tenant_id, list_id, business_name, contact_name, phone, email, stage, raw)
          VALUES (?, ?, ?, 'Cold Prospect Co', 'Casey Prospect', '4165550198', 'casey@cold.test', 'imported', ?)` ,
        args: [COLD_LEAD_ID, WEBDEV_TENANT_ID, COLD_LIST_ID, JSON.stringify({ website: "https://cold.test" })],
      },
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
      // A legacy working-stage row without an owner must never consume a slot
      // or appear on the Team pipeline before the query is paginated.
      lead("unassigned-working-1", WEBDEV_TENANT_ID, {
        name: "Unassigned Working Lead", state: "ON", stage: "assigned",
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
  const bulk = await import("../app/api/leads/bulk/route");
  const singleAssign = await import("../app/api/leads/[id]/assign/route");
  const leadImport = await import("../app/api/leads/import/route");
  const genericImport = await import("../app/api/import/[entity]/route");
  const { importLeadsForTenant } = await import("../lib/leads-import-service");
  const coldPromotion = await import("../app/api/manifest/[slug]/cold-leads/[id]/promote/route");
  const { CURRENT_OASIS_PIPELINE_CYCLE, isInPipelineCycle } = await import("../lib/pipeline-cycle");
  const { listOasisPipelineWindow, resolveOasisPipelineAssigneeScope } = await import(
    "../lib/oasis-pipeline-query"
  );
  const { fetchLeads } = await import("../lib/web-leads/data");
  const { parseFilters, filtersToParams, switchCountry } = await import("../lib/web-leads/filters");
  const { EMPTY_SCORE_INDEX } = await import("../lib/web-leads/scores");

  let activeUserId: string | null = null;
  const login = (userId: string, email: string) => {
    activeUserId = userId;
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const postRecord = async (
    slug: string,
    data: Record<string, unknown>,
    options: { withoutAdminAssignee?: boolean } = {},
  ) => {
    const submitted =
      activeUserId === OWNER &&
      slug === "oasis-ai-cc" &&
      !options.withoutAdminAssignee &&
      !("assigned_to" in data)
        ? { ...data, assigned_to: OTHER_REP }
        : data;
    const req = new NextRequest(`http://localhost/api/manifest/${slug}/records/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: submitted }),
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
  const postBulk = async (body: Record<string, unknown>) => {
    const req = new NextRequest("http://localhost/api/leads/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await bulk.POST(req);
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postSingleAssign = async (id: string, assignedTo: string | null) => {
    const req = new NextRequest(`http://localhost/api/leads/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assigned_to: assignedTo }),
    });
    const res = await singleAssign.POST(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postImport = async (rows: Array<Record<string, unknown>>) => {
    const req = new NextRequest("http://localhost/api/leads/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const res = await leadImport.POST(req);
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postGenericLeadImport = async (body: Record<string, unknown>) => {
    const req = new NextRequest("http://localhost/api/import/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await genericImport.POST(req, {
      params: Promise.resolve({ entity: "leads" }),
    });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postColdPromotion = async (body: Record<string, unknown>) => {
    const req = new NextRequest(
      `http://localhost/api/manifest/oasis-ai-cc/cold-leads/${COLD_LEAD_ID}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const res = await coldPromotion.POST(req, {
      params: Promise.resolve({ slug: "oasis-ai-cc", id: COLD_LEAD_ID }),
    });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const patchRecord = async (id: string, patch: Record<string, unknown>) => {
    const req = new NextRequest(`http://localhost/api/manifest/oasis-ai-cc/records/lead?id=${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    });
    const res = await records.PATCH(req, {
      params: Promise.resolve({ slug: "oasis-ai-cc", entity: "lead" }),
    });
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
  const closerViewer = { userId: OTHER_REP, teamRole: "closer", isAdmin: false };
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
  assert.equal(
    (await pipelineRows({ userId: OWNER, teamRole: "owner", isOwner: true }, "assigned")).includes(
      "unassigned-working-1",
    ),
    false,
    "the admin pipeline paginated an unassigned working-stage row",
  );
  // A role with no scoping reads every row it is handed, so the only thing
  // keeping another rep's leads off a member's Team tab is that the team read
  // fetches its own book plus a roster it does not have. (Verifier, 2026-09-10.)
  assert.deepEqual([...(await mineIds(memberViewer, CA, "team"))], [],
    "a member's Team tab listed leads another rep holds");

  // An OWNER creates one lead at the single manual entry point. Every later
  // stage must be reached through the audited lifecycle rather than creation.
  login(OWNER, "conaugh@oasisai.work");
  const created: Record<string, string> = {};

  const beforeColdPromotion = await leadCount();
  const ownerlessColdPromotion = await postColdPromotion({});
  assert.equal(ownerlessColdPromotion.status, 422);
  assert.equal(ownerlessColdPromotion.body.error, "assignee_required");
  assert.equal(await leadCount(), beforeColdPromotion, "an ownerless OASIS cold promotion wrote a warm lead");

  login(READ_ONLY, "readonly@oasis.test");
  const readOnlyColdPromotion = await postColdPromotion({ assignee_user_id: OTHER_REP });
  assert.equal(readOnlyColdPromotion.status, 403);
  assert.equal(readOnlyColdPromotion.body.error, "forbidden_role");
  assert.equal(await leadCount(), beforeColdPromotion, "a read-only cold promotion wrote a warm lead");

  login(OWNER, "conaugh@oasisai.work");
  const assignedColdPromotion = await postColdPromotion({ assignee_user_id: OTHER_REP });
  assert.equal(assignedColdPromotion.status, 200, assignedColdPromotion.body.message);
  assert.ok(assignedColdPromotion.body.promoted_lead_id);
  const promotedColdRow = await storedLead(assignedColdPromotion.body.promoted_lead_id!);
  assert.equal(promotedColdRow.data.assigned_to, OTHER_REP);
  assert.equal(promotedColdRow.data.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
  assert.equal(promotedColdRow.data.stage, "assigned");
  await seed.execute({ sql: "DELETE FROM tenant_records WHERE id = ?", args: [assignedColdPromotion.body.promoted_lead_id!] });
  await seed.execute({
    sql: "UPDATE cold_leads SET stage = 'imported', promoted_lead_id = NULL WHERE id = ?",
    args: [COLD_LEAD_ID],
  });
  run("(c)/(d) OASIS cold promotion requires CC/Adon and CRM-write authority");

  const beforeImport = await leadCount();
  const unownedImport = await postImport([
    { name: "Unowned cycle import", email: "unowned-cycle@example.test", state: "ON", stage: "assigned" },
  ]);
  assert.equal(unownedImport.status, 422);
  assert.equal(unownedImport.body.error, "assignee_required");
  assert.equal(await leadCount(), beforeImport, "the refused import wrote a partial row");

  const ownedImport = await postImport([
    {
      name: "Owned cycle import",
      email: "owned-cycle@example.test",
      state: "ON",
      stage: "Submitted",
      requested_amount: "25000",
      assigned_to: OTHER_REP,
    },
  ]);
  assert.equal(ownedImport.status, 200, ownedImport.body.message);
  assert.equal(ownedImport.body.inserted, 1);
  const imported = await seed.execute({
    sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?",
    args: [WEBDEV_TENANT_ID, "owned-cycle@example.test"],
  });
  assert.equal(imported.rows.length, 1, "the accepted import was not stored");
  const importedData = JSON.parse(String(imported.rows[0].data)) as Record<string, unknown>;
  assert.equal(importedData.assigned_to, OTHER_REP);
  assert.equal(importedData.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
  assert.equal(typeof importedData.assigned_at, "string");
  assert.equal(importedData.sales_program, OASIS_WEBSITE_SALES_PROGRAM);
  assert.equal(importedData.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.equal(importedData.stage, "assigned");
  assert.equal(importedData.original_stage, "Submitted");
  assert.equal(
    isInPipelineCycle({ id: String(imported.rows[0].id), data: importedData }, CURRENT_OASIS_PIPELINE_CYCLE),
    true,
    "the accepted import is still hidden from the active Pipeline board",
  );
  assert.ok(
    (await pipelineRows({ userId: OTHER_REP, teamRole: "closer", isOwner: false }, "assigned"))
      .includes(String(imported.rows[0].id)),
    "the accepted legacy import does not satisfy the actual Pipeline query",
  );
  run("(c) OASIS imports require CC/Adon and land visibly in the current cycle");
  await seed.execute({
    sql: "DELETE FROM tenant_records WHERE id = ?",
    args: [String(imported.rows[0].id)],
  });

  const genericBefore = await leadCount();
  const ownerlessGeneric = await postGenericLeadImport({
    rows: [{ business_name: "Ownerless generic import", email: "ownerless-generic@example.test" }],
  });
  assert.equal(ownerlessGeneric.status, 422);
  assert.equal(ownerlessGeneric.body.error, "assignee_required");
  assert.equal(await leadCount(), genericBefore, "the ownerless generic import wrote a row");

  const forgedGeneric = await postGenericLeadImport({
    assignee_user_id: SUN_AGENT,
    rows: [{ business_name: "Forged generic import", email: "forged-generic@example.test" }],
  });
  assert.equal(forgedGeneric.status, 422);
  assert.equal(forgedGeneric.body.error, "target_not_on_sales_roster");
  assert.equal(await leadCount(), genericBefore, "the forged generic import wrote a row");

  login(READ_ONLY, "readonly@oasis.test");
  const readonlyGeneric = await postGenericLeadImport({
    assignee_user_id: OTHER_REP,
    rows: [{ business_name: "Readonly generic import", email: "readonly-generic@example.test" }],
  });
  assert.equal(readonlyGeneric.status, 403);
  assert.equal(readonlyGeneric.body.error, "forbidden_role");
  assert.equal(await leadCount(), genericBefore, "the read-only generic import wrote a row");

  login(OWNER, "conaugh@oasisai.work");
  const acceptedGeneric = await postGenericLeadImport({
    assignee_user_id: OTHER_REP,
    rows: [{
      business_name: "Accepted generic import",
      email: "accepted-generic@example.test",
      stage: "Hot Lead",
    }],
  });
  assert.equal(acceptedGeneric.status, 200, acceptedGeneric.body.message);
  assert.equal(acceptedGeneric.body.inserted, 1);
  const genericStored = await seed.execute({
    sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?",
    args: [WEBDEV_TENANT_ID, "accepted-generic@example.test"],
  });
  assert.equal(genericStored.rows.length, 1);
  const genericData = JSON.parse(String(genericStored.rows[0].data)) as Record<string, unknown>;
  assert.equal(genericData.assigned_to, OTHER_REP);
  assert.equal(genericData.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
  assert.equal(genericData.sales_program, OASIS_WEBSITE_SALES_PROGRAM);
  assert.equal(genericData.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.equal(genericData.stage, "assigned");
  assert.ok(
    (await pipelineRows({ userId: OTHER_REP, teamRole: "closer", isOwner: false }, "assigned"))
      .includes(String(genericStored.rows[0].id)),
    "the accepted generic import does not satisfy the actual Pipeline query",
  );
  await seed.execute({
    sql: "DELETE FROM tenant_records WHERE id = ?",
    args: [String(genericStored.rows[0].id)],
  });
  run("(c)/(d) generic OASIS imports require CC/Adon and satisfy the live board predicate");

  const chatImport = await importLeadsForTenant({
    tenantId: WEBDEV_TENANT_ID,
    assignee: "adon@oasisai.work",
    rows: [{
      business_name: "Accepted chat import",
      email: "accepted-chat@example.test",
      stage: "Sent Application",
      requested_amount: "30000",
    }],
    defaultSource: "chat_attachment:test.csv",
  });
  assert.equal(chatImport.ok, true);
  if (!chatImport.ok) throw new Error(chatImport.error);
  assert.equal(chatImport.inserted, 1);
  const chatStored = await seed.execute({
    sql: "SELECT id, entity_type, data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?",
    args: [WEBDEV_TENANT_ID, "accepted-chat@example.test"],
  });
  assert.equal(chatStored.rows.length, 1);
  assert.equal(String(chatStored.rows[0].entity_type), "lead");
  const chatData = JSON.parse(String(chatStored.rows[0].data)) as Record<string, unknown>;
  assert.equal(chatData.assigned_to, OTHER_REP);
  assert.equal(chatData.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
  assert.equal(chatData.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.equal(chatData.stage, "assigned");
  assert.ok(
    (await pipelineRows({ userId: OTHER_REP, teamRole: "closer", isOwner: false }, "assigned"))
      .includes(String(chatStored.rows[0].id)),
    "the accepted chat import does not satisfy the actual Pipeline query",
  );
  await seed.execute({
    sql: "DELETE FROM tenant_records WHERE id = ?",
    args: [String(chatStored.rows[0].id)],
  });
  run("(c) chat attachment imports default/resolve CC+Adon and remain OASIS leads");

  login(SUN_AGENT, "agent@sun.test");
  const legacyAssignedImport = await postImport([
    {
      name: "Assigned legacy import",
      email: "assigned-legacy-import@example.test",
      state: "FL",
      assigned_to: SUN_AGENT,
    },
  ]);
  assert.equal(legacyAssignedImport.status, 200, legacyAssignedImport.body.message);
  const legacyImported = await seed.execute({
    sql: "SELECT id, data FROM tenant_records WHERE tenant_id = ? AND json_extract(data, '$.email') = ?",
    args: [SUN_TENANT, "assigned-legacy-import@example.test"],
  });
  assert.equal(legacyImported.rows.length, 1, "the non-OASIS import was not stored");
  const legacyImportedData = JSON.parse(String(legacyImported.rows[0].data)) as Record<string, unknown>;
  assert.equal(
    legacyImportedData.assigned_to,
    SUN_AGENT,
    "the founder-only OASIS guard must not strip a legacy tenant's existing owner",
  );
  await seed.execute({
    sql: "DELETE FROM tenant_records WHERE id = ?",
    args: [String(legacyImported.rows[0].id)],
  });
  run("(d) non-OASIS imports retain their prior assignment behavior");
  login(OWNER, "conaugh@oasisai.work");

  const createdAssigned = await postRecord("oasis-ai-cc", {
    name: "Owner lead assigned",
    company: "Assigned Company",
    state: "ON",
    stage: "assigned",
  });
  assert.equal(createdAssigned.status, 200, createdAssigned.body.message);
  const storedAssigned = await storedLead(createdAssigned.body.record!.id);
  assert.equal(storedAssigned.tenantId, WEBDEV_TENANT_ID);
  assert.equal(storedAssigned.data.stage, "assigned");
  assert.equal(storedAssigned.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.equal(storedAssigned.data.sales_program, OASIS_WEBSITE_SALES_PROGRAM);
  assert.equal(storedAssigned.data.assigned_to, OTHER_REP);
  assert.equal(storedAssigned.data.lead_source_track, "company");
  assert.equal(storedAssigned.data.sourced_by_user_id, null);
  assert.equal(typeof storedAssigned.data.assigned_at, "string");
  assert.equal(typeof storedAssigned.data.stage_entered_at, "string");
  assert.equal(typeof storedAssigned.data.claimed_at, "string");
  created.assigned = createdAssigned.body.record!.id;

  const provenanceRewrite = await patchRecord(created.assigned, {
    lead_source_track: "self",
    sourced_by_user_id: OPENER,
  });
  assert.equal(provenanceRewrite.status, 409, "generic manifest PATCH rewrote commission provenance");
  assert.equal(provenanceRewrite.body.error, "use_website_sales_workflow");
  assert.deepEqual(provenanceRewrite.body.fields, ["lead_source_track", "sourced_by_user_id"]);
  const provenanceAfterPatch = await storedLead(created.assigned);
  assert.equal(provenanceAfterPatch.data.lead_source_track, "company");
  assert.equal(provenanceAfterPatch.data.sourced_by_user_id, null);

  for (const stage of BOARD_ALL.filter((key) => key !== "assigned")) {
    const refused = await postRecord("oasis-ai-cc", {
      name: `No create ${stage}`,
      state: "ON",
      stage,
    });
    assert.equal(refused.status, 409, `admin created directly in ${stage}`);
    assert.equal(refused.body.error, "stage_not_creatable");
    assert.deepEqual(refused.body.allowed_stages, [{ key: "assigned", label: "Assigned" }]);
  }
  run("(c) an owner creates only in Assigned; every later lifecycle stage is refused");

  const assignedIds = await pipelineRows({ userId: OWNER, teamRole: "owner", isOwner: true }, "assigned");
  assert.ok(assignedIds.includes(created.assigned), "/pipeline?stage=assigned misses the lead just created there");
  run("(c) the new lead appears on /pipeline in Assigned");

  const ownerMine = await mineIds(ownerViewer);
  assert.equal(ownerMine.size, 0, "admin-created leads must not silently enter the admin's own book");
  const assignedRepMine = await mineIds(closerViewer);
  assert.ok(assignedRepMine.has(created.assigned), "the selected rep's My leads misses the new lead");
  assert.equal(assignedRepMine.size, 2, "the selected rep's book has an unexpected row count");
  const ownerTeam = await mineIds(ownerViewer, CA, "team");
  assert.ok(ownerTeam.has(created.assigned), "Team leads misses the new Assigned lead");
  assert.ok(ownerTeam.has("other-rep-1"), "an admin's Team leads must show every rep's book");
  assert.ok(!ownerTeam.has("pool-1"), "Team leads is a book — the prospect pool must not flood it");
  run("(c) each lead appears in /web-leads My leads and Team leads immediately, with no phone");

  // D7: the region code decides the board, and it is normalised.
  const us = await postRecord("oasis-ai-cc", { name: "Miami Lead", state: "fl", stage: "assigned" });
  assert.equal(us.status, 200, us.body.message);
  assert.equal((await storedLead(us.body.record!.id)).data.state, "FL");
  assert.ok(!(await mineIds(closerViewer)).has(us.body.record!.id), "a US lead appeared on the Canada board");
  assert.ok((await mineIds(closerViewer, US)).has(us.body.record!.id), "a US lead is missing from the US board");
  run("(c) a US region code puts the lead on the US board, not the Canada one");

  // ...and the book the page opens on SAYS where it is. My leads and Team
  // leads show one country board at a time and open on Canada; until this
  // change neither tab had a country switch, so this lead was on no screen CC
  // could reach from the page (review, 2026-09-10). The book read now counts
  // both boards, and the book tabs render the rail's own switch.
  const caBook = await fetchLeads(CA, [], closerViewer, EMPTY_SCORE_INDEX, { scope: "mine", now: Date.now() });
  assert.deepEqual(caBook.boards, { ca: 2, us: 1 }, "My leads on Canada must report the US lead");
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
    (await mineIds(closerViewer, switched)).has(us.body.record!.id),
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

  // Nothing a person types into /pipeline/new is dropped: a value in every
  // field the form offers goes through the real route and comes back from the
  // row. The form is an allow-list now (portal audit, 2026-09-11), so a field
  // added to it that the route refused or lost would fail here. It runs after
  // the board counts above, which count the owner's leads exactly.
  const typed: Record<string, string> = {
    name: "Boulangerie Saint-Denis",
    company: "Boulangerie Saint-Denis Inc.",
    email: "owner@boulangerie.test",
    phone: "+1 514 555 0100",
    website: "https://boulangerie.test",
    industry: "Bakery",
    business_city: "Montreal",
    state: "QC",
    source: "referral",
    assigned_to: OTHER_REP,
    stage: "assigned",
    notes: "Met at the market. Wants online ordering.",
  };
  assert.deepEqual(
    Object.keys(typed).sort(),
    adminForm.entity.fields.map((f) => f.name).sort(),
    "the probe must type into exactly the fields the new-lead form offers",
  );
  const full = await postRecord("oasis-ai-cc", typed);
  assert.equal(full.status, 200, `${full.body.error} — ${full.body.message}`);
  const fullRow = await storedLead(full.body.record!.id);
  for (const [key, value] of Object.entries(typed)) {
    assert.equal(fullRow.data[key], value, `${key} was typed into the new-lead form and is missing from the saved lead`);
  }
  run("(c) every field the new-lead form offers is saved as typed");

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

  const missingAssignee = await postRecord(
    "oasis-ai-cc",
    { name: "Ownerless", state: "ON", stage: "assigned" },
    { withoutAdminAssignee: true },
  );
  assert.equal(missingAssignee.status, 422);
  assert.equal(missingAssignee.body.error, "assignee_required");
  assert.deepEqual(missingAssignee.body.fields, ["assigned_to"]);

  const forged = await postRecord("oasis-ai-cc", {
    name: "Forged", state: "ON", stage: "assigned", assigned_to: SUN_AGENT,
  });
  assert.equal(forged.status, 422);
  assert.equal(forged.body.error, "target_not_on_sales_roster");
  assert.deepEqual(forged.body.fields, ["assigned_to"]);
  assertReadable(forged.body, "target_not_on_sales_roster");

  login(OPENER, "opener@oasis.test");
  const repOutsideCycle = await postRecord("oasis-ai-cc", { name: "Rep Outside Cycle", state: "ON", stage: "assigned" });
  assert.equal(repOutsideCycle.status, 403, "a non-founder rep created a lead owned outside CC+Adon");
  assert.equal(repOutsideCycle.body.error, "target_not_on_sales_roster");
  assertReadable(repOutsideCycle.body, "rep outside current assignment roster");

  login(MEMBER, "member@oasis.test");
  const member = await postRecord("oasis-ai-cc", { name: "Member Lead", state: "ON", stage: "assigned" });
  assert.equal(member.status, 403, "a role with no sales access created a lead");
  assertReadable(member.body, "member");

  login(SUN_AGENT, "agent@sun.test");
  const sunIntoOasis = await postRecord("oasis-ai-cc", { name: "Cross Tenant", state: "ON", stage: "assigned" });
  assert.equal(sunIntoOasis.status, 403, "a SunBiz profile wrote into the OASIS namespace");
  assert.equal(sunIntoOasis.body.error, "slug_not_owned");

  assert.equal(await leadCount(), n0, "a refused create still wrote a row");
  run("(d) researched, missing/invalid region, forged owner, non-founder rep, member and a SunBiz profile are all refused");

  // A rep's own lead: Assigned, theirs, on their pipeline and in their book.
  login(OTHER_REP, "adon@oasisai.work");
  const repLead = await postRecord("oasis-ai-cc", { name: "Rep Sourced", state: "ON", stage: "assigned" });
  assert.equal(repLead.status, 200, repLead.body.message);
  const repStored = await storedLead(repLead.body.record!.id);
  assert.equal(repStored.data.assigned_to, OTHER_REP);
  assert.equal(repStored.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION);
  assert.equal(repStored.data.lead_source_track, "self");
  assert.equal(repStored.data.sourced_by_user_id, OTHER_REP);
  assert.equal(typeof repStored.data.claimed_at, "string");
  const repBoard = await pipelineRows({ userId: OTHER_REP, teamRole: "closer", isOwner: false }, "assigned");
  assert.ok(repBoard.includes(repLead.body.record!.id), "Adon's own lead is missing from their pipeline");
  assert.ok((await mineIds(closerViewer)).has(repLead.body.record!.id));
  assert.equal((await mineIds(openerViewer)).has(repLead.body.record!.id), false);
  assert.deepEqual(
    [...(await mineIds(openerViewer, CA, "team"))],
    [],
    "a rep's Team read must be their own book — never the pool or another rep's leads",
  );
  run("(c) an allowlisted CC+Adon lead lands in Assigned and every other rep is refused");

  // Bulk assignment is useful for pre-handoff sales work, but it must use the
  // same roster and lifecycle boundary as the single-lead handoff.
  await seed.batch(
    [
      lead(BULK_ELIGIBLE, WEBDEV_TENANT_ID, {
        name: "Bulk eligible", state: "ON", stage: "assigned", assigned_to: OPENER,
        lead_source_track: "self", sourced_by_user_id: OPENER,
        claimed_at: OLD_ASSIGNMENT_AT, assigned_at: OLD_ASSIGNMENT_AT, last_call_at: OLD_ASSIGNMENT_AT,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(BULK_WON, WEBDEV_TENANT_ID, {
        name: "Bulk won", state: "ON", stage: "won", assigned_to: OPENER,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(BULK_DELIVERY, WEBDEV_TENANT_ID, {
        name: "Bulk delivery", state: "ON", stage: "in_build", assigned_to: OPENER,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(BULK_POOL, WEBDEV_TENANT_ID, {
        name: "Bulk pool", state: "ON", stage: "researched", assigned_to: null,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(SINGLE_ELIGIBLE, WEBDEV_TENANT_ID, {
        name: "Single eligible", state: "ON", stage: "connected", assigned_to: OPENER,
        lead_source_track: "self", sourced_by_user_id: OPENER,
        claimed_at: OLD_ASSIGNMENT_AT, assigned_at: OLD_ASSIGNMENT_AT, last_call_at: OLD_ASSIGNMENT_AT,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(SINGLE_POOL, WEBDEV_TENANT_ID, {
        name: "Single pool", state: "ON", stage: "researched", assigned_to: null,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
      lead(EXPIRED_CLAIM, WEBDEV_TENANT_ID, {
        name: "Expired claim", state: "ON", stage: "assigned", assigned_to: OPENER,
        lead_source_track: "self", sourced_by_user_id: OPENER,
        claimed_at: "2000-01-01T00:00:00.000Z", last_call_at: null,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
    ],
    "write",
  );
  login(OWNER, "conaugh@oasisai.work");
  const invalidSingleTarget = await postSingleAssign(BULK_ELIGIBLE, MEMBER);
  assert.equal(invalidSingleTarget.status, 422, "single assignment accepted a non-sales tenant member");
  assert.equal(invalidSingleTarget.body.error, "target_not_on_sales_roster");
  assert.equal((await storedLead(BULK_ELIGIBLE)).data.assigned_to, OPENER);

  const refusedSingleClear = await postSingleAssign(SINGLE_ELIGIBLE, null);
  assert.equal(refusedSingleClear.status, 422, "single assignment left an active OASIS lead ownerless");
  assert.equal(refusedSingleClear.body.error, "assignee_required");
  assert.match(refusedSingleClear.body.message!, /Leads.*Release/i);
  assert.equal((await storedLead(SINGLE_ELIGIBLE)).data.assigned_to, OPENER);

  const singlePool = await postSingleAssign(SINGLE_POOL, OTHER_REP);
  assert.equal(singlePool.status, 409, "generic single assignment partially claimed a pool lead");
  assert.equal(singlePool.body.error, "use_web_leads_claim");
  assert.equal((await storedLead(SINGLE_POOL)).data.assigned_to, null);
  assert.equal((await storedLead(SINGLE_POOL)).data.stage, "researched");

  const singleExpired = await postSingleAssign(EXPIRED_CLAIM, OTHER_REP);
  assert.equal(singleExpired.status, 409, "generic single assignment bypassed the Leads claim path for an expired claim");
  assert.equal(singleExpired.body.error, "use_web_leads_claim");
  assert.equal((await storedLead(EXPIRED_CLAIM)).data.assigned_to, OPENER);

  const validSingle = await postSingleAssign(SINGLE_ELIGIBLE, OTHER_REP);
  assert.equal(validSingle.status, 200, validSingle.body.message);
  const singleAfter = await storedLead(SINGLE_ELIGIBLE);
  assert.equal(singleAfter.data.assigned_to, OTHER_REP);
  assert.equal(singleAfter.data.stage, "connected", "active transfer rewound the lifecycle stage");
  assert.equal(singleAfter.data.lead_source_track, "self");
  assert.equal(singleAfter.data.sourced_by_user_id, OPENER, "single reassignment rewrote frozen source credit");
  assert.notEqual(singleAfter.data.claimed_at, OLD_ASSIGNMENT_AT);
  assert.equal(singleAfter.data.assigned_at, singleAfter.data.claimed_at);
  assert.equal(singleAfter.data.last_call_at, null, "the previous owner's call clock leaked into the new book");

  const invalidBulkTarget = await postBulk({
    op: "assign",
    ids: [BULK_ELIGIBLE],
    assigned_to: MEMBER,
  });
  assert.equal(invalidBulkTarget.status, 422, "bulk assignment accepted a non-sales tenant member");
  assert.equal(invalidBulkTarget.body.error, "target_not_on_sales_roster");
  assert.equal((await storedLead(BULK_ELIGIBLE)).data.assigned_to, OPENER);

  const guardedBulk = await postBulk({
    op: "assign",
    ids: [BULK_ELIGIBLE, BULK_WON, BULK_DELIVERY, BULK_POOL, EXPIRED_CLAIM],
    assigned_to: OTHER_REP,
  });
  assert.equal(guardedBulk.status, 200, guardedBulk.body.message);
  assert.deepEqual(
    {
      updated: guardedBulk.body.updated,
      skipped: guardedBulk.body.skipped,
      failed: guardedBulk.body.failed,
    },
    { updated: 1, skipped: 4, failed: 0 },
    "bulk assignment must update only the eligible pre-handoff lead",
  );
  assert.equal(guardedBulk.body.claim_required, 2);
  assert.match(guardedBulk.body.message!, /Leads.*Assign/i);
  const reassignedEligible = await storedLead(BULK_ELIGIBLE);
  assert.equal(reassignedEligible.data.assigned_to, OTHER_REP);
  assert.equal(reassignedEligible.data.stage, "assigned");
  assert.equal(reassignedEligible.data.lead_source_track, "self");
  assert.equal(reassignedEligible.data.sourced_by_user_id, OPENER, "reassignment rewrote immutable source credit");
  assert.notEqual(reassignedEligible.data.claimed_at, OLD_ASSIGNMENT_AT);
  assert.equal(reassignedEligible.data.assigned_at, reassignedEligible.data.claimed_at);
  assert.equal(reassignedEligible.data.last_call_at, null);
  assert.equal((await storedLead(BULK_WON)).data.assigned_to, OPENER, "Won ownership changed out of band");
  assert.equal((await storedLead(BULK_DELIVERY)).data.assigned_to, OPENER, "delivery ownership changed out of band");
  assert.equal((await storedLead(BULK_POOL)).data.assigned_to, null, "bulk assign partially claimed a pool row");
  assert.equal((await storedLead(EXPIRED_CLAIM)).data.assigned_to, OPENER, "bulk assign bypassed canonical re-claim for an expired row");
  run("(c)/(d) bulk assignment accepts a sales-roster target and refuses guarded stages");

  // ── quick-add: the second create door, same planner on OASIS ────────────
  login(OWNER, "conaugh@oasisai.work");
  const qaAdminSkip = await postQuickAdd({
    business_name: "Quick Stage Skip", email: "stage-skip@quick.test", stage: "won", state: "ON",
  });
  assert.equal(qaAdminSkip.status, 409, "admin quick-add bypassed the roster-bound Pipeline form");
  assert.equal(qaAdminSkip.body.error, "use_pipeline_new");
  assertReadable(qaAdminSkip.body, "quick-add admin won");
  const qaOwner = await postQuickAdd({
    business_name: "Quick Founder Co", email: "founder@quick.test", stage: "assigned", state: "ON",
  });
  assert.equal(qaOwner.status, 409, "admin quick-add created an admin-owned Pipeline lead");
  assert.equal(qaOwner.body.error, "use_pipeline_new");
  assert.match(qaOwner.body.message!, /New lead/i);
  assertReadable(qaOwner.body, "quick-add admin assigned");
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
  const qaOutsideRoster = await postQuickAdd({ business_name: "Rep Outside Co", email: "outside@quick.test", stage: "assigned", state: "ON" });
  assert.equal(qaOutsideRoster.status, 403);
  assert.equal(qaOutsideRoster.body.error, "target_not_on_sales_roster");
  assertReadable(qaOutsideRoster.body, "quick-add rep outside roster");
  assert.equal(await leadCount(), n1);
  login(OTHER_REP, "adon@oasisai.work");
  const qaDefault = await postQuickAdd({
    business_name: "Rep Default Co", phone: "4165550199", email: "repdefault@quick.test", state: "ON",
  });
  assert.equal(qaDefault.status, 200, qaDefault.body.message);
  assert.equal(qaDefault.body.stage, "assigned", "an OASIS quick-add with no stage must not land in the pool");
  const qaDefaultRow = await storedLead(qaDefault.body.id!);
  assert.equal(qaDefaultRow.data.assigned_to, OTHER_REP);
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
