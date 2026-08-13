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

export function renderShopOutHtml(text: string, senderAddress: string, attachmentCount = 0): string {
  const normalized = normalizeShopOutText(text);
  const bodyOnly = normalized.replace(/(?:\r?\n){1,2}SunBiz Submissions\r?\nSunBiz Funding\s*$/i, "");
  const detailLabels = ["Business", "Monthly Revenue", "Positions", "Requested"];
  const details = new Map<string, string>();
  const narrativeLines: string[] = [];
  for (const line of bodyOnly.split(/\r?\n/)) {
    const match = line.match(/^\s*(Business|Monthly Revenue|Positions|Requested):\s*(.+?)\s*$/i);
    if (match) details.set(detailLabels.find((label) => label.toLowerCase() === match[1].toLowerCase()) || match[1], match[2]);
    else narrativeLines.push(line);
  }
  const narrative = narrativeLines
    .join("\n")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<div style="margin:0 0 18px;">${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</div>`)
    .join("");
  const detailRows = detailLabels.map((label, index) => {
    const value = escapeHtml(details.get(label) || "Not provided");
    const border = index < detailLabels.length - 1 ? "border-bottom:1px solid #e7ebf2;" : "";
    return `<tr>
      <td width="42%" style="${border}padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.8px;color:#69758a;text-transform:uppercase;">${label}</td>
      <td style="${border}padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#142747;text-align:right;">${value}</td>
    </tr>`;
  }).join("");
  const safeSenderAddress = escapeHtml(senderAddress);
  const attachmentPanel = attachmentCount > 0
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:14px;background:#fffaf0;border-left:3px solid #d4a843;border-collapse:separate;border-spacing:0;border-radius:6px;">
              <tr><td style="padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#67552d;"><strong style="color:#51401d;">Submission package included</strong><br>${attachmentCount} supporting ${attachmentCount === 1 ? "document is" : "documents are"} securely attached for underwriting review.</td></tr>
            </table>`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#edf1f6;color:#17233c;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">A new SunBiz Funding submission is ready for review.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#edf1f6;border-collapse:collapse;">
    <tr><td align="center" style="padding:36px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:660px;background:#ffffff;border-collapse:separate;border-spacing:0;border-radius:16px;overflow:hidden;box-shadow:0 10px 32px rgba(0,31,84,.12);">
        <tr>
          <td style="padding:28px 36px;background:#001f54;border-top:5px solid #d4a843;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td valign="middle">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;letter-spacing:1.7px;color:#ffffff;">SUN<span style="color:#e1b94f;">BIZ</span> FUNDING</div>
                <div style="margin-top:6px;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;letter-spacing:2.1px;color:#bfcce1;text-transform:uppercase;">Capital &bull; Clarity &bull; Confidence</div>
              </td>
              <td align="right" valign="middle"><span style="display:inline-block;padding:8px 11px;border:1px solid #49658f;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:700;letter-spacing:1px;color:#ffffff;text-transform:uppercase;">Lender Submissions</span></td>
            </tr></table>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 36px 12px;font-family:Arial,Helvetica,sans-serif;color:#26344f;word-break:break-word;">
            <div style="font-size:11px;font-weight:700;letter-spacing:1.4px;color:#b18422;text-transform:uppercase;">New opportunity</div>
            <div style="margin-top:7px;font-size:25px;font-weight:700;line-height:1.25;color:#001f54;">Submission ready for review</div>
            <div style="margin-top:12px;width:42px;height:3px;background:#d4a843;font-size:0;line-height:0;">&nbsp;</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 36px 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#35435b;word-break:break-word;">${narrative}</td>
        </tr>
        <tr>
          <td style="padding:8px 36px 30px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #dfe5ee;border-collapse:separate;border-spacing:0;border-radius:10px;overflow:hidden;">
              <tr><td colspan="2" style="padding:12px 14px;background:#f4f7fb;border-bottom:1px solid #dfe5ee;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:1.2px;color:#001f54;text-transform:uppercase;">Deal snapshot</td></tr>
              ${detailRows}
            </table>
            ${attachmentPanel}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 36px;border-top:1px solid #e2e7ef;background:#f7f9fc;font-family:Arial,Helvetica,sans-serif;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="border-left:3px solid #d4a843;padding-left:12px;">
                <div style="font-size:14px;font-weight:700;color:#001f54;">SunBiz Submissions</div>
                <div style="margin-top:4px;font-size:12px;color:#6b7485;">Lender Relations &nbsp;&bull;&nbsp; SunBiz Funding</div>
                <div style="margin-top:3px;font-size:12px;color:#6b7485;">${safeSenderAddress}</div>
              </td>
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:13px 36px;background:#001f54;font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:1.5;letter-spacing:.5px;color:#9fb0ca;text-align:center;">CONFIDENTIAL LENDER COMMUNICATION &nbsp;&bull;&nbsp; Intended solely for the addressed recipient</td></tr>
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
