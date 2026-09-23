import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";

import { CURRENT_OASIS_PIPELINE_CYCLE } from "../lib/pipeline-cycle";
import { WEBDEV_TENANT_ID } from "../lib/web-leads/tenant";

const ROOT = resolve(process.cwd());
const SCRIPT = resolve(ROOT, "scripts", "plan-oasis-pipeline-cycle.ts");
const source = readFileSync(SCRIPT, "utf8");

assert.doesNotMatch(
  source,
  /getServiceSupabase/,
  "the Turso-cloud planner must not construct or call an unavailable Supabase service client",
);
assert.match(source, /createTursoPostgrest\(getTursoClient\(\)\)/);
assert.match(source, /\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/);
assert.match(source, /\.eq\("entity_type",\s*"lead"\)/);
assert.doesNotMatch(
  source,
  /\.update\(|\.delete\(|\.insert\(|\.upsert\(|\.rpc\(/,
  "the planner must remain read-only",
);
assert.doesNotMatch(source, /--apply/, "the planner must not grow an apply flag");

const CC_ID = "11111111-1111-4111-8111-111111111111";
const ADON_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
const SEED_DB_PATH_ENV = "PIPELINE_CYCLE_PLANNER_SEED_DB_PATH";

async function seedDatabase(dbPath: string): Promise<void> {
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.batch(
      [
        `CREATE TABLE tenant_records (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE TABLE user_profiles (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          auth_user_id TEXT,
          email TEXT NOT NULL,
          full_name TEXT NOT NULL,
          display_name TEXT,
          team_role TEXT NOT NULL,
          is_owner INTEGER NOT NULL,
          admin_access INTEGER NOT NULL,
          invited_by TEXT,
          joined_at TEXT NOT NULL,
          manager_user_id TEXT
        )`,
      ],
      "write",
    );

    const now = CURRENT_OASIS_PIPELINE_CYCLE.startedAt;
    const old = "2026-09-01T00:00:00.000Z";
    const profile = (
      id: string,
      authUserId: string,
      email: string,
      fullName: string,
      joinedAt: string,
      tenantId = WEBDEV_TENANT_ID,
    ) => ({
      sql: `INSERT INTO user_profiles
        (id, tenant_id, auth_user_id, email, full_name, display_name, team_role,
         is_owner, admin_access, invited_by, joined_at, manager_user_id)
        VALUES (?, ?, ?, ?, ?, NULL, 'owner', 1, 1, NULL, ?, NULL)`,
      args: [id, tenantId, authUserId, email, fullName, joinedAt],
    });
    const record = (
      id: string,
      tenantId: string,
      entityType: string,
      data: Record<string, unknown>,
      updatedAt: string,
    ) => ({
      sql: `INSERT INTO tenant_records
        (id, tenant_id, entity_type, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, tenantId, entityType, JSON.stringify(data), updatedAt, updatedAt],
    });

    await db.batch(
      [
        profile("profile-cc", CC_ID, "conaugh@oasisai.work", "Conaugh", old),
        profile("profile-adon", ADON_ID, "adon@oasisai.work", "Adon", now),
        profile(
          "cross-tenant-profile-decoy",
          "44444444-4444-4444-8444-444444444444",
          "conaugh@oasisai.work",
          "Wrong Tenant",
          now,
          OTHER_TENANT,
        ),
        record(
          "current-oasis-lead",
          WEBDEV_TENANT_ID,
          "lead",
          {
            stage: "assigned",
            assigned_to: CC_ID,
            assigned_at: now,
            pipeline_cycle: CURRENT_OASIS_PIPELINE_CYCLE.id,
          },
          now,
        ),
        record(
          "prior-oasis-lead",
          WEBDEV_TENANT_ID,
          "lead",
          { stage: "connected", assigned_to: ADON_ID, assigned_at: old },
          old,
        ),
        record(
          "cross-tenant-decoy",
          OTHER_TENANT,
          "lead",
          {
            stage: "assigned",
            assigned_to: CC_ID,
            assigned_at: now,
            pipeline_cycle: CURRENT_OASIS_PIPELINE_CYCLE.id,
          },
          now,
        ),
        record(
          "same-tenant-non-lead-decoy",
          WEBDEV_TENANT_ID,
          "application",
          {
            stage: "assigned",
            assigned_to: CC_ID,
            assigned_at: now,
            pipeline_cycle: CURRENT_OASIS_PIPELINE_CYCLE.id,
          },
          now,
        ),
      ],
      "write",
    );
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "pipeline-cycle-planner-"));
  const dbPath = join(tempRoot, "planner.db");
  try {
    // Seed in a short-lived child so the native libSQL handle is gone before
    // this Windows process removes the fixture directory.
    const seedResult = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", resolve(ROOT, "tests", "pipeline-cycle-planner.test.ts")],
      {
        cwd: ROOT,
        env: { ...process.env, [SEED_DB_PATH_ENV]: dbPath },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(seedResult.status, 0, seedResult.stderr || seedResult.stdout);

    const env = {
      ...process.env,
      NODE_ENV: "test",
      EMPIRE_DATA_BACKEND: "turso_cloud",
      EMPIRE_AUTH_BACKEND: "turso",
      TURSO_DB_PATH: dbPath,
      TURSO_DATABASE_URL: "",
      TURSO_DB_URL: "",
      TURSO_AUTH_TOKEN: "",
      BRAVO_SUPABASE_URL: "",
      BRAVO_SUPABASE_SERVICE_ROLE_KEY: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      BRAVO_SUPABASE_ANON_KEY: "",
    };
    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", SCRIPT, "--json"],
      { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /supabase.*(?:misconfigured|unavailable|not configured)/i,
      "Turso-cloud planning must not touch the unavailable Supabase surface",
    );

    const plan = JSON.parse(result.stdout) as {
      current: Array<{ id: string }>;
      archive: Array<{ id: string }>;
      assignmentRoster: Array<{ userId: string | null }>;
    };
    assert.deepEqual(plan.current.map((row) => row.id), ["current-oasis-lead"]);
    assert.deepEqual(plan.archive.map((row) => row.id), ["prior-oasis-lead"]);
    assert.deepEqual(
      plan.assignmentRoster.map((member) => member.userId),
      [CC_ID, ADON_ID],
    );
    assert.doesNotMatch(result.stdout, /cross-tenant-decoy|same-tenant-non-lead-decoy/);

    const missingConfig = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", SCRIPT, "--json"],
      { cwd: ROOT, env: { ...env, TURSO_DB_PATH: "" }, encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(missingConfig.status, 0, "a missing Turso connection must fail closed");
    assert.match(missingConfig.stderr, /pipeline_cycle_turso_not_configured/);
    assert.doesNotMatch(
      missingConfig.stderr,
      /Service Supabase misconfigured|supabase\..*unavailable/i,
      "a missing Turso connection must not fall through to Supabase",
    );

    const implicitBackend = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", SCRIPT, "--json"],
      {
        cwd: ROOT,
        env: { ...env, EMPIRE_DATA_BACKEND: "" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.notEqual(implicitBackend.status, 0, "an implicit/local Turso mode can split lead and roster reads");
    assert.match(implicitBackend.stderr, /pipeline_cycle_requires_turso_cloud/);
    assert.doesNotMatch(
      implicitBackend.stderr,
      /Service Supabase misconfigured|supabase\..*unavailable/i,
      "the planner must reject a mixed backend before either data read",
    );

    console.log("pipeline-cycle-planner.test.ts: OK");
  } finally {
    for (const name of readdirSync(tempRoot)) unlinkSync(join(tempRoot, name));
    rmdirSync(tempRoot);
  }
}

const seedDbPath = process.env[SEED_DB_PATH_ENV];
const run = seedDbPath ? seedDatabase(seedDbPath) : main();
run.catch((error) => {
  console.error(error);
  process.exit(1);
});
