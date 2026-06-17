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
 *      config so the feature is live out of the box — US + Canada + global.
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_Q = 3;
const MAX_Q = 200;
const LIMIT = 8;
const UPSTREAM_TIMEOUT_MS = 4000;

async function googlePlaces(q: string, key: string, signal: AbortSignal): Promise<string[]> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", q);
  url.searchParams.set("types", "address");
  url.searchParams.set("key", key);
  const r = await fetch(url, { signal });
  const d = (await r.json()) as {
    predictions?: Array<{ description?: string }>;
    status?: string;
    error_message?: string;
  };
  // Google soft-fails with HTTP 200 + a status (REQUEST_DENIED / OVER_QUERY_LIMIT
  // / INVALID_REQUEST). Surface it server-side so a dead/unbilled key is
  // diagnosable instead of degrading to a silently-empty dropdown forever.
  if (d.status && d.status !== "OK" && d.status !== "ZERO_RESULTS") {
    console.warn("[address-autocomplete] google status", d.status, d.error_message || "");
  }
  return (d.predictions || []).map((p) => (p.description || "").trim()).filter(Boolean).slice(0, LIMIT);
}

async function mapbox(q: string, token: string, signal: AbortSignal): Promise<string[]> {
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`,
  );
  url.searchParams.set("access_token", token);
  url.searchParams.set("autocomplete", "true");
  url.searchParams.set("types", "address");
  url.searchParams.set("limit", String(LIMIT));
  const r = await fetch(url, { signal });
  if (!r.ok) console.warn("[address-autocomplete] mapbox http", r.status);
  const d = (await r.json()) as { features?: Array<{ place_name?: string }> };
  return (d.features || []).map((f) => (f.place_name || "").trim()).filter(Boolean).slice(0, LIMIT);
}

async function photon(q: string, signal: AbortSignal): Promise<string[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("lang", "en");
  const r = await fetch(url, { signal });
  const d = (await r.json()) as {
    features?: Array<{ properties?: Record<string, string> }>;
  };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of d.features || []) {
    const p = f.properties || {};
    // Don't let a street-less house number ("12") leak as the address line —
    // only join housenumber when there's a street; else fall back to the name.
    const line1 = p.street ? [p.housenumber, p.street].filter(Boolean).join(" ") : p.name || "";
    const label = [line1, p.city || p.county, p.state, p.postcode, p.country]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(", ");
    // Dedupe case/whitespace-insensitively so the same physical address can't
    // appear twice from slightly different OSM features.
    const key = label.toLowerCase().replace(/\s+/g, " ");
    if (label && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  return out.slice(0, LIMIT);
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < MIN_Q || q.length > MAX_Q) {
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
    let suggestions: string[] = [];
    if (googleKey) {
      suggestions = await googlePlaces(q, googleKey, ac.signal);
    } else if (mapboxToken) {
      suggestions = await mapbox(q, mapboxToken, ac.signal);
    } else {
      suggestions = await photon(q, ac.signal);
    }
    return NextResponse.json(
      { ok: true, suggestions },
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
