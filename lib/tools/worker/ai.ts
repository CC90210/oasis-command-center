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
 * called at all - the run fails fast with `request_timeout`, a distinct code
 * from `ai_timeout` (the AI account itself was asked and did not answer in
 * time): the account was never contacted on this path, so the card must
 * never say it "took too long to answer" (Codex review round 3, LOW).
 *
 * PER-CALL DEADLINE (automations-pr2-run-hooks, merged with the budget above
 * 2026-10-10): some callers (an automation/desk run under its own tighter
 * SLA) need a wait shorter than whatever the WHOLE request still has - a
 * 55 s drafter wait is wrong for a run the desk wants to give up on in 10 s.
 * ToolModelCall.deadlineMs carries that caller-set cap, independent of
 * requestStartedAt (a caller may set either, both, or neither). The wait
 * actually used, raced against the live stream, is the TIGHTER of the two -
 * either can trip first - recomputed at the same point modelBudgetMs already
 * is, right before the stream opens. Either one tripping returns the same
 * `ai_timeout` and closes the stream the same way: an explicit `it.return()`
 * on the live iterator, so its usage row settles as `cancelled` instead of
 * hanging open for the ledger's reservation sweep to find later. A caller
 * with neither deadlineMs nor requestStartedAt (a bare unit call) gets no
 * limit at all, not a crash: requestStartedAt is optional for exactly that
 * caller.
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

export type ToolSurface = "tools.learn_from_link" | "tools.repurpose_post" | "automations.draft";

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

export type ToolModelCall = {
  tenantId: string;
  userId: string | null;
  jobId: string;
  surface: ToolSurface;
  system: string;
  prompt: string;
  maxTokens: number;
  /**
   * Set once, at the top of the request (lib/tools/session-handlers.ts),
   * never per-call: modelBudgetMs reads it. Optional - a caller with no
   * whole request to share a budget against (a bare unit call, or an
   * automation/desk run carrying only its own deadlineMs below) leaves this
   * out and gets no request-budget constraint at all; only deadlineMs, if
   * given, can still bound the wait.
   */
  requestStartedAt?: Date;
  /**
   * The longest THIS call may wait, from the moment the stream opens, set
   * by the caller (an automation/desk run under its own SLA) - independent
   * of the request-wide budget above; a caller may set either, both, or
   * neither. Past it the answer is `ai_timeout` at once, and the stream is
   * closed (its row says cancelled once the provider's stream unwinds; a
   * stream that never yields again is settled by the ledger's reservation
   * sweep). The wait actually used is the TIGHTER of this and whatever the
   * request has left - either can trip first. Absent: no cap of its own.
   */
  deadlineMs?: number;
};

export type ToolModelResult = { ok: true; text: string; provider: string; model: string } | { ok: false; code: string };

/** Which state of the workspace's AI account a card should show, without calling a model. */
export function accountState(account: WorkspaceAiAccount | null): "ready" | "needs_ai_account" {
  return hasUsableKey(account) && account.provider !== LOCAL_MODEL_PROVIDER ? "ready" : "needs_ai_account";
}

/**
 * The WHOLE-REQUEST leg of the budget: `deps.timeoutMs` (tests shrink it) if
 * set, else `modelBudgetMs` of the request's own start if the caller gave one
 * - `null` when neither applies (no request-budget constraint at all, see
 * ToolModelCall.requestStartedAt above). Called fresh at each checkpoint
 * below, never cached: the Codex round 4 fix (a slow readAccount or budget
 * read spends real wall-clock time a value computed before them cannot see).
 */
function requestBudgetMs(call: Pick<ToolModelCall, "requestStartedAt">, deps: Pick<ToolModelDeps, "timeoutMs">): number | null {
  if (typeof deps.timeoutMs === "number") return deps.timeoutMs;
  return call.requestStartedAt ? modelBudgetMs(call.requestStartedAt) : null;
}

export async function runToolModelCall(call: ToolModelCall, deps: ToolModelDeps = defaultToolModelDeps()): Promise<ToolModelResult> {
  const budget = requestBudgetMs(call, deps);
  if (budget !== null && budget <= 0) {
    return noBudgetLeft(call, "no_budget_left_before_model_call");
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

  // Recomputed, not reused (Codex review round 4, P2): readAccount and
  // budgetExhaustedBeforeStream above are real round trips (a slow Turso
  // read has been measured at ~10 s), and racing the stream against a
  // budget computed BEFORE them let the total wait outlive the request's
  // real budget - a stalled model could still leave the job "running" past
  // the route's own maxDuration, with no failure ever recorded. Same rule as
  // the check above: too little left, and the model is never called at all.
  const streamBudget = requestBudgetMs(call, deps);
  if (streamBudget !== null && streamBudget <= 0) {
    return noBudgetLeft(call, "no_budget_left_after_account_read");
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
  const it = deps.stream({
    provider: account.provider,
    model: picked.model,
    apiKey,
    system: call.system,
    messages: [{ role: "user", content: call.prompt }],
    maxTokens: call.maxTokens,
    meter: picked.meter,
  });
  // call.deadlineMs, validated (finite and positive; absent or 0 means no cap
  // of its own) - the TIGHTER of this and streamBudget (above) is what the
  // loop below actually races the stream against. Either leg may be null
  // (no constraint); both null means no limit at all.
  const callDeadlineMs = typeof call.deadlineMs === "number" && Number.isFinite(call.deadlineMs) && call.deadlineMs > 0 ? call.deadlineMs : null;
  const effectiveMs =
    callDeadlineMs === null ? streamBudget : streamBudget === null ? callDeadlineMs : Math.min(callDeadlineMs, streamBudget);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut =
    typeof effectiveMs === "number"
      ? new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), effectiveMs);
        })
      : null;
  // The stream ended by itself, or was let go at the deadline: either way it
  // is not closed again below. Any other way out closes it, as for-await did.
  let settled = false;
  try {
    for (;;) {
      const pending = it.next();
      pending.catch(() => undefined);
      const got = timedOut ? await Promise.race([pending, timedOut]) : await pending;
      if (got === "timeout") {
        // Close the stream (its call records cancelled as it unwinds) without
        // waiting for a provider that may never answer again.
        settled = true;
        void it.return(undefined).catch(() => undefined);
        console.error("[tools.ai.timeout]", { tenantId: call.tenantId, surface: call.surface, afterMs: effectiveMs, deadlineMs: call.deadlineMs });
        return { ok: false, code: "ai_timeout" };
      }
      if (got.done) {
        settled = true;
        break;
      }
      const ev = got.value;
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "error") {
        if (isAiBudgetCode(ev.message) || ev.message === AI_USAGE_UNAVAILABLE) return { ok: false, code: ev.message };
        console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(ev.message).slice(0, 300) });
        return { ok: false, code: "ai_failed" };
      }
    }
  } catch (err) {
    settled = true; // a stream that threw is over
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(detail).slice(0, 500) });
    return { ok: false, code: "ai_failed" };
  } finally {
    if (timer) clearTimeout(timer);
    if (!settled) await it.return(undefined).then(() => undefined, () => undefined);
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: "ai_failed" };
  return { ok: true, text: trimmed, provider: account.provider, model: picked.model };
}

/**
 * Whatever ran earlier in this request (account read, budget check, or for
 * Learn from a link the page fetch) already spent the whole budget: calling
 * the model now could not answer AND leave time to record the failure
 * before the route's own maxDuration kills the request. Fail fast and
 * honestly instead of starting a call nobody will see finish -
 * request_timeout, NEVER ai_timeout (Codex review round 3, LOW): the AI
 * account is never contacted on this path, so the card must not say it
 * "took too long to answer".
 */
function noBudgetLeft(call: Pick<ToolModelCall, "tenantId" | "surface">, reason: string): { ok: false; code: string } {
  console.error("[tools.ai.timeout]", { tenantId: call.tenantId, surface: call.surface, reason });
  return { ok: false, code: "request_timeout" };
}
