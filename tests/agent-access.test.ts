/**
 * tests/agent-access.test.ts - which agents may use a custom key or an app.
 *
 * CC, 2026-10-26: a custom credential is set up for the agents that need it,
 * and the built-in apps come with the agents we know they serve. Pins:
 *
 *   1. The rules (lib/os/agent-access.ts): "all" or departments in rail order,
 *      unknown names refused; an app's suggestion is its catalog departments
 *      plus the Chief of Staff; a custom key's default is every agent.
 *   2. The store (lib/os/agent-access-store.ts), on a real libSQL file with the
 *      real encryption: a choice saves and reads back; saving the default
 *      clears the row; a choice that cannot be read fails closed.
 *   3. Enforcement (lib/cloud-tool-runner.ts): get_credential refuses a key the
 *      agent was not given; an app's tools are withheld from the agents it was
 *      not given (send_sms is Quo's); executeTool refuses them too; a read
 *      failure withholds every app tool.
 *   4. TOOL_CONNECTOR is whole: every workspace credential read in the runner
 *      belongs to a mapped tool.
 *   5. The routes save a key's agents before its value and drop them with it;
 *      the vault and the drawer use the picker; the picker toggles as described.
 *
 * Run: node --conditions=react-server --import tsx tests/agent-access.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "agent-access-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "agent-access-test-field-encryption-passphrase";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main() {
  console.log("agent access:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
  `);
  const rules = await import("../lib/os/agent-access");
  const store = await import("../lib/os/agent-access-store");
  const runner = await import("../lib/cloud-tool-runner");
  const { CONNECTOR_CATALOG } = await import("../lib/os/connectors");
  const { setTenantIntegrationValue, VAULT_CUSTOM_SERVICE } = await import("../lib/tenant-integration-store");
  const ctx = (agentKey: string) => ({ tenantId: OASIS, userId: "u1", agentKey, authUserId: "a1", isAdmin: true });
  const accessRows = async () =>
    (await db.execute({ sql: "SELECT field_key FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'agent_access' ORDER BY field_key", args: [OASIS] })).rows.map((r) => String(r.field_key));

  await check("the rules: all or departments in rail order, unknown names refused", () => {
    assert.equal(rules.normalizeAgentAccess("all"), "all");
    assert.deepEqual(rules.normalizeAgentAccess(["finance", "sales", "sales"]), ["sales", "finance"]);
    assert.deepEqual(rules.normalizeAgentAccess([]), [], "no agents is a choice");
    assert.equal(rules.normalizeAgentAccess(["sales", "salse"]), null, "a typo is refused, not dropped");
    assert.equal(rules.normalizeAgentAccess("sales"), null);
    assert.equal(rules.normalizeAgentAccess(null), null);
    assert.equal(rules.parseAgentAccess(rules.serializeAgentAccess(["marketing", "sales"])) !== null, true);
    assert.deepEqual(rules.parseAgentAccess('["marketing","sales"]'), ["sales", "marketing"]);
    assert.equal(rules.parseAgentAccess("all"), "all");
    assert.equal(rules.parseAgentAccess("not json"), null);
    assert.equal(rules.agentAccessLabel("all"), "All agents");
    assert.equal(rules.agentAccessLabel([]), "No agents");
    assert.equal(rules.agentAccessLabel(["sales", "finance"]), "Sales, Finance");
    assert.equal(rules.accessAllows("all", null), true, "every agent, even one with no department");
    assert.equal(rules.accessAllows(["sales"], "sales"), true);
    assert.equal(rules.accessAllows(["sales"], "marketing"), false);
    assert.equal(rules.accessAllows(["sales"], null), false);
    assert.equal(rules.sameAgentAccess(["sales", "finance"], ["finance", "sales"]), true);
    assert.equal(rules.sameAgentAccess("all", ["sales"]), false);
  });

  await check("the defaults: a custom key is for every agent; an app is its catalog agents plus the Chief of Staff", () => {
    assert.equal(store.defaultAccess({ kind: "custom", key: "FOO" }), "all");
    for (const def of CONNECTOR_CATALOG) {
      const want = rules.orderedDepartments(["chief_of_staff", ...def.departments]);
      assert.deepEqual(store.defaultAccess({ kind: "connector", slug: def.slug }), want, def.slug);
      assert.equal((store.defaultAccess({ kind: "connector", slug: def.slug }) as string[])[0], "chief_of_staff");
    }
    assert.equal(store.defaultAccess({ kind: "connector", slug: "texttorrent" }), "all", "a service with no card stays open");
    assert.equal(store.accessField({ kind: "custom", key: "My_Key" }), "custom:my_key");
    assert.equal(store.accessField({ kind: "connector", slug: "quo" }), "connector:quo");
  });

  await check("a choice saves, reads back, and saving the default clears its row", async () => {
    assert.deepEqual(await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: ["sales"] }), { ok: true });
    const read1 = await store.readAgentAccessOverrides(OASIS);
    assert.ok(read1.ok);
    if (read1.ok) {
      assert.deepEqual(store.effectiveAccess(read1.byField, { kind: "custom", key: "FOO" }), { access: ["sales"], saved: true });
      assert.deepEqual(store.effectiveAccess(read1.byField, { kind: "custom", key: "BAR" }), { access: "all", saved: false });
    }
    assert.deepEqual(await accessRows(), ["custom:foo"]);
    const stored = (await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE field_key = 'custom:foo'", args: [] })).rows[0];
    assert.doesNotMatch(String(stored.encrypted_value), /sales/, "stored encrypted, like every row there");
    assert.deepEqual(await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: "all" }), { ok: true });
    assert.deepEqual(await accessRows(), [], "the default is no row, so a later change to the default applies");
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: ["sales"] });
    assert.deepEqual(await store.clearAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" } }), { ok: true });
    assert.deepEqual(await accessRows(), []);
  });

  await check("agentMayUse: the agent's home department decides", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "custom", key: "FOO" }, access: ["sales"] });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "FOO" }, "sdr"), { allowed: true });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "FOO" }, "maven"), { allowed: false, reason: "set for Sales" });
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "FOO" }, "aura"), { allowed: false, reason: "set for Sales" }, "an agent with no department");
    assert.deepEqual(await store.agentMayUse(OASIS, { kind: "custom", key: "OTHER" }, "aura"), { allowed: true }, "nothing saved: every agent");
  });

  await check("get_credential refuses a key the agent was not given, and gives it to one that was", async () => {
    await setTenantIntegrationValue({ tenantId: OASIS, service: VAULT_CUSTOM_SERVICE, fieldKey: "foo", value: "s3cret-value" });
    const refused = await runner.executeTool("get_credential", { name: "FOO" }, ctx("maven"));
    const body = JSON.parse(refused.content);
    assert.equal(body.found, false);
    assert.equal(body.forbidden, true);
    assert.match(body.hint, /^FOO is set for Sales\. An owner can give this agent access in Settings > Connections > Custom keys\.$/);
    assert.doesNotMatch(refused.content, /s3cret-value/);
    const given = JSON.parse((await runner.executeTool("get_credential", { name: "FOO" }, ctx("sdr"))).content);
    assert.equal(given.found, true);
  });

  await check("an app's tools are withheld from the agents it was not given (send_sms is Quo's)", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "quo" }, access: ["sales"] });
    const forMaven = await runner.toolsWithheldFromAgent(OASIS, "maven");
    const forSdr = await runner.toolsWithheldFromAgent(OASIS, "sdr");
    assert.ok(forMaven.has("send_sms"));
    assert.ok(!forSdr.has("send_sms"));
    assert.ok(!forMaven.has("texttorrent_send"), "TextTorrent has nothing saved: open to every agent");
    const offered = runner.resolveActiveTools({ tenantId: OASIS, withheldTools: forMaven }).map((t) => t.name);
    assert.ok(!offered.includes("send_sms"), "not offered to the model at all");
    assert.ok(runner.resolveActiveTools({ tenantId: OASIS, withheldTools: forSdr }).some((t) => t.name === "send_sms"));
  });

  await check("executeTool refuses an app tool the agent was not given (the offer is not the boundary)", async () => {
    await store.saveAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "texttorrent" }, access: ["sales"] });
    const r = await runner.executeTool("texttorrent_send", { to: "+13655550100", message: "x" }, ctx("maven"));
    assert.equal(r.is_error, true);
    assert.match(r.content, /app_not_given_to_this_agent: texttorrent is set for Sales\./);
    await store.clearAgentAccess({ tenantId: OASIS, target: { kind: "connector", slug: "texttorrent" } });
  });

  await check("a choice that cannot be read fails closed", async () => {
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'agent_access', 'custom:broken', 'not-ciphertext')",
      args: [OASIS],
    });
    const overrides = await store.readAgentAccessOverrides(OASIS);
    assert.equal(overrides.ok, false);
    assert.match((await store.agentMayUse(OASIS, { kind: "custom", key: "OTHER" }, "sdr") as { reason: string }).reason, /^could not check which agents may use this/);
    const withheld = await runner.toolsWithheldFromAgent(OASIS, "bravo");
    assert.deepEqual([...withheld].sort(), Object.keys(runner.TOOL_CONNECTOR).sort(), "every app tool withheld this turn");
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE field_key = 'custom:broken'", args: [] });
  });

  await check("TOOL_CONNECTOR is whole: every credential read in the runner belongs to a mapped tool", () => {
    const src = read("lib/cloud-tool-runner.ts");
    const reads = (src.match(/get(Kixie|TextTorrent)Credentials\(ctx\.tenantId\)/g) || []).length;
    const mapped = Object.entries(runner.TOOL_CONNECTOR).filter(([, slug]) => slug === "kixie" || slug === "texttorrent").length;
    assert.equal(reads, mapped, "a new tool that reads an app's credentials must be added to TOOL_CONNECTOR");
    assert.doesNotMatch(src, /getTenantIntegrationBundle\(ctx\.tenantId/, "no tool reads a bundle directly");
    const names = new Set(runner.TOOL_DEFINITIONS.map((t) => t.name));
    for (const tool of Object.keys(runner.TOOL_CONNECTOR)) assert.ok(names.has(tool), `${tool} is a real tool`);
    assert.equal(runner.TOOL_CONNECTOR.send_sms, "quo");
  });

  await check("the routes: agents saved before the value, dropped with the key, owners only", () => {
    const custom = read("app/api/credentials/custom/route.ts");
    const post = custom.slice(custom.indexOf("export async function POST"), custom.indexOf("export async function DELETE"));
    assert.ok(post.indexOf("saveAgentAccess(") > -1 && post.indexOf("saveAgentAccess(") < post.indexOf("setTenantIntegrationValue("), "agents first");
    assert.match(post, /agents_not_saved/);
    assert.match(custom.slice(custom.indexOf("export async function DELETE")), /clearAgentAccess\(/);
    const agents = read("app/api/connections/agents/route.ts");
    assert.match(agents, /if \(!sess\.isAdmin\)/);
    assert.match(agents, /normalizeAgentAccess\(body\.agents\)/);
    assert.match(agents, /CONNECTOR_CATALOG\.some\(\(d\) => d\.slug === body\.id\)/, "only a real app");
  });

  await check("the vault and the drawer use the picker", () => {
    const vault = read("components/settings/CustomCredentialsVault.tsx");
    assert.match(vault, /JSON\.stringify\(\{ key: singleKey, value: singleValue, agents: singleAgents \}\)/);
    assert.match(vault, /JSON\.stringify\(\{ dotenv: bulkText, agents: bulkAgents \}\)/);
    assert.match(vault, /Used by: \{row\.agents === null \? "couldn't read" : agentAccessLabel\(row\.agents\)\}/);
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    assert.match(drawer, /Used by<\/h3>\s*<ConnectorAgentAccess key=\{def\.slug\} slug=\{def\.slug\} departments=\{def\.departments\} \/>/);
  });

  await check("the picker toggles: all, one off, none, back to all", async () => {
    const React = await import("react");
    (globalThis as unknown as { React: typeof React }).React = React;
    const { AgentPicker } = await import("../components/os/connections/AgentPicker");
    type Btn = { props: { children: unknown; onClick: () => void; "aria-pressed": boolean } };
    const buttons = (value: unknown, onChange: (v: unknown) => void) => {
      const tree = AgentPicker({ value: value as never, onChange }) as unknown as { props: { children: unknown[] } };
      const [allBtn, rest] = tree.props.children as [Btn, Btn[]];
      return [allBtn, ...rest];
    };
    let got: unknown;
    const sales = (v: unknown) => buttons(v, (x) => (got = x)).find((b) => b.props.children === "Sales")!;
    sales("all").props.onClick();
    assert.deepEqual(got, ["chief_of_staff", "marketing", "client_success", "finance", "operations"], "one off from all leaves the other five");
    sales(["sales"]).props.onClick();
    assert.deepEqual(got, [], "the last one off is no agents");
    buttons([], (x) => (got = x))[0].props.onClick();
    assert.equal(got, "all");
    buttons("all", (x) => (got = x))[0].props.onClick();
    assert.deepEqual(got, []);
    assert.equal(buttons("all", () => undefined).every((b) => b.props["aria-pressed"]), true);
  });

  console.log(failures ? `agent access: ${failures} failure(s)` : "agent access: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
