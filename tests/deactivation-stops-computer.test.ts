/**
 * tests/deactivation-stops-computer.test.ts — removing a person from the
 * team stops their computer, their automations and their queued work in
 * the SAME operation (O3a).
 *
 * deactivateMember (lib/team-activation.ts) already banned the person's
 * login and dropped them from every roster; this slice adds the cascade
 * into THIS workspace's grants: every live bridge_pairings row they own is
 * revoked, every tenant_cron_jobs row they own is disabled, and every
 * dept_chat_runs row of theirs still queued is cancelled — all in the
 * deactivation itself, not a separate cleanup job.
 *
 * Then: the next ping, poll, records write, and the MCP seat check
 * (resolveOsViewerFor, what resolveMcpSession turns into "seat_gone") all
 * fail — proven as TWO independent layers: the pairing's own revocation,
 * and (reinstating the pairing to isolate it) the seat-liveness gate alone.
 *
 * Run: node --conditions=react-server --import tsx tests/deactivation-stops-computer.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "deactivation-stops-computer-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[k];
}
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
{
  const p = require.resolve("next/navigation");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      notFound: () => {
        throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
      },
      redirect: (url: string) => {
        throw new Error(`NEXT_REDIRECT;${url}`);
      },
    },
  } as unknown as NodeModule;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

// Not the OASIS web-leads tenant, so deactivateMember's lead-disposition
// step (WEBDEV_TENANT_ID-only) never engages — this file is about the
// computer/automation/run cascade, which runs for EVERY tenant.
const TENANT = "f4f4f4f4-0000-4000-8000-0000000000f4";
const FOUNDER = "auth-founder-dsc-01";
const REP = "auth-rep-dsc-01"; // the person being deactivated

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT NOT NULL, full_name TEXT NOT NULL,
      display_name TEXT, tenant_id TEXT, team_role TEXT NOT NULL DEFAULT 'member',
      is_owner INTEGER NOT NULL DEFAULT 0, admin_access INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT,
      onboarding_completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT, banned_until TEXT, deleted_at TEXT,
      session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE tenant_manifests (slug TEXT, tenant_id TEXT, manifest TEXT, updated_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT, content_preview TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE website_sales_commissions (id TEXT PRIMARY KEY, tenant_id TEXT, rep_user_id TEXT, status TEXT);
    CREATE TABLE tenant_audit_log (id TEXT PRIMARY KEY, tenant_id TEXT, actor_user_id TEXT, actor_email TEXT, action_type TEXT NOT NULL, target_table TEXT, target_id TEXT, before TEXT, after TEXT, ip_hash TEXT, user_agent TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL,
      bridge_token_hash TEXT NOT NULL, machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT,
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      previous_token_hash TEXT, token_rotated_at TEXT
    );
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT 'bravo',
      name TEXT NOT NULL, description TEXT, schedule TEXT NOT NULL, action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT, last_run_at TEXT, last_run_status TEXT, run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      department_key TEXT, agent_slug TEXT, seq INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      user_text TEXT NOT NULL DEFAULT '', created_at TEXT, finished_at TEXT, cancel_requested_at TEXT
    );
  `);
}

const stamp = "2026-10-11T00:00:00.000Z";

async function seed() {
  for (const t of [
    "user_profiles", "_supabase_auth_users", "tenants", "tenant_manifests", "tenant_records",
    "lead_interactions", "website_sales_commissions", "tenant_audit_log",
    "bridge_pairings", "tenant_cron_jobs", "dept_chat_runs",
  ]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-z', 'Client Z HVAC')", args: [TENANT] },
      {
        sql: "INSERT INTO tenant_manifests (slug, tenant_id, manifest, updated_at) VALUES ('client-z', ?, ?, ?)",
        args: [TENANT, JSON.stringify({ tenant_slug: "client-z", brand: { name: "Z", subtitle: "s", logo: "oasis", footer_label: "f", footer_tagline: "t" }, agents: [], nav: [] }), stamp],
      },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [FOUNDER, "founder@client-z.test"] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [REP, "rep@client-z.test"] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id, team_role, is_owner, joined_at, onboarding_completed_at)
              VALUES ('p-founder', ?, 'founder@client-z.test', 'Founder', ?, 'owner', 1, ?, ?)`,
        args: [FOUNDER, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, full_name, tenant_id, team_role, is_owner, joined_at, onboarding_completed_at)
              VALUES ('p-rep', ?, 'rep@client-z.test', 'Rep', ?, 'member', 0, ?, ?)`,
        args: [REP, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope)
              VALUES ('bp-rep', ?, ?, 'Rep laptop', ?, 'daemon')`,
        args: [TENANT, REP, sha256("rep-token")],
      },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, enabled, owner_user_id, created_at)
              VALUES ('job-rep', ?, 'Rep job', '0 9 * * *', 'department_task', 1, ?, ?)`,
        args: [TENANT, REP, stamp],
      },
      {
        sql: `INSERT INTO dept_chat_runs (id, tenant_id, user_id, conversation_id, status, created_at)
              VALUES ('run-rep-queued', ?, ?, 'conv-rep', 'queued', ?)`,
        args: [TENANT, REP, stamp],
      },
      {
        sql: `INSERT INTO dept_chat_runs (id, tenant_id, user_id, conversation_id, status, seq, created_at)
              VALUES ('run-rep-done', ?, ?, 'conv-rep', 'done', 2, ?)`,
        args: [TENANT, REP, stamp],
      },
    ],
    "write",
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 10).join("\n        ")}`);
  }
}

async function main() {
  await createSchema();
  const { deactivateMember } = await import("../lib/team-activation");
  const { liveSeat } = await import("../lib/os/seat");
  const { resolveOsViewerFor } = await import("../components/os/department/viewer");
  const pingRoute = await import("../app/api/bridge/ping/route");
  const pollRoute = await import("../app/api/cron-jobs/poll/route");
  const recordsRoute = await import("../app/api/bridge/records/[entity]/route");

  const actor = {
    authUserId: FOUNDER,
    profileId: "p-founder",
    tenantId: TENANT,
    teamRole: "owner" as const,
    isOwner: true,
    adminAccess: true,
  };

  console.log("deactivation-stops-computer:");

  await check(
    "a failed automation-disable write FAILS THE WHOLE DEACTIVATION (fail closed), never a logged-and-ignored error (Codex review)",
    async () => {
      // Simulates exactly the real-world gap the review found: a database
      // that has not yet applied the migration tenant_cron_jobs.owner_user_id
      // depends on. The write must stop the operation, not report success
      // while the automation keeps running under a departed person's name.
      await db.execute("ALTER TABLE tenant_cron_jobs RENAME TO tenant_cron_jobs_missing");
      try {
        await assert.rejects(
          deactivateMember({ tenantId: TENANT, targetProfileId: "p-rep", actor, reason: "test" }),
          (err: unknown) => err instanceof Error && /automation_disable_failed/.test(err.message),
        );
        const pairing = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-rep'" });
        assert.ok(pairing.rows[0].revoked_at, "the pairing write that ran before the failure is still visible");
      } finally {
        await db.execute("ALTER TABLE tenant_cron_jobs_missing RENAME TO tenant_cron_jobs");
      }
    },
  );

  await check("deactivateMember revokes the pairing, disables the automation and cancels the queued run — in the same call", async () => {
    const result = await deactivateMember({ tenantId: TENANT, targetProfileId: "p-rep", actor, reason: "test" });
    assert.equal(result.pairingsRevoked, 1);
    assert.equal(result.automationsDisabled, 1);
    assert.equal(result.runsCancelled, 1, "only the QUEUED run, not the already-done one");

    const pairing = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-rep'" });
    assert.ok(pairing.rows[0].revoked_at);

    const job = await db.execute({ sql: "SELECT enabled FROM tenant_cron_jobs WHERE id = 'job-rep'" });
    assert.equal(Number(job.rows[0].enabled), 0);

    const queuedRun = await db.execute({ sql: "SELECT status, finished_at FROM dept_chat_runs WHERE id = 'run-rep-queued'" });
    assert.equal(queuedRun.rows[0].status, "cancelled");
    assert.ok(queuedRun.rows[0].finished_at);

    const doneRun = await db.execute({ sql: "SELECT status FROM dept_chat_runs WHERE id = 'run-rep-done'" });
    assert.equal(doneRun.rows[0].status, "done", "an already-finished run is left alone");
  });

  await check("after deactivation: liveSeat and resolveOsViewerFor (the MCP seat check) both refuse the person", async () => {
    await deactivateMember({ tenantId: TENANT, targetProfileId: "p-rep", actor, reason: "test" });
    const seat = await liveSeat(TENANT, REP);
    assert.deepEqual(seat, { live: false, reason: "deactivated" });
    const viewer = await resolveOsViewerFor(TENANT, REP);
    assert.deepEqual(viewer, { ok: false, reason: "signed_out" }, "reads as seat_gone to the MCP caller");
  });

  await check("after deactivation: ping fails on the revoked token", async () => {
    await deactivateMember({ tenantId: TENANT, targetProfileId: "p-rep", actor, reason: "test" });
    const res = await pingRoute.POST(
      new NextRequest("https://oasisai.work/api/bridge/ping", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer rep-token" },
        body: JSON.stringify({ services: {} }),
      }),
    );
    assert.equal(res.status, 403, JSON.stringify(await res.clone().json()));
  });

  await check("defense in depth: even if the pairing were NOT revoked, the seat gate alone refuses ping, poll and records", async () => {
    await deactivateMember({ tenantId: TENANT, targetProfileId: "p-rep", actor, reason: "test" });
    // Reinstate the pairing to isolate the SEAT check from the revocation
    // the same deactivation already performed above.
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = NULL WHERE id = 'bp-rep'" });

    const pingRes = await pingRoute.POST(
      new NextRequest("https://oasisai.work/api/bridge/ping", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer rep-token" },
        body: JSON.stringify({ services: {} }),
      }),
    );
    assert.equal(pingRes.status, 403, JSON.stringify(await pingRes.clone().json()));

    const pollRes = await pollRoute.GET(
      new NextRequest("https://oasisai.work/api/cron-jobs/poll", { headers: { authorization: "Bearer rep-token" } }),
    );
    assert.equal(pollRes.status, 403, JSON.stringify(await pollRes.clone().json()));

    const recordsRes = await recordsRoute.POST(
      new NextRequest("https://oasisai.work/api/bridge/records/widget", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer rep-token" },
        body: JSON.stringify({ data: { name: "x" } }),
      }),
      { params: Promise.resolve({ entity: "widget" }) },
    );
    assert.equal(recordsRes.status, 403, JSON.stringify(await recordsRes.clone().json()));
  });

  if (failures > 0) {
    console.log(`deactivation-stops-computer: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("deactivation-stops-computer: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
