/**
 * Database-only Morning Brief + Hourly Health migration.
 *
 * Run: node --conditions=react-server --import tsx tests/operator-database-jobs.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import type { CronFlow } from "../lib/automations/cron-runs";
import type { MorningBriefFacts } from "../lib/automations/operator-database-jobs";

process.env.CRON_SECRET = "operator-jobs-secret";
process.env.CRON_ATTEST_SECRET = "operator-jobs-attest";
delete process.env.CRON_ALLOW_LOCAL;
delete process.env.OASIS_MORNING_BRIEF_FORWARD;
delete process.env.OASIS_HOURLY_HEALTH_FORWARD;

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 7).join("\n        ")}`);
  }
}

const NOW = Date.parse("2026-10-29T16:00:00.000Z");
const facts: MorningBriefFacts = {
  date: "2026-10-29",
  pipeline: {
    open: 9,
    qualified: 3,
    meetings: 2,
    won: 1,
    overdueFollowups: 2,
    missingNextStep: 4,
    missingMeetingOutcome: 1,
    meetingsToday: 2,
    partial: false,
  },
  hotReplies: [{ subject: "Plumber <reply>", intent: "hot_lead" }],
  delivery: { activeProjects: 3, overdueProjects: 1, blockedTasks: 2, openTickets: 4, breachedTickets: 1 },
  needsYou: { pendingApprovals: 5, openAlerts: 2 },
};

function flow(input: Partial<CronFlow> & Pick<CronFlow, "path" | "schedule">): CronFlow {
  return {
    path: input.path,
    schedule: input.schedule,
    timeZone: input.timeZone ?? "UTC",
    words: input.words ?? input.schedule,
    nextAt: input.nextAt ?? null,
    last: input.last ?? null,
    day: input.day ?? { ok: 0, total: 0 },
  };
}

async function main(): Promise<void> {
  const jobs = await import("../lib/automations/operator-database-jobs");

  await check("each forwarding flag fails closed and accepts only explicit truthy values", () => {
    for (const value of [undefined, "", "off", "false", "0", "enabled", "onn"]) {
      assert.equal(jobs.jobForwardingEnabled(value), false, String(value));
    }
    for (const value of ["1", "on", "true", "yes", " ON "]) {
      assert.equal(jobs.jobForwardingEnabled(value), true, value);
    }
    assert.equal(jobs.requestedDryRun(new URL("https://app.test/x?dry_run=1")), true);
    assert.equal(jobs.requestedDryRun(new URL("https://app.test/x?mode=test")), true);
    assert.equal(jobs.requestedDryRun(new URL("https://app.test/x")), false);
  });

  await check("morning brief dry mode renders cloud facts but performs zero notification work", async () => {
    let pushes = 0;
    const result = await jobs.runMorningBrief(true, {
      collect: async () => facts,
      push: async () => { pushes += 1; return { delivered: true, outcome: "sent" }; },
    });
    assert.equal(result.mode, "dry_run");
    assert.equal(result.notification_writes, 0);
    assert.equal(result.notification_sends, 0);
    assert.equal(pushes, 0);
    assert.match(result.preview, /9 open/);
    assert.match(result.preview, /Plumber &lt;reply&gt;/, "untrusted subjects are Telegram-escaped");
    assert.doesNotMatch(result.preview, /revenue|MRR/i, "financial truth is not part of Bravo's brief");
  });

  await check("morning brief live mode uses exactly the approved workspace-alert lane", async () => {
    const pushes: Array<{ tenant: string; text: string }> = [];
    const result = await jobs.runMorningBrief(false, {
      collect: async () => facts,
      push: async (tenant, text) => { pushes.push({ tenant, text }); return { delivered: true, outcome: "Sent to Telegram" }; },
    });
    assert.equal(result.mode, "live");
    assert.equal(result.notification_sends, 1);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].tenant, "ef8d389e-3f15-43f2-ae00-3660f69a1452");
  });

  await check("morning brief fails loud when neither Telegram nor its approved fallback reached CC", async () => {
    await assert.rejects(
      jobs.runMorningBrief(false, {
        collect: async () => facts,
        push: async () => ({ delivered: false, outcome: "Not sent: Telegram and email both refused it" }),
      }),
      /morning brief was not delivered/,
    );
  });

  await check("staleness excludes the currently executing tick but catches one completed missed tick", () => {
    const lastHour = flow({
      path: "/hourly",
      schedule: "0 * * * *",
      last: { ok: true, status: "200", ms: 1, at: "2026-10-29T15:00:00.000Z" },
    });
    const missedHour = flow({
      path: "/missed",
      schedule: "0 * * * *",
      last: { ok: true, status: "200", ms: 1, at: "2026-10-29T14:00:00.000Z" },
    });
    assert.equal(jobs.cronFlowIsStale(lastHour, NOW), false, "16:00 is still being recorded");
    assert.equal(jobs.cronFlowIsStale(missedHour, NOW), true, "15:00 completed without a run");
  });

  await check("hourly collector reads platform cron history but only OASIS computer check-ins", async () => {
    const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "operator-health-")), "health.db")}` });
    await db.executeMultiple(`
      CREATE TABLE cron_runs (route TEXT NOT NULL, tick_at TEXT NOT NULL, ok INTEGER NOT NULL, http_status TEXT, attempts INTEGER, duration_ms INTEGER);
      CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT, last_seen_at TEXT, revoked_at TEXT);
    `);
    await db.batch([
      { sql: "INSERT INTO cron_runs (route, tick_at, ok, http_status, attempts, duration_ms) VALUES (?, ?, 1, '200', 1, 5)", args: ["/api/cron/health-check", "2026-10-29T15:45:00.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('oasis-mac', ?, 'CC Mac', ?)", args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", "2026-10-29T15:59:30.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('foreign-pc', 'foreign-tenant', 'Someone else', ?)", args: ["2026-10-29T15:59:30.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at, revoked_at) VALUES ('old-pc', ?, 'Revoked PC', ?, ?)", args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", "2026-10-29T15:59:30.000Z", "2026-10-29T15:59:40.000Z"] },
    ]);
    const collected = await jobs.collectHourlyHealthFacts(db, NOW);
    assert.deepEqual(collected.computers.map((computer) => computer.label), ["CC Mac"]);
    assert.equal(collected.computers[0].state, "online");
    assert.equal(collected.cronFlows.find((item) => item.path === "/api/cron/health-check")?.last?.ok, true);
    assert.equal(collected.cronFlows.length, 25);
    db.close();
  });

  const unhealthy = {
    cronFlows: [
      flow({ path: "/failed", schedule: "*/5 * * * *", last: { ok: false, status: "500", ms: 4, at: "2026-10-29T15:55:00.000Z" } }),
      flow({ path: "/new", schedule: "0 6 * * *", timeZone: "America/Toronto" }),
    ],
    computers: [{ label: "CCPC", lastSeenAt: "2026-10-29T15:00:00.000Z", state: "offline" as const }],
  };

  await check("hourly health dry mode reads and grades but writes, sends and resolves nothing", async () => {
    let writes = 0;
    let resolves = 0;
    const result = await jobs.runHourlyHealth(true, NOW, {
      collect: async () => unhealthy,
      writeAlert: async () => { writes += 1; return { stored: true, telegram: "Sent to Telegram", delivered: true }; },
      resolveAlerts: async () => { resolves += 1; return 1; },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.verdict.unmeasured, ["/new"], "unmeasured stays honest without becoming a fake failure");
    assert.equal(result.notification_writes, 0);
    assert.equal(result.notification_sends, 0);
    assert.equal(result.recovery_writes, 0);
    assert.deepEqual([writes, resolves], [0, 0]);
  });

  await check("hourly health alerts once on red and resolves the durable card on recovery", async () => {
    let writes = 0;
    let resolves = 0;
    const deps = {
      collect: async () => unhealthy,
      writeAlert: async () => { writes += 1; return { stored: true, telegram: "Sent to Telegram", delivered: true }; },
      resolveAlerts: async () => { resolves += 1; return 1; },
    };
    const red = await jobs.runHourlyHealth(false, NOW, deps);
    assert.equal(red.notification_writes, 1);
    assert.equal(red.notification_sends, 1);
    assert.deepEqual([writes, resolves], [1, 0]);

    const green = await jobs.runHourlyHealth(false, NOW, {
      ...deps,
      collect: async () => ({
        cronFlows: [flow({ path: "/ok", schedule: "0 * * * *", last: { ok: true, status: "200", ms: 2, at: "2026-10-29T15:00:00.000Z" } })],
        computers: [{ label: "CC Mac", lastSeenAt: "2026-10-29T15:59:30.000Z", state: "online" as const }],
      }),
    });
    assert.equal(green.ok, true);
    assert.equal(green.recovered, 1);
    assert.deepEqual([writes, resolves], [1, 1]);
  });

  await check("hourly health uses the explicit delivery result, never outcome wording", async () => {
    const refused = await jobs.runHourlyHealth(false, NOW, {
      collect: async () => unhealthy,
      writeAlert: async () => ({ stored: true, telegram: "Sent to Telegram was refused", delivered: false }),
      resolveAlerts: async () => 0,
    });
    assert.equal(refused.notification_writes, 1);
    assert.equal(refused.notification_sends, 0);
    const delivered = await jobs.runHourlyHealth(false, NOW, {
      collect: async () => unhealthy,
      writeAlert: async () => ({ stored: true, telegram: "opaque provider outcome", delivered: true }),
      resolveAlerts: async () => 0,
    });
    assert.equal(delivered.notification_sends, 1);
  });

  await check("hourly health leaves dynamic text raw for the alert lane's one escaping pass", () => {
    const preview = jobs.renderHourlyHealth({
      ok: false,
      scheduled: 1,
      healthy: 0,
      failed: [],
      stale: [],
      unmeasured: [],
      computers: [{ label: "Mac & Mini <desk>", lastSeenAt: null, state: "offline" }],
      issues: ["Mac & Mini <desk> is offline"],
    });
    assert.match(preview, /Mac & Mini <desk>/);
    assert.doesNotMatch(preview, /&amp;|&lt;/);
  });

  await check("routes require two-leg cron auth and remain off without querying when flags are unset", async () => {
    const morning = await import("../app/api/cron/morning-brief/route");
    const hourly = await import("../app/api/cron/hourly-health/route");
    const noAuth = await morning.GET(new NextRequest("https://app.test/api/cron/morning-brief"));
    assert.equal(noAuth.status, 401);
    const headers = { authorization: "Bearer operator-jobs-secret", "x-oasis-cron-attest": "operator-jobs-attest" };
    for (const [route, path] of [[morning, "morning-brief"], [hourly, "hourly-health"]] as const) {
      const response = await route.GET(new NextRequest(`https://app.test/api/cron/${path}`, { headers }));
      const body = await response.json() as { mode?: string; notification_sends?: number; recovery_writes?: number };
      assert.equal(response.status, 200);
      assert.equal(body.mode, "off");
      assert.equal(body.notification_sends, 0);
      if (path === "hourly-health") assert.equal(body.recovery_writes, 0);
    }
  });

  await check("a Morning Brief execution failure is a non-2xx cron response", async () => {
    const morning = await import("../app/api/cron/morning-brief/route");
    const headers = { authorization: "Bearer operator-jobs-secret", "x-oasis-cron-attest": "operator-jobs-attest" };
    const keys = ["TURSO_DB_PATH", "TURSO_DATABASE_URL", "TURSO_DB_URL", jobs.MORNING_BRIEF_FORWARD_ENV] as const;
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env[jobs.MORNING_BRIEF_FORWARD_ENV] = "on";
    try {
      const response = await morning.GET(new NextRequest("https://app.test/api/cron/morning-brief", { headers }));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: "morning_brief_failed" });
    } finally {
      for (const key of keys) {
        const value = before[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  await check("implementation has no local-file/model dependency and every direct business query is tenant-scoped", () => {
    const source = readFileSync("lib/automations/operator-database-jobs.ts", "utf8");
    assert.doesNotMatch(source, /ANTHROPIC_API_KEY|BRAVO_ANTHROPIC_API_KEY/);
    assert.doesNotMatch(source, /node:fs|child_process|tmp\/|briefing_snapshot/i);
    for (const table of ["approvals", "agent_alerts", "delivery_projects", "delivery_tasks", "support_tickets", "bridge_pairings"]) {
      const query = source.split("sql:").find((part) => part.includes(table));
      assert.ok(query && /tenant_id\s*=\s*\?/i.test(query), `${table} query must bind tenant_id`);
    }
  });

  console.log(`operator database jobs: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
