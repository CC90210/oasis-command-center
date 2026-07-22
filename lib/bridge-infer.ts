/**
 * lib/bridge-infer.ts — one-shot LLM inference through the VPS subscription
 * bridge (claude -p on the Max plan, ZERO per-token cost) instead of the paid
 * Anthropic API. Server-only.
 *
 * The bridge (CEO-Agent/bravo_cli, MCC-owned) already runs claude on a
 * subscription. This helper calls a small `infer` exec-tool on it:
 *   request  : { tool_name:"infer", system, prompt, model, max_tokens }
 *   response : { ok, output }  where `output` is the model's plain text
 *
 * 2026-07-22 — SUBSCRIPTION-EXCLUSIVE: the paid-API fallback is REMOVED (the
 * paid account ran dry on 2026-07-21, silently killing every feature that
 * leaned on it; Adon's standing directive is CLI-subscription only, no raw
 * tokens). The fallback chain is now:
 *   1. VPS bridge `infer` exec-tool (when the tenant has a bridge target and
 *      Bravo has deployed the tool)
 *   2. queueInfer() — insert an `inference_jobs` row (migration 120) that the
 *      APEX machine's infer-consumer daemon (JARVIS services/infer-consumer)
 *      executes via the authenticated `claude` CLI on the Max plan, then poll
 *      for the result.
 *   3. Throw an ACTIONABLE error (never a silent generic failure).
 *
 * `model` is a tier mapped to a CLI model: "fast" (haiku) | "smart"
 * (sonnet) | "max" (opus), or a full model id.
 */
import "server-only";
import { callBridgeExecTool, type BridgeTarget } from "./bridge-proxy";
import { getServiceSupabase } from "@/lib/supabase-server";

export async function bridgeInfer(
  target: BridgeTarget,
  args: { system?: string; prompt: string; model?: string; maxTokens?: number },
  opts?: { timeoutMs?: number },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await callBridgeExecTool(
    target,
    {
      tool_name: "infer",
      system: args.system ?? "",
      prompt: args.prompt,
      model: args.model ?? "fast",
      max_tokens: args.maxTokens ?? 1024,
    },
    { timeoutMs: opts?.timeoutMs ?? 30_000 },
  );
  if (r.ok && typeof r.output === "string" && r.output.trim()) {
    return { ok: true, text: r.output };
  }
  return { ok: false, error: r.error || (r.isError ? "bridge_tool_error" : "bridge_no_output") };
}

const QUEUE_TIER_RE = /^(fast|smart|max)$/;

/**
 * Subscription-CLI inference via the `inference_jobs` queue (migration 120):
 * insert a job, poll until the APEX machine's infer-consumer daemon completes
 * it on the authenticated `claude` CLI. No tokens, no paid API.
 *
 * A timeout leaves the job in place — the daemon may still finish it (the
 * result stays queryable in the table); we just stop waiting so the calling
 * route stays inside its function budget.
 */
export async function queueInfer(
  args: {
    source: string;
    system?: string;
    prompt: string;
    modelTier?: string;
    maxTokens?: number;
    tenantId?: string | null;
  },
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 2_000;
  const tier = QUEUE_TIER_RE.test(args.modelTier || "") ? (args.modelTier as string) : "fast";
  const db = getServiceSupabase();

  const ins = await db
    .from("inference_jobs")
    .insert({
      tenant_id: args.tenantId ?? null,
      source: args.source.slice(0, 120),
      system: args.system || null,
      prompt: args.prompt,
      model_tier: tier,
      max_tokens: Math.min(Math.max(args.maxTokens ?? 1024, 1), 16000),
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    return { ok: false, error: `queue_insert_failed: ${ins.error?.message || "unknown"}` };
  }
  const jobId = (ins.data as { id: string }).id;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const row = await db
      .from("inference_jobs")
      .select("status, result_text, error_message")
      .eq("id", jobId)
      .maybeSingle();
    if (row.error) continue; // transient read blip — keep polling until deadline
    const j = row.data as { status?: string; result_text?: string | null; error_message?: string | null } | null;
    if (j?.status === "complete" && (j.result_text || "").trim()) {
      return { ok: true, text: (j.result_text as string).trim() };
    }
    if (j?.status === "error") {
      return { ok: false, error: j.error_message || "infer_job_failed" };
    }
  }
  return { ok: false, error: `queue_timeout_${Math.round(timeoutMs / 1000)}s (job ${jobId} left for the daemon)` };
}

/**
 * Subscription-only one-shot inference — the shared primitive for oasis AI
 * features. Order: VPS bridge → inference_jobs queue (local CLI daemon) →
 * actionable throw. The old paid-Anthropic-API fallback is intentionally GONE
 * (2026-07-22): raw tokens are prohibited and the paid account is dry anyway.
 * `paidModel` is retained in the signature so existing callers compile; it is
 * no longer used.
 */
export async function inferTextWithFallback(args: {
  system: string;
  prompt: string;
  bridgeTarget: BridgeTarget | null;
  bridgeModel?: string;
  /** Legacy — ignored since 2026-07-22 (no paid-API path). */
  paidModel?: string;
  maxTokens: number;
  /** Caller label for the queue row (defaults to the shared primitive's name). */
  source?: string;
  /** Poll budget for the queue path — keep inside the route's maxDuration. */
  queueTimeoutMs?: number;
}): Promise<string> {
  if (args.bridgeTarget) {
    const b = await bridgeInfer(args.bridgeTarget, {
      system: args.system,
      prompt: args.prompt,
      model: args.bridgeModel ?? "fast",
      maxTokens: args.maxTokens,
    });
    if (b.ok && b.text.trim()) return b.text.trim();
    // bridge unavailable / tool not deployed → subscription queue
  }
  const q = await queueInfer(
    {
      source: args.source || "inferTextWithFallback",
      system: args.system,
      prompt: args.prompt,
      modelTier: args.bridgeModel ?? "fast",
      maxTokens: args.maxTokens,
    },
    { timeoutMs: args.queueTimeoutMs ?? 30_000 },
  );
  if (q.ok) return q.text;
  throw new Error(
    `subscription_inference_unavailable: ${q.error} — is the infer-consumer daemon running and 'claude login' valid on the APEX PC?`,
  );
}
