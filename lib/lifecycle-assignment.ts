import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";

type LifecycleEntity = "lead" | "application" | "funded_deal" | "renewal";
type RecordRow = { id: string; entity_type: LifecycleEntity; data: Record<string, unknown> };

/** Keep the owner identical across the linked lead/application lifecycle. */
export async function assignLifecycleOwner(input: {
  tenantId: string;
  record: RecordRow;
  assignedTo: string | null;
}): Promise<{ ok: true; updatedIds: string[]; previousOwners: Array<string | null> } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const rows = new Map<string, RecordRow>([[input.record.id, input.record]]);

  const collect = async (entity: "lead" | "application", field: string, value: string) => {
    const result = await db.from("tenant_records").select("id, entity_type, data")
      .eq("tenant_id", input.tenantId).eq("entity_type", entity).filter(`data->>${field}`, "eq", value);
    if (result.error) return result.error.message;
    for (const row of (result.data || []) as RecordRow[]) rows.set(row.id, row);
    return null;
  };

  const collectId = async (entity: "lead" | "application", id: unknown) => {
    if (typeof id !== "string" || rows.has(id)) return null;
    const result = await db.from("tenant_records").select("id, entity_type, data")
      .eq("tenant_id", input.tenantId).eq("entity_type", entity).eq("id", id).maybeSingle();
    if (result.error) return result.error.message;
    if (result.data) rows.set(id, result.data as RecordRow);
    return null;
  };

  let lookupError: string | null = null;
  if (input.record.entity_type === "lead") {
    lookupError = await collect("application", "lead_id", input.record.id)
      || await collectId("application", input.record.data.application_id);
  } else if (input.record.entity_type === "application") {
    lookupError = await collect("lead", "application_id", input.record.id)
      || await collectId("lead", input.record.data.lead_id);
  }
  if (lookupError) return { ok: false, error: lookupError };

  const previousOwners: Array<string | null> = [];
  const updatedIds: string[] = [];
  for (const row of rows.values()) {
    previousOwners.push(typeof row.data.assigned_to === "string" ? row.data.assigned_to.toLowerCase() : null);
    const update = await db.rpc("patch_tenant_record_data", {
      p_id: row.id,
      p_tenant_id: input.tenantId,
      p_patch: { assigned_to: input.assignedTo },
    });
    if (update.error) return { ok: false, error: update.error.message };
    updatedIds.push(row.id);
  }
  return { ok: true, updatedIds, previousOwners };
}
