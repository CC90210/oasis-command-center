/**
 * POST /api/leads/[id]/set-field — set a SINGLE data field on a lead, so a rep
 * can fill in information a lead is missing (EIN, business address, owner home
 * address, entity type, …) without leaving the lead drawer.
 *
 * WHY: the lead drawer is read-only and the only full editor renders just the
 * few manifest-declared fields, so there was no easy way to add a field the
 * record didn't already carry — even though tenant_records.data is schemaless
 * and updateRecord merges arbitrary keys. This closes that UI gap with a
 * concurrency-safe single-key write, mirroring the /assign + /score pattern.
 *
 * When the lead is already linked to an application (data.application_id), an
 * application-relevant field is MIRRORED onto that application record too, so a
 * manually-added field reaches the generated application PDF / lender
 * submission, not just the lead card.
 *
 * Body: { key: string, value: string | number | boolean | null }
 * Auth: shared CRM writers on legacy records; on OASIS, only admins or an
 * authorized sales operator who owns/collaborates on the lead.
 * Writes via the atomic patch_tenant_record_data RPC (no read-modify-write race).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { APPLICATION_FIELD_KEYS } from "@/lib/forms/application-upsert";
import {
  OASIS_WEBSITE_SALES_PROGRAM,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import {
  ownsOasisSalesRecord,
  rejectedOasisGenericPatchKeys,
  roleMayOperateOasisSalesLead,
} from "@/lib/oasis-sales-pipeline-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Control / pipeline fields that carry their own semantics + dedicated routes.
// Never settable through this generic field editor — writing them here could
// corrupt board membership, ownership, or the lead↔application link.
const PROTECTED_KEYS = new Set<string>([
  "id",
  "tenant_id",
  "entity_type",
  "created_at",
  "updated_at",
  "lead_id",
  "application_id",
  "assigned_to",
  "collaborators",
  "transferred_at",
  "promoted_at",
  "status",
  "stage",
  "created_via",
  "applicant_signature",
]);

// snake_case, must start with a letter, reasonable length. Keeps keys sane and
// blocks path-ish / operator-ish junk from landing in the JSON blob.
const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const APP_FIELD_SET = new Set<string>(APPLICATION_FIELD_KEYS as readonly string[]);
const MAX_VALUE_LEN = 2000;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Shared CRM writers may continue. OASIS sales titles reach the record gate
  // below, where role + ownership are both required; every other role fails now.
  if (!canWriteCrm(sess.teamRole) && !roleMayOperateOasisSalesLead(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't edit lead fields." },
      { status: 403 },
    );
  }
  const tenantId = sess.tenantId;
  const { id: recordId } = await ctx.params;
  if (!recordId || !UUID_RE.test(recordId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: { key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim().toLowerCase() : "";
  if (!KEY_RE.test(key)) {
    return NextResponse.json(
      { ok: false, error: "invalid_key", message: "Field name must be lowercase letters, numbers and underscores." },
      { status: 400 },
    );
  }
  // Accept string | number | boolean | null (null clears). Trim + bound strings.
  const rawVal = body.value;
  let value: string | number | boolean | null;
  if (rawVal === null || rawVal === undefined) {
    value = null;
  } else if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
    value = rawVal;
  } else if (typeof rawVal === "boolean") {
    value = rawVal;
  } else if (typeof rawVal === "string") {
    const trimmed = rawVal.trim();
    if (trimmed.length > MAX_VALUE_LEN) {
      return NextResponse.json({ ok: false, error: "value_too_long" }, { status: 400 });
    }
    value = trimmed.length ? trimmed : null;
  } else {
    return NextResponse.json({ ok: false, error: "invalid_value" }, { status: 400 });
  }

  const db = getServiceSupabase();

  // Existence + entity gate (patch_tenant_record_data is tenant-scoped but not
  // entity-scoped). The drawer opens for both leads and applications, so accept
  // either. Pull data so we can find a linked application to mirror to.
  const existing = await db
    .from("tenant_records")
    .select("id, entity_type, data")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application"])
    .eq("id", recordId)
    .maybeSingle();
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }
  const rec = existing.data as { entity_type: string; data?: Record<string, unknown> };
  const recEntity = rec.entity_type;
  const recData = rec.data || {};

  const tenantSlug = await resolveOwnedSlug(tenantId);
  if (!tenantSlug) {
    return NextResponse.json({ ok: false, error: "tenant_scope_unresolved" }, { status: 500 });
  }
  const isOasisSalesLead =
    recEntity === "lead" &&
    (recData.sales_program === OASIS_WEBSITE_SALES_PROGRAM ||
      isWebsiteSalesTenantSlug(tenantSlug));
  if (isOasisSalesLead) {
    const ownedByActor = ownsOasisSalesRecord(
      { id: recordId, data: recData },
      sess.userId,
    );
    if (
      !sess.isAdmin &&
      (!roleMayOperateOasisSalesLead(sess.teamRole) || !ownedByActor)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "forbidden_role",
          message: "You can only edit OASIS leads assigned or shared with you.",
        },
        { status: 403 },
      );
    }

    const protectedKeys = rejectedOasisGenericPatchKeys({ [key]: value });
    if (PROTECTED_KEYS.has(key) && !protectedKeys.includes(key)) {
      protectedKeys.push(key);
    }
    if (protectedKeys.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "use_website_sales_workflow",
          fields: protectedKeys,
        },
        { status: 409 },
      );
    }
  } else {
    if (PROTECTED_KEYS.has(key)) {
      return NextResponse.json(
        { ok: false, error: "protected_key", message: "That field is managed by the system and can't be edited here." },
        { status: 400 },
      );
    }
    if (!canWriteCrm(sess.teamRole)) {
      return NextResponse.json(
        { ok: false, error: "forbidden_role", message: "Your role can't edit this record." },
        { status: 403 },
      );
    }
  }

  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: recordId,
    p_tenant_id: tenantId,
    p_patch: { [key]: value },
  });
  if (upd.error) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: upd.error.message },
      { status: 500 },
    );
  }

  // Mirror application-relevant fields onto the linked application so the value
  // reaches the generated PDF / lender submission (not just the lead card). Only
  // when editing a LEAD that links to an application — editing the application
  // itself already writes the application record directly.
  let mirroredToApplication = false;
  const appId = recEntity === "lead" &&
    typeof recData.application_id === "string" && UUID_RE.test(recData.application_id)
    ? recData.application_id
    : null;
  if (appId && APP_FIELD_SET.has(key)) {
    // Confirm the application belongs to this tenant before writing to it.
    const appRow = await db
      .from("tenant_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "application")
      .eq("id", appId)
      .maybeSingle();
    if (appRow.data) {
      const appUpd = await db.rpc("patch_tenant_record_data", {
        p_id: appId,
        p_tenant_id: tenantId,
        p_patch: { [key]: value },
      });
      mirroredToApplication = !appUpd.error;
    }
  }

  // Audit — best-effort; a logging failure never fails the edit. PII values are
  // NOT written into the note (only the key name).
  try {
    const note = value === null ? `Cleared field "${key}".` : `Set field "${key}".`;
    await db.from("lead_interactions").insert({
      tenant_id: tenantId,
      lead_id: recordId,
      type: "lead_field_edited",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_set_field",
      subject: "Lead field edited",
      content: note,
      content_preview: note,
      metadata: { key, changed_by: sess.userId, mirrored_to_application: mirroredToApplication },
    });
  } catch {
    /* best-effort audit */
  }

  return NextResponse.json({ ok: true, key, value, mirrored_to_application: mirroredToApplication });
}
