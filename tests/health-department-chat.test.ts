/**
 * health-department-chat.test.ts — the department chats are watched by the
 * outcome-health framework, and a broken one is announced instead of found.
 *
 * WHY (CC, 2026-10-09: "our software improves itself and catches errors ...
 * breaks do not happen"). All six department chats were broken for hours —
 * empty replies, a stale "model not found", a CRLF stream bug — and nothing
 * alerted; CC found it himself. department_chat_outcomes and
 * department_chat_fallback (lib/health/department-chat-checks.ts) now read the
 * evidence every model call already leaves in ai_usage_events.
 *
 * Driven against a REAL local libSQL file with bravo__192 applied (the same
 * BEGIN/END-aware split scripts/apply_turso_migration.py uses), through the
 * real runCheck and runHealthChecks; only Telegram is faked.
 *
 * Run: node --conditions=react-server --import tsx tests/health-department-chat.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "health-department-chat-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.PUBLIC_APP_URL;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("BRIDGE_")) delete process.env[key];
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // oasis-ai-cc
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b"; // a client workspace
const RETIRED = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110"; // SunBiz
const NOW = Date.parse("2026-10-09T18:00:00.000Z");
const MIN = 60_000;

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** scripts/apply_turso_migration.py split_statements, line for line: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

type Turn = {
  tenant?: string;
  dept: string | null;
  minsAgo: number;
  outcome?: string;
  error?: string | null;
  /** undefined = 120 tokens; null = the provider reported none. */
  out?: number | null;
  fallback?: string | null;
};

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", "bravo__192_ai_usage.sql"), "utf8"))) {
    await db.execute(stmt);
  }
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
    CREATE TABLE health_check_runs (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      check_id TEXT, surface TEXT, verdict TEXT, observed REAL, baseline REAL, reason TEXT, ran_at TEXT);
    CREATE TABLE health_alert_state (alert_key TEXT PRIMARY KEY, tenant_id TEXT, last_signature TEXT,
      last_alerted_at TEXT, repeat_n INTEGER, first_failed_at TEXT, updated_at TEXT);
  `);
  await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] });

  let seq = 0;
  async function seed(...turns: Turn[]) {
    for (const t of turns) {
      seq += 1;
      await db.execute({
        sql: `INSERT INTO ai_usage_events
                (id, tenant_id, occurred_at, provider, model, surface, auth_kind, billing_mode, department_key,
                 fallback_reason, output_tokens, outcome, error_code)
              VALUES (?, ?, ?, 'anthropic', 'claude-sonnet-4-6', 'agents.chat', 'api_key', 'byo_key', ?, ?, ?, ?, ?)`,
        args: [
          `row-${seq}`,
          t.tenant ?? OASIS,
          new Date(NOW - t.minsAgo * MIN).toISOString(),
          t.dept,
          t.fallback ?? null,
          t.out === undefined ? 120 : t.out,
          t.outcome ?? "ok",
          t.error ?? null,
        ],
      });
    }
  }
  const reset = async () => {
    await db.execute("DELETE FROM ai_usage_events");
  };

  const { runCheck } = await import("../lib/health/drip-checks");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const {
    DEPARTMENT_CHAT_CHECKS,
    departmentChatTenantIds,
    gradeDepartmentTurns,
    isFailedTurn,
    plainFailure,
    plainFallback,
  } = await import("../lib/health/department-chat-checks");
  const { allChecks, OASIS_GLOBAL_CHECKS, ESTATE_WIDE_CHECKS, runHealthChecks } = await import("../lib/health/runner");
  const { evaluate } = await import("../lib/health/checks-core");
  const { meteredBridgeTurn } = await import("../lib/os/department-agent");
  const { runDepartmentChatHealth, DEPARTMENT_CHAT_FANOUT, brokenSummary } = await import("../lib/health/department-chat-run");
  const { modelCallMeter, billingForBridge } = await import("../lib/ai/usage");

  const supa = getServiceSupabase();
  const outcomes = DEPARTMENT_CHAT_CHECKS.find((c) => c.id === "department_chat_outcomes")!;
  const fallback = DEPARTMENT_CHAT_CHECKS.find((c) => c.id === "department_chat_fallback")!;
  const run = (c: typeof outcomes, tenant = OASIS) => runCheck(supa, tenant, c, NOW);

  // ── registration ─────────────────────────────────────────────────────────
  await check("both checks exist, page CC's lane, and are in allChecks() but not in the OASIS-global or estate-wide runs", () => {
    assert.ok(outcomes && fallback, "a check is missing");
    assert.equal(outcomes.lane, "operator");
    assert.equal(fallback.lane, "operator");
    assert.deepEqual(outcomes.rule, { kind: "must_be_zero" });
    assert.deepEqual(fallback.rule, { kind: "warn_above_zero" }, "the fallback check is a warning, not an outage");
    const ids = allChecks().map((c) => c.id);
    assert.ok(ids.includes("department_chat_outcomes") && ids.includes("department_chat_fallback"));
    // Those lists run under ONE tenant; these must run once per workspace.
    for (const list of [OASIS_GLOBAL_CHECKS, ESTATE_WIDE_CHECKS]) {
      assert.ok(!list.some((c) => c.id.startsWith("department_chat_")), "a per-workspace check would run under one tenant");
    }
    const route = readFileSync(join(ROOT, "app/api/cron/health-check/route.ts"), "utf8");
    const runModule = readFileSync(join(ROOT, "lib/health/department-chat-run.ts"), "utf8");
    assert.match(route, /runDepartmentChatHealth\(\{ notify \}\)/);
    assert.match(runModule, /checks: DEPARTMENT_CHAT_CHECKS/);
    assert.match(runModule, /departmentChatTenantIds/);
    // Another workspace's chat is graded and recorded, never paged into OASIS's operator chat.
    assert.match(runModule, /notify: opts\.notify && alertAudienceFor\(tenantId\) === "oasis_operator"/);
    // One piece throwing must not drop the others' summaries: each is guarded, and the route still answers 500.
    for (const piece of ["calendar", "estate", "fleet_heartbeat"]) assert.match(route, new RegExp(`guard\\(\\s*"${piece}"`), `${piece} is not guarded`);
    assert.match(route, /status: failedPieces\.length \? 500 : 200/);
  });

  await check("warn_above_zero: 0 is ok, a count is DEGRADED (never failing), an unreadable value is check_broken", () => {
    const rule = { kind: "warn_above_zero" } as const;
    assert.equal(evaluate("x", rule, 0, []).verdict, "ok");
    assert.equal(evaluate("x", rule, 3, []).verdict, "degraded");
    assert.equal(evaluate("x", rule, null, []).verdict, "check_broken");
  });

  // ── department_chat_outcomes ─────────────────────────────────────────────
  await check("all turns ok -> ok, and the reason says every department's latest turn was healthy", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 10 }, { dept: "sales", minsAgo: 50 },
      { dept: "marketing", minsAgo: 20 }, { dept: "finance", minsAgo: 30, out: null },
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "ok");
    assert.equal(r.observed, 0);
    assert.match(r.reason, /4 department chat turn\(s\) across 3 department\(s\)/);
    assert.match(r.reason, /latest turn of every department was healthy/);
  });

  await check("a department's latest turn is an empty_reply -> failing, naming the department, the error in words, and the last good turn", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 5, outcome: "error", error: "empty_reply_empty", out: 0 },
      { dept: "sales", minsAgo: 200 }, // the last good turn: 3h20m before NOW = 14:40 UTC
      ...Array.from({ length: 8 }, (_, i) => ({ dept: "marketing", minsAgo: 10 + i * 20 })), // keeps the rate under 50%
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /department chat is broken for Sales\./);
    assert.match(r.reason, /Sales: failing now, the model sent back an empty reply \(empty_reply_empty\)/);
    assert.match(r.reason, /last good turn 14:40 UTC, 3h 20m ago/);
    assert.ok(!/Marketing/.test(r.reason), "a healthy department was named in the alert");
    const text = outcomes.describe(r);
    assert.match(text, /https:\/\/oasisai\.work\/settings\/ai#engine/, "the alert must link to the engine settings");
  });

  await check("a department with no good turn in the window says so", async () => {
    await reset();
    await seed({ dept: "finance", minsAgo: 5, outcome: "error", error: "http_404" }, ...Array.from({ length: 6 }, (_, i) => ({ dept: "sales", minsAgo: 10 + i * 30 })));
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /Finance: failing now, the AI model was not found \(http_404\); no good turn in the last 6 h/);
  });

  await check("an 'ok' turn with output_tokens = 0 is an EMPTY SUCCESS and fails", async () => {
    await reset();
    await seed(
      { dept: "operations", minsAgo: 4, outcome: "ok", out: 0 },
      { dept: "operations", minsAgo: 90 },
      ...Array.from({ length: 6 }, (_, i) => ({ dept: "sales", minsAgo: 10 + i * 30 })),
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /Operations: failing now, the model answered ok but sent no text/);
  });

  await check("a provider that reports no usage (NULL output_tokens) is NOT an empty success", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5, out: null }, { dept: "sales", minsAgo: 15, out: null });
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  await check("RULE (b) NEVER PAGES: 3 of 4 turns failed but every department's latest turn is ok -> DEGRADED 'recovered at', never failing", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 10 }, // latest is fine: recovered at 17:50
      { dept: "sales", minsAgo: 25, outcome: "error", error: "empty_reply_thinking" },
      { dept: "sales", minsAgo: 60, outcome: "error", error: "empty_reply_thinking" },
      { dept: "sales", minsAgo: 90, outcome: "error", error: "stream_failed" },
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "degraded", "an ended burst must not hold a failing page for the rest of the window");
    assert.equal(r.observed, 3);
    assert.match(r.reason, /department chat recovered at 17:50 UTC, 10m ago after 3 failed turn\(s\); every department is answering again\./);
    assert.match(r.reason, /Last 6 h: 3 of 4 turns failed \(75%\)/);
    assert.match(r.reason, /Sales: answering again after 3 failed turn\(s\)/);
    assert.match(r.reason, /spent its whole answer budget thinking/);
    assert.ok(!/Check the AI engine/.test(outcomes.describe(r)), "a recovery notice is not a call to fix anything");
  });

  await check("...and it CLEARS: the same burst with its last failure over 30 minutes old is ok", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 10 },
      { dept: "sales", minsAgo: 50, outcome: "error", error: "empty_reply_thinking" },
      { dept: "sales", minsAgo: 80, outcome: "error", error: "empty_reply_thinking" },
      { dept: "sales", minsAgo: 110, outcome: "error", error: "stream_failed" },
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "ok");
    assert.equal(r.observed, 0);
    assert.match(r.reason, /3 failed earlier, and every department is answering again/);
  });

  await check("rule (a) still pages when a department's LATEST turn failed, even with the rate also tripped", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 5, outcome: "error", error: "stream_failed" },
      { dept: "sales", minsAgo: 25, outcome: "error", error: "stream_failed" },
      { dept: "sales", minsAgo: 45 },
      { dept: "marketing", minsAgo: 15 },
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /Sales: failing now/);
  });

  await check("exactly 50% over two turns with the latest ok is a recovery notice (never a page); 1 failure of 3 is ok", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5 }, { dept: "sales", minsAgo: 20, outcome: "error", error: "stream_failed" });
    assert.equal((await run(outcomes)).verdict, "degraded");
    await reset();
    await seed({ dept: "sales", minsAgo: 5 }, { dept: "sales", minsAgo: 30 }, { dept: "sales", minsAgo: 60, outcome: "error", error: "stream_failed" });
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  await check("one failed turn alone (a single turn) alerts through rule (a), not by a 100% rate", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5, outcome: "timeout" });
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /the call timed out/);
  });

  await check("a turn still in flight, or cancelled by the person, never fails the chat", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 1, outcome: "pending", out: null },
      { dept: "sales", minsAgo: 2, outcome: "cancelled", out: 0 },
      { dept: "sales", minsAgo: 20 },
    );
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  await check("a call whose end was never recorded (expired) IS a failure", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 3, outcome: "expired", error: "reservation_expired", out: null });
    const r = await run(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /started and never finished/);
  });

  await check("no turns at all is quiet: ok, and says nothing was graded, never a health number", async () => {
    await reset();
    for (const c of [outcomes, fallback]) {
      const r = await run(c);
      assert.equal(r.verdict, "ok");
      assert.equal(r.observed, 0);
      assert.match(r.reason, /nothing to grade \(this is not a health reading\)/);
      assert.ok(!/healthy/.test(r.reason), "a quiet window was described as healthy");
    }
  });

  await check("rows outside the 6 h window, or with no department, are not department chat", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 7 * 60, outcome: "error", error: "http_500" }, // too old
      { dept: null, minsAgo: 5, outcome: "error", error: "http_500" }, // a non-department call
    );
    const r = await run(outcomes);
    assert.equal(r.verdict, "ok");
    assert.match(r.reason, /nothing to grade/);
  });

  await check("another workspace's failures never alert this workspace, and the failing workspace is named", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 5 }, { dept: "sales", minsAgo: 25 },
      { tenant: CLIENT, dept: "marketing", minsAgo: 5, outcome: "error", error: "http_401" },
      { tenant: CLIENT, dept: "marketing", minsAgo: 15, outcome: "error", error: "http_401" },
    );
    assert.equal((await run(outcomes, OASIS)).verdict, "ok", "a client's failures alerted OASIS");
    const client = await run(outcomes, CLIENT);
    assert.equal(client.verdict, "failing");
    assert.match(client.reason, /^Client Co \(6b6b6b6b\): department chat is broken for Marketing\./);
    assert.match(client.reason, /the AI key was refused \(http_401\)/);
    // And the reverse: OASIS failing does not page the client.
    await reset();
    await seed({ dept: "sales", minsAgo: 5, outcome: "error", error: "http_500" }, { tenant: CLIENT, dept: "sales", minsAgo: 5 });
    assert.equal((await run(outcomes, CLIENT)).verdict, "ok");
    assert.equal((await run(outcomes, OASIS)).verdict, "failing");
  });

  // ── department_chat_fallback ─────────────────────────────────────────────
  await check("turns answered by a fallback -> DEGRADED (a warning), with the reason in words and a link", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 5, fallback: "model_retired:claude-sonnet-4-5" },
      { dept: "sales", minsAgo: 25, fallback: "model_retired:claude-sonnet-4-5" },
      { dept: "finance", minsAgo: 45, fallback: "model_access_limited:gemini-2.5-pro" },
      { dept: "marketing", minsAgo: 65 },
    );
    const r = await run(fallback);
    assert.equal(r.verdict, "degraded");
    assert.equal(r.observed, 3);
    assert.match(r.reason, /3 of 4 department chat turns in the last 6 h were answered by a fallback/);
    assert.match(r.reason, /Sales \(2\), Finance \(1\)/);
    assert.match(r.reason, /the chosen model claude-sonnet-4-5 is retired/);
    assert.match(r.reason, /the chosen model gemini-2\.5-pro is not available to this AI account/);
    assert.match(fallback.describe(r), /settings\/ai#engine/);
    // The chat itself is answering, so the outcomes check stays quiet.
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  await check("no fallback rows -> ok", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5 }, { dept: "sales", minsAgo: 25 });
    const r = await run(fallback);
    assert.equal(r.verdict, "ok");
    assert.match(r.reason, /none answered by a fallback/);
  });

  await check("a fallback in another workspace does not warn this one", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5 }, { tenant: CLIENT, dept: "sales", minsAgo: 5, fallback: "model_retired:x" });
    assert.equal((await run(fallback, OASIS)).verdict, "ok");
    assert.equal((await run(fallback, CLIENT)).verdict, "degraded");
  });

  // ── a read that fails is LOUD ────────────────────────────────────────────
  await check("ai_usage_events unreadable -> check_broken with the reason, never ok (both checks)", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5 });
    await db.execute("ALTER TABLE ai_usage_events RENAME TO ai_usage_events_hidden");
    try {
      for (const c of [outcomes, fallback]) {
        const r = await run(c);
        assert.equal(r.verdict, "check_broken", `${c.id} read a missing table as ${r.verdict}`);
        assert.match(r.reason, /could not read ai_usage_events, so department chat is NOT being watched/);
        assert.match(c.describe(r), /NOT being watched/);
      }
    } finally {
      await db.execute("ALTER TABLE ai_usage_events_hidden RENAME TO ai_usage_events");
    }
    assert.equal((await run(outcomes)).verdict, "ok", "control: with the table back the same data reads ok");
  });

  // ── tenant discovery ─────────────────────────────────────────────────────
  await check("departmentChatTenantIds: OASIS always, plus workspaces with a department turn in the window; never a retired one", async () => {
    await reset();
    await seed(
      { tenant: CLIENT, dept: "sales", minsAgo: 30 },
      { tenant: RETIRED, dept: "sales", minsAgo: 30 },
      { tenant: "ffffffff-0000-4000-8000-0000000000ff", dept: "sales", minsAgo: 7 * 60 }, // outside the window
      { tenant: "eeeeeeee-0000-4000-8000-0000000000ee", dept: null, minsAgo: 5 }, // not a department call
    );
    const found = await departmentChatTenantIds(NOW);
    assert.equal(found.error, null);
    assert.deepEqual([...found.tenantIds].sort(), [OASIS, CLIENT].sort());
    await reset();
    assert.deepEqual((await departmentChatTenantIds(NOW)).tenantIds, [OASIS], "a quiet estate still grades OASIS");
  });

  // ── the real runner: page once, dedupe, announce recovery ────────────────
  await check("runHealthChecks pages CC's lane once, persists the explanation, dedupes, and announces recovery", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 5, outcome: "error", error: "empty_reply_empty", out: 0 }, ...Array.from({ length: 8 }, (_, i) => ({ dept: "marketing", minsAgo: 10 + i * 20 })));
    const pages: Array<{ text: string; lane: string }> = [];
    const send = async (text: string, opts: { lane: string }) => {
      pages.push({ text, lane: opts.lane });
      return { ok: true };
    };
    const first = await runHealthChecks(OASIS, { checks: DEPARTMENT_CHAT_CHECKS, nowMs: NOW, sendTelegramImpl: send as never });
    assert.deepEqual(first.alerted, ["department_chat_outcomes"]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].lane, "operator");
    assert.match(pages[0].text, /FAILING/);
    assert.match(pages[0].text, /Sales/);
    assert.match(pages[0].text, /empty reply/);
    assert.match(pages[0].text, /settings\/ai#engine/);

    const saved = await db.execute("SELECT verdict, reason FROM health_check_runs WHERE check_id = 'department_chat_outcomes'");
    assert.equal(saved.rows[0].verdict, "failing");
    assert.match(String(saved.rows[0].reason), /Sales/, "the history must say WHAT was broken");

    const again = await runHealthChecks(OASIS, { checks: DEPARTMENT_CHAT_CHECKS, nowMs: NOW + 15 * MIN, sendTelegramImpl: send as never });
    assert.deepEqual(again.alerted, [], "the same condition re-paged within the decay window");
    assert.equal(pages.length, 1);

    await seed({ dept: "sales", minsAgo: -16 }); // a good Sales turn 1 minute after the second run's start
    await seed({ dept: "sales", minsAgo: -17 }, { dept: "sales", minsAgo: -18 });
    const healed = await runHealthChecks(OASIS, { checks: DEPARTMENT_CHAT_CHECKS, nowMs: NOW + 40 * MIN, sendTelegramImpl: send as never });
    assert.deepEqual(healed.recovered, ["department_chat_outcomes"]);
    assert.match(pages[pages.length - 1].text, /RECOVERED/);
  });

  // ── the engine fallback, in words ────────────────────────────────────────
  await check("engine_unreachable:<app> reads as 'your PC's <app> couldn't be reached', alone or joined with a model swap", () => {
    assert.match(plainFallback("engine_unreachable:claude"), /^your PC's Claude Code couldn't be reached, so the API account answered \(engine_unreachable:claude\)$/);
    assert.match(plainFallback("engine_unreachable:codex"), /your PC's Codex couldn't be reached/);
    assert.match(plainFallback("engine_unreachable:gemini"), /your PC's Gemini CLI couldn't be reached/);
    assert.match(plainFallback("engine_unreachable:local"), /your PC's local model couldn't be reached/);
    const both = plainFallback("model_retired:claude-3-5-sonnet-20241022+engine_unreachable:claude");
    assert.match(both, /the chosen model claude-3-5-sonnet-20241022 is retired/);
    assert.match(both, / and your PC's Claude Code couldn't be reached/);
    assert.match(plainFallback("engine_unreachable:vim"), /no wording for \(engine_unreachable:vim\)/, "an unknown app is shown, not guessed");
  });

  await check("turns that fell back from the chosen engine warn, naming the engine; the chat itself is answering so outcomes stays quiet", async () => {
    await reset();
    await seed(
      { dept: "sales", minsAgo: 5, fallback: "engine_unreachable:claude" },
      { dept: "marketing", minsAgo: 15, fallback: "engine_unreachable:claude" },
      { dept: "finance", minsAgo: 25 },
    );
    const r = await run(fallback);
    assert.equal(r.verdict, "degraded");
    assert.match(r.reason, /2 of 3 department chat turns in the last 6 h were answered by a fallback/);
    assert.match(r.reason, /your PC's Claude Code couldn't be reached, so the API account answered/);
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  // ── turns on the paired computer reach the check through the real meter ──
  const nowRun = (c: typeof outcomes) => runCheck(supa, OASIS, c, Date.now() + MIN);
  type Ev = { type: "delta"; text: string } | { type: "done"; inputTokens: number; outputTokens: number } | { type: "error"; message: string };
  /** One real bridge turn through meteredBridgeTurn and the real meter, writing the real row. */
  async function bridgeTurn(events: Ev[], engine: { kind: "cli"; cli: "claude" } | { kind: "local"; model: string } = { kind: "cli", cli: "claude" }) {
    const meter = modelCallMeter({ tenantId: OASIS, surface: "agents.chat", ...billingForBridge(engine), departmentKey: "sales", teammateId: "sdr" });
    async function* inner() {
      for (const ev of events) yield ev;
    }
    const seen: Ev[] = [];
    for await (const ev of meteredBridgeTurn(meter, engine, inner(), { maxOutputTokens: 100, promptBytes: 50 })) seen.push(ev as Ev);
    assert.deepEqual(seen, events, "the events pass through unchanged");
  }

  await check("a healthy turn on the paired computer is one row, and department_chat_outcomes reads it as ok", async () => {
    await reset();
    await bridgeTurn([{ type: "delta", text: "Pipeline is healthy." }, { type: "done", inputTokens: 0, outputTokens: 0 }]);
    const rows = (await db.execute("SELECT provider, model, outcome, output_tokens, cost_micro_usd, reserved_micro_usd FROM ai_usage_events")).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].provider, rows[0].model, rows[0].outcome, rows[0].cost_micro_usd, rows[0].reserved_micro_usd], ["bridge", "claude", "ok", 0, null]);
    assert.ok(Number(rows[0].output_tokens) > 0, "a reply with words never records 0 output");
    const r = await nowRun(outcomes);
    assert.equal(r.verdict, "ok", r.reason);
    assert.match(r.reason, /1 department chat turn\(s\)/);
  });

  await check("a bridge turn that failed (computer unreachable / the app errored) makes department_chat_outcomes ALERT, in words", async () => {
    await reset();
    await bridgeTurn([{ type: "error", message: "bridge_unreachable:TypeError" }]);
    let r = await nowRun(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /Sales: failing now, the paired computer could not be reached \(bridge_unreachable\)/);
    await reset();
    await bridgeTurn([{ type: "error", message: "cli_error:cli_not_found" }]);
    r = await nowRun(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /the AI app is not installed on the paired computer \(cli_not_found\)/);
  });

  await check("an EMPTY reply from the CLI alerts, whether it arrives as an error event or as a stream that simply ends", async () => {
    await reset();
    await bridgeTurn([{ type: "error", message: "empty_reply:empty" }]);
    let r = await nowRun(outcomes);
    assert.equal(r.verdict, "failing");
    assert.match(r.reason, /the model sent back an empty reply \(empty_reply_empty\)/);
    await reset();
    await bridgeTurn([]); // the stream ended with nothing at all
    r = await nowRun(outcomes);
    assert.equal(r.verdict, "failing", "a stream with no events graded ok");
    await reset();
    await bridgeTurn([{ type: "done", inputTokens: 4, outputTokens: 0 }]); // finished, no text
    assert.equal((await nowRun(outcomes)).verdict, "failing", "a finished stream with no text graded ok");
  });

  await check("a local model turn on the paired computer is named and graded the same way", async () => {
    await reset();
    await bridgeTurn([{ type: "error", message: "empty_reply:empty" }], { kind: "local", model: "llama3.3" });
    const row = (await db.execute("SELECT provider, model, billing_mode FROM ai_usage_events")).rows[0];
    assert.deepEqual([row.provider, row.model, row.billing_mode], ["bridge", "llama3.3", "local"]);
    assert.equal((await nowRun(outcomes)).verdict, "failing");
  });

  // ── refusals before any model is asked ───────────────────────────────────
  await check("a department turn refused before a model was asked alerts, in words", async () => {
    for (const [code, words] of [
      ["agent_not_configured", /no AI account is connected for this workspace to answer with \(agent_not_configured\)/],
      ["key_unreadable", /the saved AI key could not be read \(key_unreadable\)/],
      ["config_unavailable", /the workspace's AI settings could not be read \(config_unavailable\)/],
    ] as const) {
      await reset();
      await seed({ dept: "operations", minsAgo: 2, outcome: "error", error: code, out: null });
      const r = await run(outcomes);
      assert.equal(r.verdict, "failing", code);
      assert.match(r.reason, words);
    }
  });

  // ── a tool step is not an empty reply ────────────────────────────────────
  await check("a tool-using turn whose tool step recorded no output count (NULL) and whose answer step has words grades ok", async () => {
    await reset();
    await seed({ dept: "sales", minsAgo: 4, out: null }, { dept: "sales", minsAgo: 3 }, { dept: "sales", minsAgo: 40, out: null }, { dept: "sales", minsAgo: 39 });
    assert.equal((await run(outcomes)).verdict, "ok");
  });

  // ── isolation and bounds of the per-workspace run ───────────────────────
  const OTHER = "9d9d9d9d-0000-4000-8000-00000000009d";
  await check("a workspace whose run throws is logged and recorded check_broken for THAT workspace; the others still return, and only OASIS may page", async () => {
    await db.execute("DELETE FROM health_check_runs");
    const notifyBy: Record<string, boolean> = {};
    const run2 = async (tenantId: string, opts: { notify?: boolean }) => {
      notifyBy[tenantId] = opts.notify === true;
      if (tenantId === CLIENT) throw new Error("health_alert_state upsert failed");
      return runHealthChecks(tenantId, { ...(opts as object), sendTelegramImpl: (async () => ({ ok: true })) as never });
    };
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    let out;
    try {
      out = await runDepartmentChatHealth({ notify: true, nowMs: NOW, discover: async () => ({ tenantIds: [OASIS, CLIENT, OTHER], error: null }), run: run2 as never });
    } finally {
      console.error = realError;
    }
    assert.deepEqual(out.map((o) => [o.tenantId, o.failed]), [[OASIS, false], [CLIENT, true], [OTHER, false]]);
    assert.equal(out[1].summary.worst, "check_broken");
    assert.match(out[1].summary.results[0].reason, /health_alert_state upsert failed/);
    assert.equal(out[0].summary.ran, 2, "OASIS's real checks ran");
    assert.ok(logged.some((l) => String(l[0]).includes("department chat run failed")), "the failure was logged with its error");
    const rec = (await db.execute({ sql: "SELECT verdict, check_id, reason FROM health_check_runs WHERE tenant_id = ? AND verdict = 'check_broken'", args: [CLIENT] })).rows;
    assert.equal(rec.length, 1, "recorded as check_broken for the failing workspace");
    assert.equal(rec[0].check_id, "department_chat_outcomes");
    assert.deepEqual(notifyBy, { [OASIS]: true, [CLIENT]: false, [OTHER]: false }, "a workspace that is not OASIS's own never pages the operator chat");
  });

  await check("the per-workspace fan-out is bounded", async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 13 }, (_, i) => `t${i}`);
    const slow = async (tenantId: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return brokenSummary("x", tenantId);
    };
    const out = await runDepartmentChatHealth({ notify: false, discover: async () => ({ tenantIds: ids, error: null }), run: slow as never });
    assert.equal(out.length, 13, "every workspace is still graded");
    assert.ok(peak <= DEPARTMENT_CHAT_FANOUT && peak > 1, `peak concurrency ${peak}`);
    assert.equal(DEPARTMENT_CHAT_FANOUT, 5);
  });

  await check("a failed tenant discovery is logged and OASIS is still graded", async () => {
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      const out = await runDepartmentChatHealth({ notify: false, discover: async () => ({ tenantIds: [OASIS], error: "boom" }), run: (async () => brokenSummary("x", "ran")) as never });
      assert.equal(out.length, 1);
    } finally {
      console.error = realError;
    }
    assert.ok(logged.some((l) => String(l[0]).includes("tenant discovery failed")));
  });

  // ── pure grading and wording ─────────────────────────────────────────────
  await check("isFailedTurn: ok with zero tokens fails; ok with NULL tokens and ok with tokens do not; any other outcome fails", () => {
    const base = { occurredAt: "2026-10-09T17:00:00.000Z", department: "sales", errorCode: null, fallbackReason: null };
    assert.equal(isFailedTurn({ ...base, outcome: "ok", outputTokens: 0 }), true);
    assert.equal(isFailedTurn({ ...base, outcome: "ok", outputTokens: null }), false);
    assert.equal(isFailedTurn({ ...base, outcome: "ok", outputTokens: 12 }), false);
    for (const outcome of ["error", "refused", "timeout", "expired"]) {
      assert.equal(isFailedTurn({ ...base, outcome, outputTokens: 5 }), true, outcome);
    }
  });

  await check("gradeDepartmentTurns: no turns grades nothing", () => {
    const g = gradeDepartmentTurns([]);
    assert.equal(g.graded, 0);
    assert.equal(g.trouble.length, 0);
  });

  await check("plain words: statuses, empty replies, budget, unknown codes are shown not hidden", () => {
    const t = (errorCode: string | null, outcome = "error") => ({
      occurredAt: "2026-10-09T17:00:00.000Z", department: "sales", outcome, errorCode, outputTokens: null, fallbackReason: null,
    });
    assert.match(plainFailure(t("http_402")), /out of credits \(http_402\)/);
    assert.match(plainFailure(t("http_503")), /provider is down \(http_503\)/);
    assert.match(plainFailure(t("ai_budget_exhausted")), /budget is used/);
    assert.match(plainFailure(t("something_new")), /no wording for \(something_new\)/);
    assert.match(plainFailure(t(null)), /recorded no error code/);
    assert.match(plainFallback("model_expired:gpt-x"), /gpt-x is expired/);
    assert.match(plainFallback("surprise"), /no wording for \(surprise\)/);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
  console.log("health department chat tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
