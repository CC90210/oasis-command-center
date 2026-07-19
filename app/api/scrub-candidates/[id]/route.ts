/**
 * POST /api/scrub-candidates/[id] — operator approves / declines / retries a
 * scrubbed Breeze deal from the SunBiz dashboard (BreezeDealsPanel), so approval
 * is no longer Telegram-only.
 *
 * body: { action: "approve" | "decline" | "retry_promote", note?: string }
 *
 * approve → createRecord(entity="lead", stage="uw_sheet") from the candidate's
 *           lead_data (emits BRAVO_RECORD_STATUS_CHANGED → the uw_sheet drip +
 *           stale-lead nurture), THEN promoteLeadToApplication() so the deal
 *           becomes a shoppable application with the full UW-sheet field set +
 *           branded PDF — the SAME end state as the Telegram approve → VPS
 *           promote path (one behaviour, two entry points). Cross-sheet dedup
 *           links to an existing lead instead of duplicating.
 * decline → flips the candidate to `declined` with the note. No lead created.
 * retry_promote → re-runs promoteLeadToApplication for an already-approved
 *           candidate whose earlier promote failed (D8 retry surface). Uses the
 *           existing created_lead_id.
 *
 * Auth: signed-in, non-read_only member of the candidate's tenant. Concurrency:
 * an optimistic claim (pending_review → approving) so a double-click can't
 * create two leads; the claim is rolled back if lead creation throws. Raw DB
 * error text is logged server-side, never returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { createRecord, RecordsError } from "@/lib/manifest/data";
import { promoteLeadToApplication } from "@/lib/applications/promote-lead-to-application";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lifecycle/control fields that must NEVER be inherited from a scraped sheet —
// stripped before createRecord so a merchant can't pre-populate e.g. a phishing
// `application_url`, a forged `assigned_to`, or an `opted_out` bypass via a
// crafted spreadsheet cell.
const CONTROL_FIELDS = [
  "application_url", "opted_out", "assigned_to", "assigned_user_id",
  "assigned_rep_user_id", "assigned_rep_phone", "stage", "transferred_at",
  "application_id", "promoted_at",
];

function err(status: number, error: string, message?: string) {
  return NextResponse.json({ ok: false, error, ...(message ? { message } : {}) }, { status });
}

function sanitizeLeadData(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const k of CONTROL_FIELDS) delete out[k];
  out.stage = "uw_sheet"; // server-forced; never from the sheet
  return out;
}

/** Find an existing lead for this merchant by email/phone (cross-sheet dedup). */
async function findExistingLead(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  email: string,
  phone: string,
): Promise<string | null> {
  const safe = (v: string) => v && !/[(),]/.test(v);
  const ors: string[] = [];
  if (safe(email)) ors.push(`data->>email.eq.${email}`);
  if (safe(phone)) ors.push(`data->>phone.eq.${phone}`);
  if (ors.length === 0) return null;
  const r = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .or(ors.join(","))
    .limit(1)
    .maybeSingle();
  if (r.error) {
    console.error("[scrub-candidates] findExistingLead error:", r.error.message);
    return null; // fail open to createRecord — best-effort dedup
  }
  return (r.data as { id: string } | null)?.id ?? null;
}

/** Best-effort promote after the lead exists. A promote failure does NOT undo
 * the approval (the lead is real + at uw_sheet, so the drip still fires and the
 * deal is retryable); promoteLeadToApplication already files an operator alert. */
async function promoteAndSummarize(tenantId: string, leadId: string) {
  const p = await promoteLeadToApplication({ tenantId, leadId, source: "live_sub_dashboard" });
  if (!p.ok) return { promoted: false, promote_error: p.error };
  return {
    promoted: true,
    application_id: p.applicationId,
    phone_status: p.phoneStatus,
    missing_critical: p.missingCritical,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return err(401, "unauthorized");

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return err(400, "bad_id", "candidate id must be a UUID");

  let body: { action?: string; note?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return err(400, "invalid_json");
  }
  const action = (body.action || "").toLowerCase();
  if (!["approve", "decline", "retry_promote"].includes(action)) {
    return err(400, "bad_action", "action must be 'approve', 'decline', or 'retry_promote'");
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id, team_role, is_owner")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const profile = profileRes.data as
    | { tenant_id: string | null; team_role: string | null; is_owner: boolean | null }
    | null;
  const tenantId = profile?.tenant_id ?? null;
  if (!tenantId) return err(401, "no_tenant");
  const role = (profile?.is_owner ? "owner" : profile?.team_role || "read_only").toLowerCase();
  if (role === "read_only") return err(403, "forbidden", "read-only users cannot review deals");

  // Tenant-scoped fetch — a user can only act on their own tenant's candidates.
  const candRes = await db
    .from("scrub_candidates")
    .select("id, tenant_id, status, lead_data, created_lead_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (candRes.error) {
    console.error("[scrub-candidates] fetch error:", candRes.error.message);
    return err(500, "db_error");
  }
  const cand = candRes.data as
    | { id: string; tenant_id: string; status: string; lead_data: Record<string, unknown>; created_lead_id: string | null }
    | null;
  if (!cand) return err(404, "not_found");

  const nowIso = new Date().toISOString();
  const reviewer = user.id; // stable immutable audit anchor (not the mutable email)

  // ── retry_promote: re-run promote for an already-approved candidate ──────
  if (action === "retry_promote") {
    if (!cand.created_lead_id) return err(409, "no_lead", "candidate has no linked lead to promote");
    const summary = await promoteAndSummarize(tenantId, cand.created_lead_id);
    if (!summary.promoted) return err(500, "promote_failed", summary.promote_error);
    return NextResponse.json({ ok: true, action: "retry_promote", candidate_id: id, lead_id: cand.created_lead_id, ...summary });
  }

  if (cand.status !== "pending_review") {
    return err(409, "already_decided", `candidate is already ${cand.status}`);
  }

  // ── decline ──────────────────────────────────────────────────────────────
  if (action === "decline") {
    const upd = await db
      .from("scrub_candidates")
      .update({ status: "declined", reviewed_by: reviewer, reviewed_at: nowIso, review_note: note, updated_at: nowIso })
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .eq("status", "pending_review"); // optimistic lock
    if (upd.error) {
      console.error("[scrub-candidates] decline update error:", upd.error.message);
      return err(500, "db_error");
    }
    return NextResponse.json({ ok: true, action: "declined", candidate_id: id });
  }

  // ── approve → ATOMIC CLAIM (pending_review → approving) so a double-click
  //    or two operators can't both createRecord and produce duplicate leads ──
  const claim = await db
    .from("scrub_candidates")
    .update({ status: "approving", reviewed_by: reviewer, reviewed_at: nowIso, review_note: note, updated_at: nowIso })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .eq("status", "pending_review")
    .select("id");
  if (claim.error) {
    console.error("[scrub-candidates] claim error:", claim.error.message);
    return err(500, "db_error");
  }
  if (!claim.data || claim.data.length === 0) {
    return err(409, "already_decided", "candidate is no longer pending");
  }

  const raw = (cand.lead_data || {}) as Record<string, unknown>;
  const email = String(raw.email || "").trim().toLowerCase();
  const phone = String(raw.phone || "").trim();

  // Cross-sheet dedup: link to an existing merchant lead instead of duplicating.
  const existingLeadId = await findExistingLead(db, tenantId, email, phone);
  if (existingLeadId) {
    await db
      .from("scrub_candidates")
      .update({ status: "approved", created_lead_id: existingLeadId, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    const summary = await promoteAndSummarize(tenantId, existingLeadId);
    return NextResponse.json({ ok: true, action: "approved", candidate_id: id, lead_id: existingLeadId, deduped: true, ...summary });
  }

  let leadId: string;
  try {
    const record = await createRecord({ tenant_id: tenantId, entity: "lead", data: sanitizeLeadData(raw) });
    leadId = record.id;
  } catch (e) {
    // Roll the claim back so the candidate returns to the queue for retry.
    await db
      .from("scrub_candidates")
      .update({ status: "pending_review", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .eq("status", "approving");
    const code = e instanceof RecordsError ? e.code : "create_failed";
    console.error("[scrub-candidates] createRecord error:", e instanceof Error ? e.message : e);
    return err(code === "validation" ? 400 : 500, code);
  }

  const upd = await db
    .from("scrub_candidates")
    .update({ status: "approved", created_lead_id: leadId, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (upd.error) {
    console.error("[scrub-candidates] finalize update error:", upd.error.message);
    // Lead created but the flip failed — stays 'approving' (out of pending, so
    // no double-create). Still promote so the deal is usable; surface a warning.
    const summary = await promoteAndSummarize(tenantId, leadId);
    return NextResponse.json({ ok: true, action: "approved", candidate_id: id, lead_id: leadId, warning: "candidate_status_update_failed", ...summary });
  }

  const summary = await promoteAndSummarize(tenantId, leadId);
  return NextResponse.json({ ok: true, action: "approved", candidate_id: id, lead_id: leadId, ...summary });
}
