/**
 * POST /api/forms/view
 *
 * Public-facing view-tracking endpoint. The personalized form page POSTs
 * here on mount; we record a form_views row + transition the lead's
 * stage to `viewed_application` if it isn't already past that point.
 * Rate-limited at the DB level (one view per lead per hour) so a page
 * refresh doesn't re-fire the drip 50 times.
 *
 * Auth: same HMAC token from the URL. No session cookie.
 *
 * Body: { token: string }
 * Response: { ok, viewed_application_fired: boolean }
 *
 * The boolean tells the public form page whether the drip kicked off so
 * it can render an appropriate UX confirmation (rare — usually invisible).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getClientIp } from "@/lib/api-helpers";
import { verifyFormLink, type FormLinkPayload } from "@/lib/form-links";
import { rateLimit } from "@/lib/rate-limit";
import { updateRecord, RecordsError } from "@/lib/manifest/data";
import { LEAD_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Change #1 (Adon, lead status defs 2026-06-19): a bare form view no longer
// advances to viewed_application. Opening the FIRST application (initial-lead-
// capture) without completing it sets "Intent Inquiry"; completion sets
// "Viewed" (in /api/forms/submit). The old POST_VIEWED_STAGES guard is gone.

export async function POST(req: NextRequest) {
  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const sigResult = verifyFormLink(body.token);
  if (!sigResult.ok) {
    return NextResponse.json(
      { ok: false, error: `token_${sigResult.reason}` },
      { status: sigResult.reason === "server_misconfigured" ? 503 : 400 },
    );
  }
  const link: FormLinkPayload = sigResult.payload;

  // Per-token rate limit — 4 view-pings per minute is more than enough
  // for legitimate page refreshes; abusive bots would be capped at the
  // route layer well before the once-per-hour DB rule kicks in.
  const limit = rateLimit({
    key: `forms-view:${link.lead_id}:${link.form_id}`,
    capacity: 4,
    refillPerSec: 1 / 15,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }

  const db = getServiceSupabase();

  // Resolve the form + join tenant for the three-way cross-check.
  // Codex review 2026-05-15: the prior implementation skipped the
  // tenant.slug verification that /api/forms/submit and the public
  // form page both enforce. A token whose tenant slug has drifted
  // (e.g. tenant was renamed after the token was minted) could record
  // views and update stages under whichever tenant currently owns
  // the form row. Three-way bind matches the submit + page paths:
  //   1. HMAC verifies link.tenant + link.form_id + link.lead_id
  //   2. Form row's tenant.slug must equal link.tenant
  //   3. Form row's enabled must be true
  const formRow = await db
    .from("forms")
    .select("id, tenant_id, slug, enabled, tenant:tenants!inner(slug)")
    .eq("id", link.form_id)
    .maybeSingle();
  if (formRow.error || !formRow.data) {
    return NextResponse.json({ ok: false, error: "form_not_found" }, { status: 404 });
  }
  const form = formRow.data as {
    id: string;
    tenant_id: string;
    slug: string;
    enabled: boolean;
    tenant: { slug: string } | { slug: string }[] | null;
  };
  // PostgREST returns the joined relation as an object or array
  // depending on cardinality — normalize.
  const tenantRow = Array.isArray(form.tenant) ? form.tenant[0] : form.tenant;
  if (!tenantRow || tenantRow.slug !== link.tenant) {
    return NextResponse.json({ ok: false, error: "tenant_mismatch" }, { status: 400 });
  }
  if (!form.enabled) {
    return NextResponse.json({ ok: false, error: "form_disabled" }, { status: 400 });
  }

  // DB-level dedup: only record + fire the drip if no view from this lead
  // in the last hour. Cheap query because the form_views index is
  // (tenant_id, lead_id, viewed_at DESC).
  const recentCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentRow = await db
    .from("form_views")
    .select("id")
    .eq("tenant_id", form.tenant_id)
    .eq("lead_id", link.lead_id)
    .gte("viewed_at", recentCutoff)
    .limit(1)
    .maybeSingle();
  if (recentRow.data) {
    // Already counted this view in the last hour — record nothing,
    // return false for the dripped flag.
    return NextResponse.json({ ok: true, viewed_application_fired: false });
  }

  // Insert the form_views row first so we have an audit trail even if
  // the stage-transition fails downstream.
  const resolvedIp = getClientIp(req);
  const ipHeader = resolvedIp === "unknown" ? null : resolvedIp;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) || null;
  await db.from("form_views").insert({
    form_id: form.id,
    tenant_id: form.tenant_id,
    lead_id: link.lead_id,
    ip_address: ipHeader,
    user_agent: userAgent,
  });

  // Now the stage transition. Read the lead first — only patch if the
  // lead is at `sent_application` (the natural pre-viewed stage).
  // Earlier-stage leads (`cold` / `follow_up`) being viewed is anomalous
  // and we don't want to skip stages; later-stage leads have moved past
  // viewed_application already and shouldn't be rolled back.
  const leadRow = await db
    .from("tenant_records")
    .select("data")
    .eq("id", link.lead_id)
    .eq("tenant_id", form.tenant_id)
    .eq("entity_type", "lead")
    .maybeSingle();
  if (leadRow.error || !leadRow.data) {
    return NextResponse.json({ ok: true, viewed_application_fired: false });
  }
  const currentStage = ((leadRow.data as { data: Record<string, unknown> }).data?.stage ||
    "") as string;

  // Only the FIRST application (initial-lead-capture interest form) drives the
  // Intent-Inquiry status on open. Any other form's view is recorded (above)
  // but is not a stage trigger under the new model.
  if (form.slug !== "initial-lead-capture") {
    return NextResponse.json({ ok: true, viewed_application_fired: false, intent_inquiry_fired: false });
  }

  // Forward-only: set "Intent Inquiry" only when the lead hasn't entered a
  // known funnel stage yet — never regress a lead already further along.
  const knownLeadStages = new Set(LEAD_PIPELINE_STAGES.map((s) => s.key));
  if (currentStage && knownLeadStages.has(currentStage)) {
    return NextResponse.json({ ok: true, viewed_application_fired: false, intent_inquiry_fired: false });
  }

  try {
    await updateRecord({
      tenant_id: form.tenant_id,
      entity: "lead",
      id: link.lead_id,
      patch: { stage: "viewed_application" },
    });
  } catch (err) {
    const reason = err instanceof RecordsError ? err.code : "unknown";
    console.error("[forms.view.stage_transition]", { lead_id: link.lead_id, reason });
    return NextResponse.json({ ok: true, viewed_application_fired: false, intent_inquiry_fired: false });
  }

  return NextResponse.json({ ok: true, viewed_application_fired: false, intent_inquiry_fired: true });
}
