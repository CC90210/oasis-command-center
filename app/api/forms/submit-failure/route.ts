/**
 * POST /api/forms/submit-failure — the browser's report that a public form
 * submission failed in a way the server may never have seen.
 *
 * WHY THIS EXISTS. The server-catch dead-letter (submit-failure-capture.ts)
 * covers crashes INSIDE our handler. It cannot see the failures that end at
 * the platform edge: a Vercel 413 on an oversized body, a platform error page,
 * a network death mid-request. To the merchant those are identical to the or()
 * crash that ate nine days of applications — so the form client fires this
 * beacon on any submit failure, carrying the contact fields (never file bytes),
 * making even a platform-level loss alerted AND recoverable.
 *
 * PUBLIC ENDPOINT HYGIENE. This is unauthenticated telemetry with exactly one
 * side effect (a dead-letter insert + a decayed page), so it is defensively
 * boring: IP rate-limited, body hard-capped, slugs allowlisted, payload
 * stripped and capped inside captureSubmitFailure. Always answers 200-shaped
 * JSON — a failed beacon must never create a second error in the merchant's
 * console to worry about.
 */

import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { captureSubmitFailure } from "@/lib/forms/submit-failure-capture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A failure report is contact fields + an error string. 64KB is generous;
 *  anything bigger is not a failure report. */
const BODY_CAP_BYTES = 64_000;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req) || "unknown";
    // Burst of 5, ~1/min sustained per IP: a merchant retrying a broken form
    // fits; a flood does not.
    const rl = rateLimit({ key: `submit-failure:${ip}`, capacity: 5, refillPerSec: 1 / 60 });
    if (!rl.allowed) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }

    const raw = await req.text();
    if (raw.length > BODY_CAP_BYTES) {
      return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }

    await captureSubmitFailure({
      source: "client_beacon",
      tenantSlug: typeof body.tenant_slug === "string" ? body.tenant_slug : null,
      formSlug: typeof body.form_slug === "string" ? body.form_slug : null,
      stepIndex: typeof body.step_index === "number" ? body.step_index : null,
      error: typeof body.error === "string" ? body.error.slice(0, 500) : "client reported failure",
      payload: body.payload,
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch {
    // Telemetry must not produce its own error cascade.
    return NextResponse.json({ ok: true });
  }
}
