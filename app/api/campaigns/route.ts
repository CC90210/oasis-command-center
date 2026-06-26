/**
 * /api/campaigns — TextTorrent native bulk campaigns (anti-block engine).
 *
 * GET  → list campaigns + status from /campaigning/analytic, plus the contact
 *        lists that power the create form.
 *
 * POST → launch a native bulk campaign via /campaigning/bulk — TT's carrier-safe
 *        mass-send engine (number-pool rotation, round-robin, batch drip,
 *        opt-out link). Owner/admin only. DRY-RUN unless the texttorrent channel
 *        is live (see lib/integrations/send-mode.ts).
 *
 * The earlier /campaign/* paths 404 — the live namespace is /campaigning/*.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveTenantId, resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import {
  getTextTorrentCredentials,
  listCampaigns,
  createBulkCampaign,
  listLists,
  TextTorrentError,
  type TtCampaign,
  type TtList,
} from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ttStatus(err: TextTorrentError): number {
  return err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
}

/** Coerce a body value to a boolean with a default (TT anti-block flags). */
function boolOr(v: unknown, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return dflt;
}

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const creds = await getTextTorrentCredentials(tenantId);
    let campaigns: TtCampaign[] = [];
    try {
      campaigns = (await listCampaigns(creds, { limit: 50 })).data || [];
    } catch (e) {
      // Don't let an analytics hiccup break the create form; only surface 429.
      if (e instanceof TextTorrentError && e.status === 429) throw e;
    }
    // Contact lists power the create-form audience picker.
    let lists: TtList[] = [];
    try {
      lists = (await listLists(creds)).data || [];
    } catch {
      /* form list-picker degrades to empty */
    }

    return NextResponse.json({ ok: true, campaigns, lists, templates: [] });
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

type CampaignBody = {
  list_id?: unknown;
  message?: unknown;
  campaign_name?: unknown;
  numbers?: unknown;
  sms_type?: unknown;
  number_pool?: unknown;
  round_robin?: unknown;
  batch_process?: unknown;
  batch_size?: unknown;
  batch_frequency?: unknown;
  opt_out_link?: unknown;
  scheduled_date?: unknown;
  scheduled_time?: unknown;
};

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

  let body: CampaignBody;
  try {
    body = (await req.json().catch(() => ({}))) as CampaignBody;
  } catch {
    body = {};
  }
  const listId = typeof body.list_id === "string" ? body.list_id.trim() : String(body.list_id ?? "").trim();
  const message = typeof body.message === "string" ? body.message.trim() : "";
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

  try {
    const creds = await getTextTorrentCredentials(session.tenantId);

    // Sender-number pool. Explicit list wins; otherwise the rep's resolved
    // sending number (tenant default). TT requires at least one.
    let numbers: string[] = Array.isArray(body.numbers)
      ? body.numbers.map((n) => String(n).trim()).filter(Boolean)
      : [];
    if (!numbers.length) {
      const senderId = await resolveTextTorrentSenderId({
        tenantId: session.tenantId,
        userId: session.userId,
      });
      if (senderId) numbers = [senderId];
    }
    if (!numbers.length) {
      return NextResponse.json(
        { ok: false, error: "no_sender_number", message: "No sender number — set a Default Business Number in Settings → Integrations or pick numbers to blast from." },
        { status: 400 },
      );
    }

    const campaignName =
      typeof body.campaign_name === "string" && body.campaign_name.trim()
        ? body.campaign_name.trim().slice(0, 255)
        : `Campaign ${new Date().toISOString().slice(0, 10)}`;
    const scheduledDate = typeof body.scheduled_date === "string" && body.scheduled_date.trim() ? body.scheduled_date.trim() : undefined;
    const scheduledTime = typeof body.scheduled_time === "string" && body.scheduled_time.trim() ? body.scheduled_time.trim() : undefined;

    // Anti-block defaults ON — the whole point of native campaigns.
    const args = {
      campaign_name: campaignName,
      contact_list_id: listId,
      sms_body: cleanMessage,
      numbers,
      sms_type: "sms" as const,
      number_pool: boolOr(body.number_pool, numbers.length > 1),
      round_robin_campaign: boolOr(body.round_robin, numbers.length > 1),
      batch_process: boolOr(body.batch_process, true),
      batch_size: typeof body.batch_size === "number" ? body.batch_size : undefined,
      batch_frequency: typeof body.batch_frequency === "number" ? body.batch_frequency : undefined,
      opt_out_link: boolOr(body.opt_out_link, true),
      selected_date: scheduledDate,
      selected_time: scheduledTime,
    };

    if (isDryRun("texttorrent")) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        provider: "texttorrent",
        would_send: {
          campaign_name: campaignName,
          list_id: listId,
          numbers,
          anti_block: { number_pool: args.number_pool, round_robin: args.round_robin_campaign, batch: args.batch_process, opt_out_link: args.opt_out_link },
          scheduled: scheduledDate ? `${scheduledDate} ${scheduledTime || ""}`.trim() : "now",
        },
      });
    }

    const r = await createBulkCampaign(creds, args);
    return NextResponse.json({
      ok: true,
      dry_run: false,
      provider: "texttorrent",
      campaign_id: r.data?.campaign_id,
      total_contacts: r.data?.total_contacts,
      total_segments: r.data?.total_segments,
      total_credit: r.data?.total_credit,
    });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status: ttStatus(err) });
    }
    return NextResponse.json(
      { ok: false, error: "campaign_send_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
