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
 * Until that tool is deployed on the bridge, callBridgeExecTool returns
 * {ok:false} and this returns {ok:false}; every caller then falls back to its
 * existing paid-API path, so wiring this in is a no-op regression-wise and
 * flips to free automatically once Bravo adds the tool.
 *
 * `model` is a tier the bridge maps to a CLI model: "fast" (haiku) | "smart"
 * (sonnet) | "max" (opus), or a full model id.
 */
import "server-only";
import { callBridgeExecTool, type BridgeTarget } from "./bridge-proxy";

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

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Bridge-first one-shot inference with a paid-Anthropic-API fallback — the shared
 * primitive for oasis AI features moving off the paid key. Returns the model's
 * plain text. Throws "anthropic_key_missing" ONLY when neither the bridge nor a
 * key is available (preserves each caller's deterministic-fallback contract).
 * `bridgeModel` is a tier (fast|smart|max); `paidModel` is the full Anthropic id.
 */
export async function inferTextWithFallback(args: {
  system: string;
  prompt: string;
  bridgeTarget: BridgeTarget | null;
  bridgeModel?: string;
  paidModel: string;
  maxTokens: number;
}): Promise<string> {
  if (args.bridgeTarget) {
    const b = await bridgeInfer(args.bridgeTarget, {
      system: args.system,
      prompt: args.prompt,
      model: args.bridgeModel ?? "fast",
      maxTokens: args.maxTokens,
    });
    if (b.ok && b.text.trim()) return b.text.trim();
    // bridge unavailable / tool not deployed → fall through to the paid API
  }
  const apiKey = (process.env.BRAVO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("anthropic_key_missing");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({ model: args.paidModel, max_tokens: args.maxTokens, system: args.system, messages: [{ role: "user", content: args.prompt }] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${detail.slice(0, 300)}`);
  }
  const responseBody = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (responseBody.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();
}
