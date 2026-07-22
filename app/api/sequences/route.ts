/**
 * /api/sequences — operator-facing CRUD for drip sequences (Phase 4.2).
 *
 * GET  → list this tenant's sequences (RLS-scoped via the authed user).
 * POST → create a new sequence. Body:
 *          { name, description?, trigger_event?,
 *            trigger_filter, steps, enabled?, one_per_lead? }
 *
 * Per-row update / delete live at /api/sequences/[id].
 *
 * The sequence_runner.py daemon on the operator's machine reads
 * directly from drip_sequences (service-role) and ignores these
 * routes; they're operator UX only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";
import { getSessionContext, canManageTeam } from "@/lib/team";
import { isMissingTableError, missingTablePayload } from "@/lib/api-helpers";
import { guardSequenceSteps } from "@/lib/drips/edit-guard";
import {
  parseDripSteps,
  parseDripTriggerFilter,
  DripDefinitionError,
} from "@/lib/drips/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .select(
      "id, name, description, trigger_event, trigger_filter, steps, enabled, one_per_lead, created_by, created_at, updated_at",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingTableError(error, "public.drip_sequences")) {
      return NextResponse.json(
        missingTablePayload({
          migration: "database/043_drip_sequences.sql",
          feature: "Drip Sequences",
        }),
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sequences: data || [] });
}

export async function POST(req: NextRequest) {
  // Admin-only: creating a drip sequence defines a campaign that fires real
  // SMS/email. Non-admin members can view (GET) but not create.
  const ctx = await getSessionContext();
  if (!ctx) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can create drip sequences." },
      { status: 403 },
    );
  }
  const tenantId = ctx.tenantId;
  const userId = ctx.authUserId;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  if (!name) {
    return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  }

  let steps, triggerFilter;
  try {
    steps = parseDripSteps(body.steps);
    triggerFilter = parseDripTriggerFilter(body.trigger_filter);
  } catch (err) {
    if (err instanceof DripDefinitionError) {
      return NextResponse.json(
        { ok: false, error: "invalid_definition", path: err.path, reason: err.reason },
        { status: 400 },
      );
    }
    throw err;
  }

  // Write-time compliance guard (2026-07-22): create previously skipped the
  // copy guard entirely, so scaffolded/imported sequences could persist
  // lender/broker copy unguarded until the first edit. Same shared guard as
  // PATCH; no prior baseline on create (nothing to preserve yet).
  const guarded = await guardSequenceSteps(tenantId, steps, null);
  if (!guarded.ok) {
    return NextResponse.json(
      { ok: false, error: guarded.error, step: guarded.step, message: guarded.message },
      { status: 400 },
    );
  }
  steps = guarded.steps;

  const triggerEvent = String(body.trigger_event || "BRAVO_RECORD_STATUS_CHANGED");

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .insert({
      tenant_id: tenantId,
      name: name.slice(0, 200),
      description: body.description ? String(body.description).slice(0, 1000) : null,
      trigger_event: triggerEvent,
      trigger_filter: triggerFilter,
      steps,
      enabled: body.enabled !== false,
      one_per_lead: body.one_per_lead !== false,
      created_by: userId,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sequence: data });
}
