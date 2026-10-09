/**
 * lib/forms/first-submission.ts - is this submission the FIRST one this lead
 * made on this form? The one rule every "new lead" alert uses.
 *
 * WHY ONE FUNCTION. The AI-audit step-0 alert (lib/forms/ai-audit-notify.ts)
 * and the offer-page lead alert (lib/offer-pages/notify.ts) both fire only for
 * a lead's first visit to a form. Each carrying its own copy of the query is
 * how two alerts end up disagreeing about what a new lead is. Extracted from
 * notifyAiAuditStarted unchanged (offer pages, 2026-10-08).
 *
 * WHY "IS THE OLDEST ROW MINE", NOT "IS THERE ONLY ONE ROW". A returning
 * visitor is smart-matched onto their existing lead, so the count is the only
 * thing that tells a new inbound from a repeat, but counting races: two
 * near-simultaneous submits (a double-click, back-then-resubmit) both land
 * their rows before either callback reads, both see a count of 2, and NEITHER
 * alerts, in exactly the case where the lead was most eager. Asking whether the
 * oldest row is this one always has exactly one winner, whatever order the
 * callbacks run in. id breaks a tie between two rows with the same timestamp.
 *
 * FAILS CLOSED. An unreadable result answers false: a missed alert is
 * recoverable (the lead is still in the pipeline); an alert on every refresh
 * trains the operator to ignore the channel.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function isFirstSubmissionForLead(input: {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  leadId: string;
  submissionId: string;
}): Promise<boolean> {
  const { db, tenantId, formId, leadId, submissionId } = input;
  try {
    // (tenant_id, lead_id, submitted_at) is indexed - see migration 042.
    const { data, error } = await db
      .from("form_submissions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("form_id", formId)
      .eq("lead_id", leadId)
      .order("submitted_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    if (error || !data?.length) return false;
    return (data[0] as { id: string }).id === submissionId;
  } catch {
    return false;
  }
}
