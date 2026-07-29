/**
 * agent-alert.ts — write an operator-visible alert from oasis server code.
 *
 * Two surfaces in one call:
 *  1. A durable `agent_alerts` row — rendered in the dashboard System Health
 *     panel and resolvable via POST /api/agent-alerts/[id]/resolve. This is the
 *     record the operator sees and dismisses.
 *  2. For warn/urgent, a Telegram push (via lib/notify/telegram) so a live
 *     failure pages someone instead of waiting to be noticed.
 *
 * The `agent_alerts` schema is owned by the VPS SunBiz-Agent repo (migration
 * 069/health-check convention): columns tenant_id, alert_type, severity
 * ('info'|'warn'|'urgent'), subject_type, subject_id, title, body, payload,
 * created_at, resolved_at. There is no TS insert wrapper elsewhere — this is it.
 *
 * De-duplicated the same way the VPS health-check does: if an UNRESOLVED row for
 * the same (tenant, alert_type, subject) already exists we refresh it instead of
 * inserting a duplicate, so a repeatedly-failing signal (e.g. a bad HMAC secret
 * firing every minute) is ONE open card, not a storm.
 *
 * Best-effort by contract: never throws. A monitoring write must not fail the
 * operation it is monitoring.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";
import { isSameNews, shouldPageTelegram } from "@/lib/notify/alert-page-policy";

export type { AlertSeverity } from "@/lib/notify/alert-page-policy";
import type { AlertSeverity } from "@/lib/notify/alert-page-policy";

export async function writeAgentAlert(input: {
  tenantId: string;
  alertType: string;
  severity: AlertSeverity;
  title: string;
  body?: string;
  subjectType?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
  /** Override Telegram push (default: on for warn/urgent, off for info). */
  telegram?: boolean;
  /** Page Telegram only when this call CREATES the open card — a refresh of an
   *  already-open card stays silent. For high-frequency callers (e.g. every
   *  claimed drip row during a TT credit outage) where re-paging per call is a
   *  notification storm (codex review 2026-07-23). Default false = legacy
   *  behavior (page on every call).
   *
   *  Escalation still pages: suppression applies ONLY when the refreshed card is
   *  materially the SAME signal — same severity, and same `notifySignature` when
   *  the caller supplies one. A warn that becomes urgent, or a different set of
   *  failing fields, breaks through (codex review 2026-07-29). Silence must mean
   *  "you already know", never "it got worse while you weren't looking". */
  telegramOncePerOpen?: boolean;
  /** Optional content fingerprint for `telegramOncePerOpen`. Two calls with the
   *  same signature are the same news; a changed signature re-pages even though
   *  the card was already open. Stored on the row (payload.__notify_sig) so the
   *  comparison survives across processes. Omit to compare severity only. */
  notifySignature?: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  let refreshedExisting = false;
  /** True only when the card we refreshed carried the SAME news (severity +
   *  signature). Anything else must still page. Starts false = loud. */
  let refreshedUnchanged = false;
  try {
    const db = getServiceSupabase();

    // De-dup against an existing OPEN row for the same signal + subject. Pull
    // severity + payload too: the once-per-open suppression needs to know
    // whether this call is the same news or an escalation.
    let q = db
      .from("agent_alerts")
      .select("id, severity, payload")
      .eq("tenant_id", input.tenantId)
      .eq("alert_type", input.alertType)
      .is("resolved_at", null)
      .limit(1);
    q = input.subjectId ? q.eq("subject_id", input.subjectId) : q.is("subject_id", null);
    const existing = await q.maybeSingle();
    const existingRow = existing.data as {
      id: string;
      severity: string | null;
      payload: Record<string, unknown> | null;
    } | null;
    const existingId = existingRow?.id;

    const payload =
      input.notifySignature === undefined
        ? (input.payload ?? null)
        : { ...(input.payload ?? {}), __notify_sig: input.notifySignature };

    const row: Record<string, unknown> = {
      tenant_id: input.tenantId,
      alert_type: input.alertType,
      severity: input.severity,
      title: input.title,
      body: input.body ?? null,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      payload,
    };

    const sameNews = isSameNews({
      existingSeverity: existingRow?.severity,
      existingSignature: existingRow?.payload?.__notify_sig,
      nextSeverity: input.severity,
      nextSignature: input.notifySignature,
    });

    if (existingId) {
      // Refresh the open card (bump created_at so it re-sorts to the top).
      // Flag only on a VERIFIED refresh — a failed update errs toward loud
      // (codex review 2026-07-23).
      const upd = await db
        .from("agent_alerts")
        .update({ ...row, created_at: nowIso })
        .eq("id", existingId);
      if (!upd.error) {
        refreshedExisting = true;
        refreshedUnchanged = sameNews;
      }
    } else {
      await db.from("agent_alerts").insert({ ...row, created_at: nowIso });
    }
  } catch (err) {
    // Write failed → we can't know if a card was open; err toward LOUD
    // (refreshedExisting stays false so Telegram still fires).
    console.error("[agent-alert] write failed:", err instanceof Error ? err.message : err);
  }

  const wantTelegram = shouldPageTelegram({
    severity: input.severity,
    telegram: input.telegram,
    telegramOncePerOpen: input.telegramOncePerOpen,
    refreshedExisting,
    refreshedUnchanged,
  });
  if (wantTelegram) {
    const tag = input.severity === "urgent" ? "🚨" : "⚠️";
    const text = `${tag} ${input.title}${input.body ? `\n${input.body}` : ""}`;
    await sendTelegram(text).catch(() => {});
  }
}
