/**
 * consent-flags-stay-set.test.ts — a person who told us "do not call me" or
 * "stop" stays that way until a workspace OWNER or ADMIN says otherwise, and
 * that is on the record.
 *
 * THE GAP (2026-10-20). A lead record carries markers the gates read: data.dnc
 * (the call queue), data.opted_out / sms_opt_out / email_opt_out and
 * stage === "opted_out" (the drip engine), data.opted_out and status ===
 * "opted_out" (the outbound gateway), data.sms_opt_out_at (the email cool-off).
 * Nothing stopped an editor from CLEARING one. set-field wrote any key,
 * updateRecord merged any patch, and so did every caller that hands it a key a
 * client or an agent chose: the manifest PATCH, the bridge, the AI's
 * update_record (and the cloud chat tool that runs it), bulk stage moves. One
 * edit made a person who had said "stop" contactable again, and nothing showed
 * who did it.
 *
 * THE RULE. A marker that is set is lifted only by a workspace owner or admin
 * BY BASE ROLE (session.isTrueAdmin: an admin_access grant is not enough),
 * through a route that records the lift. Reps, read-only seats, AI agents, the
 * bridge, bulk edits, imports and quick-add never lift one. Setting a marker
 * (more restrictive) stays open to everyone who may edit the lead.
 *
 * "Set" is read the way the gates read it: a write lifts a marker when ANY gate
 * that reads it would flip from suppressing to not suppressing. The gates do
 * not agree with each other (the call queue reads dnc as `true` or `1`, the
 * drip engine also accepts "true" and "1", the outbound gateway wants a real
 * `true`), so the rule is checked against each gate's own source below.
 *
 * Every route runs for real through tests/_delivery-harness.ts: signed
 * sessions, real profiles, real SQL on a local libSQL file. Nothing leaves the
 * machine.
 *
 * Run: node --conditions=react-server --import tsx tests/consent-flags-stay-set.test.ts
 */
import { CLIENT_A, OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const SLUG = "client-a";
const TOKEN = "consent-flags-bridge-token-0001";
// The public form routes verify an HMAC link; a key makes them enforce it.
process.env.FORM_LINK_HMAC_KEY = "consent-flags-form-link-key-0123456789abcdef";
const LOCKED_MESSAGE =
  "This lead asked not to be contacted. Only a workspace owner or admin can lift that, and it is recorded.";

type Seat = { id: string; email: string };
const seatUser = (n: number, email: string): Seat => ({
  id: `0d000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  email,
});
const SEATS = {
  viewer: seatUser(1, "viewer@client-a.test"), // read_only
  rep: seatUser(2, "rep@client-a.test"), // member: a CRM writer, not an admin
  admin: seatUser(3, "admin@client-a.test"), // admin by team_role
  granted: seatUser(4, "granted@client-a.test"), // member plus the admin_access grant: isAdmin, not isTrueAdmin
} as const;

const lid = (n: number) => `1ead0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const L = { a: lid(1), b: lid(2), c: lid(3), oasis: lid(4), app: lid(5), phone: lid(6) };

// What each kind of lead looks like when it has been marked.
const DNC_LEAD = { name: "Dana Dnc", notes: "asked never to be called", stage: "follow_up", dnc: true, dnc_at: "2026-10-01T10:00:00.000Z" };
const STOP_LEAD = {
  name: "Olive Optout",
  stage: "follow_up",
  opted_out: true,
  sms_opt_out: true,
  email_opt_out: "1",
  sms_opt_out_at: "2026-10-01T12:00:00.000Z",
};
const STAGE_LEAD = { name: "Stan Stage", stage: "opted_out", notes: "unsubscribed" };
const STATUS_LEAD = { name: "Sia Status", stage: "follow_up", status: "opted_out" };
const CLEAN_LEAD = { name: "Cleo Clean", stage: "sent_application" };

type Res = { status: number; body: Record<string, unknown> };
type Handler = (req: never, ctx: never) => Promise<Response>;

async function call(handler: unknown, req: NextRequest, params?: Record<string, string>): Promise<Res> {
  const res = await (handler as Handler)(req as never, (params ? { params: Promise.resolve(params) } : undefined) as never);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The 409 every refusing route answers: a stable code, the keys, one plain sentence. */
function assertLocked(r: Res, fields: string[], label: string) {
  assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, "consent_flag_locked", `${label}: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body.fields, fields, `${label}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.message, LOCKED_MESSAGE, label);
}

/** Resolves the typed refusal updateRecord throws, or fails when the write was accepted. */
async function refusedWith(attempt: Promise<unknown>, fields: string[], label: string) {
  try {
    await attempt;
  } catch (e) {
    const err = e as { name?: string; code?: string; fields?: unknown; message?: string };
    assert.equal(err.name, "RecordsError", `${label}: ${err.message}`);
    assert.equal(err.code, "consent_flag_locked", `${label}: ${err.message}`);
    assert.deepEqual(err.fields, fields, label);
    assert.equal(err.message, LOCKED_MESSAGE, label);
    return;
  }
  assert.fail(`${label}: the write was accepted`);
}

async function main() {
  console.log("consent-flags-stay-set:");
  const db = await setupDatabase();
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

  // The tables the routes below touch beyond the shared harness.
  await db.executeMultiple(`
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      publisher_agent TEXT, source_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      published_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
      revoked_at TEXT, scope TEXT, paired_via TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      bridge_token_hash TEXT, previous_token_hash TEXT, token_rotated_at TEXT);
    CREATE TABLE IF NOT EXISTS form_views (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      form_id TEXT, tenant_id TEXT, lead_id TEXT, ip_address TEXT, user_agent TEXT, viewed_at TEXT DEFAULT ${NOW_SQL});
    -- The public form routes join forms to tenants; the adapter resolves that join from a real foreign key.
    DROP TABLE forms;
    CREATE TABLE forms (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
  `);

  // ── seats in Client A ─────────────────────────────────────────────────────
  const seat = (user: Seat, role: string, adminAccess = 0) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [user.id, user.email] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
              onboarding_completed_at, full_name, joined_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      args: [`p-${user.id}`, user.id, user.email, CLIENT_A, role, adminAccess, user.email],
    },
  ];
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  const draft = finalizeManifestFromWizard({ template: "custom", slug: SLUG, answers: {} });
  const manifest = parseManifest(
    JSON.parse(
      JSON.stringify({
        ...draft,
        data_model: [
          {
            name: "lead",
            label: "Lead",
            fields: [
              { name: "name", type: "string" },
              { name: "notes", type: "string" },
              { name: "stage", type: "string" },
              { name: "status", type: "string" },
              { name: "dnc", type: "boolean" },
              { name: "opted_out", type: "boolean" },
            ],
          },
          {
            name: "application",
            label: "Application",
            fields: [
              { name: "business_name", type: "string" },
              { name: "status", type: "string" },
            ],
          },
        ],
      }),
    ),
  );
  await db.batch(
    [
      ...seat(SEATS.viewer, "read_only"),
      ...seat(SEATS.rep, "member"),
      ...seat(SEATS.admin, "admin"),
      ...seat(SEATS.granted, "member", 1),
      {
        sql: "INSERT INTO tenant_manifests VALUES ('m-client-a', ?, ?, ?, 1, 1, '2026-09-01', '2026-09-01')",
        args: [CLIENT_A, SLUG, JSON.stringify(manifest)],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, scope, bridge_token_hash)
              VALUES ('pair-1', ?, NULL, 'Test PC', 'daemon', ?)`,
        args: [CLIENT_A, createHash("sha256").update(TOKEN, "utf8").digest("hex")],
      },
    ],
    "write",
  );

  // ── helpers over the database ─────────────────────────────────────────────
  const put = (id: string, data: Record<string, unknown>, tenant = CLIENT_A, entity = "lead") =>
    db.execute({
      sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, tenant_id = excluded.tenant_id, entity_type = excluded.entity_type`,
      args: [id, tenant, entity, JSON.stringify(data)],
    });
  const stored = async (id: string) =>
    JSON.parse(String((await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0].data)) as Record<string, unknown>;
  const interactions = async (leadId: string, type?: string) =>
    (
      await db.execute({
        sql: `SELECT * FROM lead_interactions WHERE lead_id = ? ${type ? "AND type = ?" : ""} ORDER BY created_at`,
        args: type ? [leadId, type] : [leadId],
      })
    ).rows;
  const wipeInteractions = () => db.execute("DELETE FROM lead_interactions");
  const meta = (row: Record<string, unknown>) => JSON.parse(String(row.metadata)) as Record<string, unknown>;

  // ── what is under test ────────────────────────────────────────────────────
  const consent = () => import("../lib/consent/lead-consent-flags");
  const setField = await import("../app/api/leads/[id]/set-field/route");
  const setStage = await import("../app/api/leads/[id]/set-stage/route");
  const records = await import("../app/api/manifest/[slug]/records/[entity]/route");
  const bulk = await import("../app/api/leads/bulk/route");
  const bridgeRecords = await import("../app/api/bridge/records/[entity]/route");
  const appEdit = await import("../app/api/applications/[id]/edit/route");
  const quickAdd = await import("../app/api/leads/quick-add/route");
  const formView = await import("../app/api/forms/view/route");
  const { signFormLink } = await import("../lib/form-links");
  const { updateRecord } = await import("../lib/manifest/data");
  const { runAction } = await import("../lib/agent-actions");
  const { executeTool } = await import("../lib/cloud-tool-runner");
  const recordCrud = (await import("../lib/workflow-steps/record-crud")).default;
  const { APPLICATION_FIELD_KEYS } = await import("../lib/forms/application-upsert");

  const setFieldAs = async (who: Seat | null, leadId: string, key: string, value: unknown) => {
    await login(who);
    return call(setField.POST, request(`/api/leads/${leadId}/set-field`, "POST", { key, value }), { id: leadId });
  };
  const patchAs = async (who: Seat | null, leadId: string, patch: Record<string, unknown>) => {
    await login(who);
    return call(records.PATCH, request(`/api/manifest/${SLUG}/records/lead?id=${leadId}`, "PATCH", { patch }), { slug: SLUG, entity: "lead" });
  };
  const setStageAs = async (who: Seat | null, leadId: string, stage: string) => {
    await login(who);
    return call(setStage.POST, request(`/api/leads/${leadId}/set-stage`, "POST", { stage }), { id: leadId });
  };
  const bulkAs = async (who: Seat | null, ids: string[], stage: string) => {
    await login(who);
    return call(bulk.POST, request("/api/leads/bulk", "POST", { op: "stage", ids, stage, entity: "lead" }));
  };
  const bridgePatch = (leadId: string, patch: Record<string, unknown>) =>
    call(bridgeRecords.PATCH, request(`/api/bridge/records/lead?id=${leadId}`, "PATCH", { patch }, { authorization: `Bearer ${TOKEN}` }), { entity: "lead" });
  const ASSISTANT = { tenantId: CLIENT_A, authUserId: USERS.clientA.id, userId: USERS.clientA.id, isAdmin: true };
  const aiPatch = (leadId: string, patch: Record<string, unknown>) =>
    runAction({ type: "update_record", payload: { entity: "lead", id: leadId, patch } }, ASSISTANT);

  // ═══ 1. THE RULE, AS A PURE FUNCTION ═══════════════════════════════════════
  await check("rule: switching a set flag off any way is a lift, for each of the four flags", async () => {
    const { liftedConsentKeys, CONSENT_FLAG_KEYS } = await consent();
    assert.deepEqual([...CONSENT_FLAG_KEYS].sort(), ["dnc", "email_opt_out", "opted_out", "sms_opt_out"]);
    for (const key of CONSENT_FLAG_KEYS) {
      for (const set of [true, 1]) {
        for (const off of [false, 0, null, "", "false", undefined]) {
          assert.deepEqual(liftedConsentKeys({ [key]: set }, { [key]: off }), [key], `${key}: ${String(set)} -> ${String(off)}`);
        }
        assert.deepEqual(liftedConsentKeys({ [key]: set, name: "x" }, { name: "x" }), [key], `${key}: removed by a whole-document write`);
      }
    }
  });

  await check("rule: 'set' is read exactly as each gate reads it (checked against the gates' own source)", async () => {
    const { liftedConsentKeys, CONSENT_FLAG_KEYS } = await consent();
    const fromSource = (file: string, pattern: RegExp, what: string): ((v: unknown) => boolean) => {
      const m = readFileSync(join(__dirname, "..", file), "utf8").match(pattern);
      assert.ok(m, `${file}: no ${what}. The consent lock must read the flag the way this gate does; change lib/consent/lead-consent-flags.ts with it.`);
      return new Function("v", `return (${m[1].replaceAll("data.dnc", "v")});`) as (v: unknown) => boolean;
    };
    const drips = ["lib/drips/enroller.ts", "lib/drips/executor.ts"].map((f) =>
      fromSource(f, /function isTruthyFlag\(v: unknown\): boolean \{\s*return ([^;]+);\s*\}/, "isTruthyFlag"),
    );
    const callQueue = [
      fromSource("lib/web-leads/claim.ts", /dnc: (data\.dnc === true \|\| data\.dnc === 1),/, "factsFrom's dnc reading"),
      fromSource("lib/web-leads/assign.ts", /const isDnc = (data\.dnc === true \|\| data\.dnc === 1);/, "assign's isDnc"),
    ];
    // Business-Empire-Agent scripts/integrations/send_gateway.py: lead_data.get("opted_out") is True
    const gateway = (v: unknown) => v === true;
    const gates: Record<string, Array<(v: unknown) => boolean>> = {
      dnc: callQueue,
      opted_out: [...drips, gateway],
      sms_opt_out: drips,
      email_opt_out: drips,
    };
    assert.deepEqual([...CONSENT_FLAG_KEYS].sort(), Object.keys(gates).sort(), "a flag was added or dropped: add its gate here");
    const values: unknown[] = [true, false, 1, 0, "1", "0", "true", "false", "TRUE", "yes", 2, null, undefined, "", [], {}];
    for (const key of CONSENT_FLAG_KEYS) {
      for (const before of values) {
        assert.equal(
          liftedConsentKeys({ [key]: before }, {}).includes(key),
          gates[key].some((reads) => reads(before)),
          `${key}: ${JSON.stringify(before)} removed`,
        );
        for (const after of values) {
          assert.equal(
            liftedConsentKeys({ [key]: before }, { [key]: after }).includes(key),
            gates[key].some((reads) => reads(before) && !reads(after)),
            `${key}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
          );
        }
      }
    }
  });

  await check("rule: leaving 'opted_out' on stage or status is a lift; entering it, staying in it, or a different spelling is not", async () => {
    const { liftedConsentKeys } = await consent();
    assert.deepEqual(liftedConsentKeys({ stage: "opted_out" }, { stage: "follow_up" }), ["stage"]);
    assert.deepEqual(liftedConsentKeys({ status: "opted_out" }, { status: "new" }), ["status"]);
    assert.deepEqual(liftedConsentKeys({ stage: "opted_out" }, {}), ["stage"], "removed");
    assert.deepEqual(liftedConsentKeys({ stage: "opted_out", status: "opted_out" }, { stage: "x", status: "y" }), ["stage", "status"]);
    assert.deepEqual(liftedConsentKeys({ stage: "follow_up" }, { stage: "opted_out" }), [], "entering");
    assert.deepEqual(liftedConsentKeys({ stage: "opted_out" }, { stage: "opted_out", notes: "x" }), [], "staying");
    assert.deepEqual(liftedConsentKeys({ stage: "Opted_Out" }, { stage: "follow_up" }), [], "the gates compare exactly");
  });

  await check("rule: clearing sms_opt_out_at, or moving it earlier, is a lift; keeping it or moving it later is not", async () => {
    const { liftedConsentKeys } = await consent();
    const T = "2026-10-01T12:00:00.000Z";
    for (const cleared of [null, undefined, ""]) {
      assert.deepEqual(liftedConsentKeys({ sms_opt_out_at: T }, { sms_opt_out_at: cleared }), ["sms_opt_out_at"], String(cleared));
    }
    assert.deepEqual(liftedConsentKeys({ sms_opt_out_at: T }, {}), ["sms_opt_out_at"], "removed");
    assert.deepEqual(liftedConsentKeys({ sms_opt_out_at: T }, { sms_opt_out_at: "2026-09-01T00:00:00.000Z" }), ["sms_opt_out_at"], "earlier ends the cool-off sooner");
    assert.deepEqual(liftedConsentKeys({ sms_opt_out_at: T }, { sms_opt_out_at: "2026-10-01T12:00:00Z" }), [], "same instant, another format");
    assert.deepEqual(liftedConsentKeys({ sms_opt_out_at: T }, { sms_opt_out_at: "2026-10-05T00:00:00.000Z" }), [], "later is more restrictive");
    assert.deepEqual(liftedConsentKeys({}, { sms_opt_out_at: T }), [], "stamping");
    assert.deepEqual(liftedConsentKeys({ name: "x" }, { name: "y" }), [], "no stamp to lift");
  });

  await check("rule: setting a flag, restating one, or editing anything else lifts nothing; a patch is read as a shallow merge", async () => {
    const { liftedConsentKeys, liftedConsentKeysByPatch } = await consent();
    assert.deepEqual(liftedConsentKeys({}, { dnc: true }), []);
    assert.deepEqual(liftedConsentKeys({ dnc: false }, { dnc: true }), []);
    assert.deepEqual(liftedConsentKeys({ dnc: true }, { dnc: true, notes: "x" }), []);
    assert.deepEqual(liftedConsentKeys({ dnc: true }, { dnc: 1 }), [], "the call queue reads 1 as set");
    assert.deepEqual(liftedConsentKeys({ sms_opt_out: true }, { sms_opt_out: "true" }), [], "the drip engine reads 'true' as set");
    assert.deepEqual(liftedConsentKeys({ dnc: true }, { dnc: "true" }), ["dnc"], "the call queue wants a real true or 1");
    assert.deepEqual(liftedConsentKeys({ opted_out: true }, { opted_out: "true" }), ["opted_out"], "the outbound gateway wants a real true");
    assert.deepEqual(liftedConsentKeysByPatch({ dnc: true, name: "a" }, { name: "b" }), []);
    assert.deepEqual(liftedConsentKeysByPatch({ dnc: true, name: "a" }, { dnc: false }), ["dnc"]);
    assert.deepEqual(liftedConsentKeysByPatch({ dnc: true }, { dnc: undefined }), ["dnc"], "an undefined value is dropped when the row is written");
    assert.deepEqual(liftedConsentKeysByPatch(null, { dnc: false }), []);
    assert.deepEqual(liftedConsentKeys({ dnc: true }, null), ["dnc"], "a whole document that is not an object clears everything");
    assert.deepEqual(liftedConsentKeys(null, { dnc: false }), []);
  });

  await check("rule: several lifts are reported once each, flags first, then stage and status, then the stamp", async () => {
    const { liftedConsentKeys } = await consent();
    const before = { email_opt_out: true, dnc: true, sms_opt_out_at: "2026-10-01T12:00:00.000Z", status: "opted_out", stage: "opted_out", opted_out: 1, sms_opt_out: "true" };
    assert.deepEqual(liftedConsentKeys(before, {}), ["dnc", "opted_out", "sms_opt_out", "email_opt_out", "stage", "status", "sms_opt_out_at"]);
  });

  // ═══ 2. updateRecord: THE CHOKEPOINT ═══════════════════════════════════════
  await check("updateRecord: a patch that clears a consent flag is refused with consent_flag_locked, and nothing is written", async () => {
    for (const [seed, patch, fields] of [
      [DNC_LEAD, { dnc: false }, ["dnc"]],
      [STOP_LEAD, { opted_out: null, notes: "kept?" }, ["opted_out"]],
      [STOP_LEAD, { sms_opt_out: 0, email_opt_out: "false" }, ["sms_opt_out", "email_opt_out"]],
      [STOP_LEAD, { sms_opt_out_at: null }, ["sms_opt_out_at"]],
    ] as Array<[Record<string, unknown>, Record<string, unknown>, string[]]>) {
      await put(L.a, seed);
      await refusedWith(updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch }), fields, JSON.stringify(patch));
      assert.deepEqual(await stored(L.a), seed, `${JSON.stringify(patch)}: the row changed`);
    }
  });

  await check("updateRecord: stage or status leaving opted_out is refused, on a lead and on an application", async () => {
    await put(L.a, STAGE_LEAD);
    await refusedWith(updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { stage: "follow_up" } }), ["stage"], "stage");
    assert.deepEqual(await stored(L.a), STAGE_LEAD);
    await put(L.a, STATUS_LEAD);
    await refusedWith(updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { status: "new" } }), ["status"], "status");
    assert.deepEqual(await stored(L.a), STATUS_LEAD);
    const application = { business_name: "Acme", status: "opted_out" };
    await put(L.app, application, CLIENT_A, "application");
    await refusedWith(updateRecord({ tenant_id: CLIENT_A, entity: "application", id: L.app, patch: { status: "declined" } }), ["status"], "application status");
    assert.deepEqual(await stored(L.app), application);
  });

  await check("updateRecord: the guarded (ifMatch) path obeys the same rule", async () => {
    await put(L.a, DNC_LEAD);
    await refusedWith(
      updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { dnc: false }, ifMatchAll: [{ field: "stage", value: "follow_up" }] }),
      ["dnc"],
      "ifMatchAll",
    );
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("updateRecord: setting a flag, editing other fields on a flagged lead, and other record types all still work", async () => {
    await put(L.a, DNC_LEAD);
    await updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { notes: "called back by mistake" } });
    await updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { opted_out: true, sms_opt_out: "true" } });
    await updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.a, patch: { dnc: true } });
    assert.deepEqual(await stored(L.a), { ...DNC_LEAD, notes: "called back by mistake", opted_out: true, sms_opt_out: "true" });
    // A flag that was never set can be written off: nothing is lifted.
    await put(L.b, CLEAN_LEAD);
    await updateRecord({ tenant_id: CLIENT_A, entity: "lead", id: L.b, patch: { dnc: false, stage: "follow_up" } });
    // Another record type that happens to use the word as a stage is not a lead.
    await put(L.c, { stage: "opted_out" }, CLIENT_A, "offer");
    await updateRecord({ tenant_id: CLIENT_A, entity: "offer", id: L.c, patch: { stage: "closed" } });
    assert.equal((await stored(L.c)).stage, "closed");
  });

  await check("updateRecord: with allowConsentLift the write goes through and is recorded first, naming the keys and who", async () => {
    await put(L.a, { ...STOP_LEAD, stage: "opted_out" });
    await wipeInteractions();
    const row = await updateRecord({
      tenant_id: CLIENT_A,
      entity: "lead",
      id: L.a,
      patch: { opted_out: false, stage: "follow_up" },
      allowConsentLift: { actorUserId: USERS.clientA.id, via: "dashboard_test" },
    } as Parameters<typeof updateRecord>[0]);
    assert.equal(row.data.opted_out, false);
    assert.equal(row.data.stage, "follow_up");
    assert.equal(row.data.sms_opt_out, true, "only what was written changed");
    const rows = await interactions(L.a, "consent_flag_lifted");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, USERS.clientA.id);
    assert.equal(rows[0].agent_source, "dashboard_test");
    assert.equal(rows[0].tenant_id, CLIENT_A);
    assert.ok(String(rows[0].content).includes("opted_out") && String(rows[0].content).includes("stage"), String(rows[0].content));
    assert.deepEqual(meta(rows[0]).keys, ["opted_out", "stage"]);
  });

  await check("updateRecord: a lift that cannot be recorded is not made (no record, no lift)", async () => {
    await put(L.a, DNC_LEAD);
    await db.execute("ALTER TABLE lead_interactions RENAME TO lead_interactions_off");
    try {
      await assert.rejects(
        updateRecord({
          tenant_id: CLIENT_A,
          entity: "lead",
          id: L.a,
          patch: { dnc: false },
          allowConsentLift: { actorUserId: USERS.clientA.id, via: "dashboard_test" },
        } as Parameters<typeof updateRecord>[0]),
        (e: { code?: string }) => e.code === "db",
      );
    } finally {
      await db.execute("ALTER TABLE lead_interactions_off RENAME TO lead_interactions");
    }
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("guardConsentLift: locked with no lifter, recorded and allowed with one, not_recorded when the record cannot be written", async () => {
    const { guardConsentLift } = await import("../lib/consent/consent-lift");
    const lifter = { actorUserId: USERS.clientA.id, via: "test" };
    const base = { tenantId: CLIENT_A, entity: "lead", recordId: L.a, before: DNC_LEAD, patch: { dnc: false } };
    await wipeInteractions();
    assert.deepEqual(await guardConsentLift({ ...base, lifter: null }), { ok: false, reason: "locked", lifted: ["dnc"] });
    assert.equal((await interactions(L.a)).length, 0, "a refusal records nothing");
    assert.deepEqual(await guardConsentLift({ ...base, patch: { notes: "x" }, lifter }), { ok: true, lifted: [] });
    assert.deepEqual(await guardConsentLift({ ...base, entity: "offer", lifter: null }), { ok: true, lifted: [] }, "other record types are not guarded");
    assert.equal((await interactions(L.a)).length, 0, "nothing lifted, nothing recorded");
    assert.deepEqual(await guardConsentLift({ ...base, lifter }), { ok: true, lifted: ["dnc"] });
    assert.equal((await interactions(L.a, "consent_flag_lifted")).length, 1);
    await db.execute("ALTER TABLE lead_interactions RENAME TO lead_interactions_off");
    try {
      assert.deepEqual(await guardConsentLift({ ...base, lifter }), { ok: false, reason: "not_recorded", lifted: ["dnc"] });
    } finally {
      await db.execute("ALTER TABLE lead_interactions_off RENAME TO lead_interactions");
    }
  });

  // ═══ 3. set-field ══════════════════════════════════════════════════════════
  await check("set-field: a rep cannot switch a consent flag off (409 consent_flag_locked); the lead is unchanged and nothing is logged", async () => {
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ["dnc", false, DNC_LEAD],
      ["dnc", "false", DNC_LEAD],
      ["opted_out", null, STOP_LEAD],
      ["sms_opt_out", 0, STOP_LEAD],
      ["email_opt_out", "", STOP_LEAD],
      ["sms_opt_out_at", null, STOP_LEAD],
    ];
    for (const [key, value, seed] of cases) {
      await put(L.a, seed);
      await wipeInteractions();
      const r = await setFieldAs(SEATS.rep, L.a, key, value);
      assertLocked(r, [key], `${key} -> ${JSON.stringify(value)}`);
      assert.deepEqual(await stored(L.a), seed, `${key}: the lead changed`);
      assert.equal((await interactions(L.a)).length, 0, `${key}: a refused edit left an audit row`);
    }
  });

  await check("set-field: writing 'true' over a real true is a lift for the call queue, so a rep cannot do it", async () => {
    await put(L.a, DNC_LEAD);
    assertLocked(await setFieldAs(SEATS.rep, L.a, "dnc", "true"), ["dnc"], "dnc true -> 'true'");
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("set-field: a read-only seat is refused (403) and the flag stays set", async () => {
    await put(L.a, DNC_LEAD);
    const r = await setFieldAs(SEATS.viewer, L.a, "dnc", false);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("set-field: an admin by the admin_access grant is not enough (409); only the base role is", async () => {
    await put(L.a, DNC_LEAD);
    assertLocked(await setFieldAs(SEATS.granted, L.a, "dnc", false), ["dnc"], "granted admin");
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("set-field: an admin and the owner can lift a flag; one audit row names the key and who did it", async () => {
    for (const [who, key, value, seed, expectedValue] of [
      [SEATS.admin, "dnc", false, DNC_LEAD, false],
      [USERS.clientA, "opted_out", null, STOP_LEAD, null],
    ] as Array<[Seat, string, unknown, Record<string, unknown>, unknown]>) {
      await put(L.a, seed);
      await wipeInteractions();
      const r = await setFieldAs(who, L.a, key, value);
      assert.equal(r.status, 200, `${who.email}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.consent_lifted, [key]);
      assert.deepEqual(await stored(L.a), { ...seed, [key]: expectedValue });
      const rows = await interactions(L.a);
      assert.equal(rows.length, 1, `${who.email}: the act is one row`);
      assert.equal(rows[0].type, "consent_flag_lifted");
      assert.equal(rows[0].actor_user_id, who.id);
      assert.equal(rows[0].agent_source, "dashboard_set_field");
      assert.ok(String(rows[0].content).includes(key), String(rows[0].content));
      assert.deepEqual(meta(rows[0]).keys, [key]);
    }
  });

  await check("set-field: a lift that cannot be recorded is not made (500, flag still set)", async () => {
    await put(L.a, DNC_LEAD);
    await db.execute("ALTER TABLE lead_interactions RENAME TO lead_interactions_off");
    let r: Res;
    try {
      r = await setFieldAs(SEATS.admin, L.a, "dnc", false);
    } finally {
      await db.execute("ALTER TABLE lead_interactions_off RENAME TO lead_interactions");
    }
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "consent_lift_not_recorded");
    assert.deepEqual(await stored(L.a), DNC_LEAD);
  });

  await check("set-field: a rep can still set a flag, restate one, move the stamp later, and edit anything else on a flagged lead", async () => {
    await put(L.a, CLEAN_LEAD);
    await wipeInteractions();
    const set = await setFieldAs(SEATS.rep, L.a, "dnc", true);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((await stored(L.a)).dnc, true);
    const edited = await interactions(L.a, "lead_field_edited");
    assert.equal(edited.length, 1, "an ordinary edit is logged as it always was");
    assert.equal(set.body.consent_lifted, undefined);

    await put(L.a, STOP_LEAD);
    for (const [key, value] of [
      ["notes", "left a voicemail"],
      ["opted_out", true],
      ["email_opt_out", "1"],
      ["sms_opt_out_at", "2026-10-05T00:00:00.000Z"],
    ] as Array<[string, unknown]>) {
      const r = await setFieldAs(SEATS.rep, L.a, key, value);
      assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
    }
    const after = await stored(L.a);
    assert.equal(after.notes, "left a voicemail");
    assert.equal(after.opted_out, true);
    assert.equal(after.sms_opt_out, true);
    assert.equal(after.sms_opt_out_at, "2026-10-05T00:00:00.000Z");

    await put(L.b, CLEAN_LEAD);
    const noop = await setFieldAs(SEATS.rep, L.b, "dnc", false);
    assert.equal(noop.status, 200, "a flag that was never set lifts nothing");
  });

  await check("set-field on OASIS: a rep who owns the lead cannot lift its flag; an admin can", async () => {
    const lead = { business_name: "Oasis Dnc Co", assigned_to: USERS.rep.id, stage: "assigned", sales_program: "website_sales_v1", dnc: true };
    await put(L.oasis, lead, OASIS);
    const refused = await setFieldAs(USERS.rep, L.oasis, "dnc", false);
    assertLocked(refused, ["dnc"], "OASIS rep");
    assert.deepEqual(await stored(L.oasis), lead);
    const ok = await setFieldAs(USERS.rep, L.oasis, "notes", "asked us not to call");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await wipeInteractions();
    const lifted = await setFieldAs(USERS.adon, L.oasis, "dnc", false);
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    assert.equal((await stored(L.oasis)).dnc, false);
    assert.equal((await interactions(L.oasis, "consent_flag_lifted")).length, 1);
  });

  // ═══ 4. the manifest records PATCH ═════════════════════════════════════════
  await check("manifest PATCH: a rep who owns the lead cannot clear a flag (403, as before); a read-only seat cannot either", async () => {
    const lead = { ...DNC_LEAD, assigned_to: SEATS.rep.id };
    await put(L.a, lead);
    const rep = await patchAs(SEATS.rep, L.a, { dnc: false });
    assert.equal(rep.status, 403, JSON.stringify(rep.body));
    const viewer = await patchAs(SEATS.viewer, L.a, { dnc: false });
    assert.equal(viewer.status, 403, JSON.stringify(viewer.body));
    assert.deepEqual(await stored(L.a), lead);
  });

  await check("manifest PATCH: an admin by the admin_access grant cannot lift a flag or a stage (409)", async () => {
    await put(L.a, DNC_LEAD);
    assertLocked(await patchAs(SEATS.granted, L.a, { dnc: false }), ["dnc"], "flag");
    assert.deepEqual(await stored(L.a), DNC_LEAD);
    await put(L.a, STAGE_LEAD);
    assertLocked(await patchAs(SEATS.granted, L.a, { stage: "follow_up", notes: "back in" }), ["stage"], "stage");
    assert.deepEqual(await stored(L.a), STAGE_LEAD);
  });

  await check("manifest PATCH: an admin by role can lift, and the lift is recorded naming the key and who", async () => {
    await put(L.a, DNC_LEAD);
    await wipeInteractions();
    const r = await patchAs(SEATS.admin, L.a, { dnc: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(L.a)).dnc, false);
    const rows = await interactions(L.a, "consent_flag_lifted");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_user_id, SEATS.admin.id);
    assert.equal(rows[0].agent_source, "dashboard_manifest_edit");
    assert.deepEqual(meta(rows[0]).keys, ["dnc"]);
    await put(L.b, STAGE_LEAD);
    const moved = await patchAs(USERS.clientA, L.b, { stage: "follow_up" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(meta((await interactions(L.b, "consent_flag_lifted"))[0]).keys, ["stage"]);
  });

  await check("manifest PATCH: an admin by the grant can still set a flag and edit other fields on a flagged lead", async () => {
    await put(L.a, DNC_LEAD);
    const r = await patchAs(SEATS.granted, L.a, { notes: "new note", opted_out: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await stored(L.a), { ...DNC_LEAD, notes: "new note", opted_out: true });
  });

  // ═══ 5. set-stage ══════════════════════════════════════════════════════════
  await check("set-stage: a rep and an admin by the grant cannot move a lead out of opted_out (409); the stage stays", async () => {
    for (const who of [SEATS.rep, SEATS.granted]) {
      await put(L.a, STAGE_LEAD);
      assertLocked(await setStageAs(who, L.a, "follow_up"), ["stage"], who.email);
      assert.deepEqual(await stored(L.a), STAGE_LEAD, `${who.email}: the lead changed`);
    }
  });

  await check("set-stage: an admin by role can, with the lift recorded beside the usual stage_changed row", async () => {
    await put(L.a, STAGE_LEAD);
    await wipeInteractions();
    const r = await setStageAs(SEATS.admin, L.a, "follow_up");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await stored(L.a)).stage, "follow_up");
    const lifted = await interactions(L.a, "consent_flag_lifted");
    assert.equal(lifted.length, 1);
    assert.equal(lifted[0].agent_source, "dashboard_set_stage");
    assert.deepEqual(meta(lifted[0]).keys, ["stage"]);
    assert.equal((await interactions(L.a, "stage_changed")).length, 1);
  });

  await check("set-stage: an ordinary stage move, and a move that leaves status alone, are unchanged for a rep", async () => {
    await put(L.a, CLEAN_LEAD);
    const r = await setStageAs(SEATS.rep, L.a, "follow_up");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await put(L.b, STATUS_LEAD);
    const kept = await setStageAs(SEATS.rep, L.b, "sent_application");
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal((await stored(L.b)).status, "opted_out");
  });

  // ═══ 6. bulk ═══════════════════════════════════════════════════════════════
  await check("bulk: an opted-out lead is left where it is and reported as skipped; the rest of the selection still moves", async () => {
    for (const who of [SEATS.rep, USERS.clientA]) {
      await put(L.a, STAGE_LEAD);
      await put(L.b, CLEAN_LEAD);
      const r = await bulkAs(who, [L.a, L.b], "follow_up");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.updated, 1, `${who.email}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.skipped, 1, `${who.email}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.failed, 0, `${who.email}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.consent_locked, [L.a]);
      assert.deepEqual(await stored(L.a), STAGE_LEAD, `${who.email}: bulk lifted the stage`);
      assert.equal((await stored(L.b)).stage, "follow_up");
    }
  });

  await check("bulk: a selection with nothing opted out has no consent_locked key and reports exactly as before", async () => {
    await put(L.a, CLEAN_LEAD);
    await put(L.b, CLEAN_LEAD);
    const r = await bulkAs(SEATS.rep, [L.a, L.b], "follow_up");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.updated, 2);
    assert.equal("consent_locked" in r.body, false);
  });

  // ═══ 7. the bridge ═════════════════════════════════════════════════════════
  await check("bridge: a daemon cannot clear a flag or leave opted_out (409); it can still set one and edit other fields", async () => {
    await put(L.a, DNC_LEAD);
    assertLocked(await bridgePatch(L.a, { dnc: false }), ["dnc"], "flag");
    assert.deepEqual(await stored(L.a), DNC_LEAD);
    await put(L.b, STAGE_LEAD);
    assertLocked(await bridgePatch(L.b, { stage: "follow_up" }), ["stage"], "stage");
    assert.deepEqual(await stored(L.b), STAGE_LEAD);
    const ok = await bridgePatch(L.a, { notes: "synced", opted_out: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await stored(L.a), { ...DNC_LEAD, notes: "synced", opted_out: true });
  });

  // ═══ 8. the AI: dashboard actions and the cloud chat's tool ════════════════
  await check("AI update_record: even in an owner's chat it cannot clear a flag or leave opted_out; it can still set one and edit", async () => {
    await put(L.a, STOP_LEAD);
    const flag = await aiPatch(L.a, { opted_out: false });
    assert.equal(flag.ok, false, JSON.stringify(flag));
    assert.match(String((flag as { error?: string }).error), /consent_flag_locked/);
    assert.deepEqual(await stored(L.a), STOP_LEAD);
    await put(L.b, STAGE_LEAD);
    const stage = await aiPatch(L.b, { stage: "follow_up" });
    assert.equal(stage.ok, false, JSON.stringify(stage));
    assert.deepEqual(await stored(L.b), STAGE_LEAD);
    const fine = await aiPatch(L.a, { notes: "asked for a callback", dnc: true });
    assert.equal(fine.ok, true, JSON.stringify(fine));
    assert.deepEqual(await stored(L.a), { ...STOP_LEAD, notes: "asked for a callback", dnc: true });
  });

  await check("cloud chat tool update_record: the same refusal, as a tool error the model sees", async () => {
    await put(L.a, DNC_LEAD);
    const r = await executeTool("update_record", { entity: "lead", id: L.a, patch: { dnc: false } }, { ...ASSISTANT, agentKey: "bravo" });
    assert.equal(r.is_error, true, r.content);
    assert.match(r.content, /consent_flag_locked/);
    assert.deepEqual(await stored(L.a), DNC_LEAD);
    const fine = await executeTool("update_record", { entity: "lead", id: L.a, patch: { notes: "ok" } }, { ...ASSISTANT, agentKey: "bravo" });
    assert.equal(fine.is_error, false, fine.content);
  });

  // ═══ 9. workflow automation ════════════════════════════════════════════════
  await check("workflow record-crud: an automation cannot clear a flag or leave opted_out; it can still merge other data", async () => {
    const ctx = { tenant_id: CLIENT_A, run_id: "run-1", trigger_event: {}, prior_outputs: {}, step_count_remaining: 10, outbound_cap_remaining: 10 };
    await put(L.a, DNC_LEAD);
    const flag = await recordCrud.execute({ operation: "update", entity_type: "lead", record_id: L.a, data: { dnc: false } }, ctx);
    assert.equal(flag.status, "failed", JSON.stringify(flag));
    assert.match((flag as { error: string }).error, /consent_flag_locked/);
    assert.deepEqual(await stored(L.a), DNC_LEAD);
    // The step finds its row by id alone, so the entity_type a workflow names is not evidence of what the row is.
    const mislabelled = await recordCrud.execute({ operation: "update", entity_type: "note", record_id: L.a, data: { dnc: false } }, ctx);
    assert.equal(mislabelled.status, "failed", JSON.stringify(mislabelled));
    assert.deepEqual(await stored(L.a), DNC_LEAD);
    await put(L.b, STAGE_LEAD);
    const stage = await recordCrud.execute({ operation: "update", entity_type: "lead", record_id: L.b, data: { stage: "follow_up" } }, ctx);
    assert.equal(stage.status, "failed", JSON.stringify(stage));
    assert.deepEqual(await stored(L.b), STAGE_LEAD);
    const fine = await recordCrud.execute({ operation: "update", entity_type: "lead", record_id: L.a, data: { notes: "merged", opted_out: true } }, ctx);
    assert.equal(fine.status, "complete", JSON.stringify(fine));
    assert.deepEqual(await stored(L.a), { ...DNC_LEAD, notes: "merged", opted_out: true });
  });

  // ═══ 10. quick-add ═════════════════════════════════════════════════════════
  await check("quick-add: re-adding an opted-out merchant leaves its stage and its flags alone", async () => {
    const lead = { ...STAGE_LEAD, business_name: "Stan Stage", phone: "5145550106", opted_out: true };
    await put(L.phone, lead);
    await login(SEATS.rep);
    const r = await call(quickAdd.POST, request("/api/leads/quick-add", "POST", { business_name: "Stan Stage", phone: "514 555 0106", stage: "follow_up" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.existing, true, "the merchant was matched, not added again");
    assert.equal(r.body.stage, "opted_out");
    assert.match(String(r.body.message), /left there instead of being moved back/);
    assert.deepEqual(await stored(L.phone), lead);
  });

  // ═══ 10b. a public link ═══════════════════════════════════════════════════
  await check("forms/view: opening an old application link does not re-open a merchant who opted out", async () => {
    // The route skips only the stages in LEAD_PIPELINE_STAGES, and opted_out is not one of them, so
    // before this change a bare page view moved the merchant to viewed_application.
    const formId = "f0f0f0f0-0000-4000-8000-000000000001";
    await db.execute({
      sql: "INSERT OR REPLACE INTO forms (id, tenant_id, slug, name, enabled) VALUES (?, ?, 'initial-lead-capture', 'Interest form', 1)",
      args: [formId, CLIENT_A],
    });
    const view = async (leadId: string) => {
      const token = signFormLink({ tenant: SLUG, form_id: formId, lead_id: leadId });
      assert.ok(token, "the form-link key is not set");
      const quiet = console.error;
      console.error = () => undefined;
      try {
        return await call(formView.POST, request("/api/forms/view", "POST", { token }));
      } finally {
        console.error = quiet;
      }
    };
    await put(L.a, STAGE_LEAD);
    const optedOut = await view(L.a);
    assert.equal(optedOut.status, 200, JSON.stringify(optedOut.body));
    assert.equal(optedOut.body.intent_inquiry_fired, false, JSON.stringify(optedOut.body));
    assert.deepEqual(await stored(L.a), STAGE_LEAD);
    await put(L.b, { name: "No stage yet" });
    const ordinary = await view(L.b);
    assert.equal(ordinary.body.intent_inquiry_fired, true, "an ordinary first view still moves the lead");
    assert.equal((await stored(L.b)).stage, "viewed_application");
  });

  // ═══ 11. the application editor ════════════════════════════════════════════
  await check("application editor: it cannot receive a consent key at all, so it is not a way around the lock", async () => {
    const { CONSENT_FLAG_KEYS } = await consent();
    for (const key of [...CONSENT_FLAG_KEYS, "sms_opt_out_at", "dnc_at", "stage", "status"]) {
      assert.equal((APPLICATION_FIELD_KEYS as readonly string[]).includes(key), false, `${key} is an editable application field`);
    }
    await put(L.app, { business_name: "Acme", status: "application_in", lead_id: L.a }, CLIENT_A, "application");
    await login(SEATS.rep);
    for (const patch of [{ dnc: false }, { opted_out: null }, { sms_opt_out: false }, { status: "application_in" }]) {
      const r = await call(appEdit.PATCH, request(`/api/applications/${L.app}/edit`, "PATCH", { patch }), { id: L.app });
      assert.equal(r.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "invalid_key", JSON.stringify(patch));
    }
  });

  // ═══ 12. who may pass allowConsentLift ═════════════════════════════════════
  await check("callers: only the owner/admin routes pass allowConsentLift (never the bridge, bulk, quick-add, the AI, imports, workflows or forms)", () => {
    const root = join(__dirname, "..");
    const filesMentioning = (token: string) => {
      const found: string[] = [];
      for (const dir of ["app", "lib", "components", "workers", "scripts"]) {
        for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
          if (!/\.(?:[cm]?[jt]sx?)$/.test(rel)) continue;
          if (readFileSync(join(root, dir, rel), "utf8").includes(token)) found.push(`${dir}/${rel.split("\\").join("/")}`);
        }
      }
      return found.sort();
    };
    const lifters = filesMentioning("allowConsentLift");
    assert.deepEqual(
      lifters,
      ["app/api/leads/[id]/set-stage/route.ts", "app/api/manifest/[slug]/records/[entity]/route.ts", "lib/manifest/data.ts"],
      `allowConsentLift appears in: ${lifters.join(", ")}`,
    );
    // The decision itself is asked by exactly the three writers that apply a patch to a lead.
    const askers = filesMentioning("guardConsentLift").filter((f) => !f.startsWith("lib/consent/"));
    assert.deepEqual(
      askers,
      ["app/api/leads/[id]/set-field/route.ts", "lib/manifest/data.ts", "lib/workflow-steps/record-crud.ts"],
      `guardConsentLift appears in: ${askers.join(", ")}`,
    );
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    assert.match(read("app/api/manifest/[slug]/records/[entity]/route.ts"), /allowConsentLift:\s*r\.is_true_admin/);
    assert.match(read("app/api/leads/[id]/set-stage/route.ts"), /allowConsentLift:\s*sess\.isTrueAdmin/);
    // set-field writes through an RPC, not updateRecord, so it names its own lifter; the step never has one.
    assert.match(read("app/api/leads/[id]/set-field/route.ts"), /lifter:\s*sess\.isTrueAdmin/);
    assert.match(read("lib/manifest/data.ts"), /lifter:\s*input\.allowConsentLift \?\? null/);
    assert.match(read("lib/workflow-steps/record-crud.ts"), /lifter:\s*null/);
  });

  finish("consent-flags-stay-set");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
