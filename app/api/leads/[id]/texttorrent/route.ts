/**
 * POST /api/leads/[id]/texttorrent — send a direct 1:1 Text Torrent SMS to a lead.
 *
 * Unlike the sequence-enroll picker (which drips a cadence), this sends ONE
 * message now via TT's /inbox/chat path (lib/integrations/texttorrent.sendSms) —
 * the live-verified per-lead send the Jordan agent uses. Resolves the operator's
 * own TT sender number when set, else the tenant default. Dry-run unless the
 * texttorrent channel is flipped live (lib/integrations/send-mode).
 *
 * Auth: session-cookie → tenant. Body: { to_number: string, message: string }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isDryRun } from "@/lib/integrations/send-mode";
import { checkPhoneOptOut } from "@/lib/lead-interactions-queries";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { getTextTorrentCredentials, sendSms, TextTorrentError } from "@/lib/integrations/texttorrent";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MSG = 1600;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  let body: { to_number?: unknown; message?: unknown; account?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const toNumber = typeof body.to_number === "string" ? body.to_number.trim() : "";
  const message = (typeof body.message === "string" ? body.message : "").trim().slice(0, MAX_MSG);
  if (!toNumber) return NextResponse.json({ ok: false, error: "to_number_required" }, { status: 400 });
  if (!message) return NextResponse.json({ ok: false, error: "message_required" }, { status: 400 });

  // Which TextTorrent account sends this: the main SunBiz line, or the dedicated
  // follow-up account (its own SID/number + its own LIVE_SEND flag + rate budget).
  const account = body.account === "followup" ? "followup" : "main";
  const service = account === "followup" ? "texttorrent_followup" : "texttorrent";
  const channel = service; // send-mode channel + LIVE_SEND_* key

  // Opt-out gate. This direct-send path bypasses send_gateway's suppression, so
  // re-check here and FAIL CLOSED — a lead who replied STOP must never get texted,
  // and a failed lookup blocks rather than sends. [[fail-closed-default]] / CASL.
  const optOut = await checkPhoneOptOut(sess.tenantId, toNumber);
  if (optOut.optedOut) {
    return NextResponse.json(
      { ok: false, error: "opted_out", message: "Recipient previously opted out (STOP) — send blocked." },
      { status: 409 },
    );
  }
  if (optOut.checkFailed) {
    return NextResponse.json(
      { ok: false, error: "suppression_check_failed", message: "Could not verify opt-out status — send blocked (fail-closed)." },
      { status: 503 },
    );
  }

  // Sender number: the operator's own TT number when set (main account only), else the
  // selected account's tenant default.
  const senderId = await resolveTextTorrentSenderId({ tenantId: sess.tenantId, userId: sess.userId, service });
  if (!senderId) {
    return NextResponse.json(
      { ok: false, error: "no_sender_number", message: "No Text Torrent sender number — set one in Settings → Integrations (or your own in Personal)." },
      { status: 400 },
    );
  }

  if (isDryRun(channel)) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      provider: "texttorrent",
      account,
      would_send: { to_number: toNumber, from: senderId, chars: message.length, account },
    });
  }

  try {
    // Selected account's tenant-default act-as sub-account; the per-rep identity is
    // the sender NUMBER resolved above, not the act-as email.
    const creds = await getTextTorrentCredentials(sess.tenantId, { service });
    const res = await sendSms(creds, { number: toNumber, message, sender_id: senderId });

    const trackingWarnings: string[] = [];
    let db: ReturnType<typeof getServiceSupabase>;
    try {
      db = getServiceSupabase();
    } catch (err) {
      console.error("[leads.texttorrent] tracking database unavailable after send", err);
      return NextResponse.json({
        ok: true,
        dry_run: false,
        provider: "texttorrent",
        chat_id: res.data?.chat_id ?? null,
        stage_bumped: null,
        tracking_warning: "tracking_database_unavailable",
      });
    }
    let touchAt = new Date().toISOString();
    try {
      const interaction = await db.from("lead_interactions").insert({
        tenant_id: sess.tenantId,
        lead_id: leadId,
        type: "sms_sent",
        channel: "sms_texttorrent",
        direction: "outbound",
        agent_source: "dashboard_drawer",
        provider: "texttorrent",
        provider_message_id: res.data?.message_id ?? null,
        actor_user_id: sess.userId,
        content: message,
        content_preview: message.slice(0, 1024),
        metadata: {
          requested_by_email: sess.email,
          acted_by_user_id: sess.userId,
          to_number: toNumber,
          from_number: senderId,
          chat_id: res.data?.chat_id ?? null,
          tt_message_id: res.data?.message_id ?? null,
          tt_account: account,
          status: "sent",
        },
      }).select("created_at").single();
      if (interaction.error) {
        trackingWarnings.push("interaction_log_failed");
        console.error("[leads.texttorrent] interaction insert failed", interaction.error);
      } else {
        const storedAt = (interaction.data as { created_at?: string | null } | null)?.created_at;
        if (typeof storedAt === "string" && Number.isFinite(Date.parse(storedAt))) {
          touchAt = new Date(storedAt).toISOString();
        }
      }
    } catch (err) {
      trackingWarnings.push("interaction_log_failed");
      console.error("[leads.texttorrent] interaction insert threw", err);
    }

    try {
      await persistCanonicalLeadTouch(db, {
        tenantId: sess.tenantId,
        leadId,
        occurredAt: touchAt,
      });
    } catch (err) {
      trackingWarnings.push("canonical_touch_failed");
      console.error("[leads.texttorrent] canonical touch update failed", err);
    }

    let stageBumped: string | null = null;
    try {
      const stageEvent = await dispatchLeadStageEvent({
        type: "outbound_email_queued", // reuse the outbound-touch stage motion
        tenantId: sess.tenantId,
        leadId,
      });
      stageBumped = stageEvent.fired ? stageEvent.to : null;
    } catch (err) {
      trackingWarnings.push("stage_dispatch_failed");
      console.error("[leads.texttorrent] stage dispatch failed", err);
    }

    return NextResponse.json({
      ok: true,
      dry_run: false,
      provider: "texttorrent",
      chat_id: res.data?.chat_id ?? null,
      stage_bumped: stageBumped,
      tracking_warning: trackingWarnings.length ? trackingWarnings.join(",") : null,
    });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      const status = err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
      return NextResponse.json({ ok: false, error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { ok: false, error: "texttorrent_send_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
