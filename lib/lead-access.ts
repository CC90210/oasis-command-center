import "server-only";
import { getRecord } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled, type LeadViewer } from "@/lib/lead-scope";

/**
 * Single-lead access gate for the /api/leads/[id]/* routes (Adon Batch 2).
 * Fetches the lead/application and confirms the viewer may access it — admin,
 * or the agent it's assigned to. Returns the record, or null when it's missing
 * OR access-denied; callers return 404 either way so a non-owner can't even
 * confirm the record exists.
 *
 * Server-only (imports the DB layer) — kept separate from lib/lead-scope.ts so
 * that module stays pure + unit-testable.
 */
export async function getAccessibleLead(
  viewer: LeadViewer,
  input: { tenantId: string; entity?: "lead" | "application"; id: string },
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const entity = input.entity || "lead";
  const rec = await getRecord({ tenant_id: input.tenantId, entity, id: input.id }).catch(() => null);
  if (!rec) return null;
  const data = rec.data as Record<string, unknown>;
  if (!canViewLead(viewer, data, leadScopingEnabled())) return null;
  return { id: rec.id, data };
}
