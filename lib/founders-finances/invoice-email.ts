/**
 * Invoice email: FROM the OASIS mailbox, WITH the PDF attached. Always both.
 *
 * MAILBOX RESOLUTION (first complete pair wins):
 *   1. INVOICE_FROM_EMAIL + INVOICE_FROM_APP_PASSWORD (+ INVOICE_FROM_NAME) —
 *      an explicit override, for when invoices should leave from a billing
 *      address rather than the shared team mailbox;
 *   2. OASIS_MAIL_FROM + OASIS_MAIL_APP_PASSWORD — the existing OASIS shared
 *      mailbox (lib/integrations/oasis-shared-gmail-send.ts reads the same);
 *   3. the founders' tenant 'oasis_gmail' integration row {from_address,
 *      app_password} — the same row that sender falls back to.
 * None configured -> InvoiceMailerNotConfigured, thrown. There is no fallback
 * to a path that cannot carry the attachment (the e-sign sender degrades to
 * a notice without its PDF; an invoice must not).
 *
 * The mailbox must be on oasisai.work (mailboxBrandConflict): an invoice for
 * OASIS AI Solutions authenticated as another company's mailbox is refused.
 *
 * Transactional, not marketing: an invoice for work a client bought is exempt
 * from CASL consent, so the marketing suppression list is not consulted — a
 * client who unsubscribed from newsletters still receives their invoice.
 */
import "server-only";

import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { mailboxBrandConflict } from "@/lib/email/brand-for-tenant";
import { formatCents } from "./money";

export class InvoiceMailerNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceMailerNotConfigured";
  }
}

export type InvoiceMailbox = { from: string; password: string; name: string; source: "invoice_env" | "oasis_env" | "tenant_row" };

export async function resolveInvoiceMailbox(tenantId: string | null): Promise<InvoiceMailbox> {
  const envPairs: Array<[string, string, string, InvoiceMailbox["source"]]> = [
    ["INVOICE_FROM_EMAIL", "INVOICE_FROM_APP_PASSWORD", "INVOICE_FROM_NAME", "invoice_env"],
    ["OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD", "OASIS_FROM_NAME", "oasis_env"],
  ];
  let found: InvoiceMailbox | null = null;
  for (const [fromVar, passVar, nameVar, source] of envPairs) {
    const from = (process.env[fromVar] || "").trim();
    const password = (process.env[passVar] || "").replace(/\s+/g, "");
    if (from && password) {
      found = { from, password, name: (process.env[nameVar] || "").trim() || "OASIS AI Solutions", source };
      break;
    }
  }
  if (!found && tenantId) {
    const b = await getTenantIntegrationBundle(tenantId, "oasis_gmail").catch(() => ({}) as Record<string, string>);
    const from = (b.from_address || "").trim();
    const password = (b.app_password || "").replace(/\s+/g, "");
    if (from && password) found = { from, password, name: "OASIS AI Solutions", source: "tenant_row" };
  }
  if (!found) {
    throw new InvoiceMailerNotConfigured(
      "No OASIS mailbox is configured for invoices. Set INVOICE_FROM_EMAIL + INVOICE_FROM_APP_PASSWORD " +
        "(or the existing OASIS_MAIL_FROM + OASIS_MAIL_APP_PASSWORD). The invoice was NOT emailed.",
    );
  }
  const conflict = mailboxBrandConflict("oasis", found.from);
  if (conflict) throw new InvoiceMailerNotConfigured(`Refusing to send an OASIS invoice: ${conflict}`);
  return found;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * PURE. Subject + text + html for an invoice or a reminder. `bankTransfer`
 * (Wise receiving details, payment reference last) prints before the card
 * link: a bank transfer is the default way to pay a one-off invoice.
 */
export function composeInvoiceEmail(args: {
  kind: "invoice" | "reminder";
  sellerName: string;
  customerName: string;
  number: string;
  totalCents: number;
  balanceCents: number;
  currency: string;
  dueDate: string;
  paymentLinkUrl: string | null;
  paymentInstructions: string;
  bankTransfer?: Array<{ label: string; value: string }> | null;
}): { subject: string; text: string; html: string } {
  const amount = formatCents(args.balanceCents, args.currency);
  const greeting = args.customerName ? `Hi ${args.customerName},` : "Hello,";
  const subject =
    args.kind === "reminder"
      ? `Reminder: invoice ${args.number} from ${args.sellerName} is past due`
      : `Invoice ${args.number} from ${args.sellerName}`;
  const lead =
    args.kind === "reminder"
      ? `This is a reminder that invoice ${args.number} for ${amount} was due on ${args.dueDate}. The invoice is attached.`
      : `Please find attached invoice ${args.number} for ${formatCents(args.totalCents, args.currency)}, due ${args.dueDate}.`;
  const payLine = args.paymentLinkUrl ? `You can pay by card here: ${args.paymentLinkUrl}` : "";
  const bank = args.bankTransfer?.length ? args.bankTransfer : null;
  const bankText = bank
    ? `\nPay by bank transfer (Wise):\n${bank.map((r) => `  ${r.label}: ${r.value}`).join("\n")}\nPlease include the payment reference so we can match your payment.`
    : "";
  const text = [greeting, "", lead, ...(bankText ? [bankText] : []), payLine ? `\n${payLine}` : "", args.paymentInstructions ? `\n${args.paymentInstructions}` : "", "", "Thank you,", args.sellerName]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
  const bankHtml = bank
    ? `<p style="margin-bottom:4px"><strong>Pay by bank transfer (Wise)</strong></p>
<table style="border-collapse:collapse;font-size:14px">${bank
        .map((r) => `<tr><td style="padding:2px 16px 2px 0;color:#555">${esc(r.label)}</td><td style="padding:2px 0">${/reference/i.test(r.label) ? `<strong>${esc(r.value)}</strong>` : esc(r.value)}</td></tr>`)
        .join("")}</table>
<p style="color:#555;margin-top:4px">Please include the payment reference so we can match your payment.</p>`
    : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16181d;line-height:1.5">
<p>${esc(greeting)}</p>
<p>${esc(lead)}</p>
${bankHtml ? `${bankHtml}\n` : ""}${args.paymentLinkUrl ? `<p><a href="${esc(args.paymentLinkUrl)}" style="display:inline-block;padding:10px 16px;background:#0b7c85;color:#ffffff;text-decoration:none;border-radius:6px">Pay ${esc(amount)}</a></p>` : ""}
${args.paymentInstructions ? `<p style="color:#555">${esc(args.paymentInstructions).replace(/\n/g, "<br>")}</p>` : ""}
<p>Thank you,<br>${esc(args.sellerName)}</p>
</div>`;
  return { subject, text, html };
}

export async function sendInvoiceEmail(args: {
  tenantId: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  pdf: Uint8Array;
  filename: string;
}): Promise<{ messageId: string; from: string }> {
  const mailbox = await resolveInvoiceMailbox(args.tenantId);
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: mailbox.from, pass: mailbox.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const safeName = mailbox.name.replace(/["\r\n]/g, "");
  const info = await transport.sendMail({
    from: `"${safeName}" <${mailbox.from}>`,
    to: args.to,
    replyTo: mailbox.from,
    subject: args.subject.replace(/[\r\n]+/g, " "),
    text: args.text,
    html: args.html,
    attachments: [{ filename: args.filename, content: Buffer.from(args.pdf), contentType: "application/pdf" }],
  });
  return { messageId: info.messageId || "", from: mailbox.from };
}
