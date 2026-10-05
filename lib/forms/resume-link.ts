/**
 * forms/resume-link.ts — Build A from the 2026-06-06 product-feature plan.
 *
 * After a prospect submits step 0 of a multi-step public form, we email
 * them a tokenized "resume your application / upload documents" link.
 * Two reasons:
 *
 *   1. Funding deals stall when a prospect closes the tab between
 *      step 1 (basic info) and step 2 (4 months of bank statements +
 *      DL/VC). A direct resume link sidesteps "now where was that
 *      website…" friction.
 *   2. The link is HMAC-signed and pre-matched to the merchant — when
 *      they click, the form is pre-filled from their step-0 payload, so
 *      they only fill in what's left.
 *
 * Architecture: this module is the **mint + queue** layer. It does NOT
 * send the email directly — per ADR-0003 all outbound MUST route
 * through send_gateway.py (the on-host CASL + cooldown + daily-cap
 * chokepoint). The queue shape mirrors /api/leads/[id]/email (the
 * proven pattern):
 *
 *   1. Insert lead_interactions row with type='email_queued'
 *   2. Emit BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD agent event
 *   3. send_gateway picks it up, sends from the tenant's GMAIL_USER
 *      identity, marks status='sent'
 *
 * Idempotency: a single (form_id, lead_id) pair gets ONE resume email.
 * Re-submitting step 0 doesn't re-trigger. Enforced by checking
 * lead_interactions metadata.resume_form_id before inserting.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signFormLink } from "@/lib/form-links";
import { publishAgentEvent } from "@/lib/manifest/events";
import { publicFormOrigin } from "@/lib/forms/public-origin";

/** Tenant context needed for the email body branding + the link URL. */
export type ResumeEmailTenantCtx = {
  tenant_id: string;
  tenant_slug: string;
  /** Display brand for subject + signature ("SunBiz Funding", "OASIS AI", …). */
  brand: string;
  /** Send identity (e.g. "submissions@sunbizfunding.com"); the daemon decides
   *  the real From: but we put it in metadata so the audit log knows. */
  from_email?: string;
};

export type QueueResumeEmailInput = {
  db: SupabaseClient;
  tenant: ResumeEmailTenantCtx;
  /** UUID of the lead the resume link is bound to. */
  lead_id: string;
  /** UUID of the form they started filling. */
  form_id: string;
  /** Slug of the form — second path segment of the public URL. */
  form_slug: string;
  /** Display name of the form (e.g. "Funding Application"). */
  form_label?: string | null;
  /** Recipient email — captured from step 0 payload. */
  to_email: string;
  /** Recipient name — for greeting. Optional. */
  to_name?: string | null;
  /** Public app base URL (no trailing slash). Falls back to PUBLIC_APP_URL env. */
  app_base_url?: string;
};

export type QueueResumeEmailResult =
  | { ok: true; interaction_id: string; resume_url: string; skipped?: false }
  | { ok: true; skipped: true; reason: "already_queued" | "email_invalid" }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Look up an existing resume-email interaction so we don't re-fire on
 * step 1, step 2, etc. (the user re-submits step 0 only on a rare
 * "back" / refresh.) Matches on the metadata.resume_form_id we set on
 * the first send.
 */
async function alreadyQueued(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  formId: string,
): Promise<boolean> {
  const res = await db
    .from("lead_interactions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("channel", "email")
    // We tag the metadata with resume_form_id when we mint the resume
    // email. PostgREST JSON path syntax lets us filter on that.
    .filter("metadata->>resume_form_id", "eq", formId)
    .limit(1);
  return !res.error && (res.data?.length ?? 0) > 0;
}

/** Build the public resume URL. The path matches the existing personalized
 *  form route at app/f/[tenant_slug]/[form_slug]/[lead_token]. */
export function buildResumeUrl(input: {
  appBaseUrl: string;
  tenantSlug: string;
  formSlug: string;
  token: string;
}): string {
  const base = input.appBaseUrl.replace(/\/+$/, "");
  return `${base}/f/${encodeURIComponent(input.tenantSlug)}/${encodeURIComponent(input.formSlug)}/${input.token}`;
}

/** Render a plain-text email body. Plain-text is the right primitive
 *  because send_gateway's send_email tool ships both plaintext and a
 *  minimal HTML wrap by default. Keep it short — funding prospects
 *  don't read marketing copy. */
function renderResumeBody(input: {
  brand: string;
  to_name?: string | null;
  form_label?: string | null;
  resume_url: string;
}): { subject: string; body: string } {
  const subject = `Finish your ${input.form_label || "application"} — ${input.brand}`;
  const greeting = input.to_name && input.to_name.trim()
    ? `Hi ${input.to_name.trim().split(/\s+/)[0]},`
    : "Hi there,";
  const formLabel = input.form_label || "application";
  const body = [
    greeting,
    "",
    `Thanks for starting your ${formLabel} with ${input.brand}.`,
    "Pick up where you left off here — your previous answers are saved:",
    "",
    input.resume_url,
    "",
    "If you have the documents handy (bank statements, ID, voided check), uploading them takes about 2 minutes.",
    "",
    "If this email reached you by mistake, reply to let us know and we'll clear your file.",
    "",
    `— ${input.brand}`,
  ].join("\n");
  return { subject, body };
}

/**
 * Mint a fresh form-link token for the lead, queue the resume email
 * via send_gateway. Idempotent on (form_id, lead_id).
 */
export async function queueResumeEmail(
  input: QueueResumeEmailInput,
): Promise<QueueResumeEmailResult> {
  const toEmail = input.to_email.trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) {
    return { ok: true, skipped: true, reason: "email_invalid" };
  }
  if (await alreadyQueued(input.db, input.tenant.tenant_id, input.lead_id, input.form_id)) {
    return { ok: true, skipped: true, reason: "already_queued" };
  }

  // Mint a fresh token. The dashboard already has one (from anonymous_init
  // or Solara's mint), but we want a CLEAN one issued NOW so the TTL
  // window starts at the prospect's actual conversion moment, not at the
  // original anonymous landing. Defense-in-depth: even if the
  // anonymous-init token leaks, this fresh one is what the email
  // recipient uses.
  const token = signFormLink({
    tenant: input.tenant.tenant_slug,
    form_id: input.form_id,
    lead_id: input.lead_id,
  });
  if (token === null) {
    return { ok: false, error: "form_links_subsystem_unconfigured" };
  }

  const appBaseUrl = publicFormOrigin({
    tenantSlug: input.tenant.tenant_slug,
    requestOrigin: input.app_base_url,
  });
  const resumeUrl = buildResumeUrl({
    appBaseUrl,
    tenantSlug: input.tenant.tenant_slug,
    formSlug: input.form_slug,
    token,
  });

  const { subject, body } = renderResumeBody({
    brand: input.tenant.brand,
    to_name: input.to_name,
    form_label: input.form_label,
    resume_url: resumeUrl,
  });

  const ins = await input.db
    .from("lead_interactions")
    .insert({
      tenant_id: input.tenant.tenant_id,
      lead_id: input.lead_id,
      type: "email_queued",
      channel: "email",
      direction: "outbound",
      // No human queued this — the form-submit handler did.
      agent_source: "form_intake_resume",
      subject: subject.slice(0, 200),
      content: body,
      content_preview: body.slice(0, 1024),
      to_email: toEmail,
      metadata: {
        // Idempotency key — alreadyQueued() filters on this.
        resume_form_id: input.form_id,
        resume_url: resumeUrl,
        // The send_gateway daemon looks at status to know what's
        // pending. Identical shape to /api/leads/[id]/email.
        status: "queued",
        // Optional from-identity hint for the daemon.
        from_email_hint: input.tenant.from_email || null,
      },
    })
    .select("id")
    .single();
  if (ins.error) {
    return { ok: false, error: `queue_failed: ${ins.error.message}` };
  }

  const interactionId = (ins.data as { id: string }).id;

  // Wake the daemon now via the event bus rather than waiting for its
  // poll cycle. Non-fatal — daemon's fallback poll catches it within
  // ~30 s either way.
  await publishAgentEvent({
    eventType: "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD",
    tenantId: input.tenant.tenant_id,
    publisher: "dashboard",
    targetAgent: "send_gateway",
    payload: {
      lead_id: input.lead_id,
      interaction_id: interactionId,
      channel: "email",
      to_email: toEmail,
      reason: "form_resume",
    },
  });

  return { ok: true, interaction_id: interactionId, resume_url: resumeUrl };
}
