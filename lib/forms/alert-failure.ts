/**
 * alert-failure.ts — leave a trace when a lead alert cannot be delivered.
 *
 * Both funnels used to report a failed Telegram send with `console.error`
 * and nothing else. That goes to a Vercel log nobody reads, so the lived
 * experience is a lead arriving with no notification and no trace of why —
 * which is exactly what CC hit on 2026-08-01, and why the cause of that
 * particular failure is now unrecoverable.
 *
 * A notification channel is the one place a silent failure is least
 * affordable: the failure removes the very signal that would have told you
 * about it. So the failure gets written where it will be seen anyway — the
 * lead's own timeline, next to the lead it concerns.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AlertFailureInput = {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  /**
   * `agent_source` for the marker row.
   *
   * MUST NOT collide with the source a funnel's idempotency check looks
   * for. ingestAiAuditSubmission treats the presence of ANY row tagged
   * `ai_audit_funnel` as proof the submission was already processed, so
   * filing a failure marker under that source would make every retry
   * return already_ingested and permanently suppress both the ingest and
   * the alert for that lead. A record that a notification broke must never
   * be able to silence the notification.
   */
  source: string;
  /** Funnel name for the human-readable note, e.g. "AI audit". */
  label: string;
  reason: string;
  /** Anything else worth knowing, e.g. whether the welcome email went. */
  extra?: string;
  /** Log prefix, so the console line names its own caller. */
  tag: string;
};

export async function recordAlertFailure({
  db,
  tenantId,
  leadId,
  source,
  label,
  reason,
  extra,
  tag,
}: AlertFailureInput): Promise<void> {
  const note =
    `The ${label} alert could not be delivered to Telegram: ${reason}.` +
    ` The lead is real and is in the pipeline.${extra ? ` ${extra}` : ""}`;

  try {
    const rec = await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: leadId,
      type: "alert_failed",
      channel: "system",
      direction: "outbound",
      agent_source: source,
      subject: "Telegram alert FAILED",
      content: note,
      content_preview: note.slice(0, 200),
      metadata: { reason },
    });
    // The marker itself failing is the last line of defence, so it does not
    // get to fail quietly either.
    if (rec.error) {
      console.error(`[${tag}] failure marker rejected:`, rec.error.message);
    }
  } catch (err) {
    console.error(`[${tag}] could not record alert failure:`, err);
  }
}
