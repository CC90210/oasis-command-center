/**
 * next-steps-email.ts — the SunBiz funnel hand-off automations.
 *
 * Two transactional emails, sent from the connected SunBiz mailbox, signed by
 * the agent the lead is assigned to:
 *   - maybeSendNextStepsEmail        → after the interest form (step 1): ONE link
 *                                       to the full application (step 2).
 *   - maybeSendApplicationCompleteEmail → legacy fallback for old full-application
 *                                       forms that did not collect statements
 *                                       in-flow. Current SunBiz templates collect
 *                                       docs inside the full application.
 *
 * Why a NEW path instead of the old resume-email queue:
 * The form-submit route used to queue a `lead_interactions` row
 * (agent_source='form_intake_resume', type='email_queued') and rely on a
 * daemon to send it. But the dashboard-email-consumer daemon ONLY drains
 * agent_source='dashboard_drawer' rows — so even now that it runs on the VPS
 * (moved off Windows-only 2026-06-29), form_intake_resume rows aren't its job
 * and would sit at status='queued' forever — never sent.
 * (Verified 2026-06-17: 5/5 form_intake_resume rows stuck queued, 0 sent.)
 *
 * The proven path is the SAME one the lead-drawer email uses (27/27 sent):
 * the bridge `send_email` tool → send_gateway → SMTP from the tenant mailbox.
 * The form-submit route is PUBLIC (HMAC token, no session), so we resolve the
 * bridge target server-side (resolveBridgeTarget) and call the raw bridge with
 * the server-held bearer. The payload is fully server-templated (no
 * user-controlled command), so this is a trusted server-to-server send.
 *
 * intent='transactional': a direct response to the prospect's own submission,
 * so it bypasses the cold-outreach hygiene gates but still applies the CASL
 * footer + unsubscribe headers inside send_gateway. Because transactional
 * BYPASSES send_gateway's suppression gate, every sender below re-checks
 * email_suppressions FAIL-CLOSED before the address reaches the bridge.
 *
 * Idempotent per lead PER VARIANT: one next-steps email + one application-
 * complete email per lead. A returning merchant who re-submits is not re-mailed.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeTarget, callBridgeExecTool } from "@/lib/bridge-proxy";
import { getAgents } from "@/lib/config/agents";
import { getTenantMembers } from "@/lib/team";
import { mintFormLinkBySlug } from "@/lib/forms/agent-routing";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** agent_source tags — distinct per variant so the FAILURE-path marker + the
 *  idempotency check are clean and don't collide across the two emails. */
const NEXT_STEPS_SOURCE = "form_intake_next_steps";
const APP_COMPLETE_SOURCE = "form_intake_app_complete";

export type MaybeSendNextStepsInput = {
  db: SupabaseClient;
  /** Already-fetched form row. */
  form: { id: string; tenant_id: string; slug: string };
  /** Verified form-link payload (tenant slug, lead_id). */
  link: { tenant: string; lead_id: string };
  /** The just-submitted step's payload (for the email fallback). */
  payload: Record<string, unknown>;
  /** Request origin, for building absolute links. */
  origin: string;
};

type SignerCtx = { name: string; email: string; phone: string };

/**
 * Resolve the bridge target for the tenant + fire the send_email tool. Returns
 * a discriminated result so the caller can record send vs queued-fallback.
 * Best-effort: any failure returns {sent:false, reason} and the caller logs a
 * recoverable interaction the operator can see.
 */
async function sendViaBridge(input: {
  tenant: { slug: string; custom_fields: Record<string, unknown> | null };
  to: string;
  subject: string;
  body: string;
  brand?: string;
  leadId: string;
  signer: SignerCtx;
  /** Assigned-agent email to CC (so the rep whose form it was gets a copy). */
  cc?: string | null;
}): Promise<{ sent: boolean; reason?: string }> {
  const target = resolveBridgeTarget(input.tenant);
  if (!target) return { sent: false, reason: "bridge_not_configured" };

  // Mirror the lead-drawer send_email payload shape EXACTLY (proven path):
  // send_email params are top-level siblings of tool_name, not nested. The
  // bridge send_email tool runs `cc` through send_gateway.normalize_cc (header-
  // injection validated), so the CC value is forwarded safely.
  const toolBody: Record<string, unknown> = {
    tool_name: "send_email",
    to: input.to,
    subject: input.subject,
    body: input.body,
    lead_id: input.leadId,
    brand: input.brand,
    intent: "transactional",
    signer_name: input.signer.name,
  };
  if (input.signer.email) toolBody.signer_email = input.signer.email;
  if (input.signer.phone) toolBody.signer_phone = input.signer.phone;
  if (input.cc) toolBody.cc = input.cc;

  const r = await callBridgeExecTool(target, toolBody);
  if (!r.ok) {
    return { sent: false, reason: (r.error || r.output || `bridge_http_${r.httpStatus}`).slice(0, 200) };
  }
  // send_gateway returns its --json blob in `output`; status:"sent" means the
  // gates walked AND SMTP fired.
  try {
    const parsed = JSON.parse(r.output || "{}") as { status?: string; reason?: string };
    if (parsed.status === "sent") return { sent: true };
    return { sent: false, reason: `send_gateway status=${parsed.status || "unknown"}: ${parsed.reason || ""}`.slice(0, 200) };
  } catch {
    return { sent: false, reason: "bridge returned non-JSON output" };
  }
}

type AssignedAgent = SignerCtx & {
  /** Email to CC — non-null ONLY when authoritatively resolved from assigned_to.
   *  Never derived from the cached name, so we can't CC a stale/wrong rep. */
  ccEmail: string | null;
};

/**
 * Resolve the assigned agent for both the signature AND the CC, from the lead.
 *
 * `assigned_to` (auth_user_id) is AUTHORITATIVE. We resolve the tenant member by
 * it and use their real name + email. We deliberately do NOT use the cached
 * `assigned_agent_name` as a resolution source: the reassignment endpoint
 * updates assigned_to but leaves assigned_agent_name stale, so trusting the name
 * could CC the PREVIOUS rep and leak merchant details to the wrong internal
 * recipient. (Codex audit 2026-06-18 [high].)
 */
async function resolveAssignedAgent(
  tenantId: string,
  assignedTo: string | null,
  fallbackName: string,
): Promise<AssignedAgent> {
  const safeName = (fallbackName || "").trim() || "the SunBiz team";
  if (assignedTo) {
    try {
      const members = await getTenantMembers(tenantId);
      const member = members.find((x) => x.auth_user_id === assignedTo);
      const email = (member?.email || "").trim();
      if (email) {
        const name = (member?.display_name || member?.full_name || "").trim() || safeName;
        // Phone isn't on the member row — pull it from the signing roster by
        // EMAIL match (member email is the canonical address). Best-effort.
        let phone = "";
        try {
          const roster = getAgents();
          const r = roster.find((a) => a.email.trim().toLowerCase() === email.toLowerCase());
          if (r) phone = r.phone;
        } catch {
          /* roster read failed — phone stays blank, non-fatal */
        }
        return { name, email, phone, ccEmail: email };
      }
    } catch {
      // member lookup failed — fall through to name-only signer + no CC.
    }
  }
  // Unassigned / unresolvable: display name only, never a guessed CC.
  return { name: safeName, email: "", phone: "", ccEmail: null };
}

/** Subject prefixes per variant — used both as the literal subject base and to
 *  detect send_gateway's CANONICAL success row (whose agent_source is the
 *  gateway default 'manual_cc', not our source) for idempotency. Keep these
 *  lowercase + distinct; an inbound reply ("Re: …") never starts with them. */
const NEXT_STEPS_SUBJECT_PREFIX = "your next steps with ";
const APP_COMPLETE_SUBJECT_PREFIX = "we've received your application";

/**
 * Has an email of THIS variant already been recorded for this lead? One per lead
 * per variant. Two row shapes can mark a prior send (send_gateway ALWAYS logs
 * its own 'manual_cc' canonical row on success; this module logs its own row on
 * the FAILURE path): match either our `source` row or the gateway's success row
 * by the variant's subject prefix. (See the 2026-06-18 duplicate-timeline fix —
 * we no longer insert our own success row.)
 *
 * NB: deliberately NOT filtered on direction='outbound' — no send_gateway write
 * path explicitly stamps direction, so a filter could miss the success row and
 * let a re-submit re-send. channel='email' + the distinctive subject prefix is
 * enough.
 */
async function alreadySent(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
  source: string,
  subjectPrefix: string,
): Promise<boolean> {
  const res = await db
    .from("lead_interactions")
    .select("agent_source, subject")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("channel", "email")
    .limit(50);
  if (res.error) return false; // can't prove a prior send — let it through (send_gateway's own reservation dedup is the backstop)
  return (res.data ?? []).some(
    (r) =>
      r.agent_source === source ||
      (typeof r.subject === "string" &&
        r.subject.trim().toLowerCase().startsWith(subjectPrefix)),
  );
}

/** Resolved recipient + tenant + signer context shared by both senders. */
type HandoffContext = {
  toEmail: string;
  toName: string | null;
  tenant: { slug: string; custom_fields: Record<string, unknown> | null };
  brandLabel: string;
  brandSlug: string | undefined;
  signer: SignerCtx;
  ccEmail: string | null;
};

/**
 * Resolve the lead's contact email (+ name), enforce the fail-closed suppression
 * re-check, and resolve the tenant brand + the assigned agent (signer + CC).
 * Returns null when there's nothing safe/usable to send (no email, suppressed,
 * lookup error, or missing tenant) — the caller then no-ops. Shared by both
 * variants so the security posture (fail-closed suppression, authoritative
 * assigned-agent CC) is identical and lives in ONE place.
 */
async function loadHandoffContext(
  db: SupabaseClient,
  form: { id: string; tenant_id: string },
  link: { lead_id: string },
  payload: Record<string, unknown>,
): Promise<HandoffContext | null> {
  const leadRow = await db
    .from("tenant_records")
    .select("data")
    .eq("id", link.lead_id)
    .eq("tenant_id", form.tenant_id)
    .maybeSingle();
  const leadData =
    (leadRow.data as { data: Record<string, unknown> | null } | null)?.data ?? {};

  const toEmailRaw =
    (typeof leadData.email === "string" && leadData.email) ||
    (typeof payload.email === "string" && payload.email) ||
    "";
  const toEmail = toEmailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) return null; // no usable email — nothing to send

  // Honor unsubscribes even though this send is transactional (which bypasses
  // send_gateway's own suppression gate). FAIL CLOSED: any lookup error → do not
  // send. (Codex audit 2026-06-17 [high]: public relay must not fail open.)
  // Escape LIKE wildcards — `_`/`%` are valid in an email local-part.
  const suppPattern = toEmail.replace(/[%_\\]/g, "\\$&");
  const supp = await db
    .from("email_suppressions")
    .select("email")
    .eq("tenant_id", form.tenant_id)
    .ilike("email", suppPattern)
    .limit(1);
  if (supp.error) {
    console.error("[forms.handoff] suppression check errored — skipping (fail-closed)", {
      lead_id: link.lead_id,
      error: supp.error.message,
    });
    return null;
  }
  if ((supp.data?.length ?? 0) > 0) {
    console.log("[forms.handoff] recipient suppressed — skipping", { lead_id: link.lead_id });
    return null;
  }

  const tenantRow = await db
    .from("tenants")
    .select("slug, name, custom_fields")
    .eq("id", form.tenant_id)
    .maybeSingle();
  const tenant = tenantRow.data as
    | { slug: string; name: string | null; custom_fields: Record<string, unknown> | null }
    | null;
  if (!tenant) return null;
  const brandFromCustom =
    typeof tenant.custom_fields?.brand === "string" ? (tenant.custom_fields.brand as string) : null;
  const brandLabel = brandFromCustom || tenant.name || "SunBiz Funding";
  // send_gateway's `brand` key is the routing slug (sunbiz / oasis), not the label.
  const brandSlug = tenant.slug === "submissions" ? "sunbiz" : tenant.slug || undefined;

  const toName =
    (typeof leadData.contact_name === "string" && leadData.contact_name) ||
    (typeof leadData.name === "string" && leadData.name) ||
    (typeof payload.contact_name === "string" && payload.contact_name) ||
    (typeof payload.name === "string" && payload.name) ||
    null;
  const assignedTo = typeof leadData.assigned_to === "string" ? leadData.assigned_to : null;
  const fallbackName =
    (typeof leadData.assigned_agent_name === "string" && leadData.assigned_agent_name) ||
    "the SunBiz team";
  const agent = await resolveAssignedAgent(form.tenant_id, assignedTo, fallbackName);

  return {
    toEmail,
    toName,
    tenant: { slug: tenant.slug, custom_fields: tenant.custom_fields },
    brandLabel,
    brandSlug,
    signer: { name: agent.name, email: agent.email, phone: agent.phone },
    ccEmail: agent.ccEmail,
  };
}

/** Log the FAILURE-path marker (operator can see + resend). On SUCCESS we never
 *  insert — send_gateway logs its own canonical row (avoids the duplicate
 *  timeline entry CC reported 2026-06-18). */
async function logFailureMarker(
  db: SupabaseClient,
  form: { tenant_id: string },
  leadId: string,
  source: string,
  subject: string,
  body: string,
  toEmail: string,
  ccEmail: string | null,
  reason: string | undefined,
  extraMeta: Record<string, unknown>,
): Promise<void> {
  await db.from("lead_interactions").insert({
    tenant_id: form.tenant_id,
    lead_id: leadId,
    type: "email_queued",
    channel: "email",
    direction: "outbound",
    agent_source: source,
    subject: subject.slice(0, 200),
    content: body,
    content_preview: body.slice(0, 1024),
    to_email: toEmail,
    metadata: { status: "failed", sent_at: null, send_error: reason || "unknown", cc_email: ccEmail, intent: "transactional", ...extraMeta },
  });
}

/**
 * STEP 1 → STEP 2 hand-off: email the merchant ONE link to the full application
 * after they complete the interest form. Soft-fail; idempotent per lead.
 */
export async function maybeSendNextStepsEmail(input: MaybeSendNextStepsInput): Promise<void> {
  try {
    const { db, form, link, payload, origin } = input;
    const ctx = await loadHandoffContext(db, form, link, payload);
    if (!ctx) return;
    if (await alreadySent(db, form.tenant_id, link.lead_id, NEXT_STEPS_SOURCE, NEXT_STEPS_SUBJECT_PREFIX)) return;

    // CC 2026-06-22: form 1 points to form 2 ONLY (sequential funnel). The
    // bank-statement link is sent later, by maybeSendApplicationCompleteEmail.
    const fullAppUrl = await mintFormLinkBySlug(
      origin, form.tenant_id, link.tenant, link.lead_id, "full-application",
    );
    if (!fullAppUrl) {
      console.error("[forms.next_steps] full-application link did not resolve — skipping", { lead_id: link.lead_id });
      return;
    }

    const greeting = ctx.toName && ctx.toName.trim() ? `Hi ${ctx.toName.trim().split(/\s+/)[0]},` : "Hi there,";
    const subject = `Your next steps with ${ctx.brandLabel}`;
    const body = [
      greeting,
      "",
      `Thanks for reaching out to ${ctx.brandLabel}. The next step is your application — it takes about 5 minutes:`,
      "",
      "Complete your application:",
      fullAppUrl,
      "",
      "Your link is personalized to you — anything you've already told us is saved.",
      "",
      "Reply to this email if you have any questions and I'll help you through it.",
      "",
      `— ${ctx.signer.name}`,
      ctx.brandLabel,
    ].join("\n");

    const result = await sendViaBridge({
      tenant: ctx.tenant, to: ctx.toEmail, subject, body, brand: ctx.brandSlug,
      leadId: link.lead_id, signer: ctx.signer, cc: ctx.ccEmail,
    });
    if (!result.sent) {
      await logFailureMarker(db, form, link.lead_id, NEXT_STEPS_SOURCE, subject, body, ctx.toEmail, ctx.ccEmail, result.reason, {
        next_steps: true, full_application_url: fullAppUrl,
      });
      console.error("[forms.next_steps] send did not fire", { lead_id: link.lead_id, reason: result.reason });
    }
  } catch (err) {
    console.error("[forms.next_steps] threw", {
      lead_id: input.link.lead_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Legacy STEP 2 → STEP 3 follow-through: old full-application forms lacked an
 * in-flow upload step, so completion emailed one link to the bank-statement
 * upload. Current full-application templates collect documents in-flow and the
 * submit route skips this sender for those forms.
 */
export async function maybeSendApplicationCompleteEmail(input: MaybeSendNextStepsInput): Promise<void> {
  try {
    const { db, form, link, payload, origin } = input;
    const ctx = await loadHandoffContext(db, form, link, payload);
    if (!ctx) return;
    if (await alreadySent(db, form.tenant_id, link.lead_id, APP_COMPLETE_SOURCE, APP_COMPLETE_SUBJECT_PREFIX)) return;

    const bankUrl = await mintFormLinkBySlug(
      origin, form.tenant_id, link.tenant, link.lead_id, "bank-statement-upload",
    );
    if (!bankUrl) {
      console.error("[forms.app_complete] bank-statement link did not resolve — skipping", { lead_id: link.lead_id });
      return;
    }

    const greeting = ctx.toName && ctx.toName.trim() ? `Hi ${ctx.toName.trim().split(/\s+/)[0]},` : "Hi there,";
    const subject = `We've received your application — ${ctx.brandLabel}`;
    const body = [
      greeting,
      "",
      `Thanks — we've received your application with ${ctx.brandLabel}. There's one last step to start your funding review:`,
      "",
      "Upload your last few months of business bank statements:",
      bankUrl,
      "",
      "As soon as your statements are in, we begin reviewing right away. Your link is personalized to you.",
      "",
      "Reply to this email with any questions and I'll help you through it.",
      "",
      `— ${ctx.signer.name}`,
      ctx.brandLabel,
    ].join("\n");

    const result = await sendViaBridge({
      tenant: ctx.tenant, to: ctx.toEmail, subject, body, brand: ctx.brandSlug,
      leadId: link.lead_id, signer: ctx.signer, cc: ctx.ccEmail,
    });
    if (!result.sent) {
      await logFailureMarker(db, form, link.lead_id, APP_COMPLETE_SOURCE, subject, body, ctx.toEmail, ctx.ccEmail, result.reason, {
        application_complete: true, bank_statement_url: bankUrl,
      });
      console.error("[forms.app_complete] send did not fire", { lead_id: link.lead_id, reason: result.reason });
    }
  } catch (err) {
    console.error("[forms.app_complete] threw", {
      lead_id: input.link.lead_id, error: err instanceof Error ? err.message : String(err),
    });
  }
}
