/**
 * clients-data — the reads behind /clients, each gated by the SAME rule its own
 * page uses, so this list can never show more than Pipeline, Projects and the
 * Support desk would show this viewer.
 *
 *   won deals          canSeeAllPipeline inside an OASIS workspace. A rep,
 *                      manager or marketer sees clients through their own
 *                      deals in Pipeline; the whole won list is the tenant's
 *                      book, which is exactly what their scope excludes.
 *   projects, tickets  lib/delivery/access.ts: a founder standing in OASIS.
 *                      A client workspace's delivery rows are OASIS's work FOR
 *                      that workspace — OASIS is their vendor, not their
 *                      customer — so they are not this list's rows.
 *
 * Every source reports ok / not_allowed / error separately, so the page can say
 * "you can't see this" and "this failed" in different words, and neither is a 0.
 */
import "server-only";

import { listRecords } from "@/lib/manifest/data";
import { getDeliveryAccess, getDeliveryDb } from "@/lib/delivery/session";
import { LIST_LIMIT, listProjects, listTickets } from "@/lib/delivery/store";
import type { OsPageViewer } from "@/components/os/landings/page-gate";
import {
  CLIENT_STAGES,
  type ClientLead,
  type ClientProject,
  type ClientTicket,
} from "@/components/os/landings/clients-model";

export type SourceState<T> =
  | { state: "ok"; rows: T[]; truncated: boolean }
  | { state: "not_allowed" }
  | { state: "not_applicable" }
  | { state: "error" };

/** Upper bound on won deals read for the list; the page says when it is hit. */
export const CLIENTS_LEAD_LIMIT = 1000;

/** The delivery reads' own ceiling (lib/delivery/store LIST_LIMIT); the page says when it is hit. */
export const CLIENTS_DELIVERY_LIMIT = LIST_LIMIT;

async function loadWonDeals(viewer: OsPageViewer): Promise<SourceState<ClientLead>> {
  if (!viewer.oasis) return { state: "not_applicable" };
  if (!viewer.surface.capabilities.canSeeAllPipeline) return { state: "not_allowed" };
  try {
    const r = await listRecords({
      tenant_id: viewer.surface.tenantId,
      entity: "lead",
      whereIn: { stage: CLIENT_STAGES },
      sort: "-updated_at",
      limit: CLIENTS_LEAD_LIMIT,
    });
    return {
      state: "ok",
      rows: r.rows.map((row) => ({ id: row.id, updated_at: row.updated_at, data: row.data || {} })),
      truncated: r.total > r.rows.length,
    };
  } catch (err) {
    console.error("[os.clients.won_deals]", err);
    return { state: "error" };
  }
}

async function loadDelivery(
  viewer: OsPageViewer,
): Promise<{ projects: SourceState<ClientProject>; tickets: SourceState<ClientTicket> }> {
  if (!viewer.oasis) return { projects: { state: "not_applicable" }, tickets: { state: "not_applicable" } };
  const access = await getDeliveryAccess();
  if (!access.ok || access.viewer.kind !== "founder") {
    return { projects: { state: "not_allowed" }, tickets: { state: "not_allowed" } };
  }
  const db = getDeliveryDb();
  if (!db) {
    console.error("[os.clients.delivery] Turso is not configured on this deployment");
    return { projects: { state: "error" }, tickets: { state: "error" } };
  }
  const v = access.viewer;
  const [projects, tickets] = await Promise.all([
    listProjects(db, v).then(
      (r): SourceState<ClientProject> => ({ state: "ok", rows: r.rows, truncated: r.truncated }),
      (err: unknown): SourceState<ClientProject> => {
        console.error("[os.clients.projects]", err);
        return { state: "error" };
      },
    ),
    listTickets(db, v, { status: "open" }).then(
      (r): SourceState<ClientTicket> => ({ state: "ok", rows: r.rows, truncated: r.truncated }),
      (err: unknown): SourceState<ClientTicket> => {
        console.error("[os.clients.tickets]", err);
        return { state: "error" };
      },
    ),
  ]);
  return { projects, tickets };
}

export async function loadClientSources(viewer: OsPageViewer) {
  const [wonDeals, delivery] = await Promise.all([loadWonDeals(viewer), loadDelivery(viewer)]);
  return { wonDeals, ...delivery };
}
