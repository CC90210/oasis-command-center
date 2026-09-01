/**
 * P0 web-vitals ingest (instant-load plan, 2026-09-01).
 *
 * Receives the PerfVitals beacon and emits one `[perf.vitals]` log line
 * per metric. Log-only by design: no database write, no PII, nothing to
 * migrate — the baseline lives in host logs next to the `[perf]` layout
 * lines.
 *
 * Untrusted input rules (this is a public POST surface):
 *   - same-origin gate FIRST, fail-closed: no parseable Origin/Referer
 *     matching the request host → 403 before the body is read.
 *   - hard body-size cap, strict schema, charset-allowlisted strings,
 *     unknown keys rejected. Nothing from the payload is echoed into
 *     the response.
 *   - per-instance rate cap so a misbehaving client cannot flood logs.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_000;
const RATE_CAP_PER_MIN = 600;

const METRIC_NAMES = new Set([
  "TTFB",
  "FCP",
  "LCP",
  "INP",
  "CLS",
  "FID",
  "Next.js-hydration",
  "Next.js-route-change-to-render",
  "Next.js-render",
]);
const RATINGS = new Set(["good", "needs-improvement", "poor"]);
const PATH_RE = /^[A-Za-z0-9/_\-.[\]]{1,100}$/;
const ALLOWED_KEYS = new Set(["name", "value", "rating", "path"]);

let windowStart = 0;
let windowCount = 0;

function overRateCap(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount > RATE_CAP_PER_MIN;
}

function sameOrigin(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  for (const header of ["origin", "referer"]) {
    const value = req.headers.get(header);
    if (!value) continue;
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  if (overRateCap()) {
    // Deliberately 204: a flooding client learns nothing and logs stay clean.
    return new NextResponse(null, { status: 204 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) return NextResponse.json({ ok: false }, { status: 400 });
  }

  const name = body.name;
  const value = body.value;
  const rating = body.rating ?? null;
  const path = body.path;
  if (typeof name !== "string" || !METRIC_NAMES.has(name))
    return NextResponse.json({ ok: false }, { status: 400 });
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 600_000)
    return NextResponse.json({ ok: false }, { status: 400 });
  if (rating !== null && (typeof rating !== "string" || !RATINGS.has(rating)))
    return NextResponse.json({ ok: false }, { status: 400 });
  if (typeof path !== "string" || !PATH_RE.test(path))
    return NextResponse.json({ ok: false }, { status: 400 });

  try {
    console.log(
      `[perf.vitals] ${JSON.stringify({ name, value: Math.round(value * 1000) / 1000, rating, path })}`,
    );
  } catch {
    // fail-open: losing one metric line is fine, failing the beacon is not
  }
  return new NextResponse(null, { status: 204 });
}
