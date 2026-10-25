/**
 * /api/ai-audit/catalogue — the one service catalogue proposals price from.
 *
 *   GET                                  every item version (proposed, confirmed, retired)
 *   POST { action: "seed" }              add the proposed seed items (idempotent)       owner
 *   POST { action: "propose", item }     a new proposed version of a SKU                founder
 *   POST { action: "confirm", item_id }  make that version THE price                    owner
 *   POST { action: "retire", item_id }   stop offering it                               owner
 *
 * Confirming is the only way a price becomes usable on a proposal.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { validateCatalogueDraft } from "@/lib/ai-audit/catalogue";
import {
  confirmCatalogueItem,
  listCatalogue,
  proposeCatalogueVersion,
  retireCatalogueItem,
  seedCatalogue,
} from "@/lib/ai-audit/catalogue-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET() {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const items = await listCatalogue(access.session.db, access.session.tenantId);
  return json(200, { ok: true, items, viewer: { is_owner: access.session.isOwner } });
}

export async function POST(req: NextRequest) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const s = access.session;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") return json(400, { ok: false, error: "action_required" });
  const now = new Date();
  const ownerOnly = body.action === "seed" || body.action === "confirm" || body.action === "retire";
  if (ownerOnly && !s.isOwner) return json(403, { ok: false, error: "owner_only" });
  switch (body.action) {
    case "seed": {
      const r = await seedCatalogue(s.db, s.tenantId, s.userId, now);
      return json(200, { ok: true, inserted: r.inserted });
    }
    case "propose": {
      const draft = validateCatalogueDraft(body.item);
      if (!draft.ok) return json(400, { ok: false, error: "item_invalid", field: draft.field, detail: draft.error });
      const item = await proposeCatalogueVersion(s.db, s.tenantId, draft.value, s.userId, now);
      return json(200, { ok: true, item });
    }
    case "confirm":
    case "retire": {
      const id = typeof body.item_id === "string" ? body.item_id : "";
      if (!id) return json(400, { ok: false, error: "item_id_required" });
      const r = body.action === "confirm" ? await confirmCatalogueItem(s.db, s.tenantId, id, s.userId, now) : await retireCatalogueItem(s.db, s.tenantId, id, s.userId, now);
      if (!r.ok) return json(r.error === "not_found" ? 404 : 409, { ok: false, error: r.error });
      return json(200, { ok: true, item: r.item });
    }
    default:
      return json(400, { ok: false, error: "unknown_action" });
  }
}
