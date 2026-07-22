/**
 * GET+POST /api/cron/enroll-accelerated — lifecycle manager for the SMS-only
 * "Accelerated statement chase" (2026-07-21). Flag-triggered, so the normal
 * stage enroller (enroll-drips) never touches it; this cron is its dedicated
 * enroller + reaper. Cron-secret authed (same as the other /api/cron/* routes).
 *
 * One pass over every lead flagged `data.accelerated_followup` does three things:
 *   1. ENROLL  — a flagged lead with a phone, not opted-out, at a pre-funnel
 *      stage, with no active accelerated run → insert a step-0 drip_run. The
 *      executor sends each SMS from the step's pinned number (two admin lines
 *      alternate), inside TCPA hours, paced by the hourly cap.
 *   2. STOP    — a flagged lead that reached the application funnel
 *      (sent/viewed/signed_application), went terminal (dead/opted/declined/
 *      funded), or whose chase is complete → CLEAR the flag. The executor's
 *      generic flag-cancel then kills any remaining steps within one dispatch
 *      tick, and the lead drops out of the accelerated view.
 *   3. AUTO-DEAD — a flagged lead whose current chase stint started more than
 *      DRIP_ACCEL_DEAD_DAYS ago (default 45 = ~day 44 last step + a day) and
 *      still hasn't engaged → move to `dead_file` and clear the flag.
 *
 * Fail-closed + staged: NOTHING mutates until ACCELERATED_ENROLL_LIVE=1. With it
 * unset this is a pure read + report (candidates / would-enroll / would-stop /
 * would-dead), so it can run on a schedule indefinitely without touching a lead.
 * Idempotent by the drip_runs active-per-lead unique index + the flag checks.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { updateRecord } from "@/lib/manifest/data";
import { parseDripSteps } from "@/lib/drips/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LIVE = process.env.ACCELERATED_ENROLL_LIVE === "1";
const DEAD_DAYS = Number(process.env.DRIP_ACCEL_DEAD_DAYS ?? 45);
const ENROLL_LIMIT = (() => {
  const n = parseInt((process.env.ACCELERATED_ENROLL_LIMIT || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 25;
})();
const SPREAD_MS = 90 * 60_000; // step-0 jitter so a cohort doesn't detonate together
const SHOPPED_LOOKBACK_DAYS = 7;
const FLAG = "accelerated_followup";
const DEAD_STAGE = "dead_file";

// Stages where the chase is over: the lead reached the application funnel, went
// terminal, or funded. Reaching any of these → clear the flag (stop + de-list).
const STOP_STAGES = new Set([
  "sent_application",
  "viewed_application",
  "signed_application",
  "dead_file",
  "opted_out",
  "declined",
  "funded",
]);

type Lead = { id: string; data: Record<string, unknown> | null };
type RunRow = { lead_id: string; status: string; created_at: string };

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}
function isOptedOut(d: Record<string, unknown>): boolean {
  return truthy(d.opted_out) || truthy(d.sms_opt_out) || d.stage === "opted_out";
}

/** Best-effort shopped-in-last-7-days guard (mirrors enroller.ts): never start a
 *  chase on a deal shopped to funders and awaiting a response. Not a fail-closed
 *  gate — dispatch-time suppression is load-bearing; this is defense in depth. */
async function wasShoppedRecently(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadId: string,
  d: Record<string, unknown>,
): Promise<boolean> {
  const cutoff = Date.now() - SHOPPED_LOOKBACK_DAYS * 86_400_000;
  const ts =
    (typeof d.shopped_at === "string" && d.shopped_at) ||
    (typeof d.last_shopped_at === "string" && d.last_shopped_at) ||
    null;
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  try {
    const r = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .gte("created_at", new Date(cutoff).toISOString())
      .ilike("agent_source", "%shop_out%")
      .limit(1);
    if (!r.error && Array.isArray(r.data) && r.data.length > 0) return true;
  } catch {
    /* best-effort */
  }
  return false;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const db = getServiceSupabase();
  const deadCutoff = new Date(Date.now() - Math.max(1, DEAD_DAYS) * 86_400_000).toISOString();

  try {
    // The accelerated sequence(s): flag-triggered on accelerated_followup=true.
    const seqRes = await db
      .from("drip_sequences")
      .select("id, tenant_id, name, enabled, steps, trigger_filter")
      .eq("enabled", true);
    const seqs = ((seqRes.data || []) as Array<{
      id: string; tenant_id: string; name: string; steps: unknown; trigger_filter: unknown;
    }>).filter((s) => {
      const tf = s.trigger_filter as { entity?: unknown; field?: unknown } | null;
      return !!tf && (!tf.entity || tf.entity === "lead") && tf.field === FLAG;
    });
    if (seqs.length === 0) return NextResponse.json({ ok: true, note: "no accelerated sequence", live: LIVE });

    const summary: Array<Record<string, unknown>> = [];

    for (const seq of seqs) {
      const tenantId = seq.tenant_id;
      let firstChannel = "sms";
      let firstDelay = 60;
      try {
        const steps = parseDripSteps(seq.steps);
        firstChannel = steps[0].channel;
        firstDelay = Math.max(0, steps[0].delay_minutes);
      } catch {
        summary.push({ sequenceId: seq.id, error: "invalid_steps" });
        continue;
      }

      // Every flagged lead for this tenant (bounded; oldest first so a big
      // backlog degrades gracefully rather than starving old leads).
      const leadsRes = await db
        .from("tenant_records")
        .select("id, data")
        .eq("tenant_id", tenantId)
        .eq("entity_type", "lead")
        .filter(`data->>${FLAG}`, "eq", "true")
        .order("created_at", { ascending: true })
        .limit(2000);
      const leads = (leadsRes.data || []) as Lead[];
      if (leads.length === 0) {
        summary.push({ sequenceId: seq.id, tenantId, flagged: 0 });
        continue;
      }

      // Prefetch this cohort's runs for this sequence → active set (skip
      // re-enroll) + newest run per lead (current-stint clock for auto-dead).
      const leadIds = leads.map((l) => l.id);
      const active = new Set<string>();
      const newestRun = new Map<string, number>();
      for (let i = 0; i < leadIds.length; i += 300) {
        const chunk = leadIds.slice(i, i + 300);
        const runRes = await db
          .from("drip_runs")
          .select("lead_id, status, created_at")
          .eq("tenant_id", tenantId)
          .eq("sequence_id", seq.id)
          .in("lead_id", chunk);
        for (const r of (runRes.data || []) as RunRow[]) {
          if (r.status === "scheduled" || r.status === "sending") active.add(r.lead_id);
          const t = Date.parse(r.created_at);
          if (Number.isFinite(t)) newestRun.set(r.lead_id, Math.max(newestRun.get(r.lead_id) ?? 0, t));
        }
      }

      let enrolled = 0, stopped = 0, autoDead = 0, wouldEnroll = 0, wouldStop = 0, wouldDead = 0;
      let skippedNoPhone = 0, skippedOptedOut = 0, skippedActive = 0, skippedShopped = 0;
      const deadCutoffMs = Date.parse(deadCutoff);

      for (const lead of leads) {
        const d = lead.data || {};
        const stage = typeof d.stage === "string" ? d.stage : "";

        // 2. STOP — reached the funnel / terminal → clear the flag (executor
        // cancels remaining steps; lead de-lists from the accelerated view).
        if (STOP_STAGES.has(stage) || isOptedOut(d)) {
          wouldStop++;
          if (LIVE) {
            try {
              await updateRecord({ tenant_id: tenantId, entity: "lead", id: lead.id, patch: { [FLAG]: false } });
              stopped++;
            } catch (e) {
              console.error("[enroll-accelerated] stop-clear failed", lead.id, e instanceof Error ? e.message : e);
            }
          }
          continue;
        }

        // 3. AUTO-DEAD — current chase stint older than the window → retire.
        const newest = newestRun.get(lead.id);
        if (newest !== undefined && Number.isFinite(deadCutoffMs) && newest <= deadCutoffMs) {
          wouldDead++;
          if (LIVE) {
            try {
              await updateRecord({
                tenant_id: tenantId, entity: "lead", id: lead.id,
                patch: { stage: DEAD_STAGE, [FLAG]: false },
              });
              autoDead++;
              try {
                const note = `No engagement after ${DEAD_DAYS} days of accelerated chase`;
                await db.from("lead_interactions").insert({
                  tenant_id: tenantId, lead_id: lead.id, type: "stage_changed", channel: "system",
                  direction: "outbound", agent_source: "cron_enroll_accelerated",
                  subject: "Auto-retired to Dead", content: note, content_preview: note,
                  metadata: { from: stage, to: DEAD_STAGE, reason: "accelerated_exhausted", days: DEAD_DAYS },
                });
              } catch { /* best-effort audit */ }
            } catch (e) {
              console.error("[enroll-accelerated] auto-dead failed", lead.id, e instanceof Error ? e.message : e);
            }
          }
          continue;
        }

        // 1. ENROLL — new flagged lead, not yet chasing.
        if (active.has(lead.id)) { skippedActive++; continue; }
        if (isOptedOut(d)) { skippedOptedOut++; continue; }
        const phone = typeof d.phone === "string" ? d.phone.trim() : "";
        if (firstChannel === "sms" && !phone) { skippedNoPhone++; continue; }

        wouldEnroll++;
        if (!LIVE) continue;
        if (ENROLL_LIMIT !== 0 && enrolled >= ENROLL_LIMIT) continue;
        if (await wasShoppedRecently(db, tenantId, lead.id, d)) { skippedShopped++; continue; }

        const scheduledFor = new Date(
          Date.now() + firstDelay * 60_000 + Math.floor(Math.random() * SPREAD_MS),
        ).toISOString();
        const ins = await db.from("drip_runs").insert({
          tenant_id: tenantId, lead_id: lead.id, sequence_id: seq.id, sequence_name: seq.name,
          step_index: 0, channel: firstChannel, scheduled_for: scheduledFor, status: "scheduled",
        });
        if (ins.error) {
          if (!/duplicate key|unique constraint/i.test(ins.error.message)) {
            console.error("[enroll-accelerated] insert failed", lead.id, ins.error.message);
          }
          continue;
        }
        enrolled++;
      }

      summary.push({
        sequenceId: seq.id, tenantId, flagged: leads.length,
        enrolled, stopped, autoDead, wouldEnroll, wouldStop, wouldDead,
        skippedActive, skippedNoPhone, skippedOptedOut, skippedShopped,
      });
    }

    return NextResponse.json({ ok: true, live: LIVE, deadDays: DEAD_DAYS, enrollLimit: ENROLL_LIMIT, summary });
  } catch (err) {
    console.error("[enroll-accelerated] error", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unhandled_error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
