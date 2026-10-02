/**
 * /api/clients/import-stripe — "Import Stripe customers" (OASIS only).
 *
 *   GET   the plan: what an import WOULD do (create, link, skip, conflict),
 *         with each Stripe customer's name and email as the books hold them,
 *         their subscription status and their last payment, so the founder
 *         can choose. Writes nothing.
 *   POST  { confirm_privacy: true, confirmed: [{ stripe_customer_id, action }],
 *           declined: [stripe_customer_id] }
 *         carries out what the founder was SHOWN and ticked, nothing else
 *         (lib/os/customers/stripe-sync.ts runStripeImport). `declined` names
 *         the people shown and left unticked, counted as left out by the
 *         founder; a Stripe customer that reached the books after the preview,
 *         or whose action changed, is reported and left for the next review.
 *         Records hold a name, an email and the Stripe customer id, nothing
 *         more.
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
import { planStripeImport, runStripeImport, type ConfirmedImport } from "@/lib/os/customers/stripe-sync";
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
        subscription_status: p.group.subscription_status,
        last_paid_at: p.group.last_paid_at,
        ...("customerId" in p && p.customerId ? { customer_id: p.customerId } : {}),
        ...(p.action === "skip" ? { reason: p.reason } : {}),
      })),
    });
  } catch (err) {
    return customersServerError("import_stripe_plan", err);
  }
}

const MAX_CONFIRMED = 5000;

/**
 * The dialog's list, as [{ stripe_customer_id, action }]; null when it is not
 * that shape. An id is taken as the GET showed it (whatever the books hold,
 * e.g. cus_TEST_SUB): only ids the fresh plan also holds are ever acted on,
 * so the id needs no pattern of its own here, just a sane size.
 */
function parseConfirmed(raw: unknown): ConfirmedImport | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CONFIRMED) return null;
  const out = new Map<string, "create" | "link">();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { stripe_customer_id: id, action } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 255) return null;
    if (action !== "create" && action !== "link") return null;
    if (out.has(id)) return null;
    out.set(id, action);
  }
  return out;
}

/**
 * The people the founder was shown and left unticked, as [stripe_customer_id];
 * absent means none. Null when it is not that shape, or when an id is also
 * confirmed: one person cannot be both imported and left out.
 */
function parseDeclined(raw: unknown, confirmed: ConfirmedImport): Set<string> | null {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw) || raw.length > MAX_CONFIRMED) return null;
  const out = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string" || id.length === 0 || id.length > 255) return null;
    if (out.has(id) || confirmed.has(id)) return null;
    out.add(id);
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const g = await gate();
    if (!g.ok) return g.res;
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const body = parsed.body as Record<string, unknown> | null;
    if (!body || body.confirm_privacy !== true) return customersError(400, "privacy_confirmation_required");
    const confirmed = parseConfirmed(body.confirmed);
    if (!confirmed) return customersError(400, "import_confirmation_invalid", { field: "confirmed" });
    const declined = parseDeclined(body.declined, confirmed);
    if (!declined) return customersError(400, "import_confirmation_invalid", { field: "declined" });
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const result = await runStripeImport(db, g.viewer.tenantId, g.viewer.userId, new Date(), confirmed, declined);
    return NextResponse.json({
      ok: true,
      created: result.created.length,
      linked: result.linked.length,
      skipped: result.skipped,
      conflicts: result.conflicts,
      declined: result.declined.length,
      unreviewed: result.unreviewed.length,
      changed: result.changed.length,
    });
  } catch (err) {
    return customersServerError("import_stripe", err);
  }
}
