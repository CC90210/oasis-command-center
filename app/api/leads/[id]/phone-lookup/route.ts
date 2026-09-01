/**
 * /api/leads/[id]/phone-lookup — the AUTOMATED (TruePeopleSearch) phone lookup.
 *
 *   GET  — the lookup history for this lead, newest first.
 *   POST — enqueue a new lookup.
 *
 * WHY POST ONLY ENQUEUES, AND NEVER PERFORMS THE LOOKUP:
 * TruePeopleSearch has no API and is protected by DataDome, which scores the
 * source ASN before it parses a request. Every datacenter IP is challenged on
 * arrival — the VPS, and this Vercel function equally. The scrape has to run
 * from a residential connection driving a real browser, which is Adon's
 * workstation, which has no inbound address this function could call. So the
 * call direction is inverted: this route writes a row to `phone_lookup_jobs`
 * and returns immediately; the local JARVIS `tps-enricher` worker polls, claims,
 * scrapes, and writes the result back (including the `phone_lookup_status`
 * stamp on the lead). The panel polls GET until the row reaches a terminal
 * status. If you are tempted to "just call the site from here", that is the
 * thing that does not work and is the reason this queue exists.
 *
 * ORDER OF ENRICHMENT: this is the free, automated PRIMARY. Thomson Reuters
 * CLEAR (/api/leads/[id]/clair-report) is the billable, permissible-use, manual
 * FALLBACK, and lib/clair/eligibility.ts refuses it until a lookup here has run
 * and come up empty. Those two routes are two halves of one rule.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { hasUsablePhone } from "@/lib/clair/eligibility";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { getReadableLeadTargetForSession, getWritableLead } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Terminal statuses — anything else means the worker still owns the row. */
const IN_FLIGHT = ["pending", "running"];

/** A lookup burns a slice of the workstation's daily scrape budget and a slice
 * of its IP reputation, which is the scarce resource the whole design rests on.
 * Re-running the same lead inside this window returns the existing row instead. */
const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const SELECT_COLS =
  "id,status,error_message,phones,emails,matched_name,matched_age,matched_city," +
  "matched_state,confidence,source,query_first_name,query_last_name,query_city," +
  "query_state,trigger_source,requested_by_email,created_at,claimed_at,completed_at";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "bad_lead_id" }, { status: 400 });
  }

  const svc = getServiceSupabase();

  // Per-agent lead visibility: when lead scoping is on, an agent must not read
  // another agent's lead lookup PII (names/phones/emails) by hitting this
  // endpoint with a UUID. Same boundary the detail/documents routes enforce.
  // 404 (not 403) so the endpoint doesn't confirm the lead exists.
  const target = await getReadableLeadTargetForSession(sess, {
    tenantId: sess.tenantId,
    id: leadId,
  });
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const { data, error } = await svc
    .from("phone_lookup_jobs")
    .select(SELECT_COLS)
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobs: data ?? [] });
}

/**
 * Split a stored owner name into first / last.
 *
 * The scraper matches on first + last, so a single "name" string has to be
 * divided somewhere. Doing it here rather than in the worker keeps the query
 * that was actually asked visible on the job row and reviewable by the operator
 * who clicked. "Last, First" is handled because CRM imports produce it.
 */
function splitName(full: string): { first: string; last: string } {
  const clean = full.replace(/\s+/g, " ").trim();
  if (!clean) return { first: "", last: "" };
  if (clean.includes(",")) {
    const [last, first] = clean.split(",", 2).map((s) => s.trim());
    if (last && first) return { first: first.split(" ")[0], last };
  }
  const parts = clean.split(" ").filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  // Drop middle names/initials: the sites index on first + last.
  return { first: parts[0], last: parts[parts.length - 1] };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Checked before any record lookup so a read-only caller gets an identical 403
  // whether or not the lead exists (no enumeration oracle).
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "bad_lead_id" }, { status: 400 });
  }

  const svc = getServiceSupabase();

  // Tenant isolation: the lead must live in THIS tenant, or a valid session
  // could research another tenant's merchant by id.
  const access = await getWritableLead(
    { teamRole: sess.teamRole, userId: sess.userId, isOwner: sess.isTrueAdmin, adminAccess: sess.adminAccess },
    { tenantId: sess.tenantId, entity: "lead", id: leadId },
  );
  if (!access.ok) {
    return access.reason === "role_denied"
      ? NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 })
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const leadData = access.record.data;
  // Per-agent lead visibility: a write-capable member must not enqueue a lookup
  // (which spends scrape budget and produces PII) for a lead outside their scope.
  // 404, matching the detail/documents routes — no existence oracle.
  if (hasUsablePhone(leadData)) {
    return NextResponse.json(
      { ok: false, error: "already_has_phone", message: "This lead already has a phone number on file." },
      { status: 409 },
    );
  }

  const rawName = String(
    leadData.owner_full_name || leadData.owner_name || leadData.contact_name || "",
  );
  const { first, last } = splitName(rawName);
  if (!first || !last) {
    return NextResponse.json(
      {
        ok: false,
        error: "insufficient_name",
        message:
          "A first and last name are required to search. Add the owner's full name to this lead first.",
      },
      { status: 422 },
    );
  }

  // Both dedupe checks below filter in the DATABASE rather than slicing recent
  // history in memory. Fetching the last N rows and scanning them looks
  // equivalent but is not: a run of retryable failures pushes the qualifying
  // job out of the sample, and the window silently stops applying.

  // 1. One in-flight job per lead — a double-click must not spend two scrapes.
  //    (The partial unique index in database/121 is the real guarantee; this is
  //    the friendly path that returns the running job instead of a conflict.)
  const { data: inFlight, error: inFlightErr } = await svc
    .from("phone_lookup_jobs")
    .select(SELECT_COLS)
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", leadId)
    .in("status", IN_FLIGHT)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inFlightErr) {
    // Fail closed: unable to prove there is no in-flight job ⇒ do not add one.
    return NextResponse.json({ ok: false, error: "dedupe_check_failed" }, { status: 503 });
  }
  if (inFlight) {
    return NextResponse.json({ ok: true, job: inFlight, deduped: "in_flight" });
  }

  // 2. A conclusive lookup inside the dedupe window suppresses a new one. Only
  //    'completed' and 'no_results' qualify: a previous block or error is not an
  //    answer about this merchant and must never suppress a retry.
  //
  //    `?force=1` overrides this ONE check, because the most common reason an
  //    operator re-runs a lookup is that they just fixed the owner's name or
  //    state — and the stored query was snapshotted from the old, wrong data.
  //    Refusing that retry would make the window protect a result we already
  //    know was asked wrongly. It does NOT override the in-flight check above,
  //    and the worker's daily cap still applies.
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force) {
    const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const { data: recent, error: recentErr } = await svc
      .from("phone_lookup_jobs")
      .select(SELECT_COLS)
      .eq("tenant_id", sess.tenantId)
      .eq("lead_id", leadId)
      .in("status", ["completed", "no_results"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentErr) {
      return NextResponse.json({ ok: false, error: "dedupe_check_failed" }, { status: 503 });
    }
    if (recent) {
      return NextResponse.json({ ok: true, job: recent, deduped: "recent" });
    }
  }

  // Home city/state beats the business address for a people-search match, so
  // prefer the owner's own address when the import captured one.
  const city = String(leadData.owner_home_city || leadData.owner_city || leadData.city || "").trim();
  const state = String(
    leadData.owner_home_state || leadData.owner_state || leadData.business_state || leadData.state || "",
  ).trim();
  const ageRaw = Number(leadData.owner_age);

  const { data: job, error: insErr } = await svc
    .from("phone_lookup_jobs")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      query_first_name: first,
      query_last_name: last,
      query_city: city || null,
      query_state: state || null,
      query_age: Number.isFinite(ageRaw) && ageRaw > 0 && ageRaw < 120 ? Math.round(ageRaw) : null,
      trigger_source: "manual",
      requested_by: sess.userId,
      requested_by_email: sess.email,
    })
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    // 23505 = the partial unique index in database/121, which is what actually
    // guarantees one unfinished job per lead. The dedupe SELECT above is a
    // read-then-insert and two concurrent POSTs can both clear it, so losing
    // this race is expected rather than exceptional: return the job that won.
    if (isUniqueViolationError(insErr)) {
      const { data: winner } = await svc
        .from("phone_lookup_jobs")
        .select(SELECT_COLS)
        .eq("tenant_id", sess.tenantId)
        .eq("lead_id", leadId)
        .in("status", IN_FLIGHT)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (winner) return NextResponse.json({ ok: true, job: winner, deduped: "in_flight" });
    }
    return NextResponse.json(
      { ok: false, error: "enqueue_failed", message: insErr.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, job });
}
