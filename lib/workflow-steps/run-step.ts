/**
 * Workflow Step Dispatcher — V6.9.2 substrate.
 *
 * Looks up a step handler by type and invokes it with the (input, context)
 * pair. Returns a normalized StepResult. Used by the bridge daemon
 * (scripts/workflow_runner.py, V6.9.2.x operational) via the
 * /api/workflows/run-step HTTP endpoint.
 *
 * Adding a new step type:
 *   1. Create lib/workflow-steps/<type>.ts exporting `default: WorkflowStep`
 *   2. Add an import + REGISTRY entry below
 *   3. Document it in CONTEXT.md (V6.9.4 vocabulary) if user-facing
 *
 * Anti-slop: no eval / dynamic require. The registry is explicit so
 * security review can read one file to know every step type that exists.
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";
import recordCrud from "./record-crud";
import httpRequest from "./http-request";
import ifElse from "./if-else";
import delay from "./delay";
import mailSender from "./mail-sender";

const REGISTRY: Record<string, WorkflowStep> = {
  [recordCrud.type]: recordCrud,
  [httpRequest.type]: httpRequest,
  [ifElse.type]: ifElse,
  [delay.type]: delay,
  [mailSender.type]: mailSender,
};

/**
 * List of registered step types. Used by the WorkflowBuilder UI to render
 * the "Add Step" picker.
 */
export function listRegisteredStepTypes(): string[] {
  return Object.keys(REGISTRY).sort();
}

/**
 * Resolve a step handler by type. Returns null when the type is unknown.
 * Caller should fail the run with a clear error message in that case.
 */
export function getStepHandler(type: string): WorkflowStep | null {
  return REGISTRY[type] ?? null;
}

/**
 * Execute one step. Hot path called by the daemon's per-step HTTP loop.
 *
 * Caps:
 *   - step_count_remaining: pre-decremented by caller before invoking
 *   - outbound_cap_remaining: enforced by send_gateway-routed steps
 *
 * The dispatcher does NOT catch handler exceptions — those bubble up so
 * the caller can record the full stack to workflow_run_steps.error.
 */
export async function runStep(
  stepType: string,
  input: unknown,
  ctx: StepContext,
): Promise<StepResult> {
  const handler = getStepHandler(stepType);
  if (!handler) {
    return { status: "failed", error: `unknown_step_type: ${stepType}` };
  }
  if (ctx.step_count_remaining <= 0) {
    return { status: "failed", error: "step_cap_exhausted" };
  }
  return handler.execute(input, ctx);
}
