/**
 * POST /api/automations/background-workers/control — start/stop/restart a
 * SunBiz VPS background daemon via the VPS bridge's exec-tool.
 *
 * Why a server-side proxy (unlike the OASIS local-bridge path, which the
 * browser hits directly on localhost): the SunBiz daemons run on the VPS, not
 * the operator's machine. The VPS bridge is reachable from Vercel via its
 * Cloudflare tunnel (SUNBIZ_BRIDGE_URL) — but the bearer must NOT live in the
 * browser, and the public tunnel must never receive arbitrary bash. So this
 * route:
 *   - authenticates the caller as the SunBiz tenant operator,
 *   - allowlists action ∈ {start,stop,restart} and the daemon name (the 7
 *     SunBiz pm2 services — mirrors SUNBIZ_WORKERS in ../route.ts),
 *   - then, and only then, forwards `pm2 <action> <name>` to the bridge with
 *     the server-held bearer. The tunnel can only ever receive that exact,
 *     constrained command from us — never operator-supplied bash.
 *
 * Env: SUNBIZ_BRIDGE_URL (e.g. https://bridge.oasisai.work) + SUNBIZ_BRIDGE_BEARER.
 * If unset, returns 503 bridge_not_configured (controls stay hidden until set).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { SUNBIZ_WORKER_NAMES } from "@/lib/automations/sunbiz-workers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The only daemons this route may control — derived from the shared
// SUNBIZ_WORKERS list, so the allowlist can never drift from the displayed set.
const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { service?: string; action?: string };
  try {
    body = (await req.json()) as { service?: string; action?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = String(body.action || "");
  const name = String(body.service || "").replace(/^pm2\./, "");
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  if (!SUNBIZ_WORKER_NAMES.has(name)) {
    return NextResponse.json({ ok: false, error: "unknown_worker" }, { status: 400 });
  }

  // Caller must be the SunBiz tenant operator.
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const tenant = await getTenant(tenantId);
  if (!tenant || resolveClientProfileSlug(tenant) !== "sun") {
    return NextResponse.json({ ok: false, error: "not_enabled_for_tenant" }, { status: 403 });
  }

  const bridgeUrl = (process.env.SUNBIZ_BRIDGE_URL || "").replace(/\/$/, "");
  const bearer = process.env.SUNBIZ_BRIDGE_BEARER || "";
  if (!bridgeUrl || !bearer) {
    return NextResponse.json(
      {
        ok: false,
        error: "bridge_not_configured",
        detail: "Set SUNBIZ_BRIDGE_URL + SUNBIZ_BRIDGE_BEARER in the dashboard environment.",
      },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(`${bridgeUrl}/exec-tool`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ tool_name: "bash", input: { command: `pm2 ${action} ${name}` } }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      output?: string;
      is_error?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false || data.is_error === true) {
      return NextResponse.json(
        { ok: false, error: data.error || data.output || `bridge_http_${res.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, output: data.output || "ok" });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "bridge_unreachable" },
      { status: 502 },
    );
  }
}
