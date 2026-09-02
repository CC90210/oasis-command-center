/**
 * GET /api/shell/status — the sidebar's live/bridge dots, fetched by the
 * client AFTER first paint (P1 instant-load, 2026-09-01).
 *
 * These reads used to block the root layout on every full page load. The
 * signals are per-operator chrome: session-gated (401 without one), never
 * cached (no-store), and resolved through the same lib/shell-status.ts
 * logic the layout's label resolution shares, so the manifest-validation
 * guard on the agent slug cannot drift between the two callers.
 */

import { NextResponse } from "next/server";
import { getActiveProfile } from "@/lib/queries";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { getShellStatus, resolvePrimaryAgent } from "@/lib/shell-status";
import { safe } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const profile = await safe("shell_status.profile", getActiveProfile(), null);
  if (!profile) {
    // No session → no status. Fail closed; the dots simply stay off.
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const tenantId = profile.tenant_id || null;
  const manifest = await safe(
    "shell_status.manifest",
    getTenantManifestForUser(tenantId),
    null,
  );
  const agent = resolvePrimaryAgent(profile, manifest);
  const status = await getShellStatus(agent, tenantId);
  return NextResponse.json(status, {
    headers: { "cache-control": "no-store" },
  });
}
