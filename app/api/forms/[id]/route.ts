/**
 * /api/forms/[id] — operator-facing per-form mutations (Phase 3.2).
 *
 * GET    → fetch one form (RLS-scoped).
 * PATCH  → update name / description / branding / steps / step_outcomes /
 *          on_complete_stage / enabled / redirect_url. Slug is NOT
 *          editable (URLs depend on it); operators rename via delete +
 *          create if they truly need a different slug.
 * DELETE → soft-delete by setting enabled=false. Hard-delete via the
 *          DELETE method drops the row + cascades to form_submissions
 *          (rare; only used during cleanup). A workspace's support desk
 *          intake form is refused with 409 support_desk_form; the list's
 *          on/off toggle pauses it instead (lib/delivery/desks.ts).
 *
 * WHO (MKT-02, 2026-10-02): the workspace is the session's (formsSession,
 * lib/forms/access.ts), and every read and write carries its tenant_id, so
 * another workspace's form id is a 404. PATCH and DELETE need canEditForms:
 * a member who may not edit gets 403 and the form is untouched.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { formsSession } from "@/lib/forms/access";
import { deleteFormWithOfferPage, offerPagesDb } from "@/lib/offer-pages/store";
import {
  parseFormSteps,
  parseFormBranding,
  parseStepOutcomes,
  FormDefinitionError,
} from "@/lib/forms/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await formsSession({ edit: false });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("forms")
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
  return NextResponse.json({ ok: true, form: data });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Build the patch only from keys explicitly present in the body — we
  // don't want to clobber unset columns with undefined.
  const patch: Record<string, unknown> = {};
  if ("name" in body) {
    const v = String(body.name || "").trim();
    if (!v) return NextResponse.json({ ok: false, error: "name_empty" }, { status: 400 });
    patch.name = v.slice(0, 200);
  }
  if ("description" in body) {
    patch.description = body.description ? String(body.description).slice(0, 1000) : null;
  }
  if ("branding" in body) {
    try {
      patch.branding = parseFormBranding(body.branding);
    } catch (err) {
      if (err instanceof FormDefinitionError) {
        return NextResponse.json(
          { ok: false, error: "invalid_branding", path: err.path, reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
  }
  if ("steps" in body) {
    try {
      patch.steps = parseFormSteps(body.steps);
    } catch (err) {
      if (err instanceof FormDefinitionError) {
        return NextResponse.json(
          { ok: false, error: "invalid_steps", path: err.path, reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
  }
  if ("step_outcomes" in body) {
    try {
      patch.step_outcomes = parseStepOutcomes(body.step_outcomes);
    } catch (err) {
      if (err instanceof FormDefinitionError) {
        return NextResponse.json(
          { ok: false, error: "invalid_step_outcomes", path: err.path, reason: err.reason },
          { status: 400 },
        );
      }
      throw err;
    }
  }
  if ("on_complete_stage" in body) {
    patch.on_complete_stage = body.on_complete_stage
      ? String(body.on_complete_stage)
      : null;
  }
  if ("enabled" in body) {
    patch.enabled = Boolean(body.enabled);
  }
  if ("redirect_url" in body) {
    patch.redirect_url = body.redirect_url
      ? String(body.redirect_url).slice(0, 2000)
      : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "no_changes" }, { status: 400 });
  }

  const db = getServiceSupabase();
  // maybeSingle: no row means the id is not this workspace's form (or is
  // gone), which is a 404, not the driver's "no rows" error as a 500.
  const { data, error } = await db
    .from("forms")
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select()
    .maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, form: data });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const { id } = await ctx.params;

  const db = getServiceSupabase();
  // A workspace's support desk intake (lib/delivery/desks.ts) is not deleted
  // here: the desk would keep its registration with no form behind it, and
  // its public URL would stop filing tickets (Codex, PR #473). Switching the
  // form off pauses the desk instead. A database without support_desks
  // (migration bravo__188 not applied) has no desk forms to protect.
  const desk = await db.from("support_desks").select("form_id").eq("tenant_id", tenantId).eq("form_id", id).maybeSingle();
  if (desk.error && !/no such table: support_desks/i.test(desk.error.message)) {
    return NextResponse.json({ ok: false, error: desk.error.message }, { status: 500 });
  }
  if (desk.data) {
    return NextResponse.json(
      {
        ok: false,
        error: "support_desk_form",
        message: "This form is your support desk's intake, so it can't be deleted. To stop taking requests, switch the form off instead.",
      },
      { status: 409 },
    );
  }
  // OFFER PAGES (bravo__203). On the Turso data plane the form and its offer
  // page row are deleted in ONE batch, so no orphaned page outlives its form
  // and nothing depends on SQLite enforcing the foreign key. Before the
  // migration lands the form goes alone, exactly as below.
  const offers = offerPagesDb();
  if (offers) {
    let removed: number;
    try {
      removed = await deleteFormWithOfferPage(offers, tenantId, id);
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    if (!removed) {
      return NextResponse.json({ ok: false, error: "not_found_or_forbidden" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }
  // count: "exact" so a no-op delete (id already gone, or tenant
  // mismatch) surfaces as 404 instead of a silent ok:true that the UI
  // would interpret as success. See the parallel /api/sequences/[id]
  // handler for the same rationale.
  const { error, count } = await db
    .from("forms")
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
