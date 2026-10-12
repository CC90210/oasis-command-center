"use client";

/**
 * lib/offers/tracking-client.ts - the ONE place a browser fires a funnel
 * event (V5a, HANDOVER section 5). Every component that tracks something
 * (OfferPage's mount, FormPublicClient's step changes, VideoFacade's play
 * button, the community/checkout links) calls `trackEvent` here; nothing
 * else constructs the request body or touches sessionStorage.
 *
 * PRIVACY (Quebec Law 25), enforced structurally, not by convention:
 *   - the visit id lives in sessionStorage, NEVER a cookie, NEVER sent as
 *     part of any value this module reads from the DOM (no IP, no
 *     fingerprint, no navigator.userAgent);
 *   - sessionStorage is tab-scoped and gone when the tab closes -- there is
 *     no persistent cross-session identifier here at all;
 *   - when sessionStorage is unavailable (SSR, a locked-down browser, private
 *     mode in some engines), getOrCreateVisitId returns null and trackEvent
 *     is a deliberate, silent no-op. No fallback identifier is ever
 *     substituted -- a fallback that still ties an event to *something*
 *     would defeat the whole point.
 *
 * Fire-and-forget: trackEvent never throws, never returns a promise the
 * caller must await, and never blocks navigation. navigator.sendBeacon is the
 * primary transport (survives the page unloading, e.g. right after a
 * checkout/community click navigates away); a fetch with keepalive is the
 * fallback where sendBeacon is unavailable (old Safari, non-browser test
 * environments).
 */
import { FUNNEL_EVENT_NAMES, type FunnelEventName } from "./tracking-store";

const VISIT_ID_KEY = "oasis_visit_id";
const ENDPOINT = "/api/offer-events";

/** A fresh, unguessable id with no server round trip -- crypto.randomUUID(). */
function freshId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Only reachable in an environment with neither sessionStorage's crypto nor
  // the Web Crypto API (effectively never in a real browser). Still never a
  // cookie, still never persisted beyond this one call.
  return `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The per-visit id, created once per browser tab session and read back for
 * every later call. null when sessionStorage cannot be used at all -- the
 * caller must treat that as "do not track this event", not "use a temporary
 * id instead".
 */
export function getOrCreateVisitId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.sessionStorage.getItem(VISIT_ID_KEY);
    if (existing) return existing;
    const id = freshId();
    window.sessionStorage.setItem(VISIT_ID_KEY, id);
    return id;
  } catch {
    // Storage disabled/unavailable (private-mode quirks, locked-down policy).
    // No cookie fallback, no in-memory fallback that would smuggle an id into
    // a later unrelated call: tracking for this page view is simply skipped.
    return null;
  }
}

export type TrackInput = {
  /** The tenant's public slug, exactly as the offer page / form URL carries it. */
  tenant: string;
  /** The form's public slug. */
  form: string;
  event: FunnelEventName;
  stepIndex?: number;
  detail?: Record<string, unknown>;
};

function send(body: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Never let a tracking failure reach the caller.
  }
}

/**
 * Fire one funnel event. Silently does nothing when there is no visit id
 * (see getOrCreateVisitId) or the event name is not one of the ones this
 * build ships (a typo at a call site should never reach the network).
 */
export function trackEvent(input: TrackInput): void {
  try {
    if (!(FUNNEL_EVENT_NAMES as readonly string[]).includes(input.event)) return;
    const visitId = getOrCreateVisitId();
    if (!visitId) return;
    const body = JSON.stringify({
      tenant: input.tenant,
      form: input.form,
      visit_id: visitId,
      event: input.event,
      ...(typeof input.stepIndex === "number" ? { step_index: input.stepIndex } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    });
    send(body);
  } catch {
    // trackEvent must never throw into the component that called it.
  }
}

/** Read-only export for callers that need the current visit id without creating one (e.g. a link href). */
export function peekVisitId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(VISIT_ID_KEY);
  } catch {
    return null;
  }
}
