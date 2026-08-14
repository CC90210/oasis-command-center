/**
 * PATCH /api/applications/[id]/edit — bulk-edit an application's data fields
 * from the global "Edit Application" form, then regenerate the filed
 * application PDF from the updated payload.
 *
 * WHY a dedicated route (2026-07-22): the generic manifest records PATCH is
 * ADMIN-only, but editing an application is a rep capability — same class as
 * set-field (canWriteCrm). set-field itself is single-key (one RPC per field);
 * a form save needs one atomic multi-key write + ONE PDF regeneration.
 *
 * Body: { patch: { <data key>: string | number | boolean | null, ... } }
 *   - keys must be application-relevant: APPLICATION_FIELD_KEYS plus the
 *     small extra set the PDF renders (industry, product/service, partner
 *     block). PROTECTED control keys are rejected outright.
 *   - null clears a field. Strings trimmed + length-bounded.
 * Response: { ok, record, pdf: { regenerated, error? } }
 *
 * Auth: any non-read_only tenant member (canWriteCrm), fail closed, identical
 * 403 before existence check (no enumeration oracle) — mirrors set-field.
 * Write: atomic patch_tenant_record_data RPC (no read-modify-write race).
 * PDF: generateApplicationDocumentFromRecord({ replace: true }) — same
 * replace-and-refile semantics as the manifest PATCH + the on-demand button.
 * Awaited but soft-fail: a failed render never un-saves the data; the caller
 * gets pdf.regenerated=false + the error to surface a retry affordance.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { APPLICATION_FIELD_KEYS } from "@/lib/forms/application-upsert";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";
import { isAcceptableCaptureAddress } from "@/lib/address/us-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE_LEN = 2000;
const MAX_KEYS = 60;

// System/pipeline DATA keys — never writable through the form (same doctrine
// as set-field's PROTECTED_KEYS; corrupting these breaks boards/links/
// signatures). NOTE: data.entity_type (the business's legal structure — llc,
// s_corp, …) is NOT protected here: it's a legitimate application field in
// APPLICATION_FIELD_KEYS, and the patch RPC only merges into the `data` jsonb —
// it can never touch the tenant_records.entity_type COLUMN.
const PROTECTED_KEYS = new Set<string>([
  "id",
  "tenant_id",
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

// The editable surface IS the canonical whitelist (single source of truth —
// the same set the form intake + extraction pipeline persists, which is
// exactly what the PDF renders from).
const EDITABLE = new Set<string>(APPLICATION_FIELD_KEYS as readonly string[]);

/**
 * Legacy display-alias sync. Drawer readers (OwnerTab, OwnerAssignedRow)
 * check OLD alias keys FIRST (`ein || tax_id`, `state || business_state`,
 * `legal_name || business_name`, `ownership_pct`, `owner_ssn_last4 ||
 * ssn_last4`, `contact_name || owner_name`, `phone`) — records carrying
 * stale alias copies would keep displaying the pre-edit value after a
 * canonical-key edit. Two sync classes, applied to the SAME atomic patch:
 *
 * OVERWRITE — pure display copies with no editor of their own: always
 * follow the canonical key (null propagates).
 * FILL-mirrors — first-class reader keys the intake pipeline duplicates
 * (FIELD_ALIASES: owner_full_name → contact_name/owner_name, owner_cell →
 * phone, business_legal_name → business_name): follow the canonical key
 * ONLY when the client didn't explicitly set the target in the same save —
 * an operator who deliberately sets a different contact person wins.
 */
const ALIAS_OVERWRITE: Record<string, ReadonlyArray<string>> = {
  tax_id_ein: ["ein", "tax_id"],
  business_state: ["state"],
  business_legal_name: ["legal_name"],
  owner_ownership_pct: ["ownership_pct"],
};
const ALIAS_FILL: Record<string, ReadonlyArray<string>> = {
  owner_full_name: ["contact_name", "owner_name"],
  owner_cell: ["phone"],
  business_legal_name: ["business_name"],
};

function applyAliasSync(patch: Record<string, string | number | boolean | null>): void {
  const clientKeys = new Set(Object.keys(patch));
  for (const [canonical, aliases] of Object.entries(ALIAS_OVERWRITE)) {
    if (clientKeys.has(canonical)) {
      for (const alias of aliases) patch[alias] = patch[canonical];
    }
  }
  for (const [canonical, aliases] of Object.entries(ALIAS_FILL)) {
    if (clientKeys.has(canonical)) {
      for (const alias of aliases) {
        if (!clientKeys.has(alias)) patch[alias] = patch[canonical];
      }
    }
  }
  // SSN aliases derive the last-4 (never store the full SSN under a last4 key).
  if (clientKeys.has("owner_ssn")) {
    const v = patch.owner_ssn;
    const digits = typeof v === "string" ? v.replace(/\D+/g, "") : "";
    const last4 = digits.length >= 4 ? digits.slice(-4) : null;
    patch.owner_ssn_last4 = last4;
    patch.ssn_last4 = last4;
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't edit applications." },
      { status: 403 },
    );
  }
  const tenantId = sess.tenantId;
  const { id: applicationId } = await ctx.params;
  if (!applicationId || !UUID_RE.test(applicationId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: { patch?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
    return NextResponse.json({ ok: false, error: "patch_required" }, { status: 400 });
  }
  const rawPatch = body.patch as Record<string, unknown>;
  const keys = Object.keys(rawPatch);
  if (keys.length === 0) {
    return NextResponse.json({ ok: false, error: "empty_patch" }, { status: 400 });
  }
  if (keys.length > MAX_KEYS) {
    return NextResponse.json({ ok: false, error: "too_many_keys" }, { status: 400 });
  }

  // Validate every key + value BEFORE writing anything — all-or-nothing.
  const patch: Record<string, string | number | boolean | null> = {};
  for (const rawKey of keys) {
    const key = rawKey.trim().toLowerCase();
    if (PROTECTED_KEYS.has(key) || !EDITABLE.has(key)) {
      return NextResponse.json(
        { ok: false, error: "invalid_key", message: `"${key}" is not an editable application field.` },
        { status: 400 },
      );
    }
    const rawVal = rawPatch[rawKey];
    if (rawVal === null || rawVal === undefined) {
      patch[key] = null;
    } else if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
      patch[key] = rawVal;
    } else if (typeof rawVal === "boolean") {
      patch[key] = rawVal;
    } else if (typeof rawVal === "string") {
      const trimmed = rawVal.trim();
      if (trimmed.length > MAX_VALUE_LEN) {
        return NextResponse.json(
          { ok: false, error: "value_too_long", message: `"${key}" exceeds ${MAX_VALUE_LEN} chars.` },
          { status: 400 },
        );
      }
      patch[key] = trimmed.length ? trimmed : null;
    } else {
      return NextResponse.json(
        { ok: false, error: "invalid_value", message: `"${key}" must be a string, number, boolean, or null.` },
        { status: 400 },
      );
    }
  }

  // Keep legacy display aliases in lockstep with the canonical keys (server-
  // added — the client whitelist above intentionally rejects alias keys).
  applyAliasSync(patch);

  const db = getServiceSupabase();

  // Existence + entity gate: this route edits APPLICATIONS only.
  const existing = await db
    .from("tenant_records")
    // `data` is read so the address gate below can see the STORED business_state
    // when the patch doesn't carry one.
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ ok: false, error: "lookup_failed" }, { status: 500 });
  }
  if (!existing.data) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }

  // ADDRESS COMPLETENESS — the server-side boundary for operator edits.
  //
  // ApplicationEditForm validates this too, but a client check is a courtesy,
  // not a guarantee: this route accepts a raw PATCH, so a rep hitting the API
  // directly could save a bare street line and regenerate the lender-facing PDF
  // from it, defeating the invariant the merchant form enforces. (Codex P1.)
  //
  // Only keys PRESENT IN THE PATCH are checked. ~1,000 existing applications
  // carry a partial address, and re-validating stored values would block an
  // operator from editing an unrelated field on a record they did not break.
  {
    const storedData = (existing.data as { data?: Record<string, unknown> }).data ?? {};
    // Fall back to the STORED state only when the patch does not touch it at all.
    // Testing the value's type instead of the key's PRESENCE was a bypass: a
    // patch carrying `business_state: null` alongside a stateless address
    // validated against the old state, passed, and then cleared it in the same
    // atomic write — saving precisely the incomplete address this gate exists
    // to stop. An explicit clear must count as "no state". (Codex P1, round 2.)
    const patchTouchesState = Object.prototype.hasOwnProperty.call(patch, "business_state");
    const effectiveState = patchTouchesState ? patch.business_state : storedData.business_state;
    for (const key of ["business_address", "owner_home_address", "partner_home_address"]) {
      const value = patch[key];
      // null clears the field, which stays legal — an owner may genuinely remove
      // an optional partner's address.
      if (typeof value !== "string" || !value) continue;
      const gate = isAcceptableCaptureAddress(
        value,
        key === "business_address" ? effectiveState : undefined,
      );
      if (!gate.ok) {
        return NextResponse.json(
          { ok: false, error: "incomplete_address", field: key, message: gate.message },
          { status: 400 },
        );
      }
    }
  }

  // Atomic multi-key merge — same RPC set-field uses, one call for the batch.
  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: applicationId,
    p_tenant_id: tenantId,
    p_patch: patch,
  });
  if (upd.error) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: upd.error.message },
      { status: 500 },
    );
  }

  // Re-read the merged record (the RPC returns void on some deployments —
  // fetch canonically rather than trusting a client-side merge).
  const fresh = await db
    .from("tenant_records")
    .select("id, tenant_id, entity_type, data, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("id", applicationId)
    .maybeSingle();

  // Regenerate the filed application PDF from the updated payload. Replace
  // semantics: the generator soft-deletes the prior generated copy first.
  // The generator never throws — it reports { ok, documentId?, error? }.
  const gen = await generateApplicationDocumentFromRecord({
    tenantId,
    applicationId,
    replace: true,
  });
  const pdf = gen.ok
    ? { regenerated: true as const, document_id: gen.documentId ?? null }
    : { regenerated: false as const, error: (gen.error || "pdf_regeneration_failed").slice(0, 300) };
  if (!gen.ok) {
    console.error("[applications.edit] pdf regeneration failed", {
      application_id: applicationId,
      error: pdf.error,
    });
  }

  return NextResponse.json({ ok: true, record: fresh.data ?? null, pdf });
}
