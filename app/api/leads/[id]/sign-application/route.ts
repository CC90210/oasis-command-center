/**
 * POST /api/leads/[id]/sign-application — put the logged-in REP's OWN
 * signature on this lead's application, at the application's existing
 * signature line. Adds a signature if there's none, replaces it if one
 * already exists.
 *
 * Single-signer, inline, immediate. This is NOT the multi-signer e-sign
 * envelope flow (components/esign/*, the public /sign/[token] pages) — that
 * flow belongs to a separate, unrelated project (Trytan/Triton Health) and
 * stays untouched. The standalone SunBiz "E-Sign" nav tab was removed in
 * favor of this inline per-lead button (2026-07-09, commit 263b1e6:
 * "SunBiz e-sign is being reworked into a per-lead/application inline SIGN
 * button (add/replace signature on the application doc), not a standalone
 * tab.").
 *
 * Mechanism mirrors the sibling `application-signature` route (the
 * autofill-crop signature flow) almost exactly — same RPC, same regenerate
 * call, same PNG validation. Two differences: (1) the caller only needs the
 * LEAD id — this route resolves the linked "application" tenant_records row
 * itself, so the Sign button doesn't need to separately know an
 * application_id; and (2) the signature is always the REP'S OWN, resolved
 * server-side from user_profiles — never client-supplied — so a rep can't
 * sign as someone else.
 *
 * `applicant_signature` / `signature_name` are plain JSONB fields on the
 * application record (tenant_records.data) — there is exactly ONE signature
 * slot per application, so patching that field always overwrites whatever
 * was there before (nothing → "add"; the merchant's own captured signature,
 * or a prior rep's → "replace"). Regenerating the PDF re-embeds whatever is
 * currently in that field at the SAME signature-line position every time
 * (lib/forms/application-pdf.ts ~L558-606, the single "AUTHORIZATION &
 * SIGNATURE" block) — so add-vs-replace needs no branching here.
 *
 * Body:  { signatureDataUri: "data:image/png;base64,…" }
 * Query: ?entity=application — pass when the drawer is open on an
 *   APPLICATION record directly (so [id] is an application id, not a lead
 *   id); the lead id used for logging is then resolved from the
 *   application's own data.lead_id. Default (no query param) treats [id] as
 *   a lead id and resolves ITS linked application record. Mirrors the exact
 *   `entity=` convention already used by /api/leads/[id]/detail and
 *   lib/lead-access.ts's getWritableLead / getAccessibleLeadTarget, so the
 *   ONE Sign button rendered in the shared LeadFileBody works from both the
 *   Leads and the Applications drawer.
 * Auth: any non-read_only CRM member (a "rep") in the tenant may sign ANY
 *   lead/application in their own tenant — getWritableLead, the same
 *   authorization tier as e-sign / PDFs / promote (lib/lead-access.ts's own
 *   docstring lists "e-sign" as a covered action).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access";
import { isReadOnlyRole } from "@/lib/role-gates";
import { getServiceSupabase } from "@/lib/supabase-server";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A PNG data-URI from the SignatureField canvas (<canvas>.toDataURL("image/png")).
const PNG_DATA_URI_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// Bound the payload so a giant base64 blob can't be used to exhaust the request.
// A drawn signature is small; 3 MB of base64 is generous headroom.
const MAX_DATA_URI_LEN = 3_000_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }

  const url = new URL(req.url);
  const entity: "lead" | "application" =
    url.searchParams.get("entity") === "application" ? "application" : "lead";

  // Role-based CRM-write gate on the record itself: any non-read_only member
  // may act on ANY lead/application in their tenant (LEAD_SCOPING_ENABLED
  // does not narrow this — matches the sibling application-signature route).
  const acc = await getWritableLead(
    { teamRole: sess.teamRole, userId: sess.userId, isOwner: sess.isTrueAdmin, adminAccess: sess.adminAccess },
    { tenantId: sess.tenantId, entity, id },
  );
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json(
          { ok: false, error: "forbidden_role", message: "Read-only members can't do this." },
          { status: 403 },
        )
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const record = acc.record;

  let body: { signatureDataUri?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const dataUri = typeof body.signatureDataUri === "string" ? body.signatureDataUri.trim() : "";
  if (!dataUri || dataUri.length > MAX_DATA_URI_LEN || !PNG_DATA_URI_RE.test(dataUri)) {
    return NextResponse.json({ ok: false, error: "invalid_signature_data_uri" }, { status: 400 });
  }
  // Prove it's actually a PNG: the regex above only checks the prefix + base64
  // alphabet. Arbitrary base64 would pass it, then fail embedPng at PDF-render
  // time and silently leave a blank signature line while this endpoint
  // reported success. Decode + verify the 8-byte PNG magic + a sane size bound.
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(dataUri.slice("data:image/png;base64,".length), "base64");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_signature_png" }, { status: 400 });
  }
  if (sigBytes.length < 67 || sigBytes.length > 2_000_000 || !sigBytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return NextResponse.json({ ok: false, error: "invalid_signature_png" }, { status: 400 });
  }

  const db = getServiceSupabase();

  // Resolve the application to sign + the lead id to log the audit row
  // against. Deliberately NOT lib/manifest/data.ts's listRecords() here: for
  // entity="application" that helper filters entity="application" rows to
  // `data->>promoted_at IS NOT NULL` (board-view semantics — an application
  // created by the form/upsert helper while the deal is still a lead has no
  // promoted_at yet). A rep must be able to sign as soon as the application
  // record exists, before "Transfer to Application" — so this is a raw,
  // unfiltered lookup, matching lib/forms/application-upsert.ts's own
  // (newest-first) resolution.
  let applicationId: string;
  let leadIdForLog: string;
  if (entity === "application") {
    applicationId = id;
    const linked = record.data.lead_id;
    leadIdForLog = typeof linked === "string" && UUID_RE.test(linked) ? linked : id;
  } else {
    leadIdForLog = id;
    const appLookup = await db
      .from("tenant_records")
      .select("id")
      .eq("tenant_id", sess.tenantId)
      .eq("entity_type", "application")
      .filter("data->>lead_id", "eq", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (appLookup.error) {
      return NextResponse.json(
        { ok: false, error: "application_lookup_failed", detail: appLookup.error.message },
        { status: 500 },
      );
    }
    const appRow = appLookup.data as { id: string } | null;
    if (!appRow) {
      return NextResponse.json({ ok: false, error: "no_application" }, { status: 404 });
    }
    applicationId = appRow.id;
  }

  // The rep's OWN name — resolved server-side, never client-supplied, so a
  // rep can never sign the document as someone else.
  const profileRes = await db
    .from("user_profiles")
    .select("display_name, full_name")
    .eq("auth_user_id", sess.userId)
    .eq("tenant_id", sess.tenantId)
    .maybeSingle();
  const profile = profileRes.data as { display_name: string | null; full_name: string | null } | null;
  const repName = (profile?.display_name || profile?.full_name || sess.email || "").trim().slice(0, 120);

  // Add-or-replace: applicant_signature/signature_name are plain fields — a
  // patch always overwrites whatever was in that one slot before (none, the
  // merchant's own captured signature, or a prior rep's), so there's no
  // separate branch for "add" vs "replace".
  const patch: Record<string, unknown> = { applicant_signature: dataUri };
  if (repName) patch.signature_name = repName;
  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: applicationId,
    p_tenant_id: sess.tenantId,
    p_patch: patch,
  });
  if (upd.error) {
    return NextResponse.json({ ok: false, error: "save_failed", detail: upd.error.message }, { status: 500 });
  }

  // Regenerate the filed PDF so the rep's signature lands on the existing
  // signature line (generateApplicationPdf embeds whatever is currently in
  // applicant_signature). replace:true soft-deletes the prior generated copy
  // first. Never throws into callers.
  const regen = await generateApplicationDocumentFromRecord({
    tenantId: sess.tenantId,
    applicationId,
    replace: true,
  });

  // Audit — fixed subject/content strings + ids only; no PII, no signature
  // bytes ever logged.
  try {
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: leadIdForLog,
      type: "signature_set",
      channel: "system",
      direction: "outbound",
      agent_source: "rep_signature",
      subject: "Rep signed the application",
      content: "A rep signed the application on the merchant's behalf, at the application's signature line.",
      content_preview: "Rep signature added to application.",
      metadata: {
        application_id: applicationId,
        signed_name: repName || null,
        changed_by: sess.userId,
      },
    });
  } catch {
    /* best-effort audit */
  }

  if (!regen.ok) {
    // The signature WAS written, but the PDF didn't regenerate — and the
    // generator soft-deletes the prior PDF before uploading the replacement,
    // so reporting success here would leave the rep believing a signed PDF
    // exists when it may be missing/unsigned. Surface it so they retry.
    return NextResponse.json(
      { ok: false, error: "pdf_regen_failed", signature_saved: true, detail: regen.error },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, documentId: regen.documentId, application_id: applicationId });
}
