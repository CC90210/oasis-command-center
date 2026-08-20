/**
 * oasis-client-onboarding-seed.ts — the intake a WON website client fills in.
 *
 * Public URL (private link in practice — it is sent to a named client, not
 * advertised): https://oasisai.work/f/oasis-webdev/client-onboarding
 *
 * WHAT THIS FORM IS FOR, AND WHY IT IS SHORT.
 * OASIS houses every client's automation in-house: each client site posts its
 * contact form to ONE central OASIS webhook, and ONE shared agent answers all
 * of them, replying AS that client's brand. The agent's identity per inbound
 * post is a `client_automation_profiles` row — and every field in that row that
 * only the client can answer is asked here. Nothing else is.
 *
 * The single most important answer is step 1: the email address(es) copied on
 * every automated reply. That CC is the entire transparency contract of the
 * model — the owner watches their own brand speak, in real time, without ever
 * handing over a password.
 *
 * WHAT THIS FORM MUST NEVER ASK FOR. Mailbox passwords, app passwords, SMTP
 * credentials, or any account login. OASIS supplies the sending infrastructure
 * and owns the sending identity; the client supplies an address to be CC'd. A
 * field that asks a client for a credential would invert the whole model and
 * make OASIS liable for a secret it does not need. Do not add one.
 *
 * WHERE THE ANSWERS GO. Submissions ingest through app/api/forms/submit — the
 * same hardened path every tenant form uses — landing on the client's lead
 * record. lib/client-automation-profiles.ts then turns a completed submission
 * into the profile row the shared agent reads, and issues the site's ingest
 * key.
 *
 * Source of truth for the shape. Editing this file changes NOTHING until the
 * seed is re-run — the live definition lives in the `forms` table:
 *   node --env-file=.env.local --import tsx scripts/seed-client-onboarding-form.ts --apply
 */
import type { FormBranding, FormStep } from "./types";

/** Public slug → /f/oasis-webdev/client-onboarding */
export const CLIENT_ONBOARDING_SLUG = "client-onboarding";

/**
 * The OASIS website-sales tenant. Deliberately NOT a hardcoded UUID, unlike the
 * two `oasis-ai-cc` funnel seeds: this repo has no verified tenant id for
 * oasis-webdev, and inventing one would seed the form into nothing (or, worse,
 * into another tenant). The seed script resolves the id from this slug at run
 * time and refuses to write if it does not resolve.
 */
export const CLIENT_ONBOARDING_TENANT_SLUG = "oasis-webdev";

export const CLIENT_ONBOARDING_NAME = "Client Onboarding";
export const CLIENT_ONBOARDING_DESCRIPTION =
  "Post-sale intake for a won OASIS website client — reply CCs, brand identity, " +
  "voice rules, site assets, and written permission to send on their behalf.";

/**
 * Completing onboarding moves the client from `onboarding` to `in_build`.
 *
 * close_website_deal() (database/146) already parks a won lead at `onboarding`.
 * The gate between `onboarding` and `in_build` is exactly this form: assets in,
 * voice rules agreed, permission recorded, build can start. Both keys are in
 * OASIS_LEAD_STAGES (lib/oasis-stage-meta.ts) — the 14-stage lifecycle runs
 * won → onboarding → in_build → client_review → launched.
 */
export const CLIENT_ONBOARDING_ON_COMPLETE_STAGE = "in_build";

/**
 * THE EXACT DISCLOSURE THE CLIENT AGREES TO, as one exported constant.
 *
 * This is the permission that lets OASIS send email as this business. Consent
 * evidence is only worth something if it can reproduce the wording the person
 * actually saw, so the string is exported rather than typed inline: the
 * attestation field's label below and the `send_consent_evidence` written by
 * lib/client-automation-profiles.ts are the SAME string, and a test pins them
 * together. Changing this wording changes what past clients agreed to only if
 * you also fail to re-record it — so if you edit it, re-seed AND treat existing
 * profiles as consented under the old text.
 */
export const CLIENT_ONBOARDING_CONSENT_TEXT =
  "I authorize OASIS to reply to enquiries from my website on my behalf, using " +
  "an OASIS-operated email address that sends under my business name, and I " +
  "confirm that every one of those replies will copy the email address(es) I " +
  "gave in step 1 so I can see them. I can pause this at any time by telling OASIS.";

export const CLIENT_ONBOARDING_BRANDING: FormBranding = {
  // The established OASIS mark — gold on near-black, same as `start` and
  // `ai-audit`. A client who just paid should land on something that looks like
  // the company they bought from, not a generic form canvas.
  primary_color: "#e8c547",
  accent_color: "#faf9f5",
  headline: "Let's get your site and your automation live",
  subheadline:
    "Five short steps, about six minutes. We never ask for passwords or logins — " +
    "OASIS supplies the infrastructure. All we need is where to copy you.",
  thanks_message:
    "Got it. Your build starts from this. You'll get a preview link to approve " +
    "before anything goes live, and every automated reply will land in your inbox too.",
};

/**
 * Industries, for the shared classifier's first cut at an inbound. `combobox`
 * (pick or type) rather than `select`: a local-business list is never complete,
 * and forcing "Other" loses the one word that would have told the agent what
 * this business does.
 */
const CLIENT_INDUSTRIES: string[] = [
  "HVAC / Heating & Cooling",
  "Plumbing",
  "Electrical",
  "Roofing",
  "Landscaping / Lawn Care",
  "General Contracting / Renovation",
  "Painting",
  "Cleaning Services",
  "Pest Control",
  "Moving & Storage",
  "Auto Repair",
  "Auto Sales",
  "Real Estate",
  "Property Management",
  "Law Firm",
  "Accounting / Bookkeeping",
  "Insurance",
  "Financial Services",
  "Medical Practice",
  "Dental Practice",
  "Chiropractic / Physio",
  "Veterinary",
  "Salon / Barbershop",
  "Spa / Med Spa",
  "Fitness / Gym",
  "Restaurant",
  "Catering / Events",
  "Photography / Video",
  "Retail Store",
  "E-commerce",
  "Trucking / Logistics",
  "Construction Supply",
  "Childcare / Daycare",
  "Education / Tutoring",
  "Consulting / Professional Services",
];

export const CLIENT_ONBOARDING_STEPS: FormStep[] = [
  // ── Step 1 — Where replies go ─────────────────────────────────────────────
  // FIRST, because it is the one thing OASIS genuinely cannot proceed without,
  // and because an abandoned form that got this far is still actionable. Every
  // other step describes the business; this one is the transparency contract.
  {
    key: "replies",
    title: "Where should we copy you?",
    description:
      "When someone fills in your website form, we answer them in your name — " +
      "and copy you on every single reply, so nothing happens behind your back.",
    cta_label: "Next",
    fields: [
      {
        // Named `email`, not `cc_email_primary`, ON PURPOSE. The personalized
        // /f/<tenant>/<slug>/<lead_token> route prefills from the lead record
        // through a fixed key whitelist — business_name, contact_name, email,
        // phone, monthly_revenue, business_state, industry
        // (app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx). Matching the
        // whitelist means the owner opens the link and this field is already
        // filled with the address OASIS has been emailing them at, editable.
        // The one field the whole model depends on should not start blank.
        name: "email",
        label: "Your email — copied on every reply we send",
        type: "email",
        required: true,
        placeholder: "you@yourbusiness.com",
        help: "This is the most important answer on the form. Check the spelling.",
      },
      {
        name: "cc_emails_additional",
        label: "Anyone else who should be copied",
        type: "textarea",
        placeholder: "office@yourbusiness.com\npartner@yourbusiness.com",
        help: "Optional. One email per line.",
        maxLength: 1000,
      },
      {
        name: "notification_email",
        label: "Where should urgent enquiries be flagged?",
        type: "email",
        placeholder: "Leave blank to use the email above",
        help: "Optional — for the ones that shouldn't wait, like an emergency call-out.",
      },
      {
        // `phone`, again to hit the lead-token prefill whitelist.
        name: "phone",
        label: "Best phone number for you",
        type: "phone",
        required: true,
        placeholder: "+1 …",
        help: "Used when we need a human answer fast. Never published to customers unless you ask.",
      },
    ],
  },

  // ── Step 2 — Business identity ────────────────────────────────────────────
  // Everything the shared agent needs to answer "who am I speaking as, and what
  // can I truthfully say this business does". Hours and timezone are here
  // together on purpose — hours without a timezone tell the agent nothing.
  {
    key: "business",
    title: "About the business",
    description: "This is what the assistant will know about you when it answers.",
    cta_label: "Next",
    fields: [
      {
        name: "business_name",
        label: "Business name, exactly as customers should see it",
        type: "text",
        required: true,
        placeholder: "Acme Heating & Cooling",
        help: "The name replies will be signed with.",
        maxLength: 120,
      },
      {
        name: "what_you_do",
        label: "What do you do, in one sentence?",
        type: "textarea",
        required: true,
        placeholder:
          "We install and repair residential furnaces and AC units across the West Island.",
        help: "Write it the way you'd say it to a customer on the phone.",
        maxLength: 400,
      },
      {
        name: "industry",
        label: "Industry",
        type: "combobox",
        required: true,
        help: "Pick the closest match — or type your own if it isn't listed.",
        options: CLIENT_INDUSTRIES.map((v) => ({ value: v, label: v })),
      },
      {
        name: "service_area",
        label: "Where do you serve?",
        type: "text",
        required: true,
        placeholder: "Montreal + West Island, within 40 km",
        help: "So we don't book you a job three hours away.",
        maxLength: 200,
      },
      {
        name: "business_hours",
        label: "Your hours",
        type: "textarea",
        required: true,
        placeholder: "Mon–Fri 8am–6pm\nSat 9am–1pm\nSun closed",
        help: "Plain English is fine. Tells the assistant when to promise a callback.",
        maxLength: 500,
      },
      {
        name: "timezone",
        label: "Your timezone",
        type: "select",
        required: true,
        help: "Your hours mean nothing without this.",
        options: [
          { value: "America/Toronto", label: "Eastern — Toronto / Montreal / New York" },
          { value: "America/Halifax", label: "Atlantic — Halifax" },
          { value: "America/St_Johns", label: "Newfoundland — St. John's" },
          { value: "America/Winnipeg", label: "Central — Winnipeg / Chicago" },
          { value: "America/Edmonton", label: "Mountain — Edmonton / Denver" },
          { value: "America/Vancouver", label: "Pacific — Vancouver / Los Angeles" },
          { value: "America/Phoenix", label: "Arizona — no daylight saving" },
        ],
      },
      {
        name: "top_services",
        label: "The 3–5 services you most want leads for",
        type: "textarea",
        required: true,
        placeholder: "Furnace installation\nAC repair\nAnnual maintenance plans",
        help: "One per line. The assistant prioritises enquiries that match these.",
        maxLength: 600,
      },
    ],
  },

  // ── Step 3 — Voice & rules ────────────────────────────────────────────────
  // The guardrails. `never_say` is REQUIRED with an explicit escape hatch
  // because "we had no idea it would quote a price" is the complaint this
  // question exists to prevent, and an optional field gets skipped by exactly
  // the busy owner who most needs to answer it.
  {
    key: "voice",
    title: "How should we sound — and what's off limits?",
    description:
      "The assistant answers in your name, so these are the rules it follows.",
    cta_label: "Next",
    fields: [
      {
        name: "reply_tone",
        label: "How should replies read?",
        type: "select",
        required: true,
        options: [
          { value: "formal", label: "Formal — full sentences, no contractions" },
          { value: "professional", label: "Professional — polished but human (most businesses)" },
          { value: "friendly", label: "Friendly — warm and conversational" },
          { value: "casual", label: "Casual — short, plain, first-name basis" },
        ],
      },
      {
        name: "brand_voice",
        label: "Anything specific about how you talk to customers?",
        type: "textarea",
        placeholder:
          "We always say 'no charge for the estimate'. Never use the word 'cheap'.",
        help: "Optional. Phrases you always use, words you hate — anything that sounds like you.",
        maxLength: 800,
      },
      {
        name: "never_say",
        label: "What must we NEVER say or promise?",
        type: "textarea",
        required: true,
        placeholder:
          "Never quote a price\nNever promise same-day service\nNever say the work is guaranteed",
        help:
          "One per line. Prices, guarantees, timelines — anything only you can commit to. " +
          "If there's genuinely nothing, write \"nothing\".",
        maxLength: 800,
      },
      {
        name: "response_speed",
        label: "How fast should customers hear back?",
        type: "select",
        required: true,
        help: "The assistant replies immediately either way — this sets what it promises YOU'll do next.",
        options: [
          { value: "5", label: "Within 5 minutes — speed is how we win" },
          { value: "15", label: "Within 15 minutes" },
          { value: "60", label: "Within the hour" },
          { value: "240", label: "Within 4 hours" },
          { value: "480", label: "Same business day" },
          { value: "1440", label: "Next business day" },
        ],
      },
    ],
  },

  // ── Step 4 — Website assets ───────────────────────────────────────────────
  // `website_domain` is the load-bearing field of the entire model: it is the
  // key the inbound webhook matches on to decide which client an enquiry
  // belongs to. The help text spells out the exact normalized form because a
  // domain typed as "https://acme.com/" produces a profile that silently never
  // matches a real post.
  {
    key: "assets",
    title: "Your website",
    description: "Domain, logo, photos — whatever you already have. Missing pieces are fine.",
    cta_label: "Next",
    fields: [
      {
        name: "website_domain",
        label: "Your website domain",
        type: "text",
        required: true,
        placeholder: "acmeheating.com",
        help: "Just the domain — no \"https://\", no \"www.\", no slash at the end.",
        maxLength: 253,
      },
      {
        name: "domain_status",
        label: "Who owns that domain right now?",
        type: "select",
        required: true,
        options: [
          { value: "own_it", label: "I own it and can give access to the DNS" },
          { value: "own_no_access", label: "I own it but I don't know how to get in" },
          { value: "third_party", label: "My old web guy / agency controls it" },
          { value: "need_one", label: "I don't have one yet — OASIS should register it" },
        ],
        help: "No wrong answer. It just changes who does the DNS work.",
      },
      {
        name: "brand_assets",
        label: "Logo, photos, anything visual",
        type: "file_upload_multi",
        accept: ["image/*", "application/pdf"],
        max_files: 40,
        max_file_mb: 25,
        help:
          "Drag everything in at once — logo, team photos, job photos, old brochures. " +
          "Real photos of your actual work beat stock images every time.",
      },
      {
        name: "existing_copy",
        label: "Text you already have that we should reuse",
        type: "textarea",
        placeholder: "Paste your About page, service descriptions, anything written.",
        help: "Optional. Saves us guessing at your story.",
        maxLength: 5000,
      },
      {
        name: "reviews_link",
        label: "Link to your reviews",
        type: "url",
        placeholder: "https://g.page/…",
        help: "Optional. Google, Facebook, HomeStars — wherever your reviews live.",
      },
      {
        name: "booking_link",
        label: "Booking or scheduling link",
        type: "url",
        placeholder: "https://calendly.com/…",
        help: "Optional — if you have one, the assistant can send customers straight to it.",
      },
      {
        name: "social_profiles",
        label: "Social profiles",
        type: "textarea",
        placeholder: "https://instagram.com/acmeheating\nhttps://facebook.com/acmeheating",
        help: "Optional. One per line.",
        maxLength: 1000,
      },
    ],
  },

  // ── Step 5 — Approval & permission ────────────────────────────────────────
  // The consent step. Two things are being recorded: who signs off on the built
  // site, and the written authority for OASIS to send email as this business.
  // The attestation is a single-option `select` — the house pattern for a
  // required agreement (lib/forms/sunbiz-templates.ts) — with the full
  // disclosure as its label so the exact wording is what gets stored as
  // evidence, not a paraphrase of it.
  {
    key: "approval",
    title: "Last step — sign off",
    description:
      "Who approves the finished site, and your permission for us to answer on your behalf.",
    cta_label: "Finish onboarding",
    fields: [
      {
        name: "approver_name",
        label: "Who approves the website before it goes live?",
        type: "text",
        required: true,
        placeholder: "Full name",
        help: "The one person whose yes means launch. Usually you.",
        maxLength: 120,
      },
      {
        name: "approver_email",
        label: "Their email",
        type: "email",
        required: true,
        placeholder: "you@yourbusiness.com",
        help: "Where the preview link goes.",
      },
      {
        name: "send_consent",
        label: CLIENT_ONBOARDING_CONSENT_TEXT,
        type: "select",
        required: true,
        options: [{ value: "agreed", label: "Yes, I authorize this" }],
        help: "We never ask for your email password. OASIS supplies the sending address.",
      },
      {
        name: "consent_signed_name",
        label: "Type your full name to confirm",
        type: "text",
        required: true,
        placeholder: "Full name",
        // Defaults to the approver's name so the client doesn't retype it, the
        // same pattern the SunBiz signature step uses. Still editable — the
        // person granting sending authority is not always the site approver.
        prefill_from: "approver_name",
        maxLength: 120,
      },
    ],
  },
];

/** How many steps a client walks through. Derived, never typed twice. */
export const CLIENT_ONBOARDING_STEP_COUNT = CLIENT_ONBOARDING_STEPS.length;

/**
 * Assemble the `forms` table row (minus the DB-generated id/timestamps).
 *
 * tenantId is REQUIRED, unlike the two funnel seeds which default to a
 * hardcoded uuid: there is no verified oasis-webdev tenant id in this repo, and
 * a wrong default would seed a client-facing form into the wrong tenant. The
 * seed script resolves it from CLIENT_ONBOARDING_TENANT_SLUG.
 */
export function buildClientOnboardingRow(tenantId: string) {
  if (!tenantId || !tenantId.trim()) {
    throw new Error(
      "buildClientOnboardingRow: tenantId is required — resolve it from " +
        `CLIENT_ONBOARDING_TENANT_SLUG ("${CLIENT_ONBOARDING_TENANT_SLUG}") first.`,
    );
  }
  return {
    tenant_id: tenantId,
    slug: CLIENT_ONBOARDING_SLUG,
    name: CLIENT_ONBOARDING_NAME,
    description: CLIENT_ONBOARDING_DESCRIPTION,
    branding: CLIENT_ONBOARDING_BRANDING,
    steps: CLIENT_ONBOARDING_STEPS,
    on_complete_stage: CLIENT_ONBOARDING_ON_COMPLETE_STAGE,
    step_outcomes: {} as Record<string, string>,
    enabled: true,
    redirect_url: null as string | null,
    created_by: null as string | null,
  };
}
