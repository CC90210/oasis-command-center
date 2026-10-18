/**
 * GET /api/integrations/registry — canonical integration list.
 *
 * Returns the live check catalog for the bridge: service slug, category,
 * label and env_key (when api_key style). The bridge can scan .env.agents
 * without carrying its own hardcoded list. Settings > Connections is the
 * only user-facing connections catalog (2026-10-18).
 *
 * Public (no auth) since the data is static and non-sensitive: service
 * names and env-var names only. No tenant data leaks. Cached for 5 minutes
 * via Cache-Control to keep bridge fetch overhead low.
 */

import { NextResponse } from "next/server";
import { KNOWN_INTEGRATIONS } from "@/lib/integrations-registry";

export const runtime = "nodejs";
export const dynamic = "force-static"; // pure data, no per-request state

export async function GET() {
  // Project just the fields the bridge needs. env_key is optional —
  // entries without it aren't api-key style integrations.
  const entries = KNOWN_INTEGRATIONS.map((i) => ({
    service: i.service,
    label: i.label,
    category: i.category,
    connection_kind: i.connection_kind,
    env_key: i.env_key || null,
    setup_complexity: i.setup_complexity,
  }));
  return NextResponse.json(
    { ok: true, count: entries.length, entries },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300",
      },
    }
  );
}
