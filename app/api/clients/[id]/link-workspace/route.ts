/**
 * POST /api/clients/[id]/link-workspace — link an OASIS client record to the
 * client's own OASIS workspace, or unlink it.
 *
 * Body: { client_tenant_id: "<tenants.id>" | null, confirmed: true }
 * (confirmed: the operator answered "Link <workspace> to this client?" or
 * "Unlink?" in the control; without it nothing changes.)
 *
 * OPERATOR ONLY, and only in OASIS's own workspace. The link is what lets the
 * record's Usage tab read the client's workspace (its ROI snapshots, agent
 * channels, approvals and desk), so it is a cross-workspace read grant: the
 * platform operator (lib/platform-operator.ts, verified by auth user id) is
 * the one person who may make it. Everyone else gets a 403 that says so.
 *
 * The record must be OASIS's (404 otherwise), the workspace must exist, may
 * not be OASIS's own and may not be a retired business (409 retired_business,
 * lib/os/customers/retired.ts), and one workspace belongs to one client record
 * (unique index; the holder is named in the 409). Without migration
 * bravo__195 the write is refused with a 503 (client_workspace_link_not_set_up):
 * the migration is named in the log, and the person on screen gets a sentence.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { setClientWorkspace } from "@/lib/os/customers/store";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const TENANT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.oasis) return customersError(403, "oasis_only");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const session = await resolveSessionContext();
    if (!session.ok || !(await isPlatformOperatorForAuthUser(session.userId, session.email))) {
      return customersError(403, "operator_only");
    }
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const body = parsed.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || !("client_tenant_id" in body)) {
      return customersError(400, "client_tenant_id_invalid", { field: "client_tenant_id" });
    }
    const raw = body.client_tenant_id;
    const clientTenantId = raw === null || raw === "" ? null : typeof raw === "string" && TENANT_ID_RE.test(raw.trim()) ? raw.trim() : undefined;
    if (clientTenantId === undefined) return customersError(400, "client_tenant_id_invalid", { field: "client_tenant_id" });
    // A cross-workspace read grant, made or removed, is confirmed first (the
    // control asks "Link <workspace> to this client?"); nothing changes without it.
    if (body.confirmed !== true) return customersError(400, "link_confirmation_required");
    let result: Awaited<ReturnType<typeof setClientWorkspace>>;
    try {
      result = await setClientWorkspace(db, viewer.tenantId, id, clientTenantId, new Date());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such column: client_tenant_id/i.test(msg)) {
        console.error("[customers:link_workspace] migration bravo__195 is not applied", msg);
        return customersError(503, "client_workspace_link_not_set_up");
      }
      throw err;
    }
    if (!result.ok) {
      if (result.error === "not_found") return customersError(404, "not_found");
      return customersError(409, result.error, result.existingId ? { existing_id: result.existingId } : undefined);
    }
    return NextResponse.json({ ok: true, changed: result.changed, client_tenant_id: result.customer.client_tenant_id });
  } catch (err) {
    return customersServerError("link_workspace", err);
  }
}
