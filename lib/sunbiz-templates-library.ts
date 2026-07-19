/**
 * sunbiz-templates-library.ts - the manual email-template library the SunBiz
 * operators (Matt / Jordan / Alex) pick from in the lead-drawer Send-Email
 * composer (components/leads/LeadDetailDrawer.tsx → EmailComposer).
 *
 * CC's ask (2026-06-23): a reusable set of email templates for the whole
 * SunBiz funding lifecycle, so the team isn't writing from scratch for every
 * lead. Expanded 2026-06-26 (CC: "more options, wide variety, best in
 * industry") from 6 to a full lifecycle library, grouped by category so the
 * dropdown stays navigable. These are MANUAL. The operator picks one, it
 * auto-fills subject + body personalized to the lead, and they edit before
 * hitting Queue send. Nothing here auto-fires (the auto-cadence lives in
 * drip_sequences / lib/sunbiz-default-sequences.ts). The lead drawer is
 * SunBiz-only (TenantLeadDrawerMount gates slug === "sun"), so these never
 * surface on other tenants.
 *
 * Voice + compliance contract (matches lib/sunbiz-default-sequences.ts and the
 * scripts/draft_critic.py slop list, keep new templates inside it):
 *   - Warm, plain, specific, low-pressure. First-person direct-funder language:
 *     SunBiz funds the deal ("bank statements are the gate", "we review your
 *     file", "we fund you", funds in days). NEVER tell or hint to a merchant
 *     that their file is shopped to third-party lenders/funders. Say "we" /
 *     "our team" / "our underwriting", never "our lenders" / "lender offers".
 *   - NO sign-off / "- Name" line: send_gateway wraps the body in the
 *     brand="sunbiz" shell and appends the operator's signature at send time
 *     (scripts/email_template.py _signature_block). A name here would double it.
 *   - NO draft_critic slop phrases ("just checking in", "circle back",
 *     "quick question", "i hope this finds you well", "moving forward",
 *     "looking forward to hearing back", "no pressure just", fake urgency, etc.)
 *   - NO invented facts. Templates never assert a specific number, referral, or
 *     event about the lead. The operator edits in real specifics. This keeps
 *     them past the critic's ungrounded_claim check.
 *
 * Merge fields: {{first_name}} and {{business_name}} only, the two fields the
 * lead drawer reliably has (record.data.name / record.data.company). Missing
 * values fall back to friendly defaults ("there" / "your business") so a thin
 * lead never renders "Hi ,". Do NOT add merge fields the composer can't supply.
 */

export type SunbizTemplateCategory =
  | "welcome"
  | "educational"
  | "nurture"
  | "industry"
  | "use_case"
  | "speed"
  | "consolidation"
  | "seasonal"
  | "amount"
  | "follow_up"
  | "reengagement"
  | "application"
  | "viewed_application"
  | "signed_application"
  | "document_request"
  | "offer"
  | "objection"
  | "onboarding"
  | "retention"
  | "renewal"
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
   * regardless. There the operator picks per-lead and edits before sending.
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
  { category: "nurture", label: "Nurture - not ready yet" },
  { category: "industry", label: "Industry-specific" },
  { category: "use_case", label: "By use case (payroll, inventory, equipment...)" },
  { category: "speed", label: "Fast funding / urgency" },
  { category: "consolidation", label: "Consolidate / refinance" },
  { category: "seasonal", label: "Seasonal & timely" },
  { category: "amount", label: "By funding amount" },
  { category: "follow_up", label: "Follow-up - no reply" },
  { category: "reengagement", label: "Re-engage cold leads" },
  { category: "application", label: "Application" },
  { category: "viewed_application", label: "App viewed - finish it" },
  { category: "signed_application", label: "App signed - send statements" },
  { category: "document_request", label: "Documents" },
  { category: "offer", label: "Offers & closing" },
  { category: "objection", label: "Handle an objection" },
  { category: "onboarding", label: "After funding" },
  { category: "retention", label: "Retention & referrals" },
  { category: "renewal", label: "Renewal / more capital" },
  { category: "breakup", label: "Close the thread" },
];

export const SUNBIZ_EMAIL_TEMPLATES: SunbizEmailTemplate[] = [
  // ---- First touch ---------------------------------------------------------
  {
    id: "welcome",
    category: "welcome",
    label: "New inquiry - welcome",
    subject: "Your funding request for {{business_name}}",
    body: `Hi {{first_name}},

Thanks for reaching out about funding for {{business_name}}. Once I have a completed application and your last 3 months of business bank statements, your file goes straight into our underwriting and I come back with the options that actually fit, usually within 24 to 48 hours.

There's no cost to see what you qualify for, and no obligation to take anything.

If you can send me a good time today or tomorrow, I'll walk you through the application and answer anything before you fill it out.`,
  },
  {
    id: "welcome_brief",
    category: "welcome",
    label: "First touch - short & direct",
    subject: "{{business_name}} - funding options in 48 hours",
    body: `Hi {{first_name}},

Short version: send me a completed application and your last 3 months of business bank statements, and I'll bring back real options for {{business_name}}, usually inside two days. No cost to look, no obligation.

Want me to send the application link, or would a quick call be easier first?`,
  },

  // ---- Educate / build trust ----------------------------------------------
  {
    id: "how_it_works",
    category: "educational",
    label: "How it works - the 3-step explainer",
    subject: "How funding actually works for {{business_name}}",
    body: `Hi {{first_name}},

A lot of owners aren't sure what they're signing up for, so here's the whole process in three steps:

1. You send a completed application and your last 3 months of business bank statements.
2. Your file goes straight into our underwriting, one place, so you're not applying all over town and collecting hard credit pulls.
3. The options that fit {{business_name}} come back, usually within a day or two. You compare them side by side and pick one, or walk away.

That's it. Reply here and I'll send the application whenever you're ready.`,
  },
  {
    id: "what_lenders_look_at",
    category: "educational",
    label: "What lenders actually look at",
    subject: "What actually gets {{business_name}} approved",
    body: `Hi {{first_name}},

Since credit score is what everyone worries about, here's the honest picture of what we weigh most for a deal like {{business_name}}:

- Consistent revenue and regular deposits in your bank statements. This carries the most weight.
- Time in business and how your account is managed day to day.
- Credit matters, but it's rarely the thing that makes or breaks an approval here.

That's why the statements are the gate. They tell the real story. If you can get me three months of them, I can tell you quickly and honestly where {{business_name}} stands.`,
  },

  // ---- Nurture - not ready yet --------------------------------------------
  {
    id: "value_add",
    category: "nurture",
    label: "Value-add / nurture",
    subject: "A faster path to capital for {{business_name}}",
    body: `Hi {{first_name}},

A bit of context on why owners come to us instead of chasing this down themselves: one application, one place, and we underwrite it in house, so you're looking at real options side by side instead of taking one number on faith.

Most of the deals we fund close in a few days, not weeks, and because we know up front what we can approve, we can usually tell you what's realistic for {{business_name}} before you spend time chasing a no.

If now's the right time to look at working capital, reply here and I'll get you the application. If it isn't, tell me roughly when and I'll check back then.`,
  },
  {
    id: "timing_capital",
    category: "nurture",
    label: "Nurture - line it up before you need it",
    subject: "The best time to set up funding for {{business_name}}",
    body: `Hi {{first_name}},

One thing I've learned funding these deals: the best time to line up capital is before you're up against a deadline. Approvals come easier and terms are better when revenue looks steady, not in the middle of a crunch.

So even if {{business_name}} doesn't need anything today, it can be worth knowing what you'd qualify for now, so the money's there the day an opportunity or a gap shows up.

If that's useful, send me three months of statements and I'll show you where you stand. No need to take anything.`,
  },
  {
    id: "use_case_growth",
    category: "nurture",
    label: "Nurture - funding a specific move",
    subject: "Funding the next move for {{business_name}}",
    body: `Hi {{first_name}},

Most of the capital we put out goes to one of a few things: buying inventory ahead of a busy stretch, covering payroll through a slow month, picking up equipment, or bridging the gap before a big invoice gets paid.

If {{business_name}} has a move like that on the horizon, it's worth knowing what's available before you commit to it. One application, real options back in a day or two, and you decide from there.

Tell me what you're weighing and I'll tell you straight whether funding makes sense for it.`,
  },

  // ---- Industry-specific ---------------------------------------------------
  {
    id: "industry_restaurant",
    category: "industry",
    label: "Industry - restaurant / food service",
    subject: "Funding built for restaurants like {{business_name}}",
    body: `Hi {{first_name}},

Restaurants run on tight cash flow. Payroll lands every two weeks, food and supply costs move with the season, and a slow stretch can squeeze you fast. A lot of the owners I work with use funding to smooth exactly that: cover a slow month, stock up before a busy run, or fix the equipment that can't wait.

Because your card and deposit volume shows up clearly in your bank statements, food-service files tend to move quickly on our end. Send me three months of statements for {{business_name}} and I'll show you what's realistic.`,
  },
  {
    id: "industry_construction",
    category: "industry",
    label: "Industry - construction / contractors",
    subject: "Capital that keeps {{business_name}}'s jobs moving",
    body: `Hi {{first_name}},

Construction has a cash-flow problem baked in: you front materials and labor, then wait 30, 60, sometimes 90 days to get paid. A lot of contractors I work with use funding to bridge that gap, take the next job without waiting on the last invoice to clear.

One application and three months of statements, and I can show {{business_name}} what's available to cover materials, make payroll, or pick up equipment between draws. Reply and I'll get you started.`,
  },
  {
    id: "industry_trucking",
    category: "industry",
    label: "Industry - trucking / transportation",
    subject: "Funding for {{business_name}} between settlements",
    body: `Hi {{first_name}},

Trucking lives and dies on cash flow. Fuel, repairs, and insurance hit now, but settlement checks come later. The owner-operators and fleets I work with use funding to keep trucks rolling: cover a major repair, fuel up for a long haul, or bridge the wait on a load that's already delivered.

Send me three months of business bank statements for {{business_name}} and I'll show you what you'd qualify for. Most files like this move quickly.`,
  },

  // ---- By use case ---------------------------------------------------------
  {
    id: "use_case_payroll",
    category: "use_case",
    label: "Use case - make payroll",
    subject: "Covering payroll for {{business_name}}",
    body: `Hi {{first_name}},

Payroll is the one bill that can't slip. Your people show up, they get paid. When revenue is lumpy or a big client pays late, a lot of owners use short-term capital to keep payroll steady without touching the reserves they need for everything else.

If that's the gap for {{business_name}}, one application and three months of statements gets you real options in a day or two. Reply and I'll send the application.`,
  },
  {
    id: "use_case_inventory",
    category: "use_case",
    label: "Use case - buy inventory ahead",
    subject: "Stocking up ahead of demand for {{business_name}}",
    body: `Hi {{first_name}},

The classic squeeze: you need to buy inventory now to sell it later, but the cash to buy it is tied up in what you haven't sold yet. Funding closes that gap: buy ahead of a busy stretch, take a bulk discount, or keep shelves full without draining your account.

If {{business_name}} has a buy coming up, send me three months of statements and I'll show you what's available so you can move on it. Real options back in a day or two.`,
  },
  {
    id: "use_case_equipment",
    category: "use_case",
    label: "Use case - equipment / repairs",
    subject: "Funding equipment for {{business_name}}",
    body: `Hi {{first_name}},

When a piece of equipment goes down or you need to add capacity, waiting isn't really an option. Every day it's out costs you work. Funding lets you fix or buy now and pay it back as the equipment earns, instead of draining cash you need elsewhere.

If that's the situation at {{business_name}}, one application and three months of statements puts real options in front of you in a day or two. Reply and I'll get it moving.`,
  },

  // ---- Fast funding / urgency ----------------------------------------------
  {
    id: "speed_fast_turnaround",
    category: "speed",
    label: "Speed - funds in days, not weeks",
    subject: "How fast {{business_name}} can have funds",
    body: `Hi {{first_name}},

If timing is the thing on your mind: this isn't a bank process. With a completed application and three months of business bank statements, I can have real options back for {{business_name}} in a day or two, and most deals fund within a few days of you picking one.

The statements are the gate, so the faster I have those, the faster everything moves. Send them over and I'll start the same day.`,
  },
  {
    id: "speed_deadline",
    category: "speed",
    label: "Speed - working against a deadline",
    bulkSafe: false,
    subject: "Working against a deadline for {{business_name}}?",
    body: `Hi {{first_name}},

You mentioned timing is tight, so let's move accordingly. If you can get me a completed application and three months of business bank statements today, I'll get your file into underwriting right away and have options for {{business_name}} back fast.

The one thing that slows these down is waiting on statements. Everything else I can run on my end. Send those over and I'll keep this on the fast track.`,
  },

  // ---- Consolidate / refinance ---------------------------------------------
  {
    id: "consolidation_simplify",
    category: "consolidation",
    label: "Consolidate - one cleaner payment",
    subject: "Turning several payments into one for {{business_name}}",
    body: `Hi {{first_name}},

If {{business_name}} is juggling more than one advance or loan, it's worth a look at consolidating. A lot of the deals I fund roll several balances into one cleaner payment, which can free up daily cash flow and make the whole thing easier to manage.

Send me three months of statements and I'll show you whether consolidating makes sense for your numbers, or whether you're better off leaving things as they are. Straight answer either way.`,
  },
  {
    id: "consolidation_refi",
    category: "consolidation",
    label: "Refinance - better terms as you pay down",
    subject: "A look at refinancing for {{business_name}}",
    body: `Hi {{first_name}},

As you pay down existing financing, you build a track record, and that track record can open better terms than what you started with. For a lot of owners, refinancing into a stronger position lowers the daily strain and frees up room to grow.

If you've got a balance out, send me three months of statements and I'll show you honestly whether {{business_name}} can do better than where it sits today. No guessing.`,
  },

  // ---- Seasonal & timely ---------------------------------------------------
  {
    id: "seasonal_busy_prep",
    category: "seasonal",
    label: "Seasonal - gear up before your busy season",
    subject: "Getting {{business_name}} ready for the busy stretch",
    body: `Hi {{first_name}},

Most businesses have a season that makes the year, and the smart move is lining up capital before it hits, not scrambling in the middle of it. Stock up, staff up, or get the marketing out ahead of demand while approvals are easy and your numbers look steady.

If {{business_name}} has a busy stretch coming, send me three months of statements now and I'll show you what's available so you're ready when it lands.`,
  },
  {
    id: "seasonal_slow_bridge",
    category: "seasonal",
    label: "Seasonal - bridge a slow stretch",
    subject: "Bridging the slow season for {{business_name}}",
    body: `Hi {{first_name}},

Every business has a slow stretch. The trick is getting through it without falling behind on the bills that don't slow down with revenue. Short-term capital can carry {{business_name}} across the gap, then get paid back as things pick up again.

If that's where you're headed, it's easier to set up now than in the thick of it. Send me three months of statements and I'll show you what you'd qualify for.`,
  },

  // ---- By funding amount ---------------------------------------------------
  {
    id: "amount_up_to_500k",
    category: "amount",
    label: "Amount - up to $500K, apply to get quoted",
    subject: "How much {{business_name}} could qualify for",
    body: `Hi {{first_name}},

The honest answer to "how much can I get" is that it depends on your revenue and how your bank statements look. The program funds up to $500,000, and the way to find your real number is to apply and get quoted.

There's no cost to see where {{business_name}} lands and no obligation to take anything. Send me a completed application and three months of statements and I'll bring back the actual numbers.`,
  },
  {
    id: "amount_smaller_start",
    category: "amount",
    label: "Amount - start smaller, grow the line",
    subject: "Starting right-sized for {{business_name}}",
    body: `Hi {{first_name}},

You don't have to take the biggest number on the table. A lot of owners start with a right-sized amount, pay it down cleanly, and use that track record to come back for more, larger and on better terms the second time around.

The program funds up to $500,000, but the right starting point is whatever {{business_name}} can put to work and pay back comfortably. Send me three months of statements and I'll help you find that number.`,
  },
  {
    id: "amount_larger_deal",
    category: "amount",
    label: "Amount - larger capital need",
    subject: "Funding a larger move for {{business_name}}",
    body: `Hi {{first_name}},

If you're planning something bigger like a major expansion, a large inventory buy, or a new location, the program funds up to $500,000, and the way to find your real ceiling is to apply and get quoted on your actual numbers.

Send me a completed application and three months of business bank statements, and I'll bring back what {{business_name}} qualifies for so you can plan around a real figure, not a guess.`,
  },

  // ---- Follow-up - no reply ------------------------------------------------
  {
    id: "follow_up",
    category: "follow_up",
    label: "Follow-up (no reply yet)",
    subject: "Still worth a look at funding for {{business_name}}?",
    body: `Hi {{first_name}},

I haven't heard back, so I want to make sure this didn't get buried. The offer stands: send me a completed application and 3 months of bank statements, and I'll bring you the options that fit {{business_name}}, usually within a day or two.

If the timing's off, just tell me when to check back and I'll stay out of your inbox until then. If you're ready, reply here and I'll send the application link.`,
  },
  {
    id: "follow_up_short",
    category: "follow_up",
    label: "Follow-up - short 2nd nudge",
    subject: "{{business_name}} - here when you're ready",
    body: `Hi {{first_name}},

Not sure if now's the right time, so I'll keep this short. If working capital for {{business_name}} is still on the table, send the application and three months of statements and I'll have options back in a day or two.

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
- Your file goes into underwriting and I bring back the options that fit {{business_name}}, usually inside 24 to 48 hours.
- You compare and decide, no obligation on any of them.

Send those two things over whenever you can and I'll get moving the same day.`,
  },
  {
    id: "follow_up_final",
    category: "follow_up",
    label: "Follow-up - last note before I close out",
    subject: "Last note on funding for {{business_name}}",
    body: `Hi {{first_name}},

I'll stop here unless I hear from you. I don't want to keep landing in your inbox if the timing's wrong.

If capital for {{business_name}} is still worth a look, reply and I'll pick it right back up, same day. If not, no harm done and the door stays open whenever things change.`,
  },

  // ---- Re-engage cold leads ------------------------------------------------
  {
    id: "reengage_still_open",
    category: "reengagement",
    // History-dependent ("since we talked", "still right here"), not safe for a
    // mixed bulk blast that may include leads with no prior interaction (Codex P2).
    bulkSafe: false,
    label: "Re-engage - your file is still open",
    subject: "{{business_name}} - still on file whenever you need it",
    body: `Hi {{first_name}},

It's been a stretch since we talked about funding for {{business_name}}, and your file is still right here on my end, nothing to redo.

If working capital is back on your radar, whether it's a project, a slow month, inventory, or payroll, reply and I'll pull current numbers so you can see exactly what's available now. Things change quarter to quarter, so the figure may look different than last time.`,
  },
  {
    id: "reengage_whats_changed",
    category: "reengagement",
    // "Last time the timing wasn't right" assumes prior contact, not bulk-safe.
    bulkSafe: false,
    label: "Re-engage - what's changed on your end?",
    subject: "Has anything changed for {{business_name}}?",
    body: `Hi {{first_name}},

A lot can shift in a few months: revenue, a new opportunity, a gap that wasn't there before. Last time the timing wasn't right for {{business_name}}, and I get that.

If the picture's changed at all, it takes three months of statements for me to show you where you'd stand today. No cost to look, and if it's still not the moment, just tell me when and I'll hold off.`,
  },
  {
    id: "reengage_new_options",
    category: "reengagement",
    // "last time we spoke" assumes prior contact, not bulk-safe.
    bulkSafe: false,
    label: "Re-engage - fresh program options",
    subject: "New options worth a look for {{business_name}}",
    body: `Hi {{first_name}},

Reaching back out because our funding programs have shifted, and there may be a better fit for {{business_name}} now than there was last time we spoke.

If working capital is worth another look, send me three months of statements and I'll show you what's on the table today, real options, no cost to see them. If the timing's still off, point me to a better month and I'll check back then.`,
  },

  // ---- Application ---------------------------------------------------------
  {
    id: "application_link",
    category: "application",
    label: "Send the application (let's start)",
    subject: "Let's get {{business_name}} started",
    body: `Hi {{first_name}},

Let's get the ball rolling. The application takes about ten minutes. It's the basics on {{business_name}} and how to reach you. Once it's in with your last 3 months of business bank statements, it goes straight into underwriting and I start pulling together your options.

I'll send the application link in my next note. If you'd rather I walk you through it line by line, tell me a good time and we'll knock it out together.`,
  },
  {
    id: "missing_item",
    category: "application",
    label: "Application - one item still open",
    bulkSafe: false,
    subject: "Almost there on {{business_name}}'s file",
    body: `Hi {{first_name}},

Your application came through, thanks for that. Before I can move {{business_name}} into underwriting, there are still one or two items outstanding. I'll list exactly what's missing right below this line so we can close it out fast:

Once those are in, your file is complete and I can move it the same day.`,
  },

  // ---- App viewed - finish it ---------------------------------------------
  {
    id: "viewed_nudge",
    category: "viewed_application",
    label: "App viewed - gentle nudge to finish",
    subject: "Finishing the application for {{business_name}}",
    body: `Hi {{first_name}},

If you started the application for {{business_name}} and didn't get all the way through, no problem at all. Tell me where it got stuck and I'll handle the rest with you in a couple of minutes.

The day it's complete with your last 3 months of business bank statements, your file goes into underwriting and I come back with the options that actually fit, usually inside 24 to 48 hours.`,
  },
  {
    id: "viewed_value",
    category: "viewed_application",
    label: "App viewed - two minutes to real offers",
    subject: "Two minutes between you and real numbers",
    body: `Hi {{first_name}},

The application is the only thing standing between {{business_name}} and seeing real numbers. It takes about two minutes, there's no hard credit pull to fill it out, and no obligation on anything that comes back.

Want me to send a fresh link, or would it be easier to do it together on a quick call?`,
  },
  {
    id: "viewed_seen",
    category: "viewed_application",
    label: "App viewed - saw it open (1:1)",
    bulkSafe: false,
    subject: "Saw the application come up on your end",
    body: `Hi {{first_name}},

I saw the application for {{business_name}} open up but not come back completed. If something on it wasn't clear, tell me which part and I'll walk you through it.

Once it's in with your last 3 months of bank statements, your file is ready for underwriting the same day.`,
  },

  // ---- App signed - send statements ---------------------------------------
  {
    id: "signed_statements",
    category: "signed_application",
    label: "App signed - statements are the last step",
    subject: "Last step for {{business_name}}: bank statements",
    body: `Hi {{first_name}},

Your application is in, thank you. The last thing I need to move {{business_name}} into underwriting is your most recent 3 months of business bank statements. Those are the gate, they carry the most weight in what you qualify for.

Send them over and I'll have your file underwritten the same day, with your options usually back in 24 to 48 hours.`,
  },
  {
    id: "signed_upload",
    category: "signed_application",
    label: "App signed - secure upload link",
    subject: "Where to send your statements, {{first_name}}",
    body: `Hi {{first_name}},

We're at the final step for {{business_name}}. I'll send you a secure upload link for your last 3 months of business bank statements, or you can reply with them attached, whichever is easier.

The moment they're in, your file goes straight into underwriting.`,
  },
  {
    id: "signed_privacy",
    category: "signed_application",
    label: "App signed - statements + privacy reassurance (1:1)",
    bulkSafe: false,
    subject: "Your file's ready, just need statements",
    body: `Hi {{first_name}},

Thanks for getting the application signed. The only thing left for {{business_name}} is your last 3 months of business bank statements. They stay with us, they're only used to underwrite your file, and they never leave our team without your say.

Send them when you can and I'll move your file the same day.`,
  },

  // ---- Documents -----------------------------------------------------------
  {
    id: "document_request",
    category: "document_request",
    label: "Document request (bank statements)",
    subject: "One thing to unlock funding for {{business_name}}",
    body: `Hi {{first_name}},

Your file is ready for underwriting. The only thing I'm missing is 3 months of business bank statements. PDF exports from your online banking are perfect (full statements, not screenshots).

Once those are in, underwriting runs and I can start pulling together your options for {{business_name}}. Without them, we can't price the deal, so this is the one step that moves everything forward.

You can reply with them attached, or tell me what's easiest and I'll send you a secure upload link.`,
  },
  {
    id: "doc_upload_link",
    category: "document_request",
    label: "Document request - secure upload link",
    subject: "Secure link to send {{business_name}}'s statements",
    body: `Hi {{first_name}},

To keep {{business_name}}'s documents off regular email, I'll send you a secure upload link in my next note. It's quicker and safer than attachments.

What I need there: the last 3 months of business bank statements, as full PDF exports from your online banking. As soon as they land, I can get your file into underwriting and start pulling together your options.

If a link is more hassle than just replying with the files, that works too, whatever's easiest on your end.`,
  },
  {
    id: "stips_request",
    category: "document_request",
    label: "Conditions to fund (stips)",
    bulkSafe: false,
    subject: "Last items to fund {{business_name}}",
    body: `Hi {{first_name}},

Good news first, your file is approved. To release the funds, we need a short list of standard items, nothing unusual: a voided business check, a copy of your ID, and proof of business ownership.

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

Good news, your file came back approved and I have offers in hand for {{business_name}}.

Rather than send over a wall of numbers, I'd like to walk you through them for five minutes so you can see the real differences in amount, term, payment, and total cost, and pick the one that fits how your business actually runs.

What time works today or tomorrow? If you'd rather I send the strongest option in writing first, say the word and I'll get it over.`,
  },
  {
    id: "offer_comparison",
    category: "offer",
    label: "Offer - compare the options",
    bulkSafe: false,
    subject: "Your options for {{business_name}}, side by side",
    body: `Hi {{first_name}},

You've got a few offers to choose from, and the right one depends on what matters most to you. The real differences aren't the headline amount. They're the term, the payment size, and the total cost of the money.

Tell me which way you lean for {{business_name}}:
- Most capital up front, or
- Lowest payment / least strain on cash flow, or
- Shortest term so you're paid off fastest.

Give me your priority and I'll point you to the offer that actually fits it.`,
  },
  {
    id: "funding_day",
    category: "offer",
    label: "Offer - contracts & funding day",
    bulkSafe: false,
    subject: "Ready to fund {{business_name}}",
    body: `Hi {{first_name}},

You picked your offer. Here's the home stretch. I'll send the contract over to e-sign; once it's back and the standard items are in, we typically wire {{business_name}} within one business day.

I'll be on it the whole way and will confirm the moment funds are released. If anything in the contract needs a second look before you sign, tell me and we'll go through it together.`,
  },

  // ---- Handle an objection -------------------------------------------------
  {
    id: "objection_cost",
    category: "objection",
    label: "Objection - cost / rate concern",
    bulkSafe: false,
    subject: "On the cost - a straight answer for {{business_name}}",
    body: `Hi {{first_name}},

Fair question on the cost, and you deserve a straight answer. This isn't a bank term loan and it shouldn't be judged like one. It's faster capital, no collateral, and an approval in days instead of weeks. You're paying for speed and access, and whether that's worth it depends on what the money lets you do.

The honest test: what does the capital let {{business_name}} earn or save versus what it costs? Send me the numbers you're weighing and I'll tell you plainly whether it pencils out. If it doesn't, I'll say so.`,
  },
  {
    id: "objection_existing",
    category: "objection",
    label: "Objection - already has financing",
    bulkSafe: false,
    subject: "If {{business_name}} already has a balance out",
    body: `Hi {{first_name}},

If you've already got a loan or advance out, that doesn't take you out of the running. A lot of the deals I fund either sit alongside existing financing or roll it into one cleaner payment, so you're not juggling several at once.

Send me the last 3 months of statements and I'll show you exactly what's realistic for {{business_name}}, whether that's additional capital or consolidating what you've already got. No guessing, just the real options.`,
  },

  // ---- After funding -------------------------------------------------------
  {
    id: "post_funding_welcome",
    category: "onboarding",
    label: "Post-funding - welcome aboard",
    bulkSafe: false,
    subject: "{{business_name}} is funded - what's next",
    body: `Hi {{first_name}},

Congratulations, {{business_name}} is funded. A couple of things to set you up well from here:

- Keep your payments on schedule and your statements clean. That track record is what makes your next round larger and cheaper.
- I'm your point of contact for anything that comes up, so keep this email handy.

When you're partway through and thinking about more capital, reach out and I'll have fresh numbers ready. Glad we got this done.`,
  },

  // ---- Retention & referrals ----------------------------------------------
  {
    id: "renewal_eligible",
    category: "retention",
    label: "Retention - renewal / more capital",
    bulkSafe: false,
    subject: "{{business_name}} likely qualifies for more",
    body: `Hi {{first_name}},

Quick one with good news. You've paid down enough that {{business_name}} likely qualifies for additional capital, and usually on better terms than the first round, since you've now got a track record with us.

If there's a use for it, whether it's inventory, a hire, a project, or a cushion, reply and I'll pull current numbers so you can see exactly what's on the table.`,
  },
  {
    id: "referral_request",
    category: "retention",
    label: "Retention - ask for a referral",
    bulkSafe: false,
    subject: "A quick favor - who else could use this?",
    body: `Hi {{first_name}},

Since the funding worked out for {{business_name}}, I'll ask the obvious question: do you know another owner who's tired of waiting on a bank?

Same deal for them: one application, real options in a day or two, no cost to look. Send me their name or just pass along my email, and I'll take good care of anyone you point my way.`,
  },
  {
    id: "winback",
    category: "retention",
    label: "Retention - win back a past client",
    bulkSafe: false,
    subject: "Been a while - {{business_name}} is still on file",
    body: `Hi {{first_name}},

It's been a while since we funded {{business_name}}, and your file is still here on my end, so there's nothing to redo.

If you're thinking about another round, whether it's inventory, payroll, a project, or just getting ahead of a slow stretch, I can have updated options in front of you in a day or two. Reply and I'll pull fresh numbers.`,
  },

  // ---- Renewal / more capital ----------------------------------------------
  {
    id: "renewal_halfway",
    category: "renewal",
    label: "Renewal - you're paid partway down",
    bulkSafe: false,
    subject: "{{business_name}} is in range for a renewal",
    body: `Hi {{first_name}},

You're far enough into your current balance that {{business_name}} is in range for a renewal, and renewals usually come back larger and on better terms, since you've now got a clean track record with us.

If there's a use for the capital, reply and I'll pull current numbers so you can see exactly what's available. No obligation to take it, just worth knowing where you stand.`,
  },
  {
    id: "renewal_more_capital",
    category: "renewal",
    label: "Renewal - need more before you're paid off",
    bulkSafe: false,
    subject: "More capital for {{business_name}} sooner than you'd think",
    body: `Hi {{first_name}},

You don't always have to wait until you're fully paid off to get more. Depending on how {{business_name}} has performed since we funded you, there may be room to add capital now, either on top of your current balance or by rolling it into one cleaner payment.

Send me your three most recent statements and I'll show you which path actually makes sense for your numbers. Straight answer either way.`,
  },
  {
    id: "renewal_better_terms",
    category: "renewal",
    label: "Renewal - better terms this round",
    bulkSafe: false,
    subject: "Better terms waiting for {{business_name}}",
    body: `Hi {{first_name}},

Here's the upside of a clean payment history: the second round is almost always better than the first. Since we funded {{business_name}}, you've built the track record we price on, which usually means more capital, lower cost, or both.

If you've got a use for it, reply and I'll pull fresh numbers so you can compare them against where you are now. No obligation, just the real picture.`,
  },

  // ---- Close the thread ----------------------------------------------------
  {
    id: "breakup",
    category: "breakup",
    label: "Breakup / close the thread",
    subject: "Closing out {{business_name}}'s file, for now",
    body: `Hi {{first_name}},

I don't want to keep landing in your inbox if the timing isn't right, so I'm going to close out {{business_name}}'s file on my end for now.

If anything changes, whether it's a project, payroll, inventory, or a slow month, reply to this email and I'll pick it right back up. Your information stays on file, so there's nothing to redo.

Wishing you a strong quarter either way.`,
  },
];

/**
 * Templates safe for the no-edit BULK send path (LeadPipelineView's bulk-email
 * dropdown → /api/leads/bulk). Excludes every template flagged bulkSafe:false,
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
