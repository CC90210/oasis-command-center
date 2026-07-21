/**
 * GET+POST /api/cron/sweep-stale-sent-app — auto-retire stale Sent-Application
 * leads to Dead (2026-07-21). Cron-secret authed (same pattern as the other
 * /api/cron/* drip routes).
 *
 * A lead that sat at `sent_application` for DRIP_SENT_APP_DEAD_DAYS (default 37 =
 * 6h + 7-day daily nudges + ~30-day every-2-day nudges) without completing the
 * application is moved to `dead_file` (the engine's terminal "Dead" stage, off
 * the active lead board). The move goes through updateRecord so it fires
 * BRAVO_RECORD_STATUS_CHANGED — which the shipped stage-match cancel picks up to
 * kill the lead's remaining drip steps. A drip STEP cannot change stage, so this
 * terminal move lives in a cron, not the sequence.
 *
 * The "entered sent_application" clock is the earliest `sent_application`
 * drip_runs.created_at for the lead (the enroller stamps it on entry).
 * Idempotent: only acts on leads past the threshold that are STILL at
 * sent_application (a completed lead already left the stage). Capped per run.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { updateRecord } from "@/lib/manifest/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEAD_DAYS = Number(process.env.DRIP_SENT_APP_DEAD_DAYS ?? 37);
const DEAD_STAGE = "dead_file";
const SWEEP_LIMIT = 200; // safety cap per run

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  if (!(DEAD_DAYS > 0)) return NextResponse.json({ ok: true, skipped: "disabled" });

  const db = getServiceSupabase();
  const cutoff = new Date(Date.now() - DEAD_DAYS * 86_400_000).toISOString();

  try {
    // 1. Sequences triggering on sent_application (inherently the SunBiz stage).
    const seqRes = await db.from("drip_sequences").select("id, tenant_id, trigger_filter");
    const seqs = ((seqRes.data || []) as Array<{ id: string; tenant_id: string; trigger_filter: unknown }>).filter(
      (s) => {
        const tf = s.trigger_filter as { to?: unknown } | null;
        return !!tf && tf.to === "sent_application";
      },
    );
    if (seqs.length === 0) return NextResponse.json({ ok: true, moved: 0, note: "no sent_application sequence" });
    const seqIds = seqs.map((s) => s.id);

    // 2. drip_runs for those sequences older than the cutoff → distinct leads
    // whose sent_application clock started > DEAD_DAYS ago (step-0 is the oldest).
    const drRes = await db
      .from("drip_runs")
      .select("lead_id, tenant_id")
      .in("sequence_id", seqIds)
      .lte("created_at", cutoff)
      .limit(5000);
    const byTenant = new Map<string, Set<string>>();
    for (const r of (drRes.data || []) as Array<{ lead_id: string; tenant_id: string }>) {
      const set = byTenant.get(r.tenant_id) || new Set<string>();
      set.add(r.lead_id);
      byTenant.set(r.tenant_id, set);
    }
    if (byTenant.size === 0) return NextResponse.json({ ok: true, moved: 0 });

    // 3. Of those, move the ones STILL at sent_application (not completed).
    let moved = 0;
    let scanned = 0;
    for (const [tenantId, leadSet] of byTenant) {
      const leadIds = [...leadSet];
      for (let i = 0; i < leadIds.length && moved < SWEEP_LIMIT; i += 100) {
        const chunk = leadIds.slice(i, i + 100);
        const leadRes = await db
          .from("tenant_records")
          .select("id, data")
          .eq("tenant_id", tenantId)
          .eq("entity_type", "lead")
          .in("id", chunk);
        for (const lead of (leadRes.data || []) as Array<{ id: string; data: Record<string, unknown> | null }>) {
          if (moved >= SWEEP_LIMIT) break;
          scanned++;
          if ((lead.data?.stage as string | undefined) !== "sent_application") continue; // completed / moved on
          try {
            await updateRecord({ tenant_id: tenantId, entity: "lead", id: lead.id, patch: { stage: DEAD_STAGE } });
            moved++;
            // Best-effort audit.
            try {
              const note = `No completed application after ${DEAD_DAYS} days at Sent Application`;
              await db.from("lead_interactions").insert({
                tenant_id: tenantId,
                lead_id: lead.id,
                type: "stage_changed",
                channel: "system",
                direction: "outbound",
                agent_source: "cron_sweep_stale_sent_app",
                subject: "Auto-retired to Dead",
                content: note,
                content_preview: note,
                metadata: { from: "sent_application", to: DEAD_STAGE, reason: "stale_sent_application", days: DEAD_DAYS },
              });
            } catch {
              /* best-effort audit */
            }
          } catch (e) {
            console.error("[sweep-stale-sent-app] move failed", lead.id, e instanceof Error ? e.message : e);
          }
        }
      }
    }
    return NextResponse.json({ ok: true, moved, scanned, cutoffDays: DEAD_DAYS });
  } catch (err) {
    console.error("[sweep-stale-sent-app] error", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unhandled_error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
