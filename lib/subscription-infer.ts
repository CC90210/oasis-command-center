/**
 * lib/subscription-infer.ts - one-shot JSON inference on the Max SUBSCRIPTION.
 *
 * WHY THIS EXISTS. A dozen call sites in this repo each hand-rolled the same
 * block: read ANTHROPIC_API_KEY / BRAVO_ANTHROPIC_API_KEY, POST
 * api.anthropic.com, pull `content[0].text`, regex out a JSON object. That is
 * the paid account, and lib/forms/ai-audit-format.ts has said for a while that
 * it is "out of credits and banned". Every one of those sites was a charge.
 *
 * `queueInfer` already routes inference through the local Claude CLI on the Max
 * plan for zero API tokens. Moving a call onto it is NOT a transport swap
 * though, and this helper exists so the difference is written down once instead
 * of being rediscovered per site. Migrating ONE caller
 * (lib/agents/operator-email/classify.ts) turned up six defects in review:
 *
 *   1. The queue PERSISTS the prompt in inference_jobs. A direct POST was
 *      transient, so nothing had to be redacted; now anything quoted in the
 *      prompt is stored. -> redactAll runs here, always. [[redact-pii-logs]]
 *   2. The prompt is tenant-owned data once stored, so it must carry its owner.
 *   3. A queue timeout is NOT an answer. queueInfer leaves the job running and
 *      reports timedOut; folding that into a caller's fallback records a wrong
 *      result that will never be corrected. -> reported as `pending` so callers
 *      can retry or defer rather than persist.
 *   4. A STALLED queue is reported with timedOut FALSE - a terminal failure, so
 *      a dead daemon raises a real error instead of deferring forever.
 *   5. The dedupe key must be hashed AFTER redaction, or it will not match what
 *      was actually stored and sent.
 *   6. Anything that ran "for free" in a validation/dry-run mode now costs real
 *      work - callers must not invoke this on paths that discard the output.
 *
 * Callers keep their own parsing and their own fallbacks; this owns the
 * transport, the redaction and the failure vocabulary.
 */

import "server-only";
import { createHash } from "node:crypto";
import { queueInfer } from "@/lib/bridge-infer";
import { redactAll } from "@/lib/secret-redaction";

export type InferTextResult =
  | { ok: true; text: string }
  /**
   * `pending` true = still running, ask again later; the job is alive and the
   * dedupe key will collect it. `pending` false = terminal.
   */
  | { ok: false; pending: boolean; error: string };

/**
 * Default ceiling for an operator-facing click.
 *
 * Deliberately BELOW the 30s `maxDuration` the calling routes declare. At 30s
 * this polled right up to the platform's own deadline, so Vercel killed the
 * request before the caller could return its `pending` error or its
 * deterministic fallback - the soft-failure path existed but could never run.
 * The route also authenticates and does its own reads first, so the helper must
 * leave headroom rather than consume the whole budget. Codex review 2026-08-04.
 */
const DEFAULT_TIMEOUT_MS = 18_000;

export async function inferText(args: {
  /** Short stable label, e.g. "lead-scoring". Shows up in inference_jobs. */
  source: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /**
   * REQUIRED, and part of the dedupe key. Not optional, because every caller
   * that migrated onto this seam embeds lead, interaction, automation or
   * sequence data in its prompt - and an optional field is one nobody passes.
   * Two consequences if it were missing: the stored row loses its owner, and
   * because the dedupe key is content-addressed, two tenants that happen to
   * produce an identical prompt would collide and one could be handed the
   * other's generated result. Codex review 2026-08-04.
   */
  tenantId: string | null;
  /** "fast" | "smart" | "max"; the queue maps these onto the CLI. */
  modelTier?: string;
  timeoutMs?: number;
}): Promise<InferTextResult> {
  // Redact BEFORE hashing so the dedupe key matches what is stored and sent.
  const prompt = redactAll(args.prompt);
  const system = redactAll(args.system);

  /*
   * tenantId is IN the key: without it, two tenants producing an identical
   * prompt share a job, and whichever asks second collects the other's answer.
   *
   * JSON.stringify, not a delimiter. Joining with "|" is ambiguous because a
   * system prompt or a workflow persona overlay may itself contain that
   * character: (system "a", prompt "b|c") and (system "a|b", prompt "c") hash
   * identically, and one request adopts the other's unrelated job. JSON quotes
   * and escapes each field, so the boundaries survive any content.
   * Codex review 2026-08-04.
   */
  const dedupeKey = createHash("sha256")
    .update(JSON.stringify([args.tenantId ?? null, args.source, system, prompt]))
    .digest("hex")
    .slice(0, 32);

  let q: Awaited<ReturnType<typeof queueInfer>>;
  try {
    q = await queueInfer(
      {
        source: args.source,
        system,
        prompt,
        modelTier: args.modelTier || "fast",
        maxTokens: args.maxTokens,
        tenantId: args.tenantId,
        dedupeKey,
      },
      { timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS, pollMs: 1_500 },
    );
  } catch (e) {
    // queueInfer is not expected to throw, but a Supabase blip must not be
    // mistaken for a model refusal.
    return { ok: false, pending: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!q.ok) return { ok: false, pending: q.timedOut === true, error: q.error };
  return { ok: true, text: q.text };
}

/** Pull the first JSON object out of a model response. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
