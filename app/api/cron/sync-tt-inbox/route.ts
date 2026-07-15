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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const r = await syncTenantInbox(SUNBIZ_TENANT_ID, { maxChats: 15 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "sync_failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
