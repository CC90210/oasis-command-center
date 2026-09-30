/**
 * POST /api/automations/background-workers/control — start/stop/restart a
 * background worker through its bridge's exec-tool, with the bearer held here.
 *
 * TWO FLEETS, ONE ROUTE (2026-09-30).
 *
 *   OASIS — the operator's own machine. The browser used to POST the bridge on
 *   127.0.0.1:9100 directly. Since the bridge bearer went on (BEA 38139ede,
 *   2026-09-29) the bridge answers 401 to anything without the token, loopback
 *   included, and a browser must never hold that token. So every OASIS Start /
 *   Stop / Restart comes here: the verified platform operator only, standing
 *   in an OASIS workspace, a worker from lib/automations/oasis-workers.ts, and
 *   the bridge's own `fleet_control` tool (it validates the action and shells
 *   nothing; pm2 has not been the Windows supervisor since 2026-08-27). This is
 *   the only path on the OASIS deployment (DEPLOY_SURFACE=oasis).
 *
 *   SunBiz — the retired tenant's VPS daemons, kept for the non-OASIS
 *   deployment exactly as before (below). It 404s on the OASIS deployment
 *   before any session or database read.
 *
 * A 401 from a bridge is reported as `bridge_refused_token`: the bridge refused
 * the request (token), which is a configuration fault, never "offline".
 *
 * SUNBIZ PATH, as it was:
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
 *   - B4 (2026-07-23; hardened 2026-07-23 per CodeRabbit PR #81 review):
 *     WORKER-OWNER SEGREGATION. sunbiz-workers.ts tags each daemon "cc"
 *     (SunBiz core infra) / "adon" (Breeze/MCA underwriting) / "shared".
 *     This table has no per-user identity column, so the actor's side is
 *     resolved from authorizeBridgeRequest()'s isOperator flag: the empire
 *     operator (CC) bypassing the tenant gate = "cc"; any other authenticated
 *     SunBiz tenant member (owner/admin-tier, per the role gate above) =
 *     "adon" side. A caller may act on a worker whose owner matches their
 *     side, or "shared". Cross-owner is DENIED for everyone else — the ONLY
 *     override is the empire operator (isOperator), NOT a SunBiz tenant
 *     is_owner role. teamRole promotes to "owner" for the tenant's OWN
 *     is_owner flag (Adon, on the 'submissions' tenant) — using that as the
 *     escape hatch would let Adon's side bounce CC's core-infra daemons,
 *     which is exactly the hole this gate exists to close. Every attempt
 *     (allowed or denied) is logged with the actor via tenant_audit_log.
 *   - then, and only then, forwards `pm2 <action> <name>` to the bridge with
 *     the server-held bearer. The tunnel can only ever receive that exact,
 *     constrained command from us — never operator-supplied bash.
 */

import { NextResponse } from "next/server";
import {
  authorizeBridgeRequest,
  callBridgeExecTool,
  type BridgeAuthResult,
  type BridgeExecResult,
} from "@/lib/bridge-proxy";
import { bridgeExecToolAllowedForRole } from "@/lib/role-gates";
import { SUNBIZ_WORKERS } from "@/lib/automations/sunbiz-workers";
import { controllableOasisWorker } from "@/lib/automations/oasis-workers";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { externalTenantSurfacesBlocked } from "@/lib/deployment-surface";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ACTIONS = new Set(["start", "stop", "restart"]);

export async function POST(req: Request) {
  if (externalTenantSurfacesBlocked()) {
    // The OASIS deployment has one fleet: the operator's own machine. The
    // SunBiz remote path below never runs here.
    return controlOasisFleet(req, await authorizeBridgeRequest());
  }
  // Auth + tenant gate + VPS target resolution, all server-side. SunBiz
  // ('submissions') tenant or operator passes; everyone else 403/503.
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  if (auth.tenantSlug !== "submissions") {
    if (auth.isOperator && isOasisSurfaceTenant(auth.tenantSlug)) return controlOasisFleet(req, auth);
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
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
  // ONLY the empire operator (CC) may cross the owner boundary. A SunBiz
  // tenant is_owner (Adon, teamRole==="owner") is NOT a valid override here —
  // that would let Adon's side bounce CC's core-infra daemons, defeating the
  // whole point of this gate. (CodeRabbit PR #81 [Major]: the prior
  // `auth.teamRole === "owner" || auth.isOperator` left exactly that hole.)
  const operatorOverride = auth.isOperator;
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
        outcome: operatorOverride ? "operator_override_allowed" : "denied",
      },
    });
  }
  if (!ownerMatches && !operatorOverride) {
    return NextResponse.json(
      { ok: false, error: "cross_owner_worker_denied", worker_owner: worker.owner },
      { status: 403 },
    );
  }

  const result = await callBridgeExecTool(auth.target, {
    tool_name: "bash",
    input: { command: `pm2 ${action} ${name}` },
  });
  if (!result.ok) return bridgeFailure(result);
  return NextResponse.json({ ok: true, output: result.output || "ok" });
}

/**
 * The OASIS local fleet: the verified platform operator in an OASIS workspace,
 * a worker from the OASIS inventory, the bridge's `fleet_control` tool.
 * Everyone else gets a 404 that names nothing (a signed-out browser, 401).
 * The operator whose OASIS workspace has no bridge target gets 503
 * bridge_not_configured, which lib/automations/worker-control.ts words as "no
 * bridge address or token is set for this workspace", never "this workspace
 * can't control that worker".
 */
async function controlOasisFleet(req: Request, bridge: BridgeAuthResult): Promise<NextResponse> {
  if (!bridge.ok) {
    if (bridge.status === 401) {
      return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
    }
    if (bridge.error === "bridge_not_configured" && bridge.isOperator === true && isOasisSurfaceTenant(bridge.tenantSlug ?? "")) {
      return NextResponse.json({ ok: false, error: "bridge_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (!bridge.isOperator || !isOasisSurfaceTenant(bridge.tenantSlug)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  let body: { service?: string; action?: string };
  try {
    body = (await req.json()) as { service?: string; action?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const action = String(body.action || "");
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  const worker = controllableOasisWorker(String(body.service || ""));
  if (!worker) {
    return NextResponse.json({ ok: false, error: "unknown_worker" }, { status: 400 });
  }
  const name = worker.service.replace(/^pm2\./, "");
  const result = await callBridgeExecTool(bridge.target, {
    tool_name: "fleet_control",
    input: { action, name },
  });
  const audit = await logTenantAudit({
    tenantId: bridge.tenantId,
    actorUserId: bridge.userId,
    actionType: "background_worker_control",
    targetTable: "oasis_workers",
    targetId: name,
    after: { action, outcome: result.ok ? "accepted" : "failed", http_status: result.httpStatus },
  });
  if (!audit.ok) console.error("[background-workers.control.audit]", audit.error);
  if (!result.ok) return bridgeFailure(result);
  return NextResponse.json({ ok: true, output: result.output || "ok" });
}

/** A failed bridge call, named. A 401 is the token, never "offline". */
function bridgeFailure(result: BridgeExecResult): NextResponse {
  if (result.httpStatus === 401) {
    return NextResponse.json(
      { ok: false, error: "bridge_refused_token", message: "The bridge refused the request (token)." },
      { status: 502 },
    );
  }
  if (result.httpStatus === 0) {
    return NextResponse.json(
      { ok: false, error: "bridge_unreachable", message: result.error || "The bridge could not be reached." },
      { status: 502 },
    );
  }
  return NextResponse.json(
    { ok: false, error: result.error || result.output || `bridge_http_${result.httpStatus}` },
    { status: 502 },
  );
}
