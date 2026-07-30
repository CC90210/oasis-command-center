import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantMembers } from "@/lib/team";
import { getSubmissionsCreds, getSubmissionsFrom } from "@/lib/integrations/submissions-gmail";
import { resolveSunbizRecipients } from "@/lib/notify/sunbiz-events";
import { sendTelegram } from "@/lib/notify/telegram";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function resolveAgentMailbox(tenantId: string, userId: string): Promise<string | null> {
  for (const service of ["gmail_imap", "gmail_oauth"] as const) {
    const bundle = await getUserIntegrationBundle(tenantId, userId, service).catch(() => ({} as Record<string, string>));
    const email = (bundle.address || bundle.gmail_address || "").trim();
    if (EMAIL_RE.test(email)) return email;
  }
  return null;
}

export function lenderContact(data: Record<string, unknown>) {
  const value = data.contact_email || data.contact;
  return typeof value === "string" && EMAIL_RE.test(value.trim()) ? value.trim() : null;
}

export async function notifyRenewalAgent(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string | null;
  agentId: string | null;
  merchant: string;
  lender: string;
  amount: number;
  fundedAt: string;
  term: number;
  thresholdDate: string;
  dealId: string;
  status: string;
}) {
  const lines = [
    `Renewal threshold reached — ${input.merchant}`,
    `Lender: ${input.lender}`, `Funded: $${input.amount.toLocaleString()} on ${input.fundedAt}`,
    `Term: ${input.term} months`, `50% date: ${input.thresholdDate}`,
    `Outreach: ${input.status}`, `Open: ${process.env.NEXT_PUBLIC_APP_URL || ""}/t/sun/renewals?renewal=${input.dealId}`,
  ];
  const text = lines.join("\n");
  const results = { email: false, telegram: false };
  try {
    const members = await getTenantMembers(input.tenantId);
    const member = members.find((item) => item.auth_user_id === input.agentId);
    const to = member?.email && EMAIL_RE.test(member.email) ? member.email : null;
    if (to) {
      const creds = await getSubmissionsCreds(input.tenantId);
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true, auth: { user: creds.fromAddress, pass: creds.appPassword } });
      await transport.sendMail({ from: await getSubmissionsFrom(input.tenantId), to, subject: `Renewal ready — ${input.merchant}`, text });
      results.email = true;
    }
  } catch (error) { console.error("[renewal-outreach] internal email", error); }
  try {
    const recipients = await resolveSunbizRecipients(input.db, input.tenantId, input.agentId);
    const sends = await Promise.all(recipients.chatIds.map((chatId) => sendTelegram(text, { chatId, token: process.env.SUNBIZ_TELEGRAM_BOT_TOKEN || undefined })));
    results.telegram = sends.some((result) => result.ok);
  } catch (error) { console.error("[renewal-outreach] telegram", error); }
  return results;
}

export function lenderRenewalMessage(merchant: string) {
  return {
    subject: `Renewal check-in — ${merchant}`,
    body: `Hi,\n\nI'm checking whether ${merchant} may be eligible to discuss renewal options. Please let me know the current status and any next steps required.\n\nThank you,`,
  };
}
