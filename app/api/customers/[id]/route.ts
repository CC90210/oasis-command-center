/**
 * /api/customers/[id] — one client of the workspace.
 *
 *   GET    the record and its contacts. A client of another workspace is 404
 *          (the store matches tenant_id AND id), never 403, so the route cannot
 *          confirm it exists.
 *   PATCH  owners and admins: name, company, email, phone, lifecycle, owner
 *          (an active member of the workspace), Stripe customer, tags, custom
 *          fields, archived.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTenantMembers } from "@/lib/team";
import { validateCustomerPatch, validateOwner } from "@/lib/os/customers/rules";
import { getCustomer, listContacts, updateCustomer, type CustomerChanges } from "@/lib/os/customers/store";
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

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canRead) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const customer = await getCustomer(db, viewer.tenantId, id);
    if (!customer) return customersError(404, "not_found");
    const contacts = await listContacts(db, viewer.tenantId, id);
    return NextResponse.json({ ok: true, customer, contacts });
  } catch (err) {
    return customersServerError("detail", err);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.canWrite) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const v = validateCustomerPatch(parsed.body);
    if (!v.ok) return customersError(400, v.error, { field: v.field });
    const { owner_user_id, ...rest } = v.value;
    const changes: CustomerChanges = { ...rest };
    if ("owner_user_id" in v.value) {
      const owner = validateOwner(owner_user_id, await getTenantMembers(viewer.tenantId));
      if (!owner.ok) return customersError(400, owner.error, { field: "owner_user_id" });
      changes.owner_user_id = owner.value;
    }
    // The editor is the ledger's actor: a Status move into or out of Past
    // records customer.churned / customer.reactivated under this person.
    const result = await updateCustomer(db, viewer.tenantId, id, changes, new Date(), viewer.userId);
    if (!result.ok) {
      if (result.error === "not_found") return customersError(404, "not_found");
      return customersError(409, result.error, { existing_id: result.existingId });
    }
    return NextResponse.json({ ok: true, changed: result.changed, customer: result.customer });
  } catch (err) {
    return customersServerError("update", err);
  }
}
