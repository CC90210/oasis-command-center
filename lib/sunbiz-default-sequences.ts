/**
 * sunbiz-default-sequences.ts: the starter drip sequences for new
 * SunBiz tenants (Phase 4.5 of the SunBiz CRM build).
 *
 * These match the cadence Jordan + CC locked in at the 2026-05-15
 * meeting. They get inserted into drip_sequences when a SunBiz tenant
 * is provisioned via /api/onboarding/wizard or directly by Bravo. The
 * operator can edit / disable / delete any of them from /sequences.
 *
 * Why seed defaults instead of leaving the tenant empty:
 *   - SunBiz funding ops can't function without follow-up cadence.
 *     Forcing every new tenant to design their own drips from scratch
 *     means real leads ghost the pipeline while the operator figures
 *     out the JSON.
 *   - The seeded drips are tuned for the meeting-agreed lead.stage +
 *     offer.stage enums (Phase 2) so they fire end-to-end from day 1.
 *
 * Cadence and copy are deliberately conservative:
 *   - Cooldowns leave room for the operator to layer manual touches
 *   - "Solara" / "Helios" sender labels match SunBiz's agent personas
 *   - Plain text only; no HTML / images / links beyond simple URLs
 *   - All copy is meeting-tested wording from Text Torrent existing
 *     usage, not freshly-AI-generated cold-email-school filler
 */

import type { DripStep, DripTriggerFilter } from "./drips/types";

export type DefaultSequence = {
  name: string;
  description: string;
  trigger_event: string;
  trigger_filter: DripTriggerFilter;
  steps: DripStep[];
  one_per_lead: boolean;
  email_class?: "transactional" | "commercial";
  /** Whether the sequence is enabled on seed. Defaults to true. Set to
   *  false for sensitive drips (compliance-flagged, collections, etc.)
   *  that operators must approve before they fire on real leads. */
  enabled_on_seed?: boolean;
};

export const SUNBIZ_DEFAULT_SEQUENCES: DefaultSequence[] = [
  // ─────────────────────────────────────────────────────────────────
  // 1. Any earlier stage -> follow_up : 3-touch follow-up cadence
  // (post-migration-064 stages: hot_lead / missing_info, any of these
  // landing on follow_up via operator action or stage engine.)
  // ─────────────────────────────────────────────────────────────────
  {
    name: "Follow-up sequence",
    description:
      "Fires when a lead reaches the follow_up stage. 3-touch SMS+email cadence to get them on a call.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "follow_up" },
    one_per_lead: true,
    steps: [
      {
        channel: "email",
        delay_minutes: 10,
        from_label: "Solara",
        subject: "Quick funding options for {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nFollowing up on yesterday's note. We fund businesses like yours directly, and we can usually turn a file around fast once we have the basics.\n\nWhat does your monthly revenue look like right now? If it's in the {{lead.monthly_revenue}} range, send it over and my underwriters can take a real look. What we can do depends on the file, but it's worth reviewing.\n\nReply with a good time today or tomorrow.\n\nSolara, SunBiz Funding",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24, // 24h
        from_label: "Solara",
        body:
          "Hi {{lead.contact_name}}, this is Solara at SunBiz Funding. Saw {{lead.business_name}} and wanted to check if you're looking at funding for growth or working capital this quarter. Reply YES if you'd like to talk options.",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24 * 3, // +3 days
        from_label: "Solara",
        body:
          "{{lead.contact_name}}, last note from me on funding. Send a 1-line reply (yes / not now / never) and I'll match the pace. Otherwise I'll close out the thread on my end.",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 1b. UW Sheet -> qualified-deal first touch : 3-touch
  // Fires when Solara's "Breeze UW Entry Sheet" scrubber lands a qualified
  // MCA deal in uw_sheet (after Ezra approves it off the scrub queue). These
  // are scrubbed-from-sheet merchants, so it's a first-touch cadence: book a
  // call + request the application + 3 months of bank statements so the deal
  // can advance. send_gateway enforces CASL / opt-out / TCPA windows.
  // ─────────────────────────────────────────────────────────────────
  {
    name: "UW Sheet - qualified-deal first touch",
    description:
      "Fires when a scrubbed MCA deal lands in uw_sheet (post-Ezra approval). 3-touch SMS+email first-contact cadence to book a call and collect bank statements.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "uw_sheet" },
    one_per_lead: true,
    steps: [
      {
        channel: "email",
        delay_minutes: 10,
        from_label: "Solara",
        subject: "Funding options for {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nFollowing up. {{lead.business_name}} looks well-positioned for an advance. To get you a real answer I just need a 2-minute application and your last 3 months of business bank statements (PDF exports from online banking). Once those are in, my underwriters review the file and come back to you quickly. What we can offer depends on the file, and there's no obligation.\n\nReply here and I'll send the link.\n\nSolara, SunBiz Funding",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24, // 24h
        from_label: "Solara",
        body:
          "Hi {{lead.contact_name}}, Solara at SunBiz Funding. {{lead.business_name}} looks like a strong fit for working capital. We fund direct and can move fast once we see your file. Reply YES and I'll send the quick application plus the docs we need.",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24 * 3, // +3 days
        from_label: "Solara",
        body:
          "{{lead.contact_name}}, still happy to get {{lead.business_name}} in front of my underwriters. Send a 1-line reply (yes / not now) and I'll match the pace. Otherwise I'll close the thread on my end.",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 2. Viewed application -> nudge : 2-touch
  // ─────────────────────────────────────────────────────────────────
  {
    name: "Viewed application nudge",
    description:
      "Fires when a lead opens their personalized application link. Nudges them through the form.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "viewed_application" },
    one_per_lead: true,
    steps: [
      {
        channel: "email",
        delay_minutes: 30,
        from_label: "Solara",
        subject: "Heads up on the application for {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nWanted to follow up. Once you finish the application, my underwriters can review the file and come back with what we can do. The bank statements at step 3 are the gating piece; without them nothing can go into underwriting.\n\nIf anything's holding you up, reply here and I'll help.\n\nSolara, SunBiz Funding",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24, // 24h
        from_label: "Solara",
        body:
          "Hi {{lead.contact_name}}, saw you opened the application. Anything I can clarify? It's 3 quick steps: basic info, the app itself, then 3 months of bank statements at the end.",
      },
    ],
  },

  // 2026-06-18 (CC): the "Submitted - underwriting wait" sequence was removed
  // with the `submitted` stage. Underwriting is now an operator-driven action
  // (the Bank-tab "Run underwriting" CTA), not an auto-stage, so there's no
  // merchant auto-SMS on submit. An underwriting-triggered confirmation can be
  // added later if wanted.

  // ─────────────────────────────────────────────────────────────────
  // 4. Ghost -> 1-month revival (was "Declined", retargeted 2026-06-18)
  // ─────────────────────────────────────────────────────────────────
  {
    // 2026-06-18 (CC): retargeted from the removed `declined` stage to `ghost`
    // (where negative-reply / no-response leads now land). Same 1-month
    // re-engagement, now serving the ghost bucket.
    name: "Ghost - 1-month check-back",
    description:
      "Professional 1-month re-engagement for leads that went cold or replied 'not now'. Doesn't burn the bridge.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    // 2026-07-15 (Adon): the `ghost` stage was removed, no-response leads now
    // route to follow_up, so this trigger can no longer fire. Disabled on seed;
    // its replacement is the Follow-up rework (Build 9).
    trigger_filter: { entity: "lead", field: "stage", to: "ghost" },
    one_per_lead: true,
    enabled_on_seed: false,
    steps: [
      {
        channel: "email",
        delay_minutes: 60 * 24 * 30, // 30 days
        from_label: "Solara",
        subject: "Checking in on {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nIt's been about a month since we last talked. Things shift. What didn't fit last month sometimes does this month, especially if revenue's trending up or you've added new business.\n\nIf you're open to another look, send me an updated month of bank statements and I'll run the file again on our end. No pressure, just want to keep the door open.\n\nSolara, SunBiz Funding",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 5. Missing Info -> 3-touch info request (Phase 5 of Jordan/Oasis
  //    2026-05-23 restructure). Replaces the prior no_offers_available
  //    sequence. That stage was retired in migration 064 (consolidated
  //    into `declined`, which already has its own 1-month check-back).
  // ─────────────────────────────────────────────────────────────────
  {
    name: "Missing info - chase + book call",
    description:
      "Fires when a lead lands in missing_info (manual or classifier-flagged). Two-touch cadence to request the outstanding info and book a call if they go silent.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "missing_info" },
    one_per_lead: true,
    steps: [
      {
        channel: "email",
        delay_minutes: 30,
        from_label: "Solara",
        subject: "Quick info to unblock {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nFollowing up. Your file is sitting in our queue waiting on a couple data points before my underwriters can price it. Easiest path: reply here with a good time today or tomorrow for a 5-min call and we'll knock it out together.\n\nSolara, SunBiz Funding",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24 * 2, // 48h
        from_label: "Solara",
        body:
          "Hi {{lead.contact_name}}, your file is one step from underwriting but we're missing a couple things. Reply here and I'll list what's outstanding, or text me a good time to call.",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 6. Sent application -> immediate access email. This is intentionally its
  // own email-only sequence: a TextTorrent outage on the longer cadence must
  // never prevent the merchant from receiving their private application link.
  {
    name: "Sent application - access link",
    description:
      "Immediately gives each merchant their private, resumable application link when the lead reaches Sent Application.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "sent_application" },
    one_per_lead: true,
    email_class: "transactional",
    steps: [
      {
        channel: "email",
        delay_minutes: 0,
        from_label: "Solara",
        subject: "Your application for {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nHere is your secure SunBiz application link for {{lead.business_name}}. It is tied to your record, so you can start now or return later and continue where you left off.\n\nOpen your application:\n{{lead.application_url}}\n\nOnce the application and your last 3 months of business bank statements are submitted, your file moves into underwriting.\n\nIf you have any trouble opening it, reply to this email and I'll help.\n\nSolara, SunBiz Funding",
      },
    ],
  },

  // 7. Sent application -> completion reminder cadence
  // Phase 15.1 add (2026-05-15 evening). Adon: meeting decision was
  // "every stage triggers something". A lead at sent_application
  // that hasn't viewed the link is the canonical "they got distracted"
  // case, 24h SMS to bring them back.
  // ─────────────────────────────────────────────────────────────────
  {
    // Sent-application COMPLETION drip (2026-07-21). The FULL production cadence
    // is escalating and ~46 steps (SMS+email at +6h, then daily for a week, then
    // every 2 days for a month), and a lead still here after ~37 days is
    // auto-moved to dead_file by /api/cron/sweep-stale-sent-app. That full
    // cadence is DB-managed and installed via scripts/install-sent-app-cadence
    // (the drip_sequences row is the source of truth — the seed only bootstraps a
    // brand-new tenant, which is then re-run through the install script). This
    // seed carries a representative STARTER pair so a fresh tenant isn't empty.
    name: "Sent application - completion drip",
    description:
      "Nudges the merchant to finish their application. Escalates from +6h through ~37 days (SMS+email), then auto-retires to Dead. Stops the moment the app is completed (stage leaves sent_application).",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "sent_application" },
    one_per_lead: true,
    steps: [
      {
        channel: "sms",
        delay_minutes: 60 * 6, // +6h — first nudge
        from_label: "Solara",
        body:
          "Hi {{lead.contact_name}}, your SunBiz application link is still open. Whenever you finish it and send your last 3 months of business bank statements, I get your file straight into underwriting. Anything blocking you?",
      },
      {
        channel: "email",
        delay_minutes: 5, // paired email, right after the SMS
        from_label: "Solara",
        subject: "Finishing your application for {{lead.business_name}}",
        // Injects the merchant's per-lead resumable application link. The dispatch
        // service mints one on the fly if the lead lacks it, or HALTS the email
        // rather than send a generic link (see processEmailStep pre-flight). Every
        // email step across the live sequences carries this token; the live
        // drip_sequences rows are the source of truth (installed via scripts).
        body:
          "Hi {{lead.contact_name}},\n\nYour SunBiz application is started but not finished yet. Once it's in with your last 3 months of business bank statements, your file goes straight into our underwriting and I come back with the options that actually fit, usually within 24 to 48 hours.\n\nIf anything on the application is unclear, reply here and I'll walk you through it.\n\nStart or pick up your application here:\n{{lead.application_url}}\n\nSolara, SunBiz Funding",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 7. Signed application -> bank-statement nag
  // The form is 3-step: basic → app → bank statements. signed means
  // they finished steps 1+2; the bank-statements upload is the last
  // gate to underwriting. Without those statements underwriting can't
  // price the deal. 12h SMS + 36h email.
  // ─────────────────────────────────────────────────────────────────
  {
    name: "Signed application - bank statements nag",
    description:
      "Fires when a lead signs the application but hasn't uploaded bank statements yet. Without statements no underwriting can fire.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "signed_application" },
    one_per_lead: true,
    steps: [
      {
        channel: "email",
        delay_minutes: 60 * 12, // 12h
        from_label: "Solara",
        subject: "Last step for {{lead.business_name}}: bank statements",
        body:
          "Hi {{lead.contact_name}},\n\nYour signed application is in. For my underwriters to review and price your file, I need 3 months of bank statements (PDF exports from your online banking work great).\n\nUpload at the same application link. Underwriting fires automatically once they land.\n\nSolara, SunBiz Funding",
      },
      {
        channel: "sms",
        delay_minutes: 60 * 24 * 1.5, // ~36h
        from_label: "Solara",
        body:
          "Nice, your application is signed. Last step is 3 months of bank statements (PDFs from your bank's online portal). Without them we can't price the deal. Upload at the same link.",
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────
  // 8. Default -> 60-day soft re-engagement
  // Phase 15.1 add. Sensitive: a defaulted lead means the borrower
  // missed payments on a previous funded deal. Compliance: NO new
  // funding pitch in the same touch as the default. Just a check-in.
  // Adon: review this copy with collections before turning the sequence
  // on. Default-state is disabled by default (see seed loop).
  // ─────────────────────────────────────────────────────────────────
  {
    name: "Default - 60-day soft check-in (DISABLED by default)",
    description:
      "Sensitive: fires 60 days after a lead's funded_deal defaults. Soft check-in only, no new funding pitch in this touch. Review with compliance before enabling.",
    trigger_event: "BRAVO_RECORD_STATUS_CHANGED",
    trigger_filter: { entity: "lead", field: "stage", to: "default" },
    one_per_lead: true,
    enabled_on_seed: false,
    steps: [
      {
        channel: "email",
        delay_minutes: 60 * 24 * 60, // 60 days
        from_label: "Solara",
        subject: "Checking in on {{lead.business_name}}",
        body:
          "Hi {{lead.contact_name}},\n\nIt's been a while. I wanted to reach out and see how things are going on your end, no pitch attached, just a check-in.\n\nIf the business is back on its feet and you'd ever want to talk again, I'm here. If not, no harm done. Just close out the thread and I'll respect that.\n\nSolara, SunBiz Funding",
      },
    ],
  },
];

/**
 * Build rows ready for `db.from("drip_sequences").insert(...)` for a
 * given tenant. Caller fills in tenant_id + created_by.
 */
export function buildSunbizSequenceRows(
  tenantId: string,
  createdBy: string | null,
): Array<{
  tenant_id: string;
  name: string;
  description: string;
  trigger_event: string;
  trigger_filter: DripTriggerFilter;
  steps: DripStep[];
  enabled: boolean;
  one_per_lead: boolean;
  email_class: "transactional" | "commercial";
  created_by: string | null;
}> {
  return SUNBIZ_DEFAULT_SEQUENCES.map((s) => ({
    tenant_id: tenantId,
    name: s.name,
    description: s.description,
    trigger_event: s.trigger_event,
    trigger_filter: s.trigger_filter,
    steps: s.steps,
    // Per-seed enabled flag (defaults to true). Sensitive sequences
    // (e.g. defaulted-borrower re-engagement) explicitly set
    // enabled_on_seed: false so the operator approves copy before
    // they fire on real leads.
    enabled: s.enabled_on_seed !== false,
    one_per_lead: s.one_per_lead,
    email_class: s.email_class || "commercial",
    created_by: createdBy,
  }));
}
