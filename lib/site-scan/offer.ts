/**
 * lib/site-scan/offer.ts — the free scan as one of OASIS's offers (CC, 2026-11-13: "list this as an
 * offer first so we can track its use").
 *
 * The scan's page is the marketing page /scan, not an offer-page document. Its offer is a form,
 * `free-scan` (lib/forms/oasis-free-scan-seed.ts), which carries two things only:
 *   - the claim: "Send it to the OASIS team" submits this form's one step, so a scan's lead is
 *     filed under the scan, never as an AI Automation Audit submission;
 *   - its usage: page_view / scan_started / scan_finished go into offer_funnel_events under this
 *     form, so the Offers card counts the scan like every other offer.
 * Browser-safe: no server import, so the scan's client components read the same names.
 */
export const SCAN_OFFER_SLUG = "free-scan";
/** Where the offer's visitors go: the scan itself. */
export const SCAN_OFFER_PATH = "/scan";
export const SCAN_OFFER_NAME = "Free AI website scan";
export const SCAN_OFFER_HEADLINE = "Paste your website. Watch an AI read it, score it and find who buys from you.";
export const SCAN_OFFER_SUBHEADLINE = "The free front door to the AI audit: a report in about a minute, sent to the team with one form.";
/** The operator page with the scan's details (every scan, its replay and its lead). */
export const SCAN_DETAILS_PATH = "/forms/scans";
