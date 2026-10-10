/**
 * lib/os/runs/scope.ts - the person and workspace behind a request that only
 * reads or changes their own conversations (the list, a transcript, Stop,
 * rename, delete). The same resolution the channel route uses: the session's
 * ACTIVE workspace, never one named in the request.
 */
import "server-only";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import type { RunScope } from "./store";

export async function resolveRunScope(): Promise<{ ok: true; scope: RunScope } | { ok: false; status: number; error: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  const resolved = await resolveActiveProfileForUser(user);
  if (resolved.error) return { ok: false, status: 503, error: "profile_unavailable" };
  const tenantId = resolved.profile?.tenant_id;
  if (!tenantId) return { ok: false, status: 403, error: "no_tenant" };
  return { ok: true, scope: { tenantId, userId: user.id } };
}

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
