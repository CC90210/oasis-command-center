/**
 * /sequences — operator-facing list of tenant drip sequences (Phase 4.4).
 *
 * The bridge-side sequence-runner daemon executes; this page is the
 * operator UX for the drip definitions it consumes.
 */

import { PageHeader } from "@/components/Card";
import { getActiveProfile, getBridgeOnline } from "@/lib/queries";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { safe, isMissingTableError } from "@/lib/api-helpers";
import { SequencesTabs } from "@/components/sequences/SequencesTabs";
import { AlertCircle, Cpu, Cloud, Download } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

import type { DripStep } from "@/lib/drips/types";

type SequenceRow = {
  id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  trigger_filter: Record<string, unknown>;
  steps: DripStep[];
  enabled: boolean;
  one_per_lead: boolean;
  email_class?: string;
};

async function loadSequences(tenantId: string | null): Promise<
  | { ok: true; rows: SequenceRow[] }
  | { ok: false; reason: "no_tenant" | "migration_not_applied" | "db_error"; detail?: string }
> {
  if (!tenantId) return { ok: false, reason: "no_tenant" };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .select(
      "id, name, description, trigger_event, trigger_filter, steps, enabled, one_per_lead, email_class",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTableError(error, "public.drip_sequences")) {
      return { ok: false, reason: "migration_not_applied" };
    }
    return { ok: false, reason: "db_error", detail: error.message };
  }
  return { ok: true, rows: (data as SequenceRow[]) || [] };
}

export default async function SequencesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await safe("sequences.profile", getActiveProfile(), null);
  const [result, bridgeOnline] = await Promise.all([
    loadSequences(profile?.tenant_id || null),
    safe(
      "sequences.bridge_online",
      getBridgeOnline(profile?.tenant_id || null),
      false,
    ),
  ]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Drip sequences"
        subtitle="Automated SMS + email follow-up triggered by status changes (viewed application, submitted, declined, etc.). Runs on your machine via the local sequence-runner daemon."
      />

      {/* Bridge-online banner — drip sequences are run by the
          sequence-runner daemon on the operator's machine, exactly like
          cron jobs are run by cron_engine. Without the bridge, saved
          sequences never fire. Mirrors the banner on /automations so
          operators get a consistent "is my machine connected" signal
          across both surfaces. Self-review consistency 2026-05-24. */}
      <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
        {bridgeOnline ? (
          <Cpu className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
        ) : (
          <Cloud className="w-5 h-5 text-fg-dim shrink-0 mt-0.5" />
        )}
        <div className="flex-1 text-xs leading-relaxed">
          {bridgeOnline ? (
            <>
              <span className="text-status-engaged font-bold">Your computer is connected.</span>{" "}
              Sequences fire automatically when a lead or application hits the trigger
              stage. Edits take effect within a minute. Toggle one off to pause without
              losing the spec.
            </>
          ) : (
            <>
              <span className="text-fg-muted font-bold">Computer not connected yet.</span>{" "}
              Sequences you create here are saved, but the sequence-runner daemon needs a
              paired machine to actually send the SMS / email steps. Pair a device and
              they&apos;ll start firing within a minute.
            </>
          )}
        </div>
        {!bridgeOnline && (
          <Link
            href="/settings/devices/install"
            className="btn-primary inline-flex items-center gap-1.5 text-xs shrink-0"
          >
            <Download className="w-3 h-3" />
            Install bridge
          </Link>
        )}
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
                The Drip Sequences feature needs migration 043 applied to your
                Supabase project. Run the command below on the operator machine.
                After it completes, refresh the page.
              </p>
            </div>
          </div>
          <div className="rounded-md bg-bg-deep border border-bg-border p-2.5 font-mono text-[11px] text-fg-muted select-all">
            python scripts/apply_migration.py database/043_drip_sequences.sql
          </div>
        </div>
      )}

      {!result.ok && result.reason === "db_error" && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
          <div className="font-bold">Couldn&apos;t load sequences.</div>
          <div className="text-xs mt-1 font-mono">{result.detail}</div>
        </div>
      )}

      {result.ok && <SequencesTabs rows={result.rows} />}
    </div>
  );
}
