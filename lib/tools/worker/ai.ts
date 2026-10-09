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
 *   streamChat               the text is collected; an error event, a throw or
 *                            no text at all is a failure with a code
 *
 * Never the platform key and never CC's subscription: a workspace with no AI
 * account gets `ai_account_missing` and the card says to connect one.
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
import { redactAll } from "@/lib/secret-redaction";

export type ToolSurface = "tools.learn_from_link" | "tools.repurpose_post";

export type ToolModelDeps = {
  readAccount: (tenantId: string) => Promise<WorkspaceAiAccount | null>;
  decrypt: (encrypted: string) => string;
  stream: (req: ChatRequest) => AsyncGenerator<StreamEvent>;
  /** The usage ledger's database. Omitted in production (the shared client). */
  usageDb?: Client;
};

export function defaultToolModelDeps(): ToolModelDeps {
  return { readAccount: readWorkspaceAiAccount, decrypt: decryptField, stream: streamChat };
}

export type ToolModelCall = {
  tenantId: string;
  userId: string | null;
  jobId: string;
  surface: ToolSurface;
  system: string;
  prompt: string;
  maxTokens: number;
};

export type ToolModelResult = { ok: true; text: string; provider: string; model: string } | { ok: false; code: string };

/** Which state of the workspace's AI account a card should show, without calling a model. */
export function accountState(account: WorkspaceAiAccount | null): "ready" | "needs_ai_account" {
  return hasUsableKey(account) && account.provider !== LOCAL_MODEL_PROVIDER ? "ready" : "needs_ai_account";
}

export async function runToolModelCall(call: ToolModelCall, deps: ToolModelDeps = defaultToolModelDeps()): Promise<ToolModelResult> {
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

  const meter = modelCallMeter(
    { tenantId: call.tenantId, surface: call.surface, ...billing, userId: call.userId, jobId: call.jobId },
    { db: deps.usageDb },
  );

  let text = "";
  try {
    for await (const ev of deps.stream({
      provider: account.provider,
      model: account.model,
      apiKey,
      system: call.system,
      messages: [{ role: "user", content: call.prompt }],
      maxTokens: call.maxTokens,
      meter,
    })) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "error") {
        if (isAiBudgetCode(ev.message) || ev.message === AI_USAGE_UNAVAILABLE) return { ok: false, code: ev.message };
        console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(ev.message).slice(0, 300) });
        return { ok: false, code: "ai_failed" };
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[tools.ai.stream]", { tenantId: call.tenantId, surface: call.surface, error: redactAll(detail).slice(0, 500) });
    return { ok: false, code: "ai_failed" };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, code: "ai_failed" };
  return { ok: true, text: trimmed, provider: account.provider, model: account.model };
}
