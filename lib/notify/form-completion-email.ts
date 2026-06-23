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
 * Internal/operator email (not merchant-facing) → no send-gate / CAN-SPAM
 * footer needed, same exemption as the B2B shop-out emails. Body carries the
 * business name + which form + agent + a lead link ONLY — no SSN/sensitive PII.
 * Fully soft-fail: runs inside Next `after()`; never throws into the submit.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantMembers } from "@/lib/team";
import { getSubmissionsCreds, getSubmissionsFrom } from "@/lib/integrations/submissions-gmail";

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
    const subject = `New form completed — ${business} (Form ${formNumber})`;
    const lines = [
      `${agentName ? `${agentName}'s lead` : "A lead"} just completed ${formLabel}.`,
      "",
      `Merchant: ${business}${contact ? ` — ${contact}` : ""}`,
      `Form: ${formLabel}`,
      `Agent: ${agentName || "(unassigned)"}`,
      ...(link ? ["", `Open the lead: ${link}`] : []),
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
