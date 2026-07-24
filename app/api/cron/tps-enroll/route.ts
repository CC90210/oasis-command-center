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

type Candidate = {
  row: { id: string; tenant_id: string; created_lead_id: string; lead_data: Record<string, unknown> };
  d: Record<string, unknown>;
  name: { first: string; last: string };
};

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const write = new URL(req.url).searchParams.get("write") === "1";
  const db = getServiceSupabase();

  const summary = {
    ok: true,
    write,
    scanned: 0,
    needPhone: 0,
    enrolled: 0,
    skipped: {} as Record<string, number>,
    samples: [] as string[],
  };
  const bump = (r: string) => {
    summary.skipped[r] = (summary.skipped[r] || 0) + 1;
  };

  // KEYSET pagination over the ENTIRE approved set, keyed on the UNIQUE id. No
  // page ceiling (a ceiling permanently starves rows past it, and the
  // frontier-advance argument does not save them because they are never scanned).
  // Keying on id — not created_at — because id is unique: a created_at cursor
  // breaks when >=PAGE rows share a timestamp (a bulk import), silently skipping
  // the rest (Codex 2026-07-24). Order is therefore arbitrary rather than
  // oldest-first, which is fine: enrollment is order-agnostic (every row is
  // reached over successive sweeps as enrolled ones drop out at the dedupe step),
  // and the initial backfill already ran oldest-first.
  const PAGE = 500;
  const candidates: Candidate[] = [];
  let cursor: string | null = null;
  for (;;) {
    let q = db
      .from(CANDIDATE_TABLE)
      .select("id, tenant_id, created_lead_id, lead_data")
      .eq("status", "approved")
      .not("created_lead_id", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as Candidate["row"][];
    for (const row of rows) {
      summary.scanned++;
      const d = (row.lead_data || {}) as Record<string, unknown>;
      if (usablePhone(d.phone)) continue;
      summary.needPhone++;
      const name = splitName(pickName(d));
      if (!name) {
        bump("no_name");
        continue;
      }
      candidates.push({ row, d, name });
    }
    if (rows.length < PAGE) break; // reached the end of the table
    cursor = rows[rows.length - 1].id; // id is unique → strict advance, no overlap
  }

  if (!candidates.length) return NextResponse.json(summary);

  // Job history for every candidate, grouped in memory (chunked IN()).
  const jobsByLead = new Map<string, PriorJob[]>();
  const ids = candidates.map((c) => c.row.created_lead_id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await db
      .from(JOBS_TABLE)
      .select("lead_id, status, trigger_source, created_at")
      .in("lead_id", chunk);
    if (error) {
      return NextResponse.json({ ok: false, error: `jobs_scan_failed:${error.message}` }, { status: 500 });
    }
    for (const j of (data ?? []) as (PriorJob & { lead_id: string })[]) {
      if (!jobsByLead.has(j.lead_id)) jobsByLead.set(j.lead_id, []);
      jobsByLead.get(j.lead_id)!.push(j);
    }
  }

  for (const c of candidates) {
    if (summary.enrolled >= ENROLL_BATCH) {
      bump("batch_cap");
      continue;
    }
    const decision = enrollDecision(jobsByLead.get(c.row.created_lead_id) || []);
    if (!decision.enroll) {
      bump(decision.reason);
      continue;
    }
    const state = String(
      c.d.owner_home_state || c.d.owner_state || c.d.business_state || c.d.state || "",
    );
    if (summary.samples.length < 10) {
      summary.samples.push(`${c.name.first} ${c.name.last} (${state || "?"})`);
    }
    if (!write) {
      summary.enrolled++;
      continue;
    }
    const { error } = await db.from(JOBS_TABLE).insert({
      tenant_id: c.row.tenant_id,
      lead_id: c.row.created_lead_id,
      query_first_name: c.name.first,
      query_last_name: c.name.last,
      query_city: String(c.d.owner_home_city || c.d.owner_city || c.d.city || "") || null,
      query_state: state || null,
      trigger_source: "live_sub_auto",
      requested_by_email: "auto:live_subs:cron",
    });
    if (!error) {
      summary.enrolled++;
    } else if (error.code === "23505" || /duplicate/i.test(error.message)) {
      // Partial-unique in-flight index won a race — already queued.
      bump("already_queued");
    } else {
      bump(`insert_failed:${error.code || error.message}`);
    }
  }

  return NextResponse.json(summary);
}
