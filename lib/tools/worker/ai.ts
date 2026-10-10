/**
 * lib/tools/worker/ai.ts - one model call for a tool, on the WORKSPACE's own AI
 * account, metered and capped like every other model call.
 *
 * The same order the department channels use (lib/os/department-agent.ts
 * prepareAgentTurn and runAgentTurnToText; that file is not imported, its
 * steps are mirrored):
 *   readWorkspaceAiAccount   the account the owner connected for the team;
 *                            a read that fails is "unreadable", never "missing"
 *   hasUsableKey             switched on and holding a key; a local model server
 *                            is no account here (only the verified operator may
 *                            use one, and a tool never asks who that is)
 *   decryptField             a key that will not decrypt is "unreadable"
 *   billingForKey            the workspace's own key: byo_key
 *   budgetExhaustedBeforeStream  a workspace at its monthly cap is refused
 *                            before a model is called
 *   modelCallMeter           every call is one ai_usage_events row, under this
 *                            tool's surface, the person and the run
 *   resolveCall              a saved model the registry knows is gone is sent
 *                            as its replacement on the same provider, and the
 *                            row records why (lib/ai/model-registry.ts)
 *   streamChat               the text is collected; an error event, a throw or
 *                            no text at all is a failure with a code
 *
 * Never the platform key and never CC's subscription: a workspace with no AI
 * account gets `ai_account_missing` and the card says to connect one.
 *
 * BOUNDED (2026-10-10, incident tool_jobs 67b30884, 2026-10-10 02:31Z): the
 * Gemini call ran 132 s and the platform's own edge cut it off as http_524 at
 * roughly 100 s - the run never got a chance to fail cleanly, and the card
 * showed the generic `ai_failed` line as though the model had answered and
 * refused, which it never did. `streamChat` is now raced against a budget
 * (modelBudgetMs, below): past it, the run is told so honestly (`ai_timeout`,
 * lib/tools/errors.ts) well inside both Cloudflare's cutoff and
 * app/api/tools/run/route.ts's own `maxDuration`, instead of riding either
 * one out. The provider's own HTTP call is not aborted (lib/providers.ts
 * takes no AbortSignal today) - only this function's wait on it is bounded;
 * a true cancel needs a signal threaded through every provider there.
 *
 * WHOLE-REQUEST BUDGET (Codex review round 2, 2026-10-10): a flat 55 s timer
 * STARTING at the model call undercounts whatever ran before it in the same
 * request - the account read, the budget check, and for Learn from a link
 * the page fetch itself (lib/tools/worker/learn-from-link.ts), all inside the
 * same `maxDuration` the route declares. A slow pre-model phase plus a full
 * 55 s model wait could outlive the route's own 60 s and get the request
 * killed before finishWorkerJob ever records the failure, leaving the job
 * stuck `running` instead of ending honestly. modelBudgetMs subtracts what
 * has already elapsed since the REQUEST started (ToolModelCall.requestStartedAt,
 * set once in lib/tools/session-handlers.ts) and a FINISH_RESERVE_MS slice for
 * writing that failure, so the model is never given more time than the
 * request plausibly has left. Too little left (<=0): the model is never
 * called at all - the run fails fast with the same honest `ai_timeout`.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { decryptField } from "@/lib/field-encryption";
import { streamChat, type ChatRequest, type StreamEvent } from "@/lib/providers";
import {
  LOCAL_MODEL_PROVIDER,
  hasUsableKey,
  readWorkspaceAiAccount,
  type WorkspaceAiAccount,
} from "@/lib/ai/workspace-account";
import {
  AI_USAGE_UNAVAILABLE,
  billingForKey,
  budgetExhaustedBeforeStream,
  isAiBudgetCode,
  modelCallMeter,
} from "@/lib/ai/usage";
import { resolveCall } from "@/lib/ai/model-registry";
import { redactAll } from "@/lib/secret-redaction";

export type ToolSurface = "tools.learn_from_link" | "tools.repurpose_post";

export type ToolModelDeps = {
  readAccount: (tenantId: string) => Promise<WorkspaceAiAccount | null>;
  decrypt: (encrypted: string) => string;
  stream: (req: ChatRequest) => AsyncGenerator<StreamEvent>;
  /** The usage ledger's database. Omitted in production (the shared client). */
  usageDb?: Client;
  /** How long to wait on the model before `ai_timeout`. Tests shrink this; production leaves it at TOOL_MODEL_TIMEOUT_MS. */
  timeoutMs?: number;
};

export function defaultToolModelDeps(): ToolModelDeps {
  return { readAccount: readWorkspaceAiAccount, decrypt: decryptField, stream: streamChat };
}

/**
 * How long a tool waits on the workspace's AI account before the run is
 * told, honestly, that nothing came back in time. Comfortably inside
 * Cloudflare's own edge cutoff (roughly 100 s) and the route's declared
 * `maxDuration` (60 s) - see the module header for why neither of those is
 * a real guarantee on its own.
 */
export const TOOL_MODEL_TIMEOUT_MS = 55_000;

/** Mirrors app/api/tools/run/route.ts's own `maxDuration`: the whole request's declared ceiling. */
const REQUEST_BUDGET_MS = 60_000;
/** Reserved, inside REQUEST_BUDGET_MS, for finishWorkerJob to write the failure once the model gives up. */
const FINISH_RESERVE_MS = 5_000;

/**
 * How long is left to wait on the model, given how much of the WHOLE
 * request's budget (REQUEST_BUDGET_MS) is already spent since
 * `requestStartedAt` - never more than TOOL_MODEL_TIMEOUT_MS, never less than
 * 0 (0 means: do not call the model at all, there is no time left to answer
 * and still record the failure).
 */
export function modelBudgetMs(requestStartedAt: Date, nowMs: number = Date.now()): number {
  const elapsed = nowMs - requestStartedAt.getTime();
  const remaining = REQUEST_BUDGET_MS - elapsed - FINISH_RESERVE_MS;
  return Math.max(0, Math.min(TOOL_MODEL_TIMEOUT_MS, remaining));
}

/** Thrown by the race below when the model has not answered within `timeoutMs`. */
class ToolModelTimedOut extends Error {}

/** Thrown to carry a specific refusal code out of the stream-reading loop, below. */
class ToolModelRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** `promise`, or `ToolModelTimedOut` after `ms` - whichever comes first. The loser's timer is always cleared. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ToolModelTimedOut()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type ToolModelCall = {
  tenantId: string;
  userId: string | null;
  jobId: string;
  surface: ToolSurface;
  system: string;
  prompt: string;
  maxTokens: number;
  /** Set once, at the top of the request (lib/tools/session-handlers.ts), never per-call: modelBudgetMs reads it. */
  requestStartedAt: Date;
};

export type ToolModelResult = { ok: true; text: string; provider: string; model: string } | { ok: false; code: string };

/** Which state of the workspace's AI account a card should show, without calling a model. */
export function accountState(account: WorkspaceAiAccount | null): "ready" | "needs_ai_account" {
  return hasUsableKey(account) && account.provider !== LOCAL_MODEL_PROVIDER ? "ready" : "needs_ai_account";
}

export async function runToolModelCall(call: ToolModelCall, deps: ToolModelDeps = defaultToolModelDeps()): Promise<ToolModelResult> {
  const timeoutMs = deps.timeoutMs ?? modelBudgetMs(call.requestStartedAt);
  if (timeoutMs <= 0) {
    // Whatever ran earlier in this request (account read, budget check, or
    // for Learn from a link the page fetch) already spent the whole budget:
    // calling the model now could not answer AND leave time to record the
    // failure before the route's own maxDuration kills the request. Fail
    // fast and honestly instead of starting a call nobody will see finish.
    console.error("[tools.ai.timeout]", { tenantId: call.tenantId, surface: call.surface, reason: "no_budget_left_before_model_call" });
    return { ok: false, code: "ai_timeout" };
  }
  let account: WorkspaceAiAccount | null;
  try {
    account = await deps.readAccount(call.tenantId);
  } catch (err) {
    console.error("[tools.ai.account]", { tenantId: call.tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: "ai_account_unreadable" };
  }
  if (!hasUsableKey(account) || account.provider === LOCAL_MODEL_PROVIDER) return { ok: false, code: "ai_account_missing" };

  let apiKey: string;
  try {
    apiKey = deps.decrypt(account.encryptedApiKey);
  } catch {
    // Never log the cipher text or the reason text: a key is near.
    console.error("[tools.ai.key]", { tenantId: call.tenantId, error: "key_unreadable" });
    return { ok: false, code: "ai_account_unreadable" };
  }
  if (!apiKey) return { ok: false, code: "ai_account_unreadable" };

  const billing = billingForKey(account.provider, "tenant");
  try {
    const exhausted = await budgetExhaustedBeforeStream(call.tenantId, billing.billingMode, new Date(), deps.usageDb);
    if (exhausted) return { ok: false, code: exhausted };
  } catch (err) {
    console.error("[tools.ai.budget]", { tenantId: call.tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: AI_USAGE_UNAVAILABLE };
  }

  // The saved model, unless the registry knows it is gone: then its replacement
  // on the same provider and key, and the meter records why. Resolved here (as
  // prepareAgentTurn does) so the run names the model it really sent.
  const picked = resolveCall(
    account.provider,
    account.model,
    modelCallMeter({ tenantId: call.tenantId, surface: call.surface, ...billing, userId: call.userId, jobId: call.jobId }, { db: deps.usageDb }),
  );

  let text = "";
  try {
    await raceTimeout(
      (async () => {
        for await (const ev of deps.stream({
          provider: account.provider,
          model: picked.model,
          apiKey,
          system: call.system,
          messages: [{ role: "user", content: call.prompt }],
          maxTokens: call.maxTokens,
          meter: picked.meter,
        })) {
          if (ev.type === "delta") text += ev.text;
          else if (ev.type === "error") {
            if (isAiBudgetCode(ev.message) || ev.message === AI_USAGE_UNAVAILABLE) throw new ToolModelRefusal(ev.message);
            console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(ev.message).slice(0, 300) });
            throw new ToolModelRefusal("ai_failed");
          }
        }
      })(),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof ToolModelTimedOut) {
      console.error("[tools.ai.timeout]", { tenantId: call.tenantId, surface: call.surface, afterMs: timeoutMs });
      return { ok: false, code: "ai_timeout" };
    }
    if (err instanceof ToolModelRefusal) return { ok: false, code: err.code };
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(detail).slice(0, 500) });
    return { ok: false, code: "ai_failed" };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: "ai_failed" };
  return { ok: true, text: trimmed, provider: account.provider, model: picked.model };
}
