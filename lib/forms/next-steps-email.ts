/**
 * next-steps-email.ts — the SunBiz interest-form handoff automation.
 *
 * WHAT / WHY:
 * When a prospect submits the short interest form (initial-lead-capture), they
 * should immediately receive ONE email — from the connected SunBiz mailbox —
 * with the links to continue: step 2 (the full application) and step 3 (the
 * bank-statement upload), signed by the agent the lead is assigned to.
 *
 * Why this exists as a NEW path instead of the old resume-email queue:
 * The form-submit route used to queue a `lead_interactions` row
 * (agent_source='form_intake_resume', type='email_queued') and rely on a
 * daemon to send it. But the dashboard-email-consumer daemon ONLY drains
 * agent_source='dashboard_drawer' AND is Windows-gated in ecosystem.config.js,
 * so on the SunBiz VPS those rows sat at status='queued' forever — never sent.
 * (Verified 2026-06-17: 5/5 form_intake_resume rows stuck queued, 0 sent,
 * including the operator's own test submission.)
 *
 * The proven path is the SAME one the lead-drawer email uses (27/27 sent):
 * the bridge `send_email` tool → send_gateway → SMTP from the tenant mailbox.
 * The lead-drawer route reaches it through the session-gated
 * /api/bridge/exec-tool proxy — but the form-submit route is PUBLIC (HMAC
 * token, no session), so we resolve the bridge target server-side
 * (resolveBridgeTarget) and call the raw bridge with the server-held bearer.
 * The payload is fully server-templated (no user-controlled command), so this
 * is a trusted server-to-server send, not an arbitrary-exec surface.
 *
 * intent='transactional': this is a direct response to the prospect's own
 * submission (their next application steps), so it bypasses the cold-outreach
 * hygiene gates but still applies the CASL footer + unsubscribe headers inside
 * send_gateway.
 *
 * Idempotent per lead: one next-steps email per lead. A returning merchant who
 * re-submits (smart-matched into their existing lead) is not re-emailed.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBridgeTarget, callBridgeExecTool } from "@/lib/bridge-proxy";
import { getAgents } from "@/lib/config/agents";
import { getTenantMembers } from "@/lib/team";
import { mintFormLinkBySlug } from "@/lib/forms/agent-routing";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** agent_source tag for the interest-form handoff email — distinct from the
 *  operator drawer ('dashboard_drawer') and the legacy resume queue
 *  ('form_intake_resume') so it's auditable + the idempotency check is clean. */
const NEXT_STEPS_SOURCE = "form_intake_next_steps";

export type MaybeSendNextStepsInput = {
  db: SupabaseClient;
  /** Already-fetched form row (must be the interest/entry form). */
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
 * (app/api/leads/[id]/assign) updates assigned_to but leaves
 * assigned_agent_name stale, so trusting the name could CC the PREVIOUS rep and
 * leak merchant details to the wrong internal recipient. (Codex audit
 * 2026-06-18 [high].)
 *
 * Precedence:
 *   - assigned_to resolves to a member → sign as that member (name + email),
 *     enrich phone from the roster by EMAIL match, and CC that member's email.
 *   - assigned_to null OR unresolvable → sign with the cached name as a
 *     display-only fallback (so the signature never renders blank) and CC
 *     NOBODY (ccEmail=null). We never guess a CC recipient.
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

/** Render the plain-text handoff email. Short + direct — funding prospects
 *  skim. Includes whichever of the two next-step links resolved. */
function renderBody(input: {
  brand: string;
  toName: string | null;
  agentName: string;
  fullAppUrl: string | null;
  bankStatementUrl: string | null;
}): { subject: string; body: string } {
  const greeting = input.toName && input.toName.trim()
    ? `Hi ${input.toName.trim().split(/\s+/)[0]},`
    : "Hi there,";

  const lines: string[] = [
    greeting,
    "",
    `Thanks for reaching out to ${input.brand}. To get your funding moving, here are your next two steps — they take about 5 minutes:`,
    "",
  ];
  let n = 1;
  if (input.fullAppUrl) {
    lines.push(`Step ${n}. Complete your application:`, input.fullAppUrl, "");
    n += 1;
  }
  if (input.bankStatementUrl) {
    lines.push(`Step ${n}. Upload your last few months of bank statements:`, input.bankStatementUrl, "");
    n += 1;
  }
  lines.push(
    "Your links are personalized to you — anything you've already told us is saved.",
    "",
    "Reply to this email if you have any questions and I'll help you through it.",
    "",
    `— ${input.agentName}`,
    input.brand,
  );
  const subject = `Your next steps with ${input.brand}`;
  return { subject, body: lines.join("\n") };
}

/** Has a next-steps email already been recorded for this lead? One per lead. */
async function alreadySent(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<boolean> {
  const res = await db
    .from("lead_interactions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .eq("agent_source", NEXT_STEPS_SOURCE)
    .limit(1);
  return !res.error && (res.data?.length ?? 0) > 0;
}

/**
 * Send the interest-form handoff email (step 2 + step 3 links) for a lead.
 * Soft-fail: every error is caught + logged; never aborts the submission.
 * Caller guarantees this is the interest/entry form on step 0.
 */
export async function maybeSendNextStepsEmail(
  input: MaybeSendNextStepsInput,
): Promise<void> {
  try {
    const { db, form, link, payload, origin } = input;

    // Resolve the lead's stored contact + assignment.
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
    if (!EMAIL_RE.test(toEmail)) return; // no usable email — nothing to send

    if (await alreadySent(db, form.tenant_id, link.lead_id)) return;

    // Honor unsubscribes even though this send is transactional. A PUBLIC form
    // must never become a relay that re-emails someone who opted out — and
    // intent='transactional' bypasses send_gateway's own suppression gate, so
    // we re-check here against the dashboard's email_suppressions table before
    // the address ever reaches the bridge. (Codex audit 2026-06-17 [high]:
    // public relay / suppression-bypass.) Case-insensitive on email; any
    // suppression for this (email, tenant) — regardless of brand — blocks.
    // Escape LIKE wildcards: `_` and `%` are valid in an email local-part
    // (john_doe@…), and ilike would otherwise treat them as pattern
    // metacharacters. Match the recipient LITERALLY (case-insensitive). Same
    // escape the lead matcher uses (agent-routing.ts).
    const suppPattern = toEmail.replace(/[%_\\]/g, "\\$&");
    const supp = await db
      .from("email_suppressions")
      .select("email")
      .eq("tenant_id", form.tenant_id)
      .ilike("email", suppPattern)
      .limit(1);
    // FAIL CLOSED. If the suppression lookup errors we cannot prove the address
    // is safe to email, so we do NOT send — a gate that fails open would let an
    // opted-out recipient through on any transient DB/RLS error. (Codex audit
    // 2026-06-17 re-verify [high]: suppression check must not fail open.)
    if (supp.error) {
      console.error("[forms.submit.next_steps] suppression check errored — skipping (fail-closed)", {
        lead_id: link.lead_id,
        error: supp.error.message,
      });
      return;
    }
    if ((supp.data?.length ?? 0) > 0) {
      console.log("[forms.submit.next_steps] recipient suppressed — skipping", {
        lead_id: link.lead_id,
      });
      return;
    }

    // Tenant context — slug + custom_fields for bridge resolution, name +
    // brand for the email copy.
    const tenantRow = await db
      .from("tenants")
      .select("slug, name, custom_fields")
      .eq("id", form.tenant_id)
      .maybeSingle();
    const tenant = tenantRow.data as
      | { slug: string; name: string | null; custom_fields: Record<string, unknown> | null }
      | null;
    if (!tenant) return;
    const brandFromCustom =
      typeof tenant.custom_fields?.brand === "string"
        ? (tenant.custom_fields.brand as string)
        : null;
    const brandLabel = brandFromCustom || tenant.name || "SunBiz Funding";
    // send_gateway's `brand` key is the routing slug (sunbiz / oasis), not the
    // display label.
    const brandSlug = tenant.slug === "submissions" ? "sunbiz" : tenant.slug || undefined;

    // Mint the two next-step links. Either may be null (form missing/disabled
    // or signing unconfigured) — we send with whatever resolved; skip entirely
    // if neither did (a link-less "next steps" email is useless).
    const [fullAppUrl, bankStatementUrl] = await Promise.all([
      mintFormLinkBySlug(origin, form.tenant_id, link.tenant, link.lead_id, "full-application"),
      mintFormLinkBySlug(origin, form.tenant_id, link.tenant, link.lead_id, "bank-statement-upload"),
    ]);
    if (!fullAppUrl && !bankStatementUrl) {
      console.error("[forms.submit.next_steps] no next-step links resolved — skipping", {
        lead_id: link.lead_id,
      });
      return;
    }

    const toName =
      (typeof leadData.contact_name === "string" && leadData.contact_name) ||
      (typeof leadData.name === "string" && leadData.name) ||
      (typeof payload.contact_name === "string" && payload.contact_name) ||
      (typeof payload.name === "string" && payload.name) ||
      null;
    // Resolve the assigned rep for BOTH the signature and the CC. assigned_to
    // (auth_user_id) is authoritative; the cached assigned_agent_name is only a
    // display fallback (never a CC source) — see resolveAssignedAgent.
    const assignedTo =
      typeof leadData.assigned_to === "string" ? leadData.assigned_to : null;
    const fallbackName =
      (typeof leadData.assigned_agent_name === "string" && leadData.assigned_agent_name) ||
      "the SunBiz team";
    const agent = await resolveAssignedAgent(form.tenant_id, assignedTo, fallbackName);
    const signer: SignerCtx = { name: agent.name, email: agent.email, phone: agent.phone };
    const ccEmail = agent.ccEmail;

    const { subject, body } = renderBody({
      brand: brandLabel,
      toName,
      agentName: agent.name,
      fullAppUrl,
      bankStatementUrl,
    });

    const result = await sendViaBridge({
      tenant: { slug: tenant.slug, custom_fields: tenant.custom_fields },
      to: toEmail,
      subject,
      body,
      brand: brandSlug,
      leadId: link.lead_id,
      signer,
      cc: ccEmail,
    });

    // Record the interaction for the lead timeline + idempotency. When the
    // bridge send fired we log type='email_sent'; when it didn't (bridge
    // offline / gate refused), log a 'queued'-status row the operator can see
    // and resend from the drawer rather than silently dropping it.
    await db.from("lead_interactions").insert({
      tenant_id: form.tenant_id,
      lead_id: link.lead_id,
      type: result.sent ? "email_sent" : "email_queued",
      channel: "email",
      direction: "outbound",
      agent_source: NEXT_STEPS_SOURCE,
      subject: subject.slice(0, 200),
      content: body,
      content_preview: body.slice(0, 1024),
      to_email: toEmail,
      metadata: {
        status: result.sent ? "sent" : "failed",
        sent_at: result.sent ? new Date().toISOString() : null,
        send_error: result.sent ? null : result.reason || "unknown",
        next_steps: true,
        full_application_url: fullAppUrl,
        bank_statement_url: bankStatementUrl,
        cc_email: ccEmail,
        intent: "transactional",
      },
    });

    if (!result.sent) {
      console.error("[forms.submit.next_steps] send did not fire", {
        lead_id: link.lead_id,
        reason: result.reason,
      });
    } else {
      console.log("[forms.submit.next_steps] sent", {
        lead_id: link.lead_id,
        to: toEmail,
      });
    }
  } catch (err) {
    console.error("[forms.submit.next_steps] threw", {
      lead_id: input.link.lead_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
