/**
 * /api/sequences/[id] — operator-facing per-sequence mutations (Phase 4.2).
 *
 * GET    → fetch one sequence (RLS-scoped).
 * PATCH  → update any subset of name / description / trigger_event /
 *          trigger_filter / steps / enabled / one_per_lead. Editing a
 *          live sequence affects FUTURE enrollments only; in-flight
 *          sequence_state rows continue with the snapshot they were
 *          enrolled under (the daemon reads context_snapshot, not the
 *          definition, when firing each step).
 * DELETE → hard-delete the sequence row. Cascades to sequence_state
 *          via the FK ON DELETE CASCADE — any in-flight enrollments
 *          die with it. The /sequences UI confirms before this fires.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";
import { getSessionContext, canManageTeam } from "@/lib/team";
import {
  parseDripSteps,
  parseDripTriggerFilter,
  DripDefinitionError,
} from "@/lib/drips/types";
import { sanitizeBlastMessage, stripDashes } from "@/lib/integrations/blast-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, sequence: data });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can edit drip sequences." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if ("name" in body) {
    const v = String(body.name || "").trim();
    if (!v) return NextResponse.json({ ok: false, error: "name_empty" }, { status: 400 });
    patch.name = v.slice(0, 200);
  }
  if ("description" in body) {
    patch.description = body.description ? String(body.description).slice(0, 1000) : null;
  }
  if ("trigger_event" in body) {
    patch.trigger_event = String(body.trigger_event || "BRAVO_RECORD_STATUS_CHANGED");
  }
  if ("trigger_filter" in body) {
    try {
      patch.trigger_filter = parseDripTriggerFilter(body.trigger_filter);
    } catch (err) {
      if (err instanceof DripDefinitionError) {
        return NextResponse.json(
          { ok: false, error: "invalid_trigger_filter", path: err.path, reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
  }
  if ("steps" in body) {
    let steps;
    try {
      steps = parseDripSteps(body.steps);
    } catch (err) {
      if (err instanceof DripDefinitionError) {
        return NextResponse.json(
          { ok: false, error: "invalid_steps", path: err.path, reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
    // Fail-closed positioning/lender guard on every email step being saved
    // (Adon 2026-07-20: template rotation must never let broker/lender copy
    // into a live drip). The runtime send path strips dashes at send time, but
    // gating here means a bad AI rewrite or library paste can't PERSIST — the
    // save is rejected with the offending phrase. SMS steps ride the send-time
    // blast guard; email copy is what the rotation UI mutates, so we gate it
    // on write. checkPositioning:true == the same rule the drip executor uses.
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.channel !== "email") continue;
      // Guard EVERY piece of email copy that can reach a merchant: base
      // subject/body AND the A/B variant pools (subject_variants/body_variants),
      // which the executor samples from at send time. One combined check == one
      // lender-name lookup; a hit in ANY field blocks the whole save (a bad
      // variant would otherwise persist unguarded and fire later — 2026-07-20).
      const parts = [
        s.subject || "",
        s.body,
        ...(s.subject_variants || []),
        ...(s.body_variants || []),
      ].filter(Boolean);
      const guard = await sanitizeBlastMessage(tenantId, parts.join("\n"), { checkPositioning: true });
      if (!guard.ok) {
        return NextResponse.json(
          { ok: false, error: "blocked_copy", step: i, reason: guard.reason, message: `Step ${i + 1}: ${guard.message}` },
          { status: 400 },
        );
      }
      steps[i] = {
        ...s,
        subject: s.subject ? stripDashes(s.subject) : s.subject,
        body: stripDashes(s.body),
        ...(s.subject_variants ? { subject_variants: s.subject_variants.map(stripDashes) } : {}),
        ...(s.body_variants ? { body_variants: s.body_variants.map(stripDashes) } : {}),
      };
    }
    patch.steps = steps;
  }
  if ("enabled" in body) patch.enabled = Boolean(body.enabled);
  if ("one_per_lead" in body) patch.one_per_lead = Boolean(body.one_per_lead);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no_changes" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("drip_sequences")
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select()
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sequence: data });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canManageTeam(session.teamRole, session.adminAccess)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only owners/admins can delete drip sequences." },
      { status: 403 },
    );
  }
  const tenantId = session.tenantId;
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  // count: "exact" so we can detect "matched zero rows" — that's the
  // signal for either (a) the id was already gone, or (b) the tenant
  // scope doesn't match. Both are "not found" from the operator's
  // perspective. Without this check, a no-op delete returns ok:true and
  // the UI optimistically removes a row that the DB still has.
  const { error, count } = await db
    .from("drip_sequences")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!count) {
    return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
