/**
 * lib/ai/infer.ts — the one door to one-shot model inference, and the tenant
 * gate in front of OASIS's Claude subscription.
 *
 * WHY THIS EXISTS (docs/os-revamp/03-connectors-ai-finance.md F1, §a.4.6).
 * lib/subscription-infer.ts and lib/bridge-infer.ts run a prompt on the Claude
 * CLI under a personal Max plan: an `inference_jobs` row drained by a daemon on
 * an OASIS-operated machine, or the `infer` tool on a paired bridge. Fourteen
 * call sites reached that transport directly and passed whatever tenant they
 * were serving, so ANY tenant's lead, SMS or deal email became work on that
 * plan. Locked decision #6: client work never runs on CC's personal
 * subscription.
 *
 * THE RULE.
 *   - OASIS's own tenants (OASIS_INTERNAL_TENANT_IDS, by id) keep the
 *     subscription path exactly as it was. That is OASIS using its own plan
 *     for its own workspace.
 *   - Every other tenant (a client, retired SunBiz, an unknown id, or a caller
 *     with no tenant at all) is refused BEFORE anything is queued or sent to a
 *     bridge, with MANAGED_RUNTIME_NOT_CONFIGURED. The managed Anthropic
 *     runtime (a dedicated workspace key, per-tenant metering and a spend cap,
 *     doc 03 §d.2-§d.3) is Phase 2. Until it exists, a client feature that
 *     needs a model fails loudly instead of borrowing OASIS's plan.
 *   - The refusal is TERMINAL (`pending: false` / `timedOut: false`). A client
 *     tenant will not become OASIS on the next tick, so no caller may treat it
 *     like a slow queue and defer-and-retry it forever.
 *
 * tests/no-subscription-infer-outside-router.test.ts fails if any other file
 * imports subscription-infer or bridge-infer, so this gate cannot be walked
 * around by importing the transport directly.
 *
 * METERED (OASIS OS plan v2 §F2.6). Every request that comes through here is
 * recorded in ai_usage_events (lib/ai/usage.ts) for the tenant it names:
 * surface infer:<source>, provider claude_cli, model tier:<fast|smart|max>,
 * billing subscription. The Worker never sees the CLI's token counts, and a
 * flat plan has no per-call price, so tokens and cost are NULL; usageFor counts
 * these as flat-rate calls, never as unknown spend.
 *   - ok / error (with a code, never the daemon's prose) / timeout (the job was
 *     left queued: `pending`).
 *   - refused: a tenant that is not OASIS's own (cost 0, nothing was queued).
 *     A call with NO tenant is refused and logged but not recorded: the ledger
 *     has no tenant to file it under, and it is never filed under OASIS.
 *   - ONE ROW PER QUEUED JOB (job_id = the inference_jobs id). A dedupe key
 *     lets a later call adopt a job still running or collect one already done;
 *     that call is not a new model call and adds no row. When the job's row
 *     says `timeout` (its first caller stopped waiting), the call that later
 *     sees it finish resolves that row to ok or error
 *     (lib/ai/usage.ts recordJobModelCall).
 * No budget reservation: a flat plan has no per-call cost to reserve.
 */

import "server-only";
import { inferText, firstJsonObject, type InferTextResult } from "@/lib/subscription-infer";
import { inferTextWithFallback, queueInfer, type InferJob } from "@/lib/bridge-infer";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { recordJobModelCall, recordModelCall, type ModelCallRecord, type UsageOutcome } from "@/lib/ai/usage";

export { firstJsonObject };
export type { InferTextResult };

/** Stable prefix of every refusal, for callers and routes that map errors. */
export const MANAGED_RUNTIME_NOT_CONFIGURED = "managed_runtime_not_configured";

function refuse(source: string, tenantId: string | null | undefined): string {
  const message =
    `${MANAGED_RUNTIME_NOT_CONFIGURED}: tenant ${tenantId || "(none)"} is not an OASIS workspace. ` +
    `Client AI runs only on the managed runtime, which is not configured yet, so "${source}" ` +
    `was refused instead of running on the OASIS subscription.`;
  console.error(`[ai/infer] ${message}`);
  return message;
}

/** A code for the ledger from a transport error: its leading code token, never the prose after it. */
function inferErrorCode(message: string): string {
  const m = /^([a-z][a-z0-9_]{2,60})(?=[:\s]|$)/.exec(String(message || ""));
  return m ? m[1] : "infer_failed";
}

const QUEUE_TIERS = new Set(["fast", "smart", "max"]);

/**
 * The ai_usage_events row for a request to the subscription runtime (see
 * METERED above). `job` is the queued job it waited on, when it got that far:
 * its row is the job's one row.
 */
async function recordInfer(
  tenantId: string | null,
  source: string,
  tier: string | undefined,
  startedAt: Date,
  outcome: UsageOutcome,
  errorCode: string | null,
  job: InferJob | null = null,
): Promise<void> {
  if (typeof tenantId !== "string" || !tenantId.trim()) return;
  const surfaceSource = String(source || "unnamed").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) || "unnamed";
  const record: ModelCallRecord = {
    tenantId,
    surface: `infer:${surfaceSource}`,
    authKind: "subscription",
    billingMode: "subscription",
    occurredAt: startedAt,
    provider: "claude_cli",
    // A tier the CLI maps to a model, "fast" when none was named (the transport's
    // default), or the full model id a bridge caller named.
    model: !tier || QUEUE_TIERS.has(tier) ? `tier:${tier || "fast"}` : tier.slice(0, 100),
    // Refused before anything was queued: a known zero. Otherwise a flat plan: no per-call price.
    costMicroUsd: outcome === "refused" ? 0 : null,
    costSource: outcome === "refused" ? "none" : null,
    latencyMs: Date.now() - startedAt.getTime(),
    outcome,
    errorCode,
  };
  if (job) await recordJobModelCall({ ...record, jobId: job.id });
  else await recordModelCall(record);
}

/**
 * One-shot inference for `tenantId`: lib/subscription-infer.ts `inferText`
 * for an OASIS tenant, a terminal refusal for everyone else.
 */
export async function inferForTenant(
  tenantId: string | null,
  args: Omit<Parameters<typeof inferText>[0], "tenantId">,
): Promise<InferTextResult> {
  const startedAt = new Date();
  if (!isOasisInternalTenant(tenantId)) {
    const result = { ok: false as const, pending: false, error: refuse(args.source, tenantId) };
    await recordInfer(tenantId, args.source, args.modelTier, startedAt, "refused", MANAGED_RUNTIME_NOT_CONFIGURED);
    return result;
  }
  let job: InferJob | null = null;
  const result = await inferText({ ...args, tenantId, onJob: (j) => void (job = j) });
  if (result.ok) await recordInfer(tenantId, args.source, args.modelTier, startedAt, "ok", null, job);
  else if (result.pending) await recordInfer(tenantId, args.source, args.modelTier, startedAt, "timeout", "queue_timeout", job);
  else await recordInfer(tenantId, args.source, args.modelTier, startedAt, "error", inferErrorCode(result.error), job);
  return result;
}

/**
 * lib/bridge-infer.ts `queueInfer`, gated on `args.tenantId`. It keeps
 * queueInfer's call shape so the callers that inject it for tests
 * (lib/sms/reply-agent.ts) and the ones that read its `timedOut` /
 * `stalledMs` fields keep working unchanged. `tenantId` is required here
 * (optional on queueInfer): a caller must say whose work this is.
 */
export async function queueInferForTenant(
  args: Parameters<typeof queueInfer>[0] & { tenantId: string | null },
  opts?: Parameters<typeof queueInfer>[1],
): ReturnType<typeof queueInfer> {
  const startedAt = new Date();
  if (!isOasisInternalTenant(args.tenantId)) {
    const refused = { ok: false as const, error: refuse(args.source, args.tenantId), timedOut: false };
    await recordInfer(args.tenantId, args.source, args.modelTier, startedAt, "refused", MANAGED_RUNTIME_NOT_CONFIGURED);
    return refused;
  }
  let job: InferJob | null = null;
  const onJob = args.onJob;
  const result = await queueInfer({
    ...args,
    onJob: (j) => {
      job = j;
      onJob?.(j);
    },
  }, opts);
  // One row per job (see METERED above): an adopted or collected job resolves its row, never adds one.
  if (result.ok) {
    await recordInfer(args.tenantId, args.source, args.modelTier, startedAt, "ok", null, job);
  } else if (result.timedOut) {
    await recordInfer(args.tenantId, args.source, args.modelTier, startedAt, "timeout", "queue_timeout", job);
  } else {
    await recordInfer(args.tenantId, args.source, args.modelTier, startedAt, "error", inferErrorCode(result.error), job);
  }
  return result;
}

/**
 * lib/bridge-infer.ts `inferTextWithFallback` (the tenant's bridge, then the
 * queue), gated on `tenantId`. It throws on refusal, as the wrapped function
 * throws when the subscription is unavailable, so callers keep one error path.
 */
export async function inferTextWithFallbackForTenant(
  tenantId: string | null,
  args: Parameters<typeof inferTextWithFallback>[0],
): Promise<string> {
  const startedAt = new Date();
  const source = args.source || "inferTextWithFallback";
  if (!isOasisInternalTenant(tenantId)) {
    const message = refuse(source, tenantId);
    await recordInfer(tenantId, source, args.bridgeModel, startedAt, "refused", MANAGED_RUNTIME_NOT_CONFIGURED);
    throw new Error(message);
  }
  try {
    const text = await inferTextWithFallback(args);
    await recordInfer(tenantId, source, args.bridgeModel, startedAt, "ok", null);
    return text;
  } catch (err) {
    await recordInfer(tenantId, source, args.bridgeModel, startedAt, "error", inferErrorCode(err instanceof Error ? err.message : String(err)));
    throw err;
  }
}
