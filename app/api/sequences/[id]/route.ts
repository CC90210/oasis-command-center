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
import {
  validateInterchange,
  brandFromTriggerFilter,
  stageFromTriggerFilter,
  diffPins,
} from "@/lib/drips/template-interchange";
import { loadApprovedPoolOrThrow } from "@/lib/drips/template-pool-store";

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
  const prior = priorRes.data as { steps: unknown; name: string; trigger_filter?: unknown };

  // Every template pin this request changes, hoisted so the audit below records
  // what was actually written rather than what the client said it was doing.
  // `to: null` is an UNPIN — the step goes back to pool sampling, which is a
  // change to live copy and gets recorded like any other.
  let pinChanges: Array<{ index: number; from: string | null; to: string | null; role?: string }> = [];

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

    // Template pins are validated HERE, against the pool as it is right now,
    // before anything is written.
    //
    // WHAT IS CHECKED IS WHAT PERSISTS. Not the `interchange` field the client
    // sends — that is advisory, it names the actor for the audit, and a request
    // that omits it or disagrees with its own steps would sail straight past a
    // gate that trusted it. The check runs over `steps[i].template_id`, the
    // thing the executor will actually read.
    //
    // WHY IT MATTERS. The executor scopes the pool with
    // poolFor(brand, stage, role) before resolveCopy sees the pin, so a pin
    // outside that scope is not an error at send time — it is silence. The save
    // returns ok, the tab shows the chosen copy, and sampling keeps deciding
    // what merchants actually get. Refusing the write is the only outcome that
    // cannot lie.
    //
    // ONLY CHANGED PINS. A pin that was already there and has since gone
    // unreachable (its template retired) must not block an unrelated edit to
    // another step; the Drips tab flags that case on the step instead.
    //
    // UNPINNING IS A CHANGE TOO. Removing a pin hands the step back to pool
    // sampling, which changes what merchants receive just as much as adding
    // one. There is nothing to VALIDATE about it — sampling is always in
    // scope — but it must still be recorded, or an edit that silently altered
    // live copy leaves no trace.
    //
    // diffPins compares at sequence level, not index by index, because the
    // editor supports reordering: position is not identity, and an index-wise
    // diff would invent unpins every time a step moved.
    const pinDiff = diffPins(priorSteps, guarded.steps);
    pinChanges = pinDiff.map(({ index, from, to, role }) => ({ index, from, to, role }));

    // Only a NEW pin needs checking against the pool.
    const changedPins = pinDiff.filter((c): c is typeof c & { to: string } => Boolean(c.to));

    if (changedPins.length > 0) {
      // The filter being saved wins over the persisted one, so a swap made in
      // the same edit as a stage change is judged against the stage it will
      // actually run under.
      const filter = "trigger_filter" in patch ? patch.trigger_filter : prior.trigger_filter;
      let pool;
      try {
        // Fail closed, and say WHICH failure it was: an empty pool from a
        // broken read would otherwise be reported as "template not found",
        // sending an operator to fix a template that was never the problem.
        pool = await loadApprovedPoolOrThrow(db, tenantId);
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: "interchange_unverifiable",
            reason: `could not read the template pool, so the swap cannot be confirmed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          { status: 503 },
        );
      }
      for (const { index, from, to, role } of changedPins) {
        const verdict = validateInterchange(pool, {
          sequenceId: id,
          stepIndex: index,
          fromTemplateId: from,
          toTemplateId: to,
          actorUserId: session.authUserId ?? "",
          brand: brandFromTriggerFilter(filter),
          stage: stageFromTriggerFilter(filter),
          role,
        });
        if (!verdict.ok) {
          // The validator's own words, and which step. "Rejected" alone is not
          // something an operator can act on.
          return NextResponse.json(
            { ok: false, error: "invalid_interchange", step: index + 1, reason: verdict.reason },
            { status: 400 },
          );
        }
      }
    }
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
  // Driven by pinChanges — the pins that were actually persisted — not by the
  // client's `interchange` field. An audit built from request metadata records
  // what the caller SAID it did, which is the one thing not worth keeping: a
  // direct API swap would leave no trace at all, and that is exactly the swap
  // worth being able to reconstruct.
  for (const change of pinChanges) {
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
          step_index: change.index,
          from: change.from,
          to: change.to,
          // Present when the pin still points at the same template but the
          // step's role moved, which changes which templates may substitute
          // for it. Without this an unchanged from/to reads as a no-op record.
          role: change.role ?? null,
          actor: session.authUserId ?? null,
        }),
      })
      .then(
        () => undefined,
        (err: unknown) => {
          console.error("[sequences.interchange_audit.failed]", {
            sequence_id: id,
            step_index: change.index,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
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
