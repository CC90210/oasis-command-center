/**
 * pg-bridge-usage-log.test.ts — every /api/pg bridge call leaves one line in the
 * Worker's logs naming the credential (a label), the table or RPC, the status and
 * whether a tenant was named, and never a token, a filter value or a body.
 *
 * WHY. Either bridge bearer reaches every table outside the denylist, with no
 * forced tenant filter (2026-10-19 audit, P0-2). Narrowing it to per-credential
 * allowlists needs what each fleet really uses, and TT_PG_BRIDGE_TOKEN belongs to
 * the retired SunBiz SMS runtime: before it is revoked, the logs must show
 * whether anything still presents it. Nothing recorded either until now.
 *
 * Drives the real GET/POST handlers on a local libSQL file.
 *
 * Run: node --conditions=react-server --import tsx tests/pg-bridge-usage-log.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "pg-bridge-usage-log-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

const TT = "tt-bridge-secret-value-0001";
const APEX = "apex-bridge-secret-value-0002";
process.env.TT_PG_BRIDGE_TOKEN = TT;
process.env.APEX_PG_BRIDGE_TOKEN = APEX;

const PRIVATE_EMAIL = "private.person@example.com";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

type Usage = { event: string; credential: string | null; method: string; target: string; status: number; tenantFilter: boolean | null };

/** Run one call with console.log recorded; returns the response (or the error) and the usage lines. */
async function recorded(call: () => Promise<Response>): Promise<{ res?: Response; error?: unknown; lines: unknown[][]; usage: Usage[] }> {
  const lines: unknown[][] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args); };
  let res: Response | undefined;
  let error: unknown;
  try {
    res = await call();
  } catch (e) {
    error = e;
  } finally {
    console.log = original;
  }
  const usage = lines
    .map((args) => args[0])
    .filter((a): a is Usage => typeof a === "object" && a !== null && (a as Usage).event === "pg_bridge_usage");
  return { res, error, lines, usage };
}

function request(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return new NextRequest(`http://localhost/api/pg/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

async function main() {
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.execute(`CREATE TABLE demo_rows (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT)`);
  await seed.execute({ sql: `INSERT INTO demo_rows (id, tenant_id, email) VALUES ('r1', 't1', ?)`, args: [PRIVATE_EMAIL] });
  seed.close();

  const route = await import("../app/api/pg/rest/v1/[...path]/route");

  const leaks = (lines: unknown[][]) => {
    const text = JSON.stringify(lines);
    return [TT, APEX, PRIVATE_EMAIL, "r1"].filter((s) => text.includes(s));
  };

  await check("an APEX read names the credential, table, status and its tenant filter, and nothing else", async () => {
    const { res, lines, usage } = await recorded(() =>
      route.GET(request(`demo_rows?tenant_id=eq.t1&email=eq.${encodeURIComponent(PRIVATE_EMAIL)}`, { token: APEX }), params(["demo_rows"])),
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(await res!.json(), [{ id: "r1", tenant_id: "t1", email: PRIVATE_EMAIL }], "the read itself is unchanged");
    assert.equal(usage.length, 1, `one usage line per call, got ${usage.length}`);
    assert.deepEqual(usage[0], { event: "pg_bridge_usage", credential: "apex", method: "GET", target: "demo_rows", status: 200, tenantFilter: true });
    assert.deepEqual(leaks(lines), [], "no token, filter value or row data in the log");
  });

  await check("a TT read without a tenant filter is told apart from APEX and flagged as unscoped", async () => {
    const { res, usage, lines } = await recorded(() => route.GET(request("demo_rows?id=eq.r1", { token: TT }), params(["demo_rows"])));
    assert.equal(res?.status, 200);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].credential, "tt");
    assert.equal(usage[0].tenantFilter, false);
    assert.deepEqual(leaks(lines), []);
  });

  await check("a call with no credential or a wrong one is refused 401 and logged with no credential", async () => {
    for (const token of [null, "not-a-real-token"]) {
      const { res, usage, lines } = await recorded(() => route.GET(request("demo_rows", { token }), params(["demo_rows"])));
      assert.equal(res?.status, 401);
      assert.equal(usage.length, 1);
      assert.deepEqual(usage[0], { event: "pg_bridge_usage", credential: null, method: "GET", target: "demo_rows", status: 401, tenantFilter: false });
      assert.deepEqual(leaks(lines), []);
    }
  });

  await check("a denied table is logged with its 404, so probing shows up", async () => {
    const { res, usage } = await recorded(() =>
      route.GET(request("_supabase_auth_users", { token: APEX }), params(["_supabase_auth_users"])),
    );
    assert.equal(res?.status, 404);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].target, "_supabase_auth_users");
    assert.equal(usage[0].status, 404);
  });

  await check("an RPC is logged as rpc:<name> with its tenant unknown; its body is never read into the log", async () => {
    const { res, usage, lines } = await recorded(() =>
      route.POST(request("rpc/no_such_function", { method: "POST", token: TT, body: { p_email: PRIVATE_EMAIL } }), params(["rpc", "no_such_function"])),
    );
    assert.equal(res?.status, 501);
    assert.equal(usage.length, 1);
    // null, not false: an RPC's tenant argument is in the body, so "unscoped" would be a guess.
    assert.deepEqual(usage[0], { event: "pg_bridge_usage", credential: "tt", method: "POST", target: "rpc:no_such_function", status: 501, tenantFilter: null });
    assert.deepEqual(leaks(lines), []);
  });

  await check("an insert, which names its tenant in the body, is logged with the tenant unknown, not as unscoped", async () => {
    const { res, usage, lines } = await recorded(() =>
      route.POST(request("demo_rows", { method: "POST", token: APEX, body: { id: "r2", tenant_id: "t1", email: PRIVATE_EMAIL } }), params(["demo_rows"])),
    );
    assert.equal(res?.status, 201);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0], { event: "pg_bridge_usage", credential: "apex", method: "POST", target: "demo_rows", status: 201, tenantFilter: null });
    assert.deepEqual(leaks(lines), [], "no token or body value in the log");
  });

  await check("a call that throws is still logged, as 500, and the error still reaches the caller", async () => {
    // patch_tenant_record_data raises on a missing p_patch, as its Postgres original did.
    const { error, usage } = await recorded(() =>
      route.POST(request("rpc/patch_tenant_record_data", { method: "POST", token: APEX, body: {} }), params(["rpc", "patch_tenant_record_data"])),
    );
    assert.ok(error, "the throw must propagate, not be swallowed");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 500);
    assert.equal(usage[0].credential, "apex");
  });

  await check("the caller's path is capped before it reaches the log", async () => {
    const long = "x".repeat(500);
    const { usage } = await recorded(() => route.GET(request(long, { token: APEX }), params([long])));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].target.length, 80);
  });

  if (failures > 0) {
    console.log(`\npg-bridge-usage-log.test.ts — ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\npg-bridge-usage-log.test.ts — every bridge call logged once, names only ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
