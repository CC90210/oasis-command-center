/**
 * lib/drips/sunbiz-application-chase.ts — the Form 2 completion chase.
 *
 * ONE definition, imported by the tenant seed
 * (lib/sunbiz-default-sequences.ts), by the migration that rewrites the live
 * sequence, and by the test that pins it. A second hand-maintained copy would
 * drift, and the thing that drifts here reaches real merchants.
 *
 * WHY THIS EXISTS (Adon, 2026-08-20). Leads who finish the interest form land
 * in `viewed_application` and need to complete their personalised full
 * application (Form 2). The chase was TWO steps: one email, then one SMS.
 * Once those fired the lead sat in the stage forever with nothing scheduled.
 * Measured on the day: 234 leads in `viewed_application`, 232 previously
 * enrolled, and only **15** with any future contact booked. ~217 people were
 * parked there receiving nothing.
 *
 * Note the reported cause was different from the real one. The unique Form 2
 * link was never missing: every one of these emails has carried
 * {{lead.application_url}} since 2026-08-15, and lib/drips/executor.ts mints a
 * fresh per-lead link when a lead has none, HALTING rather than sending a
 * generic one. The defect was that the sequence ran out.
 *
 * DESIGN RULES, each load-bearing:
 *
 *   1. EMAIL ONLY. Adon, 2026-08-20: no SMS asking anyone to complete an
 *      application, "not even if it's a live sub". The SMS step is removed
 *      rather than reworded. tests/sunbiz-application-chase.test.ts fails if
 *      a non-email step is ever added back.
 *
 *   2. EVERY step carries {{lead.application_url}}. That token is what arms
 *      the executor's mint-and-halt guard: a step without it can silently
 *      send a merchant a message with no way to act on it.
 *
 *   3. Direct-funder positioning. SunBiz IS the funder in merchant-facing
 *      copy, so this text must pass matchPositioningPhrases + matchLenderNames
 *      (lib/integrations/blast-safety-core.ts) — the drip executor runs
 *      sanitizeBlastMessage over it at send time and BLOCKS on a hit.
 *
 *   4. No em dashes anywhere in merchant copy.
 *
 * CADENCE. `delay_minutes` is measured from the moment the PREVIOUS step
 * completes (executor.ts scheduleNext), not from enrolment, so these compound
 * to roughly five days: 30m, +1d, +1d, +1d, +2d. Adon asked for a hard chase
 * over about five days, then stop.
 */

import type { DripStep } from "./types";

/** The merge token that arms the executor's per-lead link minting. */
export const APPLICATION_LINK_TOKEN = "{{lead.application_url}}";

/**
 * Five email steps, opener through last call.
 *
 * Step 0 is preserved EXACTLY as it ran in production, variants included: it
 * is the one message in this arc with a measured conversion history, so the
 * rebuild extends the chase rather than restarting it from unproven copy.
 */
export const SUNBIZ_VIEWED_APPLICATION_STEPS: DripStep[] = [
  // ── 0. Opener (unchanged, +30 min) ─────────────────────────────────────────
  {
    channel: "email",
    delay_minutes: 30,
    role: "opener",
    subject: "Heads up on the application for {{lead.business_name}}",
    body:
      "Hi {{lead.contact_name}},\n\nSaw you started your application - you're most of the way there. Pick it back up here (your answers are saved):\n\n{{lead.application_url}}\n\nThe bank statements at the end are the key piece - once those are in, our underwriting runs and I can get you an offer.\n\n- {{lead.rep_name}}, SunBiz Funding",
    subject_variants: [
      "Heads up on the application for {{lead.business_name}}",
      "You're almost there {{lead.business_name}}",
      "Finish your SunBiz application for {{lead.business_name}}",
    ],
    body_variants: [
      "Hi {{lead.contact_name}},\n\nSaw you started your application - you're most of the way there. Pick it back up here (your answers are saved):\n\n{{lead.application_url}}\n\nThe bank statements at the end are the key piece - once those are in, our underwriting runs and I can get you an offer.\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nQuick nudge - your application for {{lead.business_name}} is open but not finished. Wrap it up here and I'll take it from there:\n\n{{lead.application_url}}\n\nIf anything's holding you up, just reply and I'll help.\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nYou're one step from underwriting. Finish the application and add 3 months of business bank statements, and I can get {{lead.business_name}} an offer:\n\n{{lead.application_url}}\n\nHappy to walk you through any part of it.\n\n- {{lead.rep_name}}, SunBiz Funding",
    ],
  },

  // ── 1. The gating piece (+24h) ─────────────────────────────────────────────
  {
    channel: "email",
    delay_minutes: 1440,
    role: "nudge",
    subject: "The last piece for {{lead.business_name}}",
    body:
      "Hi {{lead.contact_name}},\n\nYour application is still open. The part that holds most files up is the last step: 3 months of business bank statements, exported straight from your online banking as PDFs.\n\nPick up where you left off:\n\n{{lead.application_url}}\n\nOnce those land, our underwriting runs and I can come back to you with real numbers.\n\n- {{lead.rep_name}}, SunBiz Funding",
    subject_variants: [
      "The last piece for {{lead.business_name}}",
      "3 statements away from an answer",
      "What's still outstanding on your file",
    ],
    body_variants: [
      "Hi {{lead.contact_name}},\n\nYour application is still open. The part that holds most files up is the last step: 3 months of business bank statements, exported straight from your online banking as PDFs.\n\nPick up where you left off:\n\n{{lead.application_url}}\n\nOnce those land, our underwriting runs and I can come back to you with real numbers.\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nChecking in on {{lead.business_name}}'s application. Everything you've entered is saved, so you're only picking up where you stopped:\n\n{{lead.application_url}}\n\nThe statements at the end are the only thing standing between you and an answer.\n\n- {{lead.rep_name}}, SunBiz Funding",
    ],
  },

  // ── 2. Offer to do it together (+24h) ──────────────────────────────────────
  {
    channel: "email",
    delay_minutes: 1440,
    role: "question",
    subject: "Want to run through it together?",
    body:
      "Hi {{lead.contact_name}},\n\nIf the application is sitting half finished because it's fiddly, I'm happy to go through it with you on the phone. Most people get it done in under ten minutes that way.\n\nYour link stays open here:\n\n{{lead.application_url}}\n\nReply with a time that suits you and I'll call.\n\n- {{lead.rep_name}}, SunBiz Funding",
    subject_variants: [
      "Want to run through it together?",
      "10 minutes on the phone and it's done",
      "Happy to help you finish this",
    ],
    body_variants: [
      "Hi {{lead.contact_name}},\n\nIf the application is sitting half finished because it's fiddly, I'm happy to go through it with you on the phone. Most people get it done in under ten minutes that way.\n\nYour link stays open here:\n\n{{lead.application_url}}\n\nReply with a time that suits you and I'll call.\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nIs something on the application unclear? Tell me which part and I'll answer it directly, or we can do it together on a quick call.\n\n{{lead.application_url}}\n\nEither way, no pressure on {{lead.business_name}}.\n\n- {{lead.rep_name}}, SunBiz Funding",
    ],
  },

  // ── 3. What happens once it's in (+24h) ────────────────────────────────────
  {
    channel: "email",
    delay_minutes: 1440,
    role: "value",
    subject: "What happens after you hit submit",
    body:
      "Hi {{lead.contact_name}},\n\nIn case it helps to know what you're walking into: once your application and statements are in, we underwrite the file ourselves. Filling it out costs you nothing, there's no hard credit pull to look at it, and you're under no obligation to take what comes back.\n\nMost files get an answer the same day.\n\n{{lead.application_url}}\n\n- {{lead.rep_name}}, SunBiz Funding",
    subject_variants: [
      "What happens after you hit submit",
      "No obligation on anything that comes back",
      "How we look at {{lead.business_name}}'s file",
    ],
    body_variants: [
      "Hi {{lead.contact_name}},\n\nIn case it helps to know what you're walking into: once your application and statements are in, we underwrite the file ourselves. Filling it out costs you nothing, there's no hard credit pull to look at it, and you're under no obligation to take what comes back.\n\nMost files get an answer the same day.\n\n{{lead.application_url}}\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nWorth saying plainly: finishing the application does not commit {{lead.business_name}} to anything. We review the file, we come back with what we can do, and you decide from there.\n\n{{lead.application_url}}\n\n- {{lead.rep_name}}, SunBiz Funding",
    ],
  },

  // ── 4. Last call (+48h) ────────────────────────────────────────────────────
  {
    channel: "email",
    delay_minutes: 2880,
    role: "last_call",
    subject: "Closing out {{lead.business_name}}'s file, for now",
    body:
      "Hi {{lead.contact_name}},\n\nI don't want to keep landing in your inbox, so this is my last note on this one.\n\nYour application is still open and everything you entered is saved:\n\n{{lead.application_url}}\n\nIf the timing isn't right, that's completely fine. Nothing is lost, and you can pick it back up whenever things change.\n\n- {{lead.rep_name}}, SunBiz Funding",
    subject_variants: [
      "Closing out {{lead.business_name}}'s file, for now",
      "Last note from me on this",
      "Leaving your application open",
    ],
    body_variants: [
      "Hi {{lead.contact_name}},\n\nI don't want to keep landing in your inbox, so this is my last note on this one.\n\nYour application is still open and everything you entered is saved:\n\n{{lead.application_url}}\n\nIf the timing isn't right, that's completely fine. Nothing is lost, and you can pick it back up whenever things change.\n\n- {{lead.rep_name}}, SunBiz Funding",
      "Hi {{lead.contact_name}},\n\nLast one from me. I'll stop here so I'm not a nuisance.\n\nIf you'd still like numbers for {{lead.business_name}}, your saved application is here:\n\n{{lead.application_url}}\n\nOtherwise, all the best with the quarter.\n\n- {{lead.rep_name}}, SunBiz Funding",
    ],
  },
];
