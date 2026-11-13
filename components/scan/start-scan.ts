"use client";

import { trackEvent, type TrackInput } from "@/lib/offers/tracking-client";
import { AUDIT_FUNNEL } from "@/lib/marketing/routes";
import { SCAN_OFFER_SLUG } from "@/lib/site-scan/offer";

/**
 * Starting a free scan, from anywhere a visitor can (the /scan page, the landing hero). One path:
 * POST /api/scan, the claim key kept for this tab, the offer's `scan_started` count, and the
 * address the visitor goes on to with their campaign tags intact (utm_* reach the claim, which
 * files the lead under the scan's offer).
 */

const CLAIM_KEY_STORE = "oasis-scan-claim:";

export const SCAN_INPUT_ERRORS: Record<string, string> = {
  website_required: "Paste your website address first.",
  not_a_website: "That does not look like a public website address. Try the form www.yourbusiness.com.",
  social_profile: "That is a social profile, not a website. Paste the business's own site, or tell us you don't have one.",
  rate_limited: "That is a lot of scans from one place. Give it an hour, or book a call and we will run them with you.",
  not_installed: "The scanner is being set up on this deployment. Try again shortly.",
  forbidden: "Open this page on oasisai.work and try again.",
};

/** The claim key POST /api/scan gave this browser, kept for the tab so a reload can still save the report. */
export function storedClaimKey(scanId: string): string | null {
  try {
    return window.sessionStorage.getItem(CLAIM_KEY_STORE + scanId);
  } catch {
    return null;
  }
}

function storeClaimKey(scanId: string, key: string): void {
  try {
    window.sessionStorage.setItem(CLAIM_KEY_STORE + scanId, key);
  } catch {
    // Private mode or storage off: the caller still holds the key in memory for this page.
  }
}

/** One count on the free scan's offer card (offer_funnel_events under its form). */
export function trackScan(event: Extract<TrackInput["event"], "page_view" | "scan_started" | "scan_finished">): void {
  trackEvent({ tenant: AUDIT_FUNNEL.tenantSlug, form: SCAN_OFFER_SLUG, event });
}

/** A scan's address, keeping the page's own query (its campaign tags) for the claim to read. */
export function scanPath(scanId: string, search: string = typeof window !== "undefined" ? window.location.search : ""): string {
  return `/scan/${scanId}${search && search.startsWith("?") ? search : ""}`;
}

export type StartScan = { ok: true; scanId: string; claimKey: string | null } | { ok: false; error: string; trapped?: boolean };

export async function startScan(website: string, honeypot: string): Promise<StartScan> {
  let res: Response;
  try {
    res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ website, honeypot }) });
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; scan_id?: string; claim_key?: string | null; trapped?: boolean; error?: string } | null;
  if (data?.trapped) return { ok: false, error: "Thanks. We will take it from here.", trapped: true };
  if (!res.ok || !data?.ok || !data.scan_id) return { ok: false, error: SCAN_INPUT_ERRORS[data?.error ?? ""] ?? "That didn't go through. Try again in a moment." };
  if (data.claim_key) storeClaimKey(data.scan_id, data.claim_key);
  trackScan("scan_started");
  return { ok: true, scanId: data.scan_id, claimKey: data.claim_key ?? null };
}
