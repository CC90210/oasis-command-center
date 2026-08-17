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
import { coerceInferResultText } from "@/lib/infer-result-text";

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
 * route stays inside its function budget. `timedOut` says so explicitly: a
 * caller must be able to tell "still cooking, ask again" from "this failed",
 * because they warrant opposite reactions (retry quietly vs alert an outage).
 *
 * `dedupeKey` (optional) closes the loop on that timeout. Without it, a job
 * that outlives its caller's budget is orphaned: the daemon burns real
 * subscription inference finishing it, nobody ever reads the result, and the
 * next tick enqueues the identical prompt again — unbounded duplicate work on
 * anything slower than one caller's budget. With it, the job is tagged on
 * `source` and the next call ADOPTS the in-flight job (or collects its finished
 * result for free) instead of queueing a twin.
 */
export async function queueInfer(
  args: {
    source: string;
    system?: string;
    prompt: string;
    modelTier?: string;
    maxTokens?: number;
    tenantId?: string | null;
    /** Stable per-payload key. Enables adopt/collect instead of re-queueing. */
    dedupeKey?: string;
    /** How far back an existing job stays reusable. Default 30 min. */
    dedupeWindowMs?: number;
    /**
     * An in-flight job older than this is not latency, it is a stalled queue —
     * reported as a TERMINAL failure so a dead daemon raises an alarm instead
     * of looking like a slow one forever. Requires dedupeKey (that is what
     * lets a later call see the original job's age). Default 15 min.
     */
    stalledAfterMs?: number;
  },
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<
  | { ok: true; text: string; reused?: boolean }
  | { ok: false; error: string; timedOut?: boolean; stalledMs?: number }
> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const pollMs = opts?.pollMs ?? 2_000;
  const tier = QUEUE_TIER_RE.test(args.modelTier || "") ? (args.modelTier as string) : "fast";
  const db = getServiceSupabase();

  // Tag the dedupe key onto `source` so this needs no schema change and stays
  // compatible with the daemon's claim query (which only reads status+created_at).
  // Reserve room for the suffix BEFORE truncating: slicing the combined string
  // would chop the key off a long source label, so two different payloads could
  // resolve to the same stored source and adopt each other's job. Safe for the
  // current callers, but this is a shared primitive — the next one may not be.
  const key = (args.dedupeKey || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const suffix = key ? `#${key}` : "";
  const source = args.source.slice(0, 120 - suffix.length) + suffix;

  let jobId: string | null = null;

  if (key) {
    const since = new Date(Date.now() - (args.dedupeWindowMs ?? 30 * 60_000)).toISOString();
    // TENANT-SCOPED. This runs as service role, so RLS is not a backstop here.
    // The key is a content hash, and boilerplate content collides readily
    // across tenants (a generic "we received your submission" auto-reply hashes
    // the same everywhere) — without this filter one tenant could adopt or read
    // another tenant's job. A caller with no tenant may only reuse untenanted
    // jobs, never a tenant's. [[rls-required-default]]
    let q = db
      .from("inference_jobs")
      .select("id, status, result_text, created_at")
      .eq("source", source)
      .gte("created_at", since);
    q = args.tenantId ? q.eq("tenant_id", args.tenantId) : q.is("tenant_id", null);
    const prior = await q
      .order("created_at", { ascending: false })
      .limit(1);
    const p = prior.data?.[0] as
      | { id: string; status?: string; result_text?: unknown; created_at?: string }
      | undefined;
    if (!prior.error && p) {
      // Finished while an earlier caller was not looking — collect it, free.
      // coerce: the Turso shim JSON.parses '{'-prefixed TEXT, so result_text
      // arrives as an OBJECT there and `.trim()` on it throws — which is how
      // every completed classification was silently discarded 8/09→8/16.
      const priorText = coerceInferResultText(p.result_text);
      if (p.status === "complete" && priorText.trim()) {
        return { ok: true, text: priorText.trim(), reused: true };
      }
      // Still queued or running — adopt it rather than enqueue a duplicate.
      if (p.status === "pending" || p.status === "running") {
        // …unless it has been sitting there far too long. A job nobody has
        // finished after this many minutes means the consumer daemon is not
        // draining the queue, which is an OUTAGE, not slowness. Say so
        // immediately rather than polling for a result that is never coming:
        // otherwise a dead daemon reports "still cooking" on every tick
        // forever and lender replies pile up in silence — precisely the
        // failure this whole change exists to make impossible.
        const ageMs = p.created_at ? Date.now() - Date.parse(p.created_at) : 0;
        const stalledAfterMs = args.stalledAfterMs ?? 15 * 60_000;
        if (Number.isFinite(ageMs) && ageMs > stalledAfterMs) {
          return {
            ok: false,
            error: `queue_stalled: job ${p.id} still ${p.status} after ${Math.round(ageMs / 60_000)}m — is the infer-consumer daemon running?`,
            timedOut: false,
            stalledMs: ageMs,
          };
        }
        jobId = p.id;
      }
      // status 'error' falls through to a fresh attempt.
    }
  }

  if (!jobId) {
    const ins = await db
      .from("inference_jobs")
      .insert({
        tenant_id: args.tenantId ?? null,
        source,
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
    jobId = (ins.data as { id: string }).id;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const row = await db
      .from("inference_jobs")
      .select("status, result_text, error_message")
      .eq("id", jobId)
      .maybeSingle();
    if (row.error) continue; // transient read blip — keep polling until deadline
    const j = row.data as { status?: string; result_text?: unknown; error_message?: string | null } | null;
    // Same coercion as the adoption branch — the poll observes the completion
    // first on a fresh job, so an un-coerced read here re-opens the outage.
    const pollText = coerceInferResultText(j?.result_text);
    if (j?.status === "complete" && pollText.trim()) {
      return { ok: true, text: pollText.trim() };
    }
    if (j?.status === "error") {
      return { ok: false, error: j.error_message || "infer_job_failed" };
    }
  }
  // Recoverable: the job is still queued and the daemon may well finish it. With
  // a dedupeKey the next call collects that result; without one it is orphaned.
  return {
    ok: false,
    error: `queue_timeout_${Math.round(timeoutMs / 1000)}s (job ${jobId} left for the daemon)`,
    timedOut: true,
  };
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
