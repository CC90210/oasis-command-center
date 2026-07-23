/**
 * POST /api/automations/background-workers/control — start/stop/restart a
 * SunBiz VPS background daemon via the VPS bridge's exec-tool.
 *
 * Why a server-side proxy (unlike the OASIS local-bridge path, which the
 * browser hits directly on localhost): the SunBiz daemons run on the VPS, not
 * the operator's machine. The VPS bridge is reachable from Vercel via its
 * Cloudflare tunnel — but the bearer must NOT live in the browser, and the
 * public tunnel must never receive arbitrary bash.
 *
 * Bridge resolution + auth reuse the SAME hardened path every other VPS proxy
 * uses (chat, shop-out, underwriting): `authorizeBridgeRequest()` resolves the
 * session → SunBiz tenant gate → `{ baseUrl, bearerToken }` from BRIDGE_VPS_URL
 * + BRIDGE_BEARER_TOKEN (already configured in the dashboard env — the chat
 * proves it). This route then:
 *   - allowlists action ∈ {start,stop,restart} and the daemon name (the SunBiz
 *     pm2 services — SUNBIZ_WORKERS in @/lib/automations/sunbiz-workers; a
 *     name that doesn't match any entry there is rejected as unknown_worker),
 *   - gates to owner/admin only — bouncing a production daemon is a shell-tier
 *     privilege, identical to "can this role run bash on the VPS"
 *     (bridgeExecToolAllowedForRole(role, "bash")), so members / read_only /
 *     loan_officer / processor are rejected,
 *   - B4 (2026-07-23): WORKER-OWNER SEGREGATION. sunbiz-workers.ts tags each
 *     daemon "cc" (SunBiz core infra) / "adon" (Breeze/MCA underwriting) /
 *     "shared". This table has no per-user identity column, so the actor's
 *     side is resolved from authorizeBridgeRequest()'s isOperator flag: the
 *     empire operator (CC) bypassing the tenant gate = "cc"; any other
 *     authenticated SunBiz tenant member (owner/admin-tier, per the role gate
 *     above) = "adon" side. A caller may act on a worker whose owner matches
 *     their side, or "shared". Cross-owner is DENIED unless the caller's role
 *     promoted to "owner" (tenant is_owner) — the one documented escape hatch
 *     — and every attempt (allowed or denied) is logged with the actor.
 *   - then, and only then, forwards `pm2 <action> <name>` to the bridge with
 *     the server-held bearer. The tunnel can only ever receive that exact,
 *     constrained command from us — never operator-supplied bash.
 */

import { NextResponse } from "next/server";
import { authorizeBridgeRequest, callBridgeExecTool } from "@/lib/bridge-proxy";
import { bridgeExecToolAllowedForRole } from "@/lib/role-gates";
import { SUNBIZ_WORKERS } from "@/lib/automations/sunbiz-workers";
import { logTenantAudit } from "@/lib/audit/activity-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

export async function POST(req: Request) {
  // Auth + tenant gate + VPS target resolution, all server-side. SunBiz
  // ('submissions') tenant or operator passes; everyone else 403/503.
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  // pm2 start/stop/restart is a shell-tier action on the shared VPS. Gate it to
  // the same roles that may run `bash` via the bridge (owner / admin only) —
  // a member doing day-to-day deals must not be able to bounce the daemons.
  if (!bridgeExecToolAllowedForRole(auth.teamRole, "bash")) {
    return NextResponse.json(
      { ok: false, error: "tool_disallowed_for_role", team_role: auth.teamRole },
      { status: 403 },
    );
  }

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
  const worker = SUNBIZ_WORKERS.find((w) => w.service.replace(/^pm2\./, "") === name);
  if (!worker) {
    return NextResponse.json({ ok: false, error: "unknown_worker" }, { status: 400 });
  }

  // B4 (2026-07-23) — worker-owner segregation gate. See the file-header
  // doc comment above for the full rationale. Every cross-owner touch
  // (denied OR allowed-via-override) gets a DURABLE row in tenant_audit_log
  // — reusing B2's logTenantAudit() rather than a console line, so "who
  // bounced Adon's Breeze daemon" survives past Vercel's ephemeral function
  // logs and is queryable on the same Settings/Operations audit surface as
  // everything else. Best-effort: a failed audit write never blocks the
  // gate decision itself.
  const actorSide: "cc" | "adon" = auth.isOperator ? "cc" : "adon";
  const ownerMatches = worker.owner === "shared" || worker.owner === actorSide;
  const tenantOwnerOverride = auth.teamRole === "owner";
  if (!ownerMatches) {
    await logTenantAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actionType: "background_worker_cross_owner_control",
      targetTable: "sunbiz_workers",
      targetId: name,
      after: {
        actor_side: actorSide,
        action,
        worker_owner: worker.owner,
        outcome: tenantOwnerOverride ? "owner_override_allowed" : "denied",
      },
    });
  }
  if (!ownerMatches && !tenantOwnerOverride) {
    return NextResponse.json(
      { ok: false, error: "cross_owner_worker_denied", worker_owner: worker.owner },
      { status: 403 },
    );
  }

  const result = await callBridgeExecTool(auth.target, {
    tool_name: "bash",
    input: { command: `pm2 ${action} ${name}` },
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error || result.output || `bridge_http_${result.httpStatus}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, output: result.output || "ok" });
}
