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

/**
 * MATCHED ANYWHERE IN THE TEXT, not just as a prefix.
 *
 * The first version of this checked `startsWith`, which is wrong for the shape
 * these strings actually take in production. A real lead on the board carries:
 *
 *   "Vaughan, Ontario | HVAC | site NOT audited (fetch failed at seed time;
 *    site confirmed reachable 2026-08-26) | no website finding on file,
 *    confirm on the call"
 *
 * Every placeholder in that sentence is mid-text, so a prefix check passes it
 * and the whole thing goes to the business owner. Codex caught this on review
 * and reproduced the leak.
 *
 * Whitespace is collapsed first so a line break or double space inside the
 * stored value cannot walk a phrase past the match.
 */
function isInternalPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return true;
  return INTERNAL_PLACEHOLDERS.some((p) => v.includes(p));
}

/**
 * Keep only prospect-safe prose. Returns "" when nothing real survives.
 *
 * A field containing a placeholder ANYWHERE is dropped WHOLE rather than having
 * the offending clause spliced out. Two reasons: these values are single mixed
 * sentences ("site NOT audited ... | no website finding on file") where the
 * surviving fragment would be unreadable, and a partial strip invites exactly
 * the confident-sounding half-sentence this guard exists to stop. Dropping too
 * much costs a shorter email that the rep can see and add to before sending;
 * leaking costs a fabricated finding in a stranger's inbox under our name.
 */
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
  return first && first.length > 1 ? titleCaseName(first) : "there";
}

/**
 * Capitalise a scraped first name for the greeting.
 *
 * Scraped rows carry whatever the source page used, and 16 of the 1,983 named
 * OASIS leads store an all-lowercase name — including the Broadway Locksmith
 * row, which went out as "Hi simon,". To an owner that reads as a mail merge
 * that did not even bother, which is the opposite of what a personal note from
 * a rep is meant to signal.
 *
 * Only the ALL-lowercase case is touched. A name the source recorded with
 * deliberate internal capitals — McCarthy, DeLuca, O'Brien, van Veen — is left
 * exactly as written, because "Mccarthy" is a visible error where "mccarthy"
 * was merely careless data. Hyphens and apostrophes each start a new part, so
 * "mary-jane" and "o'brien" come back as "Mary-Jane" and "O'Brien".
 */
export function titleCaseName(raw: string): string {
  const s = (raw || "").trim();
  if (!s || s !== s.toLowerCase()) return s;
  return s.replace(/[a-zà-ÿ]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/**
 * `website_condition` is a CLOSED VOCABULARY, so it gets an allowlist.
 *
 * WHY THIS EXISTS. prospectSafe() is a blocklist, and a blocklist fails OPEN:
 * anything it has not been taught leaks. On 2026-09-09 it did exactly that. A
 * real send to Broadway Locksmith went out reading
 *
 *     The thing I flagged about your website:
 *     Has a site, not good
 *
 * because the list knew "has a site, not yet reviewed" and had never been shown
 * "Has a site, not good". A stranger got a blunt internal verdict on his
 * business presented as our considered finding.
 *
 * Counting the field across the whole tenant settles the design: FIVE distinct
 * values exist in 1,973 rows. This is an enum wearing a text column, so the
 * safe direction is an allowlist that maps the few sayable ones into prose and
 * DROPS everything else. Unknown now fails closed — a new value added by a
 * scraper next month says nothing to a prospect until somebody writes its line.
 *
 * The two omissions are deliberate, not oversights:
 *   "Has a site, not yet reviewed" (1,893 rows) — nobody has looked. Claiming a
 *       finding here would be inventing one.
 *   "Has a site, not good"                      — a rep's private judgement.
 *       True or not, it is not a thing you open a conversation with.
 *
 * Only observations the OWNER CAN CHECK HIMSELF survive: no site, or a site
 * that will not load. Both are verifiable in ten seconds, which is what makes
 * them fair to put in writing.
 */
export const CONDITION_PROSE: Record<string, string> = {
  "no website": "From what I can see, you don't have a website yet.",
  "does not have a site": "From what I can see, you don't have a website yet.",
  "website does not load": "From what I can see, your website isn't loading at the moment.",
};

/** Prospect-safe sentence for a stored condition, or "" when there is none. */
export function conditionProse(raw: string): string {
  const key = (raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!,;]+$/, "");
  return CONDITION_PROSE[key] || "";
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
  const notes = prospectSafe(lead.notes);
  const industry = (lead.industry || "").trim().toLowerCase();
  const city = (lead.business_city || "").trim();

  /**
   * The one observation paragraph, or nothing at all.
   *
   * A real audit finding is free prose, so it keeps its label and is quoted as
   * written. A stored condition is an enum, so it arrives as a finished
   * sentence from CONDITION_PROSE and takes NO label — labelling it would
   * produce "The thing I flagged about your website: From what I can see..."
   *
   * When neither survives the paragraph is dropped. An email that says less is
   * recoverable; one that invents a finding about a stranger's business is not.
   */
  const observedBlock = (label: string): string =>
    findings ? `${label}\n${findings}` : conditionProse(lead.website_condition);

  // Always name what the time is FOR. "Pick a time" with no subject reads
  // like a trap, and a 15-minute bound is the promise that gets it accepted.
  //
  // WITH NO LINK, ASK — do not go quiet. The booking URL was previously a
  // hardcoded calendar address whose schedule had been deleted, so every one of
  // these emails invited the owner to book and delivered him to an error page
  // (CC, 2026-09-09). The link is now absent rather than wrong when nothing is
  // configured, and an absent link must not silently remove the ask: a reply
  // naming two times books just as well, and it is the sentence a person would
  // write anyway.
  const booking = bookingUrl
    ? `If it's easier than phone tag, you can grab a 15-minute slot here and pick whatever time suits you:\n${bookingUrl}`
    : "If it's easier than phone tag, reply with a couple of times that suit you this week and I'll send an invite. Fifteen minutes is plenty.";

  const what =
    `We build and look after websites for ${industry ? `${industry} businesses` : "local businesses"}` +
    `${city ? ` around ${city}` : ""}. That means the site itself, the Google listing, and the follow-up ` +
    "that turns an enquiry into a booked job.";

  const parts: string[] = [`Hi ${first},`];

  if (template === "thanks_for_call") {
    parts.push("Thanks for taking my call just now. Here's the short version in writing, as promised.");
    const observed = observedBlock("What I noticed about your website:");
    if (observed) parts.push(observed);
    if (notes) parts.push(notes);
    parts.push(what);
    if (booking) parts.push(booking);
    parts.push("If now isn't the right time, just say so and I'll leave you be.");
    return {
      subject: company ? `${company}: what we talked about` : "What we talked about",
      body: parts.join("\n\n"),
    };
  }

  if (template === "info_request") {
    parts.push("You asked me to put this in an email, so here it is, short as I can make it.");
    const observed = observedBlock("What I noticed about your website:");
    if (observed) parts.push(observed);
    parts.push(`${what} No long contract.`);
    if (notes) parts.push(notes);
    if (booking) parts.push(booking);
    parts.push("Or just reply here with any questions. Happy to answer by email.");
    return {
      subject: company ? `${company}: the details you asked for` : "The details you asked for",
      body: parts.join("\n\n"),
    };
  }

  parts.push("Following up on my last note. I know how quickly this stuff gets buried.");
  const observed = observedBlock("The thing I flagged about your website:");
  if (observed) parts.push(observed);
  if (notes) parts.push(notes);
  if (booking) parts.push(booking);
  parts.push("If it's not a priority right now, tell me and I'll stop chasing.");
  return {
    subject: company ? `Following up: ${company}` : "Following up",
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
