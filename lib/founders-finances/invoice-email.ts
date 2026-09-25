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
import { oneTimePayVerb } from "./invoice";

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

type InvoiceEmailArgs = {
  kind: "invoice" | "reminder";
  sellerName: string;
  customerName: string;
  number: string;
  /** The ONE-TIME total (the receivable). */
  totalCents: number;
  /** The ONE-TIME balance still owed. */
  balanceCents: number;
  currency: string;
  dueDate: string;
  paymentLinkUrl: string | null;
  paymentInstructions: string;
  bankTransfer?: Array<{ label: string; value: string }> | null;
  /**
   * The monthly retainer and its Stripe recurring link (migration 185).
   * Absent = no retainer: the email is exactly what it was before 185.
   * Reminders never carry it — they chase the one-time balance only.
   * `setUp`: the client already started the subscription with the link, so
   * the section says the payments are set up instead of carrying a used link.
   */
  retainer?: RetainerArg | null;
};

type RetainerArg = { monthlyCents: number; linkUrl: string } | { monthlyCents: number; setUp: true };

const BUTTON = "display:inline-block;padding:10px 16px;background:#0b7c85;color:#ffffff;text-decoration:none;border-radius:6px";

/**
 * PURE. Subject + text + html for an invoice or a reminder. `bankTransfer`
 * (Wise receiving details, payment reference last) prints before the card
 * link: a bank transfer is the default way to pay a one-off invoice.
 *
 * With a monthly retainer the invoice email has two clearly separate parts:
 * "Implementation — {amount} due by {date}: pay by bank transfer" (the Wise
 * details + reference, and the card link when the invoice offers card) and
 * "Monthly retainer — {amount}/month: set up automatic monthly card
 * payments" (the Stripe subscription link), then "Due now" and "Monthly
 * retainer" as two separate totals.
 */
export function composeInvoiceEmail(args: InvoiceEmailArgs): { subject: string; text: string; html: string } {
  if (args.kind === "invoice" && args.retainer && args.retainer.monthlyCents > 0) return composeRetainerInvoiceEmail(args, args.retainer);
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

function composeRetainerInvoiceEmail(args: InvoiceEmailArgs, retainer: RetainerArg): { subject: string; text: string; html: string } {
  const money = (c: number) => formatCents(c, args.currency);
  const greeting = args.customerName ? `Hi ${args.customerName},` : "Hello,";
  const subject = `Invoice ${args.number} from ${args.sellerName}`;
  const dueNow = args.balanceCents > 0;
  const monthly = `${money(retainer.monthlyCents)}/month`;
  const lead = dueNow
    ? `Please find attached invoice ${args.number}. It has two parts: the implementation, paid once, and your monthly retainer, paid automatically by card.`
    : `Please find attached invoice ${args.number}. It sets up your monthly retainer; nothing is due now.`;
  const bank = args.bankTransfer?.length ? args.bankTransfer : null;
  const card = args.paymentLinkUrl || null;
  const implHeading = `Implementation — ${money(args.balanceCents)} due by ${args.dueDate}: ${oneTimePayVerb(Boolean(bank), Boolean(card))}`;
  const link = "linkUrl" in retainer ? retainer.linkUrl : null;
  const retainerHeading = link
    ? `Monthly retainer — ${monthly}: set up automatic monthly card payments`
    : `Monthly retainer — ${monthly}: automatic monthly card payments are already set up`;
  const retainerNote = link
    ? "Your card is then charged automatically each month through Stripe."
    : "Your card is charged automatically each month through Stripe; there is nothing to do.";

  const textParts: string[] = [greeting, "", lead];
  if (dueNow) {
    textParts.push("", implHeading);
    if (bank) {
      textParts.push(...bank.map((r) => `  ${r.label}: ${r.value}`), "Please include the payment reference so we can match your payment.");
    }
    if (card) textParts.push(bank ? `Or pay by card: ${card}` : `Pay by card: ${card}`);
    if (!bank && !card && args.paymentInstructions) textParts.push(args.paymentInstructions);
  }
  textParts.push("", retainerHeading, ...(link ? [`  ${link}`] : []), retainerNote);
  textParts.push("", `Due now: ${money(args.balanceCents)}`, `Monthly retainer: ${monthly}`);
  if (dueNow && args.paymentInstructions && (bank || card)) textParts.push("", args.paymentInstructions);
  textParts.push("", "Thank you,", args.sellerName);
  const text = textParts.join("\n");

  const bankHtml = bank
    ? `<table style="border-collapse:collapse;font-size:14px">${bank
        .map((r) => `<tr><td style="padding:2px 16px 2px 0;color:#555">${esc(r.label)}</td><td style="padding:2px 0">${/reference/i.test(r.label) ? `<strong>${esc(r.value)}</strong>` : esc(r.value)}</td></tr>`)
        .join("")}</table>
<p style="color:#555;margin-top:4px">Please include the payment reference so we can match your payment.</p>`
    : "";
  const section = (heading: string, body: string) =>
    `<div style="margin:18px 0;padding:14px 16px;border:1px solid #d9dde3;border-radius:8px">
<p style="margin:0 0 8px 0"><strong>${esc(heading)}</strong></p>
${body}
</div>`;
  const implHtml = dueNow
    ? section(
        implHeading,
        [
          bankHtml,
          card ? `<p style="margin:${bank ? "10px" : "0"} 0 0 0"><a href="${esc(card)}" style="${BUTTON}">Pay ${esc(money(args.balanceCents))} by card</a></p>` : "",
          args.paymentInstructions && !bank && !card ? `<p style="color:#555;margin:0">${esc(args.paymentInstructions).replace(/\n/g, "<br>")}</p>` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    : "";
  const retainerHtml = section(
    retainerHeading,
    link
      ? `<p style="margin:0"><a href="${esc(link)}" style="${BUTTON}">Set up monthly payments</a></p>
<p style="color:#555;margin:8px 0 0 0">${esc(retainerNote)}</p>`
      : `<p style="color:#555;margin:0">${esc(retainerNote)}</p>`,
  );
  const totalsHtml = `<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:2px 16px 2px 0;color:#555">Due now</td><td style="padding:2px 0;text-align:right"><strong>${esc(money(args.balanceCents))}</strong></td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#555">Monthly retainer</td><td style="padding:2px 0;text-align:right"><strong>${esc(monthly)}</strong></td></tr>
</table>`;
  const instructionsHtml =
    dueNow && args.paymentInstructions && (bank || card) ? `<p style="color:#555">${esc(args.paymentInstructions).replace(/\n/g, "<br>")}</p>\n` : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16181d;line-height:1.5">
<p>${esc(greeting)}</p>
<p>${esc(lead)}</p>
${implHtml ? `${implHtml}\n` : ""}${retainerHtml}
${totalsHtml}
${instructionsHtml}<p>Thank you,<br>${esc(args.sellerName)}</p>
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
