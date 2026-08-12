export type ShopOutEmailTemplate = {
  id: "classic" | "warm" | "detailed";
  name: string;
  description: string;
  body: string;
};

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
];

export const DEFAULT_SHOP_OUT_BODY = SHOP_OUT_EMAIL_TEMPLATES[0].body;

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

export function renderShopOutHtml(text: string, senderAddress: string): string {
  const normalized = normalizeShopOutText(text);
  const bodyOnly = normalized.replace(/(?:\r?\n){1,2}SunBiz Submissions\r?\nSunBiz Funding\s*$/i, "");
  const content = escapeHtml(bodyOnly).replace(/\r?\n/g, "<br>");
  const safeSenderAddress = escapeHtml(senderAddress);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f8;color:#17233c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f5f8;border-collapse:collapse;">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-collapse:separate;border-spacing:0;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(0,31,84,.10);">
        <tr><td style="height:6px;background:#d4a843;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:24px 32px;background:#001f54;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:25px;font-weight:800;letter-spacing:2px;color:#ffffff;">SUN<span style="color:#d4a843;">BIZ</span> FUNDING</div>
            <div style="margin-top:6px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.8px;color:#c9d4e8;text-transform:uppercase;">Lender Submissions</div>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#26344f;word-break:break-word;">${content}</td>
        </tr>
        <tr>
          <td style="padding:18px 32px;border-top:1px solid #e5e9f0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
            <div style="font-size:14px;font-weight:700;color:#001f54;">SunBiz Submissions</div>
            <div style="margin-top:4px;font-size:12px;color:#6b7485;">SunBiz Funding &nbsp;|&nbsp; ${safeSenderAddress}</div>
          </td>
        </tr>
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
