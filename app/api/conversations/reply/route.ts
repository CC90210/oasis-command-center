/**
 * POST /api/conversations/reply — send an SMS reply from the unified inbox.
 *
 * Phase 3b of the TT + Kixie full embedding plan (2026-06-02).
 *
 * Body: { lead_id?: string, to_phone: string, message: string,
 *         provider?: "texttorrent" | "kixie" }
 *
 * Provider:
 *   - "texttorrent" (default) → TT 1:1 inbox send (lib/integrations/texttorrent.sendSms)
 *   - "kixie"                  → Kixie SMS attributed to the acting employee,
 *                                resolved via the same 3-tier agent-email
 *                                ladder the drawer Call button uses.
 *
 * Safety: every send goes through isDryRun() FIRST. On dry-run we skip the
 * network call and all touch tracking so simulations cannot inflate metrics,
 * then return { ok, dry_run:true, would_send }. The dashboard defaults to
 * dry-run (see lib/integrations/send-mode.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { getUserIntegrationValue } from "@/lib/user-integration-store";
import { normalizePhoneE164, isPhoneOptedOut } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import { getKixieCredentials, sendSms as kixieSendSms, KixieError } from "@/lib/integrations/kixie";
import {
  getTextTorrentCredentials,
  sendSms as ttSendSms,
  TextTorrentError,
} from "@/lib/integrations/texttorrent";
import { resolveTextTorrentSenderId } from "@/lib/integrations/texttorrent-sender";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import { sendSmsDirectTwilio } from "@/lib/sms-direct-twilio";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort interaction log so the reply shows in the inbox + the lead
 * drawer timeline. Mirrors the shape the call route + TT inbound webhook
 * write. Never throws — a logging failure must not fail an actual send.
 */
async function logInteraction(args: {
  tenantId: string;
  leadId: string | null;
  toPhone: string;
  message: string;
  userId: string;
  provider: string;
  dryRun: boolean;
  providerMessageId?: string | null;
}): Promise<string | null> {
  if (args.dryRun) return null;
  const warnings: string[] = [];
  let occurredAt = new Date().toISOString();
  try {
    const db = getServiceSupabase();
    const row = {
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      type: "sms_sent",
      channel: "sms",
      direction: "outbound",
      agent_source: "dashboard_conversations",
      provider: args.provider,
      provider_message_id: args.providerMessageId || null,
      to_phone: args.toPhone,
      content: args.message,
      content_preview: args.message.slice(0, 1024),
      actor_user_id: args.userId,
      metadata: { provider: args.provider, dry_run: false },
    };
    const interaction = args.providerMessageId
      ? await db.from("lead_interactions").upsert(row, {
          onConflict: "provider,provider_message_id",
        }).select("created_at").single()
      : await db.from("lead_interactions").insert(row).select("created_at").single();
    if (interaction.error) {
      warnings.push("interaction_log_failed");
      console.error("[conversations.reply] interaction insert failed", interaction.error);
    } else {
      const createdAt = (interaction.data as { created_at?: string | null } | null)?.created_at;
      if (typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt))) {
        occurredAt = new Date(createdAt).toISOString();
      }
    }

    if (args.leadId) {
      try {
        await persistCanonicalLeadTouch(db, {
          tenantId: args.tenantId,
          leadId: args.leadId,
          occurredAt,
        });
      } catch (err) {
        warnings.push("canonical_touch_failed");
        console.error("[conversations.reply] canonical touch update failed", err);
      }
    }
  } catch (err) {
    warnings.push("tracking_database_failed");
    console.error("[conversations.reply] interaction insert failed", err);
  }
  return warnings.length ? warnings.join(",") : null;
}

function providerMessageIdFrom(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["messageid", "message_id"]) {
    const candidate = row[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return providerMessageIdFrom(row.data);
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json(
      { ok: false, error: session.reason },
      { status: session.reason === "no_session" ? 401 : 400 },
    );
  }
  const { tenantId, userId, email } = session;

  // Role gate (2026-06-18): sending SMS is a member+ capability — read_only
  // members are denied, matching lib/role-gates (send_sms ∈ READ_ONLY_DENIED)
  // and the bridge/exec-tool wall. The chat + bridge paths already enforce
  // this; this is the direct HTTP send path, so it needs the same gate. Fail
  // CLOSED if the role can't be resolved (a passing resolveSessionContext means
  // a profile+tenant exist, so a null here is an anomaly, not a normal member).
  let body: {
    lead_id?: unknown;
    to_phone?: unknown;
    message?: unknown;
    provider?: unknown;
  };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ ok: false, error: "message_required" }, { status: 400 });
  }
  if (message.length > 1600) {
    return NextResponse.json({ ok: false, error: "message_too_long" }, { status: 400 });
  }
  const provider =
    body.provider === "kixie" ? "kixie" :
    body.provider === "twilio" ? "twilio" :
    "texttorrent";
  const leadId =
    typeof body.lead_id === "string" && UUID_RE.test(body.lead_id) ? body.lead_id : null;
  const toPhone = normalizePhoneE164(typeof body.to_phone === "string" ? body.to_phone : "");
  if (!toPhone) {
    return NextResponse.json(
      { ok: false, error: "no_phone", message: "Recipient phone missing or unrecognized." },
      { status: 400 },
    );
  }

  // Tenant lead-ownership guard (hardening 2026-06-18, mirrors the Call route
  // at app/api/leads/[id]/call/route.ts): when a lead_id is supplied, confirm
  // it belongs to the caller's tenant before we attach an interaction row to
  // it. The credentials are already tenant-scoped so a forged lead_id can
  // never send AS another tenant, but without this check it could mis-attribute
  // a timeline row to a foreign record. 404 on mismatch, same as Call.
  if (leadId) {
    const access = await assertMayWorkLead({
      teamRole: session.teamRole,
      userId,
      tenantId,
      leadId,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
      accessMode: "owned_oasis_sales",
    });
    if (!access.ok) {
      return NextResponse.json(
        { ok: false, error: access.error, message: access.message },
        { status: access.status },
      );
    }
  } else if (!session.isAdmin) {
    return NextResponse.json(
      {
        ok: false,
        error: "lead_required",
        message: "Select an assigned lead before sending a reply.",
      },
      { status: 403 },
    );
  }

  // DRY-RUN: short-circuit before network and tracking writes.
  // Per-channel: TextTorrent / Kixie can be live independently.
  if (isDryRun(provider)) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      provider,
      would_send: { to_phone: toPhone, message, lead_id: leadId },
    });
  }

  // Compliance guard (Codex P1, 2026-06-02): refuse a live send to a contact
  // who replied STOP. Partial vs the bridge's CSV DNC list — see
  // isPhoneOptedOut's note — but catches the common dashboard-visible case.
  if (await isPhoneOptedOut(tenantId, toPhone)) {
    return NextResponse.json(
      { ok: false, error: "opted_out", message: "Recipient previously opted out (replied STOP) — send blocked." },
      { status: 409 },
    );
  }

  let providerMessageId: string | null = null;
  try {
    if (provider === "twilio") {
      const result = await sendSmsDirectTwilio({ tenantId, to: toPhone, body: message });
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, error: result.error, message: result.error },
          { status: result.http_status },
        );
      }
      providerMessageId = result.message_sid;
    } else if (provider === "kixie") {
      // 3-tier agent email: per-user override → session email → tenant default.
      let agentEmail = email || "";
      try {
        const override = await getUserIntegrationValue(tenantId, userId, "kixie", "kixie_agent_email");
        if (override) agentEmail = override;
      } catch {
        // soft-fail; session email still valid
      }
      const creds = await getKixieCredentials(tenantId);
      if (!agentEmail) agentEmail = creds.defaultAgentEmail || "";
      if (!agentEmail) {
        return NextResponse.json(
          {
            ok: false,
            error: "no_agent_email",
            message:
              "Couldn't resolve a Kixie agent email — set yours in Settings → Personal integrations.",
          },
          { status: 400 },
        );
      }
      // Per-rep "text from my own number": if the employee has set a personal
      // Kixie from-number (their own DID) in Settings → Personal integrations,
      // send from it; otherwise kixie.sendSms falls back to the tenant default
      // (creds.defaultFromNumber). Attribution-by-agent-email already happens
      // above; this makes the literal sending DID per-rep when configured.
      let fromOverride: string | undefined;
      try {
        const f = await getUserIntegrationValue(tenantId, userId, "kixie", "kixie_from_number");
        if (f) fromOverride = f;
      } catch {
        // soft-fail; tenant default from-number applies
      }
      const result = await kixieSendSms(creds, {
        target: toPhone,
        message,
        agentEmail,
        from: fromOverride,
        leadId: leadId ?? undefined,
      });
      providerMessageId = providerMessageIdFrom(result);
    } else {
      const creds = await getTextTorrentCredentials(tenantId);
      // Per-rep "text from my own number" (2026-06-24): send from the rep's own
      // TextTorrent number when set; otherwise the tenant default ("Default
      // Business Number") applies. Mirrors the Kixie from-number ladder above.
      // Attribution stays the human rep — logInteraction already stamps
      // actor_user_id + agent_source:"dashboard_conversations".
      const senderId = await resolveTextTorrentSenderId({ tenantId, userId });
      const result = await ttSendSms(creds, { number: toPhone, message, sender_id: senderId });
      providerMessageId = result.data.message_id || null;
    }
  } catch (err) {
    if (err instanceof TextTorrentError || err instanceof KixieError) {
      const status = err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message },
        { status },
      );
    }
    return NextResponse.json(
      { ok: false, error: "send_failed", message: err instanceof Error ? err.message : "send failed" },
      { status: 502 },
    );
  }

  const trackingWarning = await logInteraction({
    tenantId,
    leadId,
    toPhone,
    message,
    userId,
    provider,
    dryRun: false,
    providerMessageId,
  });
  await nudgeConversations(tenantId);
  return NextResponse.json({
    ok: true,
    dry_run: false,
    provider,
    to_phone: toPhone,
    tracking_warning: trackingWarning,
  });
}
