/**
 * GET /api/state-health — System health as JSON, for the platform operator.
 *
 * A thin wrapper over lib/admin/system-health.ts, the same loader /health
 * renders in-process (2026-09-30). It no longer proxies a state-api daemon a
 * Worker cannot reach, and no longer builds a fallback that mislabelled Turso
 * data, named the wrong host and returned every agent's working memory and the
 * latest session-log summary. What it returns is the operator's own workspace:
 * the paired computers, the guard report (or "not reported"), the background
 * workers, the failed schedules and the error/warning counts.
 *
 * OPERATOR-ONLY (P0-5, doc 02 F3). A signed-out caller gets 401; anyone who is
 * not the verified platform operator gets a 404 before any read.
 */

import { NextResponse } from "next/server";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { resolveTenantId } from "@/lib/api-auth";
import { loadSystemHealth } from "@/lib/admin/system-health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const op = await resolvePlatformOperator();
  if (!op.operator) {
    return op.reason === "no_session"
      ? NextResponse.json({ available: false, error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ available: false, error: "not_found" }, { status: 404 });
  }
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ available: false, error: "no_tenant" }, { status: 404 });
  const health = await loadSystemHealth(tenantId);
  return NextResponse.json({ available: true, ...health }, { headers: { "cache-control": "no-store" } });
}
