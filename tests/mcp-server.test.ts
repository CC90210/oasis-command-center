/**
 * mcp-server.test.ts - the OASIS MCP server (app/api/mcp, lib/mcp/*): a
 * department agent running as a CLI on the operator's PC gets the workspace's
 * live tools through a 60-minute signed bearer, and the workspace's credentials
 * never leave the Worker.
 *
 * What must hold:
 *   - the bearer is a claim, not a permission: forged, tampered, expired,
 *     wrong-audience and unknown-key bearers are refused, and the member's seat
 *     is re-read on EVERY tools call (a removed seat or a lowered role bites on
 *     the next call);
 *   - tools/list is exactly the desk's palette for the bearer's department and
 *     profile ("read" lists no propose_*), and tools/call runs through the
 *     desk's own dispatcher (palette at dispatch, model-supplied tenant ids
 *     stripped, a read-only member cannot propose);
 *   - results are scrubbed (env secret + workspace vault) and outside text is
 *     fenced;
 *   - a browser Origin is refused even with a valid bearer;
 *   - the cookie path and the bearer path give the same person the same palette.
 *
 * Real libSQL file; no network.
 * Run: node --conditions=react-server --import tsx tests/mcp-server.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "mcp-server-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.LEAD_SCOPING_MODE;
const ENV_SECRET = "sk-mcp-env-secret-0123456789abcdef";
const VAULT_SECRET = "vault-mcp-secret-zyxwvutsrqpo";
process.env.MCP_FIXTURE_API_KEY = ENV_SECRET;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "mcp-server-field-key-long-enough-0001";
const KEY_K1 = "k1-signing-key-for-tests-0123456789abcdef";
const KEY_K2 = "k2-signing-key-for-tests-0123456789abcdef";
process.env.OASIS_MCP_TOKEN_KID = "K1";
process.env.OASIS_MCP_TOKEN_KEY_K1 = KEY_K1;
process.env.OASIS_MCP_TOKEN_KEY_K2 = KEY_K2;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});
// The cookie path reads its user from getSessionUser; the parity check sets who
// the "browser" is. Everything else in the module is the real one.
let cookieUser: { id: string; email: string | null } | null = null;
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("../lib/supabase-server") as Record<string, unknown>;
  stub("../lib/supabase-server", { ...real, getSessionUser: async () => cookieUser });
}

const ACME = "a1a1a1a1-0000-4000-8000-0000000000a1";
const ZETA = "b2b2b2b2-0000-4000-8000-0000000000b2";
const OWNER = "0e000000-0000-4000-8000-000000000001";
const REP = "0e000000-0000-4000-8000-000000000002";
const OTHER_REP = "0e000000-0000-4000-8000-000000000003";
const VIEWER = "0e000000-0000-4000-8000-000000000009";
const ZOWNER = "0e000000-0000-4000-8000-0000000000f1";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const realError = console.error;
const realWarn = console.warn;
const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);
console.warn = (...args: unknown[]) => void logged.push(args);

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, agent_key TEXT, name TEXT, description TEXT,
      schedule TEXT, enabled INTEGER, last_run_at TEXT, last_run_status TEXT, created_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT, team_role TEXT,
      full_name TEXT, display_name TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (slug TEXT, tenant_id TEXT, manifest TEXT, updated_at TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT);
  `);
  const splitSql = (sql: string) => {
    const out: string[] = [];
    let buf: string[] = [];
    for (const line of sql.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      buf.push(line);
      if (t.endsWith(";")) {
        out.push(buf.join("\n").trim().replace(/;$/, ""));
        buf = [];
      }
    }
    if (buf.join("").trim()) out.push(buf.join("\n").trim());
    return out;
  };
  for (const stmt of splitSql(readFileSync(join(process.cwd(), "database/turso/bravo__186_os_approvals.sql"), "utf8"))) await db.execute(stmt);
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__190_ledger_core.sql"), "utf8"));

  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const lead = (id: string, tenant: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at) VALUES (?, ?, 'lead', ?, ?, ?)",
    args: [id, tenant, JSON.stringify(data), now, now],
  });
  const profile = (id: string, auth: string, tenant: string, role: string, email: string) => ({
    sql: "INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, auth, email, tenant, role, email.split("@")[0]],
  });
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'acme-roofing', 'Acme Roofing')", args: [ACME] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'zeta-print', 'Zeta Print')", args: [ZETA] },
      profile("p-owner", OWNER, ACME, "owner", "owner@acme.test"),
      profile("p-rep", REP, ACME, "closer", "rep@acme.test"),
      profile("p-other", OTHER_REP, ACME, "closer", "other@acme.test"),
      profile("p-viewer", VIEWER, ACME, "read_only", "viewer@acme.test"),
      profile("p-zowner", ZOWNER, ZETA, "owner", "owner@zeta.test"),
      lead("lead-acme-1", ACME, { name: "Harbor Bakery", company: "Harbor Bakery", stage: "contacted", next_action_at: past, assigned_to: REP }),
      lead("lead-acme-2", ACME, { name: "Northwind Clinic", company: "Northwind Clinic", stage: "new", assigned_to: OTHER_REP }),
      lead("lead-zeta-1", ZETA, { name: "Quillfeather Studio", company: "Quillfeather Studio", stage: "contacted", next_action_at: past }),
    ],
    "write",
  );

  // A provisioned workspace (a stored manifest row), as a real client's is: an
  // unprovisioned one opens no department page at all.
  for (const [tenant, slug] of [[ACME, "acme-roofing"], [ZETA, "zeta-print"]]) {
    await db.execute({
      sql: "INSERT INTO tenant_manifests (slug, tenant_id, manifest, updated_at) VALUES (?, ?, ?, ?)",
      args: [slug, tenant, JSON.stringify({ tenant_slug: slug, brand: { name: slug, subtitle: "Test workspace", logo: "oasis", footer_label: "Test", footer_tagline: "Test workspace" }, agents: [], nav: [] }), now],
    });
  }

  const bearer = await import("../lib/mcp/bearer");
  const server = await import("../lib/mcp/server");
  const catalog = await import("../lib/os/desk/catalog");
  const { deskToolset } = await import("../lib/os/desk/tools");
  const { OS_DEPARTMENTS } = await import("../lib/os/departments");
  const viewerMod = await import("../components/os/department/viewer");
  const route = await import("../app/api/mcp/route");

  const T0 = Date.now();
  const mint = (o: { uid?: string; tid?: string; dept?: string; prof?: "read" | "propose"; sid?: string; ttlSeconds?: number; nowMs?: number } = {}) =>
    bearer.mintMcpToken({ tid: o.tid ?? ACME, uid: o.uid ?? OWNER, dept: o.dept ?? "sales", prof: o.prof ?? "propose", sid: o.sid ?? "chat-1", ttlSeconds: o.ttlSeconds, nowMs: o.nowMs }).token;

  // A signed bearer built by hand: for claims the minter would never produce.
  const forge = (claims: Record<string, unknown>, key = KEY_K1) => {
    const body = `omcp1.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
    return `${body}.${createHmac("sha256", key).update(body, "utf8").digest("base64url")}`;
  };
  const sec = Math.floor(T0 / 1000);
  const goodClaims = { aud: "oasis-mcp", kid: "K1", tid: ACME, uid: OWNER, dept: "sales", prof: "propose", sid: "s", iat: sec, exp: sec + 600 };

  let nextId = 1;
  type Rpc = { status: number; json: Record<string, unknown> | null; res: Response };
  async function rpc(token: string | null, method: string, params?: unknown, opts: { headers?: Record<string, string>; id?: number | null } = {}): Promise<Rpc> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(opts.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (opts.id !== null) body.id = opts.id ?? nextId++;
    if (params !== undefined) body.params = params;
    const res = await route.POST(new Request("https://oasisai.work/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null, res };
  }
  const result = (r: Rpc) => (r.json?.result ?? {}) as Record<string, unknown>;
  const toolNames = (r: Rpc) => ((result(r).tools ?? []) as Array<{ name: string }>).map((t) => t.name);
  const call = (token: string, name: string, args: unknown = {}) => rpc(token, "tools/call", { name, arguments: args });
  const callText = (r: Rpc) => String(((result(r).content ?? []) as Array<{ text: string }>)[0]?.text ?? "");
  const approvalCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM approvals")).rows[0].n);
  const dept = (key: string) => OS_DEPARTMENTS.find((d) => d.key === key)!;

  console.log("Protocol");
  await check("initialize: negotiates the version, declares tools only, names itself", async () => {
    const r = await rpc(mint(), "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
    assert.equal(r.status, 200);
    assert.equal(r.json?.jsonrpc, "2.0");
    assert.equal(result(r).protocolVersion, "2025-06-18");
    assert.deepEqual(result(r).capabilities, { tools: { listChanged: false } });
    assert.equal((result(r).serverInfo as { name: string }).name, "oasis-mcp");
    assert.equal(r.res.headers.get("content-type"), "application/json");
  });
  await check("initialize with a version it does not know answers its latest, and an older supported one is echoed", async () => {
    assert.equal(result(await rpc(mint(), "initialize", { protocolVersion: "2099-01-01" })).protocolVersion, "2025-06-18");
    assert.equal(result(await rpc(mint(), "initialize", { protocolVersion: "2024-11-05" })).protocolVersion, "2024-11-05");
  });
  await check("ping answers {}; a notification is accepted with 202 and no body", async () => {
    const t = mint();
    assert.deepEqual(result(await rpc(t, "ping")), {});
    const n = await rpc(t, "notifications/initialized", undefined, { id: null });
    assert.equal(n.status, 202);
    assert.equal(n.json, null);
  });
  await check("an unknown method is -32601; batching and bad JSON are refused", async () => {
    const t = mint();
    assert.equal((await rpc(t, "resources/list")).json?.error && ((await rpc(t, "resources/list")).json?.error as { code: number }).code, -32601);
    const batch = await route.POST(new Request("https://x/api/mcp", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "[]" }));
    assert.equal(batch.status, 400);
    const bad = await route.POST(new Request("https://x/api/mcp", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "{nope" }));
    assert.equal(bad.status, 400);
    const ver = await rpc(t, "ping", undefined, { headers: { "mcp-protocol-version": "1999-01-01" } });
    assert.equal(ver.status, 400);
  });
  await check("GET and DELETE answer 405 with Allow: POST (no SSE stream, no session)", async () => {
    for (const fn of [route.GET, route.DELETE]) {
      const res = await fn();
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
    }
  });

  console.log("The bearer");
  await check("mint caps the lifetime at 60 minutes and refuses to mint without a configured key", () => {
    const m = bearer.mintMcpToken({ tid: ACME, uid: OWNER, dept: "sales", prof: "read", sid: "s", ttlSeconds: 999_999, nowMs: T0 });
    const v = bearer.verifyMcpToken(m.token, { nowMs: T0 });
    assert.ok(v.ok);
    if (v.ok) assert.equal(v.claims.exp - v.claims.iat, 3600);
    assert.throws(() => bearer.mintMcpToken({ tid: ACME, uid: OWNER, dept: "sales", prof: "read", sid: "s", env: {} }), /oasis_mcp_not_configured/);
    assert.throws(() => bearer.mintMcpToken({ tid: ACME, uid: OWNER, dept: "sales", prof: "read", sid: "s", env: { OASIS_MCP_TOKEN_KID: "K1", OASIS_MCP_TOKEN_KEY_K1: "short" } }), /oasis_mcp_not_configured/);
  });
  await check("no bearer, a malformed one, or a non-omcp1 one is 401", async () => {
    for (const t of [null, "garbage", "omcp1.x", "Bearer omcp1.a.b", "eyJhbGciOiJIUzI1NiJ9.e30.sig"]) {
      const r = await rpc(t, "tools/list");
      assert.equal(r.status, 401, String(t));
      assert.match(r.res.headers.get("www-authenticate") ?? "", /Bearer/);
    }
  });
  await check("an expired bearer is refused", async () => {
    const old = mint({ nowMs: T0 - 2 * 3600 * 1000 });
    assert.equal((await rpc(old, "tools/list")).status, 401);
    const v = bearer.verifyMcpToken(old);
    assert.ok(!v.ok && v.reason === "expired");
    const edge = forge({ ...goodClaims, iat: sec - 100, exp: sec - 1 });
    assert.equal((await rpc(edge, "tools/list")).status, 401);
  });
  await check("a bearer for another audience is refused, even correctly signed", async () => {
    const t = forge({ ...goodClaims, aud: "someone-else" });
    assert.equal((await rpc(t, "tools/list")).status, 401);
    const v = bearer.verifyMcpToken(t);
    assert.ok(!v.ok && v.reason === "wrong_aud");
  });
  await check("an unknown key id is refused (never issued, rotated away, or signed with a guessed key)", async () => {
    assert.equal((await rpc(forge({ ...goodClaims, kid: "K9" }, "x".repeat(40)), "tools/list")).status, 401);
    assert.equal((await rpc(forge({ ...goodClaims, kid: "../K1" }), "tools/list")).status, 401);
    // Rotate K2 away: a bearer it signed stops verifying at once.
    const signedByK2 = forge({ ...goodClaims, kid: "K2" }, KEY_K2);
    assert.equal((await rpc(signedByK2, "tools/list")).status, 200);
    delete process.env.OASIS_MCP_TOKEN_KEY_K2;
    try {
      assert.equal((await rpc(signedByK2, "tools/list")).status, 401);
    } finally {
      process.env.OASIS_MCP_TOKEN_KEY_K2 = KEY_K2;
    }
  });
  await check("a tampered bearer is refused: claims edited under the old signature, or the wrong key", async () => {
    const [p, body, sig] = mint({ prof: "read" }).split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), prof: "propose" })).toString("base64url");
    assert.equal((await rpc(`${p}.${edited}.${sig}`, "tools/list")).status, 401);
    assert.equal((await rpc(forge(goodClaims, KEY_K2), "tools/list")).status, 401);
    const flipped = `${p}.${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    assert.equal((await rpc(flipped, "tools/list")).status, 401);
  });
  await check("a lifetime over 60 minutes or an exp before iat is refused even when signed", async () => {
    assert.equal((await rpc(forge({ ...goodClaims, exp: sec + 7200 }), "tools/list")).status, 401);
    assert.equal((await rpc(forge({ ...goodClaims, iat: sec + 500, exp: sec + 600 }), "tools/list")).status, 401);
  });
  await check("a browser Origin is refused even with a valid bearer; the same call without one works", async () => {
    const t = mint();
    const web = await rpc(t, "tools/list", undefined, { headers: { origin: "https://evil.example" } });
    assert.equal(web.status, 403);
    const same = await rpc(t, "tools/list", undefined, { headers: { origin: "https://oasisai.work" } });
    assert.equal(same.status, 403);
    assert.equal((await rpc(t, "tools/list")).status, 200);
  });

  console.log("tools/list");
  await check("lists exactly the department's palette, with annotations", async () => {
    const r = await rpc(mint({ dept: "sales", prof: "propose" }), "tools/list");
    assert.equal(r.status, 200);
    assert.deepEqual(toolNames(r), catalog.deskPalette("sales", { canAct: true }).map((t) => t.name));
    const tools = result(r).tools as Array<{ name: string; inputSchema: unknown; annotations: Record<string, boolean> }>;
    for (const t of tools) {
      assert.ok(t.inputSchema && typeof t.inputSchema === "object", t.name);
      const proposal = t.name.startsWith("propose_");
      assert.equal(t.annotations.readOnlyHint, !proposal, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.equal(t.annotations.openWorldHint, false, t.name);
    }
  });
  await check("the 'read' profile lists no propose_* tool, in any department", async () => {
    for (const d of OS_DEPARTMENTS) {
      const r = await rpc(mint({ dept: d.key, prof: "read" }), "tools/list");
      if (r.status !== 200) continue; // a department this member cannot open lists nothing
      assert.ok(!toolNames(r).some((n) => n.startsWith("propose_")), d.key);
      const reads = catalog.deskPalette(d.key, { planMode: true, canAct: true }).map((t) => t.name);
      assert.ok(toolNames(r).every((n) => (reads as string[]).includes(n)), d.key);
    }
    const sales = await rpc(mint({ dept: "sales", prof: "read" }), "tools/list");
    assert.equal(sales.status, 200);
    assert.ok(toolNames(sales).length > 0);
  });
  await check("a department's palette is its own: Marketing offers no proposal and no pipeline tool", async () => {
    const r = await rpc(mint({ dept: "marketing", prof: "propose" }), "tools/list");
    assert.equal(r.status, 200);
    assert.deepEqual(toolNames(r), ["department_numbers", "approvals_list", "connections_status"]);
  });
  await check("a read-only member is never offered a proposal, whatever the bearer's profile says", async () => {
    const r = await rpc(mint({ uid: VIEWER, dept: "sales", prof: "propose" }), "tools/list");
    assert.equal(r.status, 200);
    assert.ok(!toolNames(r).some((n) => n.startsWith("propose_")));
  });

  console.log("tools/call");
  await check("a read returns this workspace's data, fenced as outside text", async () => {
    const r = await call(mint(), "leads_search", { query: "Harbor" });
    assert.equal(result(r).isError, false, callText(r));
    const text = callText(r);
    assert.match(text, /<<<UNTRUSTED_INPUT_BEGIN>>>/);
    assert.match(text, /Harbor Bakery/);
    assert.match(text, /<<<UNTRUSTED_INPUT_END>>>/);
  });
  await check("a tenant id the model writes is stripped: another workspace's leads never appear", async () => {
    const r = await call(mint(), "leads_search", { tenant_id: ZETA, tenantId: ZETA, limit: 15 });
    const text = callText(r);
    assert.match(text, /Harbor Bakery/);
    assert.match(text, /Northwind Clinic/);
    assert.doesNotMatch(text, /Quillfeather/);
    const other = await call(mint(), "lead_timeline", { lead_id: "lead-zeta-1", tenant_id: ZETA });
    assert.equal(result(other).isError, true);
    assert.doesNotMatch(callText(other), /Quillfeather/);
  });
  await check("a tool outside the department's palette is refused at dispatch, with no mutation", async () => {
    const before = await approvalCount();
    for (const [d, tool] of [["marketing", "propose_email"], ["sales", "routines_status"], ["sales", "get_credential"], ["sales", "finance_get_metric"]] as const) {
      const r = await call(mint({ dept: d }), tool, { to: "a@b.test", subject: "s", body: "b" });
      assert.equal(result(r).isError, true, `${d}/${tool}`);
      assert.doesNotMatch(callText(r), /Error:|\bat\s.+\(.+:\d+:\d+\)/, "no stack trace");
    }
    assert.equal(await approvalCount(), before);
  });
  await check("the read profile cannot propose: refused, no card", async () => {
    const before = await approvalCount();
    const r = await call(mint({ prof: "read" }), "propose_email", { to: "lee@harbor.test", subject: "Hi", body: "Hello" });
    assert.equal(result(r).isError, true);
    assert.equal(await approvalCount(), before);
  });
  await check("the propose profile makes one pending card owned by the member and sends nothing", async () => {
    const before = await approvalCount();
    const r = await call(mint({ uid: REP, prof: "propose" }), "propose_email", { to: "lee@harbor.test", subject: "Following up", body: "Hi Lee, checking in." });
    assert.equal(result(r).isError, false, callText(r));
    assert.equal(await approvalCount(), before + 1);
    const row = (await db.execute("SELECT status, idempotency_key, requested_by_id FROM approvals ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(String(row.status), "pending");
    assert.ok(String(row.idempotency_key).startsWith(`desk:${REP}:`), String(row.idempotency_key));
    assert.equal(String(row.requested_by_id), "mcp-sales");
  });
  await check("a read-only member cannot propose even when the bearer claims 'propose'", async () => {
    const before = await approvalCount();
    const r = await call(mint({ uid: VIEWER, prof: "propose" }), "propose_email", { to: "lee@harbor.test", subject: "Nope", body: "Nope" });
    assert.equal(result(r).isError, true);
    assert.equal(await approvalCount(), before);
  });
  await check("a failure is plain words: an unknown lead names no table, key, or stack", async () => {
    const r = await call(mint(), "lead_timeline", { lead_id: "does-not-exist" });
    assert.equal(result(r).isError, true);
    assert.equal(callText(r), "No lead with that id was found in this workspace.");
  });
  await check("a call with no tool name is -32602", async () => {
    const r = await rpc(mint(), "tools/call", {});
    assert.equal((r.json?.error as { code: number }).code, -32602);
  });
  await check("env secrets and workspace vault secrets are redacted from results", async () => {
    const { encryptField } = await import("../lib/field-encryption");
    await db.batch(
      [
        {
          sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'custom', 'acme_vault', ?)",
          args: [ACME, encryptField(VAULT_SECRET)],
        },
        lead("lead-secret", ACME, { name: `Secretive Co ${ENV_SECRET}`, company: `Vaulted ${VAULT_SECRET}`, stage: "contacted", next_action_at: past }),
      ],
      "write",
    );
    const r = await call(mint(), "leads_search", { query: "" , limit: 15 });
    const text = callText(r);
    assert.match(text, /Secretive Co/);
    assert.ok(!text.includes(ENV_SECRET), "env secret leaked");
    assert.ok(!text.includes(VAULT_SECRET), "vault secret leaked");
    assert.ok(!text.includes(ENV_SECRET.slice(8)), "env secret fragment leaked");
  });
  await check("a vault that cannot be read fails the call closed: nothing is returned", async () => {
    await db.execute("INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'custom', 'broken', 'not-ciphertext')", [ACME] as never);
    const r = await call(mint(), "leads_search", {});
    assert.equal(result(r).isError, true);
    assert.doesNotMatch(callText(r), /Harbor/);
    await db.execute("DELETE FROM tenant_integration_credentials WHERE field_key = 'broken'");
  });

  console.log("Whose seat it is");
  await check("a bearer for one workspace with a member of another is refused, both ways", async () => {
    assert.equal((await rpc(mint({ tid: ZETA, uid: OWNER }), "tools/list")).status, 403);
    assert.equal((await call(mint({ tid: ZETA, uid: OWNER }), "leads_search")).status, 403);
    assert.equal((await rpc(mint({ tid: ACME, uid: ZOWNER }), "tools/list")).status, 403);
    const own = await call(mint({ tid: ZETA, uid: ZOWNER }), "leads_search");
    assert.equal(own.status, 200);
    assert.match(callText(own), /Quillfeather/);
    assert.doesNotMatch(callText(own), /Harbor|Northwind/);
  });
  await check("a department the member cannot open is refused (the rail's own gate)", async () => {
    const r = await rpc(mint({ uid: REP, dept: "operations" }), "tools/list");
    assert.equal(r.status, 403);
    const unknown = await rpc(mint({ dept: "not_a_department" }), "tools/list");
    assert.equal(unknown.status, 403);
  });
  await check("the cookie viewer and the bearer viewer get the same person, role and palette", async () => {
    for (const uid of [OWNER, REP, VIEWER]) {
      const profileRow = (await db.execute("SELECT email FROM user_profiles WHERE auth_user_id = ?", [uid])).rows[0];
      cookieUser = { id: uid, email: String(profileRow.email) };
      const fromCookie = await viewerMod.resolveOsViewer();
      const fromBearer = await viewerMod.resolveOsViewerFor(ACME, uid);
      assert.ok(fromCookie.ok && fromBearer.ok, uid);
      if (!fromCookie.ok || !fromBearer.ok) continue;
      assert.deepEqual(fromBearer.surface, fromCookie.surface, uid);
      assert.deepEqual(fromBearer.navInput, fromCookie.navInput, uid);
      assert.equal(fromBearer.oasis, fromCookie.oasis);
      for (const d of OS_DEPARTMENTS) {
        const a = deskToolset({ viewer: fromCookie, dept: d, agentSlug: "x" }).palette.map((t) => t.name);
        const b = deskToolset({ viewer: fromBearer, dept: d, agentSlug: "x" }).palette.map((t) => t.name);
        assert.deepEqual(b, a, `${uid}/${d.key}`);
        const opened = (await rpc(mint({ uid, dept: d.key, prof: "propose" }), "tools/list")).status === 200;
        const gate = (await import("../components/os/department/gate")).departmentGate(d.slug, fromCookie.navInput) !== null;
        assert.equal(opened, gate, `${uid}/${d.key} gate`);
      }
    }
    cookieUser = null;
  });
  await check("a role downgrade bites on the very next call", async () => {
    const t = mint({ uid: OTHER_REP, prof: "propose" });
    assert.ok(toolNames(await rpc(t, "tools/list")).includes("propose_email"));
    await db.execute("UPDATE user_profiles SET team_role = 'read_only' WHERE auth_user_id = ?", [OTHER_REP] as never);
    assert.ok(!toolNames(await rpc(t, "tools/list")).includes("propose_email"));
    const before = await approvalCount();
    const r = await call(t, "propose_email", { to: "lee@harbor.test", subject: "x", body: "y" });
    assert.equal(result(r).isError, true);
    assert.equal(await approvalCount(), before);
  });
  await check("a removed seat is refused on the next call, with the same unexpired bearer", async () => {
    const t = mint({ uid: REP });
    assert.equal((await call(t, "leads_search")).status, 200);
    await db.execute("DELETE FROM user_profiles WHERE auth_user_id = ?", [REP] as never);
    const after = await call(t, "leads_search");
    assert.equal(after.status, 403);
    assert.doesNotMatch(JSON.stringify(after.json), /Harbor/);
    assert.equal((await rpc(t, "tools/list")).status, 403);
    // ping needs no seat: it carries no workspace data.
    assert.equal((await rpc(t, "ping")).status, 200);
  });

  console.log("Wiring");
  await check("the route is bearer-gated inside and does not read a cookie; the middleware lets the path through", () => {
    const src = readFileSync(join(process.cwd(), "app/api/mcp/route.ts"), "utf8");
    assert.match(src, /handleMcpPost/);
    assert.doesNotMatch(src, /cookies\(\)|getSessionUser/);
    assert.match(readFileSync(join(process.cwd(), "middleware.ts"), "utf8"), /"\/api\/mcp",/);
  });

  console.error = realError;
  console.warn = realWarn;
  if (failures > 0) {
    for (const l of logged.slice(-12)) realError(...l);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("mcp server tests passed");
}

main().catch((error) => {
  console.error = realError;
  console.warn = realWarn;
  console.error(error);
  for (const l of logged.slice(-12)) realError(...l);
  process.exit(1);
});
