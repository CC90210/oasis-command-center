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
 * network call entirely, still log a lead_interactions row tagged
 * metadata.dry_run=true so the inbox + drawer timeline reflect the attempt,
 * and return { ok, dry_run:true, would_send }. The dashboard defaults to
 * dry-run (see lib/integrations/send-mode.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getUserIntegrationValue } from "@/lib/user-integration-store";
import { normalizePhoneE164, isPhoneOptedOut } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import { getKixieCredentials, sendSms as kixieSendSms, KixieError } from "@/lib/integrations/kixie";
import {
  getTextTorrentCredentials,
  sendSms as ttSendSms,
  TextTorrentError,
} from "@/lib/integrations/texttorrent";

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
}) {
  try {
    const db = getServiceSupabase();
    await db.from("lead_interactions").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      type: "sms_sent",
      channel: "sms",
      direction: "outbound",
      agent_source: "dashboard_conversations",
      to_phone: args.toPhone,
      content_preview: args.message.slice(0, 1024),
      actor_user_id: args.userId,
      metadata: { provider: args.provider, dry_run: args.dryRun },
    });
  } catch (err) {
    console.error("[conversations.reply] interaction insert failed", err);
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
  const { tenantId, userId, email } = session;

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
  const provider = body.provider === "kixie" ? "kixie" : "texttorrent";
  const leadId =
    typeof body.lead_id === "string" && UUID_RE.test(body.lead_id) ? body.lead_id : null;
  const toPhone = normalizePhoneE164(typeof body.to_phone === "string" ? body.to_phone : "");
  if (!toPhone) {
    return NextResponse.json(
      { ok: false, error: "no_phone", message: "Recipient phone missing or unrecognized." },
      { status: 400 },
    );
  }

  // DRY-RUN: short-circuit before any network call. Still log the attempt.
  if (isDryRun()) {
    await logInteraction({ tenantId, leadId, toPhone, message, userId, provider, dryRun: true });
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

  try {
    if (provider === "kixie") {
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
      await kixieSendSms(creds, {
        target: toPhone,
        message,
        agentEmail,
        leadId: leadId ?? undefined,
      });
    } else {
      const creds = await getTextTorrentCredentials(tenantId);
      await ttSendSms(creds, { number: toPhone, message });
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

  await logInteraction({ tenantId, leadId, toPhone, message, userId, provider, dryRun: false });
  return NextResponse.json({ ok: true, dry_run: false, provider, to_phone: toPhone });
}
