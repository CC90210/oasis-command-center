/**
 * quick-email-draft.ts — what the rep's one-click email actually says.
 *
 * Pure functions, no React, no network: the wording a prospect receives is the
 * part of this feature that can do real damage, so it lives where a test can
 * reach it directly rather than inside a "use client" component that a node
 * test cannot import.
 *
 * THE ONE RULE THIS FILE ENFORCES. The lead board stores honest INTERNAL
 * sentences for things nobody has checked — "Not audited yet - confirm on the
 * call", "No website found yet, needs checking", "Has a site, not yet reviewed".
 * They are correct on a rep's screen and indefensible in a message to the
 * business owner: at best they are nonsense, at worst they read as a finding
 * somebody made about that company's website. Every one of them is stripped, and
 * when nothing real survives the paragraph is DROPPED rather than replaced with
 * something confident-sounding. Same rule the lead card renders under.
 */

/**
 * Internal placeholders that must never reach a prospect. Compared on a trimmed,
 * lower-cased prefix so a seeder writing different capitalisation or appending a
 * clause ("Not audited yet - confirm on the call") is still caught.
 */
export const INTERNAL_PLACEHOLDERS = [
  "not audited yet",
  "not checked",
  "no website finding on file",
  "no website found yet",
  "has a site, not yet reviewed",
  "site not audited",
  "confirm on the call",
  "needs checking",
] as const;

function isInternalPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  return INTERNAL_PLACEHOLDERS.some((p) => v.startsWith(p) || v === p);
}

/** Keep only prospect-safe prose. Returns "" when nothing real survives. */
export function prospectSafe(value: string): string {
  const v = (value || "").trim();
  if (!v || isInternalPlaceholder(v)) return "";
  return v;
}

/**
 * The greeting name.
 *
 * A contact field holding the COMPANY name is the overwhelmingly common shape on
 * scraped rows — the HVAC lead in the pipeline has contact name == business name
 * — and "Hi HVAC Mechanical Systems Inc," is worse than a neutral greeting.
 */
export function firstNameOf(contactName: string, company: string): string {
  const name = (contactName || "").trim();
  const letters = (s: string) => s.replace(/[^a-z]/gi, "").toLowerCase();
  if (!name || (company && letters(name) === letters(company))) return "there";
  const first = name.split(/\s+/)[0];
  return first && first.length > 1 ? first : "there";
}

export type QuickEmailLead = {
  name: string;
  company: string;
  email: string;
  industry: string;
  business_city: string;
  website: string;
  website_condition: string;
  audit_findings: string;
  notes: string;
};

export type TemplateId = "thanks_for_call" | "info_request" | "follow_up";

export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: "thanks_for_call", label: "Thanks for the call", hint: "Right after a connected call." },
  { id: "info_request", label: "They asked for info", hint: '"Just send me an email."' },
  { id: "follow_up", label: "Follow up", hint: "No answer yet, nudge them." },
];

export function buildDraft(
  template: TemplateId,
  lead: QuickEmailLead,
  bookingUrl: string,
): { subject: string; body: string } {
  const first = firstNameOf(lead.name, lead.company);
  const company = (lead.company || "").trim();
  const findings = prospectSafe(lead.audit_findings);
  const condition = prospectSafe(lead.website_condition);
  const notes = prospectSafe(lead.notes);
  const industry = (lead.industry || "").trim().toLowerCase();
  const city = (lead.business_city || "").trim();

  // Assembled only from things somebody actually recorded. Findings beat the
  // one-line condition; if both are placeholders there is no paragraph at all.
  const observed = findings || condition;

  // Always name what the time is FOR. "Pick a time" with no subject reads
  // like a trap, and a 15-minute bound is the promise that gets it accepted.
  const booking = bookingUrl
    ? `If it's easier than phone tag, you can grab a 15-minute slot here and pick whatever time suits you:\n${bookingUrl}`
    : "";

  const what =
    `We build and look after websites for ${industry ? `${industry} businesses` : "local businesses"}` +
    `${city ? ` around ${city}` : ""} — the site itself, the Google listing, and the follow-up ` +
    "that turns an enquiry into a booked job.";

  const parts: string[] = [`Hi ${first},`];

  if (template === "thanks_for_call") {
    parts.push("Thanks for taking my call just now — here's the short version in writing, as promised.");
    if (observed) parts.push(`What I noticed about your website:\n${observed}`);
    if (notes) parts.push(notes);
    parts.push(what);
    if (booking) parts.push(booking);
    parts.push("If now isn't the right time, just say so and I'll leave you be.");
    return {
      subject: company ? `${company} — what we talked about` : "What we talked about",
      body: parts.join("\n\n"),
    };
  }

  if (template === "info_request") {
    parts.push("You asked me to put this in an email, so here it is — short as I can make it.");
    if (observed) parts.push(`What I noticed about your website:\n${observed}`);
    parts.push(`${what} No long contract.`);
    if (notes) parts.push(notes);
    if (booking) parts.push(booking);
    parts.push("Or just reply here with any questions — happy to answer by email.");
    return {
      subject: company ? `${company} — the details you asked for` : "The details you asked for",
      body: parts.join("\n\n"),
    };
  }

  parts.push("Following up on my last note — I know how quickly this stuff gets buried.");
  if (observed) parts.push(`The thing I flagged about your website:\n${observed}`);
  if (notes) parts.push(notes);
  if (booking) parts.push(booking);
  parts.push("If it's not a priority right now, tell me and I'll stop chasing.");
  return {
    subject: company ? `Following up — ${company}` : "Following up",
    body: parts.join("\n\n"),
  };
}

/**
 * Default next touch: three business days out, 9am local.
 *
 * Returned in the `datetime-local` shape the input expects (local wall clock,
 * no zone suffix) — converting to ISO here would render as a UTC time the rep
 * did not choose.
 */
export function defaultNextTouch(from: Date = new Date()): string {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < 3) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  d.setHours(9, 0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
