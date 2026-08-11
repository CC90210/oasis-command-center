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
  type DripStep,
} from "@/lib/drips/types";
import { guardSequenceSteps } from "@/lib/drips/edit-guard";

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
  const db = getServiceSupabase();
  // Prior row: the token/STOP-preservation baseline for the copy guard AND
  // the snapshot that goes into version history when copy changes.
  const priorRes = await db
    .from("drip_sequences")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (priorRes.error) {
    return NextResponse.json({ ok: false, error: priorRes.error.message }, { status: 500 });
  }
  if (!priorRes.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const prior = priorRes.data as { steps: unknown; name: string };

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
    // Shared write-time guard (lib/drips/edit-guard): compliance denylist on
    // EVERY channel (SMS included), merge-token preservation, SMS STOP-line
    // preservation, dash strip. Fail-closed: nothing persists on a hit.
    let priorSteps: DripStep[] | null = null;
    try {
      priorSteps = parseDripSteps(prior.steps);
    } catch {
      priorSteps = null; // legacy malformed row — no preservation baseline
    }
    const guarded = await guardSequenceSteps(tenantId, steps, priorSteps, {
      allowTokenRemoval: body.allowTokenRemoval === true,
    });
    if (!guarded.ok) {
      return NextResponse.json(
        { ok: false, error: guarded.error, step: guarded.step, message: guarded.message, detail: guarded.detail },
        { status: 400 },
      );
    }
    patch.steps = guarded.steps;
  }
  if ("enabled" in body) patch.enabled = Boolean(body.enabled);
  if ("one_per_lead" in body) patch.one_per_lead = Boolean(body.one_per_lead);
  if ("email_class" in body) {
    const v = String(body.email_class || "");
    if (v !== "transactional" && v !== "commercial") {
      return NextResponse.json({ ok: false, error: "invalid_email_class" }, { status: 400 });
    }
    patch.email_class = v;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no_changes" }, { status: 400 });
  }

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

  // Version history: when the STEPS changed, snapshot the PRIOR copy so the
  // edit is reversible. Best-effort — history-write failure never fails the
  // save (the save already happened); it does surface in the response.
  let historySaved: boolean | undefined;
  if ("steps" in patch) {
    const hist = await db.from("drip_sequence_versions").insert({
      tenant_id: tenantId,
      sequence_id: id,
      name: prior.name,
      steps: prior.steps,
      edited_by: session.authUserId ?? null,
    });
    historySaved = !hist.error;
  }

  // A template interchange is a deliberate swap of what merchants receive, so
  // it gets its own attributable record rather than hiding inside a generic
  // "steps changed" version. The version snapshot says WHAT the copy was; this
  // says WHO swapped which template into which step, which is the question
  // asked after a merchant complains about wording.
  const interchange = (body as { interchange?: { step_index?: unknown; to_template_id?: unknown } }).interchange;
  if (interchange && "steps" in patch) {
    const stepIndex = Number(interchange.step_index);
    const toTemplateId = String(interchange.to_template_id ?? "");
    if (Number.isInteger(stepIndex) && stepIndex >= 0 && toTemplateId) {
      // Best-effort, exactly like the version write above: the save already
      // happened and failing the request now would misreport it as rejected.
      await db
        .from("agent_events")
        .insert({
          tenant_id: tenantId,
          source: "sequences",
          level: "info",
          event: "template_interchange",
          detail: JSON.stringify({
            action: "template_interchange",
            sequence_id: id,
            step_index: stepIndex,
            to: toTemplateId,
            actor: session.authUserId ?? null,
          }),
        })
        .then(
          () => undefined,
          (err: unknown) => {
            console.error("[sequences.interchange_audit.failed]", {
              sequence_id: id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
    }
  }

  return NextResponse.json({ ok: true, sequence: data, ...(historySaved === undefined ? {} : { historySaved }) });
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
