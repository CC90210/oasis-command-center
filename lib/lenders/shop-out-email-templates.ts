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

{{agent.first_name}}
SunBiz Funding` },
  { id: "warm", name: "Warm review request", description: "A friendlier introduction with the same file details.", body: `Hi {{lender.name}} team,

Please see this new submission for your review.

${FILE_DETAILS}

The application and 3 months of bank statements are attached. Please let me know what you can offer or if you need anything else.

Thank you,
{{agent.first_name}}
SunBiz Funding` },
  { id: "detailed", name: "Detailed file summary", description: "A fuller lender request that calls out the attached package.", body: `Hi {{lender.name}} team,

We would appreciate your review of the following submission:

${FILE_DETAILS}

Documents attached:
- Funding application
- 3 months of business bank statements

Please advise on appetite, approval amount, and best available terms.

Thank you,
{{agent.first_name}}
SunBiz Funding` },
];

export const DEFAULT_SHOP_OUT_BODY = SHOP_OUT_EMAIL_TEMPLATES[0].body;

export function composeShopOutBody(templateBody: string, notes: string): string {
  const cleanNotes = notes.trim();
  return cleanNotes ? `${templateBody.trimEnd()}\n\nAdditional context:\n${cleanNotes}` : templateBody;
}
