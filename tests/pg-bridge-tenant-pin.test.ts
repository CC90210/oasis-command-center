/**
 * tests/pg-bridge-tenant-pin.test.ts — SunBiz's TextTorrent credential must see
 * SunBiz's rows only, and the APEX credential must behave exactly as before.
 *
 * WHY THIS EXISTS
 * ---------------
 * /api/pg/rest/v1 accepted TT_PG_BRIDGE_TOKEN (SunBiz's TextTorrent runtime on
 * the VPS) and then served any table outside a denylist with the caller's own
 * filters. authorised() returned a boolean, so the route could not tell which
 * company was calling, and SunBiz's runtime could read and PATCH OASIS's
 * tenant_records, lead_interactions and agent_events.
 *
 * Real route, real adapter, real SQL: an on-disk libSQL file, no mocks. The
 * point is which rows come back, and only the database can answer that.
 *
 * The inference_jobs cases are the ones a naive pin gets wrong. The live
 * runtime queues its jobs with NO tenant_id (the tenant is inside metadata)
 * and reads them back by `source`; a strict tenant_id pin hides every one of
 * them and SMS drafting stops.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const TT = "tt-bridge-test-token-0001";
const APEX = "apex-bridge-test-token-0001";
const REP = "return=representation";

const dbFile = join(mkdtempSync(join(tmpdir(), "pg-bridge-pin-")), "bridge.db");
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.TT_PG_BRIDGE_TOKEN = TT;
process.env.APEX_PG_BRIDGE_TOKEN = APEX;

const seed = createClient({ url: `file:${dbFile}` });

type Handler = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

const ids = (rows: unknown) => (rows as Array<{ id: string }>).map((r) => r.id).sort();

async function recordData(id: string): Promise<{ tenant_id: string; data: string } | null> {
  const r = await seed.execute({ sql: "SELECT tenant_id, data FROM tenant_records WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as { tenant_id: string; data: string }) ?? null;
}

async function main() {
  await seed.batch(
    [
      `CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, data TEXT, updated_at TEXT)`,
      `CREATE TABLE sunbiz_agent_accounts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider TEXT, mode TEXT)`,
      `CREATE TABLE inference_jobs (
         id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
         tenant_id TEXT, source TEXT NOT NULL, prompt TEXT,
         status TEXT NOT NULL DEFAULT 'pending', metadata TEXT NOT NULL DEFAULT '{}')`,
      // No tenant_id column: not tenant-scoped, so no caller is pinned on it.
      `CREATE TABLE app_flags (key TEXT PRIMARY KEY, value TEXT)`,
      `INSERT INTO tenant_records VALUES ('sb-lead', '${SUNBIZ}', '{"a":0}', NULL)`,
      `INSERT INTO tenant_records VALUES ('oa-lead', '${OASIS}', '{"secret":"oasis"}', NULL)`,
      `INSERT INTO sunbiz_agent_accounts VALUES ('sb-acct', '${SUNBIZ}', 'texttorrent', 'semi')`,
      `INSERT INTO sunbiz_agent_accounts VALUES ('oa-acct', '${OASIS}', 'texttorrent', 'semi')`,
      `INSERT INTO inference_jobs (id, tenant_id, source, prompt) VALUES ('tt-job', NULL, 'sunbiz_texttorrent_runtime', 'p1')`,
      `INSERT INTO inference_jobs (id, tenant_id, source, prompt) VALUES ('oa-job', '${OASIS}', 'sunbiz_texttorrent_runtime', 'p2')`,
      `INSERT INTO inference_jobs (id, tenant_id, source, prompt) VALUES ('other-job', NULL, 'conversation-summarize', 'p3')`,
      `INSERT INTO app_flags VALUES ('k', 'v')`,
    ],
    "write",
  );

  const route = await import("../app/api/pg/rest/v1/[...path]/route");

  async function call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    opts: { token?: string; body?: unknown; prefer?: string } = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(`http://localhost/api/pg/rest/v1/${path}`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token ?? TT}`,
      "content-type": "application/json",
    };
    if (opts.prefer) headers.prefer = opts.prefer;
    const req = new NextRequest(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const segments = url.pathname.replace("/api/pg/rest/v1/", "").split("/");
    const handler = (route as unknown as Record<string, Handler>)[method];
    const res = await handler(req, { params: Promise.resolve({ path: segments }) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  // ── Credentials ──────────────────────────────────────────────────────────
  assert.equal((await call("GET", "tenant_records", { token: "wrong" })).status, 401, "a wrong token is still refused");

  // ── GET: the TT credential reads SunBiz rows only ─────────────────────────
  {
    const r = await call("GET", "tenant_records?select=id,tenant_id");
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.json), ["sb-lead"], "TT must not read OASIS tenant_records");
  }
  {
    // Asking for OASIS by name gets nothing: the pin is ANDed, not replaced.
    const r = await call("GET", `tenant_records?tenant_id=eq.${OASIS}&select=id`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [], "a caller-supplied tenant filter cannot widen the pin");
  }
  {
    // The runtime's own account query, same shape as repository.js.
    const r = await call("GET", "sunbiz_agent_accounts?provider=eq.texttorrent&mode=in.(shadow,semi)&select=id,tenant_id");
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.json), ["sb-acct"], "TT sees only SunBiz's TextTorrent accounts");
  }
  {
    const r = await call("GET", "app_flags?select=key,value");
    assert.equal(r.status, 200);
    assert.equal((r.json as unknown[]).length, 1, "a table with no tenant_id column is served as before");
  }
  {
    // An embedded select would read a second table the pin never sees.
    const r = await call("GET", "sunbiz_agent_accounts?select=id,tenant_records(*)");
    assert.equal(r.status, 501, "TT may not embed another table");
  }

  // ── APEX: unchanged ───────────────────────────────────────────────────────
  {
    const r = await call("GET", "tenant_records?select=id", { token: APEX });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.json), ["oa-lead", "sb-lead"], "APEX is not pinned; its behaviour is unchanged");
  }

  // ── inference_jobs: the runtime's unowned queue rows keep working ─────────
  {
    const r = await call(
      "GET",
      "inference_jobs?source=eq.sunbiz_texttorrent_runtime&status=eq.pending&select=id,source",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      ids(r.json),
      ["tt-job"],
      "TT sees its own unowned jobs, not OASIS's job with the same source, not other unowned rows",
    );
  }
  let queuedId = "";
  {
    // Exactly what services/texttorrent-runtime/inference.js inserts.
    const r = await call("POST", "inference_jobs", {
      prefer: REP,
      body: {
        source: "sunbiz_texttorrent_runtime",
        prompt: "draft a reply",
        status: "pending",
        metadata: { tenant_id: SUNBIZ, account_id: "sb-acct" },
      },
    });
    assert.equal(r.status, 201, "the runtime can still queue a job with no tenant_id");
    queuedId = (r.json as Array<{ id: string }>)[0]?.id;
    assert.ok(queuedId, "the queued job comes back with its id");
  }
  {
    const r = await call("GET", `inference_jobs?id=eq.${queuedId}&select=id,status&limit=1`);
    assert.deepEqual(ids(r.json), [queuedId], "the runtime can read back the job it just queued");
  }
  {
    const r = await call("PATCH", `inference_jobs?id=eq.${queuedId}&status=eq.pending`, {
      prefer: REP,
      body: { status: "running" },
    });
    assert.equal(r.status, 200);
    assert.equal((r.json as unknown[]).length, 1, "the inference worker can still claim the job");
  }
  {
    const r = await call("PATCH", "inference_jobs?id=eq.oa-job", { prefer: REP, body: { status: "running" } });
    assert.deepEqual(r.json, [], "TT cannot claim OASIS's inference job");
    const row = await seed.execute("SELECT status FROM inference_jobs WHERE id = 'oa-job'");
    assert.equal(row.rows[0].status, "pending");
  }

  // ── POST: rows for another tenant are refused ─────────────────────────────
  {
    const r = await call("POST", "tenant_records", { body: { id: "x-oasis", tenant_id: OASIS, data: "{}" } });
    assert.equal(r.status, 403, "TT may not create an OASIS row");
    assert.equal(await recordData("x-oasis"), null);
  }
  {
    const r = await call("POST", "tenant_records", {
      body: [
        { id: "x-sb", tenant_id: SUNBIZ, data: "{}" },
        { id: "x-oa", tenant_id: OASIS, data: "{}" },
      ],
    });
    assert.equal(r.status, 403, "one foreign row refuses the whole batch");
    assert.equal(await recordData("x-sb"), null, "nothing from a refused batch is written");
  }
  {
    const r = await call("POST", "tenant_records", { body: { id: "x-sb2", tenant_id: SUNBIZ, data: "{}" } });
    assert.equal(r.status, 201, "a SunBiz row is still accepted");
  }
  {
    const r = await call("POST", "tenant_records", { token: APEX, body: { id: "x-apex", tenant_id: OASIS, data: "{}" } });
    assert.equal(r.status, 201, "APEX inserts are unchanged");
  }

  // ── PATCH: pinned, and no re-homing ───────────────────────────────────────
  {
    const r = await call("PATCH", "tenant_records?id=eq.oa-lead", { prefer: REP, body: { data: '{"pwned":1}' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [], "TT's PATCH matches no OASIS row");
    assert.equal((await recordData("oa-lead"))?.data, '{"secret":"oasis"}', "the OASIS row is untouched");
  }
  {
    const r = await call("PATCH", "tenant_records?id=eq.sb-lead", { prefer: REP, body: { tenant_id: OASIS } });
    assert.equal(r.status, 403, "TT may not move a SunBiz row into another tenant");
    assert.equal((await recordData("sb-lead"))?.tenant_id, SUNBIZ);
  }
  {
    const r = await call("PATCH", "tenant_records?id=eq.sb-lead", { prefer: REP, body: { data: '{"a":1}' } });
    assert.equal(r.status, 200);
    assert.equal((r.json as unknown[]).length, 1, "TT can still update its own rows");
  }

  // ── RPC: patch_tenant_record_data is pinned by p_tenant_id ────────────────
  {
    const r = await call("POST", "rpc/patch_tenant_record_data", {
      body: { p_id: "oa-lead", p_tenant_id: OASIS, p_patch: { pwned: true } },
    });
    assert.equal(r.status, 403, "TT may not patch an OASIS lead through the RPC");
    assert.equal((await recordData("oa-lead"))?.data, '{"secret":"oasis"}');
  }
  {
    const r = await call("POST", "rpc/patch_tenant_record_data", { body: { p_id: "sb-lead", p_patch: { a: 2 } } });
    assert.equal(r.status, 403, "the RPC must name the tenant it writes to");
  }
  {
    const r = await call("POST", "rpc/patch_tenant_record_data", {
      body: { p_id: "sb-lead", p_tenant_id: SUNBIZ, p_patch: { phone: "5550100" } },
    });
    assert.equal(r.status, 200, "the TPS enricher's SunBiz write still works");
    assert.equal(JSON.parse((await recordData("sb-lead"))!.data).phone, "5550100");
  }
  {
    const r = await call("POST", "rpc/patch_tenant_record_data", {
      token: APEX,
      body: { p_id: "oa-lead", p_tenant_id: OASIS, p_patch: { apex: 1 } },
    });
    assert.equal(r.status, 200, "APEX RPC behaviour is unchanged");
  }
}

main().then(
  () => console.log("pg-bridge-tenant-pin: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
