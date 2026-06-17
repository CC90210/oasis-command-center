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
 *     pm2 services — SUNBIZ_WORKER_NAMES in @/lib/automations/sunbiz-workers),
 *   - gates to owner/admin only — bouncing a production daemon is a shell-tier
 *     privilege, identical to "can this role run bash on the VPS"
 *     (bridgeExecToolAllowedForRole(role, "bash")), so members / read_only /
 *     loan_officer / processor are rejected,
 *   - then, and only then, forwards `pm2 <action> <name>` to the bridge with
 *     the server-held bearer. The tunnel can only ever receive that exact,
 *     constrained command from us — never operator-supplied bash.
 */

import { NextResponse } from "next/server";
import { authorizeBridgeRequest, callBridgeExecTool } from "@/lib/bridge-proxy";
import { bridgeExecToolAllowedForRole } from "@/lib/role-gates";
import { SUNBIZ_WORKER_NAMES } from "@/lib/automations/sunbiz-workers";

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
  if (!SUNBIZ_WORKER_NAMES.has(name)) {
    return NextResponse.json({ ok: false, error: "unknown_worker" }, { status: 400 });
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
