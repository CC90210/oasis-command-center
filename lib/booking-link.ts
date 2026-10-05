/**
 * booking-link.ts — the one place the "pick a time" link is resolved.
 *
 * WHAT WENT WRONG (CC, 2026-09-09). Two modules each carried the same
 * hardcoded default:
 *
 *     "https://calendar.app.google/tpfvJYBGircnGu8G8"
 *
 * That appointment schedule no longer exists. Rendering it gives
 * "Appointment not found — the appointment may have been deleted or the link
 * may be incorrect". It was shipping in three places at once: the quick email
 * a rep sends, the automatic booking email a lead gets on reaching `qualified`,
 * and the "Book a call" CTA on the public marketing site at /contact and /work.
 * Every one of them invited a prospect to book and sent them to an error page.
 *
 * WHY A HARDCODED DEFAULT WAS THE BUG, not just the wrong string. A fallback
 * URL is a promise that some address always works, and no code can keep that
 * promise about a resource owned outside the repo — a booking page can be
 * deleted by one click in a calendar UI, and nothing here would ever know. The
 * old comment on it read "env-overridable, never absent", which is exactly the
 * guarantee that cannot be made. Absent is now representable, and every caller
 * has to decide what to do without a link. That is the honest shape:
 *
 *   - no link  -> the email asks the prospect to name two times instead
 *   - no link  -> the site offers email rather than a dead button
 *
 * An email that says "reply with a couple of times" still books meetings. One
 * that points at an error page loses the prospect AND the credibility.
 *
 * Pure and env-injectable so the resolution rules are testable without a
 * deployment.
 */

/** Checked in order; the first non-empty one wins. */
export const BOOKING_URL_ENV_KEYS = [
  "NEXT_PUBLIC_BOOKING_URL",
  "NEXT_PUBLIC_FOUNDER_BOOKING_URL",
  "OASIS_FOUNDER_BOOKING_URL",
  "BOOKING_LINK",
] as const;

/**
 * Links known to be dead, refused even when explicitly configured.
 *
 * This is deliberately a blocklist of ONE. It exists because the retired
 * schedule is still written down in git history, in old emails, and in
 * whatever note the value gets pasted from next time — the single most likely
 * value for someone to "restore" while fixing this. Refusing it by name means
 * that restore fails loudly at the source instead of quietly resuming the
 * outage. Delete an entry only when the link is verified working again.
 */
export const RETIRED_BOOKING_URLS: readonly string[] = [
  "https://calendar.app.google/tpfvjybgircngu8g8",
];

/**
 * Is this a usable booking link?
 *
 * Shape only — no network. It cannot tell a live schedule from a deleted one
 * (Google returns HTTP 200 and renders "Appointment not found" in JavaScript,
 * so even a fetch would not know). Liveness is checked by
 * scripts/verify-booking-link.mjs, which renders the page.
 */
export function isUsableBookingUrl(raw: string | null | undefined): boolean {
  const url = (raw || "").trim();
  if (!url) return false;
  if (RETIRED_BOOKING_URLS.includes(url.toLowerCase().replace(/\/+$/, ""))) return false;
  try {
    const u = new URL(url);
    // https only: this link is handed to strangers, and a booking page reached
    // over http is both a trust signal and a downgrade risk.
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * The configured booking link, or "" when there is not a usable one.
 *
 * "" is a real answer, not a failure. Callers MUST handle it — that is the
 * whole point of removing the default.
 */
export function resolveBookingUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const key of BOOKING_URL_ENV_KEYS) {
    const value = (env[key] || "").trim();
    if (!value) continue;
    if (!isUsableBookingUrl(value)) continue;
    return value;
  }
  return "";
}

/**
 * True when a value was configured but rejected — a misconfiguration worth
 * shouting about, as opposed to simply never having been set. Lets a health
 * surface tell "nobody set it" apart from "somebody set the dead one again".
 */
export function bookingUrlMisconfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = BOOKING_URL_ENV_KEYS.map((k) => (env[k] || "").trim()).filter(Boolean);
  if (configured.length === 0) return false;
  return !configured.some(isUsableBookingUrl);
}
