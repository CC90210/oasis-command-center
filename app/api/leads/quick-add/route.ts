/**
 * POST /api/leads/quick-add — rep quick-add of a lead directly at a pipeline
 * stage (default `sent_application`). For reps logging an application they sent
 * OUTSIDE the software (TextTorrent / email) so the merchant lands in the funnel
 * at "Sent Application". Manual for now; automated later once TT is integrated.
 *
 * Body: { business_name (required), phone?, email?, stage? }.
 *
 * Create-or-advance, deduped: if a lead already exists for this tenant (matched
 * by email/phone/business via findExistingLead) it is ADVANCED to the stage
 * (no duplicate); otherwise a new lead is created. createRecord AND updateRecord
 * both fire BRAVO_RECORD_STATUS_CHANGED, so the drip enroller auto-enrolls the
 * lead into the stage's sequence (a phone-less lead simply skips the SMS-only
 * step 0 as no_contact_method — chosen behavior 2026-07-20).
 *
 * Auth: any non-read-only tenant member (canWriteCrm) — the same role gate the
 * one-click set-stage action uses. Fail closed. Audited to lead_interactions.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { createRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { findExistingLead } from "@/lib/forms/agent-routing";
import { LEAD_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_STAGE = "sent_application";

// Local, matching the private import-service normalizers (email trim+lowercase,
// phone → digits, drop a leading US 1). findExistingLead normalizes internally
// for matching; we also store the normalized values for consistency.
function normEmail(s: unknown): string | null {
  const e = typeof s === "string" ? s.trim().toLowerCase() : "";
  return e || null;
}
function normPhone(s: unknown): string | null {
  const digits = typeof s === "string" ? s.replace(/\D+/g, "") : "";
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return d || null;
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't add leads." },
      { status: 403 },
    );
  }

  let body: { business_name?: unknown; phone?: unknown; email?: unknown; stage?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const businessName = typeof body.business_name === "string" ? body.business_name.trim() : "";
  if (!businessName) {
    return NextResponse.json({ ok: false, error: "business_name_required" }, { status: 400 });
  }
  const stage = typeof body.stage === "string" && body.stage.trim() ? body.stage.trim() : DEFAULT_STAGE;
  if (!LEAD_PIPELINE_STAGES.some((s) => s.key === stage)) {
    return NextResponse.json({ ok: false, error: "invalid_stage" }, { status: 400 });
  }

  const email = normEmail(body.email);
  const phone = normPhone(body.phone);
  // A lead with no way to reach it is useless (can't dedup, can't follow up, can't
  // drip). Require at least one contact — the modal enforces this too.
  if (!email && !phone) {
    return NextResponse.json({ ok: false, error: "contact_required", message: "Add a phone or email." }, { status: 400 });
  }
  const tenantId = sess.tenantId;

  let leadId: string;
  let existing = false;
  let advanced = false;
  let fromStage: string | null = null;
  try {
    // Create-or-advance, deduped on STRONG identity only (email/phone). We
    // deliberately DON'T match on business name here: two different merchants can
    // share a name, and merging them would advance the wrong file + lose the new
    // one's contact. A missed returning-merchant just yields a dup (harmless) vs a
    // false merge (data loss).
    const found = await findExistingLead(tenantId, { email, phone });
    if (found) {
      existing = true;
      leadId = found.id;
      fromStage = typeof found.data.stage === "string" ? found.data.stage : null;
      if (fromStage !== stage) {
        await updateRecord({ tenant_id: tenantId, entity: "lead", id: leadId, patch: { stage } });
        advanced = true;
      }
    } else {
      const created = await createRecord({
        tenant_id: tenantId,
        entity: "lead",
        data: {
          business_name: businessName,
          ...(phone ? { phone } : {}),
          ...(email ? { email } : {}),
          stage,
        },
      });
      leadId = created.id;
    }
  } catch (err) {
    const code = err instanceof RecordsError ? err.code : "unknown";
    return NextResponse.json({ ok: false, error: "write_failed", code }, { status: 500 });
  }

  // Best-effort audit — mirrors set-stage.
  try {
    const db = getServiceSupabase();
    const note = existing
      ? advanced
        ? `Manually added — existing lead moved ${fromStage || "—"} → ${stage}`
        : `Manually added — lead already at ${stage}`
      : `Manually added lead at ${stage}`;
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: leadId,
      type: "lead_added_manual",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_quick_add",
      subject: "Lead added manually",
      content: note,
      content_preview: note,
      metadata: {
        stage,
        from: fromStage,
        existing,
        advanced,
        business_name: businessName,
        has_phone: !!phone,
        has_email: !!email,
        changed_by: sess.userId,
      },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, id: leadId, stage, existing, advanced });
}
