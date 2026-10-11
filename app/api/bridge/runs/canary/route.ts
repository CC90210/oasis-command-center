/**
 * POST /api/bridge/runs/canary - a 5-minute READ-profile MCP bearer for the
 * person's first open department, with NO run attached (O4 preflight step
 * 3, cli_design.json computer_runner). The connector spawns Claude Code
 * with it and reads the init event ONLY: tools must be exactly
 * mcp__oasis__*, and the only connected MCP server must be `oasis`. It then
 * kills the process tree at once, before any model call -- this route never
 * runs a turn and never touches dept_chat_runs.
 *
 * Same auth and approval gate as the claim route (resolvePairingFromBearer,
 * pairingCanClaim, the daemon-is-agents-owner rule, a live seat): a canary
 * bearer is a real, if narrow, capability (read access to this person's
 * workspace tools for 5 minutes), never handed to an unapproved or revoked
 * pairing.
 */
import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { isDaemonScope, pairingCanClaim, resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import { isAgentsOwner } from "@/lib/agents-owner";
import { liveSeat } from "@/lib/os/seat";
import { resolveOsViewerFor } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { mintMcpToken } from "@/lib/mcp/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANARY_TTL_SECONDS = 300;

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return bad(403, "unexpected_origin_header");

  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const { pairing } = resolved;

  if (!pairing.userId) return bad(409, "pairing_has_no_owner");
  if (!pairingCanClaim(pairing)) return bad(403, "not_approved");
  if (isDaemonScope(pairing) && !(await isAgentsOwner(pairing.tenantId, pairing.userId))) {
    return bad(403, "agents_owner_only");
  }
  const seat = await liveSeat(pairing.tenantId, pairing.userId);
  if (!seat.live) return bad(403, "seat_inactive");

  const viewer = await resolveOsViewerFor(pairing.tenantId, pairing.userId);
  if (!viewer.ok) return bad(403, "seat_inactive");

  const dept = OS_DEPARTMENTS.find((d) => departmentGate(d.slug, viewer.navInput) !== null);
  if (!dept) return bad(409, "no_department_open");

  let mcp: { token: string; exp: number };
  try {
    mcp = await mintMcpToken({
      tid: pairing.tenantId,
      uid: pairing.userId,
      dept: dept.key,
      prof: "read",
      sid: `canary-${crypto.randomUUID()}`,
      ttlSeconds: CANARY_TTL_SECONDS,
      // Bound to the computer that asked (security review, O4):
      // resolveMcpSession refuses it the moment this pairing is revoked.
      pid: pairing.pairingId,
      orig: "test",
    });
  } catch {
    return bad(503, "oasis_mcp_not_configured");
  }

  return NextResponse.json({ ok: true, token: mcp.token, exp: mcp.exp, mcp_url: "https://oasisai.work/api/mcp", department: dept.key });
}
