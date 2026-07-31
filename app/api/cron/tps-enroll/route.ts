/**
 * GET /api/cron/tps-enroll — cloud enrollment of Live Subs into the
 * TruePeopleSearch queue. Runs on a Vercel cron every ~10 min, 24/7, so a Live
 * Sub is queued for a phone lookup regardless of whether Adon's workstation (the
 * only machine that can actually run the scrape) is on.
 *
 * WHY THIS IS SEPARATE FROM THE SCRAPE: TruePeopleSearch is DataDome-protected;
 * only a residential IP driving a real browser passes. That runs on a local,
 * non-elevated desktop worker. Enrollment (deciding WHICH Live Subs need a phone
 * and enqueuing them) is pure database work and belongs in the cloud so the
 * pipeline never depends on the PC being on. The local worker only drains.
 *
 * A "Live Sub" = an APPROVED scrub_candidates row that spawned a lead
 * (created_lead_id). This is the TypeScript port of the proven JARVIS
 * services/tps-enricher/enroll.js sweep.
 *
 * Auth: Bearer SCAN_TRIGGER_SECRET | CRON_SECRET (Vercel sends the latter).
 * DRY unless ?write=1 — a dry run reports the set it WOULD enqueue, writing nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANDIDATE_TABLE = "scrub_candidates";
const JOBS_TABLE = "phone_lookup_jobs";

const ENROLL_BATCH = Number(process.env.TPS_ENROLL_BATCH || 25);
const MAX_AUTO_ATTEMPTS = Number(process.env.TPS_MAX_AUTO_ATTEMPTS || 3);
const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return false;
  for (const secret of [process.env.SCAN_TRIGGER_SECRET, process.env.CRON_SECRET]) {
    if (!secret) continue;
    const a = Buffer.from(bearer);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function usablePhone(p: unknown): boolean {
  const d = String(p ?? "").replace(/\D/g, "");
  return d.length >= 10 && !/^0+$/.test(d);
}

/** first/last from a stored owner name. "Last, First" honoured. null when a real
 * two-part name is not present — a nameless Live Sub is not enrollable. */
function splitName(full: unknown): { first: string; last: string } | null {
  const clean = String(full || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (clean.includes(",")) {
    const [last, first] = clean.split(",", 2).map((s) => s.trim());
    if (last && first) return { first: first.split(" ")[0], last };
  }
  const parts = clean.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function pickName(d: Record<string, unknown>): unknown {
  return d.owner_full_name || d.owner_name || d.contact_name || "";
}

type PriorJob = { status: string; trigger_source: string; created_at: string };

/** Should this lead be auto-enrolled now, given its job history? Mirrors
 * enroll.js enrollDecision exactly. */
function enrollDecision(jobs: PriorJob[]): { enroll: boolean; reason: string } {
  if (jobs.some((j) => j.status === "pending" || j.status === "running")) {
    return { enroll: false, reason: "in_flight" };
  }
  if (jobs.some((j) => j.status === "completed")) {
    return { enroll: false, reason: "already_found" };
  }
  const now = Date.now();
  const recentNoResults = jobs.some(
    (j) => j.status === "no_results" && now - new Date(j.created_at).getTime() < DEDUPE_WINDOW_MS,
  );
  if (recentNoResults) return { enroll: false, reason: "recent_no_results" };
  const autoAttempts = jobs.filter((j) => j.trigger_source === "live_sub_auto").length;
  if (autoAttempts >= MAX_AUTO_ATTEMPTS) return { enroll: false, reason: "attempts_exhausted" };
  return { enroll: true, reason: "eligible" };
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const write = new URL(req.url).searchParams.get("write") === "1";
  const db = getServiceSupabase();

  const summary = {
    ok: true,
    write,
    reclaimed: 0,
    scanned: 0,
    needPhone: 0,
    enrolled: 0,
    skipped: {} as Record<string, number>,
    samples: [] as string[],
  };
  const bump = (r: string) => {
    summary.skipped[r] = (summary.skipped[r] || 0) + 1;
  };

  // Reclaim stale claims. If the local worker crashes mid-scrape, its row is
  // stuck `running` forever — the UI polls it, the dedupe treats it as in-flight,
  // and nothing ever retries it. Reset `running` rows claimed longer ago than any
  // scrape could take back to `pending` so they are picked up again. Runs here
  // (every 10 min, in the cloud) so it works even while the workstation is down.
  const STALE_RUNNING_MS = Number(process.env.TPS_STALE_RUNNING_MIN || 15) * 60_000;
  if (write) {
    const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    const { data: reclaimed } = await db
      .from(JOBS_TABLE)
      .update({ status: "pending", claimed_at: null })
      .eq("status", "running")
      .lt("claimed_at", staleCutoff)
      .select("id");
    summary.reclaimed = reclaimed?.length ?? 0;
  }

  // INCREMENTAL enrollment. Paginate approved candidates keyed on the UNIQUE id
  // (unique → strict advance, no timestamp ties, no starvation). Per page:
  // batch-load job history, and for each JOB-eligible candidate consult the LIVE
  // lead (tenant_records.data is authoritative — scrub_candidates.lead_data is
  // only the approval-time snapshot and goes stale the moment an operator edits
  // the lead's phone/name/address). Enqueue from the LIVE data. STOP as soon as
  // ENROLL_BATCH jobs are queued, so a large approved history never
  // scans-the-world-before-inserting into a Vercel timeout (Codex 2026-07-24).
  // The frontier advances across sweeps because enrolled leads acquire in-flight
  // jobs and drop out at the dedupe step.
  //
  // KNOWN LIMITATION (acceptable at this scale): the cursor resets each run, so
  // when the approved population grows into the thousands AND most are terminally
  // ineligible (already have a phone), a run rescans them before reaching newer
  // eligible ones and could hit the Vercel timeout, starving the newer ones. Not
  // fixed here because the safe fix (a persisted cross-run cursor) needs new state
  // infra, and a phone_lookup_status query-filter is unsafe while the VPS enricher
  // still writes false statuses (see docs/TPS_VPS_DECOMMISSION.md). Live Subs is a
  // hand-approved BD queue (tens–low-hundreds); revisit with a persisted cursor if
  // it ever approaches that size.
  const PAGE = 500;
  let cursor: string | null = null;
  let done = false;
  while (!done) {
    let q = db
      .from(CANDIDATE_TABLE)
      .select("id, tenant_id, created_lead_id")
      .eq("status", "approved")
      .not("created_lead_id", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as { id: string; tenant_id: string; created_lead_id: string }[];
    if (!rows.length) break;

    // Batch job history for this page.
    const jobsByLead = new Map<string, PriorJob[]>();
    const leadIds = rows.map((r) => r.created_lead_id);
    for (let i = 0; i < leadIds.length; i += 200) {
      const chunk = leadIds.slice(i, i + 200);
      const { data: jd, error: je } = await db
        .from(JOBS_TABLE)
        .select("lead_id, status, trigger_source, created_at")
        .in("lead_id", chunk);
      if (je) {
        return NextResponse.json({ ok: false, error: `jobs_scan_failed:${je.message}` }, { status: 500 });
      }
      for (const j of (jd ?? []) as (PriorJob & { lead_id: string })[]) {
        if (!jobsByLead.has(j.lead_id)) jobsByLead.set(j.lead_id, []);
        jobsByLead.get(j.lead_id)!.push(j);
      }
    }

    for (const row of rows) {
      summary.scanned++;
      const decision = enrollDecision(jobsByLead.get(row.created_lead_id) || []);
      if (!decision.enroll) {
        bump(decision.reason);
        continue;
      }
      // Job-eligible → the LIVE lead is authoritative for phone + identity.
      const { data: lead } = await db
        .from("tenant_records")
        .select("data")
        .eq("id", row.created_lead_id)
        .eq("tenant_id", row.tenant_id)
        .maybeSingle();
      const ld = (lead?.data ?? {}) as Record<string, unknown>;
      if (usablePhone(ld.phone)) {
        bump("already_has_phone");
        continue;
      }
      summary.needPhone++;
      const name = splitName(pickName(ld));
      if (!name) {
        bump("no_name");
        continue;
      }
      const state = String(
        ld.owner_home_state || ld.owner_state || ld.business_state || ld.state || "",
      );
      if (summary.samples.length < 10) {
        summary.samples.push(`${name.first} ${name.last} (${state || "?"})`);
      }
      if (write) {
        const { error: ie } = await db.from(JOBS_TABLE).insert({
          tenant_id: row.tenant_id,
          lead_id: row.created_lead_id,
          query_first_name: name.first,
          query_last_name: name.last,
          query_city: String(ld.owner_home_city || ld.owner_city || ld.city || "") || null,
          query_state: state || null,
          trigger_source: "live_sub_auto",
          requested_by_email: "auto:live_subs:cron",
        });
        if (!ie) summary.enrolled++;
        else if (ie.code === "23505" || /duplicate/i.test(ie.message)) bump("already_queued");
        else bump(`insert_failed:${ie.code || ie.message}`);
      } else {
        summary.enrolled++;
      }

      if (summary.enrolled >= ENROLL_BATCH) {
        done = true;
        break;
      }
    }

    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].id;
  }

  return NextResponse.json(summary);
}
