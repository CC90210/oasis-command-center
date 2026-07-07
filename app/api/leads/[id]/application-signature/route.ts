/**
 * POST /api/leads/[id]/application-signature — set a merchant signature on the
 * lead's SunBiz application and regenerate the PDF with it embedded.
 *
 * This is the server half of "extract the signature from a dropped application
 * and put it on the new SunBiz document" (CC 2026-06-25). The cropping happens
 * in the browser (the only place with image tooling); this route takes the
 * resulting PNG data-URI, writes it to the application's `applicant_signature`
 * field — the SAME field the signature-pad form path uses — and regenerates the
 * application PDF, which already renders that field (lib/forms/application-pdf.ts
 * embedPng + drawImage). So the placement is fully reused.
 *
 * Body: { application_id: uuid, signature_data_uri: "data:image/png;base64,…",
 *         signature_name?: string }
 * Auth: any non-read_only CRM member in the tenant (getWritableLead); read-only denied.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getWritableLead } from "@/lib/lead-access"; // 2026-07-07: canWriteCrm/getWritableLead conversion
import { isReadOnlyRole } from "@/lib/role-gates";
import { getServiceSupabase } from "@/lib/supabase-server";
import { generateApplicationDocumentFromRecord } from "@/lib/forms/application-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A PNG data-URI from a browser <canvas>.toDataURL("image/png"). We accept PNG
// only (what the canvas crop produces + what the PDF embedder expects).
const PNG_DATA_URI_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// Bound the payload so a giant base64 blob can't be used to exhaust the request.
// A cropped signature is small; 3 MB of base64 is generous headroom.
const MAX_DATA_URI_LEN = 3_000_000;

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
  // Role-based CRM-write gate on the LEAD: any non-read_only member may act on
  // ANY lead in their tenant (LEAD_SCOPING_ENABLED does not narrow this). The
  // application is the lead's; gating the lead is the authorization boundary.
  const acc = await getWritableLead(
    { teamRole: sess.teamRole },
    { tenantId: sess.tenantId, entity: "lead", id },
  );
  if (!acc.ok) {
    return acc.reason === "role_denied"
      ? NextResponse.json({ ok: false, error: "forbidden_role", message: "Read-only members can't do this." }, { status: 403 })
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const lead = acc.record;

  let body: { application_id?: unknown; signature_data_uri?: unknown; signature_name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const applicationId = typeof body.application_id === "string" ? body.application_id.trim() : "";
  if (!UUID_RE.test(applicationId)) {
    return NextResponse.json({ ok: false, error: "invalid_application_id" }, { status: 400 });
  }
  const dataUri = typeof body.signature_data_uri === "string" ? body.signature_data_uri.trim() : "";
  if (!dataUri || dataUri.length > MAX_DATA_URI_LEN || !PNG_DATA_URI_RE.test(dataUri)) {
    return NextResponse.json({ ok: false, error: "invalid_signature_data_uri" }, { status: 400 });
  }
  // Prove it's actually a PNG (Codex 2026-06-25): the regex only checks the prefix
  // + base64 alphabet. Arbitrary base64 would store, then fail embedPng at PDF time
  // and silently draw a blank line while the API reported success. Decode + verify
  // the 8-byte PNG magic + a sane decoded-size bound.
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(dataUri.slice("data:image/png;base64,".length), "base64");
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_signature_png" }, { status: 400 });
  }
  if (sigBytes.length < 67 || sigBytes.length > 2_000_000 || !sigBytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return NextResponse.json({ ok: false, error: "invalid_signature_png" }, { status: 400 });
  }
  const signatureName =
    typeof body.signature_name === "string" ? body.signature_name.trim().slice(0, 120) : "";

  const db = getServiceSupabase();

  // Confirm the application belongs to this tenant AND is linked to this lead
  // (so a forged application_id can't write a signature onto another deal). The
  // lead may carry application_id, or the application carries lead_id — accept
  // either link, matching how the drawer resolves the pair.
  const appRes = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  const appRow = appRes.data as { id: string; data?: Record<string, unknown> } | null;
  if (!appRow) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }
  const appData = appRow.data || {};
  // Link invariant (Codex 2026-06-25): if the application carries its OWN lead_id
  // it MUST be THIS lead — a stale/corrupt lead.application_id can't override it.
  // Only a leadless (legacy/backfilled) application falls back to the lead-side
  // link, so a mismatched pair can never write a signature onto the wrong deal.
  const appLeadId =
    typeof appData.lead_id === "string" && UUID_RE.test(appData.lead_id) ? appData.lead_id : null;
  const linkOk = appLeadId
    ? appLeadId === id
    : typeof lead.data.application_id === "string" && lead.data.application_id === applicationId;
  if (!linkOk) {
    return NextResponse.json({ ok: false, error: "application_not_linked_to_lead" }, { status: 409 });
  }

  // Write the signature onto the application via the data-patch RPC (bypasses the
  // form-field whitelist, like the bulk routes do — applicant_signature is a
  // system field, not an operator-typed form field). signature_name feeds the
  // printed name beside the signature in the PDF.
  const patch: Record<string, unknown> = { applicant_signature: dataUri };
  if (signatureName) patch.signature_name = signatureName;
  const upd = await db.rpc("patch_tenant_record_data", {
    p_id: applicationId,
    p_tenant_id: sess.tenantId,
    p_patch: patch,
  });
  if (upd.error) {
    return NextResponse.json({ ok: false, error: "save_failed", detail: upd.error.message }, { status: 500 });
  }

  // Regenerate the PDF so the embedded signature lands on the filed document.
  // generateApplicationDocumentFromRecord never throws into callers.
  const regen = await generateApplicationDocumentFromRecord({
    tenantId: sess.tenantId,
    applicationId,
    replace: true,
  });

  // Audit.
  try {
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: id,
      type: "signature_set",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_autofill_signature",
      subject: "Signature added to application",
      content: "Merchant signature captured from the dropped application and embedded in the SunBiz PDF.",
      content_preview: "Signature captured from dropped application.",
      metadata: { application_id: applicationId, signed_name: signatureName || null, source: "autofill_crop", changed_by: sess.userId },
    });
  } catch {
    /* best-effort audit */
  }

  if (!regen.ok) {
    // The signature WAS written, but the PDF didn't regenerate — and the generator
    // soft-deletes the prior PDF before uploading the replacement, so reporting
    // success here would leave the operator believing a signed PDF exists when it
    // may be missing/unsigned. Surface it so they regenerate from the drawer.
    // (Codex 2026-06-25.)
    return NextResponse.json(
      { ok: false, error: "pdf_regen_failed", signature_saved: true, detail: regen.error },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, application_id: applicationId, pdf_regenerated: true });
}
