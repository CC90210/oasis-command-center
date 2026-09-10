/**
 * GET /api/forms/address-autocomplete?q=<query>
 *
 * Server-side address-autocomplete proxy for the PUBLIC merchant form (the
 * full-application "address" fields). The personalized form isn't session-
 * authed, so this route is public — but it's IP-rate-limited and returns only
 * formatted-address strings; provider API keys never reach the client.
 *
 * Provider ladder (first configured wins; all called server-side):
 *   1. GOOGLE_PLACES_API_KEY → Google Places Autocomplete — best UX, needs a
 *      billing-enabled Google Maps Platform key. CORS-blocked client-side, so
 *      the proxy is mandatory.
 *   2. MAPBOX_TOKEN          → Mapbox geocoding (autocomplete).
 *   3. (default, keyless)    → Photon / komoot (OpenStreetMap). Works with ZERO
 *      config so the feature is live out of the box.
 *
 * US-ONLY (CC 2026-06-22): every provider is restricted to United States
 * addresses — Google `components=country:us`, Mapbox `country=us`, Photon
 * filtered to properties.countrycode==="US" + a US-center ranking bias. The
 * dropdown must never offer a China / Canada / other-country address.
 *
 * To turn on the premium Google UX, set GOOGLE_PLACES_API_KEY in the dashboard
 * env; no code change needed.
 *
 * Degrades gracefully: any upstream error/timeout returns { ok:true,
 * suggestions:[] } so the field silently falls back to a plain text input the
 * merchant can fill manually.
 */

import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import {
  googleAutocompleteSuggestions,
  photonFeaturesToSuggestions,
  type AddressSuggestion,
  type PhotonProperties,
} from "@/lib/forms/address-suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_Q = 3;
const MAX_Q = 200;
const LIMIT = 8;
const UPSTREAM_TIMEOUT_MS = 4000;

async function googlePlaces(q: string, key: string, signal: AbortSignal): Promise<AddressSuggestion[]> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", q);
  url.searchParams.set("types", "address");
  url.searchParams.set("components", "country:us"); // US-only (CC 2026-06-22)
  url.searchParams.set("key", key);
  const r = await fetch(url, { signal });
  const d = (await r.json()) as {
    predictions?: Array<{ description?: string; place_id?: string }>;
    status?: string;
    error_message?: string;
  };
  // Google soft-fails with HTTP 200 + a status (REQUEST_DENIED / OVER_QUERY_LIMIT
  // / INVALID_REQUEST). Surface it server-side so a dead/unbilled key is
  // diagnosable instead of degrading to a silently-empty dropdown forever.
  if (d.status && d.status !== "OK" && d.status !== "ZERO_RESULTS") {
    throw new Error(`google_${d.status.toLowerCase()}`);
  }
  return googleAutocompleteSuggestions(d, LIMIT);
}

async function googlePlaceDetails(placeId: string, key: string, signal: AbortSignal): Promise<string> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "formatted_address");
  url.searchParams.set("key", key);
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`google_details_http_${r.status}`);
  const d = (await r.json()) as { result?: { formatted_address?: string }; status?: string };
  if (d.status !== "OK") throw new Error(`google_details_${(d.status || "unknown").toLowerCase()}`);
  return (d.result?.formatted_address || "").trim();
}

async function mapbox(q: string, token: string, signal: AbortSignal): Promise<AddressSuggestion[]> {
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`,
  );
  url.searchParams.set("access_token", token);
  url.searchParams.set("autocomplete", "true");
  url.searchParams.set("types", "address");
  url.searchParams.set("country", "us"); // US-only (CC 2026-06-22)
  url.searchParams.set("limit", String(LIMIT));
  const r = await fetch(url, { signal });
  if (!r.ok) console.warn("[address-autocomplete] mapbox http", r.status);
  const d = (await r.json()) as { features?: Array<{ place_name?: string }> };
  return (d.features || []).map((f) => (f.place_name || "").trim()).filter(Boolean)
    .slice(0, LIMIT).map((value) => ({ label: value, value }));
}

/**
 * OSM/Photon is a STREET-level geocoder, not an address-level one, and that
 * difference is what broke the merchant form. Measured live on production
 * 2026-09-10 (sunbizfunding.com, 56 suggestions across 12 real queries):
 *
 *   - 26 of 56 suggestions DROPPED the house number the merchant had typed.
 *     "123 Biscayne Blvd Miami" returned eight suggestions and not one of them
 *     was 123 Biscayne Blvd. A merchant who picked one sent a lender an address
 *     they do not occupy — silent corruption, worse than a refusal.
 *   - Non-addresses were offered as addresses: "Sloat Blvd bikeway",
 *     "The Green (First State Heritage Park)".
 *   - COUNTIES were printed as cities: "Snow View Drive, Summit, Utah" (Summit
 *     is a county), likewise "Kent, Michigan" and "Riverside, California".
 *   - Some entries carry no postcode at all, so selecting one from OUR dropdown
 *     failed OUR capture gate with "Include the ZIP code" and then offered the
 *     same entry again on the next keystroke. A closed loop with no exit.
 *
 * So Photon is now filtered down to entries usable as a mailing address: a real
 * housenumber + street, a 5-digit postcode, and a genuine city. Fewer
 * suggestions is the correct trade — an empty dropdown leaves the field a plain
 * text input the merchant can complete, which is strictly better than a
 * confident wrong answer. Photon stays as the keyless last resort so the field
 * survives a Google outage; it is not meant to be the primary provider, and
 * `provider` in the response exists so we can SEE when it has become one.
 */
async function photon(q: string, signal: AbortSignal): Promise<AddressSuggestion[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  // Over-request: the filters below are aggressive, so ask for well over LIMIT
  // to still fill the dropdown with the entries that survive them.
  url.searchParams.set("limit", String(LIMIT * 6));
  url.searchParams.set("lang", "en");
  // US-ONLY (CC 2026-06-22): Photon is global and was surfacing China/Canada
  // addresses. Bias ranking toward the geographic center of the US so US
  // results come back first, then hard-filter to countrycode US below. (A bbox
  // filter would exclude Alaska/Hawaii; the countrycode filter keeps all 50
  // states + DC.)
  url.searchParams.set("lat", "39.8283");
  url.searchParams.set("lon", "-98.5795");
  const r = await fetch(url, { signal });
  const d = (await r.json()) as { features?: Array<{ properties?: PhotonProperties }> };
  // The filter itself lives in lib/forms/address-suggestions.ts so the test
  // suite pins the real implementation instead of a copy of it. `q` is passed
  // so the filter can refuse a well-formed answer to a DIFFERENT question.
  return photonFeaturesToSuggestions(d.features, LIMIT, q);
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  const placeId = (req.nextUrl.searchParams.get("place_id") || "").trim();
  if ((!placeId && (q.length < MIN_Q || q.length > MAX_Q)) ||
      (placeId && !/^[A-Za-z0-9_-]{10,300}$/.test(placeId))) {
    return NextResponse.json({ ok: false, error: "invalid_query" }, { status: 400 });
  }

  // IP-scoped token bucket: capacity 30, +0.5/sec (~30/min sustained). A
  // debounced client makes only a handful of calls per address fill; this caps
  // a bot from draining the upstream provider's quota. Per-instance accuracy
  // (see lib/rate-limit.ts) is sufficient for this abuse surface.
  const ip = getClientIp(req);
  const decision = rateLimit({
    key: `address-autocomplete:${ip}`,
    capacity: 30,
    refillPerSec: 0.5,
  });
  if (!decision.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  // Global, identity-independent ceiling. getClientIp reads the FIRST
  // X-Forwarded-For entry, which is client-spoofable — so the per-IP bucket
  // above can be sidestepped by rotating XFF. This fixed-key bucket hard-caps
  // TOTAL upstream calls per warm instance regardless of IP, protecting a
  // billed Google/Mapbox quota from drain. (review 2026-06-17 [medium].)
  const globalDecision = rateLimit({
    key: "address-autocomplete:global",
    capacity: 240,
    refillPerSec: 4,
  });
  if (!globalDecision.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  const mapboxToken = process.env.MAPBOX_TOKEN;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    if (placeId) {
      if (!googleKey) return NextResponse.json({ ok: false, error: "provider_unavailable" }, { status: 503 });
      const address = await googlePlaceDetails(placeId, googleKey, ac.signal);
      if (!address) throw new Error("google_details_empty");
      return NextResponse.json({ ok: true, address });
    }

    let suggestions: AddressSuggestion[] = [];
    // WHICH provider actually answered. Returned to the caller (a bare name —
    // never a key, a quota or an error body) because the ladder below is a
    // redundancy that HIDES failure: with no Google key configured every
    // request still returned ok:true and a full dropdown, so the feature looked
    // healthy from the outside while merchants were being served street-level
    // OSM guesses. That is precisely what happened, undetected, from launch
    // until 2026-09-10 — GOOGLE_PLACES_API_KEY had never been set on the Vercel
    // project at all. `scripts/address_autocomplete_canary.mjs` now asserts
    // this field reads "google" against production. Verify CONTRIBUTION, not
    // presence. (See memory: redundancy-hides-failure.)
    let provider: "google" | "mapbox" | "photon" | "none" = "none";
    // A provider can fail with HTTP 200 (bad key/quota) or return no useful
    // results. Continue down the ladder so one stale deployment secret cannot
    // disable the merchant's address control.
    if (googleKey) {
      try {
        suggestions = await googlePlaces(q, googleKey, ac.signal);
        if (suggestions.length) provider = "google";
      } catch (err) { console.warn("[address-autocomplete] google unavailable", err instanceof Error ? err.message : err); }
    }
    if (!suggestions.length && mapboxToken) {
      try {
        suggestions = await mapbox(q, mapboxToken, ac.signal);
        if (suggestions.length) provider = "mapbox";
      } catch (err) { console.warn("[address-autocomplete] mapbox unavailable", err instanceof Error ? err.message : err); }
    }
    if (!suggestions.length) {
      suggestions = await photon(q, ac.signal);
      if (suggestions.length) provider = "photon";
      // A configured Google key that never answers is a production incident,
      // not a fallback working as intended. Say so at error level so it lands
      // in the log stream that is actually watched.
      if (googleKey) {
        console.error("[address-autocomplete] GOOGLE KEY CONFIGURED BUT PHOTON SERVED THE MERCHANT", { q_len: q.length });
      }
    }
    return NextResponse.json(
      { ok: true, provider, suggestions },
      { headers: { "cache-control": "public, max-age=60, s-maxage=60" } },
    );
  } catch (err) {
    // Upstream failed/timed out — return empty so the field degrades to a plain
    // text input. Never surface provider errors to the public client, but LOG
    // server-side so a misconfigured key / quota breach is diagnosable instead
    // of flying blind (house pattern: lib/api-helpers.ts safe()).
    console.error(
      "[address-autocomplete] upstream failed",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ ok: true, suggestions: [] });
  } finally {
    clearTimeout(timer);
  }
}
