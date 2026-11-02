/** Permanent isolated workspace fixture: no provider calls, secrets or sends. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import type { OsViewer } from "../components/os/department/viewer";
import type { CapabilityDeps } from "../lib/os/agent-capabilities";

const dir = mkdtempSync(join(tmpdir(), "agent-capabilities-"));
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = join(dir, "fixture.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "capabilities-fixture-encryption-key-00001";
const A = "a1000000-0000-4000-8000-000000000001";
const B = "b1000000-0000-4000-8000-000000000002";
const USER = "u1000000-0000-4000-8000-000000000001";
const SECRET = "fixture-key-value-never-reaches-model-492817";
const OTHER = "another-workspace-secret-never-visible-1234";
const TO = "+14165550100";
let checks = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); checks++; console.log(`ok ${checks} - ${name}`); }
function stub(name: string, exports: Record<string, unknown>) {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/navigation", { notFound: () => { throw new Error("not_found"); }, redirect: () => { throw new Error("redirect"); } });
stub("next/headers", { cookies: async () => ({ get: () => undefined, getAll: () => [] }), headers: async () => new Headers() });
globalThis.fetch = async () => { throw new Error("UNEXPECTED_NETWORK"); };

async function main() {
  const db = createClient({ url: `file:${process.env.TURSO_DB_PATH}` });
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, tenant_id TEXT, email TEXT, full_name TEXT, display_name TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE _supabase_auth_users (id TEXT PRIMARY KEY, email TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE tenant_manifests (tenant_id TEXT, slug TEXT, manifest TEXT, updated_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT, phone_last10 TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, direction TEXT, metadata TEXT, from_phone TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT, created_by TEXT,
      last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, UNIQUE(tenant_id, service, field_key));
    INSERT INTO tenants (id,slug) VALUES ('${A}','fixture-a'),('${B}','fixture-b');
    INSERT INTO _supabase_auth_users (id,email) VALUES ('${USER}','fixture@example.test');
    INSERT INTO user_profiles (id,auth_user_id,tenant_id,email,team_role,is_owner) VALUES ('fixture-profile','${USER}','${A}','fixture@example.test','owner',1);
  `);
  for (const file of ["bravo__186_os_approvals.sql", "bravo__190_ledger_core.sql"]) {
    await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso", file), "utf8"));
  }
  const { capabilitiesFor } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const viewer = (tenantId = A, userId = USER, persona: "founder" | "sales" | "readonly" = "founder"): OsViewer => {
    const caps = capabilitiesFor(persona, "fixture-a");
    return {
      ok: true, surface: { ok: true, tenantId, userId, tenantSlug: "fixture-a", teamRole: persona === "founder" ? "owner" : persona, persona, capabilities: caps, degraded: false },
      navInput: { persona, capabilities: caps, isOperator: false, tenantSlug: "fixture-a", isOasisTenant: false, modules: resolveOsModules({ tenantSlug: "fixture-a", provisioned: true }), provisioned: true, founders: null },
      oasis: false, provisioned: true, authUserId: userId, email: "fixture@example.test",
      manifest: { agents: [{ slug: "custom-chief", display_name: "Chief", enabled: true, departments: ["chief_of_staff"] }], os: { departments: ["chief_of_staff", "sales", "marketing"] }, brand: { name: "Fixture" } } as OsViewer["manifest"],
    };
  };
  let current: OsViewer | null = viewer();
  await db.execute({ sql: "INSERT INTO tenant_manifests (tenant_id,slug,manifest,updated_at) VALUES (?,?,?,?)", args: [A, "fixture-a", JSON.stringify({ tenant_slug: "fixture-a", brand: { name: "Fixture", subtitle: "Isolated fixture", logo: "oasis", footer_label: "Fixture", footer_tagline: "Fixture" }, agents: [{ slug: "custom-chief", display_name: "Chief", enabled: true, departments: ["chief_of_staff"] }], nav: [], os: { departments: ["chief_of_staff", "sales", "marketing"], modules: [], chat_apps: [] } }), new Date().toISOString()] });
  const originalViewer = await import("../components/os/department/viewer");
  const resolveViewer: typeof originalViewer.resolveOsViewerFor = async (tenant, user) => current && current.surface.tenantId === tenant && current.surface.userId === user ? current : { ok: false, reason: "signed_out" };
  stub("../components/os/department/viewer", { ...originalViewer, resolveOsViewerFor: resolveViewer });
  const { OS_DEPARTMENTS } = await import("../lib/os/departments");
  const chief = OS_DEPARTMENTS.find(d => d.key === "chief_of_staff")!;
  const marketing = OS_DEPARTMENTS.find(d => d.key === "marketing")!;
  const { loadAgentCapabilities, currentCapabilityViewer } = await import("../lib/os/agent-capabilities");
  const { setTenantIntegrationValue } = await import("../lib/tenant-integration-store");
  const { saveAgentAccess } = await import("../lib/os/agent-access-store");
  const { saveKeyHost } = await import("../lib/os/custom-key-hosts");
  const { encryptField } = await import("../lib/field-encryption");
  const set = async (tenantId: string, service: string, fieldKey: string, value: string) => {
    const out = await setTenantIntegrationValue({ tenantId, service, fieldKey, value });
    assert.equal(out.ok, true, JSON.stringify(out));
  };
  await set(A, "custom", "first_key", SECRET);
  await set(B, "custom", "foreign_key", OTHER);
  await set(A, "quo", "api_key", SECRET);
  await saveKeyHost({ tenantId: A, key: "FIRST_KEY", host: "api.example.com" });
  await saveAgentAccess({ tenantId: A, target: { kind: "custom", key: "FIRST_KEY" }, access: ["chief_of_staff"] });
  const facts: CapabilityDeps["facts"] = async input => {
    assert.equal(input.tenantId, A); assert.equal(input.userId, USER); assert.equal(input.personal, true);
    return { keyRows: [], connections: [], serverChecks: [], agentChecks: [], appNotConfigured: [], oasisWorkspace: false };
  };
  const catalog = () => loadAgentCapabilities(viewer(), chief, Date.now(), { facts, resolveViewer });
  await check("discovery includes only assigned tenant keys and never values", async () => {
    const out = await catalog();
    assert.deepEqual(out.custom_keys.map(k => k.name), ["FIRST_KEY"]);
    assert.equal(out.custom_keys[0].website, "api.example.com");
    assert.ok(!JSON.stringify(out).includes(SECRET)); assert.ok(!JSON.stringify(out).includes(OTHER));
    assert.equal((await loadAgentCapabilities(viewer(), marketing, Date.now(), { facts, resolveViewer })).custom_keys.length, 0);
  });
  await check("new key and assignment revocation are visible on the next call", async () => {
    await set(A, "custom", "new_key", "new-fixture-value-123456789");
    assert.deepEqual((await catalog()).custom_keys.map(k => k.name), ["FIRST_KEY", "NEW_KEY"]);
    await saveAgentAccess({ tenantId: A, target: { kind: "custom", key: "FIRST_KEY" }, access: [] });
    assert.deepEqual((await catalog()).custom_keys.map(k => k.name), ["NEW_KEY"]);
    assert.equal((await catalog()).custom_keys[0].status, "website_required");
  });
  await check("removed seat and mismatched tenant or user fail closed", async () => {
    current = null; await assert.rejects(catalog, /capability_access_unavailable/);
    await assert.rejects(() => currentCapabilityViewer(viewer(), chief, async () => viewer(B)), /capability_access_unavailable/);
    await assert.rejects(() => currentCapabilityViewer(viewer(), chief, async () => viewer(A, "another-user")), /capability_access_unavailable/);
    current = viewer();
  });
  await check("unreadable assignments fail closed; corrupt per-key choice reveals no key", async () => {
    await assert.rejects(() => loadAgentCapabilities(viewer(), chief, Date.now(), { facts, resolveViewer, access: async () => ({ ok: false, error: "offline" }) }), /capability_assignments_unavailable/);
    await db.execute({ sql: "INSERT INTO tenant_integration_credentials (tenant_id,service,field_key,encrypted_value) VALUES (?,'agent_access','custom:new_key','broken')", args: [A] });
    assert.equal((await catalog()).custom_keys.length, 0);
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id=? AND service='agent_access' AND field_key='custom:new_key'", args: [A] });
  });
  const { deskToolset } = await import("../lib/os/desk/tools");
  const { DESK_TOOLS, deskPalette } = await import("../lib/os/desk/catalog");
  const { listMcpTools, callMcpTool } = await import("../lib/mcp/tools");
  const { executeTool, TOOL_DEFINITIONS } = await import("../lib/cloud-tool-runner");
  await check("API and CLI share SMS/custom tools; plan and read-only cannot propose", async () => {
    const cli = listMcpTools({ viewer: viewer(), dept: chief, prof: "propose" }).map(t => t.name);
    assert.ok(cli.includes("propose_sms") && cli.includes("use_custom_key"));
    assert.deepEqual(cli, deskToolset({ viewer: viewer(), dept: chief, agentSlug: "custom-chief" }).palette.map(t => t.name));
    assert.ok(!listMcpTools({ viewer: viewer(), dept: chief, prof: "read" }).some(t => t.name === "propose_sms"));
    assert.ok(!deskPalette("chief_of_staff", { canAct: false }).some(t => t.name === "propose_sms"));
    assert.ok(!TOOL_DEFINITIONS.some(t => ["get_credential", "add_credential"].includes(t.name)));
    for (const name of ["get_credential", "add_credential"]) {
      const result = await executeTool(name, { name: "FIRST_KEY", value: SECRET }, { tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452", userId: USER, authUserId: USER, agentKey: "bravo", isAdmin: true });
      assert.ok(!result.content.includes(SECRET)); assert.match(result.content, /not_available|settings_required/);
    }
  });
  await check("MCP custom-key call uses trusted department and current assignment", async () => {
    await saveAgentAccess({ tenantId: A, target: { kind: "custom", key: "NEW_KEY" }, access: ["chief_of_staff"] });
    const result = await callMcpTool({ viewer: viewer(), dept: chief, prof: "propose" }, "use_custom_key", { name: "NEW_KEY", url: "https://evil.test", tenant_id: B, departmentKey: "marketing" });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /website|could not/);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });
  const { proposeDeskSms } = await import("../lib/os/desk/proposals");
  const { getApprovalInTenant, decideApproval } = await import("../lib/os/approvals/store");
  const { approvalScopeFromViewer } = await import("../lib/os/approvals/scope");
  const { executeApproval } = await import("../lib/os/approvals/execute");
  const { defaultExecutorDeps } = await import("../lib/os/approvals/executors");
  const { describeOutcome } = await import("../components/os/approvals/outcome");
  let sends = 0;
  let intake = true;
  let ambiguous = false;
  const deps = defaultExecutorDeps();
  deps.isDryRun = () => false; deps.publishEvent = async () => {};
  deps.sms = {
    viewer: resolveViewer,
    stopReadiness: async () => ({ ready: intake, reason: intake ? "ready" : "pending_delivery" }),
    send: async (credentials, args) => {
      assert.equal(credentials.tenantId, A); assert.equal(credentials.apiKey, SECRET); assert.equal(args.to, TO);
      sends++;
      return ambiguous ? { ok: false, code: "quo_unreachable", reason: "Quo may have accepted it; check before sending again." } : { ok: true, id: `fixture-message-${sends}`, status: "queued", conversationId: "fixture-conversation", from: "+14165550199" };
    },
  };
  const prepare = async (body: string) => {
    const proposed = await proposeDeskSms(viewer(), chief, "custom-chief", { to: TO, body, tenant_id: B });
    const row = await getApprovalInTenant(db, A, proposed.approval_id); assert.ok(row);
    assert.equal(row.status, "pending");
    return row;
  };
  const approve = async (row: NonNullable<Awaited<ReturnType<typeof getApprovalInTenant>>>) => {
    const result = await decideApproval(db, approvalScopeFromViewer(viewer()), row.id, { kind: "approve", payloadHash: row.payload_hash }, new Date());
    assert.equal(result.ok, true);
  };
  const execute = (id: string, tenantId = A) => executeApproval(db, { tenantId, approvalId: id, approver: { userId: USER, email: null } }, deps);
  await check("proposal is tenant-bound, deduplicated, and sends nothing before approval", async () => {
    const first = await prepare("Hello fixture"); const repeat = await prepare("Hello fixture");
    assert.equal(first.id, repeat.id); assert.equal(sends, 0);
    assert.equal((await execute(first.id)).ok, false); assert.equal(sends, 0);
    assert.equal((await execute(first.id, B)).ok, false); assert.equal(sends, 0);
    await approve(first);
    const outcomes = await Promise.all([execute(first.id), execute(first.id)]);
    assert.equal(outcomes.filter(o => o.ok).length, 1); assert.equal(sends, 1);
    const receipt = await getApprovalInTenant(db, A, first.id); assert.ok(receipt);
    assert.equal(receipt.status, "executed"); assert.equal(receipt.execution_result?.outcome, "sent");
    assert.equal(receipt.execution_result?.outcome === "sent" && receipt.execution_result.message_id, "fixture-message-1");
    const ledger = await db.execute({ sql: "SELECT count(*) AS n FROM outcome_events WHERE tenant_id=?", args: [A] }); assert.ok(Number(ledger.rows[0].n) > 0);
    // The UI describes provider acceptance, never recipient delivery.
    assert.match(describeOutcome({ ...receipt, decided_by_name: null }, x => x, Date.now())!.text, /Accepted by Quo/);
  });
  await check("pending STOP intake and unknown delivery never send or replay", async () => {
    const waiting = await prepare("Pending intake fixture"); await approve(waiting); intake = false;
    const before = sends; await execute(waiting.id); assert.equal(sends, before);
    assert.equal((await getApprovalInTenant(db, A, waiting.id))?.status, "failed");
    intake = true;
    const unknown = await prepare("Ambiguous fixture"); await approve(unknown); ambiguous = true;
    await execute(unknown.id); await execute(unknown.id); assert.equal(sends, before + 1);
    assert.equal((await getApprovalInTenant(db, A, unknown.id))?.execution_result?.outcome, "failed"); ambiguous = false;
  });
  await check("revoked role, deactivated member, and removed connector grant stop execution", async () => {
    for (const mode of ["role", "seat", "grant"]) {
      current = viewer(); const row = await prepare(`Revocation ${mode}`); await approve(row);
      if (mode === "role") current = viewer(A, USER, "readonly");
      if (mode === "seat") current = null;
      if (mode === "grant") await saveAgentAccess({ tenantId: A, target: { kind: "connector", slug: "quo" }, access: [] });
      const before = sends; await execute(row.id); assert.equal(sends, before);
      assert.equal((await getApprovalInTenant(db, A, row.id))?.status, "failed");
    }
    current = viewer(); await saveAgentAccess({ tenantId: A, target: { kind: "connector", slug: "quo" }, access: "all" });
  });
  await check("members need their own stored recipient; no foreign lead or arbitrary number", async () => {
    const rep = viewer(A, USER, "sales");
    await assert.rejects(() => proposeDeskSms(rep, chief, "custom-chief", { to: TO, body: "Fixture" }), /sms_lead_required/);
    await db.execute({ sql: "INSERT INTO tenant_records VALUES ('lead-other',?,'lead',?,?,?)", args: [B, JSON.stringify({ phone: TO, assigned_to: USER }), new Date().toISOString(), new Date().toISOString()] });
    await assert.rejects(() => proposeDeskSms(rep, chief, "custom-chief", { to: TO, body: "Fixture", lead_id: "lead-other" }), /lead_not_found/);
    await db.execute({ sql: "INSERT INTO tenant_records VALUES ('lead-own',?,'lead',?,?,?)", args: [A, JSON.stringify({ phone: "+14165550101", assigned_to: USER }), new Date().toISOString(), new Date().toISOString()] });
    await assert.rejects(() => proposeDeskSms(rep, chief, "custom-chief", { to: TO, body: "Fixture", lead_id: "lead-own" }), /sms_recipient_does_not_match_lead/);
  });
  await check("renamed generic API department agent uses the same SMS dispatcher", async () => {
    const out = await executeTool("propose_sms", { to: TO, body: "Generic fixture", tenant_id: B }, { tenantId: A, userId: USER, authUserId: USER, agentKey: "custom-chief", isAdmin: true });
    assert.equal(out.is_error, false, out.content); assert.equal(JSON.parse(out.content).sent, false);
    const revoked = deskToolset({ viewer: viewer(), dept: chief, agentSlug: "custom-chief" });
    current = null;
    assert.equal((await revoked.execute("propose_sms", { to: TO, body: "Stale fixture" })).is_error, true);
    current = viewer();
    assert.ok(DESK_TOOLS.propose_sms.description.includes("sends nothing"));
  });
  await check("real profile deactivation and role changes override an API caller's stale admin flag", async () => {
    const before = sends;
    for (const revoked of ["deactivated", "read_only"]) {
      const row = await prepare(`Real seat ${revoked}`); await approve(row);
      await db.execute({ sql: "UPDATE user_profiles SET deactivated_at=?,team_role=?,is_owner=? WHERE tenant_id=? AND auth_user_id=?", args: [revoked === "deactivated" ? new Date().toISOString() : null, revoked === "read_only" ? "read_only" : "owner", revoked === "read_only" ? 0 : 1, A, USER] });
      const out = await executeTool("propose_sms", { to: TO, body: "Stale admin claim", tenant_id: B, departmentKey: "chief_of_staff" }, { tenantId: A, userId: USER, authUserId: USER, agentKey: "custom-chief", isAdmin: true });
      assert.equal(out.is_error, true, out.content);
      await executeApproval(db, { tenantId: A, approvalId: row.id, approver: { userId: USER, email: null } }, { ...deps, sms: { ...deps.sms, viewer: originalViewer.resolveOsViewerFor } });
      assert.equal((await getApprovalInTenant(db, A, row.id))?.status, "failed");
      assert.equal(sends, before);
      await db.execute({ sql: "UPDATE user_profiles SET deactivated_at=NULL,team_role='owner',is_owner=1 WHERE tenant_id=? AND auth_user_id=?", args: [A, USER] });
    }
  });
  await check("invalid text, missing tenant credential and automation proposals fail before send", async () => {
    const { validateSendSmsPayload } = await import("../lib/os/approvals/rules");
    for (const payload of [{ to: "4165550100", body: "Hello" }, { to: TO, body: "" }, { to: TO, body: "x".repeat(1601) }, { to: TO, body: "bad\0text" }, { to: TO, body: "Hello", provider: "twilio" }]) {
      assert.equal(validateSendSmsPayload(payload).ok, false);
    }
    await assert.rejects(() => proposeDeskSms(viewer(B), chief, "custom-chief", { to: TO, body: "No workspace key" }), /quo_credentials_unavailable/);
    const routine = deskToolset({ viewer: viewer(), dept: chief, agentSlug: "custom-chief", only: ["propose_sms"] });
    assert.ok(!routine.palette.some(tool => tool.name === "propose_sms"));
    assert.equal((await routine.execute("propose_sms", { to: TO, body: "Routine text" })).is_error, true);
  });
  await check("enabled custom agents without departments retain only all-agent key grants", async () => {
    const stored = await db.execute({ sql: "SELECT manifest FROM tenant_manifests WHERE tenant_id=?", args: [A] });
    const manifest = JSON.parse(String(stored.rows[0].manifest));
    manifest.agents.push({ slug: "custom-reader", display_name: "Custom reader", enabled: true, departments: [] });
    manifest.agents.push({ slug: "disabled-reader", display_name: "Off reader", enabled: false, departments: [] });
    await db.execute({ sql: "UPDATE tenant_manifests SET manifest=? WHERE tenant_id=?", args: [JSON.stringify(manifest), A] });
    await saveAgentAccess({ tenantId: A, target: { kind: "custom", key: "NEW_KEY" }, access: "all" });
    await saveKeyHost({ tenantId: A, key: "NEW_KEY", host: "api.example.com" });
    const as = (agentKey: string) => ({ tenantId: A, userId: USER, authUserId: USER, agentKey });
    const read = await executeTool("use_custom_key", { name: "NEW_KEY", url: "https://evil.test" }, as("custom-reader"));
    assert.match(read.content, /wrong_website/);
    await saveAgentAccess({ tenantId: A, target: { kind: "custom", key: "NEW_KEY" }, access: ["chief_of_staff"] });
    const restricted = await executeTool("use_custom_key", { name: "NEW_KEY", url: "https://api.example.com" }, as("custom-reader"));
    assert.match(restricted.content, /not_assigned/);
    for (const name of ["disabled-reader", "not-in-roster"]) {
      assert.match((await executeTool("use_custom_key", { name: "NEW_KEY", url: "https://api.example.com" }, as(name))).content, /agent_has_no_department_capabilities/);
    }
    assert.match((await executeTool("propose_sms", { to: TO, body: "No department grant" }, as("custom-reader"))).content, /agent_has_no_department_capabilities/);
  });
  await check("approved provider canary uses the real Quo adapter and durable STOP suppression", async () => {
    const { sendQuoSms, QUO_API_BASE } = await import("../lib/integrations/quo");
    process.env.LIVE_SEND_QUO = "1";
    process.env.PROVIDER_QUO_ENABLED = "1";
    delete process.env.BRAVO_FORCE_DRY_RUN;
    await set(A, "quo", "from_number", "+14165550199");
    let calls = 0;
    const canary = { ...deps, sms: { ...deps.sms, send: (credentials: Parameters<typeof sendQuoSms>[0], input: Parameters<typeof sendQuoSms>[1]) => sendQuoSms(credentials, input, {
      fetchImpl: async (url, init) => {
        assert.equal(String(url), `${QUO_API_BASE}/messages`); assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("authorization"), SECRET);
        assert.deepEqual(JSON.parse(String(init?.body)), { content: "Provider canary fixture", from: "+14165550199", to: [TO] });
        calls++;
        return new Response(JSON.stringify({ data: { id: "fixture-provider-accepted", status: "queued" } }), { status: 202 });
      },
    }) } };
    const row = await prepare("Provider canary fixture"); await approve(row);
    await executeApproval(db, { tenantId: A, approvalId: row.id, approver: { userId: USER, email: null } }, canary);
    const receipt = await getApprovalInTenant(db, A, row.id);
    assert.equal(receipt?.status, "executed"); assert.equal(calls, 1);
    assert.ok(receipt?.execution_result?.outcome === "sent");
    assert.equal(receipt.execution_result.message_id, "fixture-provider-accepted");
    assert.equal(receipt.execution_result.provider_status, "queued");
    assert.ok(!JSON.stringify(receipt).includes(SECRET));
    const suppressed = await prepare("Suppressed fixture"); await approve(suppressed);
    await db.execute({ sql: "INSERT INTO sunbiz_phone_suppressions VALUES (?,?)", args: [A, TO.slice(-10)] });
    await executeApproval(db, { tenantId: A, approvalId: suppressed.id, approver: { userId: USER, email: null } }, canary);
    assert.equal((await getApprovalInTenant(db, A, suppressed.id))?.status, "failed"); assert.equal(calls, 1);
    delete process.env.LIVE_SEND_QUO; delete process.env.PROVIDER_QUO_ENABLED;
  });
  await check("raw credential tools cannot be reintroduced through a resumed turn", async () => {
    assert.ok(!TOOL_DEFINITIONS.some(t => t.name === "get_credential" || t.name === "add_credential"));
    const row = await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE tenant_id=? AND service='custom' AND field_key='first_key'", args: [A] });
    assert.notEqual(row.rows[0].encrypted_value, SECRET); assert.ok(encryptField("fixture") !== "fixture");
  });
  console.log(`agent capabilities: ${checks} checks passed`);
  db.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
