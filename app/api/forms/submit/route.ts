/**
 * POST /api/forms/submit
 *
 * Public-facing submission endpoint for a personalized form link.
 * Authenticated via HMAC bearer token in the request body (not a session
 * cookie) so prospects can submit without an OASIS account.
 *
 * Flow:
 *   1. Verify the HMAC token via lib/form-links.ts.
 *   2. Look up the form to confirm it's still enabled.
 *   3. Insert a form_submissions row (one per step completion).
 *   4. If form.step_outcomes maps this step_index to a lead.stage value,
 *      transition the lead via updateRecord. The Phase 2 publisher fires
 *      BRAVO_RECORD_STATUS_CHANGED automatically, which the Phase 4 drip
 *      engine consumes.
 *
 * Body:
 *   {
 *     token: string,         // the HMAC-signed lead_token from the URL
 *     step_index: number,    // 0-based index into form.steps
 *     payload: {...},        // field-name -> value map
 *     file_attachments?: [...]
 *   }
 *
 * Response: { ok, submission_id, next_step?, lead_stage? }
 *
 * Rate-limit: 30 submissions per minute per token (lead-bound). Hand-
 * rolled in-memory bucket so a runaway client can't flood the dashboard.
 * Tracks by token rather than IP because forms are personalized links —
 * one IP could legitimately submit forms for multiple leads.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getClientIp } from "@/lib/api-helpers";
import { verifyFormLink, signFormLink, type FormLinkPayload } from "@/lib/form-links";
import {
  parseFormSteps,
  type FormStep,
  FormDefinitionError,
} from "@/lib/forms/types";
import { rateLimit } from "@/lib/rate-limit";
import { createRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { uploadLeadDocument } from "@/lib/lead-documents";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { maybeQueueResumeEmail } from "@/lib/forms/maybe-queue-resume";
import { maybeSendNextStepsEmail } from "@/lib/forms/next-steps-email";
import { upsertApplicationFromFormStep } from "@/lib/forms/application-upsert";
import { resolveRepAssignment, mintFullApplicationLink, findExistingLead } from "@/lib/forms/agent-routing";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom for the post-response handoff-email send (Next `after`): the bridge
// send_email round-trip can take up to ~20s. The prospect's response returns
// immediately regardless; this only bounds the background `after` callback.
export const maxDuration = 30;

type SubmitBody = {
  token?: string;
  step_index?: number;
  payload?: Record<string, unknown>;
  file_attachments?: Array<{
    field_name: string;
    storage_path: string;
    mime_type: string;
    size_bytes: number;
  }>;
  // Anonymous-form mode (shareable-link, no per-lead HMAC): on the first
  // submit the client sends anonymous_init {tenant_slug, form_slug} and
  // no token. The server creates a fresh lead, signs a token tied to it,
  // and returns it for the rest of the multi-step funnel.
  anonymous_init?: {
    tenant_slug?: string;
    form_slug?: string;
    // ?rep=<jordan|alex|ezra> from the per-agent interest link — resolved to
    // assigned_to so the lead lands under that agent.
    rep?: string;
  };
};

// The public client embeds files as `inline_base64` inside payload[field].
// This shape unwraps them so the server can move bytes to Supabase Storage.
type InlineFile = {
  inline_base64: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

function isInlineFile(v: unknown): v is InlineFile {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.inline_base64 === "string" &&
    typeof obj.filename === "string" &&
    typeof obj.mime_type === "string" &&
    typeof obj.size_bytes === "number"
  );
}


export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // Two auth shapes:
  //   1. Personalized link (Solara's mint): body.token is an HMAC.
  //   2. Anonymous share link: body.anonymous_init = {tenant_slug, form_slug}
  //      with no token. The server creates a fresh lead, signs a token,
  //      and returns it so subsequent steps in the same session re-use it.
  let link: FormLinkPayload;
  let mintedTokenForResponse: string | null = null;
  if (body.token) {
    const sigResult = verifyFormLink(body.token);
    if (!sigResult.ok) {
      return NextResponse.json(
        { ok: false, error: `token_${sigResult.reason}` },
        { status: sigResult.reason === "server_misconfigured" ? 503 : 400 },
      );
    }
    link = sigResult.payload;
  } else if (body.anonymous_init?.tenant_slug && body.anonymous_init?.form_slug) {
    // Anonymous_init is ONLY valid on step 0 — without this guard an
    // attacker could POST anonymous_init with step_index=N (final
    // step) and an empty payload, instantly creating a lead and
    // bumping it to on_complete_stage. Lock the entry point to step 0
    // and rely on the minted_token + per-step sequential check below
    // for the rest of the funnel. (Codex pass 4, 2026-05-18.)
    if (Number(body.step_index) !== 0) {
      return NextResponse.json(
        { ok: false, error: "anonymous_init_requires_step_0" },
        { status: 400 },
      );
    }
    // Pre-create rate limit on the anonymous_init path. The token-bucket
    // BELOW keys on lead_id, which is freshly minted here — so without
    // this gate every anonymous request would land in its own bucket and
    // a bot could spam-create leads unbounded. Key the limiter on
    // (ip, tenant_slug, form_slug) so legitimate humans aren't blocked
    // by someone else hammering the same form. 10 inits/minute per
    // (ip, form) is roughly one human filling the form every 6 seconds,
    // well above retry-after-typo but far below scripted abuse.
    const resolved = getClientIp(req);
    const ip = resolved === "unknown" ? "no-ip" : resolved;
    const tenantSlug = body.anonymous_init.tenant_slug.toLowerCase();
    const formSlug = body.anonymous_init.form_slug.toLowerCase();
    const initLimit = rateLimit({
      key: `forms-anon-init:${ip}:${tenantSlug}:${formSlug}`,
      capacity: 10,
      refillPerSec: 10 / 60,
    });
    if (!initLimit.allowed) {
      return NextResponse.json(
        { ok: false, error: "rate_limited", retry_in_sec: initLimit.resetIn },
        { status: 429 },
      );
    }
    const anonResult = await initAnonymousLead({
      tenantSlug,
      formSlug,
      payload: body.payload || {},
      ip,
      rep: body.anonymous_init.rep,
      origin: req.nextUrl.origin,
    });
    if (!anonResult.ok) {
      return NextResponse.json(
        { ok: false, error: anonResult.error },
        { status: anonResult.status },
      );
    }
    link = anonResult.link;
    mintedTokenForResponse = anonResult.token;
  } else {
    return NextResponse.json(
      { ok: false, error: "no_auth_provided" },
      { status: 400 },
    );
  }

  // Per-token rate limit. 30/min is roughly 1 submission every 2s, enough
  // for legitimate multi-step funnels (basic -> app -> upload) but well
  // below abusive-bot territory.
  const limit = rateLimit({
    key: `forms-submit:${link.lead_id}:${link.form_id}`,
    capacity: 30,
    refillPerSec: 0.5,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }

  const stepIndex = Number(body.step_index);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return NextResponse.json(
      { ok: false, error: "invalid_step_index" },
      { status: 400 },
    );
  }

  const payload =
    body.payload && typeof body.payload === "object" ? body.payload : {};
  // body.file_attachments is intentionally ignored after Codex pass 2 —
  // anything the client says it uploaded must be re-derived from
  // server-side uploadedDocs further down. See the comment at
  // resolvedAttachments for the reasoning.

  // Inline files arrive base64-encoded inside payload. Pull them out so we
  // can upload to Supabase Storage and stop persisting the bytes in jsonb
  // (form_submissions.payload would otherwise grow unbounded). The mutated
  // payload retains a reference to the storage_path so operators can still
  // see what was uploaded against each field.
  const inlineFiles: Array<{ fieldName: string; file: InlineFile }> = [];
  for (const [fieldName, value] of Object.entries(payload)) {
    if (isInlineFile(value)) {
      inlineFiles.push({ fieldName, file: value });
    }
  }

  // Look up the form to confirm it's still enabled + step_index is in
  // range. Tenant scoping comes from the verified token's tenant slug;
  // we double-check the form's tenant_id row matches that slug to defeat
  // tenant-id forgery via a leaked token.
  const db = getServiceSupabase();
  const formRow = await db
    .from("forms")
    .select(
      "id, tenant_id, slug, steps, on_complete_stage, step_outcomes, enabled, redirect_url, tenant:tenants!inner(slug)",
    )
    .eq("id", link.form_id)
    .maybeSingle();
  if (formRow.error || !formRow.data) {
    return NextResponse.json({ ok: false, error: "form_not_found" }, { status: 404 });
  }
  const form = formRow.data as {
    id: string;
    tenant_id: string;
    slug: string;
    steps: unknown;
    on_complete_stage: string | null;
    step_outcomes: Record<string, string> | null;
    enabled: boolean;
    redirect_url: string | null;
    tenant: { slug: string } | { slug: string }[] | null;
  };
  if (!form.enabled) {
    return NextResponse.json({ ok: false, error: "form_disabled" }, { status: 400 });
  }
  const tenantRow = Array.isArray(form.tenant) ? form.tenant[0] : form.tenant;
  if (!tenantRow || tenantRow.slug !== link.tenant) {
    return NextResponse.json({ ok: false, error: "tenant_mismatch" }, { status: 400 });
  }

  // Parse the steps to validate step_index range. parseFormSteps throws
  // on malformed data — if a DB row is somehow corrupt we 500 cleanly.
  let steps: FormStep[];
  try {
    steps = parseFormSteps(form.steps);
  } catch (err) {
    if (err instanceof FormDefinitionError) {
      return NextResponse.json(
        { ok: false, error: "form_definition_corrupt", path: err.path, reason: err.reason },
        { status: 500 },
      );
    }
    throw err;
  }
  if (stepIndex >= steps.length) {
    return NextResponse.json(
      { ok: false, error: "step_index_out_of_range", max: steps.length - 1 },
      { status: 400 },
    );
  }

  // Sequential-progress + required-field enforcement (Codex pass 4,
  // 2026-05-18). Without these checks an attacker with a valid token
  // (stolen or anonymous-init'd) could POST step_index=N (final) with
  // an empty payload and trigger on_complete_stage immediately,
  // bumping the lead to 'submitted' without any actual data.
  //
  // 1. Step N requires that submissions exist for steps 0..N-1 of the
  //    same (form_id, lead_id). Step 0 is exempt.
  // 2. Required fields on the SUBMITTED step must be present in the
  //    payload (string fields non-empty; file_upload fields either in
  //    inlineFiles or referenced as already-uploaded storage_path).
  if (stepIndex > 0) {
    const priorQ = await db
      .from("form_submissions")
      .select("step_index")
      .eq("form_id", form.id)
      .eq("lead_id", link.lead_id);
    const completedSteps = new Set(
      (priorQ.data || []).map((r) => Number((r as { step_index: number }).step_index)),
    );
    for (let i = 0; i < stepIndex; i++) {
      if (!completedSteps.has(i)) {
        return NextResponse.json(
          { ok: false, error: "prior_step_incomplete", missing_step: i },
          { status: 400 },
        );
      }
    }
  }
  const currentStep = steps[stepIndex];
  const inlineFileNames = new Set(inlineFiles.map((f) => f.fieldName));
  for (const field of currentStep.fields) {
    if (!field.required) continue;
    const v = payload[field.name];
    if (field.type === "file_upload") {
      // Either an inline file in THIS request OR a previously-uploaded
      // storage_path reference would satisfy the field.
      const hasInline = inlineFileNames.has(field.name);
      const hasStoragePath =
        v && typeof v === "object" && typeof (v as { storage_path?: unknown }).storage_path === "string";
      if (!hasInline && !hasStoragePath) {
        return NextResponse.json(
          { ok: false, error: "missing_required_file", field: field.name },
          { status: 400 },
        );
      }
    } else {
      const present =
        (typeof v === "string" && v.trim().length > 0) ||
        (typeof v === "number" && !Number.isNaN(v)) ||
        (Array.isArray(v) && v.length > 0) ||
        (typeof v === "boolean");
      if (!present) {
        return NextResponse.json(
          { ok: false, error: "missing_required_field", field: field.name },
          { status: 400 },
        );
      }
    }
  }

  // Insert the submission row. service-role write — RLS doesn't see this
  // path; HMAC token + tenant_id match is the auth boundary.
  const resolvedIp = getClientIp(req);
  const ipHeader = resolvedIp === "unknown" ? null : resolvedIp;
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) || null;

  // Move inline files to Supabase Storage. The bucket + RLS policies live
  // in migration 055. Each file lands under <tenant_id>/<lead_id>/<filename>
  // — the tenant-prefix anchors the read RLS policy without an extra join.
  //
  // Errors here don't abort the whole submission: a stage-transition can
  // still go through with missing docs, and the operator sees the gap on
  // the lead detail page. We log to stage_warning style so the UI can
  // surface the partial-success state.
  const uploadedDocs: Array<{
    field_name: string;
    storage_path: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    doc_type: string;
  }> = [];
  const uploadWarnings: Array<{ field_name: string; reason: string }> = [];

  // Schema-driven file validation. Without this an attacker could embed
  // arbitrary {inline_base64, ...} blobs against any payload key (even
  // ones the form doesn't declare as file_upload) and we'd happily push
  // bytes to Storage with attacker-controlled MIME types. Enforce on
  // the server: (a) the field must exist on THIS step, (b) it must be
  // type=file_upload, (c) the file's mime_type must be in the field's
  // accept[] list, (d) decoded length must agree with the claimed
  // size, (e) total decoded bytes per request cap so a base64-bomb can
  // never knock the runtime over.
  const currentStepFields = new Map(steps[stepIndex].fields.map((f) => [f.name, f]));
  const PER_FILE_DECODED_CAP_BYTES = 15 * 1024 * 1024;
  const PER_REQUEST_DECODED_CAP_BYTES = 60 * 1024 * 1024;
  const MAX_FILES_PER_STEP = 10;
  let totalDecodedBytes = 0;
  if (inlineFiles.length > MAX_FILES_PER_STEP) {
    return NextResponse.json(
      { ok: false, error: "too_many_files", max: MAX_FILES_PER_STEP },
      { status: 400 },
    );
  }
  for (const { fieldName, file } of inlineFiles) {
    const fieldDef = currentStepFields.get(fieldName);
    if (!fieldDef || fieldDef.type !== "file_upload") {
      // Drop silently from inlineFiles; clear the payload entry so the
      // form_submissions row doesn't keep the attacker bytes either.
      uploadWarnings.push({
        field_name: fieldName,
        reason: "field_not_file_upload",
      });
      delete payload[fieldName];
      continue;
    }
    // MIME allowlist from the form schema. When the operator left
    // accept empty we fall back to a conservative inert-image / PDF
    // set — never allow application/* freeform.
    const allowedMime = (fieldDef.accept && fieldDef.accept.length > 0)
      ? fieldDef.accept
      : ["application/pdf", "image/png", "image/jpeg", "image/webp"];
    const mimeAllowed = allowedMime.some((rule) =>
      rule.endsWith("/*")
        ? file.mime_type.startsWith(rule.slice(0, -1))
        : file.mime_type === rule
    );
    if (!mimeAllowed) {
      uploadWarnings.push({
        field_name: fieldName,
        reason: `mime_not_allowed: ${file.mime_type}`,
      });
      delete payload[fieldName];
      continue;
    }
    // Decoded-length check. Computing Buffer length once here means we
    // pay the base64-decode cost regardless, but it bounds memory: a
    // 60MB request bomb still gets rejected before storage.
    let bytes: Buffer;
    try {
      bytes = Buffer.from(file.inline_base64, "base64");
    } catch {
      uploadWarnings.push({ field_name: fieldName, reason: "base64_invalid" });
      delete payload[fieldName];
      continue;
    }
    if (bytes.length > PER_FILE_DECODED_CAP_BYTES) {
      uploadWarnings.push({
        field_name: fieldName,
        reason: `file_too_large: ${bytes.length}`,
      });
      delete payload[fieldName];
      continue;
    }
    totalDecodedBytes += bytes.length;
    if (totalDecodedBytes > PER_REQUEST_DECODED_CAP_BYTES) {
      return NextResponse.json(
        { ok: false, error: "request_payload_too_large" },
        { status: 413 },
      );
    }
    try {
      // Use the field name as doc_type so it lines up with the
      // classifier enum in migration 049. uploadLeadDocument owns
      // storage path shape + sanitization + metadata insert + cleanup,
      // shared with the operator-side drawer upload at
      // /api/leads/[id]/documents.
      const docType = fieldName.replace(/[^a-z0-9_]/gi, "_").toLowerCase()
        || "unclassified";
      const result = await uploadLeadDocument({
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        filename: file.filename,
        mimeType: file.mime_type,
        bytes,
        sizeBytes: file.size_bytes,
        docType,
        uploadedBy: "form_intake",
        source: "form_intake",
        extraMetadata: {
          form_id: form.id,
          field_name: fieldName,
          step_index: stepIndex,
        },
      });
      if (!result.ok) {
        uploadWarnings.push({ field_name: fieldName, reason: result.error });
        continue;
      }
      // Strip the bytes from the payload now that they're persisted —
      // form_submissions.payload should not carry the file contents.
      payload[fieldName] = {
        filename: file.filename,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        storage_path: result.document.storage_path,
      };
      uploadedDocs.push({
        field_name: fieldName,
        storage_path: result.document.storage_path,
        filename: result.document.filename,
        mime_type: result.document.mime_type,
        size_bytes: result.document.size_bytes,
        doc_type: result.document.doc_type,
      });
    } catch (err) {
      uploadWarnings.push({
        field_name: fieldName,
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  // After all uploads for this step, evaluate stage progression once.
  // The engine checks "all required SunBiz docs present?" against the
  // canonical doc-type set; partial uploads stay in missing_info,
  // complete uploads advance to hot_lead.
  if (uploadedDocs.length > 0) {
    await dispatchLeadStageEvent({
      type: "doc_uploaded",
      tenantId: form.tenant_id,
      leadId: link.lead_id,
      docType: uploadedDocs[uploadedDocs.length - 1].doc_type,
    });
  }

  // form_submissions.file_attachments is derived SOLELY from
  // uploadedDocs — the server-side record of what landed in Storage.
  // Codex flagged that the previous map kept any client-supplied
  // attachments[] entry without a matched inline upload, which let a
  // crafted POST persist arbitrary storage_path values (including
  // foreign-tenant paths) — and downstream /api/applications/.../
  // underwrite would later forward those paths to the underwriter.
  // Discarding the request-body attachments entirely closes that.
  const resolvedAttachments = uploadedDocs.map((d) => ({
    field_name: d.field_name,
    storage_path: d.storage_path,
    filename: d.filename,
    mime_type: d.mime_type,
    size_bytes: d.size_bytes,
  }));

  const insertRes = await db
    .from("form_submissions")
    .insert({
      form_id: form.id,
      tenant_id: form.tenant_id,
      lead_id: link.lead_id,
      step_index: stepIndex,
      payload,
      file_attachments: resolvedAttachments,
      ip_address: ipHeader,
      user_agent: userAgent,
    })
    .select("id")
    .single();
  if (insertRes.error) {
    return NextResponse.json(
      { ok: false, error: insertRes.error.message },
      { status: 500 },
    );
  }
  const submissionId = (insertRes.data as { id: string }).id;

  // Stage transition — if step_outcomes has a target for this step,
  // patch the lead via updateRecord. Phase 2's BRAVO_RECORD_STATUS_CHANGED
  // publisher fires automatically; the Phase 4 drip engine consumes it.
  // The final step also honors on_complete_stage as a fallback.
  let appliedStage: string | null = null;
  const stepOutcomes = form.step_outcomes || {};
  const isLastStep = stepIndex === steps.length - 1;
  const targetStage =
    stepOutcomes[String(stepIndex)] ||
    (isLastStep && form.on_complete_stage) ||
    null;

  // Round 3 R3-10: stage-transition failure used to swallow the error
  // and return ok:true, hiding from the operator that the drip never
  // fired. Now we capture the reason + surface it in the response so
  // the public form page can flag a partial success and the operator
  // sees in their /feed event tape that the lead landed but the
  // pipeline didn't advance.
  let stageWarning: { reason: string; target_stage: string } | null = null;
  if (targetStage) {
    try {
      await updateRecord({
        tenant_id: form.tenant_id,
        entity: "lead",
        id: link.lead_id,
        patch: { stage: targetStage },
      });
      appliedStage = targetStage;
    } catch (err) {
      const reason = err instanceof RecordsError ? err.code : "unknown";
      console.error("[forms.submit.stage_transition]", {
        lead_id: link.lead_id,
        target_stage: targetStage,
        reason,
      });
      stageWarning = { reason, target_stage: targetStage };
    }
  }

  // 2026-06-11 SOP §4 closeout — bridge form payload to application
  // record. Adon MCA SOP §4 match-fitness scorer reads business_state +
  // industry off tenant_records.data on the application row. Before this
  // hook, form-collected fields lived only in form_submissions.payload
  // and never reached the application — so SOP §4 high-risk blocks were
  // dormant on every form-originated deal. Now: each step's payload
  // upserts into the application record (creates one when none exists,
  // merges into the existing one when found). Best-effort: failure here
  // never aborts the form submission — the form_submissions row stays
  // the audit trail.
  try {
    const appUpsert = await upsertApplicationFromFormStep({
      tenantId: form.tenant_id,
      leadId: link.lead_id,
      formId: form.id,
      stepIndex,
      payload,
    });
    if ("created" in appUpsert) {
      console.log("[forms.submit.application_upsert]", {
        lead_id: link.lead_id,
        step: stepIndex,
        action: appUpsert.created ? "created" : "updated",
        keys: appUpsert.updated_keys,
      });
    }
  } catch (err) {
    console.error("[forms.submit.application_upsert.failed]", {
      lead_id: link.lead_id,
      step: stepIndex,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Surface owner KYC onto the lead so the operator's Owner tab populates for
  // form-originated deals (it reads flat owner_* keys off the lead record).
  // Raw merge-write, best-effort — never aborts the submission. Only the SSN
  // last-4 lands on the lead; the full value stays on form_submissions.payload.
  try {
    const ownerFields = mapOwnerFields(payload);
    if (Object.keys(ownerFields).length > 0) {
      const cur = await db
        .from("tenant_records")
        .select("data")
        .eq("id", link.lead_id)
        .eq("tenant_id", form.tenant_id)
        .maybeSingle();
      const curData =
        (cur.data as { data?: Record<string, unknown> } | null)?.data || {};
      await db
        .from("tenant_records")
        .update({ data: { ...curData, ...ownerFields } })
        .eq("id", link.lead_id)
        .eq("tenant_id", form.tenant_id);
    }
  } catch (err) {
    console.error("[forms.submit.owner_map.failed]", {
      lead_id: link.lead_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Post-step-0 follow-up email. Two paths:
  //   - Interest/entry form (initial-lead-capture): send the HANDOFF email
  //     with the next two steps (full application + bank statements) via the
  //     proven bridge send_email path (the resume queue is never drained for
  //     SunBiz — see next-steps-email.ts). This is the automation that fires
  //     the moment a prospect submits their info.
  //   - Any other multi-step form: the legacy resume-link queue (resume where
  //     you left off). Left intact for non-interest forms.
  // Both are fire-and-forget + soft-fail: the response never waits on or is
  // aborted by the email side.
  if (stepIndex === 0 && form.slug === "initial-lead-capture") {
    // Run the handoff send AFTER the response is returned (Next 15 `after`) so
    // a slow/offline bridge can never delay or time out the prospect's
    // submission. The helper is fully soft-fail. (Codex audit 2026-06-17
    // [medium]: awaited bridge send blocked the public response.) Capture the
    // origin now — req must not be touched inside the post-response callback.
    const origin = req.nextUrl.origin;
    after(() =>
      maybeSendNextStepsEmail({
        db,
        form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
        link: { tenant: link.tenant, lead_id: link.lead_id },
        payload,
        origin,
      }),
    );
  } else {
    await maybeQueueResumeEmail({
      db,
      step_index: stepIndex,
      form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
      link: { tenant: link.tenant, lead_id: link.lead_id, form_id: link.form_id },
      payload,
    });
  }

  return NextResponse.json({
    ok: true,
    submission_id: submissionId,
    next_step: isLastStep ? null : stepIndex + 1,
    lead_stage: appliedStage,
    redirect_url: isLastStep ? form.redirect_url : null,
    // Non-null when the prospect's submission landed but the lead's
    // stage didn't advance — drip didn't fire, operator needs to look
    // (typical causes: lead row was deleted between view + submit;
    // entity_type mismatch from a manifest edit mid-flight).
    stage_warning: stageWarning,
    // Per-file outcome: how many uploads landed in storage, which
    // failed. The public client doesn't show this to the prospect (it
    // would just confuse them) but the operator-facing /forms/[id]/
    // detail surface can.
    uploads: {
      attempted: inlineFiles.length,
      succeeded: uploadedDocs.length,
      warnings: uploadWarnings,
    },
    // Anonymous-share flow only: returned on the first step so the
    // client can carry the freshly-signed token through subsequent
    // steps. Null on every personalized (Solara-minted) submit.
    minted_token: mintedTokenForResponse,
  });
}

/**
 * Anonymous-share intake: validate the (tenant_slug, form_slug) pair,
 * create a fresh lead seeded with whatever name/email/phone we can pull
 * out of the first-step payload, sign a token for it. The signed token
 * becomes the auth boundary for the rest of the submission flow.
 */
async function initAnonymousLead(input: {
  tenantSlug: string;
  formSlug: string;
  payload: Record<string, unknown>;
  ip: string | null;
  /** ?rep=<agent> from a per-agent interest link → resolved to assigned_to. */
  rep?: string;
  /** Request origin, for minting the absolute full-application link. */
  origin: string;
}): Promise<
  | { ok: true; link: FormLinkPayload; token: string }
  | { ok: false; error: string; status: number }
> {
  const db = getServiceSupabase();
  const resolved = await resolvePublicForm(db, input.tenantSlug, input.formSlug);
  if (!resolved.ok) {
    return { ok: false, error: "not_found", status: 404 };
  }
  const tenantSlug = resolved.tenant_slug;
  const form = resolved.form;

  // Seed the lead with whatever common contact fields the operator
  // already collected on this step. Falls back gracefully when the
  // form's field names don't match — the operator can still see the
  // raw payload in the form_submissions row.
  const pick = (k: string) =>
    typeof input.payload[k] === "string" ? (input.payload[k] as string) : undefined;

  // Merchant-entered contact fields — seed a new lead OR merge into an existing
  // one (smart matching below). Email lowercased so dedup matches reliably.
  const contactFields: Record<string, unknown> = {};
  const name = pick("contact_name") || pick("name") || pick("full_name");
  if (name) contactFields.contact_name = name;
  const business = pick("business_name") || pick("company");
  if (business) contactFields.business_name = business;
  const emailRaw = pick("email");
  const email = emailRaw ? emailRaw.trim().toLowerCase() : undefined;
  if (email) contactFields.email = email;
  const phone = pick("phone");
  if (phone) contactFields.phone = phone;
  const monthlyRev = pick("monthly_revenue");
  if (monthlyRev) contactFields.monthly_revenue = monthlyRev;

  // Per-agent routing: resolve ?rep → the agent's user_profiles.auth_user_id.
  const repAssign = await resolveRepAssignment(form.tenant_id, input.rep);

  // SMART MATCHING (CC 2026-06-16): a returning merchant who opens a fresh form
  // link + re-enters their details must NOT spawn a duplicate lead. Match an
  // existing lead by email/phone and route the new info into that SAME file
  // (uploads attach to lead_id, so they land on the existing file too).
  const existing = await findExistingLead(form.tenant_id, { email, phone, business });

  let lead: { id: string; data: Record<string, unknown> };
  if (existing) {
    // Merge the new contact info; PRESERVE the existing assignment + stage +
    // application_url — a re-submission shouldn't steal the deal from the
    // original agent or reset pipeline progress. Adopt a rep only if the
    // existing lead was never assigned.
    const merged: Record<string, unknown> = { ...existing.data, ...contactFields };
    if (existing.data.stage) merged.stage = existing.data.stage;
    if (existing.data.assigned_to) {
      merged.assigned_to = existing.data.assigned_to;
      merged.assigned_agent_name = existing.data.assigned_agent_name;
    } else if (repAssign) {
      merged.assigned_to = repAssign.auth_user_id;
      merged.assigned_agent_name = repAssign.name;
    }
    await db
      .from("tenant_records")
      .update({ data: merged })
      .eq("id", existing.id)
      .eq("tenant_id", form.tenant_id);
    lead = { id: existing.id, data: merged };
  } else {
    // Migration 064: public-form submissions land at hot_lead (active engagement).
    const leadData: Record<string, unknown> = {
      stage: "hot_lead",
      source: "public_form",
      created_from_form_id: form.id,
      created_from_ip_hash: input.ip ? hashIp(input.ip) : null,
      ...contactFields,
    };
    if (repAssign) {
      leadData.assigned_to = repAssign.auth_user_id;
      leadData.assigned_agent_name = repAssign.name;
    } else {
      // Unassigned → still give the drip a sane signer so
      // {{lead.assigned_agent_name}} never renders blank.
      leadData.assigned_agent_name = "the SunBiz team";
    }
    try {
      const created = await createRecord({
        tenant_id: form.tenant_id,
        entity: "lead",
        data: leadData,
      });
      lead = { id: created.id, data: leadData };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      return { ok: false, error: `lead_create_failed: ${detail}`, status: 500 };
    }
  }

  const token = signFormLink({
    tenant: tenantSlug,
    form_id: form.id,
    lead_id: lead.id,
  });
  if (token === null) {
    return { ok: false, error: "form_links_misconfigured", status: 503 };
  }

  // Ensure the lead carries application_url (the per-lead FULL application link)
  // + a sane assigned_agent_name so the Inquiry Welcomer drip resolves them
  // (sequence_runner spreads lead.data into the drip context). Best-effort.
  const patch: Record<string, unknown> = {};
  if (!lead.data.application_url) {
    const applicationUrl = await mintFullApplicationLink(
      input.origin,
      form.tenant_id,
      tenantSlug,
      lead.id,
    );
    if (applicationUrl) patch.application_url = applicationUrl;
  }
  if (!lead.data.assigned_agent_name) {
    patch.assigned_agent_name = repAssign?.name || "the SunBiz team";
  }
  if (Object.keys(patch).length > 0) {
    await db
      .from("tenant_records")
      .update({ data: { ...lead.data, ...patch } })
      .eq("id", lead.id)
      .eq("tenant_id", form.tenant_id);
  }

  return {
    ok: true,
    token,
    link: {
      tenant: tenantSlug,
      form_id: form.id,
      lead_id: lead.id,
      iat: Math.floor(Date.now() / 1000),
    },
  };
}

/** Truncated SHA-256 of the IP — used for lightweight per-IP dedup
 *  without persisting raw IPs in tenant data. */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Map the full-application's flat owner_* fields onto the lead's data using the
 * key shape the operator Owner tab reads (components/leads/LeadDetailDrawer.tsx
 * OwnerTab → owner_name, owner_ssn_last4, owner_dob, ownership_pct,
 * owner_address_line1). Without this, owner KYC stayed only on
 * form_submissions.payload and the Owner tab rendered blank for form-originated
 * deals.
 *
 * PII discipline: only the SSN's last 4 are copied to the lead JSONB (which the
 * pipeline + drawer read broadly). The full SSN stays on form_submissions.payload
 * — the audited source-of-truth — and never enters the lead record.
 */
function mapOwnerFields(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const s = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string).trim() : "";
  const name = s("owner_full_name");
  if (name) out.owner_name = name;
  const ssnDigits = s("owner_ssn").replace(/\D/g, "");
  if (ssnDigits.length >= 4) out.owner_ssn_last4 = ssnDigits.slice(-4);
  const dob = s("owner_dob");
  if (dob) out.owner_dob = dob;
  const pct = payload.owner_ownership_pct;
  if (typeof pct === "number" || (typeof pct === "string" && pct.trim()))
    out.ownership_pct = pct;
  const addr = s("owner_home_address");
  if (addr) out.owner_address_line1 = addr;
  return out;
}
