/**
 * /uw-sheet — Ezra's approval queue for the "Breeze UW Entry Sheet" automation.
 *
 * Solara's scrubber (SunBiz-Agent/scripts/mca_lead_scrubber.py) pulls MCA lead
 * sheets off the shared Breeze/SunBiz Google Drive, scores each deal, and writes
 * the qualified ones to scrub_candidates as `pending_review`. THIS page is the
 * human gate: Ezra reviews each deal packet and Approves (→ creates the lead at
 * the uw_sheet stage, firing the follow-up lifecycle) or Declines.
 *
 * Mirrors /sequences: server component resolves tenant + loads rows, renders a
 * client list with the approve/decline actions.
 */

import { PageHeader } from "@/components/Card";
import { getActiveProfile } from "@/lib/queries";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { safe, isMissingTableError } from "@/lib/api-helpers";
import { UwSheetQueueClient, type ScrubCandidate } from "@/components/uw-sheet/UwSheetQueueClient";
import { AlertCircle, ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

async function loadCandidates(tenantId: string | null): Promise<
  | { ok: true; rows: ScrubCandidate[] }
  | { ok: false; reason: "no_tenant" | "migration_not_applied" | "db_error"; detail?: string }
> {
  if (!tenantId) return { ok: false, reason: "no_tenant" };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("scrub_candidates")
    .select(
      "id, tier, score, reasons, decline_reason, previously_submitted, leverage_pct, monthly_revenue, lead_data, source_file, scrubbed_at, created_at",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "pending_review")
    .order("score", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error, "public.scrub_candidates")) {
      return { ok: false, reason: "migration_not_applied" };
    }
    return { ok: false, reason: "db_error", detail: error.message };
  }
  return { ok: true, rows: (data as ScrubCandidate[]) || [] };
}

export default async function UwSheetQueuePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await safe("uw_sheet.profile", getActiveProfile(), null);
  const result = await loadCandidates(profile?.tenant_id || null);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="UW Sheet — pending approval"
        subtitle="Deals Solara scrubbed off the Breeze/SunBiz lead sheets. Approve to inject the lead into the pipeline (kicks off follow-up); decline to discard. You have the final write-off."
      />

      <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
        <ClipboardCheck className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
        <div className="flex-1 text-xs leading-relaxed text-fg-muted">
          Each card is one scrubbed merchant with its score and the reasoning behind it.
          <span className="text-fg font-medium"> Approve</span> creates the lead at the{" "}
          <span className="text-fg font-medium">UW Sheet</span> stage and starts the autonomous
          follow-up cadence. <span className="text-fg font-medium">Decline</span> discards it (no
          lead created). Bank statements are uploaded manually after approval.
        </div>
      </div>

      {!result.ok && result.reason === "no_tenant" && (
        <div className="rounded-xl border border-status-warm/40 bg-status-warm/5 p-4 text-sm text-status-warm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>No tenant resolved for this user. Complete onboarding first.</span>
        </div>
      )}

      {!result.ok && result.reason === "migration_not_applied" && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 space-y-2">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-bold text-fg">One-time setup required</div>
              <p className="text-xs text-fg-muted mt-1 leading-relaxed">
                The Breeze UW Entry Sheet queue needs migration 081 applied to the
                Supabase project. Run the command below, then refresh.
              </p>
            </div>
          </div>
          <div className="rounded-md bg-bg-deep border border-bg-border p-2.5 font-mono text-[11px] text-fg-muted select-all">
            python scripts/apply_migration.py database/081_scrub_candidates.sql
          </div>
        </div>
      )}

      {!result.ok && result.reason === "db_error" && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          <div className="font-bold">Couldn&apos;t load the queue.</div>
          <div className="text-xs mt-1 font-mono">{result.detail}</div>
        </div>
      )}

      {result.ok && <UwSheetQueueClient initialRows={result.rows} />}
    </div>
  );
}
