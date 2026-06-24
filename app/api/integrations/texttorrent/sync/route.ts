/**
 * POST /api/integrations/texttorrent/sync — pull the tenant's recent Text
 * Torrent threads into lead_interactions so the Conversations "Text Torrent"
 * section shows full history (the inbound webhook only captures NEW texts).
 *
 * Session-authed (any tenant member). Idempotent + bounded (TT 60/min limit).
 * Drives the "Sync now" button on the per-rep Text Torrent connect card; a
 * scheduled backstop can call the same logic later.
 */
import { NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { syncTenantInbox } from "@/lib/integrations/texttorrent-ingest";
import { TextTorrentError } from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function resolveTenantId(userId: string): Promise<string | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (r.data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
}

export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  try {
    const result = await syncTenantInbox(tenantId, { maxChats: 40 });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof TextTorrentError) {
      // missing_credentials / rate_limited / http_* — surface a clean message.
      const status = e.code === "missing_credentials" ? 400 : e.status === 429 ? 429 : 502;
      return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status });
    }
    console.error("[tt-sync] failed", e);
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 500 });
  }
}
