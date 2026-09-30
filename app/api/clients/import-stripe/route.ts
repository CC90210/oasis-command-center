/**
 * /api/clients/import-stripe — "Import Stripe customers" (OASIS only).
 *
 *   GET   the plan: what an import WOULD do (create, link, skip, conflict),
 *         with each Stripe customer's name and email as the books hold them.
 *         Writes nothing.
 *   POST  { confirm_privacy: true } carries the plan out
 *         (lib/os/customers/stripe-sync.ts runStripeImport): records hold a
 *         name, an email and the Stripe customer id, nothing more.
 *
 * Founder-clicked only. The books are OASIS's, so it runs only in OASIS's own
 * workspace, only for an owner or admin who may act there, and only for a
 * founder who may open Money (lib/founders-finances/access-io.ts
 * resolveFinanceViewer, the Finances pages' own gate). POST also requires the
 * founder to have answered the privacy question in the dialog: Stripe
 * subscribers can be private individuals (Quebec Law 25).
 */
import { NextResponse, type NextRequest } from "next/server";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { planStripeImport, runStripeImport } from "@/lib/os/customers/stripe-sync";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
  type ClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate(): Promise<{ ok: true; viewer: ClientsViewer } | { ok: false; res: NextResponse }> {
  const viewer = await resolveClientsViewer();
  if (!viewer) return { ok: false, res: customersError(401, "not_signed_in") };
  if (viewer.tenantId !== DELIVERY_TENANT_ID) return { ok: false, res: customersError(403, "oasis_only") };
  if (!viewer.canWrite) return { ok: false, res: customersError(403, "forbidden") };
  if (!(await resolveFinanceViewer())) return { ok: false, res: customersError(403, "finance_owners_only") };
  return { ok: true, viewer };
}

export async function GET() {
  try {
    const g = await gate();
    if (!g.ok) return g.res;
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const plan = await planStripeImport(db, g.viewer.tenantId);
    const count = (a: string) => plan.filter((p) => p.action === a).length;
    return NextResponse.json({
      ok: true,
      summary: { create: count("create"), link: count("link"), skip: count("skip"), conflict: count("conflict") },
      items: plan.map((p) => ({
        action: p.action,
        stripe_customer_id: p.group.stripe_customer_id,
        name: p.group.name,
        email: p.group.email,
        lifecycle: p.group.lifecycle,
        ...("customerId" in p && p.customerId ? { customer_id: p.customerId } : {}),
        ...(p.action === "skip" ? { reason: p.reason } : {}),
      })),
    });
  } catch (err) {
    return customersServerError("import_stripe_plan", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const g = await gate();
    if (!g.ok) return g.res;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const body = parsed.body as Record<string, unknown> | null;
    if (!body || body.confirm_privacy !== true) return customersError(400, "privacy_confirmation_required");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const result = await runStripeImport(db, g.viewer.tenantId, g.viewer.userId, new Date());
    return NextResponse.json({
      ok: true,
      created: result.created.length,
      linked: result.linked.length,
      skipped: result.skipped,
      conflicts: result.conflicts,
    });
  } catch (err) {
    return customersServerError("import_stripe", err);
  }
}
