/**
 * sunbiz-templates-library.ts — the manual email-template library the SunBiz
 * operators (Matt / Jordan / Alex) pick from in the lead-drawer Send-Email
 * composer (components/leads/LeadDetailDrawer.tsx → EmailComposer).
 *
 * CC's ask (2026-06-23): a reusable set of email templates for the whole
 * SunBiz funding lifecycle, so the team isn't writing from scratch for every
 * lead. Expanded 2026-06-26 (CC: "more options, wide variety, best in
 * industry") from 6 to a full lifecycle library, grouped by category so the
 * dropdown stays navigable. These are MANUAL — the operator picks one, it
 * auto-fills subject + body personalized to the lead, and they edit before
 * hitting Queue send. Nothing here auto-fires (the auto-cadence lives in
 * drip_sequences / lib/sunbiz-default-sequences.ts). The lead drawer is
 * SunBiz-only (TenantLeadDrawerMount gates slug === "sun"), so these never
 * surface on other tenants.
 *
 * Voice + compliance contract (matches lib/sunbiz-default-sequences.ts and the
 * scripts/draft_critic.py slop list — keep new templates inside it):
 *   - Warm, plain, specific, low-pressure. Real SunBiz funding language
 *     ("3-5 lender offers", "bank statements are the gate", funds in days).
 *   - NO sign-off / "— Name" line: send_gateway wraps the body in the
 *     brand="sunbiz" shell and appends the operator's signature at send time
 *     (scripts/email_template.py _signature_block). A name here would double it.
 *   - NO draft_critic slop phrases ("just checking in", "circle back",
 *     "quick question", "i hope this finds you well", "moving forward",
 *     "looking forward to hearing back", "no pressure just", fake urgency, etc.)
 *   - NO invented facts. Templates never assert a specific number, referral, or
 *     event about the lead — the operator edits in real specifics. This keeps
 *     them past the critic's ungrounded_claim check.
 *
 * Merge fields: {{first_name}} and {{business_name}} only — the two fields the
 * lead drawer reliably has (record.data.name / record.data.company). Missing
 * values fall back to friendly defaults ("there" / "your business") so a thin
 * lead never renders "Hi ,". Do NOT add merge fields the composer can't supply.
 */

export type SunbizTemplateCategory =
  | "welcome"
  | "educational"
  | "nurture"
  | "follow_up"
  | "application"
  | "document_request"
  | "offer"
  | "objection"
  | "onboarding"
  | "retention"
  | "breakup";

export type SunbizEmailTemplate = {
  /** Stable id (used as the <option> value + React key). */
  id: string;
  category: SunbizTemplateCategory;
  /** Operator-facing label in the dropdown. */
  label: string;
  subject: string;
  body: string;
  /**
   * Safe to send via the BULK pipeline path (LeadPipelineView → /api/leads/bulk),
   * which queues the chosen template to EVERY selected lead with NO per-lead
   * edit step. Templates that assert a specific funnel position or history
   * (approved, funded, paid down, "we spoke today") are marked false so a mixed
   * or wrong bulk selection can't blast a false claim to leads it isn't true for.
   * Undefined === true (safe). The 1:1 lead-drawer composer shows ALL templates
   * regardless — there the operator picks per-lead and edits before sending.
   */
  bulkSafe?: boolean;
};

/**
 * Category display order + group labels for the composer's grouped dropdown
 * (<optgroup>). Ordered to follow the funnel top-to-bottom. A category with no
 * templates is skipped at render time.
 */
export const SUNBIZ_TEMPLATE_CATEGORIES: {
  category: SunbizTemplateCategory;
  label: string;
}[] = [
  { category: "welcome", label: "First touch" },
  { category: "educational", label: "Educate / build trust" },
  { category: "nurture", label: "Nurture — not ready yet" },
  { category: "follow_up", label: "Follow-up — no reply" },
  { category: "application", label: "Application" },
  { category: "document_request", label: "Documents" },
  { category: "offer", label: "Offers & closing" },
  { category: "objection", label: "Handle an objection" },
  { category: "onboarding", label: "After funding" },
  { category: "retention", label: "Retention & referrals" },
  { category: "breakup", label: "Close the thread" },
];

export const SUNBIZ_EMAIL_TEMPLATES: SunbizEmailTemplate[] = [
  // ---- First touch ---------------------------------------------------------
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
    id: "welcome_brief",
    category: "welcome",
    label: "First touch — short & direct",
    subject: "{{business_name}} — funding options in 48 hours",
    body: `Hi {{first_name}},

Short version: send me a completed application and your last 3 months of business bank statements, and I'll bring back the real lender offers for {{business_name}} — typically 3 to 5, inside two days. No cost to look, no obligation.

Want me to send the application link, or would a quick call be easier first?`,
  },

  // ---- Educate / build trust ----------------------------------------------
  {
    id: "how_it_works",
    category: "educational",
    label: "How it works — the 3-step explainer",
    subject: "How funding actually works for {{business_name}}",
    body: `Hi {{first_name}},

A lot of owners aren't sure what they're signing up for, so here's the whole process in three steps:

1. You send a completed application and your last 3 months of business bank statements.
2. I take that one file to our lender network — instead of you applying to lenders one at a time and collecting hard credit pulls.
3. The offers that fit {{business_name}} come back, usually 3 to 5, within a day or two. You compare them side by side and pick one, or walk away.

That's it. Reply here and I'll send the application whenever you're ready.`,
  },
  {
    id: "what_lenders_look_at",
    category: "educational",
    label: "What lenders actually look at",
    subject: "What actually gets {{business_name}} approved",
    body: `Hi {{first_name}},

Since credit score is what everyone worries about, here's the honest picture of what lenders weigh most for a deal like {{business_name}}:

- Consistent revenue and regular deposits in your bank statements — this carries the most weight.
- Time in business and how your account is managed day to day.
- Credit matters, but it's rarely the thing that makes or breaks an approval here.

That's why the statements are the gate — they tell the real story. If you can get me three months of them, I can tell you quickly and honestly where {{business_name}} stands.`,
  },

  // ---- Nurture — not ready yet --------------------------------------------
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
    id: "timing_capital",
    category: "nurture",
    label: "Nurture — line it up before you need it",
    subject: "The best time to set up funding for {{business_name}}",
    body: `Hi {{first_name}},

One thing I've learned placing these deals: the best time to line up capital is before you're up against a deadline. Approvals come easier and terms are better when revenue looks steady — not in the middle of a crunch.

So even if {{business_name}} doesn't need anything today, it can be worth knowing what you'd qualify for now, so the money's there the day an opportunity or a gap shows up.

If that's useful, send me three months of statements and I'll show you where you stand. No need to take anything.`,
  },
  {
    id: "use_case_growth",
    category: "nurture",
    label: "Nurture — funding a specific move",
    subject: "Funding the next move for {{business_name}}",
    body: `Hi {{first_name}},

Most of the capital I place goes to one of a few things — buying inventory ahead of a busy stretch, covering payroll through a slow month, picking up equipment, or bridging the gap before a big invoice gets paid.

If {{business_name}} has a move like that on the horizon, it's worth knowing what's available before you commit to it. One application, real offers back in a day or two, and you decide from there.

Tell me what you're weighing and I'll tell you straight whether funding makes sense for it.`,
  },

  // ---- Follow-up — no reply ------------------------------------------------
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
    id: "follow_up_short",
    category: "follow_up",
    label: "Follow-up — short 2nd nudge",
    subject: "{{business_name}} — here when you're ready",
    body: `Hi {{first_name}},

Not sure if now's the right time, so I'll keep this short. If working capital for {{business_name}} is still on the table, send the application and three months of statements and I'll have offers back in a day or two.

If it isn't, tell me when and I'll hold off until then.`,
  },
  {
    id: "post_call_recap",
    category: "follow_up",
    label: "Post-call recap + next step",
    bulkSafe: false,
    subject: "Recap + next step for {{business_name}}",
    body: `Hi {{first_name}},

Good talking today. Here's the recap so nothing slips:

- You send a completed application plus your last 3 months of business bank statements.
- I take the file to our lenders and bring back the offers that fit {{business_name}}, usually inside 24 to 48 hours.
- You compare and decide — no obligation on any of them.

Send those two things over whenever you can and I'll get moving the same day.`,
  },
  {
    id: "follow_up_final",
    category: "follow_up",
    label: "Follow-up — last note before I close out",
    subject: "Last note on funding for {{business_name}}",
    body: `Hi {{first_name}},

I'll stop here unless I hear from you — I don't want to keep landing in your inbox if the timing's wrong.

If capital for {{business_name}} is still worth a look, reply and I'll pick it right back up, same day. If not, no harm done and the door stays open whenever things change.`,
  },

  // ---- Application ---------------------------------------------------------
  {
    id: "application_link",
    category: "application",
    label: "Send the application (let's start)",
    subject: "Let's get {{business_name}} started",
    body: `Hi {{first_name}},

Let's get the ball rolling. The application takes about ten minutes — it's the basics on {{business_name}} and how to reach you. Once it's in with your last 3 months of business bank statements, I go straight to our lenders and start pulling offers.

I'll send the application link in my next note. If you'd rather I walk you through it line by line, tell me a good time and we'll knock it out together.`,
  },
  {
    id: "missing_item",
    category: "application",
    label: "Application — one item still open",
    bulkSafe: false,
    subject: "Almost there on {{business_name}}'s file",
    body: `Hi {{first_name}},

Your application came through — thanks for that. Before I can send {{business_name}} to lenders, there are still one or two items outstanding. I'll list exactly what's missing right below this line so we can close it out fast:

Once those are in, your file is complete and I can submit it the same day.`,
  },

  // ---- Documents -----------------------------------------------------------
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
    id: "doc_upload_link",
    category: "document_request",
    label: "Document request — secure upload link",
    subject: "Secure link to send {{business_name}}'s statements",
    body: `Hi {{first_name}},

To keep {{business_name}}'s documents off regular email, I'll send you a secure upload link in my next note — it's quicker and safer than attachments.

What I need there: the last 3 months of business bank statements, as full PDF exports from your online banking. As soon as they land, I can take your file to lenders and start pulling offers.

If a link is more hassle than just replying with the files, that works too — whatever's easiest on your end.`,
  },
  {
    id: "stips_request",
    category: "document_request",
    label: "Conditions to fund (stips)",
    bulkSafe: false,
    subject: "Last items to fund {{business_name}}",
    body: `Hi {{first_name}},

Good news first — your file is approved. To release the funds, the lender needs a short list of standard items, nothing unusual: a voided business check, a copy of your ID, and proof of business ownership.

Once those are in, funding for {{business_name}} is usually same-day or next-day. Send them back however's easiest and I'll push this across the line.`,
  },

  // ---- Offers & closing ----------------------------------------------------
  {
    id: "offer",
    category: "offer",
    label: "Offer / approval",
    bulkSafe: false,
    subject: "Offers are in for {{business_name}}",
    body: `Hi {{first_name}},

Good news — your file came back approved and I have offers in hand for {{business_name}}.

Rather than send over a wall of numbers, I'd like to walk you through them for five minutes so you can see the real differences — amount, term, payment, and total cost — and pick the one that fits how your business actually runs.

What time works today or tomorrow? If you'd rather I send the strongest option in writing first, say the word and I'll get it over.`,
  },
  {
    id: "offer_comparison",
    category: "offer",
    label: "Offer — compare the options",
    bulkSafe: false,
    subject: "Your options for {{business_name}}, side by side",
    body: `Hi {{first_name}},

You've got a few offers to choose from, and the right one depends on what matters most to you. The real differences aren't the headline amount — they're the term, the payment size, and the total cost of the money.

Tell me which way you lean for {{business_name}}:
- Most capital up front, or
- Lowest payment / least strain on cash flow, or
- Shortest term so you're paid off fastest.

Give me your priority and I'll point you to the offer that actually fits it.`,
  },
  {
    id: "funding_day",
    category: "offer",
    label: "Offer — contracts & funding day",
    bulkSafe: false,
    subject: "Ready to fund {{business_name}}",
    body: `Hi {{first_name}},

You picked your offer — here's the home stretch. I'll send the contract over to e-sign; once it's back and the standard items are in, the lender typically wires {{business_name}} within one business day.

I'll be on it the whole way and will confirm the moment funds are released. If anything in the contract needs a second look before you sign, tell me and we'll go through it together.`,
  },

  // ---- Handle an objection -------------------------------------------------
  {
    id: "objection_cost",
    category: "objection",
    label: "Objection — cost / rate concern",
    bulkSafe: false,
    subject: "On the cost — a straight answer for {{business_name}}",
    body: `Hi {{first_name}},

Fair question on the cost, and you deserve a straight answer. This isn't a bank term loan and it shouldn't be judged like one — it's faster capital, no collateral, and an approval in days instead of weeks. You're paying for speed and access, and whether that's worth it depends on what the money lets you do.

The honest test: what does the capital let {{business_name}} earn or save versus what it costs? Send me the numbers you're weighing and I'll tell you plainly whether it pencils out. If it doesn't, I'll say so.`,
  },
  {
    id: "objection_existing",
    category: "objection",
    label: "Objection — already has financing",
    bulkSafe: false,
    subject: "If {{business_name}} already has a balance out",
    body: `Hi {{first_name}},

If you've already got a loan or advance out, that doesn't take you out of the running. A lot of the deals I place either sit alongside existing financing or roll it into one cleaner payment, so you're not juggling several at once.

Send me the last 3 months of statements and I'll show you exactly what's realistic for {{business_name}} — whether that's additional capital or consolidating what you've already got. No guessing, just the real options.`,
  },

  // ---- After funding -------------------------------------------------------
  {
    id: "post_funding_welcome",
    category: "onboarding",
    label: "Post-funding — welcome aboard",
    bulkSafe: false,
    subject: "{{business_name}} is funded — what's next",
    body: `Hi {{first_name}},

Congratulations — {{business_name}} is funded. A couple of things to set you up well from here:

- Keep your payments on schedule and your statements clean. That track record is what makes your next round larger and cheaper.
- I'm your point of contact for anything that comes up — keep this email handy.

When you're partway through and thinking about more capital, reach out and I'll have fresh numbers ready. Glad we got this done.`,
  },

  // ---- Retention & referrals ----------------------------------------------
  {
    id: "renewal_eligible",
    category: "retention",
    label: "Retention — renewal / more capital",
    bulkSafe: false,
    subject: "{{business_name}} likely qualifies for more",
    body: `Hi {{first_name}},

Quick one with good news. You've paid down enough that {{business_name}} likely qualifies for additional capital — and usually on better terms than the first round, since you've now got a track record with the lender.

If there's a use for it — inventory, a hire, a project, a cushion — reply and I'll pull current numbers so you can see exactly what's on the table.`,
  },
  {
    id: "referral_request",
    category: "retention",
    label: "Retention — ask for a referral",
    bulkSafe: false,
    subject: "A quick favor — who else could use this?",
    body: `Hi {{first_name}},

Since the funding worked out for {{business_name}}, I'll ask the obvious question: do you know another owner who's tired of waiting on a bank?

Same deal for them — one application, real offers in a day or two, no cost to look. Send me their name or just pass along my email, and I'll take good care of anyone you point my way.`,
  },
  {
    id: "winback",
    category: "retention",
    label: "Retention — win back a past client",
    bulkSafe: false,
    subject: "Been a while — {{business_name}} is still on file",
    body: `Hi {{first_name}},

It's been a while since we funded {{business_name}}, and your file is still here on my end, so there's nothing to redo.

If you're thinking about another round — inventory, payroll, a project, or just getting ahead of a slow stretch — I can have updated offers in front of you in a day or two. Reply and I'll pull fresh numbers.`,
  },

  // ---- Close the thread ----------------------------------------------------
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
 * Templates safe for the no-edit BULK send path (LeadPipelineView's bulk-email
 * dropdown → /api/leads/bulk). Excludes every template flagged bulkSafe:false —
 * i.e. anything that assumes a funnel position or history that would be a false
 * claim if blasted to a lead it isn't true for. The 1:1 composer ignores this
 * and shows the full library. Render the bulk dropdown from THIS list only.
 */
export const SUNBIZ_BULK_SAFE_TEMPLATES: SunbizEmailTemplate[] =
  SUNBIZ_EMAIL_TEMPLATES.filter((t) => t.bulkSafe !== false);

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
