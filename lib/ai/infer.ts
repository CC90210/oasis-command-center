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
 */

import "server-only";
import { inferText, firstJsonObject, type InferTextResult } from "@/lib/subscription-infer";
import { inferTextWithFallback, queueInfer } from "@/lib/bridge-infer";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";

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

/**
 * One-shot inference for `tenantId`: lib/subscription-infer.ts `inferText`
 * for an OASIS tenant, a terminal refusal for everyone else.
 */
export async function inferForTenant(
  tenantId: string | null,
  args: Omit<Parameters<typeof inferText>[0], "tenantId">,
): Promise<InferTextResult> {
  if (!isOasisInternalTenant(tenantId)) {
    return { ok: false, pending: false, error: refuse(args.source, tenantId) };
  }
  return inferText({ ...args, tenantId });
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
  if (!isOasisInternalTenant(args.tenantId)) {
    return { ok: false, error: refuse(args.source, args.tenantId), timedOut: false };
  }
  return queueInfer(args, opts);
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
  if (!isOasisInternalTenant(tenantId)) {
    throw new Error(refuse(args.source || "inferTextWithFallback", tenantId));
  }
  return inferTextWithFallback(args);
}
