/**
 * lib/web-leads/presence-evidence.ts — the measured sentence behind every
 * presence check, same contract as check-evidence.ts: verbalize what was
 * measured and name the bar; NEVER judge, NEVER invent. Pass/fail comes from
 * the stored blob; a check whose pillar was unmeasured gets null and the
 * card says "not measured yet" in one honest place instead of thirteen.
 *
 * The numbers quoted come from the blob's cached Google answer (`gbp`), so
 * the sentence and the check can never disagree about one business mid-call.
 * Hand-written, verbatim, no generation — battle-card rule 3 applies to
 * presence exactly as it applies to the website.
 */

import type { PresenceBlob } from "./presence";

type Gbp = {
  found?: boolean;
  rating?: number | null;
  userRatingCount?: number;
  businessStatus?: string | null;
  hasPhotos?: boolean;
  hasHours?: boolean;
  phone?: string | null;
  formattedAddress?: string | null;
};

const LINES: Record<string, (b: PresenceBlob) => string | null> = {
  // ── Google Business Profile ─────────────────────────────────────────
  gbp_found: (b) => {
    const g = (b.gbp || {}) as Gbp;
    return g.found
      ? "A Google Business Profile was found for this business."
      : "No Google Business Profile was found when we searched for this business by name and location.";
  },
  gbp_operational: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "Cannot be listed as operational without a profile.";
    return g.businessStatus === "OPERATIONAL"
      ? "Google lists the business as currently operational."
      : `Google's status for this listing reads ${g.businessStatus || "unknown"} rather than operational.`;
  },
  gbp_rated: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "No profile, so no star rating anywhere on Google.";
    return typeof g.rating === "number" && g.rating > 0
      ? `Rated ${g.rating.toFixed(1)} stars on Google.`
      : "The profile exists but carries no star rating yet.";
  },
  gbp_reviews_10: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "No profile, so no Google reviews at all.";
    const n = g.userRatingCount ?? 0;
    return `${n} Google ${n === 1 ? "review" : "reviews"}; ten or more earns the point.`;
  },
  gbp_photos: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "No profile, so no photos on Google.";
    return g.hasPhotos ? "The profile carries photos." : "The profile has no photos at all.";
  },
  gbp_hours: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "No profile, so no opening hours on Google.";
    return g.hasHours
      ? "Opening hours are filled in on the profile."
      : "The profile shows no opening hours, so Google cannot say whether they are open right now.";
  },

  // ── one identity everywhere ─────────────────────────────────────────
  nap_phone_match: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "With no Google profile there is nothing to compare the directory's phone number against.";
    if (!g.phone) return "Google's listing shows no phone number to compare against the directory's.";
    return "Compared the phone number on Google with the one in the business directory.";
  },
  nap_locality: (b) => {
    const g = (b.gbp || {}) as Gbp;
    if (!g.found) return "With no Google profile there is nothing to compare the directory's city against.";
    return "Compared the city on Google's listing with the one in the business directory.";
  },
  nap_both_listed: (b) => {
    const g = (b.gbp || {}) as Gbp;
    return g.found && g.formattedAddress
      ? "A street address is recorded on both Google and the business directory."
      : "A street address is missing from at least one of Google and the business directory.";
  },

  // ── email that lands ────────────────────────────────────────────────
  mail_mx: () => "Checked the public mail records on the website's own domain.",
  mail_spf: () =>
    "Checked for the public record (called SPF) that tells other mail systems who may send email for this domain; without it, their email is easier to fake and more likely to land in spam.",
  mail_dmarc: () =>
    "Checked for the public record (called DMARC) that tells other mail systems what to do with fakes; without it, there is no instruction and less protection.",

  // ── social links that work ──────────────────────────────────────────
  social_resolve: () => "Each social link found on the website was checked to see whether it still works.",
};

export const PRESENCE_EXPLAINED_CODES = Object.keys(LINES);

/**
 * The sentence for one presence check, or null when its pillar was not
 * measured (the caller renders one honest "not measured yet" line for the
 * pillar instead).
 */
export function presenceLine(code: string, blob: PresenceBlob): string | null {
  const pillar = blob.pillars.find((p) => p.checks.some((c) => c.code === code));
  const check = pillar?.checks.find((c) => c.code === code);
  if (!pillar || !check || check.has === null || pillar.score === null) return null;
  const fn = LINES[code];
  return fn ? fn(blob) : null;
}
