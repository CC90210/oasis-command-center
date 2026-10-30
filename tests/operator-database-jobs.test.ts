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
const DELIVERY_MIGRATION = "database/turso/bravo__251_operator_job_delivery_and_cron_observation.sql";

async function deliveryDb(label: string) {
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), `${label}-`)), "jobs.db")}` });
  await db.executeMultiple(readFileSync(DELIVERY_MIGRATION, "utf8"));
  return db;
}

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
    observedAt: (input as Partial<CronFlow> & { observedAt?: string | null }).observedAt ?? null,
  } as CronFlow;
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
    const db = await deliveryDb("operator-brief-live");
    const pushes: Array<{ tenant: string; text: string }> = [];
    const result = await jobs.runMorningBrief(false, {
      collect: async () => facts,
      push: async (tenant, text) => { pushes.push({ tenant, text }); return { delivered: true, outcome: "Sent to Telegram" }; },
      db,
      now: () => NOW,
      claimToken: () => "brief-live-claim",
      requestReview: async () => undefined,
    });
    assert.equal(result.mode, "live");
    assert.equal(result.notification_sends, 1);
    assert.equal(result.delivery_state, "delivered");
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].tenant, "ef8d389e-3f15-43f2-ae00-3660f69a1452");
    db.close();
  });

  await check("morning brief fails loud when neither Telegram nor its approved fallback reached CC", async () => {
    const db = await deliveryDb("operator-brief-refused");
    let reviews = 0;
    await assert.rejects(
      jobs.runMorningBrief(false, {
        collect: async () => facts,
        push: async () => ({ delivered: false, outcome: "Not sent: Telegram and email both refused it" }),
        db,
        now: () => NOW,
        claimToken: () => "brief-refused-claim",
        requestReview: async () => { reviews += 1; },
      }),
      /delivery unknown|delivery_unknown/,
    );
    const row = (await db.execute("SELECT status, attempt_started_at, delivered_at FROM operator_job_deliveries")).rows[0];
    assert.equal(row.status, "delivery_unknown");
    assert.ok(row.attempt_started_at);
    assert.equal(row.delivered_at, null);
    assert.equal(reviews, 1);
    db.close();
  });

  await check("morning brief concurrent invocations claim once and send once", async () => {
    const db = await deliveryDb("operator-brief-race");
    let pushes = 0;
    let entered!: () => void;
    let release!: () => void;
    const inPush = new Promise<void>((resolve) => { entered = resolve; });
    const holdPush = new Promise<void>((resolve) => { release = resolve; });
    const first = jobs.runMorningBrief(false, {
      collect: async () => facts,
      push: async () => {
        pushes += 1;
        entered();
        await holdPush;
        return { delivered: true, outcome: "Sent to Telegram" };
      },
      db,
      now: () => NOW,
      claimToken: () => "brief-race-a",
      requestReview: async () => undefined,
    });
    await inPush;
    await assert.rejects(
      jobs.runMorningBrief(false, {
        collect: async () => facts,
        push: async () => { pushes += 1; return { delivered: true, outcome: "duplicate" }; },
        db,
        now: () => NOW,
        claimToken: () => "brief-race-b",
        requestReview: async () => undefined,
      }),
      /delivery in flight|delivery_in_flight/,
    );
    release();
    const sent = await first;
    assert.equal(sent.notification_sends, 1);
    assert.equal(pushes, 1);
    db.close();
  });

  await check("morning brief delivered retry is idempotent", async () => {
    const db = await deliveryDb("operator-brief-retry");
    let pushes = 0;
    const run = (token: string) => jobs.runMorningBrief(false, {
      collect: async () => facts,
      push: async () => { pushes += 1; return { delivered: true, outcome: "Sent to Telegram" }; },
      db,
      now: () => NOW,
      claimToken: () => token,
      requestReview: async () => undefined,
    });
    const first = await run("brief-retry-a");
    const retry = await run("brief-retry-b");
    assert.equal(first.delivery_state, "delivered");
    assert.equal(retry.delivery_state, "already_delivered");
    assert.equal(retry.notification_sends, 0);
    assert.equal(pushes, 1);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM operator_job_deliveries")).rows[0].n), 1);
    db.close();
  });

  await check("morning brief lost provider response becomes terminal unknown and never sends again", async () => {
    const db = await deliveryDb("operator-brief-lost");
    let pushes = 0;
    let reviews = 0;
    const deps = (token: string) => ({
      collect: async () => facts,
      push: async () => {
        pushes += 1;
        throw new Error("connection reset after provider accepted request https://provider.test/send?token=provider-secret-123456789");
      },
      db,
      now: () => NOW,
      claimToken: () => token,
      requestReview: async () => { reviews += 1; },
    });
    await assert.rejects(jobs.runMorningBrief(false, deps("brief-lost-a")), /delivery unknown|delivery_unknown/);
    await assert.rejects(jobs.runMorningBrief(false, deps("brief-lost-b")), /delivery unknown|delivery_unknown/);
    const row = (await db.execute("SELECT status, attempt_started_at, delivered_at, last_error FROM operator_job_deliveries")).rows[0];
    assert.equal(row.status, "delivery_unknown");
    assert.ok(row.attempt_started_at);
    assert.equal(row.delivered_at, null);
    assert.match(String(row.last_error), /connection reset/);
    assert.doesNotMatch(String(row.last_error), /provider-secret-123456789/);
    assert.match(String(row.last_error), /token=\[REDACTED\]/);
    assert.equal(pushes, 1, "the retry must not repeat an ambiguous provider attempt");
    assert.ok(reviews >= 1, "the ambiguous row is surfaced for operator review");
    db.close();
  });

  await check("only a lease that expired before any provider attempt can be reclaimed", async () => {
    const reclaimable = await deliveryDb("operator-brief-reclaim");
    await reclaimable.execute({
      sql: `INSERT INTO operator_job_deliveries
              (id, tenant_id, job_key, delivery_key, scheduled_for, status, claim_token, lease_expires_at, created_at, updated_at)
            VALUES ('old-claim', ?, 'morning_brief', 'morning_brief:2026-10-29', '2026-10-29', 'claimed', 'old-token', ?, ?, ?)`,
      args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", new Date(NOW - 1).toISOString(), new Date(NOW - 60_000).toISOString(), new Date(NOW - 60_000).toISOString()],
    });
    let safePushes = 0;
    const reclaimed = await jobs.runMorningBrief(false, {
      collect: async () => facts,
      push: async () => { safePushes += 1; return { delivered: true, outcome: "Sent to Telegram" }; },
      db: reclaimable,
      now: () => NOW,
      claimToken: () => "new-token",
      requestReview: async () => undefined,
    });
    assert.equal(reclaimed.delivery_state, "delivered");
    assert.equal(safePushes, 1);
    reclaimable.close();

    const ambiguous = await deliveryDb("operator-brief-no-reclaim");
    await ambiguous.execute({
      sql: `INSERT INTO operator_job_deliveries
              (id, tenant_id, job_key, delivery_key, scheduled_for, status, claim_token, lease_expires_at, attempt_started_at, created_at, updated_at)
            VALUES ('old-attempt', ?, 'morning_brief', 'morning_brief:2026-10-29', '2026-10-29', 'attempting', 'old-token', ?, ?, ?, ?)`,
      args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", new Date(NOW - 1).toISOString(), new Date(NOW - 30_000).toISOString(), new Date(NOW - 60_000).toISOString(), new Date(NOW - 60_000).toISOString()],
    });
    let unsafePushes = 0;
    await assert.rejects(
      jobs.runMorningBrief(false, {
        collect: async () => facts,
        push: async () => { unsafePushes += 1; return { delivered: true, outcome: "duplicate" }; },
        db: ambiguous,
        now: () => NOW,
        claimToken: () => "must-not-claim",
        requestReview: async () => undefined,
      }),
      /delivery unknown|delivery_unknown/,
    );
    assert.equal(unsafePushes, 0);
    assert.equal((await ambiguous.execute("SELECT status FROM operator_job_deliveries")).rows[0].status, "delivery_unknown");
    ambiguous.close();
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

  await check("a registered route with no runs alerts only after its first due tick has completed", () => {
    const neverRun = flow({
      path: "/new-daily",
      schedule: "0 6 * * *",
      timeZone: "America/Toronto",
      observedAt: "2026-10-29T09:55:00.000Z",
    } as Partial<CronFlow> & Pick<CronFlow, "path" | "schedule"> & { observedAt: string });
    assert.equal(jobs.cronFlowIsStale(neverRun, Date.parse("2026-10-29T10:00:59.000Z")), false, "the 06:00 EDT tick can still be recording");
    assert.equal(jobs.cronFlowIsStale(neverRun, Date.parse("2026-10-29T10:01:00.000Z")), true, "the first due tick completed with no run");
    const verdict = jobs.evaluateHourlyHealth({
      cronFlows: [neverRun],
      computers: [{ label: "CC Mac", lastSeenAt: "2026-10-29T10:00:30.000Z", state: "online" }],
    }, Date.parse("2026-10-29T10:01:00.000Z"));
    assert.deepEqual(verdict.stale, ["/new-daily"]);
    assert.deepEqual(verdict.unmeasured, [], "late never-run routes are red, not indefinitely hidden as unmeasured");
    assert.equal(verdict.ok, false);
  });

  await check("never-run grace follows Toronto DST schedule semantics", () => {
    const spring = flow({
      path: "/spring",
      schedule: "30 2 * * *",
      timeZone: "America/Toronto",
      observedAt: "2026-03-08T05:00:00.000Z",
    } as Partial<CronFlow> & Pick<CronFlow, "path" | "schedule"> & { observedAt: string });
    assert.equal(jobs.cronFlowIsStale(spring, Date.parse("2026-03-08T07:30:59.000Z")), false, "the missing 02:30 shifts to 03:30 EDT and remains in-flight for its minute");
    assert.equal(jobs.cronFlowIsStale(spring, Date.parse("2026-03-08T07:31:00.000Z")), true);

    const fall = flow({
      path: "/fall",
      schedule: "30 1 * * *",
      timeZone: "America/Toronto",
      observedAt: "2026-11-01T04:00:00.000Z",
    } as Partial<CronFlow> & Pick<CronFlow, "path" | "schedule"> & { observedAt: string });
    assert.equal(jobs.cronFlowIsStale(fall, Date.parse("2026-11-01T05:30:59.000Z")), false);
    assert.equal(jobs.cronFlowIsStale(fall, Date.parse("2026-11-01T05:31:00.000Z")), true, "the first 01:30 is the only fixed-time occurrence");
  });

  await check("a route not yet observed stays honestly unmeasured", () => {
    const unseen = flow({ path: "/not-observed", schedule: "* * * * *" });
    const verdict = jobs.evaluateHourlyHealth({
      cronFlows: [unseen],
      computers: [{ label: "CC Mac", lastSeenAt: "2026-10-29T15:59:30.000Z", state: "online" }],
    }, NOW);
    assert.equal(jobs.cronFlowIsStale(unseen, NOW), false);
    assert.deepEqual(verdict.unmeasured, ["/not-observed"]);
    assert.deepEqual(verdict.stale, []);
    assert.equal(verdict.ok, true);
  });

  await check("hourly collector reads platform cron history but only OASIS computer check-ins", async () => {
    const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "operator-health-")), "health.db")}` });
    await db.executeMultiple(readFileSync("database/turso/bravo__249_cron_runs.sql", "utf8"));
    await db.executeMultiple(readFileSync("database/turso/bravo__250_cron_runs_unique_tick.sql", "utf8"));
    await db.executeMultiple(readFileSync(DELIVERY_MIGRATION, "utf8"));
    await db.executeMultiple("CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT, last_seen_at TEXT, revoked_at TEXT);");
    await db.batch([
      { sql: "INSERT INTO cron_runs (route, tick_at, ok, http_status, attempts, duration_ms) VALUES (?, ?, 1, '200', 1, 5)", args: ["/api/cron/health-check", "2026-10-29T15:45:00.000Z"] },
      { sql: "INSERT INTO cron_route_observations (route, observed_at) VALUES (?, ?)", args: ["/api/cron/health-check", "2026-10-29T14:00:00.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('oasis-mac', ?, 'CC Mac', ?)", args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", "2026-10-29T15:59:30.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('foreign-pc', 'foreign-tenant', 'Someone else', ?)", args: ["2026-10-29T15:59:30.000Z"] },
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at, revoked_at) VALUES ('old-pc', ?, 'Revoked PC', ?, ?)", args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452", "2026-10-29T15:59:30.000Z", "2026-10-29T15:59:40.000Z"] },
    ]);
    const collected = await jobs.collectHourlyHealthFacts(db, NOW);
    assert.deepEqual(collected.computers.map((computer) => computer.label), ["CC Mac"]);
    assert.equal(collected.computers[0].state, "online");
    assert.equal(collected.cronFlows.find((item) => item.path === "/api/cron/health-check")?.last?.ok, true);
    assert.equal(collected.cronFlows.find((item) => item.path === "/api/cron/health-check")?.observedAt, "2026-10-29T14:00:00.000Z");
    assert.equal(collected.cronFlows.length, 26);
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
    assert.match(preview, /cloud routes and paired computers only/i);
    assert.match(preview, /VPS daemon health is a separate service-check concern/i);
  });

  await check("hourly health explicitly does not claim to replace broad daemon watchdog coverage", () => {
    assert.equal(
      jobs.HOURLY_HEALTH_SCOPE_NOTE,
      "Scope: cloud routes and paired computers only. VPS daemon health is a separate service-check concern.",
    );
    const source = readFileSync("lib/automations/operator-database-jobs.ts", "utf8");
    assert.match(source, /not a replacement for the retired Windows watchdog/i);
    assert.match(source, /VPS daemon health/i);
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
