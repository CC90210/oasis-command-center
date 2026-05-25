/**
 * GET /api/manifest/[slug]/underwriting/queue
 *
 * Returns all applications for the tenant bucketed into four underwriting
 * workflow groups. Powers the Underwriting tab's queue board in
 * UnderwritingClient.tsx.
 *
 * Groups:
 *   needs_underwriting  — no run OR latest run.status='error'
 *   in_progress         — latest run.status IN ('pending','parsing')
 *   ready_to_shop       — status='complete' AND readiness_score >= 60
 *   risk_flagged        — status='complete' AND (risk_flags non-empty OR score < 60)
 *
 * Preview mode: if the caller doesn't own the slug, returns empty groups
 * (200) rather than 403 so the UI's empty preview renders without error.
 *
 * Response: { groups: { needs_underwriting, in_progress, ready_to_shop, risk_flagged } }
 * Each entry: { application_id, business_name, contact_name, monthly_revenue,
 *               status_pill, readiness_score, run_id, risk_flag_count }
 *
 * Uses a single JOIN to avoid N+1 — one query fetches all applications
 * plus their most-recent underwriting row via a lateral subquery.
 *
 * Phase 7.3 SunBiz CRM (second-meeting 2026-05-25).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_GROUPS = {
  needs_underwriting: [],
  in_progress: [],
  ready_to_shop: [],
  risk_flagged: [],
};

type QueueEntry = {
  application_id: string;
  business_name: string | null;
  contact_name: string | null;
  monthly_revenue: number | null;
  status_pill: string | null;
  readiness_score: number | null;
  run_id: string | null;
  risk_flag_count: number;
};

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await ctx.params;
  const normalised = slug.toLowerCase();

  if (!(await manifestExists(normalised))) {
    return NextResponse.json({ ok: false, error: "unknown_tenant" }, { status: 404 });
  }

  // Preview-mode gate: return empty groups (not 403) if the caller doesn't
  // own this slug so the UI's empty preview state renders correctly.
  // resolveDataTenant returns null for cross-tenant callers and empire
  // operators browsing a non-owned slug — both get the same silent empty
  // groups response, matching the pattern in /manifest/[slug]/records/[entity].
  const dataTenantId = await resolveDataTenant(normalised, session.tenantId);
  if (!dataTenantId) {
    return NextResponse.json({ groups: EMPTY_GROUPS });
  }

  const db = getServiceSupabase();

  // One round-trip: join tenant_records (applications) with the latest
  // application_underwriting row via a Postgres DISTINCT ON sub-select.
  // Supabase JS client doesn't expose LATERAL, so we use the rpc escape
  // hatch — but the team hasn't shipped a generic-query RPC. Instead we
  // pull applications and their latest underwriting run in two queries
  // (applications list + one aggregated underwriting query), then merge
  // in JS. Two queries, O(1) round-trips, still avoids N+1.

  const appsResult = await db
    .from("tenant_records")
    .select("id, data, status")
    .eq("tenant_id", dataTenantId)
    .eq("entity_type", "application");

  if (appsResult.error) {
    return NextResponse.json(
      { ok: false, error: appsResult.error.message },
      { status: 500 },
    );
  }

  const apps = (appsResult.data ?? []) as Array<{
    id: string;
    status: string | null;
    data: Record<string, unknown>;
  }>;

  if (apps.length === 0) {
    return NextResponse.json({ groups: EMPTY_GROUPS });
  }

  const appIds = apps.map((a) => a.id);

  // Fetch ALL underwriting rows for these applications, then pick the
  // latest per application_id in JS (avoids DISTINCT ON / LATERAL).
  const uwResult = await db
    .from("application_underwriting")
    .select(
      "id, application_id, status, readiness_score, risk_flags, run_at",
    )
    .eq("tenant_id", dataTenantId)
    .in("application_id", appIds)
    .order("run_at", { ascending: false });

  if (uwResult.error) {
    return NextResponse.json(
      { ok: false, error: uwResult.error.message },
      { status: 500 },
    );
  }

  // Build a map: application_id → latest underwriting row.
  type UwRow = {
    id: string;
    application_id: string;
    status: string;
    readiness_score: number | null;
    risk_flags: unknown[];
    run_at: string;
  };
  const latestUw = new Map<string, UwRow>();
  for (const row of (uwResult.data ?? []) as UwRow[]) {
    if (!latestUw.has(row.application_id)) {
      latestUw.set(row.application_id, row);
    }
  }

  // Bucket applications.
  const groups: Record<keyof typeof EMPTY_GROUPS, QueueEntry[]> = {
    needs_underwriting: [],
    in_progress: [],
    ready_to_shop: [],
    risk_flagged: [],
  };

  for (const app of apps) {
    const d = app.data ?? {};
    const entry: QueueEntry = {
      application_id: app.id,
      business_name: typeof d.business_name === "string" ? d.business_name : null,
      contact_name: typeof d.contact_name === "string" ? d.contact_name : null,
      monthly_revenue: typeof d.monthly_revenue === "number" ? d.monthly_revenue : null,
      status_pill: app.status,
      readiness_score: null,
      run_id: null,
      risk_flag_count: 0,
    };

    const uw = latestUw.get(app.id);
    if (!uw || uw.status === "error") {
      groups.needs_underwriting.push(entry);
    } else if (uw.status === "pending" || uw.status === "parsing") {
      entry.run_id = uw.id;
      groups.in_progress.push(entry);
    } else if (uw.status === "complete") {
      const flags = Array.isArray(uw.risk_flags) ? uw.risk_flags : [];
      entry.run_id = uw.id;
      entry.readiness_score = uw.readiness_score;
      entry.risk_flag_count = flags.length;
      if ((uw.readiness_score ?? 0) >= 60 && flags.length === 0) {
        groups.ready_to_shop.push(entry);
      } else {
        groups.risk_flagged.push(entry);
      }
    } else {
      // Unknown status — treat as needs_underwriting so it surfaces.
      groups.needs_underwriting.push(entry);
    }
  }

  // Sort each bucket per spec.
  groups.needs_underwriting.sort(
    (a, b) => (b.monthly_revenue ?? 0) - (a.monthly_revenue ?? 0),
  );
  // in_progress: oldest first — we don't have started_at, run_at is proximate.
  // The UW row is already ordered DESC; oldest run_id will be later in the
  // map. Re-sort by run_at ascending via the latestUw map.
  groups.in_progress.sort((a, b) => {
    const ra = latestUw.get(a.application_id)?.run_at ?? "";
    const rb = latestUw.get(b.application_id)?.run_at ?? "";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  groups.ready_to_shop.sort(
    (a, b) => (b.readiness_score ?? 0) - (a.readiness_score ?? 0),
  );
  groups.risk_flagged.sort(
    (a, b) => (a.readiness_score ?? 0) - (b.readiness_score ?? 0),
  );

  return NextResponse.json({ groups });
}
