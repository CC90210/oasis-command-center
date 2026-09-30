/**
 * /api/customers — the workspace's clients (its OWN customers).
 *
 *   GET   list (filters: lifecycle, owner = <user id>|unassigned, q,
 *         archived=1). Readers: canSeeClientIdentities. Ticket and project
 *         counts only for a viewer who may read the workspace's desk; for
 *         everyone else they are null (unknown), never 0.
 *   POST  create (owners and admins). Duplicate email / Stripe customer in the
 *         workspace is a 409 naming the record that already holds it.
 *
 * The tenant is the session's (lib/os/customers/session.ts); nothing in the
 * request can name another workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTenantMembers } from "@/lib/team";
import { validateCustomerCreate, validateOwner } from "@/lib/os/customers/rules";
import { createCustomer, listCustomers } from "@/lib/os/customers/store";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canRead) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const sp = req.nextUrl.searchParams;
    const { rows, truncated } = await listCustomers(
      db,
      viewer.tenantId,
      {
        lifecycle: sp.get("lifecycle"),
        owner: sp.get("owner"),
        q: sp.get("q"),
        includeArchived: sp.get("archived") === "1",
      },
      { withDelivery: viewer.desk !== null },
    );
    return NextResponse.json({ ok: true, customers: rows, truncated });
  } catch (err) {
    return customersServerError("list", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const v = validateCustomerCreate(parsed.body);
    if (!v.ok) return customersError(400, v.error, { field: v.field });
    const owner = validateOwner(v.value.owner_user_id, await getTenantMembers(viewer.tenantId));
    if (!owner.ok) return customersError(400, owner.error, { field: "owner_user_id" });
    const result = await createCustomer(
      db,
      viewer.tenantId,
      { ...v.value, owner_user_id: owner.value, source_lead_id: null },
      viewer.userId,
      new Date(),
    );
    if (!result.ok) return customersError(409, result.error, { existing_id: result.existingId });
    return NextResponse.json({ ok: true, id: result.customer.id, customer: result.customer }, { status: 201 });
  } catch (err) {
    return customersServerError("create", err);
  }
}
