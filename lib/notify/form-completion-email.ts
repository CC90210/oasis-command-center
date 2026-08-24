/**
 * form-completion-email.ts — email the assigned agent + submissions@ when a
 * merchant completes a SunBiz form (1 interest / 2 full application / 3 bank
 * statements). Adon 2026-06-23: "the agent whose link they filled out, as well
 * as submissions@, should get an email notifying them."
 *
 * Complements the Telegram alert (sendSunbizLeadEvent), which only reaches
 * owner+admins who linked a chat id. This guarantees an EMAIL to the actual
 * assigned agent + the shared submissions@ inbox.
 *
 * CHANNEL (Adon 2026-08-24): the body now names HOW the application arrived
 * — Text, Dial, Email or Unknown — plus the link, with the HMAC token segment
 * REDACTED. The full-application URL is a bearer credential for that lead's
 * form; the channel is what actually answers "did this come from a text, a
 * call, or an email link", so the token is not mailed around to get it.
 *
 * It reports BOTH axes because they legitimately differ: a merchant found
 * through a text blast who applies from a drip email is origination=Text,
 * this-application=Email. Showing only one would misattribute the other.
 *
 * Internal/operator email (not merchant-facing) → no send-gate / CAN-SPAM
 * footer needed, same exemption as the B2B shop-out emails. Body carries the
 * business name + which form + agent + a lead link ONLY — no SSN/sensitive PII.
 * Fully soft-fail: runs inside Next `after()`; never throws into the submit.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantMembers } from "@/lib/team";
import { getSubmissionsCreds, getSubmissionsFrom } from "@/lib/integrations/submissions-gmail";
import {
  LEAD_SOURCE_LABELS,
  readLeadSource,
  normalizeLeadSource,
  LAST_SUBMITTED_VIA_KEY,
  LAST_SUBMITTED_LINK_KEY,
} from "@/lib/forms/lead-source";

const FORM_LABELS: Record<number, string> = {
  1: "the interest form (Form 1)",
  2: "the full application (Form 2)",
  3: "bank statements (Form 3)",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendFormCompletionEmail(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  formNumber: 1 | 2 | 3;
  origin?: string;
  /** Channel of THIS submission, resolved by the submit route. */
  submittedVia?: string;
  /** Link used, token already redacted. */
  submittedLink?: string;
}): Promise<void> {
  try {
    const { db, tenantId, leadId, formNumber } = input;
    const formLabel = FORM_LABELS[formNumber] || `Form ${formNumber}`;

    // Lead context (no sensitive fields pulled into the email).
    const leadRes = await db
      .from("tenant_records")
      .select("data")
      .eq("id", leadId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const leadData = (leadRes.data as { data?: Record<string, unknown> } | null)?.data || {};
    const business =
      (typeof leadData.business_name === "string" && leadData.business_name.trim()) ||
      (typeof leadData.business_legal_name === "string" && leadData.business_legal_name.trim()) ||
      "a merchant";
    const contact = typeof leadData.contact_name === "string" ? leadData.contact_name.trim() : "";
    const assignedTo = typeof leadData.assigned_to === "string" ? leadData.assigned_to : null;

    // Resolve the assigned agent's email + name.
    let agentEmail = "";
    let agentName = "";
    if (assignedTo) {
      const members = await getTenantMembers(tenantId).catch(() => []);
      const m = members.find((x) => x.auth_user_id === assignedTo);
      if (m) {
        agentEmail = EMAIL_RE.test((m.email || "").trim()) ? m.email.trim() : "";
        agentName = (m.display_name || m.full_name || "").trim();
      }
    }

    // From + submissions@ recipient via the tenant's gws credential.
    const creds = await getSubmissionsCreds(tenantId);
    const submissionsAddr = creds.fromAddress;
    const from = await getSubmissionsFrom(tenantId);
    const to = Array.from(new Set([agentEmail, submissionsAddr].filter((e) => EMAIL_RE.test(e))));
    if (to.length === 0) return;

    const link = input.origin ? `${input.origin}/t/sun?lead=${leadId}` : "";

    // How THIS application arrived. Prefer what the submit route just resolved;
    // fall back to what the lead carries, so a mid-funnel step with no query
    // string still reports the channel rather than going blank.
    const viaRaw =
      input.submittedVia ??
      (typeof leadData[LAST_SUBMITTED_VIA_KEY] === "string"
        ? (leadData[LAST_SUBMITTED_VIA_KEY] as string)
        : undefined);
    const via = normalizeLeadSource(viaRaw);
    const viaLabel = LEAD_SOURCE_LABELS[via];
    const usedLink =
      input.submittedLink ??
      (typeof leadData[LAST_SUBMITTED_LINK_KEY] === "string"
        ? (leadData[LAST_SUBMITTED_LINK_KEY] as string)
        : "");

    // Origination (first touch) is a different axis and both are reported.
    const originated = readLeadSource(leadData);
    const originatedLabel = LEAD_SOURCE_LABELS[originated];

    const subject = `New form completed — ${business} via ${viaLabel} (Form ${formNumber})`;
    const lines = [
      `${agentName ? `${agentName}'s lead` : "A lead"} just completed ${formLabel}.`,
      "",
      `Came in through: ${viaLabel}`,
      `Originally sourced from: ${originatedLabel}`,
      "",
      `Merchant: ${business}${contact ? ` — ${contact}` : ""}`,
      `Form: ${formLabel}`,
      `Agent: ${agentName || "(unassigned)"}`,
      ...(usedLink ? [`Link used: ${usedLink}`] : []),
      ...(link ? ["", `Open the lead: ${link}`] : []),
      "",
      "The signed part of a form link is redacted above on purpose — it grants",
      "access to that merchant's form. The channel is the part you need.",
      "",
      "— SunBiz automated notification",
    ];
    const text = lines.join("\n");

    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // STARTTLS
      requireTLS: true,
      auth: { user: creds.fromAddress, pass: creds.appPassword },
    });
    await transporter.sendMail({ from, to, subject, text });
  } catch (err) {
    console.error("[form-completion-email] threw", err instanceof Error ? err.message : String(err));
  }
}
