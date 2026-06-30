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
import { enqueueBackgroundCheck } from "@/lib/background-check/enqueue";
import { getClientIp } from "@/lib/api-helpers";
import { verifyFormLink, signFormLink, type FormLinkPayload } from "@/lib/form-links";
import {
  parseFormSteps,
  type FormStep,
  FormDefinitionError,
} from "@/lib/forms/types";
import { isFieldVisible, buildAnswerContext } from "@/lib/forms/visibility";
import { rateLimit } from "@/lib/rate-limit";
import { createRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { uploadLeadDocument, registerLeadDocument, classifyDocTypeByFilename } from "@/lib/lead-documents";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { resolvePublicForm } from "@/lib/forms/public-resolver";
import { maybeQueueResumeEmail } from "@/lib/forms/maybe-queue-resume";
import { maybeSendNextStepsEmail, maybeSendApplicationCompleteEmail } from "@/lib/forms/next-steps-email";
import { notifyOasisFunnelSubmission } from "@/lib/forms/oasis-funnel-notify";
import { buildOasisLeadPatch } from "@/lib/forms/oasis-funnel-format";
import { OASIS_FUNNEL_SLUG, OASIS_FUNNEL_TENANT_ID } from "@/lib/forms/oasis-funnel-seed";
import { maybeGenerateApplicationDocument } from "@/lib/forms/application-document";
import { sendSunbizLeadEvent } from "@/lib/notify/sunbiz-events";
import { sendFormCompletionEmail } from "@/lib/notify/form-completion-email";
import { mintFormLinkBySlug } from "@/lib/forms/agent-routing";
import { upsertApplicationFromFormStep } from "@/lib/forms/application-upsert";
import { autoRunUnderwritingForLead } from "@/lib/underwriting/run";
import { resolveRepAssignment, mintFullApplicationLink, findExistingLead } from "@/lib/forms/agent-routing";
import { LEAD_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";
import { isFormStageDowngrade } from "@/lib/forms/stage-transition";
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
    // ?rep=<jordan|alex|matt> from the per-agent interest link — resolved to
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
  // Fetch prior submissions for (a) the sequential-progress check and (b) the
  // server-authoritative show_if context. mergedAnswers is built by
  // buildAnswerContext, which whitelists every payload to its OWN step's
  // declared fields — so a crafted body can't override a controller field on
  // another step to dodge a required field. (Codex audit 2026-06-18 [critical].)
  let priorRows: Array<{ step_index: number; payload: unknown }> = [];
  if (stepIndex > 0) {
    const priorQ = await db
      .from("form_submissions")
      .select("step_index, payload")
      .eq("form_id", form.id)
      .eq("lead_id", link.lead_id);
    priorRows = (priorQ.data || []) as Array<{ step_index: number; payload: unknown }>;
    const completedSteps = new Set(priorRows.map((r) => Number(r.step_index)));
    for (let i = 0; i < stepIndex; i++) {
      if (!completedSteps.has(i)) {
        return NextResponse.json(
          { ok: false, error: "prior_step_incomplete", missing_step: i },
          { status: 400 },
        );
      }
    }
  }
  const mergedAnswers = buildAnswerContext(steps, priorRows, stepIndex, payload);

  const currentStep = steps[stepIndex];
  const inlineFileNames = new Set(inlineFiles.map((f) => f.fieldName));
  for (const field of currentStep.fields) {
    if (!field.required) continue;
    // Hidden-by-condition fields are not required (mirrors the renderer + the
    // client validator). Evaluated against mergedAnswers, never client-trusted.
    if (!isFieldVisible(field, mergedAnswers)) continue;
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
    } else if (field.type === "file_upload_multi") {
      // Satisfied by a non-empty array of uploaded descriptors (the client
      // uploaded each to a signed URL and reports {storage_path,...}). The
      // descriptors are re-validated + registered below.
      const ok =
        Array.isArray(v) &&
        v.length > 0 &&
        v.some(
          (d) =>
            d && typeof d === "object" && typeof (d as { storage_path?: unknown }).storage_path === "string",
        );
      if (!ok) {
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

  // Direct-to-Storage multi-file fields (file_upload_multi). The client uploaded
  // each file straight to Storage via a server-minted signed URL
  // (/api/forms/upload-url) and reports {storage_path, filename, mime_type,
  // size_bytes} descriptors in payload[field]. Register each as a lead_document.
  // registerLeadDocument re-validates the path is inside this tenant+lead prefix
  // AND that the object actually exists + reads its real size — so a forged or
  // foreign-tenant descriptor (the reason inline client attachments are ignored
  // above) is rejected here too. Caps + MIME allowlist mirror the inline path.
  const DEFAULT_MULTI_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
  for (const field of currentStepFields.values()) {
    if (field.type !== "file_upload_multi") continue;
    const raw = payload[field.name];
    if (!Array.isArray(raw)) {
      if (raw !== undefined) delete payload[field.name];
      continue;
    }
    const maxFiles = typeof field.max_files === "number" && field.max_files > 0 ? field.max_files : 50;
    const allowedMime = field.accept && field.accept.length > 0 ? field.accept : DEFAULT_MULTI_MIME;
    // 2026-06-20 (Ethan/Alex): the doc bucket is now ONE field for ALL document
    // types, so we classify EACH file by its own filename — license.pdf →
    // drivers_license, void.pdf → void_cheque, statement.pdf → bank_statements_3mo —
    // and only fall back to the field's default type when a filename is ambiguous.
    // (Pre-collapse this keyed off field.name, which would mis-type every file in
    // the merged bucket as a bank statement and starve the required-docs tracker.)
    const fieldDocType = classifyDocTypeByFilename(field.name);
    const cleaned: Array<{ storage_path: string; filename: string; mime_type: string; size_bytes: number }> = [];
    for (const d of raw.slice(0, maxFiles)) {
      if (!d || typeof d !== "object") continue;
      const desc = d as { storage_path?: unknown; filename?: unknown; mime_type?: unknown };
      const sp = typeof desc.storage_path === "string" ? desc.storage_path : "";
      const fn = typeof desc.filename === "string" && desc.filename ? desc.filename : "upload";
      const mt = typeof desc.mime_type === "string" ? desc.mime_type : "";
      if (!sp) {
        uploadWarnings.push({ field_name: field.name, reason: "missing_storage_path" });
        continue;
      }
      const mimeOk = allowedMime.some((rule) =>
        rule.endsWith("/*") ? mt.startsWith(rule.slice(0, -1)) : mt === rule,
      );
      if (!mimeOk) {
        uploadWarnings.push({ field_name: field.name, reason: `mime_not_allowed: ${mt}` });
        continue;
      }
      // Per-file classification: license/void/ID files dropped into the shared
      // bucket get their true doc_type; ambiguous filenames fall back to the
      // field's default (bank_statements_3mo for the statements bucket).
      const perFileType = classifyDocTypeByFilename(fn);
      const docTypeForFile = perFileType !== "unclassified" ? perFileType : fieldDocType;
      const reg = await registerLeadDocument({
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        storagePath: sp,
        filename: fn,
        mimeType: mt,
        docType: docTypeForFile,
        uploadedBy: "form_intake",
        source: "form_intake",
        extraMetadata: { form_id: form.id, field_name: field.name, step_index: stepIndex },
      });
      if (!reg.ok) {
        uploadWarnings.push({ field_name: field.name, reason: reg.error });
        continue;
      }
      uploadedDocs.push({
        field_name: field.name,
        storage_path: reg.document.storage_path,
        filename: reg.document.filename,
        mime_type: reg.document.mime_type,
        size_bytes: reg.document.size_bytes,
        doc_type: reg.document.doc_type,
      });
      cleaned.push({
        storage_path: reg.document.storage_path,
        filename: reg.document.filename,
        mime_type: reg.document.mime_type,
        size_bytes: reg.document.size_bytes,
      });
    }
    // Persist the server-verified descriptors (drops anything that failed
    // validation) so form_submissions.payload reflects what actually registered.
    payload[field.name] = cleaned;
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
    // Batch 4 hook (c): bank-statements uploaded → 🔵 alert the owner + admins.
    // Gated to the funding tenant + the bank/full-application forms.
    if (
      isFundingTenant(link.tenant) &&
      (form.slug === "bank-statement-upload" || form.slug === "full-application")
    ) {
      const bankFileCount = uploadedDocs.length;
      after(() =>
        sendSunbizLeadEvent({
          db,
          tenantId: form.tenant_id,
          leadId: link.lead_id,
          kind: "bank_statements",
          extra: { file_count: bankFileCount },
        }),
      );
      // Email the assigned agent + submissions@ that Form 3 (bank statements)
      // was completed. Only on the bank-statement-upload form (not when the
      // full application happens to carry statements — that's Form 2).
      if (form.slug === "bank-statement-upload") {
        after(() =>
          sendFormCompletionEmail({ db, tenantId: form.tenant_id, leadId: link.lead_id, formNumber: 3, origin: req.nextUrl.origin }),
        );
      }
    }
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
  // The returning lead's current stage (read below for the forward-only guard),
  // reused to suppress the interest-form continue-now links for a merchant who
  // has already completed/submitted their application.
  let currentLeadStage: string | null = null;
  const stepOutcomes = form.step_outcomes || {};
  const isLastStep = stepIndex === steps.length - 1;
  const fullApplicationCollectsDocuments =
    form.slug === "full-application" && formCollectsBankStatements(steps);
  // Change #1 (Adon, lead status defs 2026-06-19): COMPLETING the first
  // application (the initial-lead-capture interest form) = the merchant has
  // "Viewed" (completed) the first app → viewed_application. Opening-but-not-
  // completing is set to "Intent Inquiry" in /api/forms/view. This overrides
  // the interest form's stored on_complete_stage on its final step only.
  // Adon 2026-06-22: completing the THIRD form (bank-statement-upload) = bank
  // statements received → advance the lead to "Submitted Application" (submitted
  // to underwriting; entry stage for the signed-application drip). Like the
  // initial-lead-capture override, this wins over the form's stored
  // on_complete_stage on its final step. The forward-only guard below still
  // applies (a more-advanced lead is never downgraded).
  const targetStage =
    isLastStep && form.slug === "initial-lead-capture"
      ? "viewed_application"
      : isLastStep && form.slug === "bank-statement-upload"
        ? "submitted_application"
        : stepOutcomes[String(stepIndex)] ||
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
    // Forward-only guard. A returning merchant who re-submits the interest form
    // is smart-matched into their EXISTING (often more-advanced) lead — applying
    // the entry form's step_outcome would DOWNGRADE them to the entry stage.
    // Skip the write when the lead is already further down the funnel. Only
    // treats it as a downgrade when BOTH stages are known lead stages and the
    // current one is strictly later; unknown stages fall through and apply as
    // before. (Codex audit 2026-06-18 [high]: reused leads were downgraded.)
    let isDowngrade = false;
    try {
      const curRes = await db
        .from("tenant_records")
        .select("data")
        .eq("id", link.lead_id)
        .eq("tenant_id", form.tenant_id)
        .maybeSingle();
      if (curRes.error) {
        // FAIL CLOSED: a stage read we can't trust must not lead to an overwrite
        // — preserve the existing stage rather than risk re-engaging a
        // terminal/opted_out lead (CASL). (Codex audit 2026-06-18 [high].)
        // Surface the skipped advance so the operator isn't left in the dark
        // that a returning lead didn't move (Codex [medium]). Not flagged for an
        // INTENTIONAL downgrade-skip below — that's correct, not a stall.
        isDowngrade = true;
        stageWarning = { reason: "stage_read_failed", target_stage: targetStage };
      } else {
        const curStage = (curRes.data as { data?: Record<string, unknown> } | null)?.data?.stage;
        currentLeadStage = typeof curStage === "string" ? curStage : null;
        // Forward-only with terminal-stage policy: ghost/declined reactivate on a
        // new submission, default/opted_out are preserved, active + unknown
        // stages are never downgraded/overwritten. See lib/forms/stage-transition.ts.
        isDowngrade = isFormStageDowngrade(
          typeof curStage === "string" ? curStage : null,
          targetStage,
          LEAD_PIPELINE_STAGES.map((s) => s.key),
        );
      }
    } catch {
      // Read threw — FAIL CLOSED (preserve the existing stage), same reasoning.
      isDowngrade = true;
      stageWarning = { reason: "stage_read_threw", target_stage: targetStage };
    }
    if (isDowngrade) {
      // Preserve the lead's more-advanced stage; the submission is still
      // recorded (form_submissions row above) and the application upsert /
      // handoff email still run.
      appliedStage = null;
    } else {
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
  }

  // Auto-enqueue a background check the moment the FULL application is signed.
  // Deferred (after the response flushes) + best-effort so it never adds latency
  // to or fails the submission; the JARVIS bg-check-worker polls the queue.
  // Idempotent (one open check per lead).
  if (appliedStage === "signed_application") {
    after(async () => {
      try {
        const enq = await enqueueBackgroundCheck({ db, tenantId: form.tenant_id, leadId: link.lead_id });
        if (!enq.ok) console.error("[forms.submit.bgc_enqueue]", { lead_id: link.lead_id, error: enq.reason });
      } catch (e) {
        console.error("[forms.submit.bgc_enqueue.threw]", {
          lead_id: link.lead_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  // Bridge form payload → application record. Adon MCA SOP §4 match-fitness
  // scorer reads business_state + industry off the application row; each step's
  // payload upserts into the application (creates when none exists, merges when
  // found). Best-effort: failure never aborts the submission.
  //
  // 2026-06-18 (lead-first lifecycle): the INTEREST form (initial-lead-capture)
  // must NOT create an application — an inquiry isn't an application yet. The
  // application comes into existence only when the merchant submits the FULL
  // application (full-application / bank-statement-upload). This is what keeps
  // the Opportunity Pipeline holding REAL applications instead of premature
  // "Application In" rows for every inquiry.
  // Funding-only: an application entity (Opportunity Pipeline) is a funding
  // construct. The OASIS funnel ("start") must NOT create applications — it
  // feeds the lead pipeline only. Gate to the funding tenant so non-funding
  // tenants' non-interest forms don't spawn phantom application rows.
  if (isFundingTenant(link.tenant) && form.slug !== "initial-lead-capture") try {
    // Full-application is the legitimate application-data channel — pass its
    // payload through. For OTHER funding forms (bank-statement-upload), pass ONLY
    // the fields the form actually DECLARES, so a bank-link holder can't inject
    // undeclared application-field mutations (requested_advance, business_legal_name,
    // …) via a crafted POST right before the new auto-underwrite path. (Codex
    // Rule-8 2026-06-22 finding 3.) The bank form declares only `bank_statements`,
    // so the upsert sees no app-shaped fields → no-op, exactly like a legit submit.
    const declaredStepFields = new Set((steps[stepIndex]?.fields || []).map((f) => f.name));
    const appUpsertPayload =
      form.slug === "full-application"
        ? payload
        : Object.fromEntries(Object.entries(payload).filter(([k]) => declaredStepFields.has(k)));
    const appUpsert = await upsertApplicationFromFormStep({
      tenantId: form.tenant_id,
      leadId: link.lead_id,
      formId: form.id,
      stepIndex,
      payload: appUpsertPayload,
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
  // next_forms: personalized links to the full application + bank-statement
  // forms, returned in the response so the interest form's completion screen
  // can offer "continue now" buttons — the SAME links the handoff email sends.
  // Minted only on the interest-form submission.
  let nextForms: Array<{ slug: string; label: string; url: string }> | null = null;

  if (stepIndex === 0 && form.slug === "initial-lead-capture") {
    // Run the handoff send AFTER the response is returned (Next 15 `after`) so
    // a slow/offline bridge can never delay or time out the prospect's
    // submission. The helper is fully soft-fail. (Codex audit 2026-06-17
    // [medium]: awaited bridge send blocked the public response.) Capture the
    // origin now — req must not be touched inside the post-response callback.
    const origin = req.nextUrl.origin;
    // Mint the continue-now links synchronously so they ride the response. Both
    // are quick indexed lookups; run them in parallel. Null entries (a form
    // missing/disabled) are dropped, so we only surface links that resolve.
    // CC 2026-06-22: form 1 → form 2 ONLY (sequential funnel). The bank-statement
    // link is offered later, on full-application completion (see the else-if
    // below + maybeSendApplicationCompleteEmail). Mint just the full-application
    // continue-now link here.
    const fullAppUrl = await mintFormLinkBySlug(
      origin, form.tenant_id, link.tenant, link.lead_id, "full-application",
    );
    const minted = [
      fullAppUrl ? { slug: "full-application", label: "Complete your full application", url: fullAppUrl } : null,
    ].filter((x): x is { slug: string; label: string; url: string } => x !== null);
    // Don't re-invite a returning merchant who has ALREADY completed/submitted
    // their application (smart-matched into an advanced lead) — the links are
    // valid, but the buttons would ask them to re-fill finished forms. (review
    // 2026-06-17 [low].) sent/viewed are still pending → keep offering them.
    const APPLIED_STAGES = new Set([
      "signed_application",
      "submitted",
      "approved",
      "funded",
      "default",
    ]);
    const alreadyApplied = !!currentLeadStage && APPLIED_STAGES.has(currentLeadStage);
    nextForms = !alreadyApplied && minted.length > 0 ? minted : null;
    after(() =>
      maybeSendNextStepsEmail({
        db,
        form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
        link: { tenant: link.tenant, lead_id: link.lead_id },
        payload,
        origin,
      }),
    );
    // Batch 4 hook (a): first application → 🟢 alert owner + admins.
    after(() =>
      sendSunbizLeadEvent({
        db,
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        kind: "first_application",
        extra: payload,
      }),
    );
    // Email the assigned agent + submissions@ that Form 1 was completed.
    if (isFundingTenant(link.tenant)) {
      after(() =>
        sendFormCompletionEmail({ db, tenantId: form.tenant_id, leadId: link.lead_id, formNumber: 1, origin: req.nextUrl.origin }),
      );
    }
  } else if (isLastStep && form.slug === "full-application") {
    // Legacy fallback: old DB-seeded full-application forms did not collect
    // documents, so completion had to hand the merchant to the separate upload
    // form. The current canonical seed collects documents in-flow; in that case
    // do not ask the merchant to upload the same statements twice.
    if (!fullApplicationCollectsDocuments) {
      const origin = req.nextUrl.origin;
      const bankUrl = await mintFormLinkBySlug(
        origin, form.tenant_id, link.tenant, link.lead_id, "bank-statement-upload",
      );
      nextForms = bankUrl
        ? [{ slug: "bank-statement-upload", label: "Upload your bank statements", url: bankUrl }]
        : null;
      after(() =>
        maybeSendApplicationCompleteEmail({
          db,
          form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
          link: { tenant: link.tenant, lead_id: link.lead_id },
          payload,
          origin,
        }),
      );
    }
  } else {
    await maybeQueueResumeEmail({
      db,
      step_index: stepIndex,
      form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
      link: { tenant: link.tenant, lead_id: link.lead_id, form_id: link.form_id },
      payload,
    });
  }

  // Final step of the FULL application → generate the signed application PDF
  // (exact SunBiz layout, populated with the merchant's submitted data + their
  // drawn signature), file it to the lead's documents ("Final Application
  // Form"), and record it on the timeline. Runs AFTER the response (Next 15
  // `after`) so PDF generation never delays the merchant's submit; the helper
  // is fully soft-fail. Gated to the full application's last step so the
  // interest + bank-statement forms don't trigger it.
  if (isLastStep && form.slug === "full-application") {
    after(() =>
      maybeGenerateApplicationDocument({
        db,
        form: { id: form.id, tenant_id: form.tenant_id, slug: form.slug },
        link: { tenant: link.tenant, lead_id: link.lead_id },
        ip: ipHeader,
      }),
    );
    // Batch 4 hook (b): second/full application → 🟡 alert owner + admins.
    after(() =>
      sendSunbizLeadEvent({
        db,
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        kind: "second_application",
        extra: payload,
      }),
    );
    // Email the assigned agent + submissions@ that Form 2 was completed.
    if (isFundingTenant(link.tenant)) {
      after(() =>
        sendFormCompletionEmail({ db, tenantId: form.tenant_id, leadId: link.lead_id, formNumber: 2, origin: req.nextUrl.origin }),
      );
    }
  }

  // Final step of either document-complete path → auto-run underwriting.
  // Standalone bank-statement form gates on uploadedDocs from THIS request. The
  // in-flow full application reaches this branch on the later signature step, so
  // its required documents were already validated on the earlier upload step.
  if (
    (isLastStep && form.slug === "bank-statement-upload" && uploadedDocs.length > 0) ||
    (isLastStep && fullApplicationCollectsDocuments)
  ) {
    after(() =>
      autoRunUnderwritingForLead({
        db,
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        source:
          form.slug === "full-application"
            ? "form_intake_full_application"
            : "form_intake_bank_statements",
      }),
    );
  }

  // OASIS personal-brand funnel (CC): final step. Gated to CC's EXACT tenant +
  // form so no other tenant can fire CC's Telegram/Gmail notifications. (Codex
  // audit 2026-06-18 [high]: a startsWith("oasis") gate matched other tenants.)
  if (
    isLastStep &&
    form.tenant_id === OASIS_FUNNEL_TENANT_ID &&
    form.slug === OASIS_FUNNEL_SLUG
  ) {
    const answers = { ...mergedAnswers };
    // (a) Enrich the lead with canonical OASIS fields. The pipeline reads
    // data.name/company/email/phone/notes, but the funnel collects contact on
    // the LAST step and the create path stored contact_name/business_name — so
    // without this the lead would render blank in the pipeline. Awaited so the
    // pipeline is correct the moment CC looks. Best-effort.
    try {
      const patch = buildOasisLeadPatch(answers);
      if (Object.keys(patch).length > 0) {
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
          .update({ data: { ...curData, ...patch } })
          .eq("id", link.lead_id)
          .eq("tenant_id", form.tenant_id);
      }
    } catch (err) {
      console.error("[forms.submit.oasis_enrich.failed]", {
        lead_id: link.lead_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // (b) Ping CC's Telegram + send the Claude welcome email. Fire-and-forget +
    // soft-fail via `after()`. mergedAnswers carries interests + branch details
    // + contact (built from whitelisted answers across steps).
    after(() =>
      notifyOasisFunnelSubmission({
        db,
        tenantId: form.tenant_id,
        leadId: link.lead_id,
        answers,
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    submission_id: submissionId,
    next_step: isLastStep ? null : stepIndex + 1,
    lead_stage: appliedStage,
    redirect_url: isLastStep ? form.redirect_url : null,
    // Personalized continue-now links (interest form completion only) — the
    // public form's thank-you screen renders these as buttons. Null for every
    // other form/step.
    next_forms: nextForms,
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
 * Tenant policy for anonymous public-form leads. SunBiz (the funding tenant,
 * row slug "submissions" / manifest slug "sun") keeps its EXACT original
 * behavior — funding-pipeline stage, "public_form" source, full-application
 * link minting, SunBiz signer. Every other tenant (OASIS personal brand +
 * client agencies) uses the agency lead lifecycle: stage from the form's
 * own on_complete_stage, "inbound" source, no full-application link.
 * Keyed off the tenant ROW slug.
 */
function isFundingTenant(tenantSlug: string): boolean {
  const s = (tenantSlug || "").toLowerCase();
  return s === "sun" || s === "submissions";
}

function formCollectsBankStatements(steps: FormStep[]): boolean {
  return steps.some((step) =>
    step.fields.some(
      (field) => field.type === "file_upload_multi" && field.name === "bank_statements",
    ),
  );
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
    // Stage/source/signer are tenant-aware. SunBiz keeps its exact prior
    // values (funding pipeline). Other tenants (OASIS etc.) start the lead at
    // the form's own on_complete_stage — its lifecycle's first stage — because
    // "intent_inquiry_submitted" isn't a valid OASIS stage and would render as
    // a phantom kanban column.
    const funding = isFundingTenant(tenantSlug);
    const defaultStage = funding
      ? // Unchanged SunBiz behavior: intent expressed (contact + revenue),
        // not yet applied. The form's step_outcomes/on_complete_stage resolve
        // to the same stage; this covers the create before that runs.
        "intent_inquiry_submitted"
      : form.on_complete_stage ||
        (form.step_outcomes as Record<string, string> | null | undefined)?.["0"] ||
        "new_contact";
    const leadData: Record<string, unknown> = {
      stage: defaultStage,
      // OASIS lead source enum has no "public_form" — map to "inbound" (a
      // social/funnel lead came to us). SunBiz keeps "public_form".
      source: funding ? "public_form" : "inbound",
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
      leadData.assigned_agent_name = funding ? "the SunBiz team" : "the OASIS AI team";
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
  // The application_url is funding-specific (there's no full-application form
  // for OASIS) — only mint it for the funding tenant.
  const patch: Record<string, unknown> = {};
  if (isFundingTenant(tenantSlug) && !lead.data.application_url) {
    const applicationUrl = await mintFullApplicationLink(
      input.origin,
      form.tenant_id,
      tenantSlug,
      lead.id,
    );
    if (applicationUrl) patch.application_url = applicationUrl;
  }
  if (!lead.data.assigned_agent_name) {
    patch.assigned_agent_name =
      repAssign?.name || (isFundingTenant(tenantSlug) ? "the SunBiz team" : "the OASIS AI team");
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
