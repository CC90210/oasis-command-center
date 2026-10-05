import { NextResponse } from "next/server";
import { deploymentGitRef, deploymentGitSha } from "@/lib/health/runtime-environment";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness probe for the Docker healthcheck, external uptime monitors,
 * and the desktop wizard's "is the dashboard reachable" check.
 *
 * Intentionally public (allowlisted in middleware.ts). The public payload
 * is build info + uptime, so callers can detect "is the deploy fresh".
 * The desktop wizard reads `version`; every other consumer reads only the
 * HTTP status.
 *
 * Cache-Control: no-store so monitors get the actual current state
 * instead of an edge-cached snapshot from minutes ago.
 */

const START_TIME = Date.now();

// Integration env vars CC's dashboard needs to function. We report
// presence (boolean) ONLY — never the values — so the operator can see at
// a glance whether a deploy carries the right secrets. Added 2026-05-21
// after the BRAVO_ANTHROPIC_API_KEY-missing regression on the "Recommend
// next move" button.
//
// OPERATOR ONLY since 2026-09-29 (F0 containment). This map used to go to
// anyone who asked, and "which of these secrets is unset" is a list of the
// integrations that are down, handed to whoever wants to probe them. It is
// now added to the payload only for a verified platform operator session;
// everyone else gets the build info alone.
const INTEGRATION_KEYS = [
  "BRAVO_ANTHROPIC_API_KEY",
  "BRAVO_OPENAI_API_KEY",
  "BRAVO_SUPABASE_URL",
  "BRAVO_SUPABASE_SERVICE_ROLE_KEY",
  "BRAVO_SUPABASE_ANON_KEY",
  "BRAVO_FIELD_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OASIS_OUTBOUND_HMAC_SECRET",
  "CHAT_ATTACHMENT_HMAC_KEY",
  "CHAT_RESUME_HMAC_KEY",
  "CRON_SECRET",
] as const;

function integrationPresence(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of INTEGRATION_KEYS) {
    out[k] = Boolean((process.env[k] || "").trim());
  }
  return out;
}

export async function GET() {
  // Fails closed: a session or membership lookup error is logged inside and
  // answers "not an operator", so the probe still answers 200 without the map.
  const op = await resolvePlatformOperator();
  return NextResponse.json(
    {
      status: "ok",
      service: "command-center",
      version: deploymentGitSha()?.slice(0, 8) || "dev",
      branch: deploymentGitRef() || "main",
      deployed_at: process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN
        ? new Date(START_TIME).toISOString()
        : new Date(START_TIME).toISOString(),
      uptime_seconds: Math.round((Date.now() - START_TIME) / 1000),
      ...(op.operator ? { integrations: integrationPresence() } : {}),
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
