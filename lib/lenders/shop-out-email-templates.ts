export type ShopOutEmailTemplate = {
  id: "classic" | "warm" | "detailed" | "plain";
  name: string;
  description: string;
  body: string;
};

export const PLAIN_SHOP_OUT_MARKER = "[[SHOP_OUT_PLAIN_EMAIL]]";

const FILE_DETAILS = `Business:        {{application.business_name}}
Monthly Revenue: {{application.monthly_revenue_display}}
Positions:       {{application.position_count_display}}
Requested:       {{application.requested_amount_display}}`;

export const SHOP_OUT_EMAIL_TEMPLATES: ShopOutEmailTemplate[] = [
  { id: "classic", name: "Classic submission", description: "The concise SunBiz format shown in prior lender emails.", body: `New submission attached.

${FILE_DETAILS}

Application + 3 months of bank statements are attached. Please review and advise on approval.

SunBiz Submissions
SunBiz Funding` },
  { id: "warm", name: "Warm review request", description: "A friendlier introduction with the same file details.", body: `Hi {{lender.name}} team,

Please see this new submission for your review.

${FILE_DETAILS}

The application and 3 months of bank statements are attached. Please let me know what you can offer or if you need anything else.

Thank you,
SunBiz Submissions
SunBiz Funding` },
  { id: "detailed", name: "Detailed file summary", description: "A fuller lender request that calls out the attached package.", body: `Hi {{lender.name}} team,

We would appreciate your review of the following submission:

${FILE_DETAILS}

Documents attached:
- Funding application
- 3 months of business bank statements

Please advise on appetite, approval amount, and best available terms.

Thank you,
SunBiz Submissions
SunBiz Funding` },
  { id: "plain", name: "No template", description: "Send the email like a regular text email, without the branded frame.", body: `${PLAIN_SHOP_OUT_MARKER}
Please see application and statements attached. Thanks` },
];

export const DEFAULT_SHOP_OUT_BODY = SHOP_OUT_EMAIL_TEMPLATES[0].body;

export function resolveShopOutPresentation(text: string): { text: string; branded: boolean } {
  if (!text.startsWith(PLAIN_SHOP_OUT_MARKER)) return { text, branded: true };
  return {
    text: text.slice(PLAIN_SHOP_OUT_MARKER.length).replace(/^\r?\n/, ""),
    branded: false,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the operator-approved lender copy inside the canonical SunBiz shell.
 *
 * The copy stays plain text in the editor and database so operators can edit it
 * safely. HTML is produced only at the final send boundary, which guarantees
 * every lender receives the branded presentation without allowing edited copy
 * to inject markup into the message.
 */
export function normalizeShopOutText(text: string, operatorName?: string): string {
  let normalized = text.trim();
  const sharedSignature = "SunBiz Submissions\nSunBiz Funding";

  if (operatorName?.trim()) {
    const escapedName = operatorName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(
      new RegExp(
        `(?:\\r?\\n){1,2}(?:(?:best(?: regards)?|regards|thank you|thanks|sincerely),?\\r?\\n)?${escapedName}(?:\\r?\\nSunBiz Funding)?(?=(?:\\r?\\n){2}Additional context:|$)`,
        "i",
      ),
      "",
    );
  }

  if (normalized.endsWith(sharedSignature)) return normalized;

  // Existing drafts may already have been personalized as "Matt / SunBiz
  // Funding" and may have Additional context appended after that signature.
  // Normalize and move the shared signature back to the actual end so saved
  // legacy drafts cannot leak the operator identity to a lender.
  normalized = normalized.replace(
    /(?:\r?\n){1,2}[^\r\n]{1,80}\r?\nSunBiz Funding(?:(?:\r?\n){2}Additional context:\r?\n([\s\S]+))?\s*$/i,
    (_match, notes: string | undefined) =>
      notes
        ? `\n\nAdditional context:\n${notes.trim()}\n\n${sharedSignature}`
        : `\n\n${sharedSignature}`,
  );
  return normalized.endsWith(sharedSignature)
    ? normalized
    : `${normalized.trimEnd()}\n\n${sharedSignature}`;
}

export function renderShopOutHtml(text: string, senderAddress: string, attachmentCount = 0): string {
  const normalized = normalizeShopOutText(text);
  const bodyOnly = normalized.replace(/(?:\r?\n){1,2}SunBiz Submissions\r?\nSunBiz Funding\s*$/i, "");
  const content = escapeHtml(bodyOnly).replace(/\r?\n/g, "<br>");
  const safeSenderAddress = escapeHtml(senderAddress);
  void attachmentCount;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#071d4d;color:#202124;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#071d4d;border-collapse:collapse;">
    <tr><td align="center" style="padding:34px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe3ee;border-collapse:separate;border-spacing:0;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.28);">
        <tr><td align="center" style="padding:30px 32px 28px;background:linear-gradient(180deg,#102d63 0%,#dcecf2 100%);">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;letter-spacing:5px;color:#34425a;">SUN<span style="color:#d4a843;">BIZ</span> FUNDING</div>
          <div style="margin-top:9px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;color:#d4a843;text-transform:uppercase;">Business Funding &bull; Built Around Your Cash Flow</div>
        </td></tr>
        <tr><td style="padding:42px 38px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.7;color:#202124;word-break:break-word;">${content}</td></tr>
        <tr>
          <td style="padding:22px 38px 28px;border-top:1px solid #e2e7ef;background:#ffffff;font-family:Arial,Helvetica,sans-serif;">
            <div style="font-size:15px;font-weight:700;color:#202124;">&mdash; SunBiz Submissions</div>
            <div style="margin-top:4px;font-size:13px;color:#5f6368;">SunBiz Funding LLC</div>
            <div style="margin-top:14px;font-size:12px;"><a href="https://sunbizfunding.com" style="color:#059669;text-decoration:none;">https://sunbizfunding.com</a></div>
            <div style="display:none;">${safeSenderAddress}</div>
          </td>
        </tr>
        <tr><td style="padding:16px 30px;background:#071d4d;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#d5dceb;text-align:center;">You're receiving this from SunBiz Submissions at SunBiz Funding.<br>Reply to this email &mdash; it lands in our shared submissions inbox.</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function composeShopOutBody(templateBody: string, notes: string): string {
  const cleanNotes = notes.trim();
  return normalizeShopOutText(
    cleanNotes ? `${templateBody.trimEnd()}\n\nAdditional context:\n${cleanNotes}` : templateBody,
  );
}
