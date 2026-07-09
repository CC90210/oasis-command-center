/**
 * lib/esign/email.ts — signing-link + completion-notice emails.
 *
 * Sends through the SAME proven submissions@ path every other operator-
 * facing dashboard email uses — sendGmail (lib/integrations/
 * submissions-gmail-send.ts:134), extended (this feature) with an
 * optional `html` field so the signing link can render as a real button
 * instead of a bare URL, while `text` stays the plaintext fallback.
 *
 * Every untrusted field interpolated into the HTML body (signer name,
 * envelope title, operator message) is escaped via lib/markdown.ts's
 * escapeHtml — these are operator/signer-supplied free text, not
 * developer-controlled strings, so unescaped interpolation would be an
 * HTML/link injection vector in the recipient's mail client.
 */

import "server-only";
import { sendGmail, type SendResult } from "@/lib/integrations/submissions-gmail-send";
import { escapeHtml } from "@/lib/markdown";

function wrapHtml(bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:#001F54;padding:18px 24px;">
                <span style="color:#ffffff;font-size:15px;font-weight:bold;letter-spacing:0.02em;">OASIS E-Sign</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;color:#1f2937;font-size:14px;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f9fafb;color:#9ca3af;font-size:11px;">
                This is an automated message from the OASIS e-signature system.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Send a signer their signing link. `url` MUST already contain the raw
 *  token (minted by lib/esign/tokens.ts) — this module never sees or logs
 *  the token itself beyond what's embedded in the link text. */
export async function sendSigningLinkEmail(input: {
  tenantId: string;
  to: string;
  signerName: string;
  envelopeTitle: string;
  url: string;
  message?: string | null;
}): Promise<SendResult> {
  const safeName = escapeHtml((input.signerName || "there").split(/\s+/)[0] || "there");
  const safeTitle = escapeHtml(input.envelopeTitle);
  const safeMessage = input.message ? escapeHtml(input.message) : "";
  const safeUrl = escapeHtml(input.url);

  const html = wrapHtml(`
    <p style="margin:0 0 12px;">Hi ${safeName},</p>
    <p style="margin:0 0 12px;">You've been asked to review and sign <strong>${safeTitle}</strong>.</p>
    ${safeMessage ? `<p style="margin:0 0 16px;padding:10px 12px;background:#f4f5f7;border-radius:8px;color:#374151;">${safeMessage}</p>` : ""}
    <p style="margin:0 0 20px;">
      <a href="${safeUrl}" style="display:inline-block;background:#001F54;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:bold;font-size:13px;">Review &amp; Sign</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:12px;">Or paste this link into your browser:<br>${safeUrl}</p>
  `);

  const text = [
    `Hi ${input.signerName || "there"},`,
    "",
    `You've been asked to review and sign "${input.envelopeTitle}".`,
    input.message ? `\n${input.message}\n` : "",
    "Review and sign here:",
    input.url,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return sendGmail({
    tenantId: input.tenantId,
    to: input.to,
    subject: `Signature requested: ${input.envelopeTitle}`,
    body: text,
    html,
  });
}

/** Notify the envelope's creator once every signer has completed. */
export async function sendEnvelopeCompletedEmail(input: {
  tenantId: string;
  to: string;
  envelopeTitle: string;
  downloadUrl?: string | null;
}): Promise<SendResult> {
  const safeTitle = escapeHtml(input.envelopeTitle);
  const safeUrl = input.downloadUrl ? escapeHtml(input.downloadUrl) : "";

  const html = wrapHtml(`
    <p style="margin:0 0 12px;">All signers have completed <strong>${safeTitle}</strong>.</p>
    ${
      safeUrl
        ? `<p style="margin:0 0 20px;"><a href="${safeUrl}" style="display:inline-block;background:#001F54;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:bold;font-size:13px;">Open in OASIS</a></p>`
        : ""
    }
  `);

  const text = [
    `All signers have completed "${input.envelopeTitle}".`,
    input.downloadUrl ? `\nOpen it here: ${input.downloadUrl}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return sendGmail({
    tenantId: input.tenantId,
    to: input.to,
    subject: `Completed: ${input.envelopeTitle}`,
    body: text,
    html,
  });
}

/**
 * On full completion, email EVERY signer a confirmation with the fully-signed
 * PDF ATTACHED. Sends from the configured e-sign sender (ESIGN_FROM_EMAIL +
 * ESIGN_FROM_APP_PASSWORD — e.g. adonyess@gmail.com) via Gmail SMTP so the PDF
 * can ride as an attachment; if that sender isn't configured it degrades to
 * the submissions@ path (HTML notice, NO attachment). Best-effort per
 * recipient — one failed send never blocks the others. Never throws.
 */
export async function sendEnvelopeCompletedWithPdf(input: {
  tenantId: string;
  to: string[];
  envelopeTitle: string;
  pdfBytes: Buffer;
}): Promise<{ ok: boolean; sent: number; error?: string }> {
  const recipients = Array.from(
    new Set(input.to.map((e) => (e || "").trim().toLowerCase()).filter(Boolean)),
  );
  if (recipients.length === 0) return { ok: false, sent: 0, error: "no_recipients" };

  const safeTitle = escapeHtml(input.envelopeTitle);
  const html = wrapHtml(`
    <p style="margin:0 0 12px;"><strong>${safeTitle}</strong> has been signed by all parties.</p>
    <p style="margin:0 0 12px;">The completed, fully-signed PDF is attached to this email for your records. A certificate page for each signer — signature, printed name, date, IP address, and consent — is appended to the document.</p>
    <p style="margin:0;color:#6b7280;font-size:12px;">Please retain this copy.</p>
  `);
  const text = [
    `${input.envelopeTitle} has been signed by all parties.`,
    "",
    "The completed, fully-signed PDF is attached for your records. A certificate page for each signer is appended to the document.",
  ].join("\n");
  const safeName = input.envelopeTitle.replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 80) || "document";
  const filename = `${safeName} - signed.pdf`;

  const user = (process.env.ESIGN_FROM_EMAIL || "").trim();
  const pass = (process.env.ESIGN_FROM_APP_PASSWORD || "").replace(/\s+/g, "");
  if (user && pass) {
    const fromName = (process.env.ESIGN_FROM_NAME || "").trim() || user;
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass },
    });
    let sent = 0;
    let lastErr: string | undefined;
    for (const to of recipients) {
      try {
        await transport.sendMail({
          from: `"${fromName}" <${user}>`,
          to,
          subject: `Signed & completed: ${input.envelopeTitle}`,
          text,
          html,
          attachments: [{ filename, content: input.pdfBytes, contentType: "application/pdf" }],
        });
        sent++;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "send_failed";
      }
    }
    return { ok: sent > 0, sent, error: lastErr };
  }

  // Fallback — submissions@ path has no attachment support, so this sends an
  // HTML notice per signer WITHOUT the PDF. Configure ESIGN_FROM_* to attach.
  let sent = 0;
  for (const to of recipients) {
    const r = await sendGmail({ tenantId: input.tenantId, to, subject: `Completed: ${input.envelopeTitle}`, body: text, html });
    if (r.ok) sent++;
  }
  return { ok: sent > 0, sent };
}
