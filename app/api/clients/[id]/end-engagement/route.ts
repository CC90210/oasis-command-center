/**
 * POST /api/clients/[id]/end-engagement — "Mark engagement ended".
 *
 * A founder's click (owners and admins; the page asks for confirmation first)
 * moves the client to Past (lifecycle "churned") and records customer.churned
 * in the Business Ledger in the same batch (lib/os/customers/store.ts
 * endEngagement). Nothing else on the record changes, and nothing is deleted:
 * its tickets, projects, files and history stay. A client already Past is a
 * no-op (changed: false). Undo is the record's Status select.
 */
import { NextResponse, type NextRequest } from "next/server";
import { endEngagement } from "@/lib/os/customers/store";
import { customersError, customersServerError, getCustomersDb, resolveClientsViewer } from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const result = await endEngagement(db, viewer.tenantId, id, viewer.userId, new Date());
    if (!result.ok) return customersError(404, "not_found");
    return NextResponse.json({ ok: true, changed: result.changed, lifecycle: result.customer.lifecycle, id: result.customer.id });
  } catch (err) {
    return customersServerError("end_engagement", err);
  }
}
