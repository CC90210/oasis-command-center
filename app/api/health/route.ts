import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness probe for the Docker healthcheck, external uptime monitors,
 * and the desktop wizard's "is the dashboard reachable" check.
 *
 * Intentionally public (allowlisted in middleware.ts). The payload is
 * deliberately small + non-sensitive: build info + uptime so callers
 * can detect "is the deploy fresh" without leaking anything.
 *
 * Cache-Control: no-store so monitors get the actual current state
 * instead of an edge-cached snapshot from minutes ago.
 */

const START_TIME = Date.now();

// Integration env vars CC's dashboard needs to function. We report
// presence (boolean) ONLY — never the values — so the operator can see at
// a glance whether a deploy carries the right secrets without leaking
// anything. Added 2026-05-21 after the BRAVO_ANTHROPIC_API_KEY-missing
// regression on the "Recommend next move" button.
const INTEGRATION_KEYS = [
  "BRAVO_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "BRAVO_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "OASIS_OUTBOUND_HMAC_SECRET",
] as const;

function integrationPresence(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of INTEGRATION_KEYS) {
    out[k] = Boolean((process.env[k] || "").trim());
  }
  return out;
}

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "command-center",
      version: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || "dev",
      branch: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF || "main",
      deployed_at: process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN
        ? new Date(START_TIME).toISOString()
        : new Date(START_TIME).toISOString(),
      uptime_seconds: Math.round((Date.now() - START_TIME) / 1000),
      integrations: integrationPresence(),
      ts: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    },
  );
}

export async function HEAD() {
  // Cheap probe path: HEAD avoids serializing the body, perfect for
  // load balancers + uptime monitors.
  return new NextResponse(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
