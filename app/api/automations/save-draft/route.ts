/**
 * POST /api/automations/save-draft
 *
 * Phase 10.3 — persist an operator-reviewed AutomationDraft as a paused,
 * exact-pairing tenant_cron_jobs row. Its reviewed source stays in the
 * server-only template record; the poll route signs it for the selected
 * daemon, which verifies that approval before atomically materializing it.
 *
 * Body: {
 *   draft: AutomationDraft,
 *   confirmed: true   // operator clicked "Save automation" (defense in depth)
 * }
 * Response 200: { ok: true, script_path, cron_id }
 * Response 4xx: { ok: false, error, message? }
 *
 * Trust model: the bridge runs as the operator. The dashboard stores the
 * reviewed draft + a confirmation flag, binds the template to the cron row,
 * and pins both to a validated daemon pairing. We don't trigger execution:
 * the row stays disabled until the operator turns it on.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { AutomationDraft } from "@/lib/ai-automation-drafter";
import { CRON_RULE_SENTENCE, isValidCronExpr } from "@/lib/automations/cron-grammar";
import { gateScriptAutomationCreate } from "@/lib/automations/script-access";
import { AutomationPipelineError, parseAutomationPipeline, targetMachineIsSelectable, type AutomationPipeline } from "@/lib/automations/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILENAME_RE = /^[a-z][a-z0-9_]*\.py$/;

type TargetPairing = {
  id: string;
  label: string | null;
  user_id: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  scope: string | null;
  tool_capabilities?: unknown;
};

// The schedule goes through the one shared grammar (lib/automations/
// cron-grammar.ts). This route used to accept day names (MON-FRI), which the
// bridge's cron_runner.py cannot parse, so such a job was saved and never fired.

/** Plain words for each draft field a refusal can name. */
const FIELD_WORDS: Record<string, string> = {
  suggested_name: "name",
  script_filename: "script file name",
  script_content: "script",
  schedule: "schedule",
  agent_key: "agent",
};

/**
 * The refusal a person reads (the page shows `message` before `error`): which
 * fields, why a schedule fails, and the way forward. The review step is
 * read-only, so drafting again is the fix for every field.
 */
function invalidDraftMessage(fields: string[]): string {
  const words = fields.map((f) => FIELD_WORDS[f] ?? f);
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0];
  const parts = [`This draft can't be saved: its ${list} ${words.length > 1 ? "are" : "is"} missing or not valid.`];
  if (fields.includes("schedule")) parts.push(CRON_RULE_SENTENCE);
  parts.push("Click Draft with AI to write a new one.");
  return parts.join(" ");
}

export async function POST(req: NextRequest) {
  // Persists a tenant_cron_jobs row (a scheduled script_run): the create gate,
  // a verified platform operator who manages this workspace
  // (lib/automations/script-access.ts).
  const gate = await gateScriptAutomationCreate("Only owners/admins can save automations.");
  if (!gate.ok) return gate.response;
  const ctx = gate.ctx;

  let body: { draft?: Partial<AutomationDraft>; confirmed?: boolean; pipeline?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.confirmed) {
    return NextResponse.json({ ok: false, error: "not_confirmed" }, { status: 400 });
  }

  const draft = body.draft || {};
  let pipeline: AutomationPipeline | null = null;
  if (body.pipeline !== undefined) {
    try {
      pipeline = parseAutomationPipeline(body.pipeline);
    } catch (error) {
      if (error instanceof AutomationPipelineError) {
        return NextResponse.json({ ok: false, error: "pipeline_invalid", field: error.field, message: error.message }, { status: 400 });
      }
      throw error;
    }
  }
  const errors: string[] = [];
  if (!draft.suggested_name || draft.suggested_name.length > 80) errors.push("suggested_name");
  if (!draft.script_filename || !FILENAME_RE.test(draft.script_filename)) errors.push("script_filename");
  if (!draft.script_content || draft.script_content.length > 100_000) errors.push("script_content");
  if (!draft.schedule || !isValidCronExpr(draft.schedule)) errors.push("schedule");
  if (!draft.agent_key) errors.push("agent_key");
  if (errors.length) {
    return NextResponse.json(
      { ok: false, error: "draft_invalid", missing_or_invalid: errors, message: invalidDraftMessage(errors) },
      { status: 400 },
    );
  }
  if (!pipeline) {
    return NextResponse.json(
      { ok: false, error: "pipeline_required", message: "Complete the four setup steps and choose a compatible computer before saving." },
      { status: 400 },
    );
  }

  // Insert the cron row first so the server-only template can bind to that
  // exact row id. Polling refuses any template/cron pairing that drifts.
  const db = getServiceSupabase();
  let target: TargetPairing | null = null;
  const pairing = await db
    .from("bridge_pairings")
    .select("id, label, user_id, last_seen_at, revoked_at, scope, tool_capabilities")
    .eq("id", pipeline.target_pairing_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (pairing.error) {
    console.error("[automations.save-draft] target pairing lookup failed", { tenantId: ctx.tenantId, error: pairing.error.message });
    return NextResponse.json({ ok: false, error: "target_machine_unavailable", message: "The selected computer could not be checked. Refresh its status and try again." }, { status: 503 });
  }
  target = pairing.data as TargetPairing | null;
  if (!target || target.user_id !== ctx.authUserId) {
    return NextResponse.json({ ok: false, error: "target_machine_not_owned", message: "Choose one of your own paired computers." }, { status: 403 });
  }
  if (!targetMachineIsSelectable(target)) {
    return NextResponse.json({ ok: false, error: "target_machine_unsupported", message: "That computer is offline or does not support generated automations yet. Update and start its bridge, then try again." }, { status: 409 });
  }
  const cronId = randomUUID();
  const templateId = randomUUID();
  const sourceHash = createHash("sha256").update(draft.script_content!, "utf8").digest("hex");
  const scriptPath = `scripts/_generated/${cronId}/${sourceHash.slice(0, 16)}_${draft.script_filename}`;
  const cronPayload = {
    id: cronId,
    tenant_id: ctx.tenantId,
    agent_key: draft.agent_key!.toLowerCase(),
    name: draft.suggested_name!,
    description: draft.suggested_description || "",
    schedule: draft.schedule!.trim(),
    action_type: "script_run",
    action_payload: {
      // The script_run handler in bravo_cli reads {script, args} from
      // action_payload. The destination stays under PROJECT_ROOT/scripts.
      script: scriptPath,
      args: [],
      // The source stays in the reviewed automation_templates record. The
      // authenticated poll route verifies this id + cron binding, then signs
      // the source for the exact pairing before returning it to the daemon.
      _automation_template_id: templateId,
      // Provenance — surface that this was AI-drafted so reviewers know
      // to read it carefully before flipping enabled=true.
      _ai_drafted: true,
      _ai_drafted_at: new Date().toISOString(),
      _automation_department: pipeline.department,
      _automation_trigger: pipeline.trigger_kind,
      _automation_inputs: pipeline.input_parameters,
      _automation_outputs: pipeline.expected_outputs,
      _connector_keys: pipeline.connector_keys,
      _target_pairing_id: pipeline.target_pairing_id,
    },
    // Disabled on creation. Operator flips on after inspecting the
    // generated file. Prevents an AI-drafted script from running before
    // anyone's seen what it does.
    enabled: false,
    // O2: the row belongs to the person who saved it, by AUTH id, exactly as
    // POST /api/cron-jobs stamps it. A row with no owner is "legacy, anyone's
    // to manage" (app/api/cron-jobs/[id]) and the poll serves it to the
    // workspace's labelled computer, so an unowned draft let another admin
    // switch on a script that then ran on the owner's computer.
    created_by: ctx.authUserId,
    owner_user_id: ctx.authUserId,
    last_scheduled_for: new Date().toISOString(),
    target_pairing_id: pipeline.target_pairing_id,
  };
  const insRes = await db
    .from("tenant_cron_jobs")
    .insert(cronPayload)
    .select()
    .single();
  if (insRes.error) {
    return NextResponse.json(
      { ok: false, error: "cron_insert_failed", message: insRes.error.message },
      { status: 500 },
    );
  }
  if (target) {
    const template = await db.from("automation_templates").insert({
      id: templateId,
      tenant_id: ctx.tenantId,
      created_by: ctx.authUserId,
      cron_job_id: cronId,
      target_pairing_id: pipeline.target_pairing_id,
      target_label: target.label || "Paired computer",
      department: pipeline.department,
      objective: pipeline.objective,
      trigger_kind: pipeline.trigger_kind,
      schedule_hint: pipeline.schedule_hint,
      input_parameters_json: pipeline.input_parameters,
      expected_outputs: pipeline.expected_outputs,
      connector_keys_json: pipeline.connector_keys,
      draft_json: draft,
      status: "ready",
    });
    if (template.error) {
      const cleanup = await db.from("tenant_cron_jobs").delete().eq("id", cronId).eq("tenant_id", ctx.tenantId).eq("owner_user_id", ctx.authUserId);
      if (cleanup.error) {
        console.error("[automations.save-draft] template insert and cron compensation both failed", {
          tenantId: ctx.tenantId,
          cronId,
          templateError: template.error.message,
          cleanupError: cleanup.error.message,
        });
      }
      return NextResponse.json(
        { ok: false, error: "automation_template_insert_failed", message: "The automation template could not be saved, so the paused schedule was rolled back." },
        { status: 500 },
      );
    }
  }

  // The targeted daemon receives the source only through its authenticated
  // cron poll. There is deliberately no browser/server push through the
  // tenant-level bridge proxy: that proxy may address a different machine.
  return NextResponse.json({
    ok: true,
    cron_id: cronId,
    script_path: scriptPath,
    template_id: templateId,
    target_label: target?.label || null,
    next_step: "enable_after_review",
  });
}
