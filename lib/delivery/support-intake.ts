/**
 * lib/delivery/support-intake.ts — a support form submission becomes a support
 * ticket on the desk that owns the form. Called from TWO early branches in
 * app/api/forms/submit/route.ts, before any lead, upload, drip or stage code in
 * that route can run:
 *   - OASIS's Client Support Ticket form (/f/oasis-ai-cc/support), recognised
 *     by its exact tenant + slug with no query (isSupportFormSubmission);
 *   - every other workspace's own support form (/f/<slug>/support), recognised
 *     by its registration in support_desks (matchWorkspaceSupportDesk; see
 *     lib/delivery/desks.ts for why a registration and not the slug alone).
 * Both run the same steps below; the desk decides the tenant every statement
 * is pinned to, and it comes from the FORM's own row, never from the body.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Confirms the form: the desk's exact tenant + `support` slug (and, for a
 *      registered desk, its registered form id), enabled, one step. Anything
 *      else is not_found (same single answer the public resolver gives, so the
 *      route cannot be used to enumerate forms).
 *   2. Validates the answers: the form's own required fields, then the ticket
 *      rules (lib/delivery/rules.ts parseSupportSubmission). Then the rate
 *      limits, per IP and per address (see PER_IP below).
 *   3. Checks the optional attachment: allowlisted type, bytes that really are
 *      an allowed type (kept under the type the bytes prove), size cap.
 *      Nothing is uploaded yet.
 *   4. Records a form_submissions row. form_submissions.lead_id is NOT NULL and
 *      there is no lead, so it carries `ticket:<ticket id>` — a value that can
 *      never match a tenant_records id, so no lead surface ever picks it up.
 *      The insert lands only while the sender is under both limits.
 *   5. Stores the attachment in private object storage under the desk's tenant
 *      and the ticket id (never the lead-documents path: a ticket is not a
 *      lead). After step 4, so a refused request stores nothing.
 *   6. Matches the requester by email (server-side only, never echoed back):
 *      to one of the desk's client records (customers, migration bravo__188)
 *      and to one of its projects; on OASIS's desk also to a client workspace.
 *   7. Creates the ticket, keyed on the submission id (idempotent).
 *   8. After the response: the desk team's alert and the requester's
 *      confirmation, each exactly once. OASIS's desk sends them through OASIS's
 *      lanes; any other desk records them as not sent until it has lanes of its
 *      own (lib/delivery/notify.ts).
 *
 * WHAT IT NEVER DOES: create or update a lead, enrol anything in a drip,
 * advance a pipeline stage, or mint a form token.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { Client } from "@libsql/client";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { parseFormSteps, FormDefinitionError, type FormField } from "@/lib/forms/types";
import { isFieldVisible } from "@/lib/forms/visibility";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { parseSupportSubmission, type SupportSubmission } from "@/lib/delivery/rules";
import {
  createTicket,
  listPendingIntakeNotifications,
  listUnticketedSupportSubmissions,
  matchClientByEmail,
  matchDeskProjectByEmail,
  projectCustomerId,
  type Attachment,
  type ClientMatch,
} from "@/lib/delivery/store";
import {
  defaultNotifyDeps,
  runIntakeNotifications,
  scheduleAfterResponse,
  type NotifyDeps,
} from "@/lib/delivery/notify";
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIME,
  SUPPORT_FORM_SLUG,
  SUPPORT_FORM_TENANT_SLUG,
  sniffAttachmentType,
} from "@/lib/delivery/support-form";
import { OASIS_DESK, findRegisteredDeskBySlug, listRegisteredDesks, type SupportDesk } from "@/lib/delivery/desks";
import { isMissingCustomersSchema, matchCustomerByEmail } from "@/lib/os/customers/store";
import { shadowSupportTriage } from "@/lib/jev/mode";

/** Private object-storage bucket (a key prefix on R2) for ticket attachments. */
export const SUPPORT_ATTACHMENT_BUCKET = "support-attachments";

/** The form_submissions.lead_id a support submission carries. Never a lead id. */
export function supportSubmissionLeadRef(ticketId: string): string {
  return `ticket:${ticketId}`;
}

/**
 * Is this request body a submission to OASIS's Client Support Ticket form?
 *
 * Pure string comparison on the body — no query — so it adds nothing to any
 * other form's submission. A token-bearing body is never this form: the
 * support branch never mints a token (a token is bound to a lead).
 */
export function isSupportFormSubmission(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { token?: unknown; anonymous_init?: { tenant_slug?: unknown; form_slug?: unknown } | null };
  if (b.token) return false;
  const tenant = b.anonymous_init?.tenant_slug;
  const form = b.anonymous_init?.form_slug;
  return (
    typeof tenant === "string" &&
    typeof form === "string" &&
    tenant.trim().toLowerCase() === SUPPORT_FORM_TENANT_SLUG &&
    form.trim().toLowerCase() === SUPPORT_FORM_SLUG
  );
}

/**
 * Is this request body a submission to ANOTHER workspace's registered support
 * form? The body test is pure (an anonymous step-0 body naming a `support`
 * form outside OASIS), so every other form pays nothing; only a body that
 * passes it costs one registry read. Null = not a desk form: the route carries
 * on down its ordinary lead path, exactly as it did before desks existed.
 * A registry read that FAILS throws: the route's catch dead-letters the
 * submission (recoverable) instead of filing a customer's support request as a
 * sales lead.
 */
export async function matchWorkspaceSupportDesk(body: unknown, deps: { db?: Client } = {}): Promise<SupportDesk | null> {
  if (!body || typeof body !== "object") return null;
  const b = body as { token?: unknown; anonymous_init?: { tenant_slug?: unknown; form_slug?: unknown } | null };
  if (b.token) return null;
  const tenant = b.anonymous_init?.tenant_slug;
  const form = b.anonymous_init?.form_slug;
  if (typeof tenant !== "string" || typeof form !== "string") return null;
  const slug = tenant.trim().toLowerCase();
  if (!slug || slug === SUPPORT_FORM_TENANT_SLUG || form.trim().toLowerCase() !== SUPPORT_FORM_SLUG) return null;
  if (!deps.db && !tursoConfigured()) return null;
  return findRegisteredDeskBySlug(deps.db ?? getTursoClient(), slug);
}

type InlineFile = { inline_base64: string; filename: string; mime_type: string; size_bytes: number };

function isInlineFile(v: unknown): v is InlineFile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.inline_base64 === "string" &&
    typeof o.filename === "string" &&
    typeof o.mime_type === "string" &&
    typeof o.size_bytes === "number"
  );
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "attachment";
}

export type AttachmentUploader = (path: string, bytes: Buffer, contentType: string) => Promise<{ ok: true } | { ok: false; error: string }>;

const defaultUploader: AttachmentUploader = async (path, bytes, contentType) => {
  try {
    const { error } = await getServiceSupabase()
      .storage.from(SUPPORT_ATTACHMENT_BUCKET)
      .upload(path, bytes, { contentType, upsert: false });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export type IntakeDeps = {
  db?: Client;
  now?: () => Date;
  schedule?: (task: () => Promise<void>) => void;
  notify?: NotifyDeps;
  upload?: AttachmentUploader;
};

type SubmitBody = {
  step_index?: unknown;
  payload?: unknown;
  anonymous_init?: { tenant_slug?: string; form_slug?: string } | null;
};

function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

/** Messages for the few rejections the public form has no copy for. */
const FIELD_MESSAGES: Record<string, string> = {
  email_invalid: "Please enter a valid email address so we can reply to you.",
  email_required: "Please enter your email address so we can reply to you.",
  name_required: "Please tell us your name.",
  description_required: "Please describe what is happening.",
  description_too_long: "Please keep the description under 5,000 characters.",
  name_too_long: "Please shorten your name.",
  company_too_long: "Please shorten the company name.",
  project_too_long: "Please shorten the project name.",
};

/**
 * How often one sender may file a ticket. Every accepted ticket alerts the
 * desk's team and may email a confirmation to an address the sender typed, so
 * this is what keeps the form from becoming a way to mail-bomb someone.
 *
 * Enforced twice, over the same windows:
 *   - rateLimit(), an in-memory bucket: the cheap first gate. It lives in ONE
 *     isolate's memory and production runs many Workers isolates, so requests
 *     spread across them each meet a fresh bucket.
 *   - form_submissions, the row this intake writes for every accepted request
 *     whichever isolate took it. Counted before anything is stored or sent,
 *     and counted again inside the INSERT itself (step 4): the database runs
 *     writes one at a time, so of N parallel requests that all passed the first
 *     count, only as many land as the limit allows.
 * Both are per desk: one workspace's form traffic never spends another's limit.
 */
const PER_IP = { max: 5, windowSec: 60 };
const PER_EMAIL = { max: 3, windowSec: 600 };

// The public form shows a 429's `message` when it carries one. Its own fixed
// copy says "wait a few seconds", which is wrong for the ten-minute window.
const RATE_LIMITED_MESSAGE = {
  ip: "Too many requests from your connection just now. Please wait a minute and try again.",
  email:
    `We already have several requests from this email address in the last ${PER_EMAIL.windowSec / 60} minutes. ` +
    "Please wait a few minutes and try again, or reply to the confirmation email we sent you.",
  either: "Too many requests just now. Please wait a few minutes and try again.",
};

// A workspace desk sends no confirmation until it has a mailbox of its own, so
// its copy must not point the sender at one.
const RATE_LIMITED_EMAIL_NO_ACK =
  `We already have several requests from this email address in the last ${PER_EMAIL.windowSec / 60} minutes. ` +
  "Please wait a few minutes and try again.";

function rateLimited(limit: keyof typeof RATE_LIMITED_MESSAGE, retryInSec: number, desk: SupportDesk = OASIS_DESK) {
  const message = limit === "email" && !desk.oasis ? RATE_LIMITED_EMAIL_NO_ACK : RATE_LIMITED_MESSAGE[limit];
  return fail(429, "rate_limited", { retry_in_sec: retryInSec, message });
}

/** In-memory bucket keys. OASIS's keep their original names, so its limits are unchanged. */
function bucketKey(desk: SupportDesk, kind: "ip" | "email", value: string): string {
  const base = kind === "ip" ? "support-form" : "support-form-email";
  return desk.oasis ? `${base}:${value}` : `${base}:${desk.tenantId}:${value}`;
}

// This form's submissions inside a window, from one IP (NULL is "could not be
// resolved": one shared window, as the in-memory "no-ip" bucket is) and to one
// address. Step 4 stores the NORMALISED address, so equality is exact. The
// json_valid guard keeps one malformed payload from erroring every count.
const FROM_IP_SQL = `SELECT count(*) FROM form_submissions
  WHERE form_id = ? AND tenant_id = ? AND submitted_at > ? AND ip_address IS ?`;
const TO_EMAIL_SQL = `SELECT count(*) FROM form_submissions
  WHERE form_id = ? AND tenant_id = ? AND submitted_at > ?
    AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.email') END = ?`;

function recentSubmissionArgs(desk: SupportDesk, formId: string, ip: string | null, email: string, now: Date) {
  const since = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();
  return {
    ip: [formId, desk.tenantId, since(PER_IP.windowSec), ip],
    email: [formId, desk.tenantId, since(PER_EMAIL.windowSec), email],
  };
}

/** OASIS's Client Support Ticket form (/f/oasis-ai-cc/support). */
export function handleSupportFormSubmission(
  req: NextRequest,
  rawBody: unknown,
  deps: IntakeDeps = {},
): Promise<NextResponse> {
  return handleDeskSubmission(req, rawBody, OASIS_DESK, deps);
}

/** Another workspace's own support form; `desk` comes from matchWorkspaceSupportDesk. */
export function handleWorkspaceSupportSubmission(
  req: NextRequest,
  rawBody: unknown,
  desk: SupportDesk,
  deps: IntakeDeps = {},
): Promise<NextResponse> {
  if (desk.oasis || !desk.formId) throw new Error("handleWorkspaceSupportSubmission: not a registered workspace desk");
  return handleDeskSubmission(req, rawBody, desk, deps);
}

async function handleDeskSubmission(
  req: NextRequest,
  rawBody: unknown,
  desk: SupportDesk,
  deps: IntakeDeps,
): Promise<NextResponse> {
  const body = (rawBody || {}) as SubmitBody;
  if (Number(body.step_index) !== 0) return fail(400, "anonymous_init_requires_step_0");

  const resolvedIp = getClientIp(req);
  const ip = resolvedIp === "unknown" ? "no-ip" : resolvedIp;
  const ipLimit = rateLimit({ key: bucketKey(desk, "ip", ip), capacity: PER_IP.max, refillPerSec: PER_IP.max / PER_IP.windowSec });
  if (!ipLimit.allowed) return rateLimited("ip", ipLimit.resetIn, desk);

  if (!deps.db && !tursoConfigured()) return fail(503, "server_error");
  const db = deps.db ?? getTursoClient();
  const now = (deps.now ?? (() => new Date()))();

  // 1. The form, by exact tenant + slug. Raw SQL on the same client as the
  //    ticket write, so one connection answers "does the form exist" and
  //    "record the submission".
  const formRs = await db.execute({
    sql: `SELECT f.id, f.tenant_id, f.steps, f.enabled, f.redirect_url
          FROM forms f JOIN tenants t ON t.id = f.tenant_id
          WHERE t.slug = ? AND f.slug = ? LIMIT 1`,
    args: [desk.tenantSlug, SUPPORT_FORM_SLUG],
  });
  const form = formRs.rows[0] as unknown as
    | { id: string; tenant_id: string; steps: string; enabled: number; redirect_url: string | null }
    | undefined;
  if (
    !form ||
    Number(form.enabled) !== 1 ||
    String(form.tenant_id) !== desk.tenantId ||
    (desk.formId !== null && String(form.id) !== desk.formId)
  ) {
    return fail(404, "not_found");
  }
  let fields: FormField[];
  try {
    const steps = parseFormSteps(typeof form.steps === "string" ? JSON.parse(form.steps) : form.steps);
    if (steps.length !== 1) {
      // Refuse loudly. A second step is unreachable here (no token is ever
      // minted), so accepting step 0 would file half a request as a ticket.
      console.error("[support-intake] support form has", steps.length, "steps; it must have exactly one", { tenant: desk.tenantId });
      return fail(500, "form_definition_corrupt", { reason: "support_form_must_be_single_step" });
    }
    fields = steps[0].fields;
  } catch (err) {
    console.error("[support-intake] support form definition unreadable", { tenant: desk.tenantId }, err);
    return fail(500, "form_definition_corrupt", {
      path: err instanceof FormDefinitionError ? err.path : undefined,
    });
  }

  // 2. Answers: the form's own required fields first (an operator may have
  //    added one in the builder), then the ticket rules.
  const payload: Record<string, unknown> =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? { ...(body.payload as Record<string, unknown>) }
      : {};
  for (const field of fields) {
    if (!field.required || !isFieldVisible(field, payload)) continue;
    const v = payload[field.name];
    const present =
      (typeof v === "string" && v.trim().length > 0) ||
      (typeof v === "number" && !Number.isNaN(v)) ||
      (Array.isArray(v) && v.length > 0) ||
      typeof v === "boolean" ||
      (field.type === "file_upload" && isInlineFile(v));
    if (!present) return fail(400, "missing_required_field", { field: field.name });
  }
  const parsed = parseSupportSubmission(payload);
  if (!parsed.ok) {
    // `missing_required_field` because the public form already has copy for
    // it; `message` carries the specific sentence and `field` marks the input.
    // An unmapped code would page the submit-failure beacon for a typo.
    return fail(400, "missing_required_field", {
      field: parsed.field,
      message: FIELD_MESSAGES[parsed.error] ?? "Please check the highlighted field and try again.",
    });
  }
  const sub: SupportSubmission = parsed.value;

  // Per-address limit: the form must not become a way to mail-bomb someone
  // with confirmations by typing their address repeatedly.
  const emailLimit = rateLimit({ key: bucketKey(desk, "email", sub.email), capacity: PER_EMAIL.max, refillPerSec: PER_EMAIL.max / PER_EMAIL.windowSec });
  if (!emailLimit.allowed) return rateLimited("email", emailLimit.resetIn, desk);

  // The durable limit (see PER_IP), before anything is stored, uploaded or
  // sent. A count that cannot run refuses: an unmetered public form is exactly
  // what this limit exists to prevent.
  const storedIp = resolvedIp === "unknown" ? null : resolvedIp;
  const recentArgs = recentSubmissionArgs(desk, String(form.id), storedIp, sub.email, now);
  let recent: { ip: number; email: number };
  try {
    const rs = await db.execute({
      sql: `SELECT (${FROM_IP_SQL}) AS ip, (${TO_EMAIL_SQL}) AS email`,
      args: [...recentArgs.ip, ...recentArgs.email],
    });
    recent = { ip: Number(rs.rows[0].ip), email: Number(rs.rows[0].email) };
  } catch (err) {
    console.error("[support-intake.rate_limit] durable count failed; refusing the submission", err instanceof Error ? err.message : err);
    return fail(429, "rate_limited", {
      retry_in_sec: PER_IP.windowSec,
      message: "We could not take your request just now. Please wait a minute and try again.",
    });
  }
  if (recent.email >= PER_EMAIL.max) return rateLimited("email", PER_EMAIL.windowSec, desk);
  if (recent.ip >= PER_IP.max) return rateLimited("ip", PER_IP.windowSec, desk);

  const ticketId = randomUUID();
  const submissionId = randomUUID();

  // 3. Attachment. Only the declared file_upload field, only allowlisted types,
  //    only bytes that really are one of them, only up to the cap. A refusal
  //    keeps the ticket and says so on it, and the client's confirmation email
  //    tells them to reply with the file (messages.clientAckEmail). A file that
  //    passes is marked unfinished until step 5 uploads it, so a request that
  //    dies in between leaves a true record.
  const attachments: Attachment[] = [];
  const warnings: Array<{ field_name: string; reason: string }> = [];
  const uploads: Array<{ index: number; key: string; path: string; bytes: Buffer; meta: Omit<Attachment, "storage_path"> }> = [];
  let attempted = 0;
  const fileFields = new Set(fields.filter((f) => f.type === "file_upload").map((f) => f.name));
  for (const [key, value] of Object.entries(payload)) {
    if (!isInlineFile(value)) continue;
    // Never persist raw bytes in form_submissions.payload.
    delete payload[key];
    if (!fileFields.has(key)) {
      warnings.push({ field_name: key, reason: "field_not_file_upload" });
      continue;
    }
    attempted += 1;
    const filename = sanitizeFilename(value.filename);
    const meta = { filename, mime_type: value.mime_type, size_bytes: value.size_bytes };
    if (!SUPPORT_ATTACHMENT_MIME.includes(value.mime_type)) {
      attachments.push({ ...meta, storage_path: null, error: "file type not allowed" });
      warnings.push({ field_name: key, reason: `mime_not_allowed: ${value.mime_type}` });
      continue;
    }
    const bytes = Buffer.from(value.inline_base64, "base64");
    if (bytes.length === 0 || bytes.length > SUPPORT_ATTACHMENT_MAX_BYTES) {
      attachments.push({ ...meta, storage_path: null, error: bytes.length ? "file larger than 10 MB" : "empty file" });
      warnings.push({ field_name: key, reason: bytes.length ? `file_too_large: ${bytes.length}` : "empty_file" });
      continue;
    }
    // The bytes decide the type: a real JPEG saved as .png is kept, as a JPEG;
    // bytes that are none of the allowed types never reach storage.
    const actualType = sniffAttachmentType(bytes);
    if (!actualType) {
      attachments.push({ ...meta, storage_path: null, error: "file is not a PDF, PNG, JPEG or WebP" });
      warnings.push({ field_name: key, reason: `content_mismatch: ${value.mime_type}` });
      continue;
    }
    const kept = { ...meta, mime_type: actualType };
    const path = `${desk.tenantId}/${ticketId}/${now.getTime()}_${filename}`;
    uploads.push({ index: attachments.length, key, path, bytes, meta: kept });
    attachments.push({ ...kept, storage_path: null, error: "upload did not finish" });
  }
  if (attachments.length) payload.attachment = attachments;
  // Stored normalised, so the per-address count is an exact match.
  payload.email = sub.email;

  // 4. The submission record — the idempotency key for the ticket, and the
  //    durable limit's ledger. The INSERT counts again inside itself; nothing
  //    lands when a parallel request took the last slot since the count above.
  const userAgent = req.headers.get("user-agent")?.slice(0, 500) || null;
  const recorded = await db.execute({
    sql: `INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, file_attachments, ip_address, user_agent, submitted_at)
          SELECT ?, ?, ?, ?, 0, ?, '[]', ?, ?, ?
          WHERE (${FROM_IP_SQL}) < ? AND (${TO_EMAIL_SQL}) < ?`,
    args: [
      submissionId,
      String(form.id),
      desk.tenantId,
      supportSubmissionLeadRef(ticketId),
      JSON.stringify(payload),
      storedIp,
      userAgent,
      now.toISOString(),
      ...recentArgs.ip,
      PER_IP.max,
      ...recentArgs.email,
      PER_EMAIL.max,
    ],
  });
  if (recorded.rowsAffected !== 1) return rateLimited("either", PER_IP.windowSec, desk);

  // 5. Upload, now that the request has been let in.
  for (const u of uploads) {
    const up = await (deps.upload ?? defaultUploader)(u.path, u.bytes, u.meta.mime_type);
    if (up.ok) {
      attachments[u.index] = { ...u.meta, size_bytes: u.bytes.length, storage_path: u.path };
    } else {
      console.error("[support-intake] attachment upload failed", { ticket: ticketId, error: up.error });
      attachments[u.index] = { ...u.meta, storage_path: null, error: "upload failed" };
      warnings.push({ field_name: u.key, reason: up.error });
    }
  }
  if (uploads.length) {
    // The ticket below carries the real outcome either way; this keeps the
    // submission (what the reconcile sweep reads) from saying "did not finish".
    try {
      await db.execute({
        sql: "UPDATE form_submissions SET payload = ? WHERE tenant_id = ? AND id = ?",
        args: [JSON.stringify(payload), desk.tenantId, submissionId],
      });
    } catch (err) {
      console.error("[support-intake] upload outcome not recorded on the submission", {
        submission: submissionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6 + 7. Match and create.
  const { ticket } = await createTicketFromSubmission(db, desk, { ticketId, submissionId, sub, attachments }, now);

  // 8. After the response, never before it. Then, in the same task, the Jev
  //    shadow (lib/jev/mode.ts): only when this desk's workspace has Jev on
  //    and its own key connected, it asks Jev the ticket's priority and
  //    category and records ONLY whether it agreed with what the requester
  //    chose. It changes nothing on the ticket and never throws.
  const notify = deps.notify;
  const schedule = deps.schedule ?? scheduleAfterResponse;
  schedule(async () => {
    try {
      await runIntakeNotifications(db, desk.tenantId, ticket.id, notify ?? defaultNotifyDeps(), now);
    } finally {
      await shadowSupportTriage(db, {
        tenantId: desk.tenantId,
        title: sub.title,
        description: sub.description,
        category: sub.category,
        severity: sub.severity,
        now,
      });
    }
  });

  // The public form reads next_step / redirect_url / next_forms; the rest of
  // the generic response shape is kept so the client needs no special case.
  return NextResponse.json({
    ok: true,
    submission_id: submissionId,
    ticket_number: ticket.ticket_number,
    next_step: null,
    lead_stage: null,
    redirect_url: form.redirect_url ? String(form.redirect_url) : null,
    next_forms: null,
    stage_warning: null,
    uploads: { attempted, succeeded: attachments.filter((a) => a.storage_path).length, warnings },
    minted_token: null,
  });
}

let customersMissingLogged = false;

/**
 * The desk's client record for this address, or null. A database without
 * migration bravo__188 has no client records to match, which is an answer
 * (logged once per isolate), not a reason to lose the customer's request; any
 * other failure is recorded by the caller as lookup_failed.
 */
async function matchCustomer(db: Client, desk: SupportDesk, email: string): Promise<string | null> {
  try {
    return await matchCustomerByEmail(db, desk.tenantId, email);
  } catch (err) {
    if (!isMissingCustomersSchema(err)) throw err;
    if (!customersMissingLogged) {
      customersMissingLogged = true;
      console.error("[support-intake.customers] migration bravo__188 not applied: tickets are not linked to client records");
    }
    return null;
  }
}

type Match = { client_tenant_id: string | null; project_id: string | null; client_match: string; customer_id: string | null };

async function matchRequester(db: Client, desk: SupportDesk, sub: SupportSubmission): Promise<Match> {
  if (desk.oasis) {
    const m: ClientMatch = await matchClientByEmail(db, sub.email, sub.project_hint);
    return { ...m, customer_id: await matchCustomer(db, desk, sub.email) };
  }
  // Any other desk: its own client records and projects. Its rows never name a
  // client workspace — that is OASIS's vendor relationship, not theirs.
  const [customerId, projectId] = await Promise.all([
    matchCustomer(db, desk, sub.email),
    matchDeskProjectByEmail(db, desk.tenantId, sub.email, sub.project_hint),
  ]);
  return {
    client_tenant_id: null,
    project_id: projectId,
    client_match: projectId ? "email_project" : "none",
    customer_id: customerId,
  };
}

async function createTicketFromSubmission(
  db: Client,
  desk: SupportDesk,
  input: { ticketId: string; submissionId: string; sub: SupportSubmission; attachments: Attachment[] },
  now: Date,
) {
  const { sub } = input;
  let match: Match;
  try {
    match = await matchRequester(db, desk, sub);
  } catch (err) {
    // Matching enriches the ticket; it must not cost the client their request.
    // Recorded on the ticket, so the founder sees "lookup failed", not "none".
    console.error("[support-intake] client match failed", err instanceof Error ? err.message : err);
    match = { client_tenant_id: null, project_id: null, client_match: "lookup_failed", customer_id: null };
  }
  // A ticket on a project belongs to that project's client record. The email
  // match can name another; the project wins here, because refusing would cost
  // the requester their request (Codex, PR #473). A failed lookup keeps the
  // email match, for the same reason (CodeRabbit, PR #473).
  let projectCustomer: string | null = null;
  if (match.project_id) {
    try {
      projectCustomer = await projectCustomerId(db, desk.tenantId, match.project_id);
    } catch (err) {
      console.error("[support-intake] project client lookup failed", err instanceof Error ? err.message : err);
    }
  }
  return createTicket(
    db,
    desk.tenantId,
    {
      id: input.ticketId,
      title: sub.title,
      description: sub.description,
      category: sub.category,
      severity: sub.severity,
      source: "form",
      project_id: match.project_id,
      client_tenant_id: match.client_tenant_id,
      client_name: sub.name,
      client_email: sub.email,
      client_company: sub.company,
      client_match: match.client_match,
      project_hint: sub.project_hint,
      reporter_user_id: null,
      assigned_to: null,
      attachments: input.attachments,
      form_submission_id: input.submissionId,
      customer_id: projectCustomer ?? match.customer_id,
    },
    now,
  );
}

/**
 * The safety net, run by the SLA cron, for every desk (OASIS's and each
 * registered workspace's).
 *   - A support submission with no ticket (the request died between recording
 *     the submission and creating the ticket) gets its ticket now, with the id
 *     it was always going to have.
 *   - A form ticket whose after() never ran (the instance was torn down) gets
 *     its notifications now. The claims make both no-ops for tickets that were
 *     already notified.
 */
export async function reconcileSupportIntake(
  db: Client,
  deps: NotifyDeps,
  now: Date,
): Promise<{ ticketsCreated: string[]; notificationsRetried: number; unparseable: string[] }> {
  const olderThan = new Date(now.getTime() - 2 * 60_000);
  const newerThan = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const desks = [OASIS_DESK, ...(await listRegisteredDesks(db))];
  const ticketsCreated: string[] = [];
  const unparseable: string[] = [];
  let notificationsRetried = 0;
  for (const desk of desks) {
    const orphans = await listUnticketedSupportSubmissions(db, desk.tenantId, SUPPORT_FORM_SLUG, olderThan, newerThan);
    for (const o of orphans) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(o.payload) as Record<string, unknown>;
      } catch {
        /* handled as unparseable below */
      }
      const parsed = parseSupportSubmission(payload);
      if (!parsed.ok) {
        console.error("[support-intake.reconcile] submission cannot become a ticket", { submission: o.id, error: parsed.error });
        unparseable.push(o.id);
        continue;
      }
      const ref = /^ticket:([0-9a-f-]{36})$/i.exec(o.lead_id);
      const attachments = Array.isArray(payload.attachment) ? (payload.attachment as Attachment[]) : [];
      const { ticket, created } = await createTicketFromSubmission(
        db,
        desk,
        { ticketId: ref ? ref[1] : randomUUID(), submissionId: o.id, sub: parsed.value, attachments },
        new Date(o.submitted_at),
      );
      if (created) ticketsCreated.push(ticket.ticket_number);
    }
    const pending = await listPendingIntakeNotifications(db, desk.tenantId, olderThan);
    for (const id of pending) await runIntakeNotifications(db, desk.tenantId, id, deps, now);
    notificationsRetried += pending.length;
  }
  return { ticketsCreated, notificationsRetried, unparseable };
}
