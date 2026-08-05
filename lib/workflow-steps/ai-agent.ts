/**
 * ai-agent step — V6.9.3.
 *
 * Loads an agent persona (lib/agent-personas.ts) + a prompt template,
 * substitutes {{var}} placeholders from prior_outputs + trigger_event,
 * fires a single non-streaming Anthropic call, returns the text response.
 *
 * Pure model-call step — the workflow stitches it together with
 * record-crud / http-request steps for IO. Keeps the step composable.
 *
 * Input shape:
 *   { agent_slug: string,
 *     prompt: string,                       // {{trigger.x}} or {{step_id.field}} placeholders
 *     model?: "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5",
 *     max_tokens?: number,                  // default 1024
 *     prompt_overlay?: string }             // tenant-specific overlay
 *
 * Output: { text: string, model: string, input_tokens: number, output_tokens: number }
 */

import type { StepContext, StepResult, WorkflowStep } from "./types";
import { getPersona } from "@/lib/agent-personas";
import { inferText } from "@/lib/subscription-infer";

type AiAgentInput = {
  agent_slug?: string;
  prompt?: string;
  model?: string;
  max_tokens?: number;
  prompt_overlay?: string;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_CAP = 8192;

/**
 * Replace {{trigger.x}} + {{step_id.field}} placeholders with values from
 * the run context. Missing paths render as empty string (graceful — keeps
 * the model from seeing literal {{placeholder}} text).
 */
export function substituteTemplate(
  template: string,
  trigger: Record<string, unknown>,
  priorOutputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const segments = path.split(".");
    const root = segments.shift();
    let source: unknown;
    if (root === "trigger") {
      source = trigger;
    } else if (root) {
      source = priorOutputs[root];
    }
    let cursor: unknown = source;
    for (const seg of segments) {
      if (cursor === null || cursor === undefined || typeof cursor !== "object") {
        return "";
      }
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    if (cursor === null || cursor === undefined) return "";
    return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
  });
}

const handler: WorkflowStep = {
  type: "ai-agent",
  async execute(rawInput: unknown, ctx: StepContext): Promise<StepResult> {
    const input = (rawInput || {}) as AiAgentInput;
    if (!input.agent_slug) return { status: "failed", error: "missing_agent_slug" };
    if (!input.prompt) return { status: "failed", error: "missing_prompt" };

    const systemPrompt = getPersona(input.agent_slug, input.prompt_overlay);
    const userPrompt = substituteTemplate(input.prompt, ctx.trigger_event, ctx.prior_outputs);
    const model = input.model ?? DEFAULT_MODEL;
    const maxTokens = Math.min(input.max_tokens ?? 1024, MAX_TOKENS_CAP);

    try {
      // Subscription, not the paid API. A workflow step runs unattended, so
      // this was billable on a trigger rather than on a click.
      // See lib/subscription-infer.ts.
      const inf = await inferText({
        source: `workflow:${input.agent_slug}`,
        system: systemPrompt,
        prompt: userPrompt,
        maxTokens,
        tenantId: ctx.tenant_id ?? null,
        modelTier: "smart",
      });
      if (!inf.ok) {
        return {
          status: "failed",
          error: inf.pending ? `inference_pending: ${inf.error}` : `inference_unavailable: ${inf.error}`,
        };
      }
      const text = inf.text;
      return {
        status: "complete",
        output: {
          text,
          model,
          // Token counts come from the paid API's usage block, which the queue
          // does not surface. Reported as 0 rather than invented.
          input_tokens: 0,
          output_tokens: 0,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", error: `anthropic_unreachable: ${message}` };
    }
  },
};

export default handler;
