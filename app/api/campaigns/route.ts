/**
 * /api/campaigns — TextTorrent bulk-campaign analytics + create.
 *
 * Phase 3c of the TT + Kixie full embedding plan (2026-06-02).
 *
 * GET  → list campaigns with per-campaign analytics (sent / delivered /
 *        clicked / failed / opted_out). Uses the inline counts when TT
 *        returns them on /campaign; otherwise fans out to
 *        /campaign/{id}/messages/counts, bounded + limiter-aware.
 *
 * POST → create a bulk campaign { list_id, message, scheduled_time? }.
 *        Owner/admin only (a blast hits many recipients). DRY-RUN by
 *        default — see lib/integrations/send-mode.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveTenantId, resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import {
  getTextTorrentCredentials,
  listCampaigns,
  campaignCounts,
  createCampaign,
  listLists,
  listTemplates,
  TextTorrentError,
  type TtCampaign,
  type TtList,
} from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap the per-campaign counts fan-out so a long campaign history can't blow
// the TT 60/min limiter on a single page load.
const COUNTS_FANOUT_CAP = 20;

function ttStatus(err: TextTorrentError): number {
  return err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
}

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const creds = await getTextTorrentCredentials(tenantId);
    const list = await listCampaigns(creds, { limit: 50 });
    const campaigns = list.data || [];
    const enriched: TtCampaign[] = [];
    let fanout = 0;
    let rateLimited = false;
    for (const c of campaigns) {
      // Use inline metrics when present; otherwise fetch counts (bounded).
      if (typeof c.sent === "number" || fanout >= COUNTS_FANOUT_CAP || rateLimited) {
        enriched.push(c);
        continue;
      }
      fanout += 1;
      try {
        const counts = await campaignCounts(creds, c.id);
        enriched.push({ ...c, ...counts.data });
      } catch (e) {
        if (e instanceof TextTorrentError && e.status === 429) rateLimited = true;
        enriched.push(c);
      }
    }
    // Lists + templates power the create-campaign form. Guarded so a
    // failure here never breaks the analytics table.
    let lists: TtList[] = [];
    let templates: Array<{ id: string; name: string; content: string }> = [];
    try {
      lists = (await listLists(creds)).data || [];
    } catch {
      /* form list-picker degrades to empty */
    }
    try {
      templates = (await listTemplates(creds, { limit: 50 })).data || [];
    } catch {
      /* form template-picker degrades to empty */
    }

    return NextResponse.json({
      ok: true,
      campaigns: enriched,
      lists,
      templates,
      rate_limited: rateLimited,
      counts_truncated: campaigns.length > COUNTS_FANOUT_CAP,
    });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: ttStatus(err) });
    }
    return NextResponse.json(
      { ok: false, error: "campaigns_list_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}

/** Fail-closed owner/admin gate — mirrors the chat route's callerIsAdmin. */
async function callerIsAdmin(authUserId: string): Promise<boolean> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("user_profiles")
      .select("is_owner, team_role")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    const op = r.data as { is_owner: boolean | null; team_role: string | null } | null;
    return !!op && (op.is_owner === true || op.team_role === "owner" || op.team_role === "admin");
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json(
      { ok: false, error: session.reason },
      { status: session.reason === "no_session" ? 401 : 400 },
    );
  }
  if (!(await callerIsAdmin(session.userId))) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Launching a bulk campaign is owner/admin only." },
      { status: 403 },
    );
  }

  let body: { list_id?: unknown; message?: unknown; scheduled_time?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const listId = typeof body.list_id === "string" ? body.list_id.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const scheduledTime =
    typeof body.scheduled_time === "string" && body.scheduled_time.trim()
      ? body.scheduled_time.trim()
      : undefined;
  if (!listId) {
    return NextResponse.json({ ok: false, error: "list_id_required" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ ok: false, error: "message_required" }, { status: 400 });
  }

  // Merchant-facing safety guard (fail-closed): block any lender name, strip
  // em dashes. A blast is the highest-volume merchant-facing surface.
  const safe = await sanitizeBlastMessage(session.tenantId, message);
  if (!safe.ok) {
    return NextResponse.json(
      { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits },
      { status: 400 },
    );
  }
  const cleanMessage = safe.cleaned;

  if (isDryRun()) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      would_create: { list_id: listId, message: cleanMessage, scheduled_time: scheduledTime },
    });
  }

  try {
    const creds = await getTextTorrentCredentials(session.tenantId);
    const r = await createCampaign(creds, {
      list_id: listId,
      message: cleanMessage,
      scheduled_time: scheduledTime,
    });
    return NextResponse.json({ ok: true, dry_run: false, campaign: r.data });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: ttStatus(err) });
    }
    return NextResponse.json(
      { ok: false, error: "campaign_create_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
