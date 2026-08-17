/**
 * GET/POST /api/cron/sync-tt-inbox — pull SunBiz's recent Text Torrent inbox
 * threads into lead_interactions so inbound SMS replies land in oasis (the TT
 * inbound webhook isn't delivering, so we poll). Oasis-side only — does NOT
 * touch the live JARVIS Jordan agent. Bounded + idempotent: syncTenantInbox
 * lists the inbox once + pulls up to maxChats threads, stops on 429 (rate-limit
 * safe, shared 60/min TT budget), dedups by phone+direction+content.
 *
 * Auth mirrors collect-outreach-intel: Bearer SCAN_TRIGGER_SECRET (manual) OR
 * CRON_SECRET (Vercel cron sends this automatically). Scheduled every 30 min
 * in vercel.json.
 */
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { syncTenantInbox } from "@/lib/integrations/texttorrent-ingest";
import { processReplyHandoffs } from "@/lib/drips/reply-handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SUNBIZ_TENANT_ID = process.env.TEXTTORRENT_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return false;
  for (const secret of [process.env.SCAN_TRIGGER_SECRET, process.env.CRON_SECRET]) {
    if (!secret) continue;
    const a = Buffer.from(bearer);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    // Env-tunable without a redeploy. Defaults bumped 15 -> 40 for fuller
    // ongoing coverage of the recent inbox. For a deeper one-time HISTORY
    // backfill, raise TT_SYNC_MAX_CHATS (cap 200) and TT_SYNC_PAGES (cap 10,
    // each page = 50 older chats), let it run a few cycles, then revert — the
    // sync is idempotent and 429-safe on the shared 60/min TT budget.
    const maxChats = Number(process.env.TT_SYNC_MAX_CHATS) || 40;
    const pages = Number(process.env.TT_SYNC_PAGES) || 1;
    // ?account=followup reads the LEGACY parent, which owns the AI Follow-Up
    // wire and every Live Subs conversation. Scheduled as its own invocation
    // (vercel.json + cron-driver.yml) so one account's credential failure
    // cannot abort the other account's sync, and so each shows up separately
    // when it breaks.
    const service = new URL(req.url).searchParams.get("account") === "followup"
      ? "texttorrent_followup"
      : "texttorrent";
    const r = await syncTenantInbox(SUNBIZ_TENANT_ID, { maxChats, pages, service });

    // Handoffs run straight after the ingest that produces them, so a merchant
    // who answers is off the drip within one tick rather than one more nudge.
    // Runs on BOTH accounts: the scan is keyed on lead_interactions, not on
    // which mailbox the sync just read, and the per-lead marker makes a second
    // pass a no-op. Never allowed to fail the sync — the messages are already
    // persisted and the next tick retries the handoff.
    let handoff: Awaited<ReturnType<typeof processReplyHandoffs>> | { errors: string[] } = { errors: [] };
    try {
      handoff = await processReplyHandoffs(SUNBIZ_TENANT_ID);
    } catch (e) {
      handoff = { errors: [e instanceof Error ? e.message.slice(0, 200) : "handoff_failed"] };
    }

    return NextResponse.json({ ok: true, account: service, maxChats, pages, ...r, handoff });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "sync_failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
