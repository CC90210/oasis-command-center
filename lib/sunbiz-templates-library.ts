/**
 * sunbiz-templates-library.ts — the manual email-template library the SunBiz
 * operators (Matt / Jordan / Alex) pick from in the lead-drawer Send-Email
 * composer (components/leads/LeadDetailDrawer.tsx → EmailComposer).
 *
 * CC's ask (2026-06-23): a reusable set of email templates for the whole
 * SunBiz funding lifecycle, so the team isn't writing from scratch for every
 * lead. These are MANUAL — the operator picks one, it auto-fills subject + body
 * personalized to the lead, and they edit before hitting Queue send. Nothing
 * here auto-fires (the auto-cadence lives in drip_sequences / lib/
 * sunbiz-default-sequences.ts). The lead drawer is SunBiz-only
 * (TenantLeadDrawerMount gates slug === "sun"), so these never surface on
 * other tenants.
 *
 * Voice + compliance contract (matches lib/sunbiz-default-sequences.ts and the
 * scripts/draft_critic.py slop list):
 *   - Warm, plain, specific, low-pressure. Real SunBiz funding language
 *     ("3-5 lender offers", "bank statements are the gate", funds in days).
 *   - NO sign-off / "— Name" line: send_gateway wraps the body in the
 *     brand="sunbiz" shell and appends the operator's signature at send time
 *     (scripts/email_template.py _signature_block). A name here would double it.
 *   - NO draft_critic slop phrases ("just checking in", "circle back",
 *     "quick question", "i hope this finds you well", etc.).
 *
 * Merge fields: {{first_name}} and {{business_name}} only — the two fields the
 * lead drawer reliably has (record.data.name / record.data.company). Missing
 * values fall back to friendly defaults ("there" / "your business") so a thin
 * lead never renders "Hi ,".
 */

export type SunbizTemplateCategory =
  | "welcome"
  | "nurture"
  | "follow_up"
  | "document_request"
  | "offer"
  | "breakup";

export type SunbizEmailTemplate = {
  /** Stable id (used as the <option> value + React key). */
  id: string;
  category: SunbizTemplateCategory;
  /** Operator-facing label in the dropdown. */
  label: string;
  subject: string;
  body: string;
};

export const SUNBIZ_EMAIL_TEMPLATES: SunbizEmailTemplate[] = [
  {
    id: "welcome",
    category: "welcome",
    label: "New inquiry — welcome",
    subject: "Your funding request — {{business_name}}",
    body: `Hi {{first_name}},

Thanks for reaching out about funding for {{business_name}}. Here's how this works on our end: once I have a completed application and your last 3 months of business bank statements, I take your file to our lender network and come back with the offers that actually fit — usually 3 to 5 of them, within 24 to 48 hours.

There's no cost to see what you qualify for, and no obligation to take any offer.

If you can send me a good time today or tomorrow, I'll walk you through the application and answer anything before you fill it out.`,
  },
  {
    id: "value_add",
    category: "nurture",
    label: "Value-add / nurture",
    subject: "A faster path to capital for {{business_name}}",
    body: `Hi {{first_name}},

A bit of context on why operators use us instead of going lender by lender themselves: one application puts your file in front of our whole lender network at once, so you're comparing real offers side by side instead of taking one number on faith.

Most deals we place fund in a few days, not weeks — and because we see what each lender actually approves, we can usually tell you up front what's realistic for {{business_name}} before you spend time chasing a no.

If now's the right time to look at working capital, reply here and I'll get you the application. If it isn't, tell me roughly when and I'll check back then.`,
  },
  {
    id: "follow_up",
    category: "follow_up",
    label: "Follow-up (no reply yet)",
    subject: "Still worth a look — funding for {{business_name}}?",
    body: `Hi {{first_name}},

I haven't heard back, so I want to make sure this didn't get buried. The offer stands: send me a completed application and 3 months of bank statements, and I'll bring you the lender offers that fit {{business_name}} — usually within a day or two.

If the timing's off, just tell me when to check back and I'll stay out of your inbox until then. If you're ready, reply here and I'll send the application link.`,
  },
  {
    id: "document_request",
    category: "document_request",
    label: "Document request (bank statements)",
    subject: "One thing to unlock offers for {{business_name}}",
    body: `Hi {{first_name}},

Your file is ready to go to lenders — the only thing I'm missing is 3 months of business bank statements. PDF exports from your online banking are perfect (full statements, not screenshots).

Once those are in, underwriting runs and I can start pulling offers for {{business_name}}. Without them, no lender can price the deal, so this is the one step that moves everything forward.

You can reply with them attached, or tell me what's easiest and I'll send you a secure upload link.`,
  },
  {
    id: "offer",
    category: "offer",
    label: "Offer / approval",
    subject: "Offers are in for {{business_name}}",
    body: `Hi {{first_name}},

Good news — your file came back approved and I have offers in hand for {{business_name}}.

Rather than send over a wall of numbers, I'd like to walk you through them for five minutes so you can see the real differences — amount, term, payment, and total cost — and pick the one that fits how your business actually runs.

What time works today or tomorrow? If you'd rather I send the strongest option in writing first, say the word and I'll get it over.`,
  },
  {
    id: "breakup",
    category: "breakup",
    label: "Breakup / close the thread",
    subject: "Closing out {{business_name}}'s file — for now",
    body: `Hi {{first_name}},

I don't want to keep landing in your inbox if the timing isn't right, so I'm going to close out {{business_name}}'s file on my end for now.

If anything changes — a project, payroll, inventory, a slow month — reply to this email and I'll pick it right back up. Your information stays on file, so there's nothing to redo.

Wishing you a strong quarter either way.`,
  },
];

/**
 * Substitute {{first_name}} / {{business_name}} in a template's subject + body.
 * Client-safe (no server deps). Unknown/blank values fall back to friendly
 * defaults so a thin lead never renders "Hi ," or "...for ."
 */
export function renderSunbizTemplate(
  tpl: SunbizEmailTemplate,
  vars: { firstName?: string | null; businessName?: string | null },
): { subject: string; body: string } {
  const firstName = (vars.firstName || "").trim().split(/\s+/)[0] || "there";
  const businessName = (vars.businessName || "").trim() || "your business";
  const sub = (s: string) =>
    s
      .replace(/\{\{\s*first_name\s*\}\}/g, firstName)
      .replace(/\{\{\s*business_name\s*\}\}/g, businessName);
  return { subject: sub(tpl.subject), body: sub(tpl.body) };
}
