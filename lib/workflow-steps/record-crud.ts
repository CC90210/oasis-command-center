/**
 * record-crud step — V6.9.2.
 *
 * Performs a CRUD operation against tenant_records, scoped to the run's
 * tenant_id. Operations: create / update / delete (read is expressed via
 * prior_outputs from an earlier read step or trigger event).
 *
 * Input shape:
 *   { operation: "create" | "update" | "delete",
 *     entity_type: string,
 *     record_id?: string,        // required for update/delete
 *     data?: Record<string, unknown> }  // required for create/update
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { StepContext, StepResult, WorkflowStep } from "./types";

type RecordCrudInput = {
  operation?: "create" | "update" | "delete";
  entity_type?: string;
  record_id?: string;
  data?: Record<string, unknown>;
};

const handler: WorkflowStep = {
  type: "record-crud",
  async execute(rawInput: unknown, ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as RecordCrudInput;
    if (!input.operation) return { status: "failed", error: "missing_operation" };
    if (!input.entity_type) return { status: "failed", error: "missing_entity_type" };

    const db = getServiceSupabase();

    if (input.operation === "create") {
      if (!input.data || typeof input.data !== "object") {
        return { status: "failed", error: "missing_data_for_create" };
      }
      const insert = await db
        .from("tenant_records")
        .insert({
          tenant_id: ctx.tenant_id,
          entity_type: input.entity_type,
          data: input.data,
        })
        .select("id")
        .single();
      if (insert.error || !insert.data) {
        return { status: "failed", error: `create_failed: ${insert.error?.message}` };
      }
      return { status: "complete", output: { id: (insert.data as { id: string }).id } };
    }

    if (input.operation === "update") {
      if (!input.record_id) return { status: "failed", error: "missing_record_id_for_update" };
      if (!input.data || typeof input.data !== "object") {
        return { status: "failed", error: "missing_data_for_update" };
      }
      const update = await db
        .from("tenant_records")
        .update({ data: input.data })
        .eq("id", input.record_id)
        .eq("tenant_id", ctx.tenant_id)
        .select("id")
        .maybeSingle();
      if (update.error) {
        return { status: "failed", error: `update_failed: ${update.error.message}` };
      }
      if (!update.data) return { status: "failed", error: "record_not_found" };
      return { status: "complete", output: { id: input.record_id } };
    }

    if (input.operation === "delete") {
      if (!input.record_id) return { status: "failed", error: "missing_record_id_for_delete" };
      const del = await db
        .from("tenant_records")
        .delete()
        .eq("id", input.record_id)
        .eq("tenant_id", ctx.tenant_id)
        .select("id")
        .maybeSingle();
      if (del.error) {
        return { status: "failed", error: `delete_failed: ${del.error.message}` };
      }
      if (!del.data) return { status: "failed", error: "record_not_found" };
      return { status: "complete", output: { id: input.record_id, deleted: true } };
    }

    return { status: "failed", error: `unknown_operation: ${input.operation}` };
  },
};

export default handler;
