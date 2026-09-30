/**
 * GET /api/bridge/warm-status — the operator's warm chat pool, read through
 * the server (2026-09-30).
 *
 * WarmPoolPanel used to fetch `${NEXT_PUBLIC_BRIDGE_CHAT_BASE}/warm-status`
 * from the browser. The deployed bundle inlined that as http://localhost:3000
 * (a dev-server port), so the panel said "bridge offline?" while the bridge
 * was up; and since the bridge bearer went on (09-29) a browser cannot read
 * /warm-status at all. This route asks the bridge with the bearer the Command
 * Center already holds for the operator's workspace, and returns only the
 * pool's counts and per-process state (lib/admin/warm-pool.ts sanitizePool:
 * no session ids).
 *
 * It also returns the freshest paired computer from bridge_pairings, so the
 * Coding harness header can say "CCPC online, checked in 40 s ago" from the
 * same poll. The check-in is read before the bridge is asked, from the
 * session's workspace, so a bridge that is misconfigured or refusing still
 * shows when the computer last checked in.
 *
 * OPERATOR ONLY. Signed out: 401. Anyone else: 404 before any read. A bridge
 * failure is a 200 with `reason`, so the page can still show the computer's
 * check-in: bridge_refused_token (the bridge answered 401: the token, never
 * "offline"), bridge_timeout, bridge_unreachable, bridge_error,
 * bridge_not_configured.
 */

import { NextResponse } from "next/server";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { resolveTenantId } from "@/lib/api-auth";
import { authorizeBridgeRequest } from "@/lib/bridge-proxy";
import { getServiceSupabase } from "@/lib/supabase-server";
import { machineState } from "@/lib/admin/attention";
import { sanitizePool, type WarmStatusMachine } from "@/lib/admin/warm-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REASON_MESSAGE: Record<string, string> = {
  bridge_refused_token: "The bridge refused the request (token).",
  bridge_timeout: "Your computer's bridge didn't answer within 2 seconds.",
  bridge_unreachable: "The Command Center couldn't reach your computer's bridge.",
  bridge_error: "Your computer's bridge answered with an error.",
  bridge_not_configured: "No bridge address or token is set for this workspace.",
};

export async function GET() {
  const op = await resolvePlatformOperator();
  if (!op.operator) {
    return op.reason === "no_session"
      ? NextResponse.json({ ok: false, reason: "unauthenticated" }, { status: 401 })
      : NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  const machine = await readMachine();
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    if (auth.status === 401) return NextResponse.json({ ok: false, reason: "unauthenticated" }, { status: 401 });
    return NextResponse.json({ ok: false, reason: auth.error, message: REASON_MESSAGE[auth.error] ?? auth.error, machine });
  }

  let res: Response;
  try {
    res = await fetch(`${auth.target.baseUrl}/warm-status`, {
      headers: { authorization: `Bearer ${auth.target.bearerToken}` },
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "bridge_timeout" : "bridge_unreachable";
    if (reason === "bridge_unreachable") console.error("[bridge.warm_status.fetch]", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, reason, message: REASON_MESSAGE[reason], machine });
  }
  if (res.status === 401) {
    return NextResponse.json({ ok: false, reason: "bridge_refused_token", message: REASON_MESSAGE.bridge_refused_token, machine });
  }
  if (!res.ok) {
    return NextResponse.json({ ok: false, reason: "bridge_error", message: `${REASON_MESSAGE.bridge_error} (HTTP ${res.status})`, machine });
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch (err) {
    console.error("[bridge.warm_status.body]", err instanceof Error ? err.message : err);
  }
  const pool = sanitizePool(raw);
  if (!pool) {
    return NextResponse.json({ ok: false, reason: "bridge_error", message: "Your computer's bridge sent a pool report this page can't read.", machine });
  }
  return NextResponse.json({ ok: true, pool, machine }, { headers: { "cache-control": "no-store" } });
}

/** The session workspace's freshest paired computer; `unreadable` when the read failed (logged). */
async function readMachine(): Promise<WarmStatusMachine> {
  let tenantId: string | null;
  try {
    tenantId = await resolveTenantId();
  } catch (err) {
    console.error("[bridge.warm_status.tenant]", err instanceof Error ? err.message : err);
    return { unreadable: true };
  }
  if (!tenantId) return { unreadable: true };
  const pairing = await getServiceSupabase()
    .from("bridge_pairings")
    .select("label, last_seen_at")
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (pairing.error) {
    console.error("[bridge.warm_status.pairing]", pairing.error.message);
    return { unreadable: true };
  }
  const row = ((pairing.data || []) as Array<{ label: string | null; last_seen_at: string | null }>)[0];
  return row ? { label: row.label || "Unnamed computer", last_seen_at: row.last_seen_at, state: machineState(row.last_seen_at, Date.now()) } : null;
}
