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
import { CONSENT_FLAG_LOCKED, CONSENT_FLAG_LOCKED_MESSAGE } from "@/lib/consent/lead-consent-flags";
import { guardConsentLift } from "@/lib/consent/consent-lift";
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
      /* V6.9.5 hotfix: previous version replaced the entire JSONB `data`
         column with the input, silently wiping every field not in the
         update body. Now we fetch-then-merge: read current row, spread
         existing data + input.data, write merged result. Race-tolerant
         because tenant_records is operator-mutated, not heavy concurrent. */
      const current = await db
        .from("tenant_records")
        .select("data, entity_type")
        .eq("id", input.record_id)
        .eq("tenant_id", ctx.tenant_id)
        .maybeSingle();
      if (current.error) {
        return { status: "failed", error: `read_for_merge_failed: ${current.error.message}` };
      }
      if (!current.data) return { status: "failed", error: "record_not_found" };
      const row = current.data as { data?: Record<string, unknown>; entity_type?: string };
      const merged = {
        ...(row.data ?? {}),
        ...input.data,
      };
      // CONSENT FLAGS STAY SET (2026-10-20). An automation is never the owner or
      // admin who may take back a "stop": it cannot clear dnc / opted_out /
      // sms_opt_out / email_opt_out / sms_opt_out_at or leave opted_out. Judged by
      // the entity type STORED on the row, not the one the workflow names: this
      // update is keyed by record id alone, so a workflow could otherwise name a
      // different type and walk past the check.
      const consent = await guardConsentLift({
        tenantId: ctx.tenant_id,
        entity: String(row.entity_type ?? ""),
        recordId: input.record_id,
        before: row.data,
        patch: input.data,
        lifter: null,
      });
      if (!consent.ok) {
        return {
          status: "failed",
          error: `${CONSENT_FLAG_LOCKED}: ${CONSENT_FLAG_LOCKED_MESSAGE} (${consent.lifted.join(", ")})`,
        };
      }
      const update = await db
        .from("tenant_records")
        .update({ data: merged })
        .eq("id", input.record_id)
        .eq("tenant_id", ctx.tenant_id)
        .select("id")
        .maybeSingle();
      if (update.error) {
        return { status: "failed", error: `update_failed: ${update.error.message}` };
      }
      if (!update.data) return { status: "failed", error: "record_not_found" };
      return { status: "complete", output: { id: input.record_id, merged_keys: Object.keys(input.data) } };
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
