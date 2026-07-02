/**
 * Operator Email Agent — monitor tick. Driven by the JARVIS scheduler (Bearer
 * SCAN_TRIGGER_SECRET), like scan-lender-replies. For each active agent
 * (agent_email_settings.mode != off), poll each enabled+ready mailbox
 * (work/personal), ingest deal-matched email into lead_interactions, advance the
 * cursor. Phase 1 = MONITOR only (read + ingest); draft/semi/full send paths are
 * intentionally not wired yet (mode is respected but only 'monitor' acts).
 *
 * SAFE: DRY-RUN unless ?write=1 AND mode != monitor-only gate below. Fail-closed
 * auth. Per-agent try/catch so one bad mailbox can't kill the tick. Reads are
 * gmail.readonly; nothing is ever sent from here in Phase 1.
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { listActiveAgents, markProcessed, type AgentEmailSettings } from "@/lib/agents/operator-email/settings";
import { readMailbox } from "@/lib/agents/operator-email/gmail-read";
import { ingestMessages, type IngestResult } from "@/lib/agents/operator-email/ingest";
import { writeSnapshot } from "@/lib/agents/operator-email/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function checkTrigger(req: NextRequest): NextResponse | null {
  const secret = process.env.SCAN_TRIGGER_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "trigger_not_configured" }, { status: 500 });
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(bearer);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function runAgent(agent: AgentEmailSettings, write: boolean) {
  const dryRun = !write; // writes are held off the schedule until verified
  const results: Record<string, IngestResult & { diag: string }> = {};
  const mailboxes: ("work" | "personal")[] = [];
  if (agent.workEnabled) mailboxes.push("work");
  if (agent.personalEnabled) mailboxes.push("personal");

  // Rolling window shared by both mailboxes; message-id dedupe makes overlap safe.
  const since = agent.lastProcessedAt
    ? `after:${Math.floor(Date.parse(agent.lastProcessedAt) / 1000)}`
    : "newer_than:2d";

  for (const mailbox of mailboxes) {
    // readMailbox self-checks bundle + readonly scope and reports why via `diag`
    // (scope_missing_readonly / token_refresh_failed / list_http_* / ok_N).
    const read = await readMailbox(agent.tenantId, agent.userId, mailbox, {
      query: `${since} -in:chats`,
      max: 40,
    });
    const ing = await ingestMessages(
      { tenantId: agent.tenantId, userId: agent.userId, mailbox, dryRun },
      read.messages,
    );
    results[mailbox] = { ...ing, diag: read.diag };
  }
  // Only advance the cursor on a real (write) run — a DRY tick must not consume
  // the window, or it silently skips messages the live run should have ingested.
  if (write) {
    await markProcessed(agent.tenantId, agent.userId);
    await writeSnapshot(agent.tenantId, agent.userId); // metrics for the dashboard cards
  }
  return results;
}

async function handle(req: NextRequest) {
  const denied = checkTrigger(req);
  if (denied) return denied;
  const write = req.nextUrl.searchParams.get("write") === "1";

  let agents: AgentEmailSettings[] = [];
  try {
    agents = await listActiveAgents(10);
  } catch {
    return NextResponse.json({ ok: false, error: "settings_read_failed" }, { status: 500 });
  }

  const summary: Record<string, unknown> = {};
  for (const agent of agents) {
    // Phase 1: only 'monitor' does work. Higher modes are recognized but the
    // send/draft paths are not wired yet — they no-op until a later phase.
    try {
      summary[agent.userId] = { mode: agent.mode, mailboxes: await runAgent(agent, write) };
    } catch (e) {
      summary[agent.userId] = { mode: agent.mode, error: e instanceof Error ? e.message : "agent_tick_failed" };
    }
  }

  return NextResponse.json({ ok: true, dry_run: !write, agents: agents.length, summary });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
