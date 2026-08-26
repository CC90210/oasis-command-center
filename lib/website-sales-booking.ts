/**
 * website-sales-booking.ts — Qualified → founder-booking-link automation for
 * the OASIS Website Sales Engine.
 *
 * WHAT FIRES THIS
 * `updateRecord()` (lib/manifest/data.ts) runs `runStageTransitionHooks()` on
 * every record write; the composition root (lib/portals/stage-hooks.ts)
 * registers `runQualifiedBookingHandoff` there. It reacts ONLY to a lead
 * transitioning INTO stage `qualified` on the website-sales pipeline
 * (tenant `oasis-webdev` AND data.sales_program === "website_sales_v1" —
 * both must hold, so another tenant's lead that happens to carry the program
 * field can never receive OASIS-branded mail).
 *
 * WHAT IT DOES
 *   1. Emails the lead the Google founder-booking link (warm, short,
 *      references their business by name) — via `deliverWelcomeEmail`, the
 *      SAME transport/suppression/idempotency core the OASIS funnel welcome
 *      email uses (lib/forms/oasis-funnel-email.ts). Imported, not copied:
 *      that module's behavior is untouched.
 *   2. Notifies the founders on the operator Telegram lane that a qualified
 *      lead was handed off — ALWAYS, whatever happened to the email, because
 *      founders must know about every qualification.
 *   3. Stamps `data.booking_link_sent_at` / `data.booking_link_sent_to` so it
 *      can never double-send.
 *
 * GATES (all fail-closed)
 *   - transition INTO `qualified` on entity "lead"        → else no-op
 *   - data.sales_program === "website_sales_v1"           → else no-op
 *   - tenant slug === "oasis-webdev" (live lookup)        → else skip + log
 *   - data.booking_link_sent_at already set               → skip send (idempotent)
 *   - no usable email on the lead                         → skip send, log
 *     "no_email — rep books manually", founders still notified
 *   - env OASIS_QUALIFIED_BOOKING_EMAIL_LIVE !== "1"      → skip send, log
 *   - suppression list / per-(lead,source) idempotency    → inside
 *     deliverWelcomeEmail, both FAIL CLOSED
 *
 * RECURSION SAFETY
 * The idempotency stamp is written through the `patch_tenant_record_data`
 * RPC — the same path the website-sales rep-action route and
 * `close_website_deal` use. It is an atomic jsonb merge that never calls
 * `updateRecord`, so stamping from inside the hook cannot re-enter
 * `runStageTransitionHooks`.
 *
 * FAIL-SOFT
 * `runQualifiedBookingHandoff` never throws: a booking hiccup must not fail
 * the stage write. The composition root's own try/catch is the backstop.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverWelcomeEmail } from "@/lib/forms/oasis-funnel-email";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { sendTelegram } from "@/lib/notify/telegram";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { OASIS_WEBSITE_TENANT_SLUG } from "@/lib/website-sales-workflow";
import { OASIS_WEBSITE_SALES_PROGRAM } from "@/lib/oasis-sales-pipeline-policy";

const TAG = "[website-sales.booking]";

/** Same shape as oasis-funnel-email's (not exported there). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `agent_source` for the email deliverWelcomeEmail sends + records.
 * Deliberately DISTINCT from "website_sales_pipeline": deliverWelcomeEmail's
 * idempotency check treats ANY prior row under its source as "already sent",
 * and by the time a lead is qualified it already carries website_sales_pipeline
 * rows (dispositions, qualification) — sharing that source would suppress the
 * very first booking email. Same trap recordAlertFailure documents.
 */
const BOOKING_EMAIL_SOURCE = "website_sales_booking_link";

/** Ledger source — matches the partial unique index
 *  `website_sales_interaction_request_uidx` on
 *  (tenant_id, metadata->>'request_id') where agent_source='website_sales_pipeline'. */
const PIPELINE_SOURCE = "website_sales_pipeline";

/** Existing OASIS founder booking page — env-overridable, never absent. */
const DEFAULT_BOOKING_URL = "https://calendar.app.google/tpfvJYBGircnGu8G8";

/** Marker source for a failed founder alert. MUST NOT collide with any
 *  idempotency-checked source (see recordAlertFailure's contract). */
const ALERT_FAILURE_SOURCE = "website_sales_qualified_alert";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Structurally compatible with stage-hooks' RecordTransition — declared here
 *  rather than imported so the module graph stays acyclic (the composition
 *  root imports THIS file). */
export type BookingTransition = { field: string; from?: unknown; to?: unknown };

export type QualifiedBookingContext = {
  db: SupabaseClient;
  tenantId: string;
  entity: string;
  recordId: string;
  data: Record<string, unknown>;
  transitions: BookingTransition[];
};

/** PURE. True only for a transition INTO `qualified` on a lead. */
export function isQualifiedTransition(entity: string, transitions: BookingTransition[]): boolean {
  if (entity !== "lead") return false;
  return transitions.some(
    (t) => t.field === "stage" && t.to === "qualified" && t.from !== "qualified",
  );
}

/** PURE. The program gate — data-level half of the two-part tenant gate. */
export function isWebsiteSalesLead(data: Record<string, unknown>): boolean {
  return data.sales_program === OASIS_WEBSITE_SALES_PROGRAM;
}

export function bookingUrl(): string {
  const fromEnv = (
    process.env.NEXT_PUBLIC_BOOKING_URL ||
    process.env.NEXT_PUBLIC_FOUNDER_BOOKING_URL ||
    process.env.OASIS_FOUNDER_BOOKING_URL ||
    process.env.BOOKING_LINK ||
    ""
  ).trim();
  return fromEnv || DEFAULT_BOOKING_URL;
}

/**
 * PURE. The booking email. Plain text; deliverWelcomeEmail HTML-escapes the
 * body before wrapping it in the OASIS-branded template, so the link ships as
 * a raw URL on its own line (every major client auto-links it) — an <a> anchor
 * is not expressible through the reused, escaping transport, by design.
 * Sender identity ("Conaugh McKenna" + the OASIS footer block) comes from the
 * shared transport, identical to the funnel welcome email.
 */
export function buildBookingEmail(input: {
  firstName: string;
  company: string;
  bookingUrl: string;
}): { subject: string; body: string } {
  const { firstName, company, bookingUrl } = input;
  return {
    subject: "Your website game plan call — pick a time",
    body:
      `Hey ${firstName},\n\n` +
      `You just spoke with our team, and ${company} is exactly the kind of business we do our best work for. ` +
      `The next step is a short Google Meet call with one of our founders — we'll walk through exactly what we'd build for ${company} and what it would change for you.\n\n` +
      `Pick a time that works here:\n${bookingUrl}\n\n` +
      `Talk soon,\n— CC`,
  };
}

type EmailOutcome =
  | { kind: "sent"; to: string }
  | { kind: "already_sent" }
  | { kind: "no_email" }
  | { kind: "env_gate_off"; to: string }
  | { kind: "suppressed"; to: string }
  | { kind: "failed"; to: string; reason: string };

function outcomeLine(o: EmailOutcome): string {
  switch (o.kind) {
    case "sent":
      return `sent to ${o.to}`;
    case "already_sent":
      return "not re-sent — this lead already got the booking email";
    case "no_email":
      return "skipped — no email on file, rep books manually";
    case "env_gate_off":
      return "skipped — OASIS_QUALIFIED_BOOKING_EMAIL_LIVE is off";
    case "suppressed":
      return "skipped — address is on the suppression list";
    case "failed":
      return `FAILED (${o.reason}) — rep books manually`;
  }
}

/** Tenant-slug half of the gate. Fail-closed: lookup error reads as "not the
 *  website-sales tenant" (same shape as lead-stage-dispatcher's tenantSlugFor). */
async function tenantSlugFor(db: SupabaseClient, tenantId: string): Promise<string | null> {
  try {
    const r = await db.from("tenants").select("slug").eq("id", tenantId).maybeSingle();
    if (r.error) {
      console.error(`${TAG} tenant slug lookup errored — skipping (fail-closed)`, {
        tenant_id: tenantId,
        error: r.error.message,
      });
      return null;
    }
    return (r.data?.slug || null) as string | null;
  } catch (err) {
    console.error(`${TAG} tenant slug lookup threw — skipping (fail-closed)`, {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Best-effort display name for the rep who owns the lead. Never throws. */
async function repNameFor(
  db: SupabaseClient,
  tenantId: string,
  authUserId: string,
): Promise<string> {
  if (!authUserId) return "unassigned";
  try {
    const r = await db
      .from("user_profiles")
      .select("display_name, full_name, email")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    const p = r.data as { display_name?: string; full_name?: string; email?: string } | null;
    return p?.display_name || p?.full_name || p?.email || authUserId;
  } catch {
    return authUserId;
  }
}

/**
 * The gated send. Returns an outcome, never throws.
 *
 * Idempotency is layered:
 *   1. data.booking_link_sent_at (checked by the caller before this runs;
 *      stamped below via patch_tenant_record_data on success).
 *   2. deliverWelcomeEmail's per-(lead, BOOKING_EMAIL_SOURCE) interaction
 *      check — FAIL CLOSED — which still blocks a resend if the stamp write
 *      itself failed.
 *   3. The website_sales_pipeline ledger row's deterministic
 *      request_id `booking-link-<leadId>` under the existing partial unique
 *      index, so the DB itself refuses a second "booking_link_sent" record.
 */
async function sendBookingEmail(ctx: QualifiedBookingContext, toEmail: string): Promise<EmailOutcome> {
  const { db, tenantId, recordId, data } = ctx;

  // Env gate — fail closed. Structured log so the skip is visible in Vercel logs.
  if (process.env.OASIS_QUALIFIED_BOOKING_EMAIL_LIVE !== "1") {
    console.log(`${TAG} send skipped — OASIS_QUALIFIED_BOOKING_EMAIL_LIVE != "1"`, {
      lead_id: recordId,
      tenant_id: tenantId,
      would_send_to: toEmail,
    });
    return { kind: "env_gate_off", to: toEmail };
  }

  const firstName = (str(data.contact_name) || str(data.name)).split(" ")[0] || "there";
  const company = str(data.company) || str(data.business_name) || "your business";
  const url = bookingUrl();
  const { subject, body } = buildBookingEmail({ firstName, company, bookingUrl: url });

  // Reused core: EMAIL_RE, per-(lead,source) idempotency (fail-closed),
  // suppression (fail-closed), Gmail credential guard, transport, HTML wrap,
  // and its own lead_interactions audit row under BOOKING_EMAIL_SOURCE.
  const result = await deliverWelcomeEmail({
    db,
    tenantId,
    leadId: recordId,
    toEmail,
    source: BOOKING_EMAIL_SOURCE,
    subject,
    body,
  });

  if (!result.sent) {
    if (result.reason === "already_sent") return { kind: "already_sent" };
    if (result.reason === "suppressed") return { kind: "suppressed", to: toEmail };
    return { kind: "failed", to: toEmail, reason: result.reason || "unknown" };
  }

  // Stamp FIRST (primary idempotency gate), ledger second. Atomic jsonb merge
  // via RPC — never updateRecord, so no hook re-entry. A failed stamp is loud
  // but not fatal: layer 2 above still blocks a resend.
  const stamp = await db.rpc("patch_tenant_record_data", {
    p_id: recordId,
    p_tenant_id: tenantId,
    p_patch: {
      booking_link_sent_at: new Date().toISOString(),
      booking_link_sent_to: toEmail,
    },
  });
  if (stamp.error) {
    console.error(`${TAG} idempotency stamp FAILED — resend stays blocked by the interaction ledger`, {
      lead_id: recordId,
      tenant_id: tenantId,
      error: stamp.error.message,
    });
  }

  // Pipeline ledger row — the same audit trail the rep-action route writes,
  // with a DETERMINISTIC request_id so the partial unique index makes
  // "booking link sent" recordable exactly once per lead.
  const requestId = `booking-link-${recordId}`;
  const ledger = await db.from("lead_interactions").insert({
    tenant_id: tenantId,
    lead_id: recordId,
    type: "booking_link_sent",
    channel: "email",
    direction: "outbound",
    agent_source: PIPELINE_SOURCE,
    subject: "Founder booking link sent",
    content: `Booking link emailed to ${toEmail} after qualification. URL: ${url}`,
    content_preview: "booking_link_sent",
    to_email: toEmail,
    metadata: {
      request_id: requestId,
      correlation_id: requestId,
      action: "booking_link_email",
      booking_url: url,
    },
  });
  if (ledger.error) {
    if (isUniqueViolationError(ledger.error)) {
      console.warn(`${TAG} ledger row already exists (idempotent)`, { lead_id: recordId });
    } else {
      console.error(`${TAG} ledger insert failed`, {
        lead_id: recordId,
        error: ledger.error.message,
      });
    }
  }

  return { kind: "sent", to: toEmail };
}

/** Founder notification — operator Telegram lane, HTML-escaped user data.
 *  Failure leaves a durable marker on the lead's timeline (recordAlertFailure)
 *  rather than only a console line. Never throws. */
async function notifyFounders(
  ctx: QualifiedBookingContext,
  outcome: EmailOutcome,
): Promise<void> {
  const { db, tenantId, recordId, data } = ctx;
  const e = escapeTelegramHtml;
  const name = str(data.contact_name) || str(data.name) || "Unknown contact";
  const company = str(data.company) || str(data.business_name);
  const phone = str(data.phone);
  const email = str(data.email);
  const repName = await repNameFor(db, tenantId, str(data.assigned_to));

  const text =
    `🤝 <b>Qualified lead — website sales</b>\n\n` +
    `<b>${e(name)}</b>${company ? ` — ${e(company)}` : ""}\n` +
    (email ? `📧 ${e(email)}\n` : `📧 no email on file\n`) +
    (phone ? `📱 ${e(phone)}\n` : "") +
    `Qualified by: ${e(repName)}\n\n` +
    `Booking email: ${e(outcomeLine(outcome))}`;

  try {
    const r = await sendTelegram(text, { lane: "operator" });
    if (r.ok) return;
    console.error(`${TAG} founder notify failed:`, r.reason);
    await recordAlertFailure({
      db,
      tenantId,
      leadId: recordId,
      source: ALERT_FAILURE_SOURCE,
      label: "website-sales qualification",
      reason: r.reason ?? "unknown",
      extra: `Booking email outcome: ${outcomeLine(outcome)}.`,
      tag: "website-sales.booking",
    });
  } catch (err) {
    console.error(`${TAG} founder notify threw`, {
      lead_id: recordId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The hook body the composition root registers. Runs the gate ladder, then
 * the email, then the founder notify (always). Never throws.
 */
export async function runQualifiedBookingHandoff(ctx: QualifiedBookingContext): Promise<void> {
  try {
    // Gate 1+2: a lead transitioning INTO qualified.
    if (!isQualifiedTransition(ctx.entity, ctx.transitions)) return;
    // Gate 3: the website-sales program, on its data.
    if (!isWebsiteSalesLead(ctx.data)) return;
    // Gate 4: the website-sales tenant, by live slug lookup. Fail-closed.
    const slug = await tenantSlugFor(ctx.db, ctx.tenantId);
    if (slug !== OASIS_WEBSITE_TENANT_SLUG) {
      console.log(`${TAG} skipped — tenant is not ${OASIS_WEBSITE_TENANT_SLUG}`, {
        lead_id: ctx.recordId,
        tenant_id: ctx.tenantId,
        slug,
      });
      return;
    }

    // Decide the email outcome (each branch logs its own skip).
    let outcome: EmailOutcome;
    const alreadyAt = ctx.data.booking_link_sent_at;
    const toEmail = str(ctx.data.email).trim().toLowerCase();
    if (typeof alreadyAt === "string" && alreadyAt) {
      // Gate 5: idempotency stamp. A re-qualified lead is NOT re-emailed,
      // but founders still hear about the qualification below.
      console.log(`${TAG} already sent — skipping`, {
        lead_id: ctx.recordId,
        booking_link_sent_at: alreadyAt,
      });
      outcome = { kind: "already_sent" };
    } else if (!EMAIL_RE.test(toEmail)) {
      // Gate 6: no usable address.
      console.log(`${TAG} no_email — rep books manually`, {
        lead_id: ctx.recordId,
        tenant_id: ctx.tenantId,
      });
      outcome = { kind: "no_email" };
    } else {
      // Gates 7-9 (env, suppression, per-source idempotency) live inside.
      try {
        outcome = await sendBookingEmail(ctx, toEmail);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`${TAG} send threw`, { lead_id: ctx.recordId, error: reason });
        outcome = { kind: "failed", to: toEmail, reason };
      }
    }

    // Founders must know about EVERY qualification, whatever the email did.
    await notifyFounders(ctx, outcome);
  } catch (err) {
    // Belt to the composition root's braces: a booking hiccup must never
    // fail the stage write.
    console.error(`${TAG} hook threw`, {
      lead_id: ctx.recordId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
