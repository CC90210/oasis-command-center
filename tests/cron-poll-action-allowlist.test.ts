/**
 * tests/cron-poll-action-allowlist.test.ts — the bridge's job pipe serves and
 * accepts SCRIPT jobs only (Automations guided setup, PR1).
 *
 * THE GAP. GET /api/cron-jobs/poll served every enabled tenant_cron_jobs row of
 * ANY action_type, and POST stamped a run result onto any row id the bridge
 * named. The bridge's runner (CEO-Agent bravo_cli/cron_runner.py) writes
 * "unknown action_type" over every row it cannot dispatch. The guided setup is
 * about to put department tasks in this table; served to the bridge, each one
 * would be overwritten with a false error every minute it matched, and its
 * run_count and last-run status (which the owner's list reads) would be the
 * bridge's, not the dispatcher's.
 *
 * WHAT IS PINNED, through the real route handler against a local libSQL file:
 *   - GET serves exactly script_run, snapshot_run and webhook_post. It is an
 *     ALLOWLIST: a department task, the stubbed agent_prompt and a type nobody
 *     has invented yet are all absent. (A `.neq("action_type",
 *     "department_task")` would still serve the last two, and fails here.)
 *   - POST for a department task (or any non-script row) answers 409
 *     not_a_bridge_job and never reaches record_tenant_cron_run: the row's
 *     run_count, last_run_at and last_run_status stay exactly as they were.
 *   - A script row still records its run (the harness reaches the real RPC, so
 *     the 409 above is the gate, not a broken write path), and another
 *     tenant's row is still a 404.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-poll-action-allowlist.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "cron-poll-allowlist-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

// No session is involved (the bridge authenticates with its pairing bearer),
// but lib/supabase-server reads next/headers at import time in some paths.
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

// Not an OASIS or SunBiz prefix, so any paired label is this tenant's executor.
const TENANT = "3a3a3a3a-0000-4000-8000-00000000003a";
const OTHER = "4b4b4b4b-0000-4000-8000-00000000004b";
const TOKEN = "bridge-token-for-the-allowlist-test";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

async function main() {
  console.log("cron-poll-action-allowlist:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT, bridge_token_hash TEXT, revoked_at TEXT
    );
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT 'bravo',
      name TEXT NOT NULL, description TEXT, schedule TEXT NOT NULL, action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT
    );
  `);
  const { sha256 } = await import("../lib/api-helpers");
  const row = (id: string, tenant: string, actionType: string, enabled: 0 | 1, at: string) => ({
    sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, action_payload, enabled, created_at)
          VALUES (?, ?, ?, '0 9 * * *', ?, '{}', ?, ?)`,
    args: [id, tenant, `Job ${id}`, actionType, enabled, at],
  });
  await db.batch(
    [
      {
        sql: "INSERT INTO bridge_pairings (id, tenant_id, label, bridge_token_hash) VALUES ('pair-1', ?, 'Test PC', ?)",
        args: [TENANT, sha256(TOKEN)],
      },
      row("s1", TENANT, "script_run", 1, "2026-10-01T00:00:01Z"),
      row("s2", TENANT, "snapshot_run", 1, "2026-10-01T00:00:02Z"),
      row("s3", TENANT, "webhook_post", 1, "2026-10-01T00:00:03Z"),
      row("d1", TENANT, "department_task", 1, "2026-10-01T00:00:04Z"),
      row("a1", TENANT, "agent_prompt", 1, "2026-10-01T00:00:05Z"),
      row("x1", TENANT, "some_future_type", 1, "2026-10-01T00:00:06Z"),
      row("off", TENANT, "script_run", 0, "2026-10-01T00:00:07Z"),
      row("o1", OTHER, "script_run", 1, "2026-10-01T00:00:08Z"),
    ],
    "write",
  );

  const poll = await import("../app/api/cron-jobs/poll/route");
  const { NextRequest } = await import("next/server");
  const get = () =>
    poll.GET(new NextRequest("http://localhost/api/cron-jobs/poll", { headers: { authorization: `Bearer ${TOKEN}` } }));
  const report = async (body: Record<string, unknown>) => {
    const res = await poll.POST(
      new NextRequest("http://localhost/api/cron-jobs/poll", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; message?: string; run_count?: number } };
  };
  const stamp = async (id: string) => {
    const rs = await db.execute({
      sql: "SELECT run_count, last_run_at, last_run_status, last_run_error FROM tenant_cron_jobs WHERE id = ?",
      args: [id],
    });
    const r = rs.rows[0];
    return { run_count: Number(r.run_count), last_run_at: r.last_run_at, last_run_status: r.last_run_status, last_run_error: r.last_run_error };
  };

  await check("GET serves exactly the three script types, enabled, for this tenant only", async () => {
    const res = await get();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; jobs: Array<{ id: string; action_type: string }> };
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.jobs.map((j) => j.id).sort(),
      ["s1", "s2", "s3"],
      `served: ${body.jobs.map((j) => `${j.id}:${j.action_type}`).join(", ")}`,
    );
  });

  await check("GET never serves a department task, the stubbed agent_prompt, or an unknown future type", async () => {
    const body = (await (await get()).json()) as { jobs: Array<{ action_type: string }> };
    const types = new Set(body.jobs.map((j) => j.action_type));
    for (const t of ["department_task", "agent_prompt", "some_future_type"]) assert.ok(!types.has(t), `${t} reached the bridge`);
  });

  await check("POST for a department task is refused 409 and never records a run", async () => {
    const before = await stamp("d1");
    const res = await report({ job_id: "d1", status: "error", error: "unknown action_type: department_task" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_a_bridge_job");
    assert.match(String(res.body.message), /\s/, "the refusal carries a sentence");
    assert.deepEqual(await stamp("d1"), before, "record_tenant_cron_run must not have touched the row");
  });

  await check("POST for any other non-script row is refused the same way", async () => {
    for (const id of ["a1", "x1"]) {
      const before = await stamp(id);
      const res = await report({ job_id: id, status: "success" });
      assert.equal(res.status, 409, `${id}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "not_a_bridge_job");
      assert.deepEqual(await stamp(id), before);
    }
  });

  await check("POST for a script row still records the run (the gate is the 409, not a broken write)", async () => {
    const res = await report({ job_id: "s1", status: "success", output: "sent: 3 messages" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.run_count, 1);
    const after = await stamp("s1");
    assert.equal(after.run_count, 1);
    assert.equal(after.last_run_status, "success");
  });

  await check("POST for another tenant's row is still a 404 and changes nothing", async () => {
    const before = await stamp("o1");
    const res = await report({ job_id: "o1", status: "success" });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(await stamp("o1"), before);
  });

  if (failures > 0) {
    console.log(`cron-poll-action-allowlist: ${failures} failing`);
    process.exit(1);
  }
  console.log("cron-poll-action-allowlist: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
