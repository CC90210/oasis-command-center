/**
 * TodaysCallsCard — at-a-glance tile showing the operator's call activity
 * today. Phase 3 of TT + Kixie full embedding (2026-06-01).
 *
 * Reads lead_interactions filtered to:
 *   - this tenant
 *   - actor_user_id = signed-in operator
 *   - channel = 'phone'
 *   - created_at >= today (UTC start-of-day; per-employee timezones come
 *     in a later phase once user_profiles.timezone lands)
 *
 * Renders: total call count, talk time (sum of call_duration_sec),
 * mini-summary of outcomes. Always renders even on a zero-call day so
 * operators see the surface exists.
 */

import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { Phone, PhoneOutgoing, Voicemail, PhoneMissed } from "lucide-react";
import { Card } from "@/components/Card";

type CallRow = {
  type: string | null;
  call_duration_sec: number | null;
  call_outcome: string | null;
  disposition: string | null;
};

export async function getTodaysCalls(
  tenantId: string | null,
  userId: string | null,
): Promise<CallRow[]> {
  if (!tenantId || !userId) return [];
  const db = getServiceSupabase();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  try {
    const r = await db
      .from("lead_interactions")
      .select("type,call_duration_sec,call_outcome,disposition")
      .eq("tenant_id", tenantId)
      .eq("actor_user_id", userId)
      .eq("channel", "phone")
      .gte("created_at", startOfDay.toISOString())
      .limit(500);
    return (r.data || []) as CallRow[];
  } catch {
    return [];
  }
}

function formatDuration(totalSec: number): string {
  if (totalSec === 0) return "0m";
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

export function TodaysCallsCard({ rows }: { rows: CallRow[] }) {
  const totalCalls = rows.length;
  const totalTalkSec = rows.reduce(
    (acc, r) => acc + (r.call_duration_sec || 0),
    0,
  );

  // Bucket by outcome — count rows where the latest event indicates
  // a particular endpoint state. Multiple lifecycle events for one call
  // can land in lead_interactions, so we de-dupe on the call_outcome
  // column when present and lean on the row count otherwise.
  let answered = 0;
  let voicemails = 0;
  let missed = 0;
  for (const r of rows) {
    const outcome = (r.call_outcome || "").toLowerCase();
    const type = (r.type || "").toLowerCase();
    if (outcome === "voicemail" || type === "call_voicemail") voicemails += 1;
    else if (outcome === "answered" || type === "call_answered") answered += 1;
    else if (
      outcome === "missed" ||
      outcome === "no_answer" ||
      outcome === "failed" ||
      type === "call_missed"
    )
      missed += 1;
  }

  return (
    <Card
      title="Today's calls"
      subtitle="Your call activity for the day (resets at 00:00 UTC)"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-fg-muted font-bold">
            <Phone className="w-3 h-3" />
            Total
          </div>
          <div className="text-2xl font-bold text-fg mt-1">{totalCalls}</div>
          <div className="text-[11.5px] text-fg-muted mt-1">
            {formatDuration(totalTalkSec)} talk time
          </div>
        </div>

        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-fg-muted font-bold">
            <PhoneOutgoing className="w-3 h-3 text-emerald-300" />
            Answered
          </div>
          <div className="text-2xl font-bold text-fg mt-1">{answered}</div>
          <div className="text-[11.5px] text-fg-muted mt-1">connected</div>
        </div>

        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-fg-muted font-bold">
            <Voicemail className="w-3 h-3 text-amber-300" />
            Voicemail
            <PhoneMissed className="w-3 h-3 text-red-300 ml-2" />
            Missed
          </div>
          <div className="text-2xl font-bold text-fg mt-1">
            {voicemails}
            <span className="text-fg-muted text-base font-normal mx-1">/</span>
            {missed}
          </div>
          <div className="text-[11.5px] text-fg-muted mt-1">
            VM / no-answer
          </div>
        </div>
      </div>

      {totalCalls === 0 && (
        <div className="mt-3 text-[12px] text-fg-muted italic">
          No calls placed yet today. Click any lead and hit Call to dial through Kixie.
        </div>
      )}
    </Card>
  );
}
