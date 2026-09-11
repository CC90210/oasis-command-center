/**
 * tests/kixie-compliance-tenant-lanes.test.ts — the Kixie compliance scan reads
 * only tenants that have their own lane, and posts each one's results there.
 *
 * WHY THIS EXISTS
 * ---------------
 * The scan read EVERY tenant's Kixie call summaries and alerted sunbiz-ops.
 * Only SunBiz uses Kixie today, but the first OASIS call to land in
 * lead_interactions would have been scanned against SunBiz's lender doctrine
 * and its rep, lead and transcript snippet posted in SunBiz's ops channel.
 *
 * Real route, real adapter, on-disk libSQL; only Telegram is stubbed, so the
 * test can see which chat each message went to.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CRON = "kixie-cron-test-secret-0001";

const dbFile = join(mkdtempSync(join(tmpdir(), "kixie-lanes-")), "kixie.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.CRON_SECRET = CRON;
delete process.env.SCAN_TRIGGER_SECRET;
// One distinct bot + chat per lane, so every send can be attributed.
process.env.SUNBIZ_OPS_TELEGRAM_BOT_TOKEN = "sunbiz-bot";
process.env.SUNBIZ_OPS_TELEGRAM_CHAT_ID = "sunbiz-chat";
delete process.env.SUNBIZ_TELEGRAM_BOT_TOKEN;
delete process.env.SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID;
process.env.OASIS_TELEGRAM_BOT_TOKEN = "operator-bot";
process.env.OASIS_TELEGRAM_CHAT_ID = "operator-chat";

const sent: Array<{ url: string; body: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(input), body: String(init?.body ?? "") });
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}) as typeof fetch;

const seed = createClient({ url: `file:${dbFile}` });

async function main() {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const row = (id: string, tenant: string, type: string, rep: string, content: string | null, dur: number) =>
    `INSERT INTO lead_interactions VALUES ('${id}', '${tenant}', 'lead-${id}', '${type}', ` +
    `${content === null ? "NULL" : `'${content}'`}, '${hourAgo}', '{"kixie_agent_email":"${rep}"}', ` +
    `'call-${id}', ${dur}, NULL, 'kixie', 'phone')`;

  await seed.batch(
    [
      `CREATE TABLE lead_interactions (
         id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT, content TEXT,
         created_at TEXT, metadata TEXT, kixie_call_id TEXT, call_duration_sec INTEGER,
         call_outcome TEXT, agent_source TEXT, channel TEXT)`,
      `CREATE TABLE tenants (id TEXT PRIMARY KEY, custom_fields TEXT)`,
      `CREATE TABLE agent_events (
         id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
         event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT,
         correlation_id TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
      `INSERT INTO tenants VALUES ('${SUNBIZ}', NULL)`,
      `INSERT INTO tenants VALUES ('${OASIS}', NULL)`,
      row("sb-ci", SUNBIZ, "call_ci_summary", "rep@sunbiz.test", "Rep said our lenders can fund this week", 0),
      row("oa-ci", OASIS, "call_ci_summary", "closer@oasis.test", "OASIS-ONLY-SNIPPET our lenders mention", 0),
      row("sb-dial", SUNBIZ, "call_answered", "rep@sunbiz.test", null, 45),
      row("oa-dial", OASIS, "call_answered", "closer@oasis.test", null, 90),
    ],
    "write",
  );

  const route = await import("../app/api/cron/kixie-compliance-scan/route");
  const res = await route.GET(
    new NextRequest("http://localhost/api/cron/kixie-compliance-scan?mode=weekly", {
      headers: { authorization: `Bearer ${CRON}` },
    }),
  );
  const body = (await res.json()) as {
    ok: boolean;
    scanned: number;
    flagged: number;
    flags: Array<{ interaction_id: string }>;
    weekly?: Array<{ rep: string }>;
    failures: string[];
  };
  assert.equal(res.status, 200, `scan must succeed: ${JSON.stringify(body.failures)}`);

  // ── Only SunBiz's calls were read ────────────────────────────────────────
  assert.equal(body.scanned, 1, "OASIS's call summary must not be scanned at all");
  assert.deepEqual(
    body.flags.map((f) => f.interaction_id),
    ["sb-ci"],
    "only SunBiz's call is flagged",
  );
  assert.deepEqual(
    (body.weekly || []).map((r) => r.rep),
    ["rep@sunbiz.test"],
    "the weekly scorecard covers SunBiz's reps only",
  );

  // ── Every message went to SunBiz's own lane, and carries nothing of OASIS ─
  assert.equal(sent.length, 2, "one compliance alert + one weekly digest");
  for (const s of sent) {
    assert.ok(s.url.includes("/botsunbiz-bot/"), `sent with SunBiz's bot, got ${s.url}`);
    assert.equal(JSON.parse(s.body).chat_id, "sunbiz-chat");
    assert.ok(!s.body.includes("closer@oasis.test"), "no OASIS rep in a SunBiz message");
    assert.ok(!s.body.includes("OASIS-ONLY-SNIPPET"), "no OASIS transcript text in a SunBiz message");
  }

  // ── The feed rows are SunBiz's only ──────────────────────────────────────
  const events = await seed.execute("SELECT correlation_id, payload FROM agent_events");
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].correlation_id, SUNBIZ);
  assert.equal(JSON.parse(String(events.rows[0].payload)).interaction_id, "sb-ci");
}

main().then(
  () => console.log("kixie-compliance-tenant-lanes: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
